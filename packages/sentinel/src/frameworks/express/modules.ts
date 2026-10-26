// Module bindings over captured JavaScript and TypeScript, for the Express pack: what a top-level name in a file is
// bound to (a declaration, an import from a captured file, an import from a package), what each file exports, and
// how a relative specifier resolves to a captured file. Only static forms are read: ESM imports and exports,
// top-level `require` of a literal specifier and literal `module.exports` / `exports.x` assignments. A form outside
// that is unresolved, which callers treat as unknown; nothing is evaluated.
import { identifierName, isNode, memberPath, stringValue, unwrap, walk, type JsFile, type JsNode } from './syntax.js';

export type Binding =
  /** A top-level `const` declarator (or a `let`/`var` never assigned again) and its initializer. */
  | {
      readonly kind: 'declared';
      readonly file: JsFile;
      readonly name: string;
      readonly declarator: JsNode;
      readonly init: JsNode | undefined;
    }
  | { readonly kind: 'function'; readonly file: JsFile; readonly name: string; readonly node: JsNode }
  /** `import x from 'm'`, `import { y as x } from 'm'`, or a top-level CommonJS require of 'm' bound whole or destructured. */
  | {
      readonly kind: 'import';
      readonly file: JsFile;
      readonly name: string;
      readonly specifier: string;
      readonly imported: string | 'default' | '*' | 'require';
      readonly at: JsNode;
    }
  | { readonly kind: 'unresolved'; readonly file: JsFile; readonly name: string; readonly at: JsNode };

export type ModuleTarget =
  | { readonly kind: 'file'; readonly file: JsFile }
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'unresolved' };

interface FileModule {
  readonly bindings: Map<string, Binding>;
  /** ESM named exports and CJS `exports.x`: exported name → local expression. */
  readonly exports: Map<string, { readonly value: JsNode; readonly local?: string }>;
  /** `export { x } from './y'`: exported name → (specifier, imported name). */
  readonly reexports: Map<string, { readonly specifier: string; readonly imported: string }>;
  readonly starReexports: string[];
  /** `export default <expr>` or `module.exports = <expr>`. */
  defaultExport?: JsNode;
  /** The file uses both module systems, or assigns its exports in a way not read: its exports are unresolved. */
  opaqueExports: boolean;
  readonly esm: boolean;
}

/** Names whose top-level declaration this file assigns again: their value is not the initializer's. */
function reassigned(program: JsNode): Set<string> {
  const out = new Set<string>();
  walk(program, (n) => {
    if (n.type === 'AssignmentExpression') {
      const name = identifierName(n.left as JsNode);
      if (name) out.add(name);
    }
    if (n.type === 'UpdateExpression') {
      const name = identifierName(n.argument as JsNode);
      if (name) out.add(name);
    }
  });
  return out;
}

/** Every name a file binds at the top level: declarations, functions, classes and imports. */
export function topLevelNames(program: JsNode): Set<string> {
  const out = new Set<string>();
  const ids = (n: JsNode | undefined) => {
    if (n)
      walk(n, (x) => {
        if (x.type === 'Identifier') out.add(x.name as string);
      });
  };
  for (const s of program.body as JsNode[]) {
    const decl = s.type.startsWith('Export') && s.declaration ? (s.declaration as JsNode) : s;
    if (decl.type === 'VariableDeclaration') for (const d of decl.declarations as JsNode[]) ids(d.id as JsNode);
    else if (
      (decl.type === 'FunctionDeclaration' ||
        decl.type === 'ClassDeclaration' ||
        decl.type === 'TSImportEqualsDeclaration') &&
      decl.id
    )
      out.add((decl.id as JsNode).name as string);
    else if (s.type === 'ImportDeclaration')
      for (const sp of (s.specifiers as JsNode[]) ?? []) out.add((sp.local as JsNode).name as string);
  }
  return out;
}

export class ModuleIndex {
  private readonly modules = new Map<JsFile, FileModule>();
  private readonly byPath = new Map<string, JsFile>();

  constructor(readonly files: readonly JsFile[]) {
    for (const f of files) this.byPath.set(f.path, f);
    for (const f of files) this.modules.set(f, this.read(f));
  }

  file(path: string): JsFile | undefined {
    return this.byPath.get(path);
  }

  private read(file: JsFile): FileModule {
    const bindings = new Map<string, Binding>();
    const exports = new Map<string, { value: JsNode; local?: string }>();
    const reexports = new Map<string, { specifier: string; imported: string }>();
    const starReexports: string[] = [];
    const mod: FileModule = {
      bindings,
      exports,
      reexports,
      starReexports,
      opaqueExports: false,
      esm: (file.program.body as JsNode[]).some((s) => s.type === 'ImportDeclaration' || s.type.startsWith('Export')),
    };
    const again = reassigned(file.program);
    // A file that declares or imports its own `require`, `module` or `exports` at the top level does not use Node's:
    // its require calls and CommonJS exports are not read.
    const shadowed = topLevelNames(file.program);
    const nodeRequire = !shadowed.has('require');
    if (shadowed.has('module') || shadowed.has('exports')) mod.opaqueExports = true;
    const bind = (b: Binding) => {
      // A name declared twice at the top level is not resolved.
      if (bindings.has(b.name))
        bindings.set(b.name, { kind: 'unresolved', file, name: b.name, at: (b as { at?: JsNode }).at ?? file.program });
      else bindings.set(b.name, b);
    };
    const requireOf = (init: JsNode | undefined): string | undefined => {
      if (!nodeRequire) return undefined;
      const n = unwrap(init);
      if (n?.type !== 'CallExpression' || identifierName(n.callee as JsNode) !== 'require') return undefined;
      const args = n.arguments as JsNode[];
      return args.length === 1 ? stringValue(args[0]) : undefined;
    };
    const declare = (decl: JsNode) => {
      for (const d of decl.declarations as JsNode[]) {
        const id = d.id as JsNode;
        const init = d.init as JsNode | undefined;
        const spec = requireOf(init);
        if (id.type === 'Identifier') {
          const name = id.name as string;
          if (decl.kind !== 'const' && again.has(name)) {
            bind({ kind: 'unresolved', file, name, at: d });
            continue;
          }
          if (spec !== undefined) bind({ kind: 'import', file, name, specifier: spec, imported: 'require', at: d });
          else {
            // a member of a required module, bound to a name
            const n = unwrap(init);
            const inner = n?.type === 'MemberExpression' && !n.computed ? requireOf(n.object as JsNode) : undefined;
            const prop = n?.type === 'MemberExpression' ? identifierName(n.property as JsNode) : undefined;
            if (inner !== undefined && prop)
              bind({ kind: 'import', file, name, specifier: inner, imported: prop, at: d });
            else bind({ kind: 'declared', file, name, declarator: d, init });
          }
        } else if (id.type === 'ObjectPattern' && spec !== undefined) {
          for (const p of id.properties as JsNode[]) {
            const key =
              p.type === 'Property' && !p.computed
                ? (identifierName(p.key as JsNode) ?? stringValue(p.key as JsNode))
                : undefined;
            const local = p.type === 'Property' ? identifierName(p.value as JsNode) : undefined;
            if (key && local) bind({ kind: 'import', file, name: local, specifier: spec, imported: key, at: d });
            else
              walk(p, (n) => {
                if (n.type === 'Identifier') bind({ kind: 'unresolved', file, name: n.name as string, at: d });
              });
          }
        } else {
          walk(id, (n) => {
            if (n.type === 'Identifier') bind({ kind: 'unresolved', file, name: n.name as string, at: d });
          });
        }
      }
    };
    for (const s of file.program.body as JsNode[]) {
      if (s.type === 'ImportDeclaration') {
        if (s.importKind === 'type') continue;
        const specifier = (s.source as JsNode).value as string;
        for (const sp of (s.specifiers as JsNode[]) ?? []) {
          if (sp.importKind === 'type') continue;
          const name = (sp.local as JsNode).name as string;
          const imported =
            sp.type === 'ImportDefaultSpecifier'
              ? 'default'
              : sp.type === 'ImportNamespaceSpecifier'
                ? '*'
                : (identifierName(sp.imported as JsNode) ?? stringValue(sp.imported as JsNode) ?? '?');
          bind({ kind: 'import', file, name, specifier, imported, at: sp });
        }
      } else if (s.type === 'VariableDeclaration') declare(s);
      else if (s.type === 'FunctionDeclaration' && s.id) {
        const name = (s.id as JsNode).name as string;
        bind(again.has(name) ? { kind: 'unresolved', file, name, at: s } : { kind: 'function', file, name, node: s });
      } else if (s.type === 'ClassDeclaration' && s.id)
        bind({ kind: 'unresolved', file, name: (s.id as JsNode).name as string, at: s });
      else if (s.type === 'ExportNamedDeclaration') {
        if (s.exportKind === 'type') continue;
        const decl = s.declaration as JsNode | undefined;
        if (decl?.type === 'VariableDeclaration') {
          declare(decl);
          for (const d of decl.declarations as JsNode[]) {
            const name = identifierName(d.id as JsNode);
            if (name) exports.set(name, { value: d.id as JsNode, local: name });
          }
        } else if (decl?.type === 'FunctionDeclaration' && decl.id) {
          const name = (decl.id as JsNode).name as string;
          bind(
            again.has(name)
              ? { kind: 'unresolved', file, name, at: decl }
              : { kind: 'function', file, name, node: decl },
          );
          exports.set(name, { value: decl.id as JsNode, local: name });
        } else if (decl && !decl.type.startsWith('TS')) mod.opaqueExports = true;
        const source = s.source ? ((s.source as JsNode).value as string) : undefined;
        for (const sp of (s.specifiers as JsNode[]) ?? []) {
          if (sp.exportKind === 'type') continue;
          const local = identifierName(sp.local as JsNode) ?? stringValue(sp.local as JsNode);
          const exported = identifierName(sp.exported as JsNode) ?? stringValue(sp.exported as JsNode);
          if (!local || !exported) {
            mod.opaqueExports = true;
            continue;
          }
          if (source !== undefined) reexports.set(exported, { specifier: source, imported: local });
          else exports.set(exported, { value: sp.local as JsNode, local });
        }
      } else if (s.type === 'ExportDefaultDeclaration') {
        const decl = s.declaration as JsNode;
        if (decl.type === 'FunctionDeclaration' && decl.id)
          bind({ kind: 'function', file, name: (decl.id as JsNode).name as string, node: decl });
        mod.defaultExport = decl;
      } else if (s.type === 'ExportAllDeclaration') {
        if (s.exported) mod.opaqueExports = true;
        else starReexports.push((s.source as JsNode).value as string);
      } else if (s.type === 'TSExportAssignment') {
        mod.defaultExport = s.expression as JsNode;
      }
    }
    // CommonJS exports, anywhere in the file: only top-level literal assignments are read.
    const top = new Set(file.program.body as JsNode[]);
    let cjs = false;
    walk(file.program, (n, parents) => {
      if (n.type !== 'AssignmentExpression') return;
      const left = memberPath(n.left as JsNode);
      if (!left || !((left[0] === 'module' && left[1] === 'exports') || left[0] === 'exports')) return;
      cjs = true;
      const stmt = parents[parents.length - 1];
      const atTop = stmt?.type === 'ExpressionStatement' && top.has(stmt);
      if (!atTop || n.operator !== '=') {
        mod.opaqueExports = true;
        return;
      }
      const right = n.right as JsNode;
      if (left.length === 2 && left[0] === 'module') {
        if (mod.defaultExport) mod.opaqueExports = true;
        mod.defaultExport = right;
        const obj = unwrap(right);
        if (obj?.type === 'ObjectExpression') {
          for (const p of obj.properties as JsNode[]) {
            const key =
              p.type === 'Property' && !p.computed
                ? (identifierName(p.key as JsNode) ?? stringValue(p.key as JsNode))
                : undefined;
            if (!key) {
              mod.opaqueExports = true;
              continue;
            }
            exports.set(key, {
              value: p.value as JsNode,
              ...(identifierName(p.value as JsNode) ? { local: identifierName(p.value as JsNode)! } : {}),
            });
          }
        }
      } else if ((left.length === 3 && left[0] === 'module') || (left.length === 2 && left[0] === 'exports')) {
        const name = left[left.length - 1]!;
        if (exports.has(name)) mod.opaqueExports = true;
        exports.set(name, { value: right, ...(identifierName(right) ? { local: identifierName(right)! } : {}) });
      } else mod.opaqueExports = true;
    });
    // A file that is an ES module and also assigns CommonJS exports is not followed.
    if (mod.esm && cjs) mod.opaqueExports = true;
    return mod;
  }

  binding(file: JsFile, name: string): Binding | undefined {
    return this.modules.get(file)?.bindings.get(name);
  }

  /** Whether `require` in this file is Node's (the file binds no top-level name of its own for it). */
  nodeRequire(file: JsFile): boolean {
    return !this.modules.get(file)?.bindings.has('require') && !topLevelNames(file.program).has('require');
  }

  /** Resolves a module specifier written in `from` to a captured file, a package, or nothing certain. */
  resolve(from: JsFile, specifier: string): ModuleTarget {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      if (specifier.startsWith('node:')) return { kind: 'package', name: specifier };
      const parts = specifier.split('/');
      return { kind: 'package', name: specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]! };
    }
    if (specifier.startsWith('/')) return { kind: 'unresolved' };
    const dir = from.path.includes('/') ? from.path.slice(0, from.path.lastIndexOf('/')) : '';
    const parts = dir ? dir.split('/') : [];
    for (const seg of specifier.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') {
        if (!parts.length) return { kind: 'unresolved' };
        parts.pop();
      } else parts.push(seg);
    }
    const base = parts.join('/');
    // TypeScript's ESM convention writes the emitted extension (`./x.js` for `./x.ts`).
    const swap: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
    const candidates = new Set<string>();
    const ext = /\.[cm]?[jt]s$/.exec(base)?.[0];
    if (ext) {
      candidates.add(base);
      for (const s of swap[ext] ?? []) candidates.add(base.slice(0, -ext.length) + s);
    } else
      for (const e of ['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs', '/index.ts', '/index.js'])
        candidates.add(base + e);
    const hits = [...candidates].map((c) => this.byPath.get(c)).filter((f): f is JsFile => !!f);
    return hits.length === 1 ? { kind: 'file', file: hits[0]! } : { kind: 'unresolved' };
  }

  /**
   * What a module exports under `name` ('default' for the default export or `module.exports`), as an expression in
   * the exporting file, following named re-exports. Undefined when the export is not statically readable.
   */
  exportOf(
    file: JsFile,
    name: string,
    seen = new Set<string>(),
  ): { file: JsFile; value: JsNode; local?: string } | undefined {
    const key = `${file.path}\u0000${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const mod = this.modules.get(file);
    if (!mod || mod.opaqueExports) return undefined;
    if (name === 'default') {
      const d = mod.defaultExport;
      if (!d) return undefined;
      const local = d.type === 'FunctionDeclaration' ? undefined : identifierName(d);
      return { file, value: d, ...(local ? { local } : {}) };
    }
    const e = mod.exports.get(name);
    if (e) return { file, ...e };
    const r = mod.reexports.get(name);
    if (r) {
      const t = this.resolve(file, r.specifier);
      return t.kind === 'file' ? this.exportOf(t.file, r.imported, seen) : undefined;
    }
    // A name a star re-export could supply is not followed.
    return undefined;
  }

  /** Requiring a captured CommonJS file returns its module.exports; an ES module's namespace is not read. */
  isCommonJs(file: JsFile): boolean {
    const m = this.modules.get(file);
    return !!m && !m.esm;
  }
}

export { isNode };

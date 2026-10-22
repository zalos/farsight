// Name resolution over captured Java source, for the Spring pack. A type or annotation named in a file resolves to a
// declaration in the captured source, to an external fully qualified name (an explicit import, a qualified name or
// java.lang), or to nothing certain (a wildcard import or an unknown name), which callers treat as unknown. It reads
// declarations and imports only; nothing is compiled or loaded.
import { annotationsOf, named, walk, type Annotation, type JavaFile, type JavaNode } from './syntax.js';

export interface Declared {
  readonly name: string;
  readonly pkg: string;
  readonly fqn: string;
  readonly file: JavaFile;
  readonly node: JavaNode;
  readonly kind: 'class' | 'interface' | 'annotation';
}

export type Resolved = { readonly kind: 'captured'; readonly decl: Declared } | { readonly kind: 'external'; readonly fqn: string }
  /** Several wildcard imports could supply the name, none of them captured: it is one of these. */
  | { readonly kind: 'one-of'; readonly fqns: readonly string[] } | { readonly kind: 'unknown' };

interface Imports { readonly single: Map<string, string>; readonly wildcards: string[]; readonly staticSingle: Set<string>; readonly staticWildcards: string[] }

const JAVA_LANG = new Set(['Object', 'String', 'Override', 'Deprecated', 'SuppressWarnings', 'FunctionalInterface', 'SafeVarargs', 'Exception', 'Integer', 'Long', 'Boolean']);
const DECL_KINDS: Record<string, Declared['kind']> = { class_declaration: 'class', interface_declaration: 'interface', annotation_type_declaration: 'annotation', record_declaration: 'class', enum_declaration: 'class' };

export function packageOf(file: JavaFile): string {
  const decl = named(file.root).find(n => n.type === 'package_declaration');
  return decl ? decl.text.replace(/^package\s+/, '').replace(/;\s*$/, '').replace(/\s+/g, '') : '';
}

export class TypeIndex {
  private readonly byFqn = new Map<string, Declared[]>();
  private readonly bySimple = new Map<string, Declared[]>();
  private readonly imports = new Map<JavaFile, Imports>();

  constructor(files: readonly JavaFile[]) {
    for (const file of files) {
      const pkg = packageOf(file);
      walk(file.root, n => {
        const kind = DECL_KINDS[n.type];
        if (!kind) return;
        const name = n.childForFieldName('name')?.text;
        if (!name) return;
        // Nested types are named Outer.Inner from the package.
        const outer: string[] = [];
        let p = n.parent;
        while (p) { if (DECL_KINDS[p.type]) outer.unshift(p.childForFieldName('name')?.text ?? '?'); p = p.parent; }
        const fqn = [pkg, ...outer, name].filter(Boolean).join('.');
        const d: Declared = { name, pkg, fqn, file, node: n, kind };
        for (const [map, key] of [[this.byFqn, fqn], [this.bySimple, name]] as const) {
          const list = map.get(key);
          if (list) list.push(d); else map.set(key, [d]);
        }
      });
      const single = new Map<string, string>();
      const wildcards: string[] = [];
      const staticSingle = new Set<string>();
      const staticWildcards: string[] = [];
      for (const imp of named(file.root).filter(n => n.type === 'import_declaration')) {
        const text = imp.text.replace(/^import\s+/, '').replace(/;\s*$/, '').replace(/\s+/g, ' ').trim();
        const isStatic = text.startsWith('static ');
        const path = (isStatic ? text.slice(7) : text).replace(/\s+/g, '');
        if (path.endsWith('.*')) (isStatic ? staticWildcards : wildcards).push(path.slice(0, -2));
        else if (isStatic) staticSingle.add(path);
        else single.set(path.split('.').pop()!, path);
      }
      this.imports.set(file, { single, wildcards, staticSingle, staticWildcards });
    }
  }

  /** Resolves a type or annotation name as written in `file`. */
  resolve(file: JavaFile, written: string): Resolved {
    const text = written.replace(/<[\s\S]*>/g, '').replace(/\[\s*\]/g, '').replace(/^@/, '').replace(/\s+/g, '');
    const one = (list: Declared[] | undefined): Resolved | undefined =>
      list?.length === 1 ? { kind: 'captured', decl: list[0]! } : list && list.length > 1 ? { kind: 'unknown' } : undefined;
    if (text.includes('.')) {
      const [head, ...rest] = text.split('.');
      // Outer.Inner where Outer is itself resolvable.
      if (/^[A-Z]/.test(head!)) {
        const outer = this.resolve(file, head!);
        if (outer.kind === 'captured') return one(this.byFqn.get(`${outer.decl.fqn}.${rest.join('.')}`)) ?? { kind: 'unknown' };
        if (outer.kind === 'external') return { kind: 'external', fqn: `${outer.fqn}.${rest.join('.')}` };
        return { kind: 'unknown' };
      }
      return one(this.byFqn.get(text)) ?? { kind: 'external', fqn: text };
    }
    const imp = this.imports.get(file);
    const single = imp?.single.get(text);
    if (single) return one(this.byFqn.get(single)) ?? { kind: 'external', fqn: single };
    const local = one(this.byFqn.get([packageOf(file), text].filter(Boolean).join('.')));
    if (local) return local;
    // A type declared in this file (a nested type referred to by its simple name).
    const inFile = (this.bySimple.get(text) ?? []).filter(d => d.file === file);
    if (inFile.length === 1) return { kind: 'captured', decl: inFile[0]! };
    if (imp?.wildcards.length) {
      const candidates = imp.wildcards.flatMap(w => this.byFqn.get(`${w}.${text}`) ?? []);
      if (candidates.length === 1) return { kind: 'captured', decl: candidates[0]! };
      if (candidates.length > 1) return { kind: 'unknown' };
      // Not captured: Java requires the name to come from one of the wildcard packages (or java.lang).
      const external = imp.wildcards.filter(w => !this.capturedPackage(w)).map(w => `${w}.${text}`);
      if (JAVA_LANG.has(text)) external.push(`java.lang.${text}`);
      if (external.length === 1) return { kind: 'external', fqn: external[0]! };
      return external.length ? { kind: 'one-of', fqns: external } : { kind: 'unknown' };
    }
    if (JAVA_LANG.has(text)) return { kind: 'external', fqn: `java.lang.${text}` };
    return { kind: 'unknown' };
  }

  private capturedPackage(pkg: string): boolean {
    for (const d of this.byFqn.values()) if (d.some(x => x.pkg === pkg)) return true;
    return false;
  }

  /** Whether an unqualified static call `name()` in `file` is the given static member, and nothing local shadows it. */
  isStaticImport(file: JavaFile, name: string, member: string): boolean {
    const imp = this.imports.get(file);
    const owner = member.slice(0, member.lastIndexOf('.'));
    if (!imp || !(imp.staticSingle.has(member) || imp.staticWildcards.includes(owner))) return false;
    let shadowed = false;
    walk(file.root, n => { if (n.type === 'method_declaration' && n.childForFieldName('name')?.text === name) shadowed = true; });
    return !shadowed;
  }

  annotationsOf(node: JavaNode): Annotation[] { return annotationsOf(node); }
}

/** Spring annotations that make a class a component (each is, or is meta-annotated with, @Component). */
const STEREOTYPE_FQNS = new Set([
  'org.springframework.stereotype.Component', 'org.springframework.stereotype.Service', 'org.springframework.stereotype.Repository',
  'org.springframework.stereotype.Controller', 'org.springframework.web.bind.annotation.RestController',
  'org.springframework.web.bind.annotation.ControllerAdvice', 'org.springframework.web.bind.annotation.RestControllerAdvice',
  'org.springframework.context.annotation.Configuration', 'org.springframework.boot.SpringBootConfiguration',
  'org.springframework.boot.autoconfigure.SpringBootApplication', 'org.springframework.boot.test.context.TestConfiguration',
]);
/** Annotation packages whose other annotations do not make a class a component. */
const NON_COMPONENT_PREFIXES = ['org.springframework.', 'java.', 'javax.', 'jakarta.', 'lombok.'];

export type Tri = 'yes' | 'no' | 'unknown';

/** Whether the annotations on `node` (in `file`) make it a component, following meta-annotations declared in captured source. */
export function componentStatus(index: TypeIndex, file: JavaFile, node: JavaNode, seen = new Set<JavaNode>()): Tri {
  let unknown = false;
  for (const a of annotationsOf(node)) {
    const r = index.resolve(file, a.node.childForFieldName('name')?.text ?? a.name);
    if (r.kind === 'external' || r.kind === 'one-of') {
      const fqns = r.kind === 'external' ? [r.fqn] : r.fqns;
      if (fqns.every(f => STEREOTYPE_FQNS.has(f))) return 'yes';
      if (fqns.some(f => STEREOTYPE_FQNS.has(f) || !NON_COMPONENT_PREFIXES.some(p => f.startsWith(p)))) unknown = true;
    } else if (r.kind === 'captured') {
      if (r.decl.kind !== 'annotation' || seen.has(r.decl.node)) { unknown = r.decl.kind !== 'annotation' || unknown; continue; }
      seen.add(r.decl.node);
      const meta = componentStatus(index, r.decl.file, r.decl.node, seen);
      if (meta === 'yes') return 'yes';
      if (meta === 'unknown') unknown = true;
    } else unknown = true;
  }
  return unknown ? 'unknown' : 'no';
}

/** Whether `node` carries an annotation that resolves to `fqn`, directly or through captured meta-annotations. */
export function hasAnnotation(index: TypeIndex, file: JavaFile, node: JavaNode, fqn: string, seen = new Set<JavaNode>()): Tri {
  let unknown = false;
  for (const a of annotationsOf(node)) {
    const r = index.resolve(file, a.node.childForFieldName('name')?.text ?? a.name);
    if (r.kind === 'external' || r.kind === 'one-of') {
      const fqns = r.kind === 'external' ? [r.fqn] : r.fqns;
      if (fqns.every(f => f === fqn)) return 'yes';
      if (fqns.some(f => f === fqn || !NON_COMPONENT_PREFIXES.some(p => f.startsWith(p)))) unknown = true;
    }
    else if (r.kind === 'captured' && r.decl.kind === 'annotation' && !seen.has(r.decl.node)) {
      seen.add(r.decl.node);
      const meta = hasAnnotation(index, r.decl.file, r.decl.node, fqn, seen);
      if (meta === 'yes') return 'yes';
      if (meta === 'unknown') unknown = true;
    } else if (r.kind === 'unknown') unknown = true;
  }
  return unknown ? 'unknown' : 'no';
}

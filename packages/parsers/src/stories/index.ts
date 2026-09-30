/**
 * The stories post-pass (docs/ARCHITECTURE.md ADR 9). Story files are code:
 * `*.stories.*` in Component Story Format. This pass reads them at ingest and
 * puts one `StoryRef` per named export on the component node the file's
 * default export names as `component:` — so a component's stories are in the
 * graph whether or not any Storybook runs.
 *
 * It also records the repo's Storybooks (`StorybookRef`): every
 * `.storybook/main.*` it finds, its `stories` globs, the port its scripts start
 * it on and the command that starts it, merged with `farsight.config.json →
 * storybook`. It never starts one and never fetches anything; the running
 * Storybook is read by core `storybookLive()` at serve time.
 *
 * Fail-soft like every post-pass: a file that will not parse, a story file with
 * no `component:`, a component the imports do not reach — each is recorded on
 * `meta.stories.unresolved` with its reason, never dropped and never guessed.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { parseSync } from 'oxc-parser';
import type { GraphFragment, GraphNode, StoryRef, StorybookRef, StoriesMeta, StorybookConfig } from '@farsight/core';
import { loadConfig, storyIdOf, storyNameFromExport, autoTitleOf, joinRepoPath } from '@farsight/core';
import { walk, isNode, lineIndex, stringValue, type AstNode } from '../walk.js';
import { collectFiles, SKIP_DIRS, globToRegExp } from '../shared/files.js';
import { docCommentAbove } from '../shared/docs.js';
import { createAliasResolver, resolveFileish } from '../aliases.js';
import type { IngestOptions } from '../types.js';

const STORY_FILE = /\.(stories|story)\.[cm]?[jt]sx?$/;
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

/** A CSF file by name: `button.stories.tsx`, `x.story.js`. */
export function isStoryFile(rel: string): boolean {
  return STORY_FILE.test(rel);
}

function parse(abs: string, source: string): AstNode | null {
  try {
    const result = parseSync(abs, source);
    // oxc returns `program` as an object or a JSON string depending on version
    return (typeof result.program === 'string' ? JSON.parse(result.program) : result.program) as AstNode;
  } catch {
    return null;
  }
}

/** `x satisfies Meta<…>`, `x as Meta`, `(x)` → x. */
function unwrap(n: unknown): AstNode | null {
  let cur = isNode(n) ? n : null;
  while (cur && ['TSSatisfiesExpression', 'TSAsExpression', 'ParenthesizedExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(cur.type)) {
    cur = isNode(cur.expression) ? cur.expression : null;
  }
  return cur;
}

function propsOf(obj: AstNode | null): Map<string, AstNode> {
  const out = new Map<string, AstNode>();
  if (!obj || obj.type !== 'ObjectExpression') return out;
  for (const p of (obj.properties as AstNode[]) ?? []) {
    if (p.type !== 'Property' && p.type !== 'ObjectProperty') continue;
    const key = p.key as AstNode | undefined;
    const name = key && (key.type === 'Identifier' || key.type === 'IdentifierName') ? String(key.name) : stringValue(key);
    if (name && isNode(p.value)) out.set(name, p.value as AstNode);
  }
  return out;
}

function stringList(n: AstNode | undefined): string[] | undefined {
  if (!n || n.type !== 'ArrayExpression') return undefined;
  return ((n.elements as AstNode[]) ?? []).map((e) => stringValue(e)).filter((s): s is string => s != null);
}

/** What one CSF file says, before anything is resolved against the graph. */
export interface ParsedStoryFile {
  title?: string;
  metaId?: string;
  /** the identifier `component:` names */
  component?: string;
  stories: { exportName: string; name?: string; line: number; docs?: string }[];
}

/** Read a CSF file's default export and named exports. Exported for tests. */
export function parseStoryFile(program: AstNode, source: string): ParsedStoryFile {
  const line = lineIndex(source);
  const body = (program.body as AstNode[]) ?? [];
  const decls = new Map<string, AstNode>(); // top-level const name → init
  for (const st of body) {
    const decl = st.type === 'ExportNamedDeclaration' && isNode(st.declaration) ? (st.declaration as AstNode) : st;
    if (decl.type !== 'VariableDeclaration') continue;
    for (const d of (decl.declarations as AstNode[]) ?? []) {
      const id = d.id as AstNode | undefined;
      if (id?.type === 'Identifier' && isNode(d.init)) decls.set(String(id.name), d.init as AstNode);
    }
  }
  const out: ParsedStoryFile = { stories: [] };
  let exclude: string[] | undefined;
  let include: string[] | undefined;
  for (const st of body) {
    if (st.type !== 'ExportDefaultDeclaration') continue;
    let d = unwrap(st.declaration);
    if (d?.type === 'Identifier') d = unwrap(decls.get(String(d.name)));
    const props = propsOf(d);
    const title = stringValue(props.get('title'));
    const id = stringValue(props.get('id'));
    const comp = unwrap(props.get('component'));
    if (title) out.title = title;
    if (id) out.metaId = id;
    if (comp?.type === 'Identifier') out.component = String(comp.name);
    else if (comp?.type === 'MemberExpression' || comp?.type === 'StaticMemberExpression') {
      const obj = comp.object as AstNode | undefined;
      if (obj?.type === 'Identifier') out.component = String(obj.name);
    }
    exclude = stringList(props.get('excludeStories'));
    include = stringList(props.get('includeStories'));
  }
  // `Story.storyName = '…'` (CSF 2) — the name wins over the export's start case
  const storyNames = new Map<string, string>();
  walk(program, (n) => {
    if (n.type !== 'AssignmentExpression') return;
    const left = n.left as AstNode | undefined;
    if (!left || (left.type !== 'MemberExpression' && left.type !== 'StaticMemberExpression')) return;
    const prop = left.property as AstNode | undefined;
    const obj = left.object as AstNode | undefined;
    if (obj?.type === 'Identifier' && prop && String(prop.name) === 'storyName') {
      const v = stringValue(n.right);
      if (v) storyNames.set(String(obj.name), v);
    }
  });
  const add = (exportName: string, at: AstNode, init?: AstNode | null) => {
    if (exportName === '__namedExportsOrder' || exportName === 'default') return;
    if (exclude?.includes(exportName)) return;
    if (include && !include.includes(exportName)) return;
    const named = stringValue(propsOf(unwrap(init)).get('name')) ?? storyNames.get(exportName);
    // the author's sentence as written: prose before the first @tag, markdown kept (a story's
    // docs often quote markup — "renders a real `<a>`" — which the code-doc harvest would strip)
    const raw = docCommentAbove(source, at.start ?? 0, /^\s*$/);
    const docs = raw ? raw.split(/^@\w+/m)[0]!.replace(/\s+/g, ' ').trim() : '';
    out.stories.push({ exportName, line: line(at.start ?? 0), ...(named ? { name: named } : {}), ...(docs ? { docs } : {}) });
  };
  for (const st of body) {
    if (st.type !== 'ExportNamedDeclaration') continue;
    if (st.exportKind === 'type') continue;
    const decl = st.declaration as AstNode | undefined;
    if (decl?.type === 'VariableDeclaration') {
      for (const d of (decl.declarations as AstNode[]) ?? []) {
        const id = d.id as AstNode | undefined;
        if (id?.type === 'Identifier') add(String(id.name), st, d.init as AstNode);
      }
    } else if (decl?.type === 'FunctionDeclaration' && isNode(decl.id)) {
      add(String((decl.id as AstNode).name), st);
    } else if (!decl && !st.source) {
      for (const sp of (st.specifiers as AstNode[]) ?? []) {
        const exported = sp.exported as AstNode | undefined;
        const local = sp.local as AstNode | undefined;
        const name = exported ? String(exported.name ?? stringValue(exported)) : '';
        if (name) add(name, st, local?.type === 'Identifier' ? decls.get(String(local.name)) : undefined);
      }
    }
  }
  return out;
}

// ── the repo's Storybooks ──────────────────────────────────────────────────

/** Every `.storybook` dir holding a `main.*`, repo-relative. Skips vendor/build dirs and every other dot-dir. */
export function findStorybookDirs(repoRoot: string, options: IngestOptions = {}): string[] {
  const excludes = (options.exclude ?? []).map(globToRegExp);
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 10) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const abs = join(dir, entry);
      const rel = relative(repoRoot, abs);
      if (excludes.some((re) => re.test(rel))) continue;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (entry === '.storybook') {
        if (readdirSync(abs).some((f) => /^main\.[cm]?[jt]s$/.test(f))) out.push(rel);
        continue;
      }
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
      visit(abs, depth + 1);
    }
  };
  visit(repoRoot, 0);
  return out.sort();
}

/** The string literals of `stories: [ … ]` in a main file, plus `directory:` of the object form. */
export function storiesGlobsOf(mainSource: string): string[] {
  const m = mainSource.match(/\bstories\s*:\s*\[([\s\S]*?)\](?=\s*[,}\n])/);
  if (!m) return [];
  const out: string[] = [];
  // plain strings are globs; the object form contributes its `directory` (its `files` and `titlePrefix` are not paths)
  for (const s of m[1]!.matchAll(/(?:(\w+)\s*:\s*)?(['"`])([^'"`]+)\2/g)) {
    if (!s[1] || s[1] === 'directory') out.push(s[3]!);
  }
  return out;
}

/** The directory part of a stories glob before its first wildcard (`../src/lib/**` → `../src/lib`). */
export function globBase(glob: string): string {
  const parts = glob.split('/');
  const keep: string[] = [];
  for (const p of parts) {
    if (/[*?[{]|@\(|!\(|\+\(/.test(p)) break;
    keep.push(p);
  }
  // a glob that names a file (no wildcard) — its directory is the base
  if (keep.length === parts.length && /\.[a-z]+$/i.test(keep[keep.length - 1] ?? '')) keep.pop();
  return keep.join('/');
}

function readJson(abs: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

const PORT_RE = /(?:--port[= ]|-p\s+|"port"\s*:\s*)(\d{2,5})/;

/**
 * The port a Storybook is started on and the command that starts it, read off
 * the project's `project.json` (Nx) / `package.json` and the repo root's
 * scripts — never guessed past Storybook's own default (6006, `urlFrom: default`).
 */
function startInfo(repoRoot: string, projectRoot: string): { port?: number; portFrom?: 'script'; command?: string } {
  const out: { port?: number; portFrom?: 'script'; command?: string } = {};
  const projAbs = resolve(repoRoot, projectRoot);
  const nx = readJson(join(projAbs, 'project.json'));
  const nxStory = (nx?.targets as Record<string, unknown> | undefined)?.storybook;
  const nxText = nxStory ? JSON.stringify(nxStory) : '';
  const pm = nxText.match(PORT_RE);
  if (pm) { out.port = Number(pm[1]); out.portFrom = 'script'; }
  const scriptsOf = (pkg: Record<string, unknown> | null) => Object.entries((pkg?.scripts as Record<string, string> | undefined) ?? {});
  const projectName = typeof nx?.name === 'string' ? nx.name : undefined;
  // the root's scripts first: that is where a person types `npm run …`
  const rootScripts = scriptsOf(readJson(join(repoRoot, 'package.json')))
    .filter(([name, cmd]) => /storybook/.test(cmd) && !/build-storybook|storybook build|:build-storybook/.test(cmd) && !/^build/.test(name));
  const mine = rootScripts.find(([, cmd]) => (projectName && cmd.includes(projectName)) || cmd.includes(projectRoot)) ?? (rootScripts.length === 1 ? rootScripts[0] : undefined);
  if (mine) {
    out.command = `npm run ${mine[0]}`;
    const p = mine[1].match(PORT_RE);
    if (p && !out.port) { out.port = Number(p[1]); out.portFrom = 'script'; }
  }
  if (projectRoot && projectRoot !== '.') {
    const local = scriptsOf(readJson(join(projAbs, 'package.json'))).find(([, cmd]) => /storybook (dev|start)|start-storybook/.test(cmd));
    if (local) {
      if (!out.command) out.command = `npm --prefix ${projectRoot} run ${local[0]}`;
      const p = local[1].match(PORT_RE);
      if (p && !out.port) { out.port = Number(p[1]); out.portFrom = 'script'; }
    }
  }
  if (!out.command && nxStory && projectName) out.command = `npx nx storybook ${projectName}`;
  return out;
}

function configList(block: StorybookConfig | StorybookConfig[] | undefined): StorybookConfig[] {
  if (!block) return [];
  return Array.isArray(block) ? block : [block];
}

/**
 * The repo's Storybooks: every discovered `.storybook/main.*`, merged with the
 * config's `storybook` entries (matched by `configDir`, or the only one). A
 * config entry naming a dir that was not found is kept — the config is a
 * declaration, and its URL is still where a reader is told to look.
 */
export function storybooksOf(repoRoot: string, configBlock: StorybookConfig | StorybookConfig[] | undefined, options: IngestOptions = {}): StorybookRef[] {
  const found = findStorybookDirs(repoRoot, options);
  const declared = configList(configBlock);
  const refs: StorybookRef[] = [];
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  for (const dir of found) {
    let globs: string[] = [];
    const main = readdirSync(resolve(repoRoot, dir)).find((f) => /^main\.[cm]?[jt]s$/.test(f));
    if (main) { try { globs = storiesGlobsOf(readFileSync(resolve(repoRoot, dir, main), 'utf8')); } catch { /* none read */ } }
    const cfg = declared.find((c) => c.configDir && norm(c.configDir) === dir) ?? (declared.length === 1 && found.length === 1 && !declared[0]!.configDir ? declared[0] : undefined);
    const root = cfg?.root ? norm(cfg.root) : norm(dirname(dir)) || '.';
    const start = startInfo(repoRoot, root === '.' ? '' : root);
    const url = cfg?.url ?? `http://localhost:${start.port ?? 6006}`;
    refs.push({
      configDir: dir, root: root === '' ? '.' : root, url,
      urlFrom: cfg?.url ? 'config' : start.port ? 'script' : 'default',
      ...(cfg?.command ?? start.command ? { command: cfg?.command ?? start.command } : {}),
      ...(cfg?.name ? { name: cfg.name } : {}),
      source: cfg ? 'config' : 'discovered',
      ...(globs.length ? { globs } : {}),
    });
  }
  for (const c of declared) {
    if (!c.configDir || found.includes(norm(c.configDir))) continue;
    if (!c.configDir && found.length === 1) continue;
    const dir = norm(c.configDir);
    refs.push({
      configDir: dir, root: c.root ? norm(c.root) : norm(dirname(dir)) || '.',
      ...(c.url ? { url: c.url, urlFrom: 'config' as const } : {}),
      ...(c.command ? { command: c.command } : {}), ...(c.name ? { name: c.name } : {}),
      source: 'config',
    });
  }
  return refs;
}

// ── component resolution: the import `component:` names, followed through barrels ──

function exportsFrom(abs: string, name: string, repoRoot: string, resolveAlias: (a: string, s: string) => string | null, depth = 0): { file: string; name: string }[] {
  if (depth > 4) return [];
  let src: string;
  try { src = readFileSync(abs, 'utf8'); } catch { return []; }
  const out: { file: string; name: string }[] = [];
  const target = (spec: string): string | null => {
    if (spec.startsWith('.')) { const hit = resolveFileish(resolve(dirname(abs), spec)); return hit ? relative(repoRoot, hit) : null; }
    return resolveAlias(abs, spec);
  };
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const part of m[1]!.split(',')) {
      const [orig, alias] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map((s) => s.trim());
      if (!orig || (alias ?? orig) !== name) continue;
      const file = target(m[2]!);
      if (file) out.push({ file, name: orig }, ...exportsFrom(resolve(repoRoot, file), orig, repoRoot, resolveAlias, depth + 1));
    }
  }
  for (const m of src.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    const file = target(m[1]!);
    if (file) out.push({ file, name }, ...exportsFrom(resolve(repoRoot, file), name, repoRoot, resolveAlias, depth + 1));
  }
  return out;
}

/**
 * Read the repo's story files into the fragment (in place): a `StoryRef` per
 * story on the component node, and `meta.stories`. Never throws.
 */
export function applyStories(fragment: GraphFragment, repoRoot: string, options: IngestOptions = {}): { errors: string[]; meta: StoriesMeta } {
  const repo = fragment.repo;
  const config = options.config === false ? null : loadConfig(join(repoRoot, 'farsight.config.json'));
  const storybooks = storybooksOf(repoRoot, config?.storybook, options);
  const byId = new Map<string, GraphNode>(fragment.nodes.map((n) => [n.id, n]));
  const resolveAlias = createAliasResolver(repoRoot);
  const errors: string[] = [];
  const meta: StoriesMeta = { storybooks, files: 0, stories: 0, components: 0, unresolved: [] };
  // clear what an earlier pass over the same fragment put there (idempotent re-apply)
  for (const n of fragment.nodes) if (n.stories) delete n.stories;

  const bases = storybooks.flatMap((sb) => (sb.globs ?? []).map((g) => {
    const raw = g.replace(/^\.\//, '');
    return { sb, base: joinRepoPath(sb.configDir, globBase(raw)) };
  })).sort((a, b) => b.base.length - a.base.length);
  const bookOf = (file: string) => {
    const hit = bases.find((b) => file === b.base || file.startsWith(`${b.base}/`));
    if (hit) return { sb: hit.sb, base: hit.base };
    // one Storybook whose globs could not be read collects everything
    const bare = storybooks.filter((s) => !s.globs?.length);
    return bare.length === 1 && storybooks.length === 1 ? { sb: bare[0]!, base: bare[0]!.root } : undefined;
  };

  const files = collectFiles(repoRoot, EXTS, options, (name) => name.endsWith('.d.ts')).filter((abs) => isStoryFile(abs)).sort();
  const touched = new Set<string>();
  for (const abs of files) {
    const file = relative(repoRoot, abs).replace(/\\/g, '/');
    meta.files++;
    let source: string;
    try { source = readFileSync(abs, 'utf8'); } catch { continue; }
    const program = parse(abs, source);
    if (!program) { meta.unresolved.push({ file, reason: 'unparsed', stories: 0 }); errors.push(`stories ${file}: could not be parsed`); continue; }
    const parsed = parseStoryFile(program, source);
    if (!parsed.stories.length) continue;
    const book = bookOf(file);
    let title = parsed.title;
    let titleFrom: StoryRef['titleFrom'] = 'meta';
    if (!title && book) { title = autoTitleOf(file.slice(book.base.length).replace(/^\/+/, '')); titleFrom = 'auto'; }
    if (!parsed.component) { meta.unresolved.push({ file, reason: 'no-component', stories: parsed.stories.length }); continue; }

    // the import that binds the identifier `component:` names
    let target: GraphNode | undefined = byId.get(`${repo}::${file}::${parsed.component}`);
    if (!target) {
      for (const n of (program.body as AstNode[]) ?? []) {
        if (target) break;
        if (n.type !== 'ImportDeclaration') continue;
        const spec = stringValue(n.source);
        if (!spec) continue;
        for (const sp of (n.specifiers as AstNode[]) ?? []) {
          const local = (sp.local as AstNode | undefined)?.name;
          if (local !== parsed.component) continue;
          const imported = sp.type === 'ImportDefaultSpecifier' ? 'default' : String((sp.imported as AstNode | undefined)?.name ?? local);
          const hitAbs = spec.startsWith('.') ? resolveFileish(resolve(dirname(abs), spec)) : (() => { const r = resolveAlias(abs, spec); return r ? resolve(repoRoot, r) : null; })();
          if (!hitAbs) continue;
          const hitFile = relative(repoRoot, hitAbs).replace(/\\/g, '/');
          const tries = [{ file: hitFile, name: imported }, ...exportsFrom(hitAbs, imported, repoRoot, resolveAlias)];
          for (const t of tries) {
            if (t.name === 'default') {
              const comps = fragment.nodes.filter((x) => x.loc?.path === t.file && (x.kind === 'component' || x.kind === 'page'));
              if (comps.length === 1) { target = comps[0]; break; }
              continue;
            }
            const n2 = byId.get(`${repo}::${t.file}::${t.name}`);
            if (n2) { target = n2; break; }
          }
        }
      }
    }
    if (!target) { meta.unresolved.push({ file, reason: 'component-unresolved', component: parsed.component, stories: parsed.stories.length }); continue; }
    const idBase = parsed.metaId ?? title;
    const refs: StoryRef[] = parsed.stories.map((s) => ({
      id: idBase ? storyIdOf(idBase, s.exportName) : `${file}#${s.exportName}`,
      name: s.name ?? storyNameFromExport(s.exportName),
      ...(title ? { title, titleFrom } : {}),
      exportName: s.exportName, file, line: s.line,
      ...(s.docs ? { docs: s.docs } : {}),
      ...(book ? { storybook: book.sb.configDir } : {}),
    }));
    target.stories = [...(target.stories ?? []), ...refs];
    touched.add(target.id);
    meta.stories += refs.length;
  }
  meta.components = touched.size;
  if (existsSync(repoRoot) && (meta.storybooks.length || meta.files)) {
    fragment.meta = { ...(fragment.meta ?? { files: 0, sourceHash: 'empty' }), stories: meta };
  }
  return { errors, meta };
}

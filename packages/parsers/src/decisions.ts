/**
 * The decisions pass (the 2026-10-13 outsider round, F8): every `DECISION(<id>)` comment in the source's code joined
 * to the decisions the manifests and the config declare (core decisions.ts `decisionsMetaOf`), the node each comment
 * sits on given the decision's id, the decision's `doc` read and quoted (cited-docs.ts), and the party externals a
 * config declares put on the graph as nodes no code reaches.
 *
 * Where a comment sits decides the node it names:
 * - on a line of its own **above** a declaration (blank lines and other comment lines between) — that declaration's
 *   node (a function, a component, a route, a flag): `// DECISION(D5) four-eyes` over `export function approve…`;
 * - **inside** a body (on a call, beside a branch) — the innermost node whose span holds the line;
 * - above a module-level constant that is not a node (`export const PAYMENT_INTENT_MARKS_PAID = false`) — no node;
 *   the site keeps the constant's name, and a call gated on it (`meta.when`) names the decision at request time.
 * Nothing is guessed: a comment no node and no constant stands under is a site with neither, still listed.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { GraphFragment, GraphNode, DecisionSite, DesignManifest, ExternalDecl } from '@farsight/core';
import { decisionsMetaOf, type DecisionsBlock } from '@farsight/core';
import { collectFiles } from './shared/files.js';
import { rebasePath, type WorkspaceConfig } from './shared/config-files.js';
import { applyCitedDocs } from './cited-docs.js';
import type { IngestOptions } from './types.js';

const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.kt', '.py', '.cs', '.go', '.sql'];
const SITE_RE = /DECISION\(\s*([A-Za-z0-9][\w.:-]{0,40})\s*\)\s*[:—–-]?\s*(.*)$/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|--)/;
const CONST_RE = /^\s*(?:export\s+)?(?:const|let|var|final|static|public|private|protected|\s)*\s*(?:[\w<>[\],]+\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=/;
const MAX_BYTES = 1024 * 1024;

/** Every `DECISION(<id>)` comment in the source's code files, each placed on its node (see the module comment). */
export function decisionSites(repoRoot: string, options: IngestOptions, nodes: GraphNode[], repo: string): (DecisionSite & { id: string })[] {
  const out: (DecisionSite & { id: string })[] = [];
  let files: string[] = [];
  try { files = collectFiles(repoRoot, CODE_EXTS, options, (b) => b.endsWith('.d.ts')); } catch { return out; }
  // the nodes of each file, by path
  const byPath = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (!n.loc || n.loc.repo !== repo) continue;
    if (n.kind === 'file' || n.kind === 'module' || n.kind === 'repo' || n.kind === 'test') continue;
    const list = byPath.get(n.loc.path) ?? [];
    list.push(n);
    byPath.set(n.loc.path, list);
  }
  for (const abs of files) {
    let text: string;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    if (text.length > MAX_BYTES || !text.includes('DECISION(')) continue;
    const path = relative(repoRoot, abs).replace(/\\/g, '/');
    const lines = text.split(/\r?\n/);
    const here = byPath.get(path) ?? [];
    lines.forEach((line, i) => {
      if (!line.includes('DECISION(')) return;
      const m = SITE_RE.exec(line);
      if (!m) return;
      // only a comment counts: the text before DECISION( on its line opens one
      const before = line.slice(0, line.indexOf('DECISION('));
      if (!/(\/\/|\/\*|^\s*\*|#|--)/.test(before)) return;
      const lineNo = i + 1;
      const said = m[2]!.replace(/\*\/\s*$/, '').trim();
      const site: DecisionSite & { id: string } = { id: m[1]!, path, line: lineNo, ...(said ? { text: said.slice(0, 200) } : {}) };
      // the declaration under a comment on its own line: skip blank and comment lines
      let below: number | undefined;
      if (COMMENT_LINE.test(line) || /^\s*$/.test(before)) {
        for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
          const l = lines[j]!;
          if (!l.trim() || COMMENT_LINE.test(l) || /^\s*@\w/.test(l)) continue;
          below = j + 1;
          break;
        }
      }
      const startsAt = below != null ? here.filter((n) => n.loc!.line === below) : [];
      if (startsAt.length) {
        site.nodeId = startsAt.sort((a, b) => spanOf(b) - spanOf(a))[0]!.id;
      } else {
        const holding = here.filter((n) => n.loc!.line <= lineNo && (n.loc!.endLine ?? n.loc!.line) >= lineNo).sort((a, b) => spanOf(a) - spanOf(b));
        if (holding.length) site.nodeId = holding[0]!.id;
        else if (below != null) {
          const c = CONST_RE.exec(lines[below - 1]!);
          if (c) site.symbol = c[1]!;
        }
      }
      out.push(site);
    });
  }
  return out;
}

const spanOf = (n: GraphNode) => (n.loc!.endLine ?? n.loc!.line) - n.loc!.line;

/**
 * Fold the source's decisions into `fragment.meta.decisions` and put each decision's id on the nodes it names, in
 * place. `manifests` are the design manifests the design pass read. Returns nothing; never throws.
 */
export function applyDecisions(fragment: GraphFragment, repoRoot: string, options: IngestOptions, ws: WorkspaceConfig, manifests: { manifest: DesignManifest; path: string }[]): void {
  const repo = fragment.repo;
  const sites = decisionSites(repoRoot, options, fragment.nodes, repo);
  const blocks: DecisionsBlock[] = [];
  for (const f of ws.files) {
    if (!Array.isArray(f.config.decisions)) continue;
    const decisions = f.config.decisions.map((d) => {
      if (!d || typeof d !== 'object' || typeof d.doc !== 'string' || f.root) return d;
      const [p, a] = d.doc.split('#');
      const rebased = rebasePath(f.dir, p!, `${f.path} → decisions.doc`, ws.meta.notes);
      return rebased ? { ...d, doc: a ? `${rebased}#${a}` : rebased } : { ...d, doc: undefined };
    });
    blocks.push({ from: f.path, dir: f.dir, decisions });
  }
  const declares = manifests.some((m) => Array.isArray(m.manifest.decisions) && m.manifest.decisions.length) || blocks.some((b) => b.decisions.length);
  // no decision anywhere: the documents the flows and sentences cite are still read
  if (!sites.length && !declares) { applyCitedDocs(fragment, repoRoot, options); return; }
  const byId = new Map(fragment.nodes.map((n) => [n.id, n]));
  const screenOrFlow = new Map<string, string>();
  for (const n of fragment.nodes) {
    if ((n.kind === 'page' || n.kind === 'component' || n.kind === 'flow') && n.design?.origin === 'manifest' && n.design.id && !screenOrFlow.has(n.design.id)) screenOrFlow.set(n.design.id, n.id);
  }
  const meta = decisionsMetaOf({
    manifests, blocks, sites,
    resolveAffect: (ref) => (byId.has(ref) ? ref : byId.has(`${repo}::${ref}`) ? `${repo}::${ref}` : screenOrFlow.get(ref)),
  });
  // each decision's document, quoted
  const wanted = meta.decisions.filter((d) => d.doc && !/^[a-z]+:\/\//i.test(d.doc)).map((d) => { const [path, anchor] = d.doc!.split('#'); return { path: path!, ...(anchor ? { anchor } : {}) }; });
  const docs = applyCitedDocs(fragment, repoRoot, options, wanted);
  for (const d of meta.decisions) {
    if (d.doc) {
      const [path, anchor] = d.doc.split('#');
      const ref = docs.get(d.doc);
      if (ref) d.docRef = { nodeId: `${repo}::doc::${ref.path}`, path: ref.path, ...(anchor ? { anchor } : {}), ...(ref.title ? { title: ref.title } : {}), ...(ref.quote ? { quote: ref.quote } : {}), ...(ref.cut ? { cut: true as const } : {}) };
      else if (path) meta.notes.push(`decision "${d.id}" names ${d.doc}, which is not a readable document inside the source`);
    }
    for (const id of d.nodes) {
      const n = byId.get(id);
      if (!n) continue;
      n.decisions = [...new Set([...(n.decisions ?? []), d.id])];
    }
  }
  fragment.meta = { files: fragment.meta?.files ?? 0, sourceHash: fragment.meta?.sourceHash ?? '', ...fragment.meta, decisions: meta };
}

/**
 * The party externals a config declares (`externals[]` with `kind: 'party'` and no `import`): one `external` node
 * each, with no location and no edge — declared, no code reaches it. Returns the declarations it put on the graph.
 */
export function applyParties(fragment: GraphFragment, externals: ExternalDecl[] | undefined): ExternalDecl[] {
  const out: ExternalDecl[] = [];
  const have = new Set(fragment.nodes.map((n) => n.id));
  for (const e of externals ?? []) {
    if (!e || e.kind !== 'party' || typeof e.name !== 'string' || !e.name.trim()) continue;
    const name = e.name.trim();
    const id = `${fragment.repo}::external::${name}`;
    if (have.has(id)) continue;
    have.add(id);
    fragment.nodes.push({
      id, kind: 'external', name, tags: ['external', 'party'],
      external: { kind: 'party', source: 'config', ...(e.role ? { role: e.role } : {}), ...(e.persona ? { persona: e.persona } : {}) },
    });
    out.push(e);
  }
  return out;
}

import { mergeOccurrences } from '@farsight/graph';
/**
 * Flag gates — a call under a constant the code itself fixes (lane `moves`, 2026-10-13).
 *
 * The reference app keeps its open decisions as module-level switches: `export const
 * PAYMENT_INTENT_MARKS_PAID = false` beside `if (PAYMENT_INTENT_MARKS_PAID) { await settle(…) }`. The call is in
 * the code and does not run. The parser keeps the edge — the code holds both — and says so on it:
 *
 *   meta.whenFlag  — the constant's name
 *   meta.whenValue — its literal value
 *   meta.whenAt    — `path:line` of its declaration
 *   meta.inactive  — `true` only when that value means the call does not run
 *
 * and an inactive edge's resolution names the fact that decides it (`flag-gate`), the technique the call
 * resolved by kept in the note. Only a literal `const X = true|false` (through `as const`) declared at the top of
 * the caller's own module, or of the module it imports X from (named re-exports and `export *` followed a few
 * hops), counts — never an environment read, never a `let`, never a value a function computes.
 *
 * A branch counts when its test is the bare identifier or its negation: `if (X)` / `if (!X)` (either arm), `X &&
 * call()`, `!X && call()`, `X ? a() : b()`. Anything else (`if (X && other)`, an early `if (!X) return`) is not read.
 */
import type { GraphEdge } from '@farsight/graph';
import { isNode, type AstNode } from './walk.js';

/** strip `( … )`, `as const`, `satisfies T` */
function bare(n: AstNode | undefined): AstNode | undefined {
  let x = n;
  while (x && (x.type === 'ParenthesizedExpression' || x.type === 'TSAsExpression' || x.type === 'TSSatisfiesExpression' || x.type === 'TSNonNullExpression')) x = x.expression as AstNode;
  return x;
}

/** `X` → 'X', `!X` → '!X', `!!X` → 'X'; anything else → undefined */
function identTest(test: AstNode | undefined): string | undefined {
  let t = bare(test);
  let neg = false;
  while (t && t.type === 'UnaryExpression' && t.operator === '!') { neg = !neg; t = bare(t.argument as AstNode); }
  if (!t || t.type !== 'Identifier' || typeof t.name !== 'string') return undefined;
  if (t.name === 'undefined') return undefined;
  return `${neg ? '!' : ''}${t.name}`;
}
const flip = (r: string): string => (r.startsWith('!') ? r.slice(1) : `!${r}`);

/**
 * The flag a parent puts on the child it holds, when the child runs only on one arm of a bare identifier test.
 * `'X'` — the child runs when X is truthy; `'!X'` — when X is falsy.
 */
export function flagRefAt(parent: AstNode, child: AstNode): string | undefined {
  if (parent.type === 'IfStatement' && parent.test !== child) {
    const r = identTest(parent.test as AstNode);
    if (!r) return undefined;
    if (parent.consequent === child) return r;
    if (parent.alternate === child) return flip(r);
    return undefined;
  }
  if (parent.type === 'ConditionalExpression' && parent.test !== child) {
    const r = identTest(parent.test as AstNode);
    if (!r) return undefined;
    if (parent.consequent === child) return r;
    if (parent.alternate === child) return flip(r);
    return undefined;
  }
  if (parent.type === 'LogicalExpression' && parent.right === child && (parent.operator === '&&' || parent.operator === '||')) {
    const r = identTest(parent.left as AstNode);
    if (!r) return undefined;
    return parent.operator === '&&' ? r : flip(r);
  }
  return undefined;
}

/** Every top-level `const X = true|false` (exported or not, through `as const`) in a module. */
export function moduleBoolConsts(program: AstNode, line: (o: number) => number): Map<string, { value: boolean; line: number }> {
  const out = new Map<string, { value: boolean; line: number }>();
  for (const st of (program.body as AstNode[]) ?? []) {
    const decl = st.type === 'ExportNamedDeclaration' && isNode(st.declaration) ? (st.declaration as AstNode) : st;
    if (decl.type !== 'VariableDeclaration' || decl.kind !== 'const') continue;
    for (const d of (decl.declarations as AstNode[]) ?? []) {
      const id = d.id as AstNode | undefined;
      const init = bare(d.init as AstNode | undefined);
      if (id?.type !== 'Identifier' || typeof id.name !== 'string' || !init) continue;
      if ((init.type === 'Literal' || init.type === 'BooleanLiteral') && typeof init.value === 'boolean') out.set(id.name, { value: init.value, line: line(d.start ?? 0) });
    }
  }
  return out;
}

type Imports = Map<string, Map<string, { file: string; name: string }>>;
type Reexports = Map<string, { stars: string[]; named: Map<string, { file: string; name: string }> }>;

/**
 * Resolve every `meta.whenRef` pass 1 left on an edge: the flag's value, where it is declared, and whether the
 * call runs. An edge whose flag cannot be resolved to a literal loses the reference and stays as it was. A call
 * made both under a switched-off flag and outside it is one live edge: the switched-off twin is dropped.
 * Mutates `edges` in place.
 */
export function resolveFlagGates(edges: GraphEdge[], consts: Map<string, Map<string, { value: boolean; line: number }>>, imports: Imports, reexports?: Reexports): void {
  // Resolve each site's flag independently before folding relationship-level twins.
  for (const edge of edges) for (const site of edge.occurrences ?? []) {
    const single: GraphEdge = { id: site.id, kind: edge.kind, from: edge.from, to: edge.to, meta: site.meta, resolution: site.resolution };
    resolveFlagGates([single], consts, imports, reexports);
    site.meta = single.meta;
    site.resolution = single.resolution;
  }
  const lookup = (file: string, name: string, depth = 0): { file: string; value: boolean; line: number } | undefined => {
    if (depth > 4) return undefined;
    const here = consts.get(file)?.get(name);
    if (here) return { file, ...here };
    const re = reexports?.get(file);
    const named = re?.named.get(name);
    if (named) return lookup(named.file, named.name, depth + 1);
    for (const star of re?.stars ?? []) { const hit = lookup(star, name, depth + 1); if (hit) return hit; }
    return undefined;
  };
  const resolve = (file: string, name: string) => {
    const own = consts.get(file)?.get(name);
    if (own) return { file, ...own };
    const imp = imports.get(file)?.get(name);
    return imp ? lookup(imp.file, imp.name) : undefined;
  };
  const keyOf = (e: GraphEdge) => `${e.kind}|${e.from}|${e.to}${e.meta?.op != null ? `|${e.meta.op}` : ''}`;
  /** the caller · callee pairs pass 1 split because one site sat under a flag */
  const split = new Set<string>();
  for (const e of edges) {
    const ref = e.meta?.whenRef;
    if (typeof ref !== 'string') continue;
    split.add(keyOf(e));
    const meta = { ...e.meta! };
    delete meta.whenRef;
    const bar = ref.indexOf('|');
    const file = ref.slice(0, bar);
    // the innermost test first: the first switched-off one decides; else the first one read is kept as a fact
    let pick: { flag: string; value: boolean; at: string; runs: boolean } | undefined;
    for (const r of ref.slice(bar + 1).split(',')) {
      const neg = r.startsWith('!');
      const name = neg ? r.slice(1) : r;
      const hit = resolve(file, name);
      if (!hit) continue;
      const runs = neg ? !hit.value : hit.value;
      const fact = { flag: name, value: hit.value, at: `${hit.file}:${hit.line}`, runs };
      if (!runs) { pick = fact; break; }
      pick ??= fact;
    }
    if (pick) {
      meta.whenFlag = pick.flag;
      meta.whenValue = pick.value;
      meta.whenAt = pick.at;
      if (!pick.runs) {
        meta.inactive = true;
        const was = e.resolution;
        e.resolution = {
          status: was?.status ?? 'resolved', technique: 'flag-gate', confidence: was?.confidence ?? 'HIGH',
          note: `switched off: ${pick.flag} = ${pick.value} (${pick.at})${was ? ` · resolved by ${was.technique}${was.note ? ` — ${was.note}` : ''}` : ''}`,
        };
      }
    }
    if (Object.keys(meta).length) e.meta = meta; else delete e.meta;
  }
  if (!split.size) return;
  // back to one edge per caller · callee where pass 1 split them: the first live one when the callee is reached
  // at all (a call made both under a switched-off flag and outside it reaches the function), else the first
  // switched-off one — and a live call outside any flag wins over one under a flag that lets it run
  const live = new Map<string, GraphEdge>();
  const off = new Map<string, GraphEdge>();
  for (const e of edges) {
    const k = keyOf(e);
    if (!split.has(k)) continue;
    if (e.meta?.inactive) { if (!off.has(k)) off.set(k, e); continue; }
    const had = live.get(k);
    if (!had || (had.meta?.whenFlag !== undefined && e.meta?.whenFlag === undefined)) live.set(k, e);
  }
  const keep = new Set<GraphEdge>();
  const winners = new Map<string, GraphEdge>();
  for (const k of split) { const winner = live.get(k) ?? off.get(k)!; keep.add(winner); winners.set(k, winner); }
  for (const e of edges) {
    const winner = winners.get(keyOf(e));
    if (winner && winner !== e) {
      const sites = mergeOccurrences(winner.occurrences, e.occurrences);
      if (sites) winner.occurrences = sites;
    }
  }
  let w = 0;
  for (const e of edges) if (!split.has(keyOf(e)) || keep.has(e)) edges[w++] = e;
  edges.length = w;
}

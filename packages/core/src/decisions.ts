/**
 * Declared decisions, steps done outside the code, and the parties the app hands work to — what a source says
 * the team decided or left open, so a reader can tell *the team has not decided this* from *Farsight found nothing*
 * (the 2026-10-13 outsider round, F8).
 *
 * - **Decisions** are declared in a manifest's `decisions[]` (`{ id, title, state: open · decided, decided?, owner?,
 *   summary?, doc?, affects? }`) and overridden by `farsight.config.json → decisions[]` field by field, the way a
 *   persona is. The code names one with a `DECISION(<id>)` comment on or above the function, the call or the flag
 *   constant it governs; the parser records each such comment as a site (parsers/src/decisions.ts) and this fold
 *   joins the two by id. A decision's words are the team's, quoted — never generated; it is a declaration printed
 *   as one, never an evidence class and never an absence word.
 * - **Off-platform steps** are a designed screen's `steps[]` entries with `by: person · partner · external`: done by
 *   someone outside the code on purpose. A build state of their own beside *designed, not built* — never a gate,
 *   never a verdict (no test can reach a step that has no code).
 * - **Parties** are `externals[]` entries with `kind: 'party'` and no `import`: a counterparty no code reaches. They
 *   are drawn as a lane when a step or a hand-off names them.
 *
 * Pure: the fold, the lookups, the counts and the text the MCP tool and the CLI print.
 */
import type { DecisionDecl, DecisionRow, DecisionSite, DecisionsMeta, GraphNode, DesignStep } from './graph.js';
import type { DecisionConfigEntry } from './config.js';
import type { GraphIndex } from './query.js';
import { counted, countedText, breakdownText, type Counted } from './counts.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATES = ['open', 'decided'] as const;

/** One config file's `decisions[]` and where it came from (root first, nearest last). */
export interface DecisionsBlock { from: string; dir: string; decisions: DecisionConfigEntry[] }

export interface DecisionsInput {
  manifests: { manifest: { decisions?: unknown }; path: string }[];
  blocks?: DecisionsBlock[];
  /** every `DECISION(<id>)` comment the parser read, with the id it names */
  sites?: (DecisionSite & { id: string })[];
  /** a decision's `affects` entry (a node id, a design screen id, a flow id) → the node id it names, or undefined */
  resolveAffect?: (ref: string) => string | undefined;
}

/** A manifest or config entry read softly: anything that is not a decision is left out, never thrown. */
function readDecl(raw: unknown, partial: boolean): (Partial<DecisionDecl> & { id: string }) | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return undefined;
  const out: Partial<DecisionDecl> & { id: string } = { id };
  const title = str(r.title);
  if (title) out.title = title;
  if ((STATES as readonly unknown[]).includes(r.state)) out.state = r.state as DecisionDecl['state'];
  const decided = str(r.decided);
  if (decided && DATE.test(decided)) out.decided = decided;
  for (const k of ['owner', 'summary', 'doc'] as const) { const v = str(r[k]); if (v) out[k] = v; }
  if (Array.isArray(r.affects)) {
    const list = r.affects.map(str).filter((x): x is string => !!x);
    if (list.length) out.affects = list;
  }
  if (!partial && (!out.title || !out.state)) return undefined;
  return out;
}

/**
 * Every decision of one source: the manifests' declarations (the first manifest to declare an id keeps it; a second
 * with another title is a note — two lists that use one id for two things), each config block's entry over it field by
 * field (root first, nearest last — a block may also declare an id no manifest does, when it gives a title and a
 * state), and every `DECISION(<id>)` comment joined by id. An id the code names that nothing declares is a row of its
 * own (`declared: false`) and a note.
 */
export function decisionsMetaOf(input: DecisionsInput): DecisionsMeta {
  const notes: string[] = [];
  const rows = new Map<string, DecisionRow>();
  const firstFrom = new Map<string, string>();
  for (const { manifest, path } of input.manifests) {
    const list = Array.isArray(manifest.decisions) ? manifest.decisions : [];
    for (const raw of list) {
      const d = readDecl(raw, false);
      if (!d) {
        const id = raw && typeof raw === 'object' ? str((raw as Record<string, unknown>).id) : undefined;
        notes.push(`decision ${id ? `"${id}" ` : ''}in ${path} needs an id, a title and a state (open or decided); it was left out`);
        continue;
      }
      const had = rows.get(d.id);
      if (had) {
        if ((had.title ?? '').toLowerCase() !== (d.title ?? '').toLowerCase()) {
          notes.push(`decision "${d.id}" is declared by ${firstFrom.get(d.id)} as "${had.title}" and by ${path} as "${d.title}" — one id for two decisions; "${had.title}" from ${firstFrom.get(d.id)} is kept`);
        }
        continue;
      }
      firstFrom.set(d.id, path);
      rows.set(d.id, { ...d, declared: true, from: path, sites: [], nodes: [] });
    }
  }
  for (const b of input.blocks ?? []) {
    for (const raw of Array.isArray(b.decisions) ? b.decisions : []) {
      const d = readDecl(raw, true);
      if (!d) continue;
      const had = rows.get(d.id);
      if (!had) {
        if (!d.title || !d.state) {
          notes.push(`decision "${d.id}" is named by ${b.from} but no manifest declares it, and the entry gives no title and state of its own`);
          continue;
        }
        rows.set(d.id, { ...d, declared: true, from: b.from, sites: [], nodes: [] } as DecisionRow);
        continue;
      }
      const { id: _id, ...fields } = d;
      Object.assign(had, fields);
      had.from = b.from;
    }
  }
  for (const r of rows.values()) if (r.state === 'open' && r.decided) delete r.decided;
  for (const s of input.sites ?? []) {
    const { id, ...site } = s;
    let row = rows.get(id);
    if (!row) {
      row = { id, declared: false, sites: [], nodes: [] };
      rows.set(id, row);
    }
    row.sites.push(site);
    if (site.nodeId && !row.nodes.includes(site.nodeId)) row.nodes.push(site.nodeId);
  }
  for (const r of rows.values()) {
    if (!r.declared) {
      const at = r.sites.slice(0, 3).map((s) => `${s.path}:${s.line}`).join(', ');
      notes.push(`decision "${r.id}" is named in code (${at}${r.sites.length > 3 ? `, +${r.sites.length - 3}` : ''}) but no manifest or config declares it — its title, state and owner are unknown to Farsight`);
    }
    for (const ref of r.affects ?? []) {
      const nodeId = input.resolveAffect?.(ref);
      if (!nodeId) { notes.push(`decision "${r.id}" affects "${ref}", which names no node or screen in this source`); continue; }
      if (!r.nodes.includes(nodeId)) r.nodes.push(nodeId);
    }
    r.sites.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }
  const decisions = [...rows.values()].sort((a, b) => Number(b.declared) - Number(a.declared) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { decisions, notes };
}

/** The decision rows of every source (or one), each with the source it belongs to. */
export function decisionRows(metas: Record<string, DecisionsMeta> | undefined, repo?: string): (DecisionRow & { repo: string })[] {
  const out: (DecisionRow & { repo: string })[] = [];
  for (const [r, m] of Object.entries(metas ?? {})) {
    if (repo && r !== repo) continue;
    for (const d of m.decisions ?? []) out.push({ ...d, repo: r });
  }
  return out;
}

/**
 * The decisions that bear on one node: the ids its `decisions` field carries (a comment on it or in it, an `affects`
 * entry), and a decision whose comment sits on a module-level flag constant when an edge leaving the node is gated on
 * that constant (`meta.when` names it — the call runs only when the flag is set).
 */
export function decisionsFor(index: GraphIndex, metas: Record<string, DecisionsMeta> | undefined, nodeId: string): (DecisionRow & { repo: string })[] {
  const node = index.byId.get(nodeId);
  if (!node) return [];
  const repo = node.loc?.repo ?? nodeId.split('::')[0]!;
  const rows = decisionRows(metas, repo);
  const ids = new Set(node.decisions ?? []);
  const flagRows = rows.filter((r) => r.sites.some((s) => s.symbol));
  if (flagRows.length) {
    for (const e of index.out.get(nodeId) ?? []) {
      const when = e.meta?.when;
      if (when == null) continue;
      const text = typeof when === 'string' ? when : JSON.stringify(when);
      for (const r of flagRows) if (r.sites.some((s) => s.symbol && new RegExp(`\\b${s.symbol}\\b`).test(text))) ids.add(r.id);
    }
  }
  return rows.filter((r) => ids.has(r.id));
}

/** The nodes whose edges are gated on a flag constant a decision's comment sits above (`meta.when` names it). */
function flagGated(index: GraphIndex, row: DecisionRow): string[] {
  const symbols = row.sites.map((s) => s.symbol).filter((x): x is string => !!x);
  if (!symbols.length) return [];
  const res = symbols.map((sym) => new RegExp(`\\b${sym}\\b`));
  const out = new Set<string>();
  for (const [from, edges] of index.out) {
    for (const e of edges) {
      const when = e.meta?.when;
      if (when == null) continue;
      const text = typeof when === 'string' ? when : JSON.stringify(when);
      if (res.some((re) => re.test(text))) out.add(from);
    }
  }
  return [...out];
}

/** The answer `GET /api/decisions`, MCP `decisions json:true` and `farsight decisions --json` give: one fold. */
export interface DecisionsAnswer {
  counted: { decisions: Counted; cited: Counted };
  decisions: (DecisionRow & { repo: string; names: Record<string, string> })[];
  notes: string[];
}

/**
 * Every decision (or the one `id` names, or the ones on `node`), each with the nodes it bears on — its comments' and
 * its `affects`', and the callers whose calls are gated on a flag constant it sits above — and the names of those
 * nodes, the counts over the sources in scope and the notes.
 */
export function decisionsAnswer(index: GraphIndex, metas: Record<string, DecisionsMeta> | undefined, opts: { repo?: string; id?: string; node?: string } = {}): DecisionsAnswer {
  let rows = opts.node ? decisionsFor(index, metas, opts.node) : decisionRows(metas, opts.repo);
  if (opts.id) rows = rows.filter((r) => r.id === opts.id);
  const decisions = rows.map((r) => {
    const nodes = [...new Set([...r.nodes, ...flagGated(index, r)])];
    const names: Record<string, string> = {};
    for (const id of nodes) { const n = index.byId.get(id); if (n) names[id] = n.design?.name ?? n.name; }
    return { ...r, nodes, names };
  });
  const notes = Object.entries(metas ?? {}).filter(([r]) => !opts.repo || r === opts.repo).flatMap(([, m]) => m.notes ?? []);
  return { counted: decisionsCounted(metas, opts.repo), decisions, notes };
}

/** One row as the chip prints it: `pending decision D7 · who verifies a bank-detail change`, or `decided D5 · …`. */
export function decisionChipWords(d: Pick<DecisionRow, 'id' | 'title' | 'state'>): { key: string; vars: Record<string, string> } {
  const key = !d.state ? 'decision.chip.unknown' : d.state === 'open' ? 'decision.chip.open' : 'decision.chip.decided';
  return { key, vars: { id: d.id, title: d.title ?? '' } };
}

/**
 * The counts for the decisions of every source in scope (or one): every decision by state — open · decided · named in
 * code with no declaration — and the same set by whether the code names it — cited in code · uncited. Two partitions
 * of one number, each a `Counted` over the sources in scope.
 */
export function decisionsCounted(metas: Record<string, DecisionsMeta> | undefined, repo?: string): { decisions: Counted; cited: Counted } {
  const rows = decisionRows(metas, repo);
  const open = rows.filter((r) => r.declared && r.state === 'open').length;
  const decided = rows.filter((r) => r.declared && r.state === 'decided').length;
  const codeOnly = rows.filter((r) => !r.declared).length;
  const cited = rows.filter((r) => r.sites.length).length;
  const src = 'decisionsCounted ← meta.decisions[repo].decisions';
  const recheck = { cli: `farsight decisions${repo ? ` --repo ${repo}` : ''}`, mcp: 'decisions' };
  return {
    decisions: counted(rows.length, 'count.unit.decisions', 'count.scope.workspace', src, {
      bizUnit: 'count.unit.decisions',
      breakdown: [{ key: 'count.part.decisionsOpen', n: open }, { key: 'count.part.decisionsDecided', n: decided }, { key: 'count.part.decisionsCodeOnly', n: codeOnly }],
      recheck,
    }),
    cited: counted(rows.length, 'count.unit.decisions', 'count.scope.workspace', `${src} → sites`, {
      bizUnit: 'count.unit.decisions',
      breakdown: [{ key: 'count.part.decisionsCited', n: cited }, { key: 'count.part.decisionsUncited', n: rows.length - cited }],
      recheck,
    }),
  };
}

/** The one line `graph_overview` prints, or nothing when no source has a decision. */
export function decisionsOverviewLine(metas: Record<string, DecisionsMeta> | undefined): string {
  const c = decisionsCounted(metas);
  if (!c.decisions.n) return '';
  return `decisions: ${countedText(c.decisions)} (${breakdownText(c.decisions)}; ${breakdownText(c.cited)}) — decisions lists them`;
}

/**
 * Every decision (or one, or the ones on one node) as lines for a terminal or an agent: id, state and date, the title
 * and the owner, the team's summary quoted, the document with its quoted first paragraph, where the code names it and
 * what it bears on; then the notes. Words the team wrote are printed inside quotes, never reworded.
 */
export function decisionsText(
  metas: Record<string, DecisionsMeta> | undefined,
  opts: { repo?: string; id?: string; node?: string; index?: GraphIndex } = {},
): string[] {
  let rows = decisionRows(metas, opts.repo);
  if (opts.node && opts.index) rows = decisionsFor(opts.index, metas, opts.node);
  if (opts.id) rows = rows.filter((r) => r.id === opts.id);
  const out: string[] = [];
  if (!opts.id && !opts.node) {
    const c = decisionsCounted(metas, opts.repo);
    out.push(`${countedText(c.decisions)}: ${breakdownText(c.decisions)} · ${breakdownText(c.cited)}`);
  }
  if (!rows.length) {
    out.push(opts.node ? `no decision names ${opts.node}: no DECISION(<id>) comment sits on it or in it, and no declared decision lists it under affects`
      : opts.id ? `no decision "${opts.id}" is declared or named in code` + (opts.repo ? ` in ${opts.repo}` : '')
        : 'no decisions: no manifest or config declares one (decisions[]) and no DECISION(<id>) comment names one');
    return out;
  }
  const name = (id: string) => opts.index?.byId.get(id)?.name ?? id;
  for (const r of rows) {
    out.push('');
    const state = !r.declared ? 'named in code, not declared' : r.state === 'decided' ? `decided${r.decided ? ` ${r.decided}` : ''}` : 'open — not decided yet';
    out.push(`## ${r.id}${r.title ? ` · "${r.title}"` : ''} — ${state}${r.repo ? ` (${r.repo})` : ''}`);
    if (r.owner) out.push(`owner: ${r.owner}`);
    if (r.summary) out.push(`the team's words: "${r.summary}"`);
    if (r.docRef) {
      out.push(`document: ${r.docRef.path}${r.docRef.anchor ? `#${r.docRef.anchor}` : ''}${r.docRef.title ? ` · "${r.docRef.title}"` : ''}`);
      if (r.docRef.quote) out.push(`  quoted: "${r.docRef.quote}${r.docRef.cut ? ' …' : ''}"`);
    } else if (r.doc) out.push(`document: ${r.doc} (not found inside the source)`);
    for (const s of r.sites) out.push(`named in code: ${s.path}:${s.line}${s.nodeId ? ` · on ${name(s.nodeId)}` : s.symbol ? ` · above ${s.symbol}` : ''}${s.text ? ` · "${s.text}"` : ''}`);
    if (!r.sites.length && r.declared) out.push('named in code: nowhere — no DECISION(<id>) comment names it');
    const affects = r.nodes.filter((n) => !r.sites.some((s) => s.nodeId === n));
    if (affects.length) out.push(`affects: ${affects.map(name).join(' · ')}`);
    if (r.from) out.push(`declared in: ${r.from}`);
  }
  const notes = Object.entries(metas ?? {}).filter(([r]) => !opts.repo || r === opts.repo).flatMap(([, m]) => m.notes ?? []);
  if (notes.length && !opts.id && !opts.node) { out.push(''); out.push('notes:'); for (const n of notes) out.push(`- ${n}`); }
  return out;
}

// ── steps done outside the code, and the parties that do them ─────────────────

/** Who does a step outside the code: the closed set a manifest's `steps[].by` takes. */
export const BY = ['person', 'partner', 'external'] as const;

/** A designed step somebody does outside the code, as a surface prints it. */
export interface OffPlatformStep {
  /** the step id the manifest gives (`OPS-04c.4`) */
  id: string;
  name: string;
  by: NonNullable<DesignStep['by']>;
  who?: string;
  where?: string;
  /** the screen node it is declared on */
  screen: string;
  /** the party external `who` names, when it names one */
  party?: { id: string; name: string; role?: string };
}

/** The party external nodes of one source (`kind: 'party'`), by lower-cased name. */
export function partiesOf(index: GraphIndex, repo?: string): GraphNode[] {
  const out: GraphNode[] = [];
  for (const n of index.byId.values()) {
    if (n.kind !== 'external' || n.external?.kind !== 'party') continue;
    if (repo && !n.id.startsWith(`${repo}::`)) continue;
    out.push(n);
  }
  return out;
}

/** The party a step's `who` names — the party's name, or the last part of its node id — in the screen's source. */
export function partyNamed(index: GraphIndex, repo: string, who: string | undefined): GraphNode | undefined {
  const k = (who ?? '').trim().toLowerCase();
  if (!k) return undefined;
  return partiesOf(index, repo).find((p) => p.name.toLowerCase() === k || p.id.split('::').pop()!.toLowerCase() === k);
}

/** The steps a screen node declares as done outside the code (`steps[].by`), in the manifest's order. */
export function offPlatformSteps(index: GraphIndex, screen: GraphNode | undefined): OffPlatformStep[] {
  if (!screen?.design?.steps?.length) return [];
  const repo = screen.loc?.repo ?? screen.id.split('::')[0]!;
  const out: OffPlatformStep[] = [];
  for (const s of screen.design.steps) {
    if (!s.by || !(BY as readonly string[]).includes(s.by)) continue;
    const party = partyNamed(index, repo, s.who);
    out.push({
      id: s.id, name: s.name, by: s.by, screen: screen.id,
      ...(s.who ? { who: s.who } : {}), ...(s.where ? { where: s.where } : {}),
      ...(party ? { party: { id: party.id, name: party.name, ...(party.external?.role ? { role: party.external.role } : {}) } } : {}),
    });
  }
  return out;
}

/**
 * How many designed steps are done outside the code, over the scope given (a screen, a journey, a storyline): each
 * once, split by who does them — a person, a partner, another system. Never a gate and never a verdict.
 */
export function offPlatformCounted(steps: Pick<OffPlatformStep, 'by'>[], scope: 'journey.scopeHere' | 'journey.scopeAll' | 'count.scope.storyline', source: string): Counted {
  const by = (k: OffPlatformStep['by']) => steps.filter((s) => s.by === k).length;
  return counted(steps.length, 'count.unit.offPlatform', scope, source, {
    bizUnit: 'count.unit.offPlatform',
    breakdown: [
      { key: 'count.part.offPlatformPerson', n: by('person') },
      { key: 'count.part.offPlatformPartner', n: by('partner') },
      { key: 'count.part.offPlatformExternal', n: by('external') },
    ],
  });
}

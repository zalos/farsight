/**
 * Compare two syncs on one storyline (round 2026-10-10, proposal 7): what changed between sync A and sync B,
 * in the units a storyline reader already reads — a screen built, a gate on a call, a writer of a status, an
 * operation on the contract, a journey's test verdict. Nothing else can be a delta: the five kinds are a closed
 * set (`DELTA_KINDS`), the way the absence words and the evidence classes are.
 *
 * Pure over two graph indexes and their meta. The scope is the storyline: the journeys it chains and its
 * branches, as either sync declares them, and what their walks reach — never the whole graph. Identity across
 * the two syncs is what a person would call the same thing: a screen by its design id (a designed screen's
 * page id changes when a page starts serving it), an operation by its `operationId` or its method and path
 * (`{id}` and `:id` read alike), a gate by its node and the call or action it stands in front of.
 *
 * Each delta carries its sentence in two forms — the hybrid/code words (identifiers set apart) and the
 * business words (no identifier) — as catalog keys with their arguments (`strings-compare.ts`), its door, and
 * the journeys whose cards carry its chip. Every count is a `Counted` over `count.scope.compare`.
 *
 * `storylineDiffDocument()` turns the answer into a `farsight-diff v1` document (the frozen contract grows by
 * five change kinds, one per delta kind, and an optional `storyline` block — docs/contracts/farsight-diff-v1.md).
 */
import type { GraphNode, GateTier, NodeKind, Loc } from './graph.js';
import type { GraphMeta } from './store.js';
import { type GraphIndex, buildIndex, journey, journeySummary, humanizeName, type Journey, type JourneySummary } from './query.js';
import type { SnapshotDb } from './snapshots.js';
import { setFreshnessMeta } from './freshness.js';
import { screensFor } from './design.js';
import { journeyTree, type JourneyRow, type JourneyStoryline } from './journeys.js';
import { gateTierOf } from './gate-class.js';
import { gateNameParts } from './gates.js';
import { counted, type Counted } from './counts.js';
import { t, type Register } from './strings.js';
import { CHANGE_KINDS, type ChangeKind, type DiffChange, type DiffDelta, type GraphDiff } from './diff.js';

/** The five kinds a storyline delta can be. A closed set: a sixth is a decision recorded in the contract doc. */
export const DELTA_KINDS = ['built', 'gate', 'writer', 'contract', 'verdict'] as const;
export type DeltaKind = typeof DELTA_KINDS[number];
/** Which way a delta went. `changed` is only ever a contract's status or shape, or a verdict. */
export const DELTA_CHANGES = ['added', 'removed', 'changed'] as const;
export type DeltaChange = typeof DELTA_CHANGES[number];
/** Where a delta's door opens. A closed set the viewer, the CLI and MCP each turn into an address. */
export const DELTA_DOORS = ['gate', 'move', 'cases', 'contract', 'screen'] as const;
export type DeltaDoorKind = typeof DELTA_DOORS[number];

/** One end of a comparison: the sync it is, when, at which commit. */
export interface CompareEnd {
  sync: number | null;
  at?: string;
  commit?: string;
  /** false: this sync was recorded before history kept its meta — the storyline is read with the other end's declaration */
  metaKept?: boolean;
}

/** A sentence as a catalog key and its arguments; `code` names the arguments that are identifiers (set apart in mono). */
export interface DeltaSentence {
  key: string;
  args: Record<string, string>;
  code?: string[];
}

export interface DeltaDoor {
  kind: DeltaDoorKind;
  /** the catalog key of the door's words (`door.*` / `compare.door.*`) */
  key: string;
  /** the node the door opens on: the gate, the writer, the route, the screen's page */
  node?: string;
  /** the journey the door opens in (a flow node id) */
  flow?: string;
  /** the screen's place on that journey, 1-based */
  screen?: number;
  /** the API the operation belongs to, for the contract door */
  api?: string;
}

export interface StorylineDelta {
  /** `d1…dN`, assigned over kind order, then the subject, then a detail key — the same pair of syncs always yields the same ids */
  id: string;
  kind: DeltaKind;
  change: DeltaChange;
  /** what the delta is about: the screen, the gate, the writer, the operation, the journey */
  subject: { id: string; name: string; kind: NodeKind };
  /** what it is about it: the call a gate guards, the record a writer moves */
  target?: { id: string; name: string; kind: NodeKind };
  /** the journeys (flow node ids) whose cards carry its chip */
  journeys: string[];
  /** the screen it sits on, when it sits on one */
  screen?: { id: string; name: string; flow: string; index: number };
  /** gate: who it matters to */
  tier?: GateTier;
  /** writer: the status gained or lost */
  status?: string;
  /** built: built / notBuilt · contract: the operation's status · verdict: the words before and after */
  from?: string;
  to?: string;
  /** contract: whether the storyline's code calls the operation at sync B (A for a removal) */
  called?: boolean;
  /** verdict: the short words the card's chip prints (the status, else the word; the skips when only they moved) */
  chip?: { from: string; to: string };
  loc?: Loc;
  /** the hybrid and code words */
  sentence: DeltaSentence;
  /** the business words: no identifier, the screen's and the gate's own words */
  biz: DeltaSentence;
  door: DeltaDoor;
}

/** Per journey: how many deltas of each kind its card carries, and what a built chip needs to say. */
export interface JourneyDeltaChips {
  flow: string;
  kinds: Partial<Record<DeltaKind, { added: number; removed: number; changed: number }>>;
  /** built: its screens built at B, out of its screens — *now built · 3 of 3* */
  built?: { n: number; of: number };
  /** verdict: the words before and after (the first verdict delta of this journey) */
  verdict?: { from: string; to: string };
}

export interface StorylineDiff {
  storyline: { id: string; name: string; repo: string; description?: string };
  from: CompareEnd;
  to: CompareEnd;
  deltas: StorylineDelta[];
  /** the journeys either sync draws for the storyline (the later sync's first), by flow node id and name */
  journeys: { flow: string; name: string }[];
  byJourney: JourneyDeltaChips[];
  counted: { deltas: Counted; journeys: Counted };
  /** what the comparison could not say, in sentences */
  notes: string[];
}

/** One side of the comparison: a sync's index, its meta, and where it stands. */
export interface CompareSide {
  index: GraphIndex;
  meta: GraphMeta;
  end: CompareEnd;
}

const SRC = 'core storyline-diff.ts storylineDiff';

// ── one side, read once ────────────────────────────────────────────────────

interface Walked {
  row: JourneyRow;
  j: Journey;
  sum: JourneySummary;
}

/** A screen of the storyline: the first journey that shows it and its place there, and whether a page serves it. */
interface ScreenFact { id: string; name: string; flow: string; index: number; built: boolean; designId?: string }

interface SideFacts {
  storyline: JourneyStoryline;
  walked: Map<string, Walked>;
  /** screen key → the screen */
  screens: Map<string, ScreenFact>;
  /** gate key (gate id | target key) → the gate, its target, the journeys and the screen */
  gates: Map<string, { gate: GraphNode; target: GraphNode; journeys: Set<string>; screen?: ScreenFact }>;
  /** operation key → the route and whether a non-planned step calls it */
  ops: Map<string, { route: GraphNode; called: boolean; journeys: Set<string> }>;
  /** record id → the record; writer key (record | status | writer) → the writer */
  records: Map<string, GraphNode>;
  /** node ids each journey's walk reaches */
  reach: Map<string, Set<string>>;
}

/** The method and the path of a route node, `{id}` and `:id` alike — an operation's identity across syncs. */
function opKey(n: GraphNode): string {
  if (n.contract?.spec?.operationId) return 'op:' + n.contract.spec.operationId;
  const name = n.name.trim();
  const m = name.match(/^([A-Z]+)\s+(\S+)/);
  const path = (m ? m[2]! : name).replace(/\{[^}]+\}/g, ':p').replace(/:[A-Za-z_][\w]*/g, ':p').replace(/\[[^\]]+\]/g, ':p');
  return 'route:' + (m ? m[1] + ' ' : '') + path;
}

/** A target's identity across syncs: an operation by its key, anything else by its node id. */
function targetKey(n: GraphNode): string {
  return n.kind === 'route' ? opKey(n) : n.id;
}

/** A screen's identity across syncs: its design id when it has one (a designed screen's page id moves when it is built). */
function screenKey(u: JourneySummary['user'][number]): string {
  return u.designId ? 'design:' + u.designId : u.id;
}

function sideFacts(side: CompareSide, storylineId: string, repo: string | undefined, declaredBy?: CompareSide): SideFacts | undefined {
  // a sync written before history kept its meta has no storyline declaration: read it with the other end's
  const metas = side.meta.journeys ?? declaredBy?.meta.journeys;
  const tree = journeyTree(side.index, metas, null);
  const st = tree.storylines.find((s) => s.id === storylineId && (!repo || s.repo === repo));
  if (!st) return undefined;
  const facts: SideFacts = { storyline: st, walked: new Map(), screens: new Map(), gates: new Map(), ops: new Map(), records: new Map(), reach: new Map() };
  for (const row of [...st.journeys, ...st.branches]) {
    if (facts.walked.has(row.nodeId) || !side.index.byId.has(row.nodeId)) continue;
    let j: Journey;
    let sum: JourneySummary;
    try {
      j = journey(side.index, row.nodeId);
      sum = journeySummary(side.index, j, screensFor(side.index, row.nodeId));
    } catch { continue; }
    facts.walked.set(row.nodeId, { row, j, sum });
    const reach = new Set<string>();
    for (const s of j.steps) reach.add(s.nodeId);
    facts.reach.set(row.nodeId, reach);
    sum.user.forEach((u, i) => {
      const k = screenKey(u);
      if (!facts.screens.has(k)) facts.screens.set(k, { id: u.id, name: u.name, flow: row.nodeId, index: i + 1, built: !!u.loc, ...(u.designId ? { designId: u.designId } : {}) });
    });
    const screenOfStep = (order: number) => {
      const seg = sum.segments.find((sg) => sg.from <= order && order <= sg.to && sg.screen);
      if (!seg?.screen) return undefined;
      return facts.screens.get(screenKey(seg.screen));
    };
    for (const s of j.steps) {
      const node = side.index.byId.get(s.nodeId);
      if (!node) continue;
      if (node.kind === 'route') {
        const k = opKey(node);
        const o = facts.ops.get(k) ?? { route: node, called: false, journeys: new Set<string>() };
        if (s.via !== 'planned') o.called = true;
        o.journeys.add(row.nodeId);
        facts.ops.set(k, o);
      }
      for (const g of s.gates) {
        // a planned gate is the spec's promise, a config check is the process's: neither is a gate on this call
        if (g.planned || g.config) continue;
        const gate = side.index.byId.get(g.id);
        if (!gate) continue;
        const k = g.id + '|' + targetKey(node);
        const sc = screenOfStep(s.order);
        const e = facts.gates.get(k) ?? { gate, target: node, journeys: new Set<string>(), ...(sc ? { screen: sc } : {}) };
        e.journeys.add(row.nodeId);
        facts.gates.set(k, e);
      }
    }
    for (const r of sum.system.records) {
      const n = side.index.byId.get(r.id);
      if (n) facts.records.set(n.id, n);
    }
  }
  return facts;
}

// ── the words ──────────────────────────────────────────────────────────────

/** The words a gate is printed with in the business register: what somebody wrote, else its requirement, else its name made readable. */
function gateWords(g: GraphNode): string {
  const biz = g.facets?.business;
  if (biz?.description) return biz.description.replace(/\s+/g, ' ').split(/(?<=\.)\s/)[0]!.replace(/\.$/, '');
  if (g.precondition?.words) return g.precondition.words;
  if (biz?.label) return biz.label;
  const { ident, phrase } = gateNameParts(g.name);
  return ident ? phrase : humanizeName(g.name);
}

/** A status in the words people use for it, when config named one; else the status made readable. */
function statusWords(record: GraphNode | undefined, status: string): string {
  const views = record?.lifecycle?.names?.views ?? {};
  for (const v of Object.values(views)) if (v[status]) return v[status]!;
  return humanizeName(status);
}

/** A verdict's identity: the word without its freshness (stale is the one freshness fact, never a verdict change), the status, the skips and failures. */
function verdictOf(sum: JourneySummary): { key: string; text: string; biz: string; short: string; skipped: number } | null {
  const v = sum.coverage?.journey?.verdict;
  if (!v) return null;
  const base = v.word.key === 'journey.evidence.stale' ? 'journey.evidence.observed' : v.word.key.replace(/Stale$/, '');
  const word = t(base, 'professional');
  const parts = [v.status ?? '', v.skipped ? t('compare.verdict.skipped', 'professional').replace('{n}', String(v.skipped)) : '', v.failed ? t('compare.verdict.failed', 'professional').replace('{n}', String(v.failed)) : ''].filter(Boolean);
  const text = v.status ? [v.status, ...parts.slice(1)].join(' · ') : [word, ...parts].join(' · ');
  // the verdict's words are the chip's in every register (lib/test-chip.js prints the same word in business)
  const biz = text;
  return { short: v.status ?? word, skipped: v.skipped ?? 0, key: [v.word.cls === 'stale' ? 'observed' : v.word.cls, base, v.status ?? '', v.skipped ?? 0, v.failed ?? 0].join('|'), text, biz };
}

const SEVERITY_ORDER: Record<DeltaKind, number> = { built: 0, gate: 1, writer: 2, contract: 3, verdict: 4 };

// ── the diff ───────────────────────────────────────────────────────────────

/**
 * The deltas on one storyline between sync A (`a`) and sync B (`b`), B being the later. `undefined` when
 * neither sync declares a storyline of that id. `repo` names the source when two declare the same id.
 */
export function storylineDiff(a: CompareSide, b: CompareSide, storylineId: string, opts: { repo?: string } = {}): StorylineDiff | undefined {
  const notes: string[] = [];
  const fb = sideFacts(b, storylineId, opts.repo, a);
  const fa = sideFacts(a, storylineId, opts.repo ?? fb?.storyline.repo, b);
  if (!fa && !fb) return undefined;
  if (!a.meta.journeys && b.meta.journeys) notes.push(t('compare.note.metaA', 'professional').replace('{sync}', String(a.end.sync ?? '?')));
  if (!fa) notes.push(t('compare.note.newStoryline', 'professional').replace('{sync}', String(a.end.sync ?? '?')));
  if (!fb) notes.push(t('compare.note.goneStoryline', 'professional').replace('{sync}', String(b.end.sync ?? '?')));
  const st = (fb ?? fa)!.storyline;
  const empty: SideFacts = { storyline: st, walked: new Map(), screens: new Map(), gates: new Map(), ops: new Map(), records: new Map(), reach: new Map() };
  const A = fa ?? empty;
  const B = fb ?? empty;
  const out: Omit<StorylineDelta, 'id'>[] = [];
  const nameOf = (side: SideFacts, flow: string) => side.walked.get(flow)?.row.name ?? flow;

  // built — a screen both syncs name, served by a page at one and not the other
  for (const [k, sb] of B.screens) {
    const sa = A.screens.get(k);
    if (!sa || sa.built === sb.built) continue;
    const now = sb.built;
    const journeys = [...B.walked.values()].filter((w) => w.sum.user.some((u) => screenKey(u) === k)).map((w) => w.row.nodeId);
    const args = { screen: sb.name };
    out.push({
      kind: 'built', change: now ? 'added' : 'removed',
      subject: { id: sb.id, name: sb.name, kind: (b.index.byId.get(sb.id)?.kind ?? 'page') as NodeKind },
      journeys, screen: { id: sb.id, name: sb.name, flow: sb.flow, index: sb.index },
      from: now ? 'notBuilt' : 'built', to: now ? 'built' : 'notBuilt',
      ...(b.index.byId.get(sb.id)?.loc ? { loc: b.index.byId.get(sb.id)!.loc! } : {}),
      sentence: { key: now ? 'compare.delta.built.added' : 'compare.delta.built.removed', args },
      biz: { key: now ? 'map.biz.compare.built.added' : 'map.biz.compare.built.removed', args },
      door: { kind: 'screen', key: 'compare.door.screen', flow: sb.flow, screen: sb.index, node: sb.id },
    });
  }

  // gate — a gate on a call or action of the storyline at one sync and not the other
  const gateDelta = (side: SideFacts, other: SideFacts, change: 'added' | 'removed') => {
    for (const [k, g] of side.gates) {
      if (other.gates.has(k)) continue;
      const tier = gateTierOf(g.gate).tier;
      const screen = g.screen;
      const parts = gateNameParts(g.gate.name);
      const args = { gate: parts.ident ? `${parts.ident} (${parts.phrase})` : g.gate.name, call: g.target.name, screen: screen?.name ?? nameOf(side, [...g.journeys][0]!) };
      const bizArgs = { words: gateWords(g.gate), screen: args.screen };
      out.push({
        kind: 'gate', change,
        subject: { id: g.gate.id, name: g.gate.name, kind: g.gate.kind },
        target: { id: g.target.id, name: g.target.name, kind: g.target.kind },
        journeys: [...g.journeys], ...(screen ? { screen: { id: screen.id, name: screen.name, flow: screen.flow, index: screen.index } } : {}),
        tier, ...(g.gate.loc ? { loc: g.gate.loc } : {}),
        sentence: { key: `compare.delta.gate.${change}`, args, code: ['gate', 'call'] },
        biz: { key: `map.biz.compare.gate.${change}`, args: bizArgs },
        door: { kind: 'gate', key: 'compare.door.gate', node: g.gate.id },
      });
    }
  };
  gateDelta(B, A, 'added');
  gateDelta(A, B, 'removed');

  // writer — a status of a record the storyline reaches gained or lost a writer
  const writers = (side: SideFacts) => {
    const m = new Map<string, { record: GraphNode; status: string; by: string }>();
    for (const rec of side.records.values()) for (const tr of rec.lifecycle?.transitions ?? []) {
      m.set(rec.id + '|' + tr.to + '|' + tr.by, { record: rec, status: tr.to, by: tr.by });
    }
    return m;
  };
  const unread = new Set<string>();
  const wa = writers(A);
  const wb = writers(B);
  const writerDelta = (mine: typeof wa, theirs: typeof wa, side: SideFacts, idx: GraphIndex, change: 'added' | 'removed') => {
    for (const [k, w] of mine) {
      if (theirs.has(k)) continue;
      // a record only one sync reaches is not a writer change: the record joined or left the storyline
      const other = (change === 'added' ? A : B).records.get(w.record.id);
      if (!other) continue;
      // a record whose statuses the other sync did not read at all is not a writer change either: that sync knows
      // no lifecycle for it (an older build, or the declaration came later) — said once as a note, never as moves
      if (!other.lifecycle) { unread.add(`${w.record.name}|${change === 'added' ? a.end.sync : b.end.sync}`); continue; }
      const writer = idx.byId.get(w.by);
      const journeys = [...side.reach].filter(([, r]) => r.has(w.by)).map(([f]) => f);
      const wname = writer ? (gateNameParts(writer.name).ident || writer.name) : w.by.split('::').pop()!;
      const args = { status: w.status, writer: wname, record: w.record.name };
      const bizArgs = { status: statusWords(w.record, w.status), record: humanizeName(w.record.name).toLowerCase() };
      out.push({
        kind: 'writer', change,
        subject: { id: w.by, name: args.writer, kind: (writer?.kind ?? 'function') as NodeKind },
        target: { id: w.record.id, name: w.record.name, kind: w.record.kind },
        journeys, status: w.status, ...(writer?.loc ? { loc: writer.loc } : {}),
        sentence: { key: `compare.delta.writer.${change}`, args, code: ['status', 'writer'] },
        biz: { key: `map.biz.compare.writer.${change}`, args: bizArgs },
        door: { kind: 'move', key: 'compare.door.move', node: w.by },
      });
    }
  };
  writerDelta(wb, wa, B, b.index, 'added');
  writerDelta(wa, wb, A, a.index, 'removed');
  for (const u of unread) {
    const [record, sync] = u.split('|');
    notes.push(t('compare.note.noLifecycle', 'professional').replace('{record}', record!).replace('{sync}', sync!));
  }
  // two builds may read the same code differently: say so when both ends name the build that wrote them
  const ba = a.meta.farsight?.commit, bb = b.meta.farsight?.commit;
  if (ba && bb && ba !== bb) notes.push(t('compare.note.builds', 'professional').replace('{a}', ba.slice(0, 7)).replace('{b}', bb.slice(0, 7)));

  // contract — an operation the storyline reaches was added to, taken off or changed on the contract
  const shape = (n: GraphNode) => JSON.stringify([n.contract?.params ?? [], n.contract?.requestBody ?? null, n.contract?.responses ?? [], n.contract?.security ?? []]);
  for (const k of new Set([...A.ops.keys(), ...B.ops.keys()])) {
    const oa = A.ops.get(k);
    const ob = B.ops.get(k);
    const ca = oa?.route.contract;
    const cb = ob?.route.contract;
    if (!ca && !cb) continue;
    const declared = (c: GraphNode['contract']) => !!c && c.status !== 'code-only';
    let change: DeltaChange | null = null;
    let key = '';
    if (!declared(ca) && declared(cb)) { change = 'added'; key = ob!.called ? 'added' : 'addedUncalled'; }
    else if (declared(ca) && !declared(cb)) { change = 'removed'; key = 'removed'; }
    else if (declared(ca) && declared(cb) && ca!.status !== cb!.status) { change = 'changed'; key = cb!.status === 'both' ? 'implemented' : ca!.status === 'both' ? 'unimplemented' : 'status'; }
    else if (declared(ca) && declared(cb) && shape(oa!.route) !== shape(ob!.route)) { change = 'changed'; key = 'shape'; }
    if (!change) continue;
    const o = (change === 'removed' ? oa : ob)!;
    const c = (change === 'removed' ? ca : cb)!;
    const args = { op: o.route.name, from: ca?.status ?? 'none', to: cb?.status ?? 'none' };
    const bizArgs = { what: c.summary ? c.summary.replace(/\.$/, '') : humanizeName(o.route.name) };
    out.push({
      kind: 'contract', change,
      subject: { id: o.route.id, name: o.route.name, kind: o.route.kind },
      journeys: [...o.journeys], from: args.from, to: args.to, called: o.called,
      ...(o.route.loc ? { loc: o.route.loc } : {}),
      sentence: { key: `compare.delta.contract.${key}`, args, code: ['op'] },
      biz: { key: `map.biz.compare.contract.${key}`, args: bizArgs },
      door: { kind: 'contract', key: 'compare.door.contract', node: o.route.id, ...(c.apiId ? { api: c.apiId } : {}) },
    });
  }

  // verdict — a journey both syncs walk whose one verdict changed its word, its status, its skips or failures
  for (const [flow, wbj] of B.walked) {
    const waj = A.walked.get(flow);
    if (!waj) continue;
    const va = verdictOf(waj.sum);
    const vb = verdictOf(wbj.sum);
    if (!va || !vb || va.key === vb.key) continue;
    const args = { journey: wbj.row.name, from: va.text, to: vb.text };
    // the card's chip: the status (else the word) on each side; the skips when that is all that moved
    const same = va.short === vb.short;
    const chip = same
      ? { from: t('compare.verdict.skipped', 'professional').replace('{n}', String(va.skipped)), to: t('compare.verdict.skipped', 'professional').replace('{n}', String(vb.skipped)) }
      : { from: va.short, to: vb.short };
    out.push({
      kind: 'verdict', change: 'changed', chip,
      subject: { id: flow, name: wbj.row.name, kind: 'flow' },
      journeys: [flow], from: va.text, to: vb.text,
      sentence: { key: 'compare.delta.verdict.changed', args },
      biz: { key: 'map.biz.compare.verdict.changed', args: { journey: wbj.row.name, from: va.biz, to: vb.biz } },
      door: { kind: 'cases', key: 'compare.door.cases', flow },
    });
  }

  // a deterministic order: kind, then the subject, then the target — ids follow it
  out.sort((x, y) => SEVERITY_ORDER[x.kind] - SEVERITY_ORDER[y.kind] || x.change.localeCompare(y.change)
    || x.subject.id.localeCompare(y.subject.id) || (x.target?.id ?? '').localeCompare(y.target?.id ?? ''));
  const deltas: StorylineDelta[] = out.map((d, i) => ({ id: `d${i + 1}`, ...d }));

  // the chips: per journey of the later sync, one entry per kind present
  const byJourney: JourneyDeltaChips[] = [];
  const flows = [...new Set([...B.walked.keys(), ...A.walked.keys()])];
  for (const flow of flows) {
    const mine = deltas.filter((d) => d.journeys.includes(flow));
    if (!mine.length) continue;
    const kinds: JourneyDeltaChips['kinds'] = {};
    for (const d of mine) {
      const k = kinds[d.kind] ?? { added: 0, removed: 0, changed: 0 };
      k[d.change] += 1;
      kinds[d.kind] = k;
    }
    const w = B.walked.get(flow);
    const v = mine.find((d) => d.kind === 'verdict');
    byJourney.push({
      flow, kinds,
      ...(kinds.built && w ? { built: { n: w.sum.user.filter((u) => !!u.loc).length, of: w.sum.user.length } } : {}),
      ...(v ? { verdict: v.chip ?? { from: v.from!, to: v.to! } } : {}),
    });
  }

  const by = (k: DeltaKind) => deltas.filter((d) => d.kind === k).length;
  const scope = 'count.scope.compare' as const;
  return {
    storyline: { id: st.id, name: st.name, repo: st.repo, ...(st.description ? { description: st.description } : {}) },
    from: a.end, to: b.end,
    deltas,
    journeys: flows.map((f) => ({ flow: f, name: (B.walked.get(f) ?? A.walked.get(f))!.row.name })),
    byJourney,
    counted: {
      deltas: counted(deltas.length, 'count.unit.deltas', scope, `${SRC} → deltas`, {
        bizUnit: 'count.unit.deltas',
        breakdown: DELTA_KINDS.map((k) => ({ key: `count.part.delta.${k}`, n: by(k) })),
      }),
      journeys: counted(byJourney.length, 'count.unit.journeysChanged', scope, `${SRC} → byJourney`, {
        of: new Set([...flows]).size, bizUnit: 'count.unit.journeysChanged',
      }),
    },
    notes,
  };
}

/** A delta's sentence filled in one register — what the CLI and MCP print. `biz` picks the business words. */
export function deltaText(d: StorylineDelta, opts: { register?: Register; biz?: boolean } = {}): string {
  const s = opts.biz ? d.biz : d.sentence;
  let text = t(s.key, opts.register ?? 'professional');
  for (const [k, v] of Object.entries(s.args)) text = text.split(`{${k}}`).join(v);
  return text;
}

/** The kind label a delta is printed under (`gate · added`) — the panel's and the CLI's. */
export function deltaLabel(d: Pick<StorylineDelta, 'kind' | 'change'>, register: Register = 'professional'): string {
  return `${t(`compare.kind.${d.kind}`, register)} · ${t(`compare.change.${d.change}`, register)}`;
}

/** The answer as lines — `farsight diff --storyline` and MCP `storyline_diff` print these. */
export function storylineDiffLines(diff: StorylineDiff, opts: { biz?: boolean } = {}): string[] {
  const end = (e: CompareEnd) => `sync ${e.sync ?? '?'}${e.commit ? ` · ${e.commit.slice(0, 7)}` : ''}${e.at ? ` · ${e.at.slice(0, 10)}` : ''}`;
  const c = diff.counted.deltas;
  const parts = (c.breakdown ?? []).filter((p) => p.n).map((p) => t(p.key, 'professional').replace('{n}', String(p.n)));
  const lines = [
    `${t('compare.panel.title', 'professional')} — ${diff.storyline.name} (${diff.storyline.id})`,
    `${end(diff.from)} → ${end(diff.to)}`,
    `${t(c.n === 1 ? 'count.unit.deltasOne' : 'count.unit.deltas', 'professional').replace('{n}', String(c.n))} · ${t('count.scope.compare', 'professional')}${parts.length ? ' — ' + parts.join(' · ') : ''}`,
  ];
  for (const d of diff.deltas) {
    lines.push(`  ${d.id}  ${deltaLabel(d).padEnd(22)} ${deltaText(d, { biz: opts.biz })}${d.tier ? ` [${d.tier}]` : ''}${d.loc ? `  (${d.loc.path}${d.loc.line != null ? ':' + d.loc.line : ''})` : ''}`);
  }
  if (!diff.deltas.length) lines.push(`  ${t('compare.panel.none', 'professional')}`);
  for (const n of diff.notes) lines.push(`  note: ${n}`);
  lines.push(t('compare.panel.closed', 'professional'));
  return lines;
}

// ── the frozen document: farsight-diff v1, grown by five kinds ──────────────

const CHANGE_OF: Record<DeltaKind, ChangeKind> = {
  built: 'storyline_built', gate: 'storyline_gate', writer: 'storyline_writer', contract: 'storyline_contract', verdict: 'storyline_verdict',
};

/** The label a compare end prints in the document's `base` / `head`: `sync:41 · 4677268`, as `diffGraphs` labels its ends. */
function endLabel(e: CompareEnd): string {
  const base = e.sync != null ? `sync:${e.sync}` : 'unknown';
  return e.commit ? `${base} · ${e.commit.slice(0, 7)}` : base;
}

/**
 * The answer as a `farsight-diff v1` document: every delta a `storyline_<kind>` change with its `delta` block, the
 * counts complete (every kind of the contract, zeros included — the other kinds are zero here by construction,
 * because a storyline diff reports only its five), and the `storyline` block. With `failOn`, a `gate` block judges
 * it the way `farsight gate` does: a listed kind with at least one delta fails, exit 1.
 */
export function storylineDiffDocument(diff: StorylineDiff, opts: { failOn?: readonly DeltaKind[]; limit?: number } = {}): GraphDiff {
  const limit = opts.limit ?? 500;
  const counts = Object.fromEntries(CHANGE_KINDS.map((k) => [k, 0])) as Record<ChangeKind, number>;
  for (const d of diff.deltas) counts[CHANGE_OF[d.kind]]++;
  const a = diff.from.sync ?? 'x';
  const b = diff.to.sync ?? 'x';
  const changes: DiffChange[] = diff.deltas.slice(0, limit).map((d, i) => {
    const delta: DiffDelta = {
      kind: d.kind, change: d.change,
      text: deltaText(d), biz: deltaText(d, { biz: true }),
      journeys: d.journeys,
      ...(d.screen ? { screen: d.screen } : {}),
      ...(d.target ? { target: d.target } : {}),
      ...(d.tier ? { tier: d.tier } : {}),
      ...(d.status ? { status: d.status } : {}),
      ...(d.from != null ? { from: d.from } : {}),
      ...(d.to != null ? { to: d.to } : {}),
      ...(d.called != null ? { called: d.called } : {}),
      door: {
        kind: d.door.kind,
        ...(d.door.node ? { node: d.door.node } : {}), ...(d.door.flow ? { flow: d.door.flow } : {}),
        ...(d.door.screen != null ? { screen: d.door.screen } : {}), ...(d.door.api ? { api: d.door.api } : {}),
      },
    };
    const flow = d.screen?.flow ?? d.journeys[0];
    return {
      id: `c${i + 1}`,
      kind: CHANGE_OF[d.kind],
      severity: 'notable' as const,
      confidence: 'resolved' as const,
      subject: d.subject,
      ...(d.kind === 'verdict' ? { journey: { id: d.subject.id, name: d.subject.name } } : flow ? { journey: { id: flow, name: flow } } : {}),
      ...(d.loc && d.loc.line != null ? { loc: d.loc } : {}),
      permalink: `/compare/${a}...${b}#c${i + 1}`,
      delta,
    };
  });
  // a journey's name, not its id, where the change names one
  const names = new Map(diff.journeys.map((j) => [j.flow, j.name]));
  for (const c of changes) if (c.journey && names.has(c.journey.id)) c.journey.name = names.get(c.journey.id)!;
  const byKind = Object.fromEntries(DELTA_KINDS.map((k) => [k, diff.deltas.filter((d) => d.kind === k).length])) as Record<DeltaKind, number>;
  const doc: GraphDiff = {
    schema: 'farsight-diff v1',
    base: endLabel(diff.from),
    head: endLabel(diff.to),
    truncated: diff.deltas.length > limit,
    counts,
    changes,
    storyline: { id: diff.storyline.id, name: diff.storyline.name, repo: diff.storyline.repo, from: diff.from, to: diff.to, byKind, notes: diff.notes },
  };
  if (opts.failOn?.length) {
    const rules = opts.failOn.map((k) => {
      const ids = changes.filter((c) => c.delta?.kind === k).map((c) => c.id);
      return { rule: `fail on ${k}`, result: ids.length ? 'fail' : 'pass', changes: ids };
    });
    const failed = rules.some((r) => r.result === 'fail');
    doc.gate = { policy: `--fail-on ${opts.failOn.join(',')}`, result: failed ? 'fail' : 'pass', exit: failed ? 1 : 0, rules };
  }
  return doc;
}

/** `--fail-on gate,verdict` → the kinds, or the words that are not one of the five. */
export function parseFailOn(value: string): { kinds: DeltaKind[]; unknown: string[] } {
  const words = value.split(',').map((w) => w.trim()).filter(Boolean);
  const kinds = words.filter((w): w is DeltaKind => (DELTA_KINDS as readonly string[]).includes(w));
  return { kinds, unknown: words.filter((w) => !(DELTA_KINDS as readonly string[]).includes(w)) };
}

// ── the ends of a comparison, resolved against the snapshot store ────────────

/** How an end was named: a sync, the one before, the newest on or before a day, a release, the last green run. */
export type CompareHow = 'sync' | 'previous' | 'date' | 'tag' | 'last-green' | 'now';

export type CompareRef = { sync: number; how: CompareHow; label?: string } | { error: string; absent?: 'notIndexed' };

/** One sync's index and meta, read from history (the caller may serve the current one from its own graph). */
export function compareSideOf(db: SnapshotDb, sync: number): CompareSide {
  const r = db.read(sync);
  const { nodes, edges } = r.store.toJSON();
  const index = buildIndex(nodes, edges);
  setFreshnessMeta(index, r.store.meta);
  return { index, meta: r.store.meta, end: { sync: r.ref.sync, at: r.ref.at, ...(r.ref.commit ? { commit: r.ref.commit } : {}), metaKept: r.metaKept } };
}

/**
 * Whether a storyline was green at a side: every journey of it with cases has none that failed or was skipped on its
 * own last run, and at least one passed. A journey with no cases neither greens nor reddens it.
 */
export function storylineGreen(side: CompareSide, storylineId: string, repo?: string, declaredBy?: CompareSide): boolean {
  const f = sideFacts(side, storylineId, repo, declaredBy);
  if (!f) return false;
  let passed = 0;
  for (const w of f.walked.values()) {
    const v = w.sum.coverage?.journey?.verdict;
    if (!v) continue;
    if (v.failed || v.skipped) return false;
    passed += v.runs.breakdown?.find((p) => p.key === 'count.part.passed')?.n ?? 0;
  }
  return passed > 0;
}

/**
 * The newest sync before `head` at which the storyline was green (`storylineGreen`), looking back at most `window`
 * syncs the history holds. `undefined` when none in the window was.
 */
export function lastGreenSync(db: SnapshotDb, storylineId: string, head: number, opts: { repo?: string; declaredBy?: CompareSide; window?: number } = {}): number | undefined {
  const window = opts.window ?? 30;
  let looked = 0;
  for (let s = head - 1; s >= 1 && looked < window; s--) {
    if (!db.has(s)) continue;
    looked++;
    if (storylineGreen(compareSideOf(db, s), storylineId, opts.repo, opts.declaredBy)) return s;
  }
  return undefined;
}

/**
 * The earlier end of a comparison, from how a person names it: `sync:41` or `41`, `previous` (the sync before the
 * later end), a day `2026-10-03` (or `date:2026-10-03`: the newest sync recorded on or before it), `tag:v0.3.0` (the
 * sync that ingested the release), `last-green`. A sync the history does not hold is said with the absence word
 * *not indexed*, never borrowed from a neighbour.
 */
export function resolveCompareFrom(db: SnapshotDb, value: string, ctx: { head: number; storyline: string; repo?: string; declaredBy?: CompareSide; lastGreen?: () => number | undefined }): CompareRef {
  const v = value.trim();
  const unheld = (n: number): CompareRef => ({ error: t('compare.panel.unheld', 'professional').replace('{sync}', String(n)), absent: 'notIndexed' });
  if (v === 'previous' || v === '') {
    const p = db.previous(ctx.head);
    return p == null ? { error: `no sync before sync ${ctx.head} in this history`, absent: 'notIndexed' } : { sync: p, how: 'previous' };
  }
  const n = Number(v.replace(/^sync:/, ''));
  if (Number.isInteger(n) && n >= 1 && /^(sync:)?\d+$/.test(v)) return db.has(n) ? { sync: n, how: 'sync' } : unheld(n);
  const day = v.replace(/^date:/, '');
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(day)) {
    const s = db.syncAtOrBefore(day);
    return s == null ? { error: `no sync recorded on or before ${day} in this history`, absent: 'notIndexed' } : { sync: s, how: 'date', label: day.slice(0, 10) };
  }
  if (v.startsWith('tag:')) {
    const name = v.slice(4);
    const rel = ctx.repo ? db.syncOfRelease(ctx.repo, name) : undefined;
    return rel ? { sync: rel.sync, how: 'tag', label: name } : { error: `no release ${name} in this history${ctx.repo ? ` for ${ctx.repo}` : ''}`, absent: 'notIndexed' };
  }
  if (v === 'last-green') {
    const s = ctx.lastGreen ? ctx.lastGreen() : lastGreenSync(db, ctx.storyline, ctx.head, { ...(ctx.repo ? { repo: ctx.repo } : {}), ...(ctx.declaredBy ? { declaredBy: ctx.declaredBy } : {}) });
    return s == null ? { error: `no earlier sync in this history at which every case of storyline ${ctx.storyline} passed`, absent: 'notIndexed' } : { sync: s, how: 'last-green' };
  }
  return { error: `cannot read ${v} as a sync: use sync:N, previous, a day YYYY-MM-DD, tag:<name> or last-green` };
}

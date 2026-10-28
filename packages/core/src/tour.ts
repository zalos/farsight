/**
 * Walk me through it (round 2026-10-10, proposal 8): a guided walk over a storyline or one journey, **assembled
 * from the graph, never written**. One stop per screen, in the order the storyline runs (each screen once however
 * many of its journeys show it), and one per hand-off — a move the code makes to a record (core gates.ts
 * `ActionPreconditions.moves`, the same moves the lanes draw). Every sentence is a catalog template
 * (`strings-tour.ts`) filled with what the graph holds — a screen's `@business` sentence or its design
 * description, the records its actions read and write and the store each lives in, the checks that matter to the
 * business on its actions (the gate tiers), the one test verdict with its scope (`testVerdict()`), and for a
 * hand-off who moves the record to what, what must be true first and whether the code checks the status it moves
 * from — and every clause carries the node ids it cites, the `Counted` behind any number and the verdict behind
 * any evidence word. A clause that refers back to an earlier stop says which (*(stop 2)*).
 *
 * The decision this follows (proposal 8): **nothing is printed that the graph cannot cite**. A model phrasing
 * pass is not part of this module; ask.ts carries the one named extension point for it.
 *
 * Pure over the index; each journey's walk and summary are folded once per index (`flowSummary`).
 */
import type { GraphNode, GateTier, JourneysMeta } from './graph.js';
import {
  type GraphIndex,
  type Journey,
  type JourneySummary,
  type JourneySegment,
  type JourneyMoment,
  journey,
  journeySummary,
  humanizeName,
} from './query.js';
import { screensFor } from './design.js';
import { journeyTree, personaOfScreen, type JourneyRow, type JourneyStoryline, type JourneyTree } from './journeys.js';
import { counted, countKey, scopeWord, type Counted } from './counts.js';
import { t as tr, type Register } from './strings.js';

/** A catalog word in the professional register unless another is named (the tour's text is the professional register's). */
const t = (key: string, reg: Register = 'professional'): string => tr(key, reg);
import { stepCoverage, segmentNotBuilt, type TestVerdict } from './coverage.js';
import { gateCard, gateNameParts } from './gates.js';
import { lifecycleViews, type LifecyclePersona } from './lifecycle.js';
import type { OffPlatformStep } from './decisions.js';

/** One clause of a stop: a template, its fills, the sentence in each lens, and what it cites. */
export interface TourClause {
  /** the catalog key the sentence is printed from (hybrid and code lenses) */
  key: string;
  vars: Record<string, string>;
  /** the business register's twin, when the hybrid sentence names code */
  bizKey?: string;
  /** the fills the business register prints: the twin's own, each with its code said in words (`codeFree`) */
  bizVars: Record<string, string>;
  /** the sentence in the professional register: `text` for hybrid and code, `biz` for business */
  text: string;
  biz: string;
  /** the graph node ids this clause was read from — never empty */
  cites: string[];
  /** the one verdict behind an evidence word in the sentence */
  evidence?: TestVerdict;
  /** the count behind a number in the sentence */
  counted?: Counted;
  /** the earlier stop (1-based) this clause refers back to */
  refers?: number;
  /** a gap the reader should see: a move the code does not check */
  warn?: true;
  /** a precondition's tier */
  tier?: GateTier;
  /** what kind of clause it is, for a surface that groups them */
  role:
    | 'refer'
    | 'words'
    | 'who'
    | 'actions'
    | 'data'
    | 'needs'
    | 'need'
    | 'decision'
    | 'technical'
    | 'verdict'
    | 'move'
    | 'check';
}

/** One stop of the walk. */
export interface TourStop {
  /** 1-based */
  n: number;
  /** `offPlatform`: something the design says a person, a partner or another system does here outside the code */
  kind: 'screen' | 'handoff' | 'offPlatform';
  /** an `offPlatform` stop's declared step: who does it and where, and the party it names */
  offPlatform?: OffPlatformStep;
  title: { text: string; biz: string };
  sub: { text: string; biz: string };
  journey: { id: string; name: string; step?: number; branch?: { of: string; ofName: string; when: string } };
  screen: { id: string; name: string; ordinal: number; of: number };
  /** the action a hand-off is made by (1-based ordinal among the screen's actions, as the Map's address counts it) */
  action?: { nodeId: string; label: string; ordinal: number };
  /** a hand-off's move */
  move?: {
    record: string;
    table: string;
    status: string;
    word: string;
    from?: string;
    by: string;
    checked: boolean;
    creates?: true;
  };
  persona?: { id: string; name: string };
  clauses: TourClause[];
  /** every node the stop cites, in the order its clauses cite them, each once */
  referenced: string[];
  prev: number | null;
  next: number | null;
  /** where the Map frames this stop: the journey, the screen (1-based) and, for a hand-off, the call that makes the move */
  place: { flowId: string; screen: number; node?: string };
}

/** What a cited node is, for the chips: its kind, its name as the code spells it, its name in words, where it is. */
export interface TourNodeRef {
  kind: GraphNode['kind'];
  name: string;
  words: string;
  loc?: string;
}

export interface Tour {
  target: { kind: 'storyline' | 'flow'; id: string; name: string; repo: string; description?: string };
  persona?: { id: string; name: string };
  stops: TourStop[];
  nodes: Record<string, TourNodeRef>;
  counted: { stops: Counted };
  /** always true: every sentence is a template filled from the graph */
  derived: true;
  notes: string[];
}

const SRC = 'core tour.ts tourOf';

// ── the walks, folded once per index ────────────────────────────────────────────────────────────────────

const WALKS = new WeakMap<GraphIndex, Map<string, { j: Journey; sum: JourneySummary } | null>>();
/** One journey's walk and summary, folded once per index; null when it cannot be walked. */
export function flowSummary(index: GraphIndex, flowId: string): { j: Journey; sum: JourneySummary } | null {
  let m = WALKS.get(index);
  if (!m) {
    m = new Map();
    WALKS.set(index, m);
  }
  if (m.has(flowId)) return m.get(flowId)!;
  let v: { j: Journey; sum: JourneySummary } | null;
  try {
    const j = journey(index, flowId);
    v = { j, sum: journeySummary(index, j, screensFor(index, flowId)) };
  } catch {
    v = null;
  }
  m.set(flowId, v);
  return v;
}

/** The moments of a segment in the order the screen prints them (the manifest's rank, else walk order). */
export function rankOrder(sg: JourneySegment): JourneyMoment[] {
  const ms = sg.moments.slice();
  if (!ms.some((mo) => mo.rank != null)) return ms;
  return ms.sort((a, b) => (a.rank ?? a.index) - (b.rank ?? b.index));
}
/** The 1-based place an action is printed at inside its screen — the Map address's `action=`. */
export function actionOrdinal(sg: JourneySegment, mo: JourneyMoment): number {
  return rankOrder(sg).findIndex((x) => x.index === mo.index) + 1;
}

// ── words ────────────────────────────────────────────────────────────────────────────────────────────

/** Fill `{name}` placeholders. */
export function fillWords(s: string, vars: Record<string, string>): string {
  let out = s;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}
const fill = (key: string, vars: Record<string, string>, reg: Register = 'professional') =>
  fillWords(t(key, reg), vars);
/** The business register's fills: each with its code said in words; a count and a stop number stay as they are. */
export function bizWords(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars))
    out[k] = k === 'count' || k === 'stop' || k === 'runs' || k === 'word' || k === 'scope' ? v : codeFree(v);
  return out;
}

/**
 * A sentence with its code said in words, for the business register — the viewer's `unCode()` (store.js) in core:
 * a document id in brackets goes, a backticked span and an identifier read as words (`entraSession` → *entra
 * session*, `UNDER_REVIEW` → *under review*), a path or a file reads as its name, a method and a path as the route's
 * words. Every other lens keeps the sentence as written.
 */
/**
 * An HTTP status the code answers with, said in words (`http.word.*`): *401 without an operator session* reads *a
 * refusal (nobody is signed in) without an operator session*. Only a status a sentence uses as an answer — after
 * *answers*, *returns* or *with*, or before *without*, *while*, *when*, a stop — so *401 test cases* stays a count.
 */
export function httpWords(text: string, word: (code: string) => string): string {
  const say = (code: string) => word(code.startsWith('5') ? '5xx' : code);
  return String(text ?? '')
    .replace(
      /\b(answers?|returns?|responds?\s+with|refuses\s+with|fails\s+with|with)\s+(?:an?\s+)?([45]\d\d)\b/gi,
      (_m, v: string, code: string) => `${v} ${say(code)}`,
    )
    .replace(
      /(?<![\d.,])(?<!\bof\s)(?:\b(?:an?|the)\s+)?\b([45]\d\d)\b(?=\s*(?:$|[,.;:)!?]|\s(?:without|while|when|if|unless|for|on|otherwise|else|and|or|from)\b|\s[—–-]\s))/g,
      (_m, code: string) => say(code),
    );
}
const HTTP_KNOWN = new Set(['400', '401', '403', '404', '409', '413', '415', '422', '429', '5xx']);

/**
 * A refusal message with a hole the code fills when it runs (*Vendor account is …, not ACTIVE*), as the business
 * register reads it: the hole says *(a value)* and a status constant reads as a word (outsider round, F6 · S2). The
 * viewer's `filledMessage()` is the same rule.
 */
export function holeWords(text: string): string {
  const s = String(text ?? '');
  if (!/…/.test(s)) return s;
  const v = t('plain.aValue');
  return s
    .replace(/\(\s*…\s*\)/g, v)
    .replace(/…/g, v)
    .replace(/\b[A-Z]{4,}(?:_[A-Z]+)*\b/g, (w) => (/^ADR/.test(w) ? w : w.replace(/_/g, ' ').toLowerCase()));
}

export function codeFree(text: string): string {
  text = holeWords(text);
  const words = (x: string) =>
    String(x)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .toLowerCase()
      .trim();
  const file = (p: string) =>
    words(
      (String(p).split('/').filter(Boolean).pop() ?? '').replace(/\.[\w.]+$/, '').replace(/\.(spec|test|stories)$/, ''),
    );
  return (
    httpWords(String(text ?? ''), (c) => (HTTP_KNOWN.has(c) ? t(`http.word.${c}`) : t('http.word.400')))
      .replace(/\s*\((?:[^()]*\b(?:[A-Z]{2,6}[- ]?#?\d[\w.]*|PBI)\b[^()]*)\)/g, '')
      // an aside in brackets that quotes code goes whole: the sentence reads without it
      .replace(/\s*\([^()]*`[^`]*`[^()]*\)/g, '')
      .replace(/`([^`]*)`/g, (_m, x: string) => (/[/.]/.test(x) ? file(x) : words(x)))
      .replace(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+(\/[\w/:{}.[\]-]*)/g, (_m, p: string) =>
        words(
          p
            .split('/')
            .filter((x) => x && !/^(api|v\d+)$/i.test(x) && !/^[:{[]/.test(x))
            .join(' '),
        ),
      )
      .replace(/(?:[\w.-]+\/)+[\w.-]+/g, (m) => file(m))
      .replace(/\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|md)\b/g, (m) => file(m))
      // a path on its own (/track, /me/verify) reads as its last name
      .replace(
        /(^|[\s(])\/[\w.:{}[\]/-]+/g,
        (_m, pre: string, _o: number, _w: string) =>
          `${pre}${words(
            _m
              .trim()
              .split('/')
              .filter((x) => x && !/^[:{[]/.test(x))
              .pop() ?? '',
          )}`,
      )
      // a method left alone, with no path after it, says nothing a reader can use
      .replace(/\b(?:GET|POST|PUT|PATCH|DELETE)\b\s*/g, '')
      .replace(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g, (m) => words(m))
      .replace(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g, (m) => words(m))
      .replace(/\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/g, (m) => words(m))
      .replace(/\b([a-z]+):([a-z]+)\b/g, '$1 $2')
      // a document's own id left in the sentence (OPS-04a, CON-02) is how the docs file it, not words
      .replace(/\b(?!ADR-)[A-Z]{2,5}-\d+(?:\.\d+)?[a-z]?\b/g, '')
      .replace(/[→←]/g, '')
      .replace(/\s+([,.;:)])/g, '$1')
      .replace(/\(\s*\)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

/** A label without its closing stop, for a list or a quote inside a sentence. */
export function bare(s: string): string {
  return String(s || '')
    .trim()
    .replace(/[.;:,]+$/, '')
    .trim();
}

/** A node's name in words: its business label, else its name humanized. */
export function wordsOf(n: GraphNode | undefined, fallback = ''): string {
  if (!n) return fallback;
  const label = n.facets?.business?.label;
  if (label) return label;
  if (n.kind === 'flow' || n.kind === 'page') return n.design?.name ?? n.name;
  return humanizeName((n.name.split(': ')[0] ?? n.name).split('.').pop() ?? n.name);
}
/** A record's name in a sentence: the table's name in words, lower case, one of it (`invoices` → `invoice`). */
export function recordWord(name: string): string {
  const w = humanizeName(name).toLowerCase();
  const parts = w.split(' ');
  const last = parts.pop() ?? '';
  const one = /ies$/.test(last) ? last.replace(/ies$/, 'y') : /(ss|us)$/.test(last) ? last : last.replace(/s$/, '');
  return [...parts, one].join(' ');
}
/** `path:line` of a node, else ''. */
export function locOf(n: GraphNode | undefined, line?: number): string {
  if (!n?.loc) return '';
  return `${n.loc.path}:${line ?? n.loc.line}`;
}
/** The words of a count in each lens: `4 test cases` / `4 tests`. */
export function countWords(c: Counted, business = false): string {
  const key = business ? (c.bizUnit ?? c.unit) : c.unit;
  return fillWords(t(countKey(key, c.n)), { n: String(c.n), m: String(c.of ?? '') });
}
/** ` · 1 skipped · 2 failed` — the run parts of a verdict that are not zero. */
export function runsWords(v: TestVerdict): string {
  return (['failed', 'skipped', 'flaky'] as const)
    .filter((k) => v[k] > 0)
    .map((k) => ` · ${fillWords(t(countKey(`count.part.${k}`, v[k])), { n: String(v[k]) })}`)
    .join('');
}
/** The vars every verdict sentence takes: the word, the count, the scope words, the run parts. */
export function verdictVars(v: TestVerdict, business = false): Record<string, string> {
  return { word: t(v.word.key), count: countWords(v.runs, business), scope: t(scopeWord(v.runs)), runs: runsWords(v) };
}

// ── the clause builder ──────────────────────────────────────────────────────────────────────────────────

function clause(
  role: TourClause['role'],
  key: string,
  vars: Record<string, string>,
  cites: (string | undefined)[],
  extra: Partial<Pick<TourClause, 'evidence' | 'counted' | 'refers' | 'warn' | 'tier'>> & {
    bizKey?: string;
    bizVars?: Record<string, string>;
  } = {},
): TourClause {
  const ids = [...new Set(cites.filter((x): x is string => !!x))];
  const { bizKey, bizVars, ...rest } = extra;
  const bv = bizWords(bizVars ?? vars);
  return {
    role,
    key,
    vars,
    ...(bizKey ? { bizKey } : {}),
    bizVars: bv,
    text: fill(key, vars),
    biz: fill(bizKey ?? key, bv),
    cites: ids,
    ...rest,
  };
}

/** A list of statuses (`A or B`) in the persona's words. */
export function fromWords(
  index: GraphIndex,
  table: GraphNode | undefined,
  from: string | undefined,
  persona?: LifecyclePersona,
): string {
  return String(from ?? '')
    .split(' or ')
    .filter(Boolean)
    .map((x) => statusWord(index, table, x.trim(), persona))
    .join(' or ');
}

/** The status a persona calls it (`open` → `Sent`), from the record's lifecycle views; the constant humanized otherwise. */
export function statusWord(
  index: GraphIndex,
  table: GraphNode | undefined,
  status: string,
  persona?: LifecyclePersona,
): string {
  if (!table?.lifecycle) return humanizeName(status);
  const v = lifecycleViews(index, table, persona ? { personas: [persona] } : {})[0];
  return v?.rows.find((r) => r.status === status)?.word ?? humanizeName(status);
}

// ── the walk ────────────────────────────────────────────────────────────────────────────────────────────

type Leg = { row: JourneyRow; step?: number; branch?: { of: string; ofName: string; when: string } };

/** The storyline (or the one journey) a target names: a storyline id or name, else a flow node id, name or design id. */
function resolveTarget(
  index: GraphIndex,
  tree: JourneyTree,
  target: string,
): { kind: 'storyline'; st: JourneyStoryline } | { kind: 'flow'; flow: GraphNode; row?: JourneyRow } | undefined {
  const q = target.trim().toLowerCase();
  const st =
    tree.storylines.find((s) => s.id.toLowerCase() === q) ?? tree.storylines.find((s) => s.name.toLowerCase() === q);
  if (st) return { kind: 'storyline', st };
  const rows = tree.personas.flatMap((p) => p.groups.flatMap((g) => g.journeys));
  const direct = index.byId.get(target);
  const flow =
    direct?.kind === 'flow'
      ? direct
      : [...index.byId.values()].find(
          (n) =>
            n.kind === 'flow' &&
            (n.name.toLowerCase() === q ||
              n.design?.id?.toLowerCase() === q ||
              n.id.split('::').pop()?.toLowerCase() === q),
        );
  if (!flow) return undefined;
  return { kind: 'flow', flow, row: rows.find((r) => r.nodeId === flow.id) };
}

function personaFor(row: JourneyRow | undefined, want?: string): LifecyclePersona | undefined {
  if (!row) return undefined;
  const ids = row.personaIds ?? [];
  const names = row.personaNames ?? [];
  if (want) {
    const k = want.trim().toLowerCase();
    const i = ids.findIndex((id, x) => id.toLowerCase() === k || (names[x] ?? '').toLowerCase() === k);
    if (i >= 0) return { id: ids[i]!, name: names[i] ?? ids[i]! };
  }
  return ids.length ? { id: ids[0]!, name: names[0] ?? ids[0]! } : undefined;
}

/**
 * The walk over a storyline (by id or name) or one journey (a flow node id, name or design id): its stops in
 * order, each clause citing what it was read from. `persona` picks whose words a status is printed in (and whose
 * name a stop says) where a journey is for several; undefined when nothing matches the target.
 */
export function tourOf(
  index: GraphIndex,
  target: string,
  opts: { metas?: Record<string, JourneysMeta>; persona?: string; repo?: string } = {},
): Tour | undefined {
  const tree = journeyTree(index, opts.metas, opts.repo ? new Set([opts.repo]) : null);
  const hit = resolveTarget(index, tree, target);
  if (!hit) return undefined;
  const legs: Leg[] = [];
  let head: Tour['target'];
  if (hit.kind === 'storyline') {
    const st = hit.st;
    head = {
      kind: 'storyline',
      id: st.id,
      name: st.name,
      repo: st.repo,
      ...(st.description ? { description: st.description } : {}),
    };
    st.journeys.forEach((row, i) => legs.push({ row, step: i + 1 }));
    // the branches walk after the main path: they leave it only when their condition holds
    for (const b of st.branches ?? [])
      legs.push({ row: b, branch: { of: b.branchOf, ofName: b.branchOfName, when: b.when } });
  } else {
    const f = hit.flow;
    head = {
      kind: 'flow',
      id: f.id,
      name: f.design?.name ?? f.name,
      repo: f.id.split('::')[0]!,
      ...((hit.row?.description ?? f.docs) ? { description: (hit.row?.description ?? f.docs)! } : {}),
    };
    legs.push({
      row:
        hit.row ??
        ({ nodeId: f.id, name: f.design?.name ?? f.name, personaIds: [], personaNames: [] } as unknown as JourneyRow),
    });
  }

  const stops: TourStop[] = [];
  const notes: string[] = [];
  const seenScreen = new Set<string>();
  const seenMove = new Set<string>();
  const seenOff = new Set<string>();
  /** a record's last writer stop: the screen that wrote it, for a later stop that reads it */
  const wroteAt = new Map<string, { stop: number; screen: string; name: string }>();
  let firstPersona: LifecyclePersona | undefined;
  // where each move is credited (lane moves, 2026-10-13): of every place a leg's action makes it, the one whose action
  // calls the writer most directly — fewest calls under the action's call — then the first in storyline order. Never
  // simply the first place the walk met. The places a constant switches off are kept to be named beside it.
  const bestMove = new Map<string, { leg: number; seg: number; mo: number; hops: number }>();
  const offMoves = new Map<
    string,
    { label: string; screen: string; action?: string; flag: string; value: boolean; at: string }[]
  >();
  legs.forEach((leg, li) => {
    const w = flowSummary(index, leg.row.nodeId);
    for (const sg of w?.sum.segments ?? []) {
      if (!sg.screen) continue;
      for (const mo of sg.moments) {
        for (const mv of mo.preconditions?.moves ?? []) {
          const k = `${mv.table}|${mv.to}|${mv.by}`;
          const had = bestMove.get(k);
          if (!had || (mv.hops ?? 0) < had.hops)
            bestMove.set(k, { leg: li, seg: sg.index, mo: mo.index, hops: mv.hops ?? 0 });
        }
        for (const so of mo.preconditions?.switchedOff ?? []) {
          const k = `${so.table}|${so.to}|${so.by}`;
          const list = offMoves.get(k) ?? [];
          if (!list.some((x) => x.label === mo.label && x.flag === so.flag))
            list.push({
              label: mo.label,
              screen: sg.screen.name,
              ...(mo.preconditions?.action ? { action: mo.preconditions.action } : {}),
              flag: so.flag,
              value: so.value,
              at: so.at,
            });
          offMoves.set(k, list);
        }
      }
    }
  });

  for (const [legIndex, leg] of legs.entries()) {
    const walked = flowSummary(index, leg.row.nodeId);
    if (!walked) {
      notes.push(`${leg.row.name} could not be walked`);
      continue;
    }
    const { sum } = walked;
    const legPersona = personaFor(leg.row, opts.persona);
    firstPersona ??= legPersona;
    const flowNode = index.byId.get(leg.row.nodeId);
    const jName = leg.row.name ?? flowNode?.name ?? leg.row.nodeId;
    const screens = sum.segments.filter((sg) => sg.screen);
    const cov = sum.coverage;
    const journeyRef = {
      id: leg.row.nodeId,
      name: jName,
      ...(leg.step ? { step: leg.step } : {}),
      ...(leg.branch ? { branch: leg.branch } : {}),
    };

    screens.forEach((sg, si) => {
      const sc = sg.screen!;
      // who uses this screen: its own row, a persona's routes, the sign-in guard its code meets — else the journey's
      // persona (the one the reader picked, where it is for several)
      const sp = personaOfScreen(index, opts.metas, sc.id, leg.row.nodeId);
      const own = sp && sp.personaFrom !== 'journey';
      const persona: LifecyclePersona | undefined = own ? { id: sp.persona, name: sp.personaName } : legPersona;
      const whoRefs = own ? [sc.id, ...(sp.personaFrom === 'guard' ? sp.evidence : [])] : [leg.row.nodeId];
      const key = sc.designId ?? sc.id;
      const ordinal = sg.index + 1;
      const screenRef = { id: sc.id, name: sc.name, ordinal, of: screens.length };
      if (!seenScreen.has(key)) {
        seenScreen.add(key);
        const cl: TourClause[] = [];
        // a stop for work done outside the code is not a move: the screen is still read after the move before it
        const before = [...stops].reverse().find((x) => x.kind !== 'offPlatform');
        // a screen right after a hand-off is read in its place: after the move
        if (before?.kind === 'handoff' && before.move) {
          const act = before.action;
          cl.push(
            clause(
              'refer',
              'tour.ref.after',
              {
                action: bare(act?.label ?? ''),
                record: recordWord(index.byId.get(before.move.table)?.name ?? before.move.record),
                status: before.move.status,
                stop: String(before.n),
              },
              [act?.nodeId, before.move.by, before.move.table],
              {
                refers: before.n,
                bizVars: {
                  action: bare(act?.label ?? ''),
                  record: recordWord(index.byId.get(before.move.table)?.name ?? before.move.record),
                  status: before.move.word,
                  stop: String(before.n),
                },
              },
            ),
          );
        }
        cl.push(
          sc.business
            ? clause('words', 'tour.screen.words', { words: sc.business }, [sc.id])
            : clause('words', 'tour.screen.noWords', { screen: sc.name }, [sc.id]),
        );
        if (persona) cl.push(clause('who', 'tour.screen.who', { persona: persona.name }, whoRefs));
        // the actions it starts, in the order the screen prints them
        const acts = rankOrder(sg);
        const labels: string[] = [];
        const actIds: string[] = [];
        for (const mo of acts) {
          if (labels.includes(bare(mo.label))) continue;
          labels.push(bare(mo.label));
          const call =
            mo.callStep != null
              ? walked.j.steps.find((s) => s.order === mo.callStep)?.nodeId
              : walked.j.steps.find((s) => s.order === mo.actionStep)?.nodeId;
          if (call) actIds.push(call);
        }
        if (labels.length && actIds.length)
          cl.push(clause('actions', 'tour.screen.actions', { list: labels.join('; ') }, actIds));
        else cl.push(clause('actions', 'tour.screen.noActions', {}, [sc.id]));
        // what it reads and writes, through which store
        const reads = new Map<string, string>();
        const writes = new Map<string, string>();
        const third = new Map<string, string>();
        for (const m of sg.markers) {
          if (m.kind !== 'record' && m.kind !== 'external') continue;
          const n = index.byId.get(m.nodeId);
          const nm = m.kind === 'record' ? recordWord(n?.name ?? m.name) : wordsOf(n, m.name);
          const item =
            m.kind === 'record'
              ? m.store?.name
                ? fill('tour.inStore', { record: nm, store: m.store.name })
                : fill('tour.record', { record: nm })
              : nm;
          if (m.kind === 'external' && !m.store) {
            third.set(m.nodeId, item);
            continue;
          }
          if (m.op === 'writes') writes.set(m.nodeId, item);
          else if (m.op === 'reads') reads.set(m.nodeId, item);
        }
        for (const id of writes.keys()) reads.delete(id);
        // a record an earlier screen wrote: say so, with the stop
        for (const id of [...reads.keys(), ...writes.keys()]) {
          const w = wroteAt.get(id);
          if (w && w.screen !== sc.id) {
            const rec = recordWord(index.byId.get(id)?.name ?? id);
            cl.push(
              clause('refer', 'tour.ref.reads', { record: rec, screen: w.name, stop: String(w.stop) }, [id, w.screen], {
                refers: w.stop,
              }),
            );
            break;
          }
        }
        if (reads.size)
          cl.push(clause('data', 'tour.screen.reads', { list: [...reads.values()].join(', ') }, [...reads.keys()]));
        if (writes.size)
          cl.push(clause('data', 'tour.screen.writes', { list: [...writes.values()].join(', ') }, [...writes.keys()]));
        if (third.size)
          cl.push(clause('data', 'tour.screen.calls', { list: [...third.values()].join(', ') }, [...third.keys()]));
        // the checks that matter to the business on its actions; the technical ones counted
        const needs = new Map<string, { words: string; tier: GateTier }>();
        const tech = new Set<string>();
        for (const mo of acts)
          for (const p of mo.preconditions?.preconditions ?? []) {
            if (p.planned) continue;
            if (p.tier === 'technical') tech.add(p.id);
            else if (!needs.has(p.id) && ![...needs.values()].some((x) => x.words === bare(p.words)))
              needs.set(p.id, { words: bare(p.words), tier: p.tier });
          }
        if (needs.size)
          cl.push(
            clause('needs', 'tour.screen.needs', { list: [...needs.values()].map((x) => x.words).join('; ') }, [
              ...needs.keys(),
            ]),
          );
        if (tech.size) {
          const c = counted(
            tech.size,
            'count.unit.gatesTechnical',
            'journey.scopeHere',
            `${SRC} → segments[${sg.index}].moments[].preconditions (tier technical, each once)`,
            { bizUnit: 'count.unit.gatesTechnical' },
          );
          cl.push(clause('technical', 'tour.screen.technical', { count: countWords(c) }, [...tech], { counted: c }));
        }
        // the one verdict, with its scope
        const sv = cov?.segments[sg.index];
        if (segmentNotBuilt(sg) || sv?.notBuilt)
          cl.push(clause('verdict', 'tour.screen.notBuilt', { screen: sc.name }, [sc.id]));
        else if (sv && (sv.verdict.runs.n || sv.counted?.runReports.n)) {
          cl.push(
            clause(
              'verdict',
              'tour.verdict',
              verdictVars(sv.verdict),
              [
                sc.id,
                ...sv.tests
                  .filter((x) => !x.runLevel)
                  .slice(0, 12)
                  .map((x) => x.id),
              ],
              {
                evidence: sv.verdict,
                counted: sv.verdict.runs,
                bizKey: 'tour.biz.verdict',
                bizVars: verdictVars(sv.verdict, true),
              },
            ),
          );
        } else cl.push(clause('verdict', 'tour.noTests', { what: sc.name }, [sc.id]));
        stops.push(
          makeStop(
            stops.length + 1,
            'screen',
            {
              text: fill('tour.screen.title', { screen: sc.name }),
              biz: fill('tour.screen.title', { screen: sc.name }),
            },
            {
              text: fill('tour.screen.sub', {
                journey: jName,
                n: String(screenRef.ordinal),
                m: String(screens.length),
              }),
              biz: fill('tour.screen.sub', { journey: jName, n: String(si + 1), m: String(screens.length) }),
            },
            journeyRef,
            screenRef,
            persona,
            cl,
            { flowId: leg.row.nodeId, screen: ordinal },
          ),
        );
        for (const id of writes.keys()) wroteAt.set(id, { stop: stops.length, screen: sc.id, name: sc.name });
      }

      // the hand-offs this screen's actions make, each record's moves in the order its lifecycle declares them
      const lifeAt = (table: string, to: string) => index.byId.get(table)?.lifecycle?.statuses.indexOf(to) ?? 0;
      const made = rankOrder(sg)
        .flatMap((mo) => (mo.preconditions?.moves ?? []).map((mv) => ({ mo, mv })))
        .sort((x, y) => (x.mv.table === y.mv.table ? lifeAt(x.mv.table, x.mv.to) - lifeAt(y.mv.table, y.mv.to) : 0));
      for (const { mo, mv } of made) {
        {
          const mk = `${mv.table}|${mv.to}|${mv.by}`;
          if (seenMove.has(mk)) continue;
          const best = bestMove.get(mk);
          if (best && (best.leg !== legIndex || best.seg !== sg.index || best.mo !== mo.index)) continue;
          seenMove.add(mk);
          const table = index.byId.get(mv.table);
          const writer = index.byId.get(mv.by);
          const rec = recordWord(table?.name ?? mv.record);
          const word = statusWord(index, table, mv.to, persona);
          const actNode = mo.preconditions?.action || undefined;
          const tr = table?.lifecycle?.transitions.find((x) => x.to === mv.to && x.by === mv.by);
          const at = locOf(writer, tr?.line);
          const writerName = writer?.name ?? mv.by.split('::').pop() ?? mv.by;
          const cl: TourClause[] = [];
          const who = persona?.name ?? jName;
          cl.push(
            clause(
              'move',
              'tour.handoff.who',
              {
                persona: who,
                record: rec,
                status: mv.to,
                action: bare(mo.label),
                screen: sc.name,
                writer: writerName,
                at,
              },
              [actNode, mv.by, mv.table],
              {
                bizKey: 'tour.biz.handoff.who',
                bizVars: { persona: who, record: rec, status: word, action: bare(mo.label), screen: sc.name },
              },
            ),
          );
          const from =
            mv.from ??
            mv.fromAny?.join(' or ') ??
            mo.preconditions?.preconditions
              .find((p) => p.relation === 'own' && p.requires?.length)
              ?.requires?.join(' or ');
          // the same move held by another action under a constant that switches it off: named here, never credited
          for (const o of (offMoves.get(mk) ?? []).slice(0, 2)) {
            cl.push(
              clause(
                'refer',
                'switch.tour.off',
                {
                  action: bare(o.label),
                  screen: o.screen,
                  writer: writerName,
                  flag: o.flag,
                  value: String(o.value),
                  at: o.at,
                },
                [o.action, mv.by],
                { bizKey: 'switch.biz.tour.off', bizVars: { action: bare(o.label), screen: o.screen } },
              ),
            );
          }
          if (mv.creates) cl.push(clause('check', 'tour.handoff.creates', { record: rec }, [mv.table, mv.by]));
          else if (mv.checked)
            cl.push(
              clause('check', 'tour.handoff.checked', { record: rec, from: from ?? '' }, [mv.by], {
                bizKey: 'tour.biz.handoff.checked',
                bizVars: { record: rec, from: fromWords(index, table, from, persona) },
              }),
            );
          else
            cl.push(
              clause('check', 'tour.handoff.unchecked', { record: rec, writer: writerName }, [mv.by], {
                warn: true,
                bizKey: 'tour.biz.handoff.unchecked',
                bizVars: { record: rec },
              }),
            );
          // what must be true first: the checks that matter to the business and the policies, each with its verdict
          const tech: string[] = [];
          for (const p of mo.preconditions?.preconditions ?? []) {
            if (p.planned) continue;
            if (p.tier === 'technical') {
              tech.push(p.id);
              continue;
            }
            const card = gateCard(index, p.id);
            cl.push(
              clause('need', 'tour.need', { words: bare(p.words) }, [p.id], {
                tier: p.tier,
                ...(card ? { evidence: card.verdict } : {}),
              }),
            );
          }
          for (const d of sum.segments[sg.index]?.decisions ?? []) {
            if (d.class !== 'business' || d.stepOrder < mo.from || d.stepOrder > mo.to) continue;
            cl.push(clause('decision', 'tour.decision', { label: d.label }, [d.nodeId]));
          }
          if (tech.length) {
            const c = counted(
              tech.length,
              'count.unit.gatesTechnical',
              'count.scope.action',
              `${SRC} → segments[${sg.index}].moments[${mo.index}].preconditions (tier technical)`,
              { bizUnit: 'count.unit.gatesTechnical' },
            );
            cl.push(clause('technical', 'tour.handoff.technical', { count: countWords(c) }, tech, { counted: c }));
          }
          // the tests of the code that writes the new status
          const proof = stepCoverage(index, mv.by);
          if (proof?.verdict && proof.verdict.runs.n) {
            cl.push(
              clause(
                'verdict',
                'tour.handoff.proof',
                verdictVars(proof.verdict),
                [
                  mv.by,
                  ...proof.tests
                    .filter((x) => !x.runLevel)
                    .slice(0, 12)
                    .map((x) => x.id),
                ],
                {
                  evidence: proof.verdict,
                  counted: proof.verdict.runs,
                  bizKey: 'tour.biz.handoff.proof',
                  bizVars: verdictVars(proof.verdict, true),
                },
              ),
            );
          } else
            cl.push(
              clause('verdict', 'tour.noTests', { what: writerName }, [mv.by], {
                bizVars: { what: fill('tour.biz.theMove', {}) },
              }),
            );
          const actOrd = actionOrdinal(sg, mo);
          const stop = makeStop(
            stops.length + 1,
            'handoff',
            {
              text: fill('tour.handoff.title', { record: rec, status: mv.to }),
              biz: fill('tour.handoff.title', { record: rec, status: word }),
            },
            {
              text: fill('tour.handoff.sub', { journey: jName, screen: sc.name }),
              biz: fill('tour.handoff.sub', { journey: jName, screen: sc.name }),
            },
            journeyRef,
            screenRef,
            persona,
            cl,
            { flowId: leg.row.nodeId, screen: ordinal, ...(actNode ? { node: actNode } : {}) },
          );
          stop.action = { nodeId: actNode ?? mv.by, label: bare(mo.label), ordinal: actOrd };
          stop.move = {
            record: table?.name ?? mv.record,
            table: mv.table,
            status: mv.to,
            word,
            ...(from ? { from } : {}),
            by: mv.by,
            checked: mv.checked,
            ...(mv.creates ? { creates: true as const } : {}),
          };
          stops.push(stop);
        }
      }
      // what the design says somebody does on this screen outside the code: a stop of its own, never a gate or a
      // verdict — the walk says who does it and that no test can reach it (the 2026-10-13 outsider round, F8)
      for (const st of sum.segments[sg.index]?.offPlatform ?? []) {
        if (seenOff.has(`${st.screen}|${st.id}`)) continue;
        seenOff.add(`${st.screen}|${st.id}`);
        const who = st.party?.name ?? st.who ?? t(`offPlatform.by.${st.by}`);
        const ocl: TourClause[] = [
          clause(
            'who',
            st.where ? 'tour.off.whoWhere' : 'tour.off.who',
            { who, where: st.where ?? '', screen: sc.name },
            [sc.id, st.party?.id],
          ),
          ...(st.party
            ? [
                clause(
                  'who',
                  st.party.role ? 'tour.off.partyRole' : 'tour.off.party',
                  { party: st.party.name, role: bare(st.party.role ?? '') },
                  [st.party.id],
                ),
              ]
            : []),
          clause('verdict', 'tour.off.noTest', {}, [sc.id]),
        ];
        const off = makeStop(
          stops.length + 1,
          'offPlatform',
          { text: st.name, biz: st.name },
          { text: fill('tour.off.sub', { screen: sc.name }), biz: fill('tour.off.sub', { screen: sc.name }) },
          journeyRef,
          screenRef,
          persona,
          ocl,
          { flowId: leg.row.nodeId, screen: ordinal },
        );
        off.offPlatform = st;
        stops.push(off);
      }
    });
  }
  stops.forEach((s, i) => {
    s.prev = i ? i : null;
    s.next = i < stops.length - 1 ? i + 2 : null;
  });

  const nodes: Record<string, TourNodeRef> = {};
  for (const s of stops) for (const id of s.referenced) nodes[id] ??= nodeRef(index, id);
  const screensN = stops.filter((s) => s.kind === 'screen').length;
  const offN = stops.filter((s) => s.kind === 'offPlatform').length;
  const scope = head.kind === 'storyline' ? ('count.scope.storyline' as const) : ('journey.scopeAll' as const);
  return {
    target: head,
    ...(opts.persona && firstPersona ? { persona: { id: firstPersona.id, name: firstPersona.name } } : {}),
    stops,
    nodes,
    counted: {
      stops: counted(
        stops.length,
        'count.unit.tourStops',
        scope,
        `${SRC} → stops (screens each once, then a stop per move)`,
        {
          bizUnit: 'count.unit.tourStops',
          breakdown: [
            { key: 'count.part.tourScreens', n: screensN },
            { key: 'count.part.tourHandoffs', n: stops.length - screensN - offN },
            ...(offN ? [{ key: 'count.part.tourOffPlatform', n: offN }] : []),
          ],
        },
      ),
    },
    derived: true,
    notes,
  };
}

function makeStop(
  n: number,
  kind: TourStop['kind'],
  title: TourStop['title'],
  sub: TourStop['sub'],
  journeyRef: TourStop['journey'],
  screen: TourStop['screen'],
  persona: LifecyclePersona | undefined,
  clauses: TourClause[],
  place: TourStop['place'],
): TourStop {
  const referenced: string[] = [];
  for (const c of clauses) for (const id of c.cites) if (!referenced.includes(id)) referenced.push(id);
  return {
    n,
    kind,
    title,
    sub,
    journey: journeyRef,
    screen,
    ...(persona ? { persona: { id: persona.id, name: persona.name } } : {}),
    clauses,
    referenced,
    prev: null,
    next: null,
    place,
  };
}

/** A precondition's evidence in words: the verdict's word, or *no test is known to reach it* when nothing does. */
export function needWord(v: TestVerdict): string {
  return v.word.cls === 'none' && !v.runs.n ? t('tour.noneKnown') : t(v.word.key);
}

/** A route's name in words when nobody wrote one: the verb, then the path's meaningful parts (never api, a version or a parameter). */
export function routeWords(name: string): string {
  const m = /^(GET|POST|PATCH|PUT|DELETE)\s+(.*)$/.exec(String(name || ''));
  if (!m) return humanizeName(name);
  const verb = (
    { GET: 'View', POST: 'Submit', PATCH: 'Update', PUT: 'Replace', DELETE: 'Remove' } as Record<string, string>
  )[m[1]!]!;
  const parts = m[2]!.split('/').filter((p) => p && !/^(api|v\d+)$/i.test(p) && !/^[:{[]/.test(p));
  return `${verb} ${humanizeName(parts.join(' ')).toLowerCase()}`.trim();
}

/** What a cited node is, for a chip and its tip. */
export function nodeRef(index: GraphIndex, id: string): TourNodeRef {
  const n = index.byId.get(id);
  if (!n) return { kind: 'function', name: id.split('::').pop() ?? id, words: id.split('::').pop() ?? id };
  const loc = locOf(n);
  const words = codeFree(
    n.kind === 'table'
      ? humanizeName(n.name)
      : n.kind === 'test'
        ? n.name
        : n.kind === 'route'
          ? bare(n.facets?.business?.label ?? n.contract?.summary ?? routeWords(n.name))
          : n.kind === 'guard' || n.kind === 'rule'
            ? bare(n.precondition?.words ?? (gateNameParts(n.name).ident ? gateNameParts(n.name).phrase : '') ?? '') ||
              wordsOf(n, n.name)
            : wordsOf(n, n.name),
  );
  return { kind: n.kind, name: n.name, words, ...(loc ? { loc } : {}) };
}

/**
 * The walk as text, for the CLI and MCP: a heading per stop, one line per clause with its citations in
 * backticks (so an agent can follow each, and a budget cut can name what it left out).
 */
export function tourLines(tour: Tour, opts: { business?: boolean; cites?: boolean } = {}): string[] {
  const biz = !!opts.business;
  const out: string[] = [];
  const n = tour.counted.stops;
  out.push(
    `# ${tour.target.name} — ${t('tour.title').toLowerCase()} · ${countWords(n, biz)} (${(n.breakdown ?? []).map((p) => fillWords(t(countKey(p.key, p.n)), { n: String(p.n) })).join(' · ')})`,
  );
  if (tour.target.description) out.push(tour.target.description);
  out.push(t('tour.derived'));
  for (const s of tour.stops) {
    out.push('');
    out.push(
      `## ${fillWords(t('tour.stopOf'), { n: String(s.n), m: String(tour.stops.length) })} · ${t(`tour.kind.${s.kind}`)} · ${biz ? s.title.biz : s.title.text}`,
    );
    out.push(biz ? s.sub.biz : s.sub.text);
    if (s.journey.branch)
      out.push(fillWords(t('tour.branch'), { name: s.journey.branch.ofName, when: s.journey.branch.when }));
    for (const c of s.clauses) {
      const mark = c.warn ? '⚠ ' : c.role === 'need' || c.role === 'decision' ? '  · ' : '';
      const cite = opts.cites === false || biz ? '' : `  [${c.cites.map((id) => `\`${id}\``).join(', ')}]`;
      const ev = c.role === 'need' && c.evidence ? ` — ${needWord(c.evidence)}` : '';
      out.push(`- ${mark}${biz ? c.biz : c.text}${ev}${cite}`);
    }
  }
  if (tour.notes.length) {
    out.push('');
    for (const x of tour.notes) out.push(`note: ${x}`);
  }
  return out;
}

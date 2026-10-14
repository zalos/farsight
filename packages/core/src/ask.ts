/**
 * Ask, with evidence (round 2026-10-10, proposal 8): **a small grammar, not a model**. Seven shapes of question are
 * recognised by their words, in either register, and each is answered from the index:
 *
 *  - `set` — *where is <record> set to <status>, and what must be true first*: the lifecycle's writer with its
 *    file and line, the action and the screen it runs from, what must be true before the move (the action's
 *    preconditions by tier, each with the gate card's verdict, and whether the code checks the status it moves
 *    from), the cases that prove the writer with `testVerdict()` and its scope, and the path from the screen to
 *    the record;
 *  - `guards` — *what guards <action | call | screen>*: the gates and rules on it, by tier;
 *  - `path` — *how does <A> reach <B>*: `pathBetween()`, the shortest chain of calls, requests, renders, reads
 *    and writes, hop by hop — or *no path the graph knows*;
 *  - `proves` — *what proves <screen | action | gate>*: the cases with their own last runs under the one verdict;
 *  - `who` — *who may <action>* (outsider round 2026-10-13, F7): the roles the code hands the role check on the
 *    action's walk (`guards` edges' `meta.requires`, or a literal argument), each with the check's verdict, and the
 *    other checks on the same action; *which roles can do which actions* is the role × action table;
 *  - `configure` — *can <thing> be configured, and how*: the settings the app is started with (config checks), the
 *    settings files the code reads, screens that set something up and the switches in the code (`meta.when.flag`),
 *    whose words meet the thing's — else the absence word, scoped to the question;
 *  - `happens` — *what happens to <record> once it is <status>*: the moves the code makes out of it, who makes each
 *    and where, and the screens that reach the record; or what an action does to the records it writes.
 *
 * A question in no shape as worded is **read as its nearest shape** by `readAs()` — a closed list of rules, each a
 * template over the question's own words and the graph's own names (a verb read as the status it names, *approve* →
 * approved, said so) — and the answer prints that reading first (*I read that as: …*), so nothing is mapped silently
 * (six of the eight reviewers of the outsider round rejected silent noun-mapping). A question no rule reads is
 * answered with the shapes and *did you mean*, never a guess. Every line is a catalog template (`strings-ask.ts`)
 * carrying the node ids it cites, and every answer says `derived: true`. The questions the outsiders asked are a
 * corpus in CI (`packages/core/test/ask-corpus.test.ts`).
 *
 * **The one extension point for a model**: `opts.phrase(answer)` may return the answer in other words; the answer
 * then carries `phrased: { text, by: 'model' }` beside — never instead of — its cited lines, and every surface
 * prints *phrased by a model* (`ask.phrased`). Nothing in Farsight passes one today.
 */
import type { GraphNode, EdgeKind, JourneysMeta, GateTier } from './graph.js';
import { type GraphIndex, type JourneySegment, type JourneyMoment, humanizeName } from './query.js';
import { journeyTree, personaOfScreen } from './journeys.js';
import { counted, scopeWord, type Counted, type CountScope } from './counts.js';
import { t as tr, type Register } from './strings.js';

const t = (key: string, reg: Register = 'professional'): string => tr(key, reg);
import { stepCoverage, cellCoverage, segmentNotBuilt, type TestVerdict, type CoverageTestRef } from './coverage.js';
import { gateCard } from './gates.js';
import { gateTierOf } from './gate-class.js';
import { isConfigCheck } from './config-check.js';
import { rolesFor, roleTable, roleWord } from './roles.js';
import { lifecycleViews } from './lifecycle.js';
import {
  flowSummary, rankOrder, actionOrdinal, fillWords, bare, holeWords, needWord, bizWords, fromWords, wordsOf, recordWord, locOf, countWords, verdictVars, nodeRef,
  type TourClause, type TourNodeRef,
} from './tour.js';

export const ASK_SHAPES = ['set', 'guards', 'path', 'proves', 'who', 'configure', 'happens'] as const;
export type AskShape = typeof ASK_SHAPES[number];

/** A door an answer offers: the gate card, the Map at a place, the cases on the Tests page. */
export interface AskDoor {
  kind: 'gate' | 'map' | 'cases';
  node?: string;
  flowId?: string;
  screen?: number;
  action?: number;
}

export interface PathHop { from: string; to: string; kind: EdgeKind }
export interface PathResult {
  from: string;
  to: string;
  /** the nodes of the shortest chain, first to last */
  nodes: string[];
  hops: PathHop[];
  /** the chain's links, scoped to the chain */
  counted: Counted;
  /** other chains of the same length the walk found (capped) */
  more: number;
  /** no chain from → to; this one runs to → from */
  reverse?: true;
}

export interface AskAnswer {
  question: string;
  shape: AskShape | 'unknown';
  /** always true: every line is a template filled from the graph */
  derived: true;
  lead: TourClause[];
  sections: { key: string; rows: TourClause[] }[];
  path?: PathResult;
  nodes: Record<string, TourNodeRef>;
  doors: AskDoor[];
  /** what the question's words were matched to */
  resolved: { term: string; id: string; name: string }[];
  /** the catalog keys of the shapes Ask understands — on an unknown question */
  shapes?: string[];
  /**
   * *Did you mean*: the nearest shapes filled with the question's own nouns, each one Ask would answer (its terms
   * resolve) — on a question it could not place or whose words matched nothing (swarm round 3, finding 2: *who
   * approves an invoice* got *nothing matches*). Never answered on the reader's behalf: the reader picks one.
   */
  suggest?: string[];
  /**
   * The question Ask answered, in one of its shapes, when the words were not one (outsider round 2026-10-13, F7): a
   * template filled with the question's own words — never a model's, never a fact the graph does not hold — and
   * printed first (*I read that as: …*), so nothing is mapped silently. Absent when the question was a shape as worded.
   */
  reworded?: string;
  /** a model's rephrasing, beside the cited lines — only when a caller passed `phrase` */
  phrased?: { text: string; by: 'model' };
}

const SRC = 'core ask.ts ask';
const fill = (key: string, vars: Record<string, string>) => fillWords(t(key), vars);

function line(
  role: TourClause['role'], key: string, vars: Record<string, string>, cites: (string | undefined)[],
  extra: Partial<Pick<TourClause, 'evidence' | 'counted' | 'warn' | 'tier'>> & { bizKey?: string; bizVars?: Record<string, string> } = {},
): TourClause {
  const { bizKey, bizVars, ...rest } = extra;
  const bv = bizWords(bizVars ?? vars);
  return {
    role, key, vars, ...(bizKey ? { bizKey } : {}), bizVars: bv,
    text: fill(key, vars), biz: fill(bizKey ?? key, bv),
    cites: [...new Set(cites.filter((x): x is string => !!x))],
    ...rest,
  };
}

// ── pathBetween ─────────────────────────────────────────────────────────────────────────────────────────

/** The edges a path follows: what runs, what draws, what reads and writes. */
export const PATH_KINDS: readonly EdgeKind[] = ['calls', 'http', 'renders', 'reads', 'writes', 'publishes', 'consumes'];

/**
 * The shortest chain from `a` to `b` over the edge index (breadth first, out-edges of `PATH_KINDS`), with how many
 * other chains of that length it met (capped at 9). Null when no chain the graph knows leads there within
 * `maxHops`, or either end is not in the graph.
 */
export function pathBetween(index: GraphIndex, a: string, b: string, opts: { maxHops?: number; kinds?: readonly EdgeKind[]; budget?: number } = {}): PathResult | null {
  if (!index.byId.has(a) || !index.byId.has(b)) return null;
  const kinds = new Set(opts.kinds ?? PATH_KINDS);
  const maxHops = opts.maxHops ?? 12;
  const budget = opts.budget ?? 60000;
  if (a === b) return { from: a, to: b, nodes: [a], hops: [], counted: hopsCounted(0), more: 0 };
  const parent = new Map<string, { from: string; kind: EdgeKind }>();
  const ways = new Map<string, number>([[a, 1]]);
  const depth = new Map<string, number>([[a, 0]]);
  let frontier = [a];
  let seen = 1;
  for (let d = 0; d < maxHops && frontier.length && !depth.has(b); d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of index.out.get(id) ?? []) {
        if (!kinds.has(e.kind)) continue;
        const dd = depth.get(e.to);
        if (dd === undefined) {
          depth.set(e.to, d + 1);
          parent.set(e.to, { from: id, kind: e.kind });
          ways.set(e.to, ways.get(id) ?? 1);
          next.push(e.to);
          if (++seen > budget) break;
        } else if (dd === d + 1) ways.set(e.to, Math.min(99, (ways.get(e.to) ?? 0) + (ways.get(id) ?? 1)));
      }
    }
    frontier = next;
  }
  if (!depth.has(b)) return null;
  const nodes = [b];
  const hops: PathHop[] = [];
  for (let at = b; at !== a;) {
    const p = parent.get(at)!;
    hops.unshift({ from: p.from, to: at, kind: p.kind });
    nodes.unshift(p.from);
    at = p.from;
  }
  return { from: a, to: b, nodes, hops, counted: hopsCounted(hops.length), more: Math.min(9, Math.max(0, (ways.get(b) ?? 1) - 1)) };
}

function hopsCounted(n: number): Counted {
  return counted(n, 'ask.unit.pathLinks', 'count.scope.path', 'core ask.ts pathBetween → hops (breadth first over calls · http · renders · reads · writes · publishes · consumes)', { bizUnit: 'ask.biz.pathLinks' });
}

// ── resolving words to nodes ────────────────────────────────────────────────────────────────────────────

type Cand = { id: string; kind: GraphNode['kind'] | 'action' | 'screen'; names: string[]; flowId?: string; seg?: number; mo?: number };

const norm = (s: string) => String(s).toLowerCase().replace(/[`'"“”‘’?!.,()]/g, ' ').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/^(?:the|a|an|our|my)\s+/, '');
const POOL = new WeakMap<GraphIndex, Cand[]>();
const KIND_RANK: Record<string, number> = { action: 0, screen: 1, route: 2, table: 3, guard: 4, rule: 4, flow: 5, page: 6, function: 7, component: 8 };

/** Every name a question may use, once per index: screens and actions off the journeys, and the named nodes. */
function pool(index: GraphIndex): Cand[] {
  const hit = POOL.get(index);
  if (hit) return hit;
  const out: Cand[] = [];
  const screenSeen = new Set<string>();
  for (const n of index.byId.values()) {
    if (n.kind !== 'flow') continue;
    const w = flowSummary(index, n.id);
    if (!w) continue;
    for (const sg of w.sum.segments) {
      if (sg.screen && !screenSeen.has(sg.screen.id)) {
        screenSeen.add(sg.screen.id);
        out.push({ id: sg.screen.id, kind: 'screen', names: [sg.screen.name], flowId: n.id, seg: sg.index });
      }
      for (const mo of sg.moments) {
        const call = mo.preconditions?.action || w.j.steps.find((s) => s.order === (mo.callStep ?? mo.actionStep))?.nodeId;
        if (call) out.push({ id: call, kind: 'action', names: [mo.label, ...(mo.business ? [mo.business] : [])], flowId: n.id, seg: sg.index, mo: mo.index });
      }
    }
  }
  for (const n of index.byId.values()) {
    if (!(n.kind in KIND_RANK) || n.kind === 'page' && screenSeen.has(n.id)) continue;
    const names = [n.name, ...(n.facets?.business?.label ? [n.facets.business.label] : [])];
    if (n.kind === 'table') names.push(recordWord(n.name), humanizeName(n.name));
    if (n.kind === 'flow' && n.design?.name) names.push(n.design.name);
    if (n.precondition?.words) names.push(n.precondition.words);
    out.push({ id: n.id, kind: n.kind, names });
  }
  POOL.set(index, out);
  return out;
}

/** The best match for a phrase, preferring the kinds named first. */
function resolveTerm(index: GraphIndex, term: string, prefer: readonly Cand['kind'][] = [], repo?: string): Cand | undefined {
  return resolveTermAll(index, term, prefer, repo).best;
}

/**
 * The best match and the others that matched as well (the same score, a different part): when the words name
 * several parts, the answer says which it picked and lists the rest (swarm round 3: *which tests reach loadDraft*
 * answered one of two `loadDraft`s without saying so; *what guards approve* picked the vendor account's approval).
 */
function resolveTermAll(index: GraphIndex, term: string, prefer: readonly Cand['kind'][] = [], repo?: string): { best?: Cand; others: Cand[] } {
  const direct = index.byId.get(term.trim());
  if (direct) return { best: { id: direct.id, kind: direct.kind, names: [direct.name] }, others: [] };
  const q = norm(term);
  if (!q) return { others: [] };
  const qt = q.split(' ');
  let best: { c: Cand; s: number } | undefined;
  const scored: { c: Cand; s: number }[] = [];
  for (const c of pool(index)) {
    if (repo && !c.id.startsWith(`${repo}::`)) continue;
    let s = 0;
    for (const raw of c.names) {
      const nm = norm(raw);
      if (!nm) continue;
      let v = 0;
      if (nm === q) v = 100;
      else if (` ${nm} `.includes(` ${q} `)) v = 70 - Math.min(30, nm.length - q.length);
      else if (` ${q} `.includes(` ${nm} `) && nm.length > 3) v = 60 - Math.min(30, q.length - nm.length);
      else if (nm.includes(q) && q.length > 3) v = 30;
      else {
        const nt = new Set(nm.split(' '));
        const shared = qt.filter((w) => w.length > 2 && (nt.has(w) || nt.has(w.replace(/s$/, '')) || nt.has(`${w}s`))).length;
        if (shared) v = Math.round((shared / Math.max(qt.length, nt.size)) * 50);
      }
      s = Math.max(s, v);
    }
    if (!s) continue;
    const pi = prefer.indexOf(c.kind);
    s += pi >= 0 ? (prefer.length - pi) * 3 : 0;
    scored.push({ c, s });
    if (!best || s > best.s || (s === best.s && (KIND_RANK[c.kind] ?? 9) < (KIND_RANK[best.c.kind] ?? 9))) best = { c, s };
  }
  if (!best || best.s < 25) return { others: [] };
  const b = best;
  // the others: as good a match, of the same kind, a different part (the same node met on two journeys is one part)
  const seen = new Set([b.c.id]);
  const others: Cand[] = [];
  for (const x of scored) {
    if (x.s < b.s || x.c.kind !== b.c.kind || seen.has(x.c.id)) continue;
    seen.add(x.c.id);
    others.push(x.c);
  }
  return { best: b.c, others };
}

/** Where a matched part sits, in words: the journey for a screen or an action, else its file. */
function whereOf(index: GraphIndex, c: Cand): string {
  if (c.flowId) { const f = index.byId.get(c.flowId); return f?.design?.name ?? f?.name ?? c.flowId; }
  return locOf(index.byId.get(c.id)) || c.id.split('::')[0]!;
}

/** The line that says which part the words were read as, and the others they match as well — '' when only one. */
function pickedLine(index: GraphIndex, best: Cand, others: Cand[]): TourClause | undefined {
  if (!others.length) return undefined;
  const nm = (c: Cand) => (c.kind === 'action' || c.kind === 'screen' ? c.names[0]! : index.byId.get(c.id)?.name ?? c.id);
  const list = others.slice(0, 5).map((c) => `${bare(nm(c))} (${whereOf(index, c)})`).join(' · ') + (others.length > 5 ? ` · +${others.length - 5}` : '');
  const c = counted(others.length, 'ask.unit.alsoMatch', 'count.scope.question', `${SRC} → resolveTermAll (as good a match, the same kind, another part)`, { bizUnit: 'ask.unit.alsoMatch' });
  return line('words', 'ask.picked', { name: bare(nm(best)), where: whereOf(index, best), count: countWords(c), others: list }, [best.id, ...others.slice(0, 5).map((x) => x.id)],
    { counted: c, bizKey: 'ask.biz.picked', bizVars: { name: bare(nm(best)), count: countWords(c, true), others: others.slice(0, 5).map((x) => bare(nm(x)) + (x.flowId ? ` (${whereOf(index, x)})` : '')).join(' · ') } });
}

// ── did you mean ────────────────────────────────────────────────────────────────────────────────────────

const STOP = new Set(('who what where when which how why whose is are was were be been do does did can could may might must should will would '
  + 'the a an of to for in on at by from with and or it its this that these those there any all some i we you me my our your their them '
  + 'true first before after then than get gets got has have had not no yes please tell show me us about').split(' '));

/** The question's own content words, in order: what a *did you mean* fills a shape with. */
function nounsOf(q: string): string[] {
  return norm(q).split(' ').filter((w) => w.length > 2 && !STOP.has(w));
}

/** A verb's stem, to meet a status the code declares: *approves* · *approve* → *approv* (meets `approved`). */
const stem = (w: string) => w.replace(/(?:ies|ied)$/, 'y').replace(/(?:ing|ed|es|s|e)$/, '');

/**
 * The nearest shapes filled with the question's nouns, each one Ask would answer: a record whose statuses the code
 * declares and a status the question's verb names (*who approves an invoice* → *where is invoice set to approved*),
 * then *what guards* / *what proves* the nouns, then *how does A reach B* for two nouns that each resolve. At most three.
 */
export function suggestQuestions(index: GraphIndex, question: string, repo?: string): string[] {
  const words = nounsOf(question);
  if (!words.length) return [];
  const out: string[] = [];
  const tables = [...index.byId.values()].filter((n) => n.kind === 'table' && n.lifecycle?.statuses.length && (!repo || n.id.startsWith(`${repo}::`)));
  for (const tb of tables) {
    const rec = recordWord(tb.name);
    const recWords = new Set([...norm(rec).split(' '), ...norm(humanizeName(tb.name)).split(' ')]);
    if (!words.some((w) => recWords.has(w) || recWords.has(stem(w)) || recWords.has(`${w}s`))) continue;
    const verbs = words.filter((w) => !recWords.has(w) && !recWords.has(stem(w)));
    // the status the verb names: its past form first (*approves* → `approved`), then any status word it begins
    const fit = (s: string) => {
      let best = 0;
      for (const v of verbs) {
        const st = stem(v);
        if (st.length < 4) continue;
        for (const sw of norm(humanizeName(s)).split(' ')) {
          if (sw === `${st}ed` || sw === `${st}d` || sw === st) best = Math.max(best, 2);
          else if (sw.startsWith(st)) best = Math.max(best, 1);
        }
      }
      return best;
    };
    const status = [...tb.lifecycle!.statuses].sort((x, y) => fit(y) - fit(x)).find((s) => fit(s) > 0);
    if (status) { out.push(fillWords(t('ask.suggest.set'), { record: rec, status: norm(humanizeName(status)) })); break; }
  }
  // the nouns as a term: plurals and third-person verbs to their base (*approves invoices* → *approve invoice*)
  const phrase = words.map((w) => (w.length > 4 && /[^s]s$/.test(w) ? w.slice(0, -1) : w)).join(' ');
  if (resolveTerm(index, phrase, ['action', 'route', 'screen'], repo)) out.push(fillWords(t('ask.suggest.guards'), { term: phrase }));
  if (out.length < 3 && resolveTerm(index, phrase, ['screen', 'action', 'guard', 'rule'], repo)) out.push(fillWords(t('ask.suggest.proves'), { term: phrase }));
  if (out.length < 3 && words.length >= 2) {
    const a = resolveTerm(index, words[0]!, ['screen', 'action', 'page'], repo);
    const b = resolveTerm(index, words[words.length - 1]!, ['table', 'route'], repo);
    if (a && b && a.id !== b.id && b.kind === 'table') out.push(fillWords(t('ask.suggest.path'), { a: words[0]!, b: words[words.length - 1]! }));
  }
  return [...new Set(out)].slice(0, 3);
}

/**
 * The question Ask shows as its example, built from this graph: a record whose statuses the code declares and a
 * status a writer moves it to — never a status the application does not have (the placeholder asked the reference
 * app about an *open* invoice it has no status for). Undefined on a graph with no lifecycle.
 */
export function askExample(index: GraphIndex, repo?: string): string | undefined {
  const tables = [...index.byId.values()]
    .filter((n) => n.kind === 'table' && (n.lifecycle?.transitions.length ?? 0) > 0 && (!repo || n.id.startsWith(`${repo}::`)))
    .sort((a, b) => b.lifecycle!.transitions.length - a.lifecycle!.transitions.length || a.id.localeCompare(b.id));
  const tb = tables[0];
  if (!tb) return undefined;
  const moves = tb.lifecycle!.transitions.filter((x) => x.by);
  const tr = moves[Math.floor(moves.length / 2)] ?? tb.lifecycle!.transitions[0]!;
  return fillWords(t('ask.suggest.set'), { record: recordWord(tb.name), status: norm(humanizeName(tr.to)) });
}

// ── the shapes ──────────────────────────────────────────────────────────────────────────────────────────

/** Which shape a question is, and its terms. `set` needs a record whose statuses the code declares. */
export function askShapeOf(q: string): { shape: AskShape; a?: string; b?: string } | null {
  const s = q.trim().replace(/\?+$/, '').trim();
  const l = s.toLowerCase();
  let m: RegExpExecArray | null;
  // the three shapes the outsider round asked in (2026-10-13, F7), each as its own words say it
  if ((m = /^who\s+(?:can|may)\s+(.+?)(?:\s*[,;—–]\s.*|\s+and\s+(?:which|what|who|how|where|when)\b.*)?$/i.exec(s))) return { shape: 'who', a: m[1]! };
  if ((m = /^what\s+happens\s+(?:to|when|if|after|once)\s+(.+?)(?:\s*,\s*and\s+(?:what|who|how|where|when)\b.*)?$/i.exec(s))) return { shape: 'happens', a: m[1]! };
  if ((m = /^(?:can|how\s+(?:is|are|can))\s+(.+?)\s+(?:be\s+)?configured(?:\b.*)?$/i.exec(s))) return { shape: 'configure', a: m[1]! };
  if ((m = /^how\s+(?:do|can|does)\s+(?:you|we|i|one)\s+configure\s+(.+)$/i.exec(s))) return { shape: 'configure', a: m[1]! };
  if (/^what\s+can\s+be\s+configured\b/i.test(s)) return { shape: 'configure', a: '' };
  if (/\b(?:set|sets|moved?|moves|becomes?|made|makes|turn(?:s|ed)?|changed?|goes|marks?|marked|put)\b/.test(l) && /\b(?:where|which|what|who|when|how)\b/.test(l)) return { shape: 'set', a: s };
  if ((m = /\b(?:how\s+(?:does|do|can|did)|does)\s+(.+?)\s+(?:reach(?:es)?|get\s+to|lead\s+to|call|calls|touch(?:es)?|connect\s+to|end\s+up\s+(?:in|at)|write\s+to|read)\s+(.+)$/i.exec(s))) return { shape: 'path', a: m[1]!, b: m[2]! };
  if ((m = /\b(?:path|route|way|chain)\s+from\s+(.+?)\s+to\s+(.+)$/i.exec(s))) return { shape: 'path', a: m[1]!, b: m[2]! };
  if ((m = /\bwhat\s+(?:proves|tests|verifies|covers)\s+(.+)$/i.exec(s))) return { shape: 'proves', a: m[1]! };
  if ((m = /\bwhich\s+tests?\s+(?:cover|covers|reach|reaches|check|checks|prove|proves)\s+(.+)$/i.exec(s))) return { shape: 'proves', a: m[1]! };
  if ((m = /\bis\s+(.+?)\s+(?:tested|proven|covered)\b/i.exec(s))) return { shape: 'proves', a: m[1]! };
  if ((m = /\bwhat\s+(?:guards|protects|gates|checks|stops|blocks|is\s+checked\s+(?:on|before|for))\s+(.+)$/i.exec(s))) return { shape: 'guards', a: m[1]! };
  if ((m = /\bwhat\s+must\s+be\s+true\s+(?:before|for|to)\s+(.+)$/i.exec(s))) return { shape: 'guards', a: m[1]! };
  return null;
}

function emptyAnswer(question: string, shape: AskAnswer['shape']): AskAnswer {
  return { question, shape, derived: true, lead: [], sections: [], nodes: {}, doors: [], resolved: [] };
}

function finish(index: GraphIndex, a: AskAnswer, phrase?: (answer: AskAnswer) => string): AskAnswer {
  const ids = new Set<string>();
  for (const c of [...a.lead, ...a.sections.flatMap((s) => s.rows)]) for (const id of c.cites) ids.add(id);
  for (const id of a.path?.nodes ?? []) ids.add(id);
  for (const id of ids) a.nodes[id] ??= nodeRef(index, id);
  if (phrase) {
    const text = phrase(a);
    if (text) a.phrased = { text, by: 'model' };
  }
  return a;
}

/**
 * Answer one question from the graph. `metas` (the graph's `meta.journeys`) names the personas a journey is for;
 * `repo` keeps one source; `phrase` is the named extension point for a model's rephrasing (see the module comment).
 */
export function ask(
  index: GraphIndex, question: string,
  opts: { metas?: Record<string, JourneysMeta>; repo?: string; phrase?: (answer: AskAnswer) => string } = {},
): AskAnswer {
  const asWorded = answerShape(index, question, askShapeOf(question), opts);
  if (asWorded && !weak(asWorded) && !LOOSE.has(asWorded)) return finish(index, asWorded, opts.phrase);
  // not a shape as worded (or its words matched nothing): the nearest shape filled with the question's own words, and
  // that rewording printed first — kept only when it finds what the words as worded did not
  const read = readAs(index, question, opts.repo);
  if (read && norm(read.q) !== norm(question)) {
    const a = answerShape(index, read.q, askShapeOf(read.q), opts, read);
    if (a && (!asWorded || !weak(a))) {
      a.question = question;
      a.reworded = read.q;
      a.lead.unshift(rewordLine(index, read, a));
      return finish(index, a, opts.phrase);
    }
  }
  if (asWorded && LOOSE.has(asWorded)) {
    // a set question that named no record: the record and the status it was read as, printed first
    const r = asWorded.resolved[0];
    const tb = r ? index.byId.get(r.id) : undefined;
    const st = tb?.lifecycle && asWorded.lead[0]?.vars.status;
    if (tb && st) {
      const q = fillWords(t('ask.suggest.set'), { record: recordWord(tb.name), status: norm(humanizeName(st)) });
      asWorded.reworded = q;
      asWorded.lead.unshift(line('words', 'ask.reworded', { question: q }, [tb.id]));
    }
  }
  if (asWorded) return finish(index, asWorded, opts.phrase);
  const a = emptyAnswer(question, 'unknown');
  a.lead.push(line('words', 'ask.unknown', {}, []));
  a.shapes = ASK_SHAPES.map((s) => `ask.shape.${s}`);
  const suggest = suggestQuestions(index, question, opts.repo);
  if (suggest.length) a.suggest = suggest;
  return a;
}

/** A shape whose words matched nothing: the nearest questions Ask would answer, from the same nouns. */
function notFound(index: GraphIndex, a: AskAnswer, term: string, repo?: string, cites: (string | undefined)[] = []): AskAnswer {
  a.lead.push(line('words', 'ask.notFound', { term }, cites));
  const suggest = suggestQuestions(index, a.question, repo).filter((s) => norm(s) !== norm(a.question));
  if (suggest.length) a.suggest = suggest;
  return a;
}
function askShapeOfRest(q: string): ReturnType<typeof askShapeOf> {
  const m = /\bhow\s+(?:does|do)\s+(.+?)\s+(?:reach|get\s+to)\s+(.+?)\??$/i.exec(q);
  return m ? { shape: 'path', a: m[1]!, b: m[2]! } : null;
}

/** Set answers whose record the question never named (one status only one record declares picked it). */
const LOOSE = new WeakSet<AskAnswer>();

/** An answer that only says its words matched nothing — a rewording may still find what the question meant. */
const weak = (a: AskAnswer) => a.lead.some((c) => c.key === 'ask.notFound' || c.key === 'ask.set.noRecord');

/** The answer to one shape, or null when the shape's words name nothing it can answer from. */
function answerShape(
  index: GraphIndex, question: string, shape: ReturnType<typeof askShapeOf>,
  opts: { metas?: Record<string, JourneysMeta>; repo?: string }, read?: Reading,
): AskAnswer | null {
  if (!shape) return null;
  let out: AskAnswer | null = null;
  // *what must be true before an invoice is approved*: a guards or proves question whose term is a record and one of
  // its statuses is the set shape's question — answering it as an action's checks matched the wrong action (swarm round 3)
  if ((shape.shape === 'guards' || shape.shape === 'proves') && /\b(?:is|are|gets?|becomes?|be)\s+\w+\s*$/i.test(shape.a ?? '')) {
    const hit = recordAndStatus(index, shape.a!, opts.repo);
    if (hit && 'status' in hit) out = answerSet(index, question, opts);
  }
  if (!out && shape.shape === 'set') out = answerSet(index, question, opts);
  if (!out && shape.shape === 'path') out = answerPath(index, question, shape.a!, shape.b!, opts.repo);
  if (!out && shape.shape === 'proves') out = answerProves(index, question, shape.a!, opts.repo);
  if (!out && shape.shape === 'guards') out = answerGuards(index, question, shape.a!, opts.repo);
  if (!out && shape.shape === 'who') out = answerWho(index, question, shape.a!, opts, read?.role);
  if (!out && shape.shape === 'configure') out = answerConfigure(index, question, shape.a ?? '', opts.repo);
  if (!out && shape.shape === 'happens') out = answerHappens(index, question, shape.a!, opts);
  // a set question with no record the code declares statuses for falls through to the other shapes' words
  if (!out && shape.shape === 'set') {
    const second = askShapeOfRest(question);
    if (second?.shape === 'path') out = answerPath(index, question, second.a!, second.b!, opts.repo);
  }
  if (!out) return null;
  // the words read as one record among several that declare the status: say which, and name the others
  if (read?.others?.length && read.verb) {
    const best: Cand = { id: read.verb.table, kind: 'table', names: [read.verb.record] };
    const others: Cand[] = read.others.map((n) => ({ id: n.id, kind: 'table', names: [recordWord(n.name)] }));
    const p = pickedLine(index, best, others);
    if (p) out.lead.unshift(p);
  }
  return out;
}

// ── reading a question as worded: the nearest shape, with the rewording shown (outsider round, F7) ──────────────
//
// Six of the eight reviewers of the outsider round rejected *silent* noun-mapping, so a question that is not a shape
// as worded is read as one only by these rules, each a template over the question's own words and the graph's own
// names — never a model, never a fact the graph does not hold — and the answer prints the reading first.

/** What a rewording was read from: the shape's question and, when a verb named a status, the verb, the status and the record. */
export interface Reading {
  shape: AskShape;
  /** the question in the shape's own words, answered in place of the one asked */
  q: string;
  /** the rule that read it (for the corpus): who · required · configure · happens · get · know · status */
  rule: string;
  verb?: { word: string; status: string; record: string; table: string };
  /** a role the question named (*can a reviewer approve an invoice*) */
  role?: string;
  /** the other records that declare the status, when the question named none */
  others?: GraphNode[];
}

/** Irregular past forms a status may be spelled in (*pay* → `paid`): a closed table, not a model. */
const IRREGULAR: Record<string, string> = { pay: 'paid', send: 'sent', make: 'made', hold: 'held', write: 'written', give: 'given', take: 'taken', get: 'got', set: 'set', put: 'put', lose: 'lost', buy: 'bought' };
const IRREGULAR_BACK = Object.fromEntries(Object.entries(IRREGULAR).map(([k, v]) => [v, k]));
/** Nouns the outsiders used for a move (*approval*, *payment*): each to its verb. A closed table. */
const NOUN_VERB: Record<string, string> = {
  approval: 'approve', approvals: 'approve', payment: 'pay', payments: 'pay', payout: 'pay', payouts: 'pay', submission: 'submit',
  verification: 'verify', rejection: 'reject', cancellation: 'cancel', denial: 'deny', closure: 'close', creation: 'create',
  compilation: 'compile', settlement: 'settle', correction: 'correct', corrections: 'correct', consolidation: 'consolidate',
  requirement: 'require', requirements: 'require', confirmation: 'confirm', registration: 'register',
};
/** Words that ask about a thing's configuration, never name the thing. */
const GENERIC = new Set(['required', 'require', 'requirement', 'requirements', 'rule', 'rules', 'setting', 'settings', 'option', 'options',
  'thing', 'things', 'value', 'values', 'configure', 'configured', 'configuration', 'configurable', 'change', 'changed', 'customise', 'customize',
  'where', 'needed', 'need', 'today', 'actually', 'exactly', 'company', 'screen', 'without', 'vendor’s', 'developers', 'set', 'up']);

/** A word's singular (*invoices* → *invoice*, *categories* → *category*). */
const sing = (w: string) => (w.length > 3 && /ies$/.test(w) ? `${w.slice(0, -3)}y` : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);
/** The key two words meet on: *approves* · *approved* · *approval* → `approv`; *paid* · *payment* → `pay`. */
function wordKey(w: string): string {
  const x = w.toLowerCase();
  const v = NOUN_VERB[x] ?? IRREGULAR_BACK[x] ?? x;
  return stem(sing(v));
}
/** A text's words as keys. */
function keysOf(text: string): Set<string> {
  return new Set(String(text ?? '').toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-z0-9’']+/).filter((w) => w.length > 1).map(wordKey));
}
/** The question's content words, in order, with *the*, *who*, *can* and the rest of the stop words left out. */
function contentWords(q: string): string[] {
  return norm(q).split(' ').filter((w) => w.length > 1 && !STOP.has(w));
}
/** A verb's base from the form a question used it in (*approves* · *approved* · *paying* · *paid* → *approve* · *pay*). */
function verbBase(w: string): string {
  const x = w.toLowerCase();
  if (IRREGULAR_BACK[x]) return IRREGULAR_BACK[x]!;
  if (NOUN_VERB[x]) return NOUN_VERB[x]!;
  if (/ies$/.test(x)) return x.replace(/ies$/, 'y');
  if (/ied$/.test(x)) return x.replace(/ied$/, 'y');
  if (/(?:ss|sh|ch|x|o)es$/.test(x)) return x.slice(0, -2);
  if (/[^s]s$/.test(x) && x.length > 3) return x.slice(0, -1);
  if (/ed$/.test(x) && x.length > 4) { const b = x.slice(0, -2); return /([^aeiou])\1$/.test(b) ? b.slice(0, -1) : /(?:v|u|c|g|s|z)$/.test(b) ? `${b}e` : b; }
  if (/ing$/.test(x) && x.length > 5) return x.slice(0, -3);
  return x;
}
/** The forms a status word may take for a verb: *approve* → approved · *pay* → paid · *submit* → submitted · *deny* → denied. */
function pastForms(base: string): string[] {
  const b = base.toLowerCase();
  const out = [`${b}ed`, `${b}d`, b.replace(/y$/, 'ied'), `${b}${b.slice(-1)}ed`];
  if (IRREGULAR[b]) out.push(IRREGULAR[b]!);
  return out;
}

/**
 * How well a status fits the question's words: 2 when a word *is* the status (`paid`, `cancelled`) or its verb's past
 * form (*approve* → `approved`, *pay* → `paid`) — for a status of several words, its last word, or the whole status in
 * the question; 1 when a verb begins a word of it; else 0.
 */
function statusFit(index: GraphIndex, table: GraphNode, status: string, words: string[], q: string): number {
  const phrases = new Set([norm(humanizeName(status))]);
  for (const v of lifecycleViews(index, table, { personas: Object.keys(table.lifecycle?.names?.views ?? {}).map((id) => ({ id, name: id })) })) {
    for (const r of v.rows) if (r.status === status && r.word) phrases.add(norm(r.word));
  }
  let best = 0;
  for (const ph of phrases) {
    if (!ph) continue;
    if (` ${norm(q)} `.includes(` ${ph} `)) return 2;
    const sws = ph.split(' ');
    const main = sws[sws.length - 1]!;
    for (const w of words) {
      const base = verbBase(w);
      if (main === w || pastForms(base).includes(main)) best = Math.max(best, sws.length === 1 ? 2 : 1, main === w && sws.length === 1 ? 2 : 0);
      if (sws.length > 1 && pastForms(base).includes(main)) best = Math.max(best, 2);
      const st = stem(base);
      if (st.length >= 4 && sws.some((sw) => sw.startsWith(st))) best = Math.max(best, 1);
    }
  }
  return best;
}

/** The record's names as words a question may use: its name, its singular, its words, the label somebody wrote. */
function recordNames(n: GraphNode): string[] {
  return [recordWord(n.name), norm(humanizeName(n.name)), norm(n.name), ...(n.facets?.business?.label ? [norm(n.facets.business.label)] : [])].filter(Boolean);
}

/**
 * A record whose statuses the code declares and the status the question's words name — a word that is the status, or
 * a verb whose past form it is (*approve* → approved, *pay* → paid). The record the words name first; when they name
 * none, any record that declares a status the words name exactly, the one with the most moves first and the others
 * kept so the answer can say it picked one.
 */
export function verbRecord(index: GraphIndex, q: string, repo?: string, opts: { exact?: boolean; named?: boolean } = {}): { table: GraphNode; status?: string; verb?: string; others: GraphNode[] } | undefined {
  // *sends back* is a return for correction, not a status *sent*
  const all = norm(q).replace(/\b(?:send|sends|sent|sending)\s+back\b/g, 'return').split(' ').filter(Boolean);
  const have = new Set(all.flatMap((w) => [w, sing(w)]));
  const tables = [...index.byId.values()].filter((n) => n.kind === 'table' && n.lifecycle?.statuses.length && (!repo || n.id.startsWith(`${repo}::`)));
  const named = tables.map((n) => ({ n, w: recordNames(n).filter((nm) => nm.split(' ').every((x) => have.has(x) || have.has(sing(x)))).sort((a, b) => b.length - a.length)[0] }))
    .filter((x) => x.w).sort((a, b) => b.w!.split(' ').length - a.w!.split(' ').length || (b.n.lifecycle!.transitions.length - a.n.lifecycle!.transitions.length));
  const pick = (n: GraphNode, recWords: Set<string>, min: number) => {
    const words = all.filter((w) => !recWords.has(w) && !recWords.has(sing(w)) && !STOP.has(w));
    let best: { s: string; f: number; verb: string } | undefined;
    for (const s of n.lifecycle!.statuses) {
      const f = statusFit(index, n, s, words, q);
      if (f >= min && (!best || f > best.f)) best = { s, f, verb: words.find((w) => statusFit(index, n, s, [w], '') >= 1) ?? '' };
    }
    return best;
  };
  for (const { n, w } of named) {
    const st = pick(n, new Set(w!.split(' ')), opts.exact ? 2 : 1);
    if (st) return { table: n, status: st.s, verb: st.verb, others: [] };
  }
  if (named.length) return { table: named[0]!.n, others: [] };
  if (opts.named) return undefined;
  const hits = tables.map((n) => ({ n, st: pick(n, new Set(), 2) })).filter((x) => x.st)
    .sort((a, b) => b.n.lifecycle!.transitions.length - a.n.lifecycle!.transitions.length || a.n.id.localeCompare(b.n.id));
  const h = hits[0];
  return h ? { table: h.n, status: h.st!.s, verb: h.st!.verb, others: hits.slice(1).map((x) => x.n) } : undefined;
}

/** The roles the graph's role checks are handed, as the words a question may name them by (*approver* → `ops.approver`). */
function roleWordsOf(index: GraphIndex, repo?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of allRoleRows(index, repo)) {
    for (const role of r.roles) {
      const w = norm(role.split(/[.:/]/).pop() ?? role);
      if (w && w.length > 2) { out.set(w, role); out.set(`${w}s`, role); }
    }
  }
  return out;
}

/** The leading noun phrase of a clause: the words before its verb (*the vendor account is for who they say* → *vendor account*). */
function nounPhrase(s: string): string {
  const w = norm(s).split(' ');
  const cut = w.findIndex((x, i) => i > 0 && /^(?:is|are|was|were|has|have|does|do|can|will|belongs?|really|actually|for|to|that)$/.test(x));
  return (cut > 0 ? w.slice(0, cut) : w.slice(0, 3)).join(' ').trim();
}

/** The term a question names after its shape words, with its trailing clause left off (*approve an invoice, and …*). */
const clause = (s: string) => s.replace(/\s*[,;—–]\s.*$/, '').replace(/\s+(?:to|for|on)\s+(?:it|them)$/i, '').replace(/\s+and\s+(?:which|what|who|how|where|when|does|do|is)\b.*$/i, '').replace(/["“”]/g, '').trim();

/** *what is required to approve an invoice* → the set shape when a record and a status are named, else the action's checks. */
function readRequired(index: GraphIndex, term: string, repo: string | undefined, rule: string): Reading {
  const vr = verbRecord(index, term, repo);
  if (vr?.status) {
    const record = recordWord(vr.table.name);
    return { shape: 'set', rule, q: fillWords(t('ask.suggest.set'), { record, status: norm(humanizeName(vr.status)) }), verb: { word: vr.verb ?? '', status: vr.status, record, table: vr.table.id }, ...(vr.others.length ? { others: vr.others } : {}) };
  }
  return { shape: 'guards', rule, q: fillWords(t('ask.suggest.guards'), { term }) };
}

/**
 * The nearest shape for a question that is not one as worded, filled with its own words; null when no rule reads it
 * (the answer is then *did you mean*). Pure over the index: the same words always read the same way.
 */
export function readAs(index: GraphIndex, question: string, repo?: string): Reading | null {
  // a leading topic the reader set off with a colon (*Bad path — rejection: can an invoice be …*) is a heading, not the question
  let s = question.trim().replace(/\?+$/, '').replace(/\s+/g, ' ').trim();
  const topic = /^[^:?]{1,48}:\s+(?=\S)/.exec(s);
  if (topic && !/\b(?:who|what|which|how|can|does|is|are|when|where)\b.*\b(?:who|what|which|how|can|does|is|are|when|where)\b/i.test(topic[0])) s = s.slice(topic[0].length);
  const l = s.toLowerCase();
  let m: RegExpExecArray | null;
  const strip = (x: string) => x.replace(/^(?:press|click|use|do|perform|hit|run|carry\s+out)\s+/i, '').replace(/["“”]/g, '')
    .replace(/^(?:the\s+)?(\w+)\s+(?:button|action)\b\s*/i, '$1 ').trim();
  const who = (term: string, rule = 'who', role?: string): Reading | null => {
    const tm = strip(clause(term));
    return tm ? { shape: 'who', rule, q: fillWords(t('ask.suggest.who'), { term: tm }), ...(role ? { role } : {}) } : null;
  };
  const guards = (term: string, rule: string): Reading | null => {
    const tm = strip(clause(term)).replace(/^(?:the|a|an)\s+/i, '');
    return tm ? { shape: 'guards', rule, q: fillWords(t('ask.suggest.guards'), { term: tm }) } : null;
  };
  // ── who may: *who is allowed to*, *which roles can*, *who performs*, *who approves*, *can a reviewer approve* ──
  if ((m = /^(?:who|which\s+(?:roles?|people|persons?|users?|operators?)|what\s+roles?)\s+(?:is|are)\s+(?:allowed|permitted|able|authori[sz]ed|entitled)\s+to\s+(.+)$/i.exec(s))) return who(m[1]!);
  if ((m = /^(?:which|what)\s+roles?\s+(?:can|may|could|are\s+allowed\s+to)\s+(.+)$/i.exec(s))) {
    if (/^(?:do\s+)?(?:which|what|each|every|all|any)\b/i.test(m[1]!)) return { shape: 'who', rule: 'who', q: t('ask.suggest.whoAll') };
    return who(m[1]!);
  }
  if ((m = /^who\s+(?:has\s+(?:the\s+)?(?:right|permission)|gets)\s+to\s+(.+)$/i.exec(s))) return who(m[1]!);
  if ((m = /^who\s+(?:performs|does|runs|carries\s+out|handles|presses|clicks)\s+(.+)$/i.exec(s))) return who(m[1]!);
  if (/^(?:can|may|could)\b/i.test(s) && !/\bconfigur|\bcustomi[sz]/i.test(l)) {
    // *can a person with only the reviewer role press "Approve" …*: the role the code knows, then what it would do
    const roles = roleWordsOf(index, repo);
    const named = [...roles.keys()].sort((a, b) => b.length - a.length).find((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s));
    const rm = named ? new RegExp(`\\b${named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?:\\s+roles?)?\\s+(.+)$`, 'i').exec(s) : null;
    if (named && rm) { const r = who(rm[1]!, 'who', roles.get(named)); if (r) return r; }
    const rr = /\b(?:the|a|an)\s+([a-z-]+)\s+role\s+(.+)$/i.exec(s);
    if (rr) { const r = who(rr[2]!, 'who', rr[1]!.toLowerCase()); if (r) return r; }
    // *can a reviewer approve an invoice*: a person, a verb an action is named by, its object
    const pm = /^(?:can|may|could)\s+(?:a|an|the|any|one)\s+([a-z-]+)\s+(\w+)\s+(.+)$/i.exec(s);
    if (pm && ACTION_VERBS.has(verbBase(pm[2]!)) && !/^(?:person|one|user)$/i.test(pm[1]!)) { const r = who(`${pm[2]} ${pm[3]}`, 'who', pm[1]!.toLowerCase()); if (r) return r; }
  }
  if ((m = /^who\s+([a-z]+s)\s+(.+)$/i.exec(s)) && !/^(?:is|was|has|does|goes|sees|says|knows|holds|receives|uses)$/i.test(m[1]!)) return who(`${verbBase(m[1]!)} ${m[2]!}`);
  // *…, and who closes it*: the verb on the record the sentence names
  if ((m = /\bwho\s+([a-z]+s)\s+(?:it|them)\b/i.exec(s)) && !/^(?:is|was|has|does|sees|says|knows|holds|receives|uses)$/i.test(m[1]!)) {
    const head = s.slice(0, m.index);
    const vr = verbRecord(index, head, repo, { named: true });
    const obj = vr ? recordWord(vr.table.name) : /\b(?:for|of|on|to)\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z -]*?)\s*(?:,|$)/i.exec(head)?.[1];
    if (obj) return who(`${verbBase(m[1]!)} ${obj}`);
  }
  // ── configure: *can you configure X*, *how do we change X*, *what can a client configure*, *is X configurable* ──
  if (/\b(?:configur\w*|customi[sz]\w*)\b/i.test(l) || /^(?:who|how|where)\s+(?:can|could|do|does)\s+(?:\w+\s+)?(?:change|set\s+up)\b/i.test(l)) {
    let after = /\b(?:configure|configured|configurable|customi[sz]e|customi[sz]ed|change|set\s+up)\b\s*(.*)$/i.exec(s)?.[1] ?? '';
    // *what can my company configure without the vendor's developers: required documents, …* — the list after the colon
    if (/:\s/.test(after)) after = after.slice(after.indexOf(':') + 1).trim();
    let thing = clause(after.replace(/^(?:a|an|the|its|their|our|your)\s+/i, ''));
    if (!thing) { const before = /^(?:is|are)\s+(.+?)\s+configurable/i.exec(s)?.[1]; if (before) thing = clause(before); }
    const req = /^what\s+(?:is|are)\s+(?:required|needed)\s+(?:on|for|of|in|by)\s+(.+)$/i.exec(thing);
    if (req) thing = `the requirements on ${req[1]}`;
    const named = contentWords(thing).filter((w) => !GENERIC.has(w));
    return named.length
      ? { shape: 'configure', rule: 'configure', q: fillWords(t('ask.suggest.configure'), { term: thing }) }
      : { shape: 'configure', rule: 'configure', q: t('ask.suggest.configureAll') };
  }
  // ── what proves: *is X built and working*, *was the X case ever run* ──
  if ((m = /^(?:is|are)\s+(.+?)\s+(?:built|working|tested|live|done|finished)\b/i.exec(s))) return { shape: 'proves', rule: 'proves', q: fillWords(t('ask.suggest.proves'), { term: strip(clause(m[1]!)).replace(/^(?:the|a|an)\s+/i, '') }) };
  if ((m = /^(?:was|were|has|have|did)\s+(?:the\s+)?(.+?)\s+(?:case|cases|test|tests)\s+(?:ever\s+)?(?:been\s+)?(?:run|pass|passed|green)\b/i.exec(s))) return { shape: 'proves', rule: 'proves', q: fillWords(t('ask.suggest.proves'), { term: strip(clause(m[1]!)) }) };
  // ── how does A reach B: *does a vendor record land in Business Central before …* ──
  if ((m = /^(?:when\s+.+?,\s*)?(?:does|do|can|will|could)\s+(?:a|an|the)?\s*(.+?)\s+(?:land|end\s+up|arrive|get\s+written)\s+(?:in|at|on)\s+(.+?)(?:\s+(?:before|after|when|until)\b.*)?$/i.exec(s))) {
    return { shape: 'path', rule: 'path', q: fillWords(t('ask.suggest.path'), { a: m[1]!.trim(), b: m[2]!.trim() }) };
  }
  // ── what guards: separation of duties, limits, what stops, what is compared ──
  if ((m = /^can\s+(?:one|the\s+same|a\s+single)\s+(?:person|user|operator|someone)\s+(.+?)\s+and\s+(?:then\s+)?(.+)$/i.exec(s))) return guards(m[2]!, 'separate');
  if ((m = /^(?:are|is)\s+there\s+(?:any\s+|an?\s+)?(.+?)\s+(?:limits?|rules?|checks?|controls?|thresholds?)\b/i.exec(s))) {
    const verb = contentWords(m[1]!).map((w) => NOUN_VERB[w] ?? w).filter((w) => ACTION_VERBS.has(w));
    return guards(verb.length ? verb.join(' ') : m[1]!, 'limits');
  }
  if ((m = /^what\s+(?:stops|prevents|blocks|keeps)\s+(.+?)(?:\s+from)?$/i.exec(s))) {
    const vm = /\b(?:being\s+)?(\w+ed)\b/i.exec(m[1]!);
    const rec = verbRecord(index, m[1]!, repo, { named: true });
    if (vm && rec) return guards(`${verbBase(vm[1]!)} ${recordWord(rec.table.name)}`, 'stops');
    return guards(m[1]!, 'stops');
  }
  if ((m = /^what\s+(?:exactly\s+)?(?:does|do)\s+.+?\s+(?:compare|check|look\s+at|match|verify)\s+(?:in|on|for|during|against)\s+(.+)$/i.exec(s))) return guards(m[1]!, 'compare');
  // ── what is required to: the set shape when the words name a record and a status, else the action's checks ──
  if ((m = /^what\s+(?:is|are)\s+(?:required|needed|necessary|checked)\s+(?:to|for|before)\s+(.+)$/i.exec(s))) return readRequired(index, clause(m[1]!), repo, 'required');
  if ((m = /^what\s+(?:do|does)\s+(?:you|we|i|one|it|they|a\s+\w+)\s+need\s+(?:to|for|before)\s+(.+)$/i.exec(s))) return readRequired(index, clause(m[1]!), repo, 'required');
  if ((m = /^what\s+does\s+it\s+take\s+(?:to|for)\s+(.+)$/i.exec(s))) return readRequired(index, clause(m[1]!), repo, 'required');
  if ((m = /^what\s+(?:has|have|needs?)\s+to\s+(?:be\s+true|happen)\s+(?:before|for|to)\s+(.+)$/i.exec(s))) return readRequired(index, clause(m[1]!), repo, 'required');
  // ── can <record> be <status>: where is it set to that status (*can an invoice be rejected or cancelled at all*) ──
  if ((m = /^can\s+(?:an?\s+|the\s+)?(.+?)\s+be\s+([a-z]+)(?:\s*(?:\/|\bor\b)\s*([a-z]+))?\b/i.exec(s))) {
    const vr = verbRecord(index, m[1]!, repo, { named: true });
    if (vr) {
      const record = recordWord(vr.table.name);
      const words = [m[2]!, m[3]].filter((x): x is string => !!x);
      for (const w of words) {
        const st = vr.table.lifecycle!.statuses.find((x) => statusFit(index, vr.table, x, [w], w) >= 2);
        if (st) return { shape: 'set', rule: 'can-be', q: fillWords(t('ask.suggest.set'), { record, status: norm(humanizeName(st)) }), verb: { word: w, status: st, record, table: vr.table.id } };
      }
      return { shape: 'set', rule: 'can-be', q: fillWords(t('ask.suggest.set'), { record, status: words[0]!.toLowerCase() }) };
    }
  }
  // ── how does <record> get <status> — the set shape; else the action's checks (*how does a vendor get approved*) ──
  if ((m = /^how\s+(?:does|do|is|are|can|did|would)\s+(?:an?\s+|the\s+)?(.+?)\s+(?:get|gets|become|becomes|end\s+up|turn)\s+(\w+)(?:\s.*)?$/i.exec(s))) {
    const vr = verbRecord(index, `${m[1]} ${m[2]}`, repo, { named: true });
    if (vr?.status) return readRequired(index, `${m[2]} ${m[1]}`, repo, 'get');
    return guards(`${verbBase(m[2]!)} ${m[1]!}`, 'get');
  }
  // ── how is <thing> verified · how do we know <X>: the checks on it ──
  if ((m = /^how\s+(?:is|are)\s+(?:an?\s+|the\s+)?(.+?)\s+(verified|checked|validated|confirmed|approved|vetted)\b/i.exec(s))) return guards(`${verbBase(m[2]!)} ${m[1]!}`, 'verified');
  if ((m = /^how\s+(?:do|can|would|could|does|will)\s+(?:we|you|i|they|one|anyone|the\s+\w+)\s+(?:know|tell|check|verify|ensure|make\s+sure|confirm|prove)\s+(?:that\s+|whether\s+|if\s+)?(.+)$/i.exec(s))) {
    const np = nounPhrase(m[1]!);
    if (np) return { shape: 'guards', rule: 'know', q: fillWords(t('ask.suggest.guards'), { term: np }) };
  }
  // ── a record and a status the first clause names (*when does the business pay* → paid): the set shape ──
  if (/^(?:when|where|which|what)\b/i.test(s)) {
    const first = s.split(/,\s|\s+and\s+(?:where|who|what|how|when|which)\b/i)[0]!;
    // a record the clause does not name is read from its verb only when the verb is what the question asks about
    const verbAsked = /^(?:when\s+(?:does|do|did|will|is|are)|which\s+\w+\s+(?:actually\s+)?(?:makes?|marks?|sets?|moves?))\b/i.test(first);
    const vr = verbRecord(index, first, repo, { exact: true, named: !verbAsked });
    if (vr?.status) {
      const record = recordWord(vr.table.name);
      return { shape: 'set', rule: 'status', q: fillWords(t('ask.suggest.set'), { record, status: norm(humanizeName(vr.status)) }), verb: { word: vr.verb ?? '', status: vr.status, record, table: vr.table.id }, ...(vr.others.length ? { others: vr.others } : {}) };
    }
  }
  return null;
}

/** The line every reworded answer prints first: *I read that as: …*, with the verb's status when one was read. */
function rewordLine(index: GraphIndex, read: Reading, a: AskAnswer): TourClause {
  const cites = [...(read.verb ? [read.verb.table] : []), ...a.resolved.map((r) => r.id), ...(a.lead[0]?.cites ?? [])].filter((id) => index.byId.has(id));
  if (read.verb && read.verb.word) {
    const status = norm(humanizeName(read.verb.status));
    return line('words', 'ask.reworded.status', { question: read.q, verb: read.verb.word, record: read.verb.record, status }, cites);
  }
  return line('words', 'ask.reworded', { question: read.q }, cites);
}

// ── resolving an action by its verb and its object ─────────────────────────────────────────────────────────

/** An action's words, as keys: its label, the label's first words, the sentence somebody wrote, the route it calls. */
const ACTION_WORDS = new WeakMap<GraphIndex, Map<string, { lead: Set<string>; label: Set<string>; biz: Set<string>; path: Set<string> }>>();
function actionWords(index: GraphIndex, c: Cand) {
  let m = ACTION_WORDS.get(index);
  if (!m) { m = new Map(); ACTION_WORDS.set(index, m); }
  const k = `${c.id}\u0000${c.names[0]}`;
  const hit = m.get(k);
  if (hit) return hit;
  const label = c.names[0] ?? '';
  const n = index.byId.get(c.id);
  const path = n?.kind === 'route' || n?.kind === 'function'
    ? keysOf(n.name.replace(/^(?:GET|POST|PUT|PATCH|DELETE)\s+/, '').split(/[/:{}[\]\s-]+/).filter((x) => x && !/^(?:api|v\d+|param|id)$/i.test(x)).join(' '))
    : new Set<string>();
  const v = { lead: keysOf(label.split(/\s+/).slice(0, 3).join(' ')), label: keysOf(label), biz: keysOf(c.names.slice(1).join(' ')), path };
  m.set(k, v);
  return v;
}

/**
 * The action a verb and an object name (*approve an invoice*): every action on a journey, scored by where each of the
 * phrase's words meets it — the route it calls and the label's first words weigh most, the rest of the label next,
 * the sentence somebody wrote least — and kept only when the words meet it at least twice (or once, for one word). The
 * others as good are kept, so the answer can say which it picked.
 */
function resolveAction(index: GraphIndex, phrase: string, repo?: string): { best?: Cand; others: Cand[]; hits: number; of: number } {
  const q = [...new Set(contentWords(phrase).filter((w) => !GENERIC.has(w) || /^(?:change|set)$/.test(w)).map(wordKey))].filter((w) => w.length > 1);
  if (!q.length) return { others: [], hits: 0, of: 0 };
  const rank = (list: Cand[]) => rankActions(index, q, list);
  const seen = new Set<string>();
  const gather = (kind: Cand['kind']) => {
    const out: Cand[] = [];
    for (const c of pool(index)) {
      if (c.kind !== kind || seen.has(c.id) || (repo && !c.id.startsWith(`${repo}::`))) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out;
  };
  const first = rank(gather('action'));
  // no action on a journey: a call the code serves (*approve an invoice* → the approve route), by the same words
  return first.best ? first : rank(gather('route'));
}

function rankActions(index: GraphIndex, q: string[], actions: Cand[]): { best?: Cand; others: Cand[]; hits: number; of: number } {
  // a word most actions share (*invoice* on an invoicing app) tells them apart less than a rare one (*correction*)
  const df = new Map<string, number>();
  for (const c of actions) { const w = actionWords(index, c); for (const k of q) if (w.path.has(k) || w.label.has(k) || w.biz.has(k)) df.set(k, (df.get(k) ?? 0) + 1); }
  const idf = (k: string) => Math.log(1 + actions.length / Math.max(1, df.get(k) ?? 0));
  const scored: { c: Cand; s: number; hits: number }[] = [];
  for (const c of actions) {
    const w = actionWords(index, c);
    let s = 0;
    let hits = 0;
    for (const k of q) {
      const v = Math.max(w.path.has(k) ? 3 : 0, w.lead.has(k) ? 3 : 0, w.label.has(k) ? 2 : 0, w.biz.has(k) ? 1 : 0);
      if (v) { hits++; s += v * idf(k); }
    }
    if (hits >= Math.min(2, q.length)) scored.push({ c, s, hits });
  }
  scored.sort((a, b) => b.s - a.s || b.hits - a.hits);
  const b = scored[0];
  if (!b) return { others: [], hits: 0, of: q.length };
  return { best: b.c, others: scored.filter((x) => x !== b && Math.abs(x.s - b.s) < 1e-9).map((x) => x.c), hits: b.hits, of: q.length };
}

/** The verbs an action is named by: a closed list, so *vendor account* is never read as *vendor* an *account*. */
const ACTION_VERBS = new Set(('approve reject verify submit create delete remove update edit pay send close open mark record request attach claim sign '
  + 'upload add start finalize finalise cancel deny review requeue post link unlink issue list view find search correct resolve withdraw settle '
  + 'compile schedule consolidate confirm register invite assign move set change enter key import export retry block unblock activate deactivate '
  + 'void refund draft save discard publish archive restore approves').split(' '));
/** A term that starts with an action's verb (*approve an invoice*), in any of its forms. */
const verbLed = (term: string) => { const w = contentWords(term)[0]; return !!w && ACTION_VERBS.has(verbBase(w)); };

// ── who may <action> ───────────────────────────────────────────────────────────────────────────────────

/** One role check at one call site: the guard, what it guards, the roles the code hands it and where they came from. */
interface RoleRow { guard: string; target: string; roles: string[]; from?: string }

/** A literal role a guard call was handed, from the guard instance's own id (`::guard::requireScope(billing:admin)`). */
const literalRole = (id: string) => /::guard::[\w.$]+\((['"]?)([^()'"]+)\1\)$/.exec(id)?.[2];

/**
 * The role checks on these parts: every `guards` edge into them whose call site handed the guard a role — read from a
 * constant table (`meta.requires`, the parser's preconditions pass) or a literal argument. This is the fold the
 * `gates` lane's core `roles.ts` exposes as `rolesFor(index, { action })`; Ask switches to it when it lands.
 */
function rolesOn(index: GraphIndex, ids: Iterable<string>): RoleRow[] {
  const out: RoleRow[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    for (const e of index.in.get(id) ?? []) {
      if (e.kind !== 'guards') continue;
      const g = index.byId.get(e.from);
      if (g?.kind !== 'guard') continue;
      const req = typeof e.meta?.requires === 'string' ? e.meta.requires : literalRole(g.id);
      if (!req) continue;
      const key = `${g.id}\u0000${req}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ guard: g.id, target: id, roles: req.split(/\s*,\s*/).filter(Boolean), ...(typeof e.meta?.requiresFrom === 'string' ? { from: e.meta.requiresFrom } : {}) });
    }
  }
  return out;
}
/**
 * The roles on an action, from core `roles.ts` (`rolesFor`, the role × action table's fold — one answer for Ask, the
 * gate card, `farsight roles` and MCP `roles`): the action itself and the calls its walk makes. A role the parser left
 * unread there (`rolesRead: false`) and a guard the table does not hold are read from a literal argument at the call
 * (`requireScope('billing:admin')`) — the one shape `roles.ts` does not read.
 */
function rolesForAction(index: GraphIndex, c: Cand, repo?: string): RoleRow[] {
  const parts = partsOf(index, c);
  const ids = [c.id, ...[...parts].filter((id) => id !== c.id && index.byId.get(id)?.kind === 'route')];
  const out: RoleRow[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    for (const r of rolesFor(index, { action: id, ...(repo ? { repo } : {}) })) {
      if (r.action.id !== id && r.action.handler !== id) continue;
      const roles = r.rolesRead ? r.roles : (literalRole(r.guard.id) ? [literalRole(r.guard.id)!] : []);
      const key = `${r.guard.id}\u0000${roles.join(',')}`;
      if (!roles.length || seen.has(key)) continue;
      seen.add(key);
      out.push({ guard: r.guard.id, target: r.action.id, roles, ...(r.requiresFrom ? { from: r.requiresFrom } : {}) });
    }
  }
  if (out.length) return out;
  return rolesOn(index, parts);
}
const ALL_ROLES = new WeakMap<GraphIndex, RoleRow[]>();
function allRoleRows(index: GraphIndex, repo?: string): RoleRow[] {
  let rows = ALL_ROLES.get(index);
  if (!rows) {
    const targets = new Set<string>();
    for (const list of index.in.values()) for (const e of list) if (e.kind === 'guards') targets.add(e.to);
    rows = rolesOn(index, targets);
    ALL_ROLES.set(index, rows);
  }
  return repo ? rows.filter((r) => r.target.startsWith(`${repo}::`)) : rows;
}

/** The parts an action's walk passes through: the action, the calls it makes, its walk's steps. */
function partsOf(index: GraphIndex, c: Cand): Set<string> {
  const ids = new Set<string>([c.id]);
  for (const e of index.out.get(c.id) ?? []) if (e.kind === 'http' || e.kind === 'calls') ids.add(e.to);
  for (const m of momentsOf(index, c)) {
    const w = flowSummary(index, m.flowId);
    for (const st of w?.j.steps ?? []) if (st.order >= m.mo.from && st.order <= m.mo.to) ids.add(st.nodeId);
  }
  return ids;
}

/** The checks on an action, a call or a screen, each once — the gates on its journeys' moments, else on its own walk. */
function checksOf(index: GraphIndex, c: Cand): { gates: Map<string, { tier: GateTier; words: string; loc?: string }>; moments: ReturnType<typeof momentsOf> } {
  const gates = new Map<string, { tier: GateTier; words: string; loc?: string }>();
  const moments = momentsOf(index, c);
  for (const m of moments) for (const p of m.mo.preconditions?.preconditions ?? []) {
    if (!p.planned && !gates.has(p.id)) gates.set(p.id, { tier: p.tier, words: p.words, ...(p.loc ? { loc: p.loc } : {}) });
  }
  if (!moments.length && index.byId.has(c.id)) {
    const w = flowSummary(index, c.id);
    for (const st of w?.j.steps ?? []) for (const g of st.gates) {
      if (g.config || g.planned || gates.has(g.id)) continue;
      const n = index.byId.get(g.id);
      gates.set(g.id, { tier: n ? gateTierOf(n).tier : g.tier ?? 'business', words: n?.precondition?.words ?? g.name, ...(n?.loc ? { loc: locOf(n) } : {}) });
    }
  }
  return { gates, moments };
}

/** A check as an answer row: its words, its kind and where it is, with the gate card's verdict. */
function needRow(index: GraphIndex, id: string, g: { tier: GateTier; words: string; loc?: string }): TourClause {
  const card = gateCard(index, id);
  const kind = t(index.byId.get(id)?.kind === 'rule' ? 'ask.kind.rule' : 'ask.kind.guard');
  return line('need', 'ask.row.need', { words: bare(g.words), kind, at: g.loc ?? '' }, [id], { tier: g.tier, ...(card ? { evidence: card.verdict } : {}), bizKey: 'ask.biz.row.need', bizVars: { words: holeWords(bare(g.words)), kind } });
}

/** An action's name for a sentence: its label's first clause, without its code. */
const actionName = (c: Cand, index: GraphIndex) => bare((String(c.kind === 'action' || c.kind === 'screen' ? c.names[0]! : index.byId.get(c.id)?.name ?? c.id)
  .replace(/\s*\([^()]*`[^()]*\)/g, '').replace(/\s*\((?:[A-Z]{2,6}-\d[^()]*|drives [^()]*)\)/g, '').split(/\s+[—–]\s+|;\s/)[0] ?? '').replace(/\s{2,}/g, ' '));

function answerWho(index: GraphIndex, question: string, term: string, opts: { repo?: string }, role?: string): AskAnswer {
  const a = emptyAnswer(question, 'who');
  // *which roles can do which actions*: the whole table, each action with the roles its role check is handed
  if ((/\b(?:which|what|each|every|all|any)\b/i.test(term) && /\b(?:actions?|things?|operations?)\b/i.test(term)) || /^do\s+what$/i.test(term.trim())) return whoTable(index, a, opts.repo);
  const R = resolveAction(index, term, opts.repo);
  // no action by its words: a verb that names a status (*open an invoice* → open) is the action that writes it
  let viaStatus: Cand | undefined;
  if (!R.best) {
    const vr = verbRecord(index, term, opts.repo, { named: true });
    const tr = vr?.status ? vr.table.lifecycle!.transitions.find((x) => x.to === vr.status) : undefined;
    const w = tr ? index.byId.get(tr.by) : undefined;
    if (w) viaStatus = { id: w.id, kind: w.kind, names: [humanizeName(w.name.split(': ')[0] ?? w.name)] };
  }
  const RT = R.best || viaStatus ? undefined : resolveTermAll(index, term, ['action', 'route', 'screen', 'function'], opts.repo);
  // a record is not an action: *who may* never answers with the checks on every call that touches a table
  const c = R.best ?? viaStatus ?? (RT?.best && RT.best.kind !== 'table' ? RT.best : undefined);
  if (!c) return notFound(index, a, term, opts.repo);
  const name = actionName(c, index);
  a.resolved.push({ term, id: c.id, name });
  const picked = pickedLine(index, c, R.best ? R.others : RT?.others ?? []);
  if (picked) a.lead.push(picked);
  const rows = rolesForAction(index, c, opts.repo);
  const roles = [...new Set(rows.flatMap((r) => r.roles))];
  if (rows.length) {
    a.lead.push(line('who', 'ask.who.head', { action: name, roles: roles.join(', ') }, [...rows.map((r) => r.guard), c.id],
      { bizKey: 'ask.biz.who.head', bizVars: { action: name, roles: roles.map(roleWord).join(', ') } }));
    if (role) {
      const yes = roles.includes(role);
      a.lead.push(line('who', yes ? 'ask.who.yes' : 'ask.who.no', { role, action: name, roles: roles.join(', ') }, rows.map((r) => r.guard),
        { bizVars: { role: roleWord(role), action: name, roles: roles.map(roleWord).join(', ') } }));
    }
    a.sections.push({ key: 'ask.sec.roles', rows: rows.map((r) => {
      const g = index.byId.get(r.guard);
      const card = gateCard(index, r.guard);
      return line('need', 'ask.who.row', { roles: r.roles.join(', '), guard: (g?.name ?? r.guard).split(': ')[0]!, at: locOf(g) || locOf(index.byId.get(r.target)), from: r.from ?? t('ask.who.literal') }, [r.guard, r.target],
        { ...(card ? { evidence: card.verdict } : {}), bizKey: 'ask.biz.who.row', bizVars: { roles: r.roles.map(roleWord).join(', ') } });
    }) });
    a.doors.push({ kind: 'gate', node: rows[0]!.guard });
  } else {
    a.lead.push(line('who', 'ask.who.none', { action: name }, [c.id], { bizVars: { action: name } }));
    if (role) a.lead.push(line('who', 'ask.who.unknownRole', { role, action: name }, [c.id], { bizVars: { role: roleWord(role), action: name } }));
  }
  // the other checks on the same action: what must be true besides the role
  const { gates, moments } = checksOf(index, c);
  const roleGuards = new Set(rows.map((r) => r.guard));
  const rest = [...gates].filter(([id]) => !roleGuards.has(id));
  if (rest.length) {
    const order: GateTier[] = ['business', 'policy', 'technical'];
    a.sections.push({ key: 'ask.sec.alsoChecked', rows: order.flatMap((tier) => rest.filter(([, g]) => g.tier === tier).map(([id, g]) => needRow(index, id, g))) });
  }
  const m0 = moments[0];
  if (m0) a.doors.push({ kind: 'map', flowId: m0.flowId, screen: m0.sg.index + 1, ...(c.kind === 'screen' ? {} : { action: actionOrdinal(m0.sg, m0.mo) }) });
  return a;
}

/** Every action a role check guards, each with the roles its call site hands the check — the role × action table. */
function whoTable(index: GraphIndex, a: AskAnswer, repo?: string): AskAnswer {
  // the role × action table (core roles.ts) when the code lists roles in constants; else the literal arguments
  const table = roleTable(index, repo ? { repo } : {});
  const read = table.rows.filter((r) => r.rolesRead);
  if (read.length) {
    const c = table.counted.actions;
    a.lead.push(line('who', 'ask.who.table', { count: countWords(c) }, read.slice(0, 12).map((r) => r.action.id), { counted: c, bizVars: { count: countWords(c, true) } }));
    a.sections.push({ key: 'ask.sec.roles', rows: read.slice().sort((x, y) => x.words.localeCompare(y.words)).map((r) =>
      line('who', 'ask.who.tableRow', { action: r.words, roles: r.roles.join(', ') }, [r.action.id, r.guard.id], { bizVars: { action: r.words, roles: r.roles.map(roleWord).join(', ') } })) });
    return a;
  }
  const rows = allRoleRows(index, repo);
  const routes = rows.filter((r) => index.byId.get(r.target)?.kind === 'route');
  const use = routes.length ? routes : rows;
  const byTarget = new Map<string, RoleRow[]>();
  for (const r of use) byTarget.set(r.target, [...(byTarget.get(r.target) ?? []), r]);
  if (!byTarget.size) { a.lead.push(line('who', 'ask.who.tableNone', {}, [])); return a; }
  const label = new Map<string, string>();
  for (const c of pool(index)) if (c.kind === 'action' && !label.has(c.id)) label.set(c.id, actionName(c, index));
  const c = counted(byTarget.size, 'count.unit.roleActions', 'count.scope.workspace', `${SRC} → allRoleRows (guards edges handed a literal role at the call), one per call`, { bizUnit: 'count.unit.roleActions' });
  a.lead.push(line('who', 'ask.who.table', { count: countWords(c) }, [...byTarget.keys()].slice(0, 12), { counted: c, bizVars: { count: countWords(c, true) } }));
  a.sections.push({ key: 'ask.sec.roles', rows: [...byTarget].sort((x, y) => (label.get(x[0]) ?? x[0]).localeCompare(label.get(y[0]) ?? y[0])).map(([target, rs]) => {
    const roles = [...new Set(rs.flatMap((r) => r.roles))];
    const action = label.get(target) ?? nodeRef(index, target).words;
    return line('who', 'ask.who.tableRow', { action, roles: roles.join(', ') }, [target, ...rs.map((r) => r.guard)], { bizVars: { action, roles: roles.map(roleWord).join(', ') } });
  }) });
  return a;
}

// ── can <thing> be configured ─────────────────────────────────────────────────────────────────────────────

/** Words that ask about configuring, never name the thing configured. */
const CONFIG_WORDS = new Set(['configure', 'configured', 'configurable', 'configuration', 'change', 'changed', 'setting', 'settings', 'set', 'up', 'thing', 'things', 'option', 'options', 'value', 'values', 'customise', 'customize', 'where', 'today']);

/** A setting's file: a config, settings or env folder or file. */
const SETTING_PATH = /(?:^|\/)(?:config|configs|configuration|settings|env)(?:\/|\.[a-z]+$)/i;

/**
 * What configures a thing, as the code says it: the checks on the settings the app was started with (config checks:
 * they read the environment), the switches in the code (a call under a constant flag, `meta.when.flag` — the `moves`
 * lane's), the settings the code reads from a config file, and the screens whose name says they set something up.
 * Each kept when its words meet the thing's (every one when the question names no thing). Nothing found is said
 * with the absence word, scoped to this question — never *it cannot be configured*.
 */
function answerConfigure(index: GraphIndex, question: string, thing: string, repo?: string): AskAnswer {
  const a = emptyAnswer(question, 'configure');
  // the thing's own words, the record it is *on* left out when there is more (*requirements on an invoice* → requirements)
  const own = contentWords(thing).filter((w) => !CONFIG_WORDS.has(w)).map(wordKey).filter((k) => k.length > 2);
  const recordKeys = new Set<string>();
  for (const n of index.byId.values()) if (n.kind === 'table') for (const k of keysOf(recordWord(n.name))) recordKeys.add(k);
  const focus = own.filter((k) => !recordKeys.has(k));
  const words = focus.length ? focus : own;
  const name = thing.replace(/^(?:a|an|the)\s+/i, '').trim();
  const meets = (text: string) => !words.length || words.some((w) => keysOf(text).has(w));
  const found: TourClause[] = [];
  const seen = new Set<string>();
  for (const n of index.byId.values()) {
    if (repo && !n.id.startsWith(`${repo}::`)) continue;
    const text = [n.name, n.facets?.business?.label, n.facets?.business?.description, n.loc?.path].filter(Boolean).join(' ');
    if (isConfigCheck(n) && meets(text)) {
      seen.add(n.id);
      found.push(line('data', 'ask.configure.check', { name: (n.name.split(': ')[0] ?? n.name), at: locOf(n) }, [n.id], { bizKey: 'ask.biz.configure.check', bizVars: { name: wordsOf(n) } }));
    } else if ((n.kind === 'page' || n.kind === 'flow') && /\b(?:settings?|configur\w*|set\s*up|admin)\b/i.test(`${n.name} ${n.design?.name ?? ''}`) && meets(text)) {
      seen.add(n.id);
      found.push(line('data', 'ask.configure.screen', { name: n.design?.name ?? n.name }, [n.id], { bizVars: { name: n.design?.name ?? wordsOf(n) } }));
    } else if ((n.kind === 'rule' || n.kind === 'function') && n.loc && (SETTING_PATH.test(n.loc.path) || n.tags.includes('env-schema')) && meets(text)) {
      seen.add(n.id);
      found.push(line('data', 'ask.configure.setting', { name: n.name, at: locOf(n) }, [n.id], { bizKey: 'ask.biz.configure.setting', bizVars: { name: wordsOf(n) } }));
    }
  }
  // a record column the words name (*requirements* → `campaigns.document_requirements`): kept as data, one value per record
  const colKeys = words.filter((k) => k.length > 3);
  if (colKeys.length && focus.length) for (const n of index.byId.values()) {
    if (n.kind !== 'table' || (repo && !n.id.startsWith(`${repo}::`))) continue;
    const cols = /^columns:\s*(.+)$/.exec(n.signature ?? '')?.[1]?.split(/\s*,\s*/) ?? [];
    for (const col of cols) {
      if (/^(?:id|created_at|updated_at)$|_ids?$/.test(col) || !colKeys.some((k) => keysOf(col).has(k))) continue;
      const record = recordWord(n.name);
      found.push(line('data', 'ask.configure.column', { record, column: col, table: n.name }, [n.id], { bizKey: 'ask.biz.configure.column', bizVars: { record, column: humanizeName(col).toLowerCase() } }));
    }
  }
  // switches: a call the code makes only when a constant flag says so (`meta.when`, written by the moves lane's parser pass)
  const flags = new Map<string, { value: unknown; to: string[] }>();
  for (const list of index.out.values()) for (const e of list) {
    const when = e.meta?.when as { flag?: string; value?: unknown } | undefined;
    if (!when?.flag || (repo && !e.from.startsWith(`${repo}::`))) continue;
    const to = index.byId.get(e.to);
    if (!meets(`${when.flag} ${to?.name ?? ''} ${to?.facets?.business?.label ?? ''}`)) continue;
    const f = flags.get(when.flag) ?? { value: when.value, to: [] };
    f.to.push(e.to);
    flags.set(when.flag, f);
  }
  for (const [flag, f] of flags) {
    found.push(line('data', 'ask.configure.switch', { name: flag, value: String(f.value), to: f.to.slice(0, 3).map((id) => index.byId.get(id)?.name ?? id).join(', ') }, f.to.slice(0, 3),
      { bizKey: 'ask.biz.configure.switch', bizVars: { name: flag, to: f.to.slice(0, 3).map((id) => nodeRef(index, id).words).join(', ') } }));
  }
  if (!found.length) {
    a.lead.push(line('words', 'ask.configure.none', { thing: name }, [], { bizVars: { thing: name } }));
    const sug = [...suggestQuestions(index, thing, repo), ...(resolveAction(index, thing, repo).best || resolveTerm(index, thing, ['action', 'route', 'screen'], repo) ? [fillWords(t('ask.suggest.guards'), { term: name })] : [])];
    if (sug.length) a.suggest = [...new Set(sug)].slice(0, 3);
    return a;
  }
  const c = counted(found.length, 'ask.unit.configures', 'count.scope.question', `${SRC} → answerConfigure (config checks · settings files · settings screens · switches whose words meet the question's)`, { bizUnit: 'ask.unit.configures' });
  a.lead.push(line('data', own.length ? 'ask.configure.head' : 'ask.configure.headAll', { thing: name, count: countWords(c) }, found.flatMap((x) => x.cites).slice(0, 6), { counted: c, bizVars: { thing: name, count: countWords(c, true) } }));
  a.sections.push({ key: 'ask.sec.configures', rows: found.slice(0, 12) });
  return a;
}

// ── what happens when <record> is <status> · what happens when <action> ───────────────────────────────────────

/** The screens whose walk reaches a record, each once, the journeys' order. */
function screensReaching(index: GraphIndex, tableId: string): { id: string; name: string }[] {
  const out = new Map<string, string>();
  for (const m of momentsOf(index, { id: tableId, kind: 'table', names: [] })) if (m.sg.screen && !out.has(m.sg.screen.id)) out.set(m.sg.screen.id, m.sg.screen.name);
  return [...out].map(([id, name]) => ({ id, name }));
}

/** The writer of one move, where it runs, as two lines. */
function moveLines(index: GraphIndex, opts: { metas?: Record<string, JourneysMeta>; repo?: string }, table: GraphNode, tr: { to: string; by: string; line?: number }, key: string): TourClause[] {
  const writer = index.byId.get(tr.by);
  const writerName = writer?.name ?? tr.by.split('::').pop() ?? tr.by;
  const rec = recordWord(table.name);
  const to = norm(humanizeName(tr.to));
  const out = [line('move', key, { record: rec, to, writer: writerName, at: locOf(writer, tr.line) || tr.by }, [tr.by, table.id], { bizKey: `ask.biz.${key.slice(4)}`, bizVars: { record: rec, to } })];
  const p = placesOf(index, opts.metas, table.id, tr.to, tr.by, opts.repo)[0];
  if (p) {
    const persona = p.persona ?? p.flowName;
    out.push(line('who', 'ask.happens.where', { persona, action: bare(p.mo.label), screen: p.sg.screen!.name, journey: p.flowName },
      [p.mo.preconditions?.action || tr.by, p.sg.screen!.id, p.flowId], { bizVars: { persona, action: bare(p.mo.label), screen: p.sg.screen!.name, journey: p.flowName } }));
  }
  return out;
}

function readersLine(index: GraphIndex, table: GraphNode): TourClause | undefined {
  const screens = screensReaching(index, table.id);
  if (!screens.length) return undefined;
  const c = counted(screens.length, 'ask.unit.screensReach', 'count.scope.node', `${SRC} → momentsOf(record) (the screens whose walk reaches the record, each once)`, { bizUnit: 'ask.unit.screensReach' });
  const list = screens.slice(0, 6).map((x) => x.name).join(' · ') + (screens.length > 6 ? ` · +${screens.length - 6}` : '');
  return line('data', 'ask.happens.readers', { record: recordWord(table.name), count: countWords(c), screens: list }, [table.id, ...screens.slice(0, 6).map((x) => x.id)], { counted: c, bizVars: { record: recordWord(table.name), count: countWords(c, true), screens: list } });
}

function answerHappens(index: GraphIndex, question: string, term: string, opts: { metas?: Record<string, JourneysMeta>; repo?: string }): AskAnswer | null {
  // *what happens … if Business Central is unavailable*: a condition the code holds no status for is not this shape
  if (/\b(?:if|unless|while|in\s+case)\b/i.test(term)) return null;
  const a = emptyAnswer(question, 'happens');
  const vr = verbRecord(index, term, opts.repo);
  if (vr?.status) {
    const table = vr.table;
    const rec = recordWord(table.name);
    a.resolved.push({ term, id: table.id, name: table.name });
    const status = vr.status;
    const lc = table.lifecycle!;
    const out = lc.transitions.filter((x) => x.from === status || x.fromAny?.includes(status));
    const any = lc.transitions.filter((x) => !x.from && !x.fromAny?.length && x.to !== status);
    const word = norm(humanizeName(status));
    if (!out.length) a.lead.push(line('move', 'ask.happens.stays', { record: rec, status: word }, [table.id], { bizVars: { record: rec, status: word } }));
    else a.lead.push(line('move', 'ask.happens.head', { record: rec, status: word }, [table.id], { bizVars: { record: rec, status: word } }));
    const rows: TourClause[] = [];
    for (const tr of out.slice(0, 4)) rows.push(...moveLines(index, opts, table, tr, 'ask.happens.move'));
    for (const tr of any.slice(0, 3)) rows.push(...moveLines(index, opts, table, tr, 'ask.happens.moveAny'));
    if (rows.length) a.sections.push({ key: 'ask.sec.next', rows });
    const readers = readersLine(index, table);
    if (readers) a.sections.push({ key: 'ask.sec.seen', rows: [readers] });
    return a;
  }
  // no status the words name: the action they name, and what it does to the records
  const R = resolveAction(index, term, opts.repo);
  const c = R.best;
  if (!c) return notFound(index, a, clause(term), opts.repo, vr ? [vr.table.id] : []);
  const name = actionName(c, index);
  a.resolved.push({ term, id: c.id, name });
  const picked = pickedLine(index, c, R.others);
  if (picked) a.lead.push(picked);
  const parts = partsOf(index, c);
  const rows: TourClause[] = [];
  const records = new Map<string, GraphNode>();
  for (const id of parts) for (const e of index.out.get(id) ?? []) {
    if (e.kind !== 'writes') continue;
    const tb = index.byId.get(e.to);
    if (tb?.kind === 'table') records.set(tb.id, tb);
  }
  for (const tb of index.byId.values()) {
    if (tb.kind !== 'table' || !tb.lifecycle) continue;
    for (const tr of tb.lifecycle.transitions) if (parts.has(tr.by)) { records.set(tb.id, tb); rows.push(...moveLines(index, opts, tb, tr, 'ask.happens.move').slice(0, 1)); }
  }
  for (const tb of records.values()) {
    if (rows.some((r) => r.cites.includes(tb.id))) continue;
    rows.push(line('data', 'ask.happens.writes', { record: recordWord(tb.name) }, [tb.id, c.id], { bizVars: { record: recordWord(tb.name) } }));
  }
  if (!rows.length) { a.lead.push(line('data', 'ask.happens.nothing', { action: name }, [c.id], { bizVars: { action: name } })); return a; }
  a.lead.push(line('move', 'ask.happens.action', { action: name }, [c.id], { bizVars: { action: name } }));
  a.sections.push({ key: 'ask.sec.next', rows });
  const seenRows = [...records.values()].map((tb) => readersLine(index, tb)).filter((x): x is TourClause => !!x);
  if (seenRows.length) a.sections.push({ key: 'ask.sec.seen', rows: seenRows });
  const m0 = momentsOf(index, c)[0];
  if (m0) a.doors.push({ kind: 'map', flowId: m0.flowId, screen: m0.sg.index + 1, action: actionOrdinal(m0.sg, m0.mo) });
  return a;
}

// ── where is <record> set to <status> ─────────────────────────────────────────────────────────────────────

/** The record and status a question names: the status after *to* / *become* first, the longest word otherwise. */
function recordAndStatus(index: GraphIndex, q: string, repo?: string): { table: GraphNode; status: string; unnamed?: true } | { table: GraphNode; missing: string } | { term: string } | null {
  const l = ` ${norm(q)} `;
  const tables = [...index.byId.values()].filter((n) => n.kind === 'table' && n.lifecycle?.statuses.length && (!repo || n.id.startsWith(`${repo}::`)));
  if (!tables.length) return null;
  const has = (w: string) => !!w && l.includes(` ${norm(w)} `);
  // the record: a table whose name in words the question uses (the longest wins: "contact vendor link" over "link")
  const named = tables.map((n) => ({ n, w: [recordWord(n.name), norm(n.name), norm(humanizeName(n.name))].filter(has).sort((a, b) => b.length - a.length)[0] }))
    .filter((x) => x.w).sort((a, b) => b.w!.length - a.w!.length);
  const statusIn = (n: GraphNode): { status: string; at: number; len: number } | undefined => {
    const life = n.lifecycle!;
    const words = new Map<string, string>();
    for (const s of life.statuses) { words.set(norm(s), s); words.set(norm(humanizeName(s)), s); }
    for (const v of lifecycleViews(index, n, { personas: Object.keys(life.names?.views ?? {}).map((id) => ({ id, name: id })) })) for (const r of v.rows) words.set(norm(r.word), r.status);
    let best: { status: string; at: number; len: number } | undefined;
    for (const [w, s] of words) {
      if (!w) continue;
      const at = l.lastIndexOf(` ${w} `);
      if (at < 0) continue;
      if (!best || w.length > best.len || (w.length === best.len && at > best.at)) best = { status: s, at, len: w.length };
    }
    return best;
  };
  for (const { n } of named) {
    const st = statusIn(n);
    if (st) return { table: n, status: st.status };
  }
  if (named.length) {
    const after = /\b(?:to|become|becomes|as)\s+([a-z][\w -]*?)(?:\s*(?:,|\band\b|$))/i.exec(q);
    return { table: named[0]!.n, missing: (after?.[1] ?? '').trim() || q };
  }
  // no record named: a status only one record declares
  const withStatus = tables.map((n) => ({ n, st: statusIn(n) })).filter((x) => x.st);
  if (withStatus.length === 1) return { table: withStatus[0]!.n, status: withStatus[0]!.st!.status, unnamed: true };
  const term = /\b(?:is|are|does|do)\s+(?:an?\s+|the\s+)?(.+?)\s+(?:set|moved?|made|marked|become|becomes|put)\b/i.exec(q)?.[1];
  return term ? { term } : null;
}

/** Every place a journey's walk makes the move (or reaches its writer), storyline flows first. */
function placesOf(index: GraphIndex, metas: Record<string, JourneysMeta> | undefined, table: string, to: string, by: string, repo?: string) {
  const tree = journeyTree(index, metas, repo ? new Set([repo]) : null);
  const order: string[] = [];
  for (const st of tree.storylines) for (const r of [...st.journeys, ...(st.branches ?? [])]) if (!order.includes(r.nodeId)) order.push(r.nodeId);
  const rows = tree.personas.flatMap((p) => p.groups.flatMap((g) => g.journeys));
  for (const r of rows) if (!order.includes(r.nodeId)) order.push(r.nodeId);
  for (const n of index.byId.values()) if (n.kind === 'flow' && !order.includes(n.id) && (!repo || n.id.startsWith(`${repo}::`))) order.push(n.id);
  const out: { flowId: string; flowName: string; persona?: string; personaId?: string; sg: JourneySegment; mo: JourneyMoment }[] = [];
  const fallback: typeof out = [];
  for (const id of order) {
    const w = flowSummary(index, id);
    if (!w) continue;
    const row = rows.find((r) => r.nodeId === id);
    const flowName = row?.name ?? index.byId.get(id)?.design?.name ?? index.byId.get(id)?.name ?? id;
    const persona = row?.personaNames?.[0];
    const personaId = row?.personaIds?.[0];
    for (const sg of w.sum.segments) {
      if (!sg.screen) continue;
      // who uses this screen: the screen's own persona first, then a persona's routes, its sign-in guard, the journey's (#105)
      const sp = personaOfScreen(index, metas, sg.screen.id, id);
      const who = sp ? { persona: sp.personaName, personaId: sp.persona } : { ...(persona ? { persona } : {}), ...(personaId ? { personaId } : {}) };
      for (const mo of rankOrder(sg)) {
        const place = { flowId: id, flowName, ...who, sg, mo };
        if (mo.preconditions?.moves.some((m) => m.table === table && m.to === to && m.by === by)) out.push(place);
        else if (!fallback.length && w.j.steps.some((s) => s.nodeId === by && s.order >= mo.from && s.order <= mo.to)) fallback.push(place);
      }
    }
  }
  return out.length ? out : fallback;
}

function caseRows(tests: CoverageTestRef[], cap = 8): TourClause[] {
  const list = tests.filter((x) => !x.runLevel).slice(0, cap);
  return list.map((x) => {
    const status = x.status && ['passed', 'failed', 'skipped', 'flaky'].includes(x.status) ? t(`count.part.${x.status}`).replace('{n}', '').trim() : x.status ? x.status : t('ask.row.noRun');
    const when = x.at ? x.at.slice(0, 10) : '';
    const at = x.loc ? `${x.loc.path}:${x.loc.line}` : '';
    return at
      ? line('verdict', 'ask.row.caseFile', { name: x.name, at, status, when }, [x.id], { bizKey: 'ask.biz.row.case', bizVars: { name: x.name, status, when } })
      : line('verdict', 'ask.row.case', { name: x.name, status, when }, [x.id], { bizKey: 'ask.biz.row.case' });
  });
}

function verdictRow(v: TestVerdict, cites: string[]): TourClause {
  return line('verdict', 'ask.row.verdict', verdictVars(v), cites, { evidence: v, counted: v.runs, bizKey: 'ask.biz.row.verdict', bizVars: verdictVars(v, true) });
}

function answerSet(index: GraphIndex, question: string, opts: { metas?: Record<string, JourneysMeta>; repo?: string }): AskAnswer | null {
  const hit = recordAndStatus(index, question, opts.repo);
  if (!hit) return null;
  const a = emptyAnswer(question, 'set');
  if ('term' in hit) { a.lead.push(line('words', 'ask.set.noRecord', { term: hit.term }, [])); return a; }
  const table = hit.table;
  const rec = recordWord(table.name);
  a.resolved.push({ term: rec, id: table.id, name: table.name });
  if ('missing' in hit) {
    a.lead.push(line('words', 'ask.set.unknownStatus', { record: rec, status: hit.missing }, [table.id]));
    return a;
  }
  const status = hit.status;
  // the question named no record: the status alone picked it — said, like any other reading (outsider round, F7)
  if (hit.unnamed) LOOSE.add(a);
    const writes = table.lifecycle!.transitions.filter((x) => x.to === status);
  if (!writes.length) { a.lead.push(line('words', 'ask.set.noStatus', { record: rec, status }, [table.id])); return a; }
  let first = true;
  for (const tr of writes.slice(0, 3)) {
    const writer = index.byId.get(tr.by);
    const writerName = writer?.name ?? tr.by.split('::').pop() ?? tr.by;
    const at = locOf(writer, tr.line) || tr.by;
    const places = placesOf(index, opts.metas, table.id, status, tr.by, opts.repo);
    const p = places[0];
    const word = lifecycleViews(index, table, p?.personaId ? { personas: [{ id: p.personaId, name: p.persona ?? p.personaId }] } : {})[0]?.rows.find((r) => r.status === status)?.word ?? humanizeName(status);
    a.lead.push(line('move', 'ask.set.writer', { status, writer: writerName, at }, [tr.by, table.id], { bizKey: 'ask.biz.set.writer', bizVars: { status: word } }));
    if (!p) { a.lead.push(line('who', 'ask.set.whereNone', { writer: writerName }, [tr.by])); continue; }
    const sc = p.sg.screen!;
    const actNode = p.mo.preconditions?.action || tr.by;
    const persona = p.persona ?? p.flowName;
    const ordinal = actionOrdinal(p.sg, p.mo);
    a.lead.push(line('who', 'ask.set.where', { persona, action: bare(p.mo.label), screen: sc.name, screenN: String(p.sg.index + 1), actionN: String(ordinal), journey: p.flowName },
      [actNode, sc.id, p.flowId], { bizKey: 'ask.biz.set.where', bizVars: { persona, action: bare(p.mo.label), screen: sc.name, journey: p.flowName } }));
    if (places.length > 1) {
      const c = counted(places.length - 1, 'count.unit.places', 'count.scope.node', `${SRC} → the actions whose walk makes this move, after the first`);
      a.lead.push(line('who', 'ask.set.also', { count: countWords(c) }, places.slice(1).map((x) => x.mo.preconditions?.action || x.flowId), { counted: c }));
    }
    if (!first) continue;
    first = false;
    a.doors.push({ kind: 'map', flowId: p.flowId, screen: p.sg.index + 1, action: ordinal });
    // must be true first: the move's own check, the checks that matter, the decisions, the technical ones counted
    const must: TourClause[] = [];
    const mv = p.mo.preconditions?.moves.find((m) => m.table === table.id && m.to === status && m.by === tr.by);
    const from = mv?.from ?? mv?.fromAny?.join(' or ') ?? tr.from ?? tr.fromAny?.join(' or ');
    if (mv?.creates) { /* a creation has nothing to move from: no row */ }
    else if (mv ? mv.checked : from) must.push(line('check', 'ask.row.checked', { record: rec, from: from ?? '' }, [tr.by], { bizKey: 'ask.biz.row.checked', bizVars: { record: rec, from: fromWords(index, table, from, p.personaId ? { id: p.personaId, name: p.persona ?? p.personaId } : undefined) } }));
    else must.push(line('check', 'ask.row.unchecked', { record: rec, writer: writerName }, [tr.by], { warn: true, bizKey: 'ask.biz.row.unchecked', bizVars: { record: rec } }));
    const tech: string[] = [];
    let gateDoor: string | undefined;
    for (const pre of p.mo.preconditions?.preconditions ?? []) {
      if (pre.planned) continue;
      if (pre.tier === 'technical') { tech.push(pre.id); continue; }
      const card = gateCard(index, pre.id);
      const kind = t(index.byId.get(pre.id)?.kind === 'rule' ? 'ask.kind.rule' : 'ask.kind.guard');
      gateDoor ??= pre.id;
      must.push(line('need', 'ask.row.need', { words: bare(pre.words), kind, at: pre.loc ?? '' }, [pre.id],
        { tier: pre.tier, ...(card ? { evidence: card.verdict } : {}), bizKey: 'ask.biz.row.need', bizVars: { words: holeWords(bare(pre.words)), kind } }));
    }
    const w = flowSummary(index, p.flowId);
    for (const d of w?.sum.segments[p.sg.index]?.decisions ?? []) {
      if (d.class !== 'business' || d.stepOrder < p.mo.from || d.stepOrder > p.mo.to) continue;
      const dn = index.byId.get(d.nodeId);
      must.push(line('decision', 'ask.row.decision', { label: d.label, at: dn?.loc ? `${dn.loc.path}:${d.line}` : '' }, [d.nodeId], { bizKey: 'ask.biz.row.decision' }));
    }
    if (tech.length) {
      const c = counted(tech.length, 'count.unit.gatesTechnical', 'count.scope.action', `${SRC} → segments[${p.sg.index}].moments[${p.mo.index}].preconditions (tier technical)`, { bizUnit: 'count.unit.gatesTechnical' });
      must.push(line('technical', 'ask.row.technical', { count: countWords(c) }, tech, { counted: c }));
    }
    a.sections.push({ key: 'ask.sec.must', rows: must });
    if (gateDoor) a.doors.unshift({ kind: 'gate', node: gateDoor });
    // proven by: the cases that reach the writer, under the one verdict, scoped to the writer alone
    const proof = stepCoverage(index, tr.by);
    const proven: TourClause[] = [];
    if (proof?.verdict && proof.verdict.runs.n) {
      proven.push(verdictRow(proof.verdict, [tr.by]));
      proven.push(...caseRows(proof.tests));
      a.doors.push({ kind: 'cases', node: tr.by });
    } else proven.push(line('verdict', 'tour.noTests', { what: writerName }, [tr.by], { bizVars: { what: t('tour.biz.theMove') } }));
    a.sections.push({ key: 'ask.sec.proven', rows: proven });
    // the path: how the screen reaches the record
    const path = pathBetween(index, sc.id, table.id);
    if (path) {
      a.path = path;
      a.sections.push({ key: 'ask.sec.path', rows: [pathLine(index, path)] });
    }
  }
  return a;
}

/** The chain as one line: names joined by arrows, the link count with its scope. */
function pathLine(index: GraphIndex, p: PathResult): TourClause {
  const name = (id: string) => { const n = index.byId.get(id); return n?.kind === 'page' || n?.kind === 'flow' ? n.design?.name ?? n.name : n?.name ?? id; };
  const words = (id: string) => nodeRef(index, id).words;
  const from = p.reverse ? p.to : p.from;
  const to = p.reverse ? p.from : p.to;
  return line('data', p.reverse ? 'ask.path.reverse' : 'ask.path.head', { from: name(from), to: name(to), count: countWords(p.counted), chain: p.nodes.map(name).join(' → ') }, p.nodes,
    { counted: p.counted, ...(p.reverse ? {} : { bizKey: 'ask.biz.path.head' }), bizVars: { from: words(from), to: words(to), count: countWords(p.counted, true), chain: p.nodes.map(words).join(' → ') } });
}

// ── how does <A> reach <B> ──────────────────────────────────────────────────────────────────────────────

function answerPath(index: GraphIndex, question: string, ta: string, tb: string, repo?: string): AskAnswer {
  const a = emptyAnswer(question, 'path');
  const RA = resolveTermAll(index, ta, ['screen', 'action', 'page', 'component', 'route', 'function'], repo);
  const RB = resolveTermAll(index, tb, ['table', 'route', 'function', 'screen', 'action'], repo);
  const A = RA.best;
  const B = RB.best;
  if (!A || !B) return notFound(index, a, !A ? ta : tb, repo, [A?.id ?? B?.id]);
  for (const [best, others] of [[A, RA.others], [B, RB.others]] as const) { const p = pickedLine(index, best, others); if (p) a.lead.push(p); }
  a.resolved.push({ term: ta, id: A.id, name: index.byId.get(A.id)?.name ?? A.id }, { term: tb, id: B.id, name: index.byId.get(B.id)?.name ?? B.id });
  const fwd = pathBetween(index, A.id, B.id);
  const p = fwd ?? (() => { const r = pathBetween(index, B.id, A.id); return r ? { ...r, reverse: true as const } : null; })();
  if (!p) {
    const nm = (id: string) => index.byId.get(id)?.name ?? id;
    a.lead.push(line('data', 'ask.path.none', { from: nm(A.id), to: nm(B.id) }, [A.id, B.id], { bizVars: { from: nodeRef(index, A.id).words, to: nodeRef(index, B.id).words } }));
    return a;
  }
  a.path = p;
  a.lead.push(pathLine(index, p));
  a.sections.push({ key: 'ask.sec.path', rows: p.hops.map((h) => line('data', 'ask.path.hop', { from: index.byId.get(h.from)?.name ?? h.from, via: t(`ask.path.via.${h.kind}`), to: index.byId.get(h.to)?.name ?? h.to }, [h.from, h.to],
    { bizVars: { from: nodeRef(index, h.from).words, via: t(`ask.path.via.${h.kind}`), to: nodeRef(index, h.to).words } })) });
  if (p.more) {
    const c = counted(p.more, 'count.unit.paths', 'count.scope.path', 'core ask.ts pathBetween → more (other chains of the same length, capped at 9)');
    a.lead.push(line('data', 'ask.path.more', { count: countWords(c) }, [p.from, p.to], { counted: c }));
  }
  return a;
}

// ── what guards <x> ─────────────────────────────────────────────────────────────────────────────────────

/** The moments a target names: an action's own, a call's, a screen's, else the moments whose walk reaches it. */
function momentsOf(index: GraphIndex, c: Cand): { flowId: string; sg: JourneySegment; mo: JourneyMoment }[] {
  const out: { flowId: string; sg: JourneySegment; mo: JourneyMoment }[] = [];
  for (const f of index.byId.values()) {
    if (f.kind !== 'flow') continue;
    const w = flowSummary(index, f.id);
    if (!w) continue;
    for (const sg of w.sum.segments) for (const mo of sg.moments) {
      const call = mo.preconditions?.action || w.j.steps.find((s) => s.order === (mo.callStep ?? mo.actionStep))?.nodeId;
      const hit = c.kind === 'screen' ? sg.screen?.id === c.id
        : c.kind === 'action' ? call === c.id && mo.index === c.mo && f.id === c.flowId
          : call === c.id || w.j.steps.some((s) => s.nodeId === c.id && s.order >= mo.from && s.order <= mo.to);
      if (hit) out.push({ flowId: f.id, sg, mo });
    }
    if (c.kind === 'action' && out.length) break;
  }
  return out;
}

function answerGuards(index: GraphIndex, question: string, term: string, repo?: string): AskAnswer {
  const a = emptyAnswer(question, 'guards');
  // a verb and its object (*approve an invoice*) name an action before they name the record (outsider round, F7)
  const RA = verbLed(term) ? resolveAction(index, term, repo) : { others: [], hits: 0, of: 0 };
  const R = RA.best && RA.of >= 2 && RA.hits === RA.of ? { best: RA.best, others: RA.others } : resolveTermAll(index, term, ['action', 'route', 'screen', 'function', 'page'], repo);
  const c = R.best;
  if (!c) return notFound(index, a, term, repo);
  const name = c.kind === 'action' || c.kind === 'screen' ? c.names[0]! : index.byId.get(c.id)?.name ?? c.id;
  a.resolved.push({ term, id: c.id, name });
  const picked = pickedLine(index, c, R.others);
  if (picked) a.lead.push(picked);
  // the gates on its journeys' moments; nothing on a journey names it: the gates on the steps of its own walk
  const { gates, moments } = checksOf(index, c);
  const scope: CountScope = c.kind === 'action' ? 'count.scope.action' : c.kind === 'screen' ? 'journey.scopeHere' : 'count.scope.node';
  const tiers = (k: GateTier) => [...gates.values()].filter((g) => g.tier === k).length;
  const total = counted(gates.size, 'count.unit.checks', scope, `${SRC} → the preconditions of the actions it names (each once)`, {
    bizUnit: 'count.unit.checks',
    breakdown: [{ key: 'count.part.tierBusiness', n: tiers('business') }, { key: 'count.part.tierPolicy', n: tiers('policy') }, { key: 'count.part.tierTechnical', n: tiers('technical') }],
  });
  if (!gates.size) { a.lead.push(line('words', 'ask.guards.none', { name }, [c.id])); return a; }
  a.lead.push(line('words', 'ask.guards.head', { name: bare(name), count: countWords(total) }, [c.id], { counted: total, bizVars: { name: bare(name), count: countWords(total, true) } }));
  const rows: TourClause[] = [];
  const order: GateTier[] = ['business', 'policy', 'technical'];
  for (const tier of order) for (const [id, g] of gates) if (g.tier === tier) rows.push(needRow(index, id, g));
  a.sections.push({ key: 'ask.sec.gates', rows });
  const firstGate = [...gates.keys()][0];
  if (firstGate) a.doors.push({ kind: 'gate', node: firstGate });
  const m0 = moments[0];
  if (m0) a.doors.push({ kind: 'map', flowId: m0.flowId, screen: m0.sg.index + 1, ...(c.kind === 'screen' ? {} : { action: actionOrdinal(m0.sg, m0.mo) }) });
  return a;
}

// ── what proves <x> ─────────────────────────────────────────────────────────────────────────────────────

function answerProves(index: GraphIndex, question: string, term: string, repo?: string): AskAnswer {
  const a = emptyAnswer(question, 'proves');
  const R = resolveTermAll(index, term, ['guard', 'rule', 'screen', 'action', 'route', 'function'], repo);
  const c = R.best;
  if (!c) return notFound(index, a, term, repo);
  const name = c.kind === 'action' || c.kind === 'screen' ? c.names[0]! : index.byId.get(c.id)?.name ?? c.id;
  a.resolved.push({ term, id: c.id, name });
  const picked = pickedLine(index, c, R.others);
  if (picked) a.lead.push(picked);
  let verdict: TestVerdict | undefined;
  let tests: CoverageTestRef[] = [];
  let notBuilt = false;
  if (c.kind === 'guard' || c.kind === 'rule') {
    const card = gateCard(index, c.id);
    if (card) { verdict = card.verdict; tests = card.tests; }
    a.doors.push({ kind: 'gate', node: c.id });
  } else if ((c.kind === 'screen' || c.kind === 'action') && c.flowId && c.seg != null) {
    const w = flowSummary(index, c.flowId);
    const sg = w?.sum.segments[c.seg];
    if (w && sg) {
      if (c.kind === 'screen' && segmentNotBuilt(sg)) notBuilt = true;
      const cell = cellCoverage(index, w.j, w.sum, c.seg, c.kind === 'action' ? sg.moments.findIndex((m) => m.index === c.mo) : undefined);
      if (cell) { verdict = cell.facts.verdict; tests = cell.facts.tests; if (cell.facts.notBuilt) notBuilt = true; }
      const mo = c.kind === 'action' ? sg.moments.find((m) => m.index === c.mo) : undefined;
      a.doors.push({ kind: 'map', flowId: c.flowId, screen: c.seg + 1, ...(mo ? { action: actionOrdinal(sg, mo) } : {}) });
    }
  } else {
    const sc = stepCoverage(index, c.id);
    if (sc?.verdict) { verdict = sc.verdict; tests = sc.tests; }
  }
  if (notBuilt) { a.lead.push(line('verdict', 'ask.proves.notBuilt', { name }, [c.id])); return a; }
  if (!verdict || !verdict.runs.n) { a.lead.push(line('verdict', 'tour.noTests', { what: name }, [c.id])); return a; }
  a.lead.push(line('verdict', 'ask.proves.head', { name, ...verdictVars(verdict) }, [c.id], { evidence: verdict, counted: verdict.runs, bizVars: { name, ...verdictVars(verdict, true) } }));
  a.sections.push({ key: 'ask.sec.cases', rows: caseRows(tests, 12) });
  a.doors.push({ kind: 'cases', node: c.id });
  return a;
}

// ── as text ─────────────────────────────────────────────────────────────────────────────────────────────

/** The answer as lines, for the CLI and MCP: the lead, each section, the doors as calls; citations in backticks. */
export function askLines(a: AskAnswer, opts: { business?: boolean } = {}): string[] {
  const biz = !!opts.business;
  const out: string[] = [];
  const cite = (c: TourClause) => (biz || !c.cites.length ? '' : `  [${c.cites.map((id) => `\`${id}\``).join(', ')}]`);
  const say = (c: TourClause) => `${c.warn ? '⚠ ' : ''}${biz ? c.biz : c.text}${c.role === 'need' && c.evidence ? ` · ${needWord(c.evidence)}${c.evidence.runs.n ? ` (${countWords(c.evidence.runs, biz)} ${t(scopeWord(c.evidence.runs))})` : ''}` : ''}`;
  out.push(`${t('ask.title')} · ${t('ask.derived')}${a.phrased ? ` · ${t('ask.phrased')}` : ''}`);
  out.push(`> ${a.question}`);
  for (const c of a.lead) out.push(`${say(c)}${cite(c)}`);
  if (a.suggest?.length) { out.push(t('ask.didYouMean')); for (const s of a.suggest) out.push(`  · ${s}`); }
  if (a.shapes) for (const s of a.shapes) out.push(`  · ${t(s)}`);
  for (const s of a.sections) {
    out.push('');
    out.push(`## ${t(s.key)}`);
    for (const c of s.rows) out.push(`- ${say(c)}${cite(c)}`);
  }
  if (a.phrased) { out.push(''); out.push(`${t('ask.phrased')}: ${a.phrased.text}`); }
  return out;
}

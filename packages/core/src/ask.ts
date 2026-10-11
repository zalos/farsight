/**
 * Ask, with evidence (round 2026-10-10, proposal 8): **a small grammar, not a model**. Four shapes of question are
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
 *  - `proves` — *what proves <screen | action | gate>*: the cases with their own last runs under the one verdict.
 *
 * A question in no shape is answered with the four shapes (the catalog's words), never a guess. Every line is a
 * catalog template (`strings-ask.ts`) carrying the node ids it cites, and every answer says `derived: true`.
 *
 * **The one extension point for a model**: `opts.phrase(answer)` may return the answer in other words; the answer
 * then carries `phrased: { text, by: 'model' }` beside — never instead of — its cited lines, and every surface
 * prints *phrased by a model* (`ask.phrased`). Nothing in Farsight passes one today.
 */
import type { GraphNode, EdgeKind, JourneysMeta, GateTier } from './graph.js';
import { type GraphIndex, type JourneySegment, type JourneyMoment, humanizeName } from './query.js';
import { journeyTree } from './journeys.js';
import { counted, scopeWord, type Counted, type CountScope } from './counts.js';
import { t as tr, type Register } from './strings.js';

const t = (key: string, reg: Register = 'professional'): string => tr(key, reg);
import { stepCoverage, cellCoverage, segmentNotBuilt, type TestVerdict, type CoverageTestRef } from './coverage.js';
import { gateCard } from './gates.js';
import { gateTierOf } from './gate-class.js';
import { lifecycleViews } from './lifecycle.js';
import {
  flowSummary, rankOrder, actionOrdinal, fillWords, bare, needWord, bizWords, fromWords, wordsOf, recordWord, locOf, countWords, verdictVars, nodeRef,
  type TourClause, type TourNodeRef,
} from './tour.js';

export const ASK_SHAPES = ['set', 'guards', 'path', 'proves'] as const;
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

const norm = (s: string) => String(s).toLowerCase().replace(/[`'"“”‘’?!.,()]/g, ' ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
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
  if (/\b(?:set|sets|moved?|moves|becomes?|made|turn(?:s|ed)?|changed?|goes|marked|put)\b/.test(l) && /\b(?:where|which|what|who|when|how)\b/.test(l)) return { shape: 'set', a: s };
  if ((m = /\b(?:how\s+(?:does|do|can|did)|does)\s+(.+?)\s+(?:reach(?:es)?|get\s+to|lead\s+to|call|calls|touch(?:es)?|connect\s+to|end\s+up\s+(?:in|at)|write\s+to|read)\s+(.+)$/i.exec(s))) return { shape: 'path', a: m[1]!, b: m[2]! };
  if ((m = /\b(?:path|route|way|chain)\s+from\s+(.+?)\s+to\s+(.+)$/i.exec(s))) return { shape: 'path', a: m[1]!, b: m[2]! };
  if ((m = /\bwhat\s+(?:proves|tests|verifies|covers)\s+(.+)$/i.exec(s))) return { shape: 'proves', a: m[1]! };
  if ((m = /\bwhich\s+tests?\s+(?:cover|covers|reach|reaches|check|checks|prove|proves)\s+(.+)$/i.exec(s))) return { shape: 'proves', a: m[1]! };
  if ((m = /\bis\s+(.+?)\s+(?:tested|proven|covered)\b/i.exec(s))) return { shape: 'proves', a: m[1]! };
  if ((m = /\bwhat\s+(?:guards|protects|gates|checks|stops|blocks|is\s+checked\s+(?:on|before|for))\s+(.+)$/i.exec(s))) return { shape: 'guards', a: m[1]! };
  if ((m = /\bwhat\s+must\s+be\s+true\s+(?:before|for|to)\s+(.+)$/i.exec(s))) return { shape: 'guards', a: m[1]! };
  if ((m = /\bwho\s+(?:can|may)\s+(.+)$/i.exec(s))) return { shape: 'guards', a: m[1]! };
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
  const shape = askShapeOf(question);
  // *what must be true before an invoice is approved*: a guards or proves question whose term is a record and one of
  // its statuses is the set shape's question — answering it as an action's checks matched the wrong action (swarm round 3)
  if ((shape?.shape === 'guards' || shape?.shape === 'proves') && /\b(?:is|are|gets?|becomes?|be)\s+\w+\s*$/i.test(shape.a ?? '')) {
    const hit = recordAndStatus(index, shape.a!, opts.repo);
    if (hit && 'status' in hit) {
      const a = answerSet(index, question, opts);
      if (a) return finish(index, a, opts.phrase);
    }
  }
  if (shape?.shape === 'set') {
    const a = answerSet(index, question, opts);
    if (a) return finish(index, a, opts.phrase);
  }
  if (shape?.shape === 'path') return finish(index, answerPath(index, question, shape.a!, shape.b!, opts.repo), opts.phrase);
  if (shape?.shape === 'proves') return finish(index, answerProves(index, question, shape.a!, opts.repo), opts.phrase);
  if (shape?.shape === 'guards') return finish(index, answerGuards(index, question, shape.a!, opts.repo), opts.phrase);
  // a set question with no record the code declares statuses for falls through to the other shapes' words
  const second = shape?.shape === 'set' ? askShapeOfRest(question) : null;
  if (second?.shape === 'path') return finish(index, answerPath(index, question, second.a!, second.b!, opts.repo), opts.phrase);
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

// ── where is <record> set to <status> ─────────────────────────────────────────────────────────────────────

/** The record and status a question names: the status after *to* / *become* first, the longest word otherwise. */
function recordAndStatus(index: GraphIndex, q: string, repo?: string): { table: GraphNode; status: string } | { table: GraphNode; missing: string } | { term: string } | null {
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
  if (withStatus.length === 1) return { table: withStatus[0]!.n, status: withStatus[0]!.st!.status };
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
      for (const mo of rankOrder(sg)) {
        const place = { flowId: id, flowName, ...(persona ? { persona } : {}), ...(personaId ? { personaId } : {}), sg, mo };
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
        { tier: pre.tier, ...(card ? { evidence: card.verdict } : {}), bizKey: 'ask.biz.row.need', bizVars: { words: bare(pre.words), kind } }));
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
  const R = resolveTermAll(index, term, ['action', 'route', 'screen', 'function', 'page'], repo);
  const c = R.best;
  if (!c) return notFound(index, a, term, repo);
  const name = c.kind === 'action' || c.kind === 'screen' ? c.names[0]! : index.byId.get(c.id)?.name ?? c.id;
  a.resolved.push({ term, id: c.id, name });
  const picked = pickedLine(index, c, R.others);
  if (picked) a.lead.push(picked);
  const gates = new Map<string, { tier: GateTier; words: string; loc?: string }>();
  const moments = momentsOf(index, c);
  for (const m of moments) for (const p of m.mo.preconditions?.preconditions ?? []) {
    if (!p.planned && !gates.has(p.id)) gates.set(p.id, { tier: p.tier, words: p.words, ...(p.loc ? { loc: p.loc } : {}) });
  }
  // nothing on a journey names it: the gates on the steps of its own walk
  if (!moments.length && index.byId.has(c.id)) {
    const w = flowSummary(index, c.id);
    for (const st of w?.j.steps ?? []) for (const g of st.gates) {
      if (g.config || g.planned || gates.has(g.id)) continue;
      const n = index.byId.get(g.id);
      gates.set(g.id, { tier: n ? gateTierOf(n).tier : g.tier ?? 'business', words: n?.precondition?.words ?? g.name, ...(n?.loc ? { loc: locOf(n) } : {}) });
    }
  }
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
  for (const tier of order) for (const [id, g] of gates) {
    if (g.tier !== tier) continue;
    const card = gateCard(index, id);
    const kind = t(index.byId.get(id)?.kind === 'rule' ? 'ask.kind.rule' : 'ask.kind.guard');
    rows.push(line('need', 'ask.row.need', { words: bare(g.words), kind, at: g.loc ?? '' }, [id], { tier, ...(card ? { evidence: card.verdict } : {}), bizKey: 'ask.biz.row.need', bizVars: { words: bare(g.words), kind } }));
  }
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

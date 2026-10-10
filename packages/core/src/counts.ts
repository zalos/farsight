/**
 * Typed counts — one number, the words it is printed with, and the scope it
 * counts over, handed out by the fold that computed it (docs/COUNTS.md).
 *
 * The rule the ledger enforces: **one concept → one number everywhere; two
 * numbers → two names and a printed scope.** Every number a surface prints
 * should arrive as a `Counted`, so the surface never has to know which field
 * to read, which word to put beside it, or what it counts over — and a
 * tooltip (`numberTip()` in the viewer) can say all four things from the
 * object alone.
 *
 * Additive: the plain numeric fields the folds already returned stay where
 * they were. A `Counted` sits beside them and must agree with them — the core
 * tests pin each pair.
 */
import { STRINGS, t, type Register } from './strings.js';

/** One part of a partition: its words (a catalog key with `{n}`), and, where the part is a named thing out of the graph, that name. */
export interface CountPart {
  /** catalog key printed with `{n}` filled in; its `define` says what the part is */
  key: string;
  n: number;
  /** a name out of the graph (a component, a source), when the part is one thing rather than a kind */
  label?: string;
}

/**
 * A number and everything a reader needs to cite it.
 *
 * - `unit` — the catalog key the hybrid and code lenses print the number
 *   with (`{n}`, and `{m}` when `of` is set). Its `define` is *what it counts*.
 * - `bizUnit` — the key the business lens prints it with. **Absent means the
 *   business lens does not print this number** (it counts in a developer's
 *   unit: steps, repeats). Present keys pass lint RULE 5.
 * - `scope` — the catalog key for *what it counts over* (`across this
 *   journey`, `on this screen`, `in this source`). Words never carry a
 *   developer's unit, so every lens may print them.
 * - `source` — the core function and field it was read from, so a reader
 *   (or the ledger) can find the one place it is computed.
 * - `breakdown` — a **partition**: the parts always sum to `n`. A split
 *   that overlaps is never a breakdown.
 */
export interface Counted {
  n: number;
  of?: number;
  unit: string;
  bizUnit?: string;
  scope: string;
  source: string;
  breakdown?: CountPart[];
  /**
   * The command that prints this same number again, for a reader who doubts it: the CLI line and, where one
   * exists, the MCP tool (round 2026-10-10, the front door's state of play — every number carries its re-check).
   */
  recheck?: { cli: string; mcp?: string };
}

/**
 * Every scope key a `Counted` may carry. A closed list, like the absence
 * words: a new scope is a decision recorded in docs/COUNTS.md, not a string
 * someone typed.
 */
export const COUNT_SCOPES = [
  'journey.scopeAll',       // the whole journey, each thing once however many screens meet it
  'journey.scopeHere',      // one screen of a journey
  'count.scope.action',     // one action of one screen
  'count.scope.node',       // one node, alone
  'count.scope.source',     // one source × one test level (a Tests source card)
  'count.scope.selection',  // the sources and the level the Tests page has selected
  'count.scope.workspace',  // every source in scope
  'count.scope.component',  // a component's own stories
  'count.scope.parts',      // the parts a screen or component renders
  'count.scope.storybook',  // one running Storybook's index
  'count.scope.workSource', // the items one tracker source holds, as of its last sync
  'count.scope.workSources',// every tracker source a command read, each item once
  'count.scope.workSync',   // one sync of one tracker source
  'count.scope.workItem',   // one work item
  'count.scope.project',    // one workspace project (core projects.ts), and the projects it depends on
  'count.scope.package',    // one package of one source: every file of it that imports the package
  'count.scope.affected',   // one impact answer placed on the journeys (core affected.ts): the seed, what uses it as far out as asked
  'count.scope.persona',    // the journeys shown under one persona (core journeys.ts) — a journey for two personas is in each
  'count.scope.group',      // the journeys of one group under one persona (core journeys.ts)
  'count.scope.storyline',  // the journeys one storyline chains, each once (core journeys.ts)
  'count.scope.gate',       // one gate: the gate itself and the calls a request goes through to meet it (core gates.ts)
  'count.scope.route',      // the routes a designed, not-built screen will call (core coverage.ts `notBuilt`): the screen has no code a test can reach
] as const;
export type CountScope = typeof COUNT_SCOPES[number];

/**
 * The short words a test number prints **on its chip** for the scope it counts
 * over (round 2026-10-10, proposal 4: *n cases · over this screen*). The scope
 * key itself (`on this screen`) is the long form a tip or a sentence reads; these
 * are what sits beside the number wherever two test numbers can meet, so
 * `323 cases · over this screen` and `125 · over this action` never read as one
 * claim. Keyed by `CountScope`; a scope with no chip word prints its scope key.
 */
export const SCOPE_WORDS: Partial<Record<CountScope, string>> = {
  'journey.scopeAll': 'count.over.journey',
  'journey.scopeHere': 'count.over.screen',
  'count.scope.action': 'count.over.action',
  'count.scope.node': 'count.over.part',
  'count.scope.gate': 'count.over.gate',
  'count.scope.route': 'count.over.route',
  'count.scope.affected': 'count.over.affected',
  'count.scope.source': 'count.over.source',
  'count.scope.selection': 'count.over.selection',
  'count.scope.workspace': 'count.over.workspace',
};

/** The catalog key a number's chip prints for its scope (`over this screen`) — `SCOPE_WORDS`, else the scope key itself. */
export function scopeWord(c: Pick<Counted, 'scope'> | CountScope | string): string {
  const scope = typeof c === 'string' ? c : c.scope;
  return SCOPE_WORDS[scope as CountScope] ?? scope;
}

/** Build a `Counted`, leaving out what is absent so the JSON stays small. */
export function counted(
  n: number,
  unit: string,
  scope: CountScope,
  source: string,
  extra: { of?: number; bizUnit?: string; breakdown?: CountPart[]; recheck?: { cli: string; mcp?: string } } = {},
): Counted {
  return {
    n, unit, scope, source,
    ...(extra.of != null ? { of: extra.of } : {}),
    ...(extra.bizUnit ? { bizUnit: extra.bizUnit } : {}),
    ...(extra.breakdown ? { breakdown: extra.breakdown } : {}),
    ...(extra.recheck ? { recheck: extra.recheck } : {}),
  };
}

/** The key to print `n` with: the catalog's singular (`<key>One`) when n is 1 and one exists. */
export function countKey(key: string, n: number): string {
  return n === 1 && STRINGS[`${key}One`] ? `${key}One` : key;
}

/**
 * The number in words, with its scope — for the CLI and MCP, which print text
 * rather than a tooltip: `13 actions across this journey`. `lens: 'business'`
 * uses `bizUnit` and returns `''` when the number has none (the business lens
 * does not print it).
 */
export function countedText(c: Counted, opts: { lens?: 'business' | 'hybrid' | 'code'; register?: Register; scope?: boolean } = {}): string {
  const register = opts.register ?? 'professional';
  const key = opts.lens === 'business' ? c.bizUnit : c.unit;
  if (!key) return '';
  const words = t(countKey(key, c.n), register).replace('{n}', String(c.n)).replace('{m}', String(c.of ?? ''));
  return opts.scope === false ? words : `${words} ${t(c.scope, register)}`;
}

/** A breakdown as words: `15 calls the code makes · 14 calls only declared · 2 screens with nothing to call`. */
export function breakdownText(c: Counted, register: Register = 'professional'): string {
  return (c.breakdown ?? [])
    .map((p) => `${p.label ? `${p.label} · ` : ''}${t(countKey(p.key, p.n), register).replace('{n}', String(p.n))}`)
    .join(' · ');
}

/**
 * Everything wrong with a `Counted`, as sentences — empty when it is sound.
 * The core tests run every count a fold returns through this: the keys exist,
 * carry a define and a `{n}`, the scope is one of `COUNT_SCOPES`, and the
 * breakdown is a partition.
 */
export function countedProblems(c: Counted, where = 'count'): string[] {
  const out: string[] = [];
  const need = (key: string | undefined, what: string, placeholder = true) => {
    if (!key) return;
    const e = STRINGS[key];
    if (!e) { out.push(`${where}: ${what} \`${key}\` is not in the catalog`); return; }
    if (!e.define && !STRINGS[key.replace(/One$/, '')]?.define) out.push(`${where}: ${what} \`${key}\` has no define — a number whose words nobody defined cannot say what it counts`);
    if (placeholder && !/\{n\}/.test(e.hud) && !/\{n\}/.test(e.professional)) out.push(`${where}: ${what} \`${key}\` has no {n}`);
  };
  if (!Number.isInteger(c.n) || c.n < 0) out.push(`${where}: n is ${c.n}`);
  need(c.unit, 'unit');
  need(c.bizUnit, 'bizUnit');
  need(c.scope, 'scope', false);
  if (!(COUNT_SCOPES as readonly string[]).includes(c.scope)) out.push(`${where}: scope \`${c.scope}\` is not one of COUNT_SCOPES`);
  if (c.of != null && c.of < c.n) out.push(`${where}: ${c.n} of ${c.of}`);
  if (c.of != null && !/\{m\}/.test(STRINGS[c.unit]?.professional ?? '')) out.push(`${where}: unit \`${c.unit}\` prints no {m} but the count carries \`of\``);
  if (!c.source) out.push(`${where}: no source`);
  if (c.breakdown) {
    for (const p of c.breakdown) need(p.key, 'breakdown part');
    const sum = c.breakdown.reduce((a, p) => a + p.n, 0);
    if (sum !== c.n) out.push(`${where}: breakdown sums to ${sum}, not ${c.n} — a breakdown is a partition`);
  }
  return out;
}

/**
 * Several counts as one line for a terminal or an agent, grouped by scope so
 * the scope is said once per run of numbers that share it:
 * `across this journey: 11 screens · 34 gates & rules (25 gates · 9 validation rules)`.
 * Zeroes are left out unless `zeroes` is set; a count the lens does not print
 * (no `bizUnit` under `lens: 'business'`) is left out.
 */
export function countedLine(list: (Counted | undefined)[], opts: { lens?: 'business' | 'hybrid' | 'code'; register?: Register; zeroes?: boolean; breakdown?: boolean } = {}): string {
  const register = opts.register ?? 'professional';
  const groups: { scope: string; items: string[] }[] = [];
  for (const c of list) {
    if (!c || (!c.n && !opts.zeroes)) continue;
    const words = countedText(c, { ...opts, scope: false });
    if (!words) continue;
    const parts = opts.breakdown !== false && c.breakdown?.some((p) => p.n && p.n !== c.n) ? ` (${breakdownText({ ...c, breakdown: c.breakdown.filter((p) => p.n) }, register)})` : '';
    const last = groups[groups.length - 1];
    if (last && last.scope === c.scope) last.items.push(words + parts);
    else groups.push({ scope: c.scope, items: [words + parts] });
  }
  return groups.map((g) => `${t(g.scope, register)}: ${g.items.join(' · ')}`).join(' — ');
}

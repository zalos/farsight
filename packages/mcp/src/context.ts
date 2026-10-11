/**
 * The session-start context (round 2026-10-10, proposal 9): what every agent reads first, as one short block —
 * the state of play's three columns (core `stateOfPlay`, the front door's card), the history sentence with how
 * many commits were made with an agent, what moved *since your last session* (syncs and commits after a time
 * the agent passes, the last 24 hours by default), and the lessons the owner pinned in
 * `.farsight/settings.json → lessons[]`.
 *
 * Served three ways with one text: the MCP resource `farsight://context`, `graph_overview { brief: true }`,
 * and (through the same function) any client that reads the resource at start-up.
 *
 * What it reads from the settings file is **only** `mcp.tools`, `mcp.budget` and `lessons` (`readAgentSettings`).
 * A source, its auth block or a keychain reference is never read here, so none can reach an agent through it
 * (docs/SECURITY.md). Lessons are written by a person on the Settings page; no tool writes them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  countedText, breakdownText, historySentence, t, fillFreshness, freshnessVars,
  type StateOfPlay, type HistoryFact,
} from '@farsight/core';

/** One lesson the owner wrote for agents: its words, whether it is pinned (read at every session start), when. */
export interface Lesson { text: string; pinned?: boolean; date?: string }

/** The three things an MCP session reads from `.farsight/settings.json` — and nothing else. */
export interface AgentSettings {
  /** `mcp.tools`, as written (resolved by `resolveTier`) */
  tools?: unknown;
  /** `mcp.budget` in tokens, when a positive number */
  budget?: number;
  lessons: Lesson[];
}

/** A lesson's longest text, in characters — the Settings page and the server hold it to the same. */
export const LESSON_MAX = 400;

/**
 * Read the agent's three settings from the workspace beside the graph. Missing or unreadable is the defaults
 * (no settings, no lessons) — never a throw. Every other field of the file is dropped here, unread.
 */
export function readAgentSettings(workspace: string): AgentSettings {
  const p = join(workspace, '.farsight', 'settings.json');
  if (!existsSync(p)) return { lessons: [] };
  let raw: { mcp?: { tools?: unknown; budget?: unknown }; lessons?: unknown };
  try { raw = JSON.parse(readFileSync(p, 'utf8')); } catch { return { lessons: [] }; }
  const out: AgentSettings = { lessons: lessonsOf(raw?.lessons) };
  if (raw?.mcp && typeof raw.mcp === 'object') {
    if (raw.mcp.tools !== undefined) out.tools = raw.mcp.tools;
    const b = raw.mcp.budget;
    if (typeof b === 'number' && Number.isFinite(b) && b > 0) out.budget = b;
  }
  return out;
}

/** The lessons that are well formed: a non-empty text (clipped to `LESSON_MAX`), a boolean pin, a date string. */
export function lessonsOf(v: unknown): Lesson[] {
  if (!Array.isArray(v)) return [];
  const out: Lesson[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const l = x as { text?: unknown; pinned?: unknown; date?: unknown };
    if (typeof l.text !== 'string' || !l.text.trim()) continue;
    out.push({
      text: l.text.trim().slice(0, LESSON_MAX),
      ...(l.pinned === true ? { pinned: true } : {}),
      ...(typeof l.date === 'string' && l.date ? { date: l.date.slice(0, 10) } : {}),
    });
  }
  return out;
}

export interface ContextInput {
  state: StateOfPlay;
  history: HistoryFact | null;
  /** the build this server runs (`version · commit`) */
  build: string;
  /** what *since your last session* counts from, ISO 8601, and whether the agent named it */
  since: { at: string; given: boolean };
  /** the syncs recorded after `since`, oldest first; null when no history store exists beside the graph */
  syncsSince: { sync: number; at: string }[] | null;
  /** the commits authored after `since` across the sources, and how many of them name an assistant; null without a store */
  commitsSince: { n: number; agents: number } | null;
  lessons: Lesson[];
  /** the tier line (`tierLine`) */
  tools: string;
}

/** How many pinned lessons the block prints in full before it counts the rest. */
const LESSONS_SHOWN = 8;

/**
 * The block: a `<farsight-context …>` element whose attributes say what it is as of, one line per fact, each
 * number in its own words with its unit. Plain text for an agent; nothing in it is a secret or a session link.
 */
export function contextBlock(c: ContextInput): string[] {
  const p = c.state.provenance;
  const w = (x: Parameters<typeof countedText>[0]) => countedText(x, { scope: false });
  const attrs = [
    `sync=${p.sync ?? '—'}`,
    `commit=${p.commit ? p.commit.slice(0, 7) : '—'}`,
    `build=${c.build.replace(/\s+/g, '')}`,
  ].join(' ');
  const s = c.state;
  const out = [`<farsight-context ${attrs}>`];
  out.push(`built: ${[w(s.built.journeys), w(s.built.screens), w(s.built.operations), w(s.built.storylines)].join(' · ')}`);
  const verdicts = s.validated.byVerdict.filter((v) => v.word.cls !== 'none').map((v) => `${w(v.journeys)} ${t(v.word.key, 'professional')}`);
  const lastRun = s.validated.lastE2e
    ? `${t('state.lastE2e', 'professional').replace('{date}', s.validated.lastE2e.at.slice(0, 10))}${s.validated.lastE2e.fresh ? ` (${fillFreshness(t(s.validated.lastE2e.fresh.key, 'professional'), freshnessVars(s.validated.lastE2e.fresh))})` : ''}`
    : t('state.noE2e', 'professional');
  out.push(`validated: ${[...verdicts, lastRun, `${w(s.validated.cases)} (${breakdownText({ ...s.validated.cases, breakdown: (s.validated.cases.breakdown ?? []).filter((x) => x.n) })})`].join(' · ')}`);
  const notBuilt = s.open.notBuiltNames.length ? ` (${s.open.notBuiltNames.join(', ')})` : '';
  out.push(`open: ${[`${w(s.open.screensNotBuilt)}${notBuilt}`, w(s.open.operationsNotImplemented), w(s.open.blindSpots), w(s.open.drift)].join(' · ')}`);
  if (c.history) {
    out.push(`history: ${historySentence(c.history)}${c.history.agents ? ` · ${w(c.history.agents)}` : ''}`);
  }
  const sinceWords = `since ${c.since.at.replace('T', ' ').slice(0, 16)}${c.since.given ? '' : ', the last 24 hours — pass since for your own last session'}`;
  if (c.syncsSince === null || c.commitsSince === null) {
    out.push(`since your last session (${sinceWords}): no history store beside this graph — a sync writes one`);
  } else {
    const syncs = c.syncsSince.length
      ? `${c.syncsSince.length} sync(s) (${c.syncsSince.map((x) => x.sync).join(', ')})`
      : 'no sync';
    const commits = `${c.commitsSince.n} commit(s)${c.commitsSince.n ? ` (${c.commitsSince.agents} made with an agent)` : ''}`;
    out.push(`since your last session (${sinceWords}): ${syncs} · ${commits}`);
  }
  const pinned = c.lessons.filter((l) => l.pinned);
  if (pinned.length) {
    const shown = pinned.slice(0, LESSONS_SHOWN).map((l) => `"${l.text.replace(/\s+/g, ' ')}"${l.date ? ` (${l.date})` : ''}`);
    out.push(`lessons pinned by the owner (${pinned.length} of ${c.lessons.length}): ${shown.join(' · ')}${pinned.length > LESSONS_SHOWN ? ` · … +${pinned.length - LESSONS_SHOWN} more` : ''}`);
  } else {
    out.push(`lessons: none pinned${c.lessons.length ? ` (${c.lessons.length} written, none pinned)` : ''} — the owner writes them on the Settings page (Lessons for agents); an agent never does`);
  }
  out.push(c.tools);
  out.push('</farsight-context>');
  return out;
}

/** `since` as an agent may pass it — an ISO date or time — else the last 24 hours before `now`. */
export function sinceOf(asked: string | undefined, now = new Date()): { at: string; given: boolean } {
  if (asked) {
    const d = new Date(asked);
    if (!Number.isNaN(d.getTime())) return { at: d.toISOString(), given: true };
  }
  return { at: new Date(now.getTime() - 24 * 3600 * 1000).toISOString(), given: false };
}

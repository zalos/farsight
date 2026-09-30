import { statSync, openSync, readSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Model Hub — runtime AI observability state (shared by server + MCP).
 *
 * This is a *runtime overlay*, not part of the semantic graph: it reads the
 * append-only event stream + registry that local AI tools (speak-md, recap-md,
 * Claude hooks) write to `~/.local/share/modelhub`, merges in live Ollama
 * state, and produces one state document. Everything is fail-soft: a missing
 * directory, missing files, or a downed Ollama yields empty sections, never a
 * throw — the reader must never take down its consumer.
 *
 * Contract + liveness semantics: docs/proposals/model-hub.md + model-hub-plan.md.
 */

// ── registry schema (registry.json) ─────────────────────────────
export interface RegistryModel {
  id: string;
  runtime?: string;
  license?: string;
}
export interface RegistryCategory {
  id: string;
  name: string;
  models: RegistryModel[];
}
export interface RegistryTool {
  id: string;
  uses: string[];
}
export interface RegistryChain {
  id: string;
  steps: string[];
  desc?: string;
}
export interface Registry {
  categories: RegistryCategory[];
  tools: RegistryTool[];
  chains: RegistryChain[];
}

// ── merged runtime state ────────────────────────────────────────
/** Liveness for a tool or model: is it running right now, and when did it last start/end. */
export interface Activity {
  active: boolean;
  lastStart: number | null;
  lastEnd: number | null;
}
/** A Claude Code agent session observed via user-level hooks. */
export interface ClaudeSession {
  session: string;
  active: boolean;
  /** last tool the session invoked (metadata only, never content). */
  lastTool: string | null;
  lastEventTs: number | null;
  idle: boolean;
}
export interface OllamaState {
  installed: string[];
  loaded: string[];
}
export interface ModelHubState {
  registry: Registry;
  /** per-tool activity keyed by tool id. */
  tools: Record<string, Activity>;
  /** per-model activity keyed by model id. */
  models: Record<string, Activity>;
  sessions: ClaudeSession[];
  ollama: OllamaState;
  /** ms epoch when this snapshot was produced. */
  generatedAt: number;
}

// ── one raw event line ──────────────────────────────────────────
interface RawEvent {
  ts?: number;
  source?: string;
  tool?: string;
  model?: string;
  session?: string;
  event?: string;
}

// staleness cutoffs, in seconds
const TOOL_STALE_S = 30 * 60; // 30 min
const SESSION_ACTIVE_S = 15; // 15 s

const EMPTY_REGISTRY: Registry = { categories: [], tools: [], chains: [] };

/** Resolve the Model Hub data directory: $MODELHUB_DIR or ~/.local/share/modelhub. */
export function resolveModelHubDir(): string {
  return process.env.MODELHUB_DIR || join(homedir(), '.local', 'share', 'modelhub');
}

/**
 * Size-based retention: if events.jsonl exceeds 1 MB, truncate to (roughly)
 * the last 256 KB, aligned to a line boundary so we never keep a partial line.
 * Called once at server start. Fail-soft.
 */
export function rotateEventsFile(dir = resolveModelHubDir()): void {
  const path = join(dir, 'events.jsonl');
  try {
    const size = statSync(path).size;
    const MAX = 1024 * 1024;
    const KEEP = 256 * 1024;
    if (size <= MAX) return;
    const fd = openSync(path, 'r');
    try {
      const start = size - KEEP;
      const buf = Buffer.alloc(KEEP);
      const read = readSync(fd, buf, 0, KEEP, start);
      let slice = buf.subarray(0, read);
      // drop the leading partial line so we start at a clean record boundary
      const nl = slice.indexOf(0x0a);
      if (nl >= 0) slice = slice.subarray(nl + 1);
      writeFileSync(path, slice);
    } finally {
      closeSync(fd);
    }
  } catch {
    // no file / not readable / not writable ⇒ nothing to rotate
  }
}

/** Read the registry, tolerating a missing or malformed file. */
function readRegistry(dir: string): Registry {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8')) as Partial<Registry>;
    return {
      categories: Array.isArray(raw.categories) ? raw.categories : [],
      tools: Array.isArray(raw.tools) ? raw.tools : [],
      chains: Array.isArray(raw.chains) ? raw.chains : [],
    };
  } catch {
    return { ...EMPTY_REGISTRY };
  }
}

/**
 * Tail-read the last ~64 KB of events.jsonl (open/stat/read from offset — never
 * the whole file) and parse it into events. Drops a leading partial line and
 * any unparseable line. Returns [] on any failure.
 */
function tailEvents(dir: string): RawEvent[] {
  const path = join(dir, 'events.jsonl');
  const TAIL = 64 * 1024;
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size === 0) return [];
    const start = Math.max(0, size - TAIL);
    const len = size - start;
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, start);
    let text = buf.subarray(0, read).toString('utf8');
    // if we started mid-file, discard the first (partial) line
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const events: RawEvent[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as RawEvent);
      } catch {
        // skip malformed line (events file is user-writable, untrusted)
      }
    }
    return events;
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Poll one Ollama endpoint, returning model names. Fail-soft ⇒ []. */
async function pollOllamaNames(pathname: string): Promise<string[]> {
  try {
    const res = await fetch(`http://127.0.0.1:11434${pathname}`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name?: string }[] };
    if (!Array.isArray(data.models)) return [];
    return data.models.map((m) => m?.name).filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}

/**
 * Read the full merged Model Hub state: registry + per-tool/per-model liveness
 * (from tailed events) + Claude agent sessions + live Ollama installed/loaded.
 * Never throws — every source degrades to an empty section on failure.
 */
export async function readModelHubState(dir = resolveModelHubDir()): Promise<ModelHubState> {
  const nowMs = Date.now();
  const nowS = Math.floor(nowMs / 1000);

  const registry = readRegistry(dir);
  const events = tailEvents(dir);

  const [installed, loaded] = await Promise.all([
    pollOllamaNames('/api/tags'),
    pollOllamaNames('/api/ps'),
  ]);

  // per-tool and per-model start/end tracking from the event stream
  const tools: Record<string, Activity> = {};
  const models: Record<string, Activity> = {};
  const sessionMap: Record<string, ClaudeSession> = {};

  const track = (bag: Record<string, Activity>, key: string, ev: RawEvent) => {
    if (!key) return;
    const a = (bag[key] ||= { active: false, lastStart: null, lastEnd: null });
    if (ev.event === 'start') a.lastStart = ev.ts ?? a.lastStart;
    else if (ev.event === 'end') a.lastEnd = ev.ts ?? a.lastEnd;
  };

  for (const ev of events) {
    if (ev.source === 'tool') {
      if (ev.tool) track(tools, ev.tool, ev);
      if (ev.model) track(models, ev.model, ev);
    } else if (ev.source === 'claude' && ev.session) {
      const s = (sessionMap[ev.session] ||= {
        session: ev.session,
        active: false,
        lastTool: null,
        lastEventTs: null,
        idle: false,
      });
      s.lastEventTs = ev.ts ?? s.lastEventTs;
      if (ev.event === 'idle') {
        s.idle = true;
      } else if (ev.event === 'tool') {
        s.idle = false;
        s.lastTool = ev.tool ?? s.lastTool;
      }
    }
  }

  // finalize tool/model liveness: latest start with no later end, start < 30 min old
  const finalize = (a: Activity) => {
    const started = a.lastStart != null;
    const noLaterEnd = a.lastEnd == null || (a.lastStart != null && a.lastEnd < a.lastStart);
    const fresh = a.lastStart != null && nowS - a.lastStart < TOOL_STALE_S;
    a.active = started && noLaterEnd && fresh;
  };
  for (const a of Object.values(tools)) finalize(a);
  for (const a of Object.values(models)) finalize(a);

  // a model loaded in Ollama /api/ps is also active (second liveness source)
  for (const name of loaded) {
    const a = (models[name] ||= { active: false, lastStart: null, lastEnd: null });
    a.active = true;
  }

  // finalize claude sessions: last event is a tool event < 15 s old, not idle'd
  for (const s of Object.values(sessionMap)) {
    s.active = !s.idle && s.lastEventTs != null && nowS - s.lastEventTs < SESSION_ACTIVE_S;
  }

  return {
    registry,
    tools,
    models,
    sessions: Object.values(sessionMap),
    ollama: { installed, loaded },
    generatedAt: nowMs,
  };
}

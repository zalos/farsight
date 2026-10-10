/**
 * The one rule for a **config check** (swarm-fixes round 2026-10-05, finding 4):
 * a guard that checks the process — the settings it was started with — rather
 * than a request. The parser tags such a guard `config-check` from its own text;
 * a graph ingested before the tag existed is read the same way from the node's
 * snippet. No imports, so the journey walk (query.ts) and the gate card
 * (gates.ts) can both read it without a cycle.
 */
import type { GraphNode } from './graph.js';

/** Reads the process environment: `process.env`, `import.meta.env`, `Deno.env`, or a settings record named `env` keyed in SHOUT_CASE. */
const READS_ENV = /\bprocess\.env\b|\bimport\.meta\.env\b|\bDeno\.env\b|\benv\s*(?:\[\s*['"`][A-Z][A-Z0-9_]*['"`]\s*\]|\.[A-Z][A-Z0-9_]*\b)|\benv\s*:\s*Record\s*<\s*string/;
/** A parameter that carries a request: the request itself, its context, a session, its cookies or headers, a principal, an event. */
const TAKES_REQUEST = /\b(?:req|request|ctx|context|session|cookies?|cookieHeader|headers|principal|event)\b|\bRequest\b|\bNextRequest\b/;

/** The parameters of a use-case: its input or command, or the container, repositories or services it is handed. */
const USE_CASE_PARAMS = /\b(?:input|command|cmd|deps|repos)\b|:\s*(?:Container|Deps|Dependencies|Repositories|Services|AppContext)\b/;

/** The text between a function's first `(` and the `)` that closes it — its parameters, or `''`. */
export function paramsText(code: string): string {
  const open = code.indexOf('(');
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return code.slice(open + 1, i); }
  }
  return code.slice(open + 1);
}

/**
 * True when a guard's own text is a config check: it reads the process
 * environment and takes no request. `requireSession(req)` reading
 * `env.APP_BASE_URL` checks a request; `resolveOpsDevLogin(requested, env)`
 * refusing `OPS_DEV_LOGIN=true` outside mock checks how the app was started.
 */
export function configCheckOf(code: string): boolean {
  if (!code || !READS_ENV.test(code)) return false;
  // a use-case is not a settings check because somewhere in its body it reads one (gates lane
  // 2026-10-10: a 230-line submit taking `(c: Container, input)` read as a config check). A long
  // function that takes the settings themselves (`resolveEmailDelivery(env)`) still is one.
  if (code.split('\n').length > CONFIG_CHECK_MAX_LINES && USE_CASE_PARAMS.test(paramsText(code))) return false;
  return !TAKES_REQUEST.test(paramsText(code));
}

/** Past this many lines, a function handed a use-case's parameters is a use-case that happens to read a setting. */
export const CONFIG_CHECK_MAX_LINES = 40;

/** The tag the parser writes on a guard `configCheckOf` accepts. */
export const CONFIG_CHECK_TAG = 'config-check';

/** A guard node that checks the process, not a request: the parser's tag, else its snippet read by the same rule. */
export function isConfigCheck(node: GraphNode | undefined): boolean {
  if (!node || node.kind !== 'guard') return false;
  if (node.tags?.includes(CONFIG_CHECK_TAG)) return !node.tags.includes('action-gate');
  // a gate declared in farsight.config.json is a policy somebody named, never a settings check
  if (node.tags?.includes('declared')) return false;
  // a use-case marked as a gate (it moves a record's status) is an action, never a settings check
  if (node.tags?.includes('action-gate')) return false;
  if (node.loc?.endLine && node.loc.endLine - node.loc.line + 1 > CONFIG_CHECK_MAX_LINES && node.snippet && USE_CASE_PARAMS.test(paramsText(node.snippet))) return false;
  return !!node.snippet && configCheckOf(node.snippet);
}


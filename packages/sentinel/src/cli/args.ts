// Command-line parsing: one typed result per command, or a configuration refusal with a catalog code. Every command
// declares the flags it accepts; an unknown flag, a missing value, a repeated flag or an unexpected argument is
// refused rather than ignored, so a typo can never quietly change what a command does.

/** The commands this executable knows, and the planning change that delivers each one that is not built yet. */
export const COMMANDS = {
  help: null, version: null, capabilities: null, validate: null, init: null, settings: null,
  plan: null, run: null, status: null, report: null, wait: null, pause: null, resume: null, cancel: null, serve: null,
  // A new attempt of failed work and a fresh run of a finished plan need plan revisions from PR 06's planner.
  retry: 'PR 09', rerun: 'PR 09',
  compare: 'PR 19', rules: 'PR 06', bundle: 'PR 26',
} as const satisfies Record<string, string | null>;
export type CommandName = keyof typeof COMMANDS;

type FlagKind = 'boolean' | 'value';
interface CommandSpec {
  readonly flags: Readonly<Record<string, FlagKind>>;
  /** Positional arguments: names in order; `min` of them are required. */
  readonly positional: readonly string[];
  readonly min: number;
}

const COMMON: Record<string, FlagKind> = { '--json': 'boolean' };
const STORE: Record<string, FlagKind> = { '--workspace': 'value' };
const RUN_REF: CommandSpec = { flags: { ...COMMON, ...STORE }, positional: ['runId'], min: 1 };

const SPECS: Readonly<Record<CommandName, CommandSpec>> = {
  help: { flags: COMMON, positional: [], min: 0 },
  version: { flags: COMMON, positional: [], min: 0 },
  capabilities: { flags: COMMON, positional: [], min: 0 },
  validate: { flags: COMMON, positional: ['kind', 'file'], min: 2 },
  init: { flags: { ...COMMON, '--workspace': 'value', '--profile': 'value' }, positional: [], min: 0 },
  settings: { flags: { ...COMMON, ...STORE, '--confirm': 'boolean' }, positional: ['action'], min: 1 },
  plan: { flags: { ...COMMON, ...STORE, '--confirm': 'boolean' }, positional: [], min: 0 },
  run: { flags: { ...COMMON, ...STORE, '--detach': 'boolean', '--confirm': 'boolean' }, positional: ['planId'], min: 1 },
  status: { flags: { ...COMMON, ...STORE, '--after': 'value', '--limit': 'value' }, positional: ['runId'], min: 1 },
  wait: { flags: { ...COMMON, ...STORE, '--timeout': 'value' }, positional: ['runId'], min: 1 },
  pause: RUN_REF, cancel: RUN_REF, retry: RUN_REF,
  resume: { flags: { ...COMMON, ...STORE, '--confirm': 'boolean' }, positional: ['runId'], min: 1 },
  rerun: { flags: { ...COMMON, ...STORE, '--confirm': 'boolean', '--idempotency-key': 'value' }, positional: ['runId'], min: 1 },
  report: { flags: { ...COMMON, ...STORE, '--format': 'value' }, positional: ['runId'], min: 1 },
  serve: { flags: { ...COMMON, ...STORE, '--idle-ms': 'value' }, positional: [], min: 0 },
  compare: { flags: COMMON, positional: [], min: 0 },
  rules: { flags: COMMON, positional: [], min: 0 },
  bundle: { flags: COMMON, positional: [], min: 0 },
};

export type ArgsErrorCode =
  | 'sentinel.args.unknownCommand' | 'sentinel.args.unknownFlag' | 'sentinel.args.missingValue'
  | 'sentinel.args.repeatedFlag' | 'sentinel.args.unexpectedArgument' | 'sentinel.args.missingArgument';

export interface ParsedCommand {
  readonly command: CommandName;
  readonly json: boolean;
  /** Present flags: `true` for a boolean flag, the text for a value flag. */
  readonly flags: Readonly<Record<string, string | true>>;
  readonly args: Readonly<Record<string, string>>;
}

export type ParseResult =
  | { readonly ok: true; readonly parsed: ParsedCommand }
  | { readonly ok: false; readonly code: ArgsErrorCode; readonly detail: string; readonly json: boolean };

const ALIASES: Record<string, CommandName> = { '--help': 'help', '-h': 'help', '--version': 'version', '-v': 'version' };

/** Parses `argv` (without the node and script paths). `--json` anywhere selects JSON output, even for a refusal. */
export function parseArgs(argv: readonly string[]): ParseResult {
  const json = argv.includes('--json');
  const fail = (code: ArgsErrorCode, detail: string): ParseResult => ({ ok: false, code, detail, json });
  const first = argv.find(a => a !== '--json');
  const name = first === undefined ? 'help' : (ALIASES[first] ?? first);
  if (!Object.hasOwn(SPECS, name)) return fail('sentinel.args.unknownCommand', String(first));
  const command = name as CommandName;
  // A command this build does not run is refused as unavailable before its arguments are judged.
  if (COMMANDS[command] !== null) return { ok: true, parsed: Object.freeze({ command, json, flags: Object.freeze({}), args: Object.freeze({}) }) };
  const spec = SPECS[command];
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  let skippedName = first === undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!skippedName && a === first) { skippedName = true; continue; }
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('-') && a !== '-') {
      const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
      const kind = spec.flags[flag];
      if (kind === undefined) {
        return fail('sentinel.args.unknownFlag', flag);
      }
      if (Object.hasOwn(flags, flag)) return fail('sentinel.args.repeatedFlag', flag);
      if (kind === 'boolean') {
        if (inline !== undefined) return fail('sentinel.args.unexpectedArgument', a);
        flags[flag] = true;
      } else {
        const value = inline ?? argv[++i];
        if (value === undefined || value === '' || (inline === undefined && value.startsWith('--'))) return fail('sentinel.args.missingValue', flag);
        flags[flag] = value;
      }
      continue;
    }
    positional.push(a);
  }
  if (positional.length > spec.positional.length) return fail('sentinel.args.unexpectedArgument', positional[spec.positional.length]!);
  if (positional.length < spec.min) return fail('sentinel.args.missingArgument', spec.positional[positional.length]!);
  const args: Record<string, string> = {};
  spec.positional.forEach((p, i) => { if (positional[i] !== undefined) args[p] = positional[i]!; });
  return { ok: true, parsed: Object.freeze({ command, json, flags: Object.freeze(flags), args: Object.freeze(args) }) };
}

/** The planning change for a command this build does not run yet, or null when it is built. */
export const plannedIn = (command: CommandName): string | null => COMMANDS[command];

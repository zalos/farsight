// Command-line parsing: one typed result per command, or a configuration refusal with a catalog code. Every command
// declares the flags it accepts; an unknown flag, a missing value, a repeated flag or an unexpected argument is
// refused rather than ignored, so a typo can never quietly change what a command does.

/** The commands this executable knows, and the planning change that delivers each one that is not built yet. */
export const COMMANDS = {
  help: null,
  version: null,
  capabilities: null,
  validate: null,
  init: null,
  settings: null,
  pipeline: null,
  plan: null,
  paths: null,
  run: null,
  status: null,
  report: null,
  wait: null,
  pause: null,
  resume: null,
  cancel: null,
  serve: null,
  retry: null,
  rerun: null,
  rules: null,
  assets: null,
  mcp: null,
  evidence: null,
  decision: null,
  prepare: null,
  'owner-ui': null,
  compare: null,
  bundle: 'PR 26',
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
/** The full report's choices: disclosure, format, an owner-confirmed application graph, and a new file to write. */
const FULL_REPORT: Record<string, FlagKind> = {
  '--format': 'value',
  '--disclosure': 'value',
  '--context': 'value',
  '--repo': 'value',
  '--out': 'value',
  '--confirm': 'boolean',
};
const SPECS: Readonly<Record<CommandName, CommandSpec>> = {
  help: { flags: COMMON, positional: [], min: 0 },
  version: { flags: COMMON, positional: [], min: 0 },
  capabilities: { flags: { ...COMMON, '--models': 'boolean' }, positional: [], min: 0 },
  validate: { flags: COMMON, positional: ['kind', 'file'], min: 2 },
  init: { flags: { ...COMMON, '--workspace': 'value', '--profile': 'value' }, positional: [], min: 0 },
  settings: { flags: { ...COMMON, ...STORE, '--confirm': 'boolean' }, positional: ['action'], min: 1 },
  pipeline: {
    flags: { ...COMMON, ...STORE, '--confirm': 'boolean', '--file': 'value' },
    positional: ['action'],
    min: 1,
  },
  plan: { flags: { ...COMMON, ...STORE, '--confirm': 'boolean' }, positional: [], min: 0 },
  paths: {
    flags: { ...COMMON, ...STORE, '--confirm': 'boolean', '--request': 'value' },
    positional: ['ancestorRunId'],
    min: 1,
  },
  run: {
    flags: { ...COMMON, ...STORE, '--detach': 'boolean', '--confirm': 'boolean', '--confirm-models': 'boolean' },
    positional: ['planId'],
    min: 1,
  },
  status: { flags: { ...COMMON, ...STORE, '--after': 'value', '--limit': 'value' }, positional: ['runId'], min: 1 },
  wait: { flags: { ...COMMON, ...STORE, '--timeout': 'value' }, positional: ['runId'], min: 1 },
  pause: { flags: { ...COMMON, ...STORE, '--confirm': 'boolean' }, positional: ['runId'], min: 1 },
  cancel: { flags: { ...COMMON, ...STORE, '--confirm': 'boolean' }, positional: ['runId'], min: 1 },
  retry: { flags: { ...COMMON, ...STORE, '--confirm': 'boolean' }, positional: ['runId'], min: 1 },
  resume: { flags: { ...COMMON, ...STORE, '--confirm': 'boolean' }, positional: ['runId'], min: 1 },
  rerun: { flags: { ...COMMON, ...STORE, '--confirm': 'boolean', '--stage': 'value' }, positional: ['runId'], min: 1 },
  report: {
    flags: { ...COMMON, ...STORE, ...FULL_REPORT, '--full': 'boolean', '--instructions': 'boolean' },
    positional: ['runId'],
    min: 1,
  },
  serve: { flags: { ...COMMON, ...STORE, '--idle-ms': 'value' }, positional: [], min: 0 },
  compare: { flags: { ...COMMON, ...STORE, ...FULL_REPORT }, positional: ['runId', 'baselineRunId'], min: 2 },
  rules: { flags: { ...COMMON, ...STORE, '--confirm': 'boolean' }, positional: ['action', 'packDir'], min: 1 },
  assets: {
    flags: {
      ...COMMON,
      ...STORE,
      '--confirm': 'boolean',
      '--archive': 'value',
      '--manifest': 'value',
      '--max-bytes': 'value',
      '--license': 'value',
    },
    positional: ['action', 'assetId'],
    min: 2,
  },
  'owner-ui': { flags: { ...STORE, '--farsight-origin': 'value' }, positional: [], min: 0 },
  mcp: { flags: STORE, positional: [], min: 0 },
  decision: {
    flags: {
      ...COMMON,
      ...STORE,
      '--confirm': 'boolean',
      '--finding': 'value',
      '--proposal': 'value',
      '--baseline': 'value',
      '--after': 'value',
      '--limit': 'value',
    },
    positional: ['action', 'target'],
    min: 2,
  },
  evidence: {
    flags: {
      ...COMMON,
      ...STORE,
      '--confirm': 'boolean',
      '--source': 'value',
      '--report': 'value',
      '--manifest': 'value',
      '--expect-candidate': 'value',
      '--predecessor': 'value',
      '--baseline': 'value',
      '--format': 'value',
      '--out': 'value',
      '--after': 'value',
      '--limit': 'value',
    },
    positional: ['action', 'target'],
    min: 2,
  },
  prepare: {
    flags: { ...COMMON, ...STORE, '--confirm': 'boolean', '--request-key': 'value', '--parent': 'value' },
    positional: ['action'],
    min: 0,
  },
  bundle: { flags: COMMON, positional: [], min: 0 },
};

export type ArgsErrorCode =
  | 'sentinel.args.unknownCommand'
  | 'sentinel.args.unknownFlag'
  | 'sentinel.args.missingValue'
  | 'sentinel.args.repeatedFlag'
  | 'sentinel.args.unexpectedArgument'
  | 'sentinel.args.missingArgument';

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

const ALIASES: Record<string, CommandName> = {
  '--help': 'help',
  '-h': 'help',
  '--version': 'version',
  '-v': 'version',
};

/** Parses `argv` (without the node and script paths). `--json` anywhere selects JSON output, even for a refusal. */
export function parseArgs(argv: readonly string[]): ParseResult {
  const json = argv.includes('--json');
  const fail = (code: ArgsErrorCode, detail: string): ParseResult => ({ ok: false, code, detail, json });
  const first = argv.find((a) => a !== '--json');
  const name = first === undefined ? 'help' : (ALIASES[first] ?? first);
  if (!Object.hasOwn(SPECS, name)) return fail('sentinel.args.unknownCommand', String(first));
  const command = name as CommandName;
  // A command this build does not run is refused as unavailable before its arguments are judged.
  if (COMMANDS[command] !== null)
    return { ok: true, parsed: Object.freeze({ command, json, flags: Object.freeze({}), args: Object.freeze({}) }) };
  const spec = SPECS[command];
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  let skippedName = first === undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!skippedName && a === first) {
      skippedName = true;
      continue;
    }
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      const [flag, inline] = a.includes('=')
        ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]
        : [a, undefined];
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
        if (value === undefined || value === '' || (inline === undefined && value.startsWith('--')))
          return fail('sentinel.args.missingValue', flag);
        flags[flag] = value;
      }
      continue;
    }
    positional.push(a);
  }
  if (positional.length > spec.positional.length)
    return fail('sentinel.args.unexpectedArgument', positional[spec.positional.length]!);
  if (positional.length < spec.min) return fail('sentinel.args.missingArgument', spec.positional[positional.length]!);
  if (command === 'capabilities' && flags['--models'] && !json)
    return fail('sentinel.args.unexpectedArgument', '--models requires --json');
  if (command === 'run' && flags['--confirm-models'] && flags['--detach'])
    return fail('sentinel.args.unexpectedArgument', '--confirm-models requires foreground run');
  if (command === 'report' && flags['--instructions']) {
    if (!json || Object.keys(flags).some((f) => !['--json', '--workspace', '--instructions'].includes(f)))
      return fail('sentinel.args.unexpectedArgument', '--instructions requires only --json');
  }
  if (command === 'paths' && flags['--request'] === undefined) return fail('sentinel.args.missingValue', '--request');
  const args: Record<string, string> = {};
  spec.positional.forEach((p, i) => {
    if (positional[i] !== undefined) args[p] = positional[i]!;
  });
  if (command === 'pipeline') {
    const allowed: Record<string, string[]> = { show: [], validate: ['--file'], adopt: ['--confirm'] };
    if (!Object.hasOwn(allowed, args.action!)) return fail('sentinel.args.unexpectedArgument', String(args.action));
    for (const flag of Object.keys(flags))
      if (!['--json', '--workspace', ...allowed[args.action!]!].includes(flag))
        return fail('sentinel.args.unknownFlag', flag);
  }
  if (command === 'decision') {
    const common = ['--json', '--workspace'];
    const allowed: Record<string, string[]> = {
      propose: ['--finding', '--proposal', '--confirm'],
      approve: ['--confirm'],
      read: ['--baseline'],
      list: ['--after', '--limit'],
    };
    if (!Object.hasOwn(allowed, args.action!)) return fail('sentinel.args.unexpectedArgument', 'decision');
    for (const flag of Object.keys(flags))
      if (!common.includes(flag) && !allowed[args.action!]!.includes(flag))
        return fail('sentinel.args.unknownFlag', 'decision');
  }
  if (command === 'evidence') {
    const common = ['--json', '--workspace'];
    const allowed: Record<string, string[]> = {
      import: [
        '--source',
        '--report',
        '--manifest',
        '--confirm',
        '--expect-candidate',
        '--predecessor',
        '--baseline',
        '--format',
        '--out',
      ],
      read: ['--baseline', '--format', '--out'],
      list: ['--source', '--after', '--limit', '--format', '--out'],
      abandon: ['--confirm'],
    };
    if (!Object.hasOwn(allowed, args.action!)) return fail('sentinel.args.unexpectedArgument', 'evidence');
    for (const flag of Object.keys(flags))
      if (!common.includes(flag) && !allowed[args.action!]!.includes(flag))
        return fail('sentinel.args.unknownFlag', 'evidence');
  }
  return { ok: true, parsed: Object.freeze({ command, json, flags: Object.freeze(flags), args: Object.freeze(args) }) };
}

/** The planning change for a command this build does not run yet, or null when it is built. */
export const plannedIn = (command: CommandName): string | null => COMMANDS[command];

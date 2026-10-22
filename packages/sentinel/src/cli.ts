#!/usr/bin/env node
// Placeholder executable: help, version, the explicit capability list and draft contract validation.
// No scan, ledger, scanner, container or model is started by any command here.
import { readFileSync, statSync } from 'node:fs';
import { CAPABILITIES } from './capabilities.js';
import { ENVELOPES, ENVELOPE_KINDS, MAX_ENVELOPE_BYTES, type EnvelopeKind } from './contracts/index.js';
import { parseEnvelope } from './validate.js';
// Every printed word comes from the shared catalog (packages/core/src/strings-sentinel-cli.ts).
import { sentinelWord as word } from '@farsight/core/dist/strings-sentinel-cli.js';

// Sentinel's own exit codes (they are not Work's: there, 2 means awaiting confirmation).
const EXIT = { ok: 0, configuration: 3 } as const;

const PLANNED: Record<string, string> = {
  plan: 'PR 09', run: 'PR 09', status: 'PR 09', pause: 'PR 09', resume: 'PR 09', cancel: 'PR 09', retry: 'PR 09',
  rerun: 'PR 09', serve: 'PR 08', compare: 'PR 19', report: 'PR 19', rules: 'PR 06', bundle: 'PR 26',
};

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

function help(): string {
  return [
    word('sentinel.cli.title'),
    '',
    word('sentinel.cli.scope'),
    '',
    word('sentinel.cli.usageHeading'),
    `  ${word('sentinel.cli.usageHelp')}`,
    `  ${word('sentinel.cli.usageCapabilities')}`,
    `  ${word('sentinel.cli.usageValidate')}`,
    `      ${word('sentinel.cli.kinds', { kinds: ENVELOPE_KINDS.join(', ') })}`,
    '',
    word('sentinel.cli.planned', { commands: Object.keys(PLANNED).join(', ') }),
    '',
    word('sentinel.cli.exitCodes'),
  ].join('\n');
}

function out(text: string) { process.stdout.write(text.endsWith('\n') ? text : `${text}\n`); }
function errOut(text: string) { process.stderr.write(text.endsWith('\n') ? text : `${text}\n`); }

function capabilities(json: boolean): number {
  if (json) { out(JSON.stringify({ version: version(), capabilities: CAPABILITIES }, null, 2)); return EXIT.ok; }
  const state = (c: (typeof CAPABILITIES)[number]) => word(c.state === 'unavailable' ? 'sentinel.cli.stateUnavailable' : 'sentinel.cli.stateDraft');
  const width = Math.max(...CAPABILITIES.map(c => state(c).length));
  for (const c of CAPABILITIES) {
    out(`${state(c).padEnd(width)}  ${c.id.padEnd(26)} ${word(c.reasonCode)} · ${word('sentinel.cli.plannedIn', { change: c.plannedIn })}`);
  }
  return EXIT.ok;
}

function validate(kind: string | undefined, file: string | undefined, json: boolean): number {
  if (!kind || !file || !(ENVELOPE_KINDS as string[]).includes(kind)) {
    errOut(word('sentinel.cli.validateUsage', { kinds: ENVELOPE_KINDS.join('|') }));
    return EXIT.configuration;
  }
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > MAX_ENVELOPE_BYTES) {
      errOut(word('sentinel.cli.refusedTooLarge', { bytes: MAX_ENVELOPE_BYTES }));
      return EXIT.configuration;
    }
    text = readFileSync(file, 'utf8');
  } catch {
    errOut(word('sentinel.cli.refusedUnreadable'));
    return EXIT.configuration;
  }
  const result = parseEnvelope(kind as EnvelopeKind, text);
  const schema = ENVELOPES[kind as EnvelopeKind].schema;
  if (json) out(JSON.stringify(result.ok ? { ok: true, schema } : { ok: false, schema, errors: result.errors }, null, 2));
  else if (result.ok) out(word('sentinel.cli.valid', { schema }));
  else {
    errOut(word('sentinel.cli.invalid', { schema }));
    // Printed words come from the catalog only; the validator's diagnostic detail stays in --json output.
    for (const e of result.errors.slice(0, 50)) errOut(`  ${e.code} ${e.path || '/'} ${word(e.code)}`);
    if (result.errors.length > 50) errOut(`  ${word('sentinel.cli.more', { count: result.errors.length - 50 })}`);
  }
  return result.ok ? EXIT.ok : EXIT.configuration;
}

export function main(argv: string[]): number {
  const json = argv.includes('--json');
  const args = argv.filter(a => a !== '--json');
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') { out(help()); return EXIT.ok; }
  if (command === '--version' || command === '-v') { out(word('sentinel.cli.version', { version: version(), draft: ENVELOPES.run.schema.split('/')[1]! })); return EXIT.ok; }
  if (command === 'capabilities') return capabilities(json);
  if (command === 'validate') return validate(rest[0], rest[1], json);
  if (Object.hasOwn(PLANNED, command)) {
    errOut(word('sentinel.cli.unavailable', { command, change: PLANNED[command]! }));
    return EXIT.configuration;
  }
  errOut(word('sentinel.cli.unknownCommand'));
  return EXIT.configuration;
}

process.exitCode = main(process.argv.slice(2));

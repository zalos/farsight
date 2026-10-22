#!/usr/bin/env node
// Placeholder executable: help, version, the explicit capability list and draft contract validation.
// No scan, ledger, scanner, container or model is started by any command here.
import { readFileSync, statSync } from 'node:fs';
import { CAPABILITIES } from './capabilities.js';
import { ENVELOPES, ENVELOPE_KINDS, MAX_ENVELOPE_BYTES, type EnvelopeKind } from './contracts/index.js';
import { parseEnvelope } from './validate.js';

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

const HELP = `farsight-sentinel — optional security-analysis companion to Farsight (draft; no scanner yet)

This build only defines and validates draft contracts. It cannot capture source, plan or run a scan,
and it never downloads a tool, starts a container or contacts a model provider.

usage:
  farsight-sentinel --help | --version
  farsight-sentinel capabilities [--json]      what this build can and cannot do, with reasons
  farsight-sentinel validate <kind> <file> [--json]
                                                check one JSON envelope against its draft schema
      kinds: ${ENVELOPE_KINDS.join(', ')}

planned, not available: ${Object.keys(PLANNED).join(', ')}

exit codes: 0 ok · 1 finding policy failed · 2 required coverage incomplete ·
            3 configuration or input error (also every unavailable command) · 4 awaiting owner confirmation
`;

function out(text: string) { process.stdout.write(text.endsWith('\n') ? text : `${text}\n`); }
function errOut(text: string) { process.stderr.write(text.endsWith('\n') ? text : `${text}\n`); }

function capabilities(json: boolean): number {
  if (json) { out(JSON.stringify({ version: version(), capabilities: CAPABILITIES }, null, 2)); return EXIT.ok; }
  for (const c of CAPABILITIES) out(`${c.state === 'unavailable' ? 'unavailable' : 'draft      '}  ${c.id.padEnd(26)} ${c.reasonCode} · ${c.plannedIn}`);
  return EXIT.ok;
}

function validate(kind: string | undefined, file: string | undefined, json: boolean): number {
  if (!kind || !file || !(ENVELOPE_KINDS as string[]).includes(kind)) {
    errOut(`usage: farsight-sentinel validate <${ENVELOPE_KINDS.join('|')}> <file>`);
    return EXIT.configuration;
  }
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > MAX_ENVELOPE_BYTES) {
      errOut(`refused: larger than ${MAX_ENVELOPE_BYTES} bytes`);
      return EXIT.configuration;
    }
    text = readFileSync(file, 'utf8');
  } catch {
    errOut('refused: cannot read that file');
    return EXIT.configuration;
  }
  const result = parseEnvelope(kind as EnvelopeKind, text);
  const schema = ENVELOPES[kind as EnvelopeKind].schema;
  if (json) out(JSON.stringify(result.ok ? { ok: true, schema } : { ok: false, schema, errors: result.errors }, null, 2));
  else if (result.ok) out(`valid ${schema}`);
  else {
    errOut(`invalid ${schema}`);
    for (const e of result.errors.slice(0, 50)) errOut(`  ${e.code} ${e.path || '/'} ${e.message}`);
    if (result.errors.length > 50) errOut(`  … ${result.errors.length - 50} more`);
  }
  return result.ok ? EXIT.ok : EXIT.configuration;
}

export function main(argv: string[]): number {
  const json = argv.includes('--json');
  const args = argv.filter(a => a !== '--json');
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') { out(HELP); return EXIT.ok; }
  if (command === '--version' || command === '-v') { out(`farsight-sentinel ${version()} · contracts ${ENVELOPES.run.schema.split('/')[1]}`); return EXIT.ok; }
  if (command === 'capabilities') return capabilities(json);
  if (command === 'validate') return validate(rest[0], rest[1], json);
  if (Object.hasOwn(PLANNED, command)) {
    errOut(`unavailable: '${command}' is not implemented in this draft build (planned in ${PLANNED[command]}). Nothing was started.`);
    return EXIT.configuration;
  }
  errOut(`unknown command; run farsight-sentinel --help`);
  return EXIT.configuration;
}

process.exitCode = main(process.argv.slice(2));

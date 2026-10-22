#!/usr/bin/env node
// The executable, the owner's entrypoint: help, version, capabilities, validation, workspace initialization,
// settings adoption, and a foundation-preview plan → run → status → report in the foreground. The commands that need
// the owner's background service (wait, pause, resume, cancel, retry, rerun, serve, run --detach) are refused as
// unavailable; nothing is started for them. No command downloads a tool, starts a container or contacts a model
// provider. Every result is typed (cli/outcome.ts); `--json` prints it whole, with the three verdicts.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { adoptWorkspaceSettings, planWorkspace, previewReport, runPlan, runStatus, workspaceOf, PolicyError } from './service/local.js';
import { renderPreviewJson, renderPreviewMarkdown } from './reports/preview.js';
import { CAPABILITIES } from './capabilities.js';
import { parseArgs, plannedIn, COMMANDS, type ParsedCommand } from './cli/args.js';
import { initWorkspace, InitError } from './cli/init.js';
import { result, type CommandResult } from './cli/outcome.js';
import { ENVELOPES, ENVELOPE_KINDS, MAX_ENVELOPE_BYTES, type EnvelopeKind } from './contracts/index.js';
import { parseEnvelope } from './validate.js';
// Every printed word comes from the shared catalog (strings-sentinel-cli.ts and strings-sentinel-service.ts).
import { sentinelWord, SENTINEL_CLI_STRINGS } from '@farsight/core/dist/strings-sentinel-cli.js';
import { sentinelServiceWord } from '@farsight/core/dist/strings-sentinel-service.js';

const word = (key: string, values: Record<string, string | number> = {}) =>
  (Object.hasOwn(SENTINEL_CLI_STRINGS, key) ? sentinelWord(key, values) : sentinelServiceWord(key, values));

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

function help(): string {
  const planned = (Object.keys(COMMANDS) as (keyof typeof COMMANDS)[]).filter(c => COMMANDS[c] !== null);
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
    `  ${word('sentinel.cli.usageInit')}`,
    `  ${word('sentinel.cli.usageSettings')}`,
    `  ${word('sentinel.cli.usagePlan')}`,
    `  ${word('sentinel.cli.usageRun')}`,
    `  ${word('sentinel.cli.usageStatus')}`,
    `  ${word('sentinel.cli.usageReport')}`,
    '',
    word('sentinel.cli.planned', { commands: planned.join(', ') }),
    '',
    word('sentinel.cli.exitCodes'),
  ].join('\n');
}

let jsonOut = false;
function out(text: string) { process.stdout.write(text.endsWith('\n') ? text : `${text}\n`); }
function errOut(text: string) { process.stderr.write(text.endsWith('\n') ? text : `${text}\n`); }
function finish(r: CommandResult): number {
  if (jsonOut) out(JSON.stringify(r, null, 2));
  return r.exitCode;
}

function capabilities(p: ParsedCommand): number {
  if (p.json) { out(JSON.stringify({ version: version(), capabilities: CAPABILITIES }, null, 2)); return 0; }
  const state = (c: (typeof CAPABILITIES)[number]) => word(c.state === 'unavailable' ? 'sentinel.cli.stateUnavailable' : 'sentinel.cli.stateDraft');
  const width = Math.max(...CAPABILITIES.map(c => state(c).length));
  for (const c of CAPABILITIES) {
    out(`${state(c).padEnd(width)}  ${c.id.padEnd(26)} ${word(c.reasonCode)} · ${word('sentinel.cli.plannedIn', { change: c.plannedIn })}`);
  }
  return 0;
}

function validate(p: ParsedCommand): number {
  const kind = p.args.kind;
  const file = p.args.file;
  if (!kind || !file || !(ENVELOPE_KINDS as string[]).includes(kind)) {
    errOut(word('sentinel.cli.validateUsage', { kinds: ENVELOPE_KINDS.join('|') }));
    return 3;
  }
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > MAX_ENVELOPE_BYTES) {
      errOut(word('sentinel.cli.refusedTooLarge', { bytes: MAX_ENVELOPE_BYTES }));
      return 3;
    }
    text = readFileSync(file, 'utf8');
  } catch {
    errOut(word('sentinel.cli.refusedUnreadable'));
    return 3;
  }
  const r = parseEnvelope(kind as EnvelopeKind, text);
  const schema = ENVELOPES[kind as EnvelopeKind].schema;
  if (p.json) out(JSON.stringify(r.ok ? { ok: true, schema } : { ok: false, schema, errors: r.errors }, null, 2));
  else if (r.ok) out(word('sentinel.cli.valid', { schema }));
  else {
    errOut(word('sentinel.cli.invalid', { schema }));
    // Printed words come from the catalog only; the validator's diagnostic detail stays in --json output.
    for (const e of r.errors.slice(0, 50)) errOut(`  ${e.code} ${e.path || '/'} ${word(e.code)}`);
    if (r.errors.length > 50) errOut(`  ${word('sentinel.cli.more', { count: r.errors.length - 50 })}`);
  }
  return r.ok ? 0 : 3;
}

function init(p: ParsedCommand): number {
  const workspace = typeof p.flags['--workspace'] === 'string' ? p.flags['--workspace'] : process.cwd();
  const profile = typeof p.flags['--profile'] === 'string' ? p.flags['--profile'] : undefined;
  let done;
  try {
    done = initWorkspace({ workspace, ...(profile === undefined ? {} : { profile }) });
  } catch (e) {
    if (!(e instanceof InitError)) throw e;
    errOut(word(e.code, { detail: e.detail }));
    return finish(result('init', 'refused', { reasonCode: e.code, facts: { workspace } }));
  }
  const facts = { path: done.path, digest: done.digest, profile: done.profile, recognised: done.recognised, downloads: 0, scansStarted: 0 };
  if (!done.recognised) {
    errOut(word('sentinel.init.unrecognised'));
    return finish(result('init', 'refused', { reasonCode: 'sentinel.init.unrecognised', facts }));
  }
  if (!jsonOut) {
    out(word(done.outcome === 'prepared' ? 'sentinel.init.created' : 'sentinel.init.kept', { path: done.path }));
    out(word('sentinel.init.profile', { profile: done.profile }));
    out(word('sentinel.init.prerequisites'));
    out(word('sentinel.init.credentials'));
    out(word('sentinel.init.noEffects'));
    out(word('sentinel.init.next'));
  }
  return finish(result('init', done.outcome, { facts }));
}

/** The workspace a command acts on: --workspace or the current folder, by its canonical path. */
function workspaceFor(p: ParsedCommand) {
  const given = typeof p.flags['--workspace'] === 'string' ? p.flags['--workspace'] : process.cwd();
  return workspaceOf(realpathSync.native(given));
}

/** Prints a service result: JSON whole, or its outcome words, reason and the facts a reader needs. */
function serviceOut(r: CommandResult, lines: string[] = []): number {
  if (!jsonOut) {
    for (const l of lines) out(l);
    const head = word(`sentinel.outcome.${r.outcome.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`);
    (r.exitCode === 0 ? out : errOut)(r.reasonCode && r.reasonCode !== 'sentinel.outcome.unavailable' ? `${head}: ${word(r.reasonCode)}` : head);
  }
  return finish(r);
}

async function owner(p: ParsedCommand): Promise<number> {
  const now = new Date();
  const confirm = p.flags['--confirm'] === true;
  try {
    const ws = workspaceFor(p);
    if (p.command === 'settings') {
      if (p.args.action !== 'adopt') {
        errOut(word('sentinel.args.unexpectedArgument', { detail: String(p.args.action) }));
        return finish(result('settings', 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
      }
      const r = adoptWorkspaceSettings(ws, { confirm, now });
      return serviceOut(r, [`settings ${String(r.facts.settingsDigest)}`]);
    }
    if (p.command === 'plan') {
      const r = await planWorkspace(ws, { confirm, now });
      return serviceOut(r, r.disclosure ? [`plan ${r.disclosure.planId} · ${r.disclosure.planDigest} · effects: ${r.disclosure.effects.join(', ')} · ${word('sentinel.report.previewOnly')}`] : []);
    }
    if (p.command === 'run') {
      if (p.flags['--detach'] === true) {
        errOut(word('sentinel.service.detachUnavailable'));
        return finish(result('run', 'unavailable', { reasonCode: 'sentinel.service.detachUnavailable' }));
      }
      const r = await runPlan(ws, { planId: p.args.planId!, confirm, now });
      return serviceOut(r, r.facts.runId ? [`run ${String(r.facts.runId)} · ${String(r.facts.state)} · preview findings: ${String(r.facts.previewFindings)}`] : []);
    }
    if (p.command === 'status') {
      const num = (f: string) => (typeof p.flags[f] === 'string' ? Number(p.flags[f]) : undefined);
      const after = num('--after');
      const limit = num('--limit');
      if ((after !== undefined && !Number.isSafeInteger(after)) || (limit !== undefined && !Number.isSafeInteger(limit))) {
        errOut(word('sentinel.args.missingValue', { detail: '--after/--limit' }));
        return finish(result('status', 'refused', { reasonCode: 'sentinel.args.missingValue' }));
      }
      const r = await runStatus(ws, { runId: p.args.runId!, ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit }) });
      return serviceOut(r, r.facts.state ? [`run ${p.args.runId} · ${String(r.facts.state)}`] : []);
    }
    // report
    const format = typeof p.flags['--format'] === 'string' ? p.flags['--format'] : 'md';
    if (format !== 'md' && format !== 'json') {
      errOut(word('sentinel.args.unexpectedArgument', { detail: format }));
      return finish(result('report', 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
    }
    const doc = await previewReport(ws, { runId: p.args.runId!, now });
    if ('outcome' in doc) return serviceOut(doc);
    out(format === 'json' || jsonOut ? renderPreviewJson(doc) : renderPreviewMarkdown(doc));
    return 0;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (e instanceof PolicyError || (typeof code === 'string' && code.startsWith('sentinel.'))) {
      errOut(`${code}: ${(e as Error).message}`);
      return finish(result(p.command, 'configuration-failure', { reasonCode: code }));
    }
    throw e;
  }
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  jsonOut = parsed.ok ? parsed.parsed.json : parsed.json;
  if (!parsed.ok) {
    errOut(word(parsed.code, { detail: parsed.detail }));
    return finish(result('unknown', 'refused', { reasonCode: parsed.code }));
  }
  const p = parsed.parsed;
  switch (p.command) {
    case 'help': out(help()); return 0;
    case 'version': out(word('sentinel.cli.version', { version: version(), draft: ENVELOPES.run.schema.split('/')[1]! })); return 0;
    case 'capabilities': return capabilities(p);
    case 'validate': return validate(p);
    case 'init': return init(p);
    case 'settings': case 'plan': case 'run': case 'status': case 'report': return owner(p);
    default: {
      const change = plannedIn(p.command)!;
      errOut(word('sentinel.cli.unavailable', { command: p.command, change }));
      return finish(result(p.command, 'unavailable', { reasonCode: 'sentinel.outcome.unavailable', facts: { plannedIn: change } }));
    }
  }
}

process.exitCode = await main(process.argv.slice(2));

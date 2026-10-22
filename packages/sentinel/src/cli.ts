#!/usr/bin/env node
// The executable, the owner's entrypoint: help, version, capabilities, validation, workspace initialization,
// settings adoption, and a foundation-preview plan → run → status → report, in the foreground or handed to the owner's
// background service (serve, run --detach, wait, pause, resume, cancel). Retry and rerun are refused as unavailable.
// No command downloads a tool, starts a container or contacts a model provider. Every result is typed
// (cli/outcome.ts); `--json` prints it whole, with the three verdicts.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import {
  adoptWorkspaceSettings, confirmForService, currentRules, promoteRulePack, planWorkspace, previewReport, runPlan, runResultIn, runStatus, workspaceOf, PolicyError,
  type Workspace,
} from './service/local.js';
import { connectService, serveWorkspace } from './service/owner-service.js';
import { launchService } from './service/launch.js';
import { builtinPackDir } from './service/preview-plan.js';
import { openStore } from './store/index.js';
import type { ServiceClient } from './transport/ipc.js';
import type { PreviewReport } from './reports/preview.js';
import { renderPreviewJson, renderPreviewMarkdown } from './reports/preview.js';
import { PREVIEW_DETECTOR_ID, runPreviewWorker } from './adapters/preview-detector.js';
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
    `  ${word('sentinel.cli.usageDetach')}`,
    `  ${word('sentinel.cli.usageStatus')}`,
    `  ${word('sentinel.cli.usageWait')}`,
    `  ${word('sentinel.cli.usageControls')}`,
    `  ${word('sentinel.cli.usageReport')}`,
    `  ${word('sentinel.cli.usageServe')}`,
    `  ${word('sentinel.cli.usageRules')}`,
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
  if (p.json) return finish(result('capabilities', 'answered', { facts: { version: version(), capabilities: CAPABILITIES } }));
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
  const refuse = (reasonCode: string, values: Record<string, string | number> = {}) => {
    errOut(word(reasonCode, values));
    return finish(result('validate', 'refused', { reasonCode, facts: { kind: kind ?? null } }));
  };
  if (!kind || !file || !(ENVELOPE_KINDS as string[]).includes(kind)) return refuse('sentinel.cli.validateUsage', { kinds: ENVELOPE_KINDS.join('|') });
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > MAX_ENVELOPE_BYTES) return refuse('sentinel.cli.refusedTooLarge', { bytes: MAX_ENVELOPE_BYTES });
    text = readFileSync(file, 'utf8');
  } catch {
    return refuse('sentinel.cli.refusedUnreadable');
  }
  const r = parseEnvelope(kind as EnvelopeKind, text);
  const schema = ENVELOPES[kind as EnvelopeKind].schema;
  if (p.json) {
    return finish(r.ok
      ? result('validate', 'answered', { facts: { ok: true, schema } })
      : result('validate', 'refused', { reasonCode: 'sentinel.cli.invalid', facts: { ok: false, schema, errors: r.errors } }));
  }
  if (r.ok) out(word('sentinel.cli.valid', { schema }));
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

const SERVICE_START_MS = 15_000;
const DETACHED_IDLE_MS = 15_000;
const DEFAULT_WAIT_MS = 600_000;

/** The workspace's running service, started detached (as this same executable, `serve`) when none answers. */
async function ensureService(ws: Workspace): Promise<ServiceClient | undefined> {
  const live = await connectService(ws);
  if (live) return live;
  const launched = launchService(ws.path, DETACHED_IDLE_MS);
  // Two commands may start a service at once; the loser cannot open the store and exits, and both reach the winner.
  try {
    for (const end = Date.now() + SERVICE_START_MS; Date.now() < end;) {
      await new Promise(r => setTimeout(r, 100));
      const c = await connectService(ws);
      if (c) return c;
    }
  } catch (e) {
    launched.stop();
    throw e;
  }
  // Nothing answered in time: stop exactly the process this command started, by its own handle.
  launched.stop();
  return undefined;
}

/** Sends one request and closes the connection: the run continues whatever happens to this command. */
async function ask(client: ServiceClient, op: string, body: Record<string, unknown>, timeoutMs?: number): Promise<CommandResult> {
  try { return await client.request(op, body, timeoutMs === undefined ? {} : { timeoutMs }) as CommandResult; } finally { client.close(); }
}

async function owner(p: ParsedCommand): Promise<number> {
  const now = new Date();
  const confirm = p.flags['--confirm'] === true;
  try {
    const ws = workspaceFor(p);
    const format = typeof p.flags['--format'] === 'string' ? p.flags['--format'] : 'md';
    if (p.command === 'report' && format !== 'md' && format !== 'json') {
      errOut(word('sentinel.args.unexpectedArgument', { detail: format }));
      return finish(result('report', 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
    }
    if (p.command === 'serve') return await serve(p, ws);
    if (p.command === 'wait') return await waitFor(p, ws);
    if ((p.command === 'run' && p.flags['--detach'] === true) || p.command === 'resume' || p.command === 'pause' || p.command === 'cancel') {
      // Writes on a run. First the owner's decision against the plan (without --confirm it stops here, exit 4, and
      // starts nothing); then the service is reached and the owner's receipt is minted for exactly its store and this
      // run, and spent there once. Pause needs a run the service is executing; start, resume and cancel may start it.
      const runId = (p.args.planId ?? p.args.runId)!;
      const action = p.command === 'pause' ? 'run.pause' as const : p.command === 'cancel' ? 'run.cancel' as const : 'run.start' as const;
      const shown = confirmForService(ws, { command: p.command, action, planId: runId, confirm: false, now });
      if (!confirm || ('result' in shown && shown.result.outcome !== 'awaiting-confirmation')) return serviceOut('result' in shown ? shown.result : result(p.command, 'refused'));
      const client = p.command === 'pause' ? await connectService(ws) : await ensureService(ws);
      if (!client) {
        return serviceOut(result(p.command, p.command === 'pause' ? 'refused' : 'configuration-failure',
          { reasonCode: p.command === 'pause' ? 'sentinel.service.notRunning' : 'sentinel.service.startFailed', facts: { runId } }));
      }
      const confirmed = confirmForService(ws, { command: p.command, action, planId: runId, confirm: true, now, storeId: client.storeId });
      if ('result' in confirmed) { client.close(); return serviceOut(confirmed.result); }
      const r = action === 'run.start'
        ? await ask(client, 'run.start', { planId: runId, receiptId: confirmed.receiptId })
        : await ask(client, action, { runId, receiptId: confirmed.receiptId });
      return serviceOut(r, r.facts.runId ? [`run ${String(r.facts.runId)} · ${String(r.facts.state)}${r.facts.joined === true ? ' · joined' : ''}`] : []);
    }
    // While the service runs it alone holds the store: reads go through it, and nothing new is planned or run here.
    const live = await connectService(ws);
    if (live && (p.command === 'plan' || p.command === 'run')) {
      live.close();
      return serviceOut(result(p.command, 'configuration-failure', { reasonCode: 'sentinel.service.ownerServiceRunning' }));
    }
    if (live && p.command === 'status') {
      const num = (f: string) => (typeof p.flags[f] === 'string' ? Number(p.flags[f]) : undefined);
      const after = num('--after');
      const limit = num('--limit');
      if ((after !== undefined && !(Number.isSafeInteger(after) && after >= 0)) || (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 0))) {
        live.close();
        errOut(word('sentinel.args.missingValue', { detail: '--after/--limit' }));
        return finish(result('status', 'refused', { reasonCode: 'sentinel.args.missingValue' }));
      }
      const r = await ask(live, 'run.status', { runId: p.args.runId!, ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit }) });
      return serviceOut(r, r.facts.state ? [`run ${p.args.runId} · ${String(r.facts.state)}`] : []);
    }
    if (live && p.command === 'report') {
      const doc = await ask(live, 'report', { runId: p.args.runId! }) as unknown as PreviewReport | CommandResult;
      return printReport(p, doc);
    }
    live?.close();
    if (p.command === 'settings') {
      if (p.args.action !== 'adopt') {
        errOut(word('sentinel.args.unexpectedArgument', { detail: String(p.args.action) }));
        return finish(result('settings', 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
      }
      const r = adoptWorkspaceSettings(ws, { confirm, now });
      return serviceOut(r, [`settings ${String(r.facts.settingsDigest)}`]);
    }
    if (p.command === 'rules') {
      // The owner's rule lock lives in the owner's private state, not the store: it works with or without a service.
      if (p.args.action === 'show' && p.args.packDir === undefined) return serviceOut(currentRules(ws), []);
      if (p.args.action !== 'promote' || p.args.packDir === undefined) {
        errOut(word('sentinel.args.unexpectedArgument', { detail: String(p.args.action) }));
        return finish(result('rules', 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
      }
      // `builtin:<name>` is a pack this package ships; anything else is a folder the owner names.
      const named = p.args.packDir.startsWith('builtin:') ? builtinPackDir(p.args.packDir.slice('builtin:'.length)) : p.args.packDir;
      if (named === undefined) {
        errOut(word('sentinel.args.unexpectedArgument', { detail: p.args.packDir }));
        return finish(result('rules', 'refused', { reasonCode: 'sentinel.args.unexpectedArgument' }));
      }
      const r = promoteRulePack(ws, { packDir: realpathSync.native(named), confirm, now });
      return serviceOut(r, [`pack ${String(r.facts.packId)} ${String(r.facts.version)} · candidate ${String(r.facts.candidate)} · replaces lock ${String(r.facts.previousLock)}${r.facts.lock ? ` · now lock ${String(r.facts.lock)}` : ''}`]);
    }
    if (p.command === 'plan') {
      const r = await planWorkspace(ws, { confirm, now });
      return serviceOut(r, r.disclosure ? [`plan ${r.disclosure.planId} · ${r.disclosure.planDigest} · effects: ${r.disclosure.effects.join(', ')} · ${word('sentinel.report.previewOnly')}`] : []);
    }
    if (p.command === 'run') {
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
    return printReport(p, await previewReport(ws, { runId: p.args.runId!, now }));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (e instanceof PolicyError || (typeof code === 'string' && code.startsWith('sentinel.'))) {
      errOut(`${code}: ${(e as Error).message}`);
      return finish(result(p.command, 'configuration-failure', { reasonCode: code }));
    }
    throw e;
  }
}

function printReport(p: ParsedCommand, doc: PreviewReport | CommandResult): number {
  const format = typeof p.flags['--format'] === 'string' ? p.flags['--format'] : 'md';
  {
    if ('outcome' in doc) return serviceOut(doc);
    // --json is the typed result with the report inside it; --format json alone prints the report document.
    if (jsonOut) return finish(result('report', 'answered', { facts: { report: doc } }));
    out(format === 'json' ? renderPreviewJson(doc) : renderPreviewMarkdown(doc));
    return 0;
  }
}

/** `serve`: the owner's background service for this workspace, until it is stopped or idle. */
async function serve(p: ParsedCommand, ws: Workspace): Promise<number> {
  const idle = typeof p.flags['--idle-ms'] === 'string' ? Number(p.flags['--idle-ms']) : 0;
  if (!Number.isSafeInteger(idle) || idle < 0 || idle > 86_400_000) {
    errOut(word('sentinel.args.missingValue', { detail: '--idle-ms' }));
    return finish(result('serve', 'refused', { reasonCode: 'sentinel.args.missingValue' }));
  }
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await serveWorkspace(ws, { idleMs: idle, signal: stop.signal, onListening: () => {
      if (!jsonOut) out(word(idle > 0 ? 'sentinel.service.serving' : 'sentinel.service.servingForever', { workspace: ws.path, idle }));
    } });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return finish(result('serve', 'answered', { facts: { workspace: ws.path, stopped: true } }));
}

/** `wait`: the run's result once it ends, or `submitted` (still running) when the wait does. */
async function waitFor(p: ParsedCommand, ws: Workspace): Promise<number> {
  const runId = p.args.runId!;
  const total = typeof p.flags['--timeout'] === 'string' ? Number(p.flags['--timeout']) : DEFAULT_WAIT_MS;
  if (!Number.isSafeInteger(total) || total < 0) {
    errOut(word('sentinel.args.missingValue', { detail: '--timeout' }));
    return finish(result('wait', 'refused', { reasonCode: 'sentinel.args.missingValue' }));
  }
  const end = Date.now() + total;
  for (;;) {
    const client = await connectService(ws);
    if (!client) {
      // Nothing is executing it: the store says whether it finished, stopped or was interrupted.
      const store = await openStore(ws.storePath);
      try { return serviceOut(await runResultIn(store, 'wait', runId, { executing: false })); } finally { store.close(); }
    }
    const slice = Math.max(0, Math.min(end - Date.now(), 20_000));
    const r = await ask(client, 'run.wait', { runId, timeoutMs: slice }, slice + 10_000);
    if (r.outcome !== 'submitted' || Date.now() >= end) return serviceOut(r, r.facts.state ? [`run ${runId} · ${String(r.facts.state)}`] : []);
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
  try {
    return await dispatch(p);
  } catch (e) {
    // Whatever failed, the caller gets a typed result and a catalog word, not a stack trace.
    errOut(word('sentinel.cli.unexpected', { detail: (e as { code?: unknown }).code !== undefined ? String((e as { code?: unknown }).code) : (e as Error)?.name ?? 'error' }));
    return finish(result(p.command, 'configuration-failure', { reasonCode: 'sentinel.cli.unexpected' }));
  }
}

async function dispatch(p: ParsedCommand): Promise<number> {
  switch (p.command) {
    case 'help':
      if (p.json) return finish(result('help', 'answered', { facts: { text: help() } }));
      out(help()); return 0;
    case 'version': {
      const facts = { version: version(), contracts: ENVELOPES.run.schema.split('/')[1]! };
      if (p.json) return finish(result('version', 'answered', { facts }));
      out(word('sentinel.cli.version', { version: facts.version, draft: facts.contracts })); return 0;
    }
    case 'capabilities': return capabilities(p);
    case 'validate': return validate(p);
    case 'init': return init(p);
    case 'settings': case 'plan': case 'run': case 'status': case 'report':
    case 'serve': case 'wait': case 'pause': case 'resume': case 'cancel': case 'rules': return owner(p);
    default: {
      const change = plannedIn(p.command)!;
      errOut(word('sentinel.cli.unavailable', { command: p.command, change }));
      return finish(result(p.command, 'unavailable', { reasonCode: 'sentinel.outcome.unavailable', facts: { plannedIn: change } }));
    }
  }
}

// The coordinator starts the preview detector as this same executable, with its adapter identity in the (otherwise
// empty) environment: then this process is that worker, not the command line. Nothing else selects it.
if (process.env.SENTINEL_ADAPTER_ID === PREVIEW_DETECTOR_ID) await runPreviewWorker();
else process.exitCode = await main(process.argv.slice(2));

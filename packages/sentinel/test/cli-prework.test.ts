// PR 09 prework: argument parsing, typed outcomes and exits, the actor rule, idempotent init, the local socket's
// identity and length guards with its handshake, and the preview report. No scan, scanner, container, model or
// network is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../dist/cli/args.js';
import { OUTCOME_EXIT_CODES, isFinalPolicyResult, result } from '../dist/cli/outcome.js';
import { ActorError, assertMayConfirm, refuseActorClaims, requestedByOf } from '../dist/cli/actor.js';
import { DEFAULT_SETTINGS, initWorkspace, InitError } from '../dist/cli/init.js';
import {
  FrameDecoder, IpcError, MAX_FRAME_BYTES, connectOwnerSocket, encodeFrame, fitsSocketPath, listenOwnerSocket, newOwnerNonce,
  runtimeAddress, socketPathLimit,
} from '../dist/transport/ipc.js';
import { checkPreviewReport, renderPreviewJson, renderPreviewMarkdown } from '../dist/reports/preview.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const cli = (args: string[], cwd?: string) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, timeout: 20_000 });

function scratch(t: { after(fn: () => void): void }, prefix = 'sentinel-cli-'): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('arguments: each command takes only its own flags; typos and repeats are refused, never ignored', () => {
  const ok = (argv: string[]) => { const r = parseArgs(argv); assert.ok(r.ok, JSON.stringify(r)); return r.parsed; };
  const no = (argv: string[], code: string) => { const r = parseArgs(argv); assert.ok(!r.ok); assert.equal(r.code, code, argv.join(' ')); };
  assert.equal(ok([]).command, 'help');
  assert.equal(ok(['--version']).command, 'version');
  assert.deepEqual(ok(['init', '--workspace', '/w', '--json']).flags, { '--workspace': '/w', '--json': true });
  assert.deepEqual(ok(['init', '--workspace=/w']).flags, { '--workspace': '/w' });
  assert.deepEqual(ok(['validate', 'run', 'f.json']).args, { kind: 'run', file: 'f.json' });
  no(['init', '--worksapce', '/w'], 'sentinel.args.unknownFlag');
  no(['init', '--workspace'], 'sentinel.args.missingValue');
  no(['init', '--workspace', '--json'], 'sentinel.args.missingValue');
  no(['init', '--profile', 'a', '--profile', 'b'], 'sentinel.args.repeatedFlag');
  no(['init', 'extra'], 'sentinel.args.unexpectedArgument');
  no(['validate', 'run'], 'sentinel.args.missingArgument');
  no(['capabilities', '--json=yes'], 'sentinel.args.unexpectedArgument');
  no(['scan-everything'], 'sentinel.args.unknownCommand');
  // A command this build does not run is refused as unavailable, whatever its arguments.
  assert.equal(ok(['run']).command, 'run');
  assert.ok(parseArgs(['nonsense', '--json']).ok === false && (parseArgs(['nonsense', '--json']) as { json: boolean }).json);
});

test('outcomes: Sentinel exit codes, and no confirmation or submission can read as a finished scan', () => {
  assert.deepEqual(OUTCOME_EXIT_CODES, {
    'satisfied': 0, 'finding-policy-failed': 1, 'required-coverage-incomplete': 2, 'configuration-failure': 3, 'awaiting-confirmation': 4,
    submitted: 0, answered: 0, prepared: 0, kept: 0, unavailable: 3, refused: 3,
  });
  for (const o of ['awaiting-confirmation', 'submitted', 'unavailable', 'prepared', 'kept', 'answered', 'refused', 'configuration-failure'] as const) {
    assert.equal(isFinalPolicyResult(o), false, o);
  }
  for (const o of ['satisfied', 'finding-policy-failed', 'required-coverage-incomplete'] as const) assert.equal(isFinalPolicyResult(o), true);
  const r = result('run', 'awaiting-confirmation');
  assert.deepEqual([r.outcome, r.exitCode], ['awaiting-confirmation', 4]);
  assert.deepEqual(Object.keys(r.verdicts), ['policy', 'capability', 'credential'], 'JSON always carries the three verdicts');
  assert.ok(Object.values(r.verdicts).every(v => !v.asked && !v.allowed));
  // A detached submission exits 0 but its word is never "satisfied".
  assert.deepEqual([result('run', 'submitted').outcome, result('run', 'submitted').exitCode], ['submitted', 0]);
});

test('the actor is the entrypoint\'s: a payload cannot name one, and only the owner channel can confirm', () => {
  assert.deepEqual(requestedByOf({ kind: 'owner-cli' }), { principal: 'human', channel: 'owner-cli' });
  assert.deepEqual(requestedByOf({ kind: 'service-connection', granted: { principal: 'agent', channel: 'mcp' } }), { principal: 'agent', channel: 'mcp' });
  for (const granted of [{ principal: 'human', channel: 'owner-cli' }, { principal: 'human', channel: 'mcp' }, { principal: 'agent', channel: 'owner-cli' }]) {
    assert.throws(() => requestedByOf({ kind: 'service-connection', granted: granted as never }),
      (e: unknown) => e instanceof ActorError && e.code === 'sentinel.actor.ownerChannelNotGrantable', JSON.stringify(granted));
  }
  for (const body of [{ actor: 'human' }, { plan: { requestedBy: { principal: 'human' } } }, [{ x: { who: 'owner' } }], { confirmedBy: 'owner' }]) {
    assert.throws(() => refuseActorClaims(body), (e: unknown) => e instanceof ActorError && e.code === 'sentinel.actor.payloadClaim', JSON.stringify(body));
  }
  assert.deepEqual(refuseActorClaims({ planId: 'p', options: { detach: true }, receiptId: 'r-1' }), { planId: 'p', options: { detach: true }, receiptId: 'r-1' },
    'a receipt id may travel; the service verifies it');
  assertMayConfirm({ principal: 'human', channel: 'owner-cli' });
  for (const by of [{ principal: 'agent', channel: 'mcp' }, { principal: 'human', channel: 'http-bridge' }, { principal: 'agent', channel: 'owner-cli' }] as const) {
    assert.throws(() => assertMayConfirm(by), (e: unknown) => e instanceof ActorError && e.code === 'sentinel.actor.confirmNotOwner', JSON.stringify(by));
  }
});

test('init writes the private settings once and never again; it downloads and starts nothing', t => {
  const ws = scratch(t);
  const first = initWorkspace({ workspace: ws });
  assert.equal(first.outcome, 'prepared');
  const path = join(ws, '.farsight/sentinel/settings.json');
  assert.equal(first.path, path);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(ws, '.farsight/sentinel')).mode & 0o777, 0o700);
  // Twice: the owner's edits survive byte for byte.
  const edited = readFileSync(path, 'utf8').replace('"medium"', '"high"');
  writeFileSync(path, edited);
  const second = initWorkspace({ workspace: ws });
  assert.equal(second.outcome, 'kept');
  assert.equal(readFileSync(path, 'utf8'), edited);
  assert.notEqual(second.digest, first.digest);
  assert.deepEqual(readFileSync(path, 'utf8').match(/keychain|password|token/gi), null, 'the defaults hold no credential');
  // The executable: twice, as an npm-only consumer would, from the workspace.
  const ws2 = scratch(t);
  const a = cli(['init', '--json'], ws2);
  assert.equal(a.status, 0, a.stderr);
  const body = JSON.parse(a.stdout);
  assert.deepEqual([body.outcome, body.facts.downloads, body.facts.scansStarted], ['prepared', 0, 0]);
  const before = readFileSync(join(ws2, '.farsight/sentinel/settings.json'));
  const b = cli(['init'], ws2);
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /kept .*settings\.json unchanged/);
  assert.match(b.stdout, /nothing was downloaded and no scan was started/);
  assert.deepEqual(readFileSync(join(ws2, '.farsight/sentinel/settings.json')), before);
});

test('init refuses an unsafe path or an unknown profile and leaves a foreign file as it is', t => {
  const ws = scratch(t);
  assert.throws(() => initWorkspace({ workspace: 'relative' }), (e: unknown) => e instanceof InitError && e.code === 'sentinel.init.workspaceUnsafe');
  assert.throws(() => initWorkspace({ workspace: ws, profile: 'deep' }), (e: unknown) => e instanceof InitError && e.code === 'sentinel.init.profileUnknown');
  mkdirSync(join(ws, '.farsight/sentinel'), { recursive: true, mode: 0o700 });
  symlinkSync(join(ws, 'elsewhere.json'), join(ws, '.farsight/sentinel/settings.json'));
  assert.throws(() => initWorkspace({ workspace: ws }), (e: unknown) => e instanceof InitError && e.code === 'sentinel.init.settingsUnsafe');
  assert.equal(existsSync(join(ws, 'elsewhere.json')), false, 'a link is never followed or written through');
  const ws2 = scratch(t);
  mkdirSync(join(ws2, '.farsight/sentinel'), { recursive: true, mode: 0o700 });
  writeFileSync(join(ws2, '.farsight/sentinel/settings.json'), 'not json');
  const r = cli(['init', '--json'], ws2);
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).reasonCode, 'sentinel.init.unrecognised');
  assert.equal(readFileSync(join(ws2, '.farsight/sentinel/settings.json'), 'utf8'), 'not json');
  // Recognised means PR 06's parser accepts it: a settings file holding a credential value is not, and is kept as is.
  const ws3 = scratch(t);
  initWorkspace({ workspace: ws3 });
  const p3 = join(ws3, '.farsight/sentinel/settings.json');
  const withSecret = JSON.stringify({ ...JSON.parse(readFileSync(p3, 'utf8')), mandatoryRules: ['ghp_' + 'a'.repeat(36)] });
  writeFileSync(p3, withSecret);
  const again = initWorkspace({ workspace: ws3 });
  assert.deepEqual([again.outcome, again.recognised], ['kept', false]);
  assert.equal(readFileSync(p3, 'utf8'), withSecret);
});

test('socket paths are measured in bytes with room for the terminator, and fall back to a short private folder', t => {
  assert.equal(socketPathLimit('darwin'), 103);
  assert.equal(socketPathLimit('linux'), 107);
  assert.throws(() => socketPathLimit('win32'), (e: unknown) => e instanceof IpcError && e.code === 'sentinel.ipc.platformUnsupported');
  assert.equal(fitsSocketPath(`/${'a'.repeat(102)}`, 'darwin'), true);
  assert.equal(fitsSocketPath(`/${'a'.repeat(103)}`, 'darwin'), false, '104 bytes leave no room for the terminator');
  assert.equal(fitsSocketPath(`/${'é'.repeat(51)}`, 'darwin'), true, '103 bytes');
  assert.equal(fitsSocketPath(`/${'é'.repeat(52)}`, 'darwin'), false, 'two bytes per character');
  const deep = join(scratch(t), 'x'.repeat(120));
  mkdirSync(deep);
  const a = runtimeAddress({ storePath: '/canonical/store', ownerNonce: newOwnerNonce(), env: { TMPDIR: deep } });
  t.after(() => rmSync(a.dir, { recursive: true, force: true }));
  assert.ok(a.dir.startsWith(realpathSync.native('/tmp')), 'a too-deep base is replaced by a short folder under /tmp');
  assert.ok(fitsSocketPath(a.socket));
  assert.equal(lstatSync(a.dir).mode & 0o777, 0o700);
  // A deterministic folder that is not private is refused, never repaired.
  const base = scratch(t, 'snb-');
  const nonce = newOwnerNonce();
  const first = runtimeAddress({ storePath: '/s', ownerNonce: nonce, env: { TMPDIR: base } });
  assert.equal(runtimeAddress({ storePath: '/s', ownerNonce: nonce, env: { TMPDIR: base } }).socket, first.socket, 'stable for one owner');
  chmodSync(first.dir, 0o755);
  assert.throws(() => runtimeAddress({ storePath: '/s', ownerNonce: nonce, env: { TMPDIR: base } }),
    (e: unknown) => e instanceof IpcError && e.code === 'sentinel.ipc.runtimeDirUnsafe');
});

test('frames are bounded and well formed', () => {
  const d = new FrameDecoder();
  const two = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 'é' })]);
  assert.deepEqual(d.push(two.subarray(0, 5)), []);
  assert.deepEqual(d.push(two.subarray(5)), [{ a: 1 }, { b: 'é' }]);
  const huge = Buffer.alloc(4);
  huge.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  assert.throws(() => new FrameDecoder().push(huge), (e: unknown) => e instanceof IpcError && e.code === 'sentinel.ipc.frameTooLarge');
  const bad = Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from('{x')]);
  assert.throws(() => new FrameDecoder().push(bad), (e: unknown) => e instanceof IpcError && e.code === 'sentinel.ipc.frameMalformed');
  assert.throws(() => encodeFrame('x'.repeat(MAX_FRAME_BYTES)), (e: unknown) => e instanceof IpcError && e.code === 'sentinel.ipc.frameTooLarge');
});

test('the owner socket: private, handshaken, granted per client kind, refusing payload actors and impostors', async t => {
  const base = scratch(t, 'snc-');
  const identity = { storeId: 'store-1', ownerNonce: newOwnerNonce() };
  const address = runtimeAddress({ storePath: '/canonical/store', ownerNonce: identity.ownerNonce, env: { TMPDIR: base } });
  const seen: unknown[] = [];
  const server = await listenOwnerSocket(address, identity, async (op, body, by) => { seen.push({ op, body, by }); return { op, by }; });
  t.after(() => server.close());
  assert.equal(lstatSync(address.socket).mode & 0o777, 0o600);
  assert.ok(lstatSync(address.socket).isSocket());

  const mcp = await connectOwnerSocket(address, identity, 'mcp');
  assert.deepEqual(await mcp.request('status', { runId: 'r-1' }), { op: 'status', by: { principal: 'agent', channel: 'mcp' } });
  assert.throws(() => mcp.request('run.start', { planId: 'p', requestedBy: { principal: 'human' } }), (e: unknown) => e instanceof ActorError);
  mcp.close();
  // Even the owner's own CLI is a non-owner over the socket: no hello selects owner authority, so it cannot confirm.
  const owner = await connectOwnerSocket(address, identity, 'cli');
  const granted = await owner.request('status', {}) as { by: { principal: 'human' | 'agent'; channel: 'owner-cli' } };
  assert.deepEqual(granted.by, { principal: 'agent', channel: 'local-service' });
  assert.throws(() => assertMayConfirm(granted.by), (e: unknown) => e instanceof ActorError && e.code === 'sentinel.actor.confirmNotOwner');
  owner.close();
  // A hello that tries to claim more is refused before any request runs.
  const sneaky = connect(address.socket);
  await new Promise(r => sneaky.once('connect', r));
  const sneakyReplies = new FrameDecoder();
  const sneakyGot: unknown[] = [];
  sneaky.on('data', c => sneakyGot.push(...sneakyReplies.push(c)));
  sneaky.write(encodeFrame({ protocol: 'sentinel-service/draft-1', type: 'hello', client: 'cli', principal: 'human', channel: 'owner-cli' }));
  await new Promise(r => setTimeout(r, 150));
  sneaky.destroy();
  assert.deepEqual(sneakyGot[0], { type: 'error', code: 'sentinel.actor.payloadClaim' });

  // A raw client that skips the guard is refused by the service too.
  const raw = connect(address.socket);
  await new Promise(r => raw.once('connect', r));
  const replies = new FrameDecoder();
  const got: unknown[] = [];
  raw.on('data', c => got.push(...replies.push(c)));
  raw.write(encodeFrame({ protocol: 'sentinel-service/draft-1', type: 'hello', client: 'mcp' }));
  raw.write(encodeFrame({ type: 'request', id: 1, op: 'run.start', body: { actor: 'human' } }));
  await new Promise(r => setTimeout(r, 200));
  raw.destroy();
  assert.deepEqual((got[1] as { ok: boolean; code: string }), { type: 'response', id: 1, ok: false, code: 'sentinel.actor.payloadClaim' });
  assert.ok(!seen.some(s => (s as { op: string }).op === 'run.start'), 'the handler never saw it');

  // A client that expects another store or owner refuses the service.
  await assert.rejects(connectOwnerSocket(address, { ...identity, storeId: 'store-2' }, 'cli'),
    (e: unknown) => e instanceof IpcError && e.code === 'sentinel.ipc.handshakeMismatch');
  // A second service for the same address refuses while the first still answers.
  await assert.rejects(listenOwnerSocket(address, identity, async () => null), (e: unknown) => e instanceof IpcError && e.code === 'sentinel.ipc.socketInUse');
});

test('a stale socket of ours is replaced; a file or an open folder at the address is refused', async t => {
  const base = scratch(t, 'snd-');
  const identity = { storeId: 'store-1', ownerNonce: newOwnerNonce() };
  const address = runtimeAddress({ storePath: '/s', ownerNonce: identity.ownerNonce, env: { TMPDIR: base } });
  // A process that dies while listening leaves its socket file behind.
  const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(address.socket)}, () => process.stdout.write('up'))`]);
  await new Promise(r => child.stdout.once('data', r));
  child.kill('SIGKILL');
  await new Promise(r => child.once('exit', r));
  assert.ok(lstatSync(address.socket).isSocket(), 'the stale socket is still there');
  const server = await listenOwnerSocket(address, identity, async () => 'ok');
  const c = await connectOwnerSocket(address, identity, 'mcp');
  assert.equal(await c.request('ping', {}), 'ok');
  c.close();
  await server.close();

  writeFileSync(address.socket, 'not a socket');
  await assert.rejects(listenOwnerSocket(address, identity, async () => null), (e: unknown) => e instanceof IpcError && e.code === 'sentinel.ipc.socketUnsafe');
  await assert.rejects(connectOwnerSocket(address, identity, 'cli'), (e: unknown) => e instanceof IpcError && e.code === 'sentinel.ipc.socketUnsafe');
  rmSync(address.socket);
  chmodSync(address.dir, 0o755);
  await assert.rejects(connectOwnerSocket(address, identity, 'cli'), (e: unknown) => e instanceof IpcError && e.code === 'sentinel.ipc.runtimeDirUnsafe');
});

test('the preview report is labelled, scoped and regenerates from its stored document alone', () => {
  const doc = {
    schema: 'sentinel-preview-report/draft-1' as const, label: 'foundation-preview' as const, runId: 'run-1', snapshotId: 'snap-1',
    ledgerSequence: 42, generatedAt: '2026-10-22T00:00:00Z',
    counts: [
      { n: 2, unit: 'sentinel.count.findings', scope: 'sentinel.scope.report', source: 'preview fixture detector',
        breakdown: [{ key: 'sentinel.count.part.high', n: 1 }, { key: 'sentinel.count.part.low', n: 1 }], recheck: { cli: 'farsight-sentinel report run-1 --json' } },
      { n: 1, unit: 'sentinel.count.unknownBoundaries', scope: 'sentinel.scope.inventory', source: 'snapshot inventory', recheck: { cli: 'farsight-sentinel report run-1' } },
    ],
    limitations: ['sentinel.report.previewOnly', 'sentinel.report.noScannerCoverage'],
  };
  const json = renderPreviewJson(doc);
  const md = renderPreviewMarkdown(doc);
  assert.match(md, /foundation preview/i);
  assert.match(md, /2 findings in this report \(1 high, 1 low\)/);
  assert.match(md, /1 folder never listed in the captured files/);
  assert.match(md, /an empty finding list here says nothing about the code's safety/);
  // Regeneration: the stored JSON alone renders the same report, with no ledger or scan.
  const stored = JSON.parse(json);
  assert.equal(renderPreviewJson(stored), json);
  assert.equal(renderPreviewMarkdown(stored), md);
  const bad = (over: object) => assert.throws(() => checkPreviewReport({ ...doc, ...over } as never), /sentinel\.report\.invalid/);
  bad({ limitations: ['sentinel.report.previewOnly'] });
  bad({ label: 'full' });
  bad({ counts: [{ ...doc.counts[0], breakdown: [{ key: 'sentinel.count.part.high', n: 1 }] }] });
  bad({ counts: [{ ...doc.counts[0], scope: 'count.scope.journey' }] });
  bad({ counts: [{ ...doc.counts[0], recheck: undefined }] });
});

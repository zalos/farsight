#!/usr/bin/env node
// Real public CLI/SDK, installed by npm outside the checkout. No private runtime imports or acquisition.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
  realpathSync,
  mkdtempSync,
  chmodSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, connect as netConnect } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { npmConsumer } from './npm-consumer.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  version = JSON.parse(readFileSync(join(root, 'packages/sentinel/package.json'))).version,
  artifact = resolve(process.argv[2] ?? join(root, 'build/sentinel', `farsight-sentinel-${version}.tgz`));
const c = await npmConsumer('sentinel-preparation-', [artifact]),
  services = new Set(),
  heldServices = new Set(),
  clients = new Set(),
  proxies = new Set(),
  wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function stop(child, signal = heldServices.has(child) ? 'SIGKILL' : 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  let timer;
  try {
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise(
        (_, reject) => (timer = setTimeout(() => reject(Error('owned preparation service failed to stop')), 10000)),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  const require = createRequire(join(c.dir, 'package.json')),
    { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href),
    { StdioClientTransport } = await import(
      pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
    );
  const installed = dirname(require.resolve('farsight-sentinel/package.json')),
    bin = c.bin('farsight-sentinel'),
    scratch = realpathSync.native(c.scratch);
  writeFileSync(join(c.dir, 'public.mjs'), "export * from 'farsight-sentinel';\n");
  const { validateEnvelope } = await import(pathToFileURL(join(c.dir, 'public.mjs')).href);
  async function fixture(label, files = 8, holdCaptured = false) {
    const ws = join(scratch, label);
    mkdirSync(join(ws, 'src'), { recursive: true });
    for (let i = 0; i < files; i++)
      writeFileSync(
        join(ws, 'src', `inert-${i}.ts`),
        'export const readInvoice = id => db.query("SELECT * FROM invoice WHERE id = " + id);\n',
      );
    const env = { ...c.env, XDG_STATE_HOME: join(scratch, label + '-owner'), NODE_PATH: '', NODE_OPTIONS: '' };
    const owner = async (...args) => {
      try {
        return JSON.parse((await c.exec(bin, [...args, '--json'], { cwd: ws, env, timeout: 30000 })).stdout);
      } catch (e) {
        if (typeof e.code === 'number' && e.stdout) return JSON.parse(e.stdout);
        throw e;
      }
    };
    assert.equal((await owner('init')).outcome, 'prepared');
    assert.equal((await owner('settings', 'adopt', '--confirm')).outcome, 'prepared');
    assert.equal(
      (await owner('rules', 'promote', join(installed, 'rules/foundation-preview'), '--confirm')).outcome,
      'prepared',
    );
    // Trusted consumer fault injection, never a shipped flag or target code: after the ORIGINAL atomic rename
    // of this exact fixture's genuine captured record, signal fd3 then hold only this owned Node process.
    const preload = join(scratch, label + '-captured-hold.mjs'),
      records = join(ws, '.farsight/sentinel/store/preparation/records');
    if (holdCaptured)
      writeFileSync(
        preload,
        `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {dirname,basename} from 'node:path';
const original=fs.renameSync;fs.renameSync=function(...args){const value=original.apply(this,args),path=String(args[1]);if(dirname(path)===${JSON.stringify(records)}&&/^[a-f0-9]{64}\\.json$/.test(basename(path))){const record=JSON.parse(fs.readFileSync(path,'utf8'));if(record.phase==='captured'&&record.checkpoint==='captured'&&record.snapshotId){fs.writeSync(3,'captured-checkpoint\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}return value;};syncBuiltinESMExports();`,
      );
    let service,
      errors = '',
      captured;
    const launch = (hold = false) => {
      service = spawn(
        process.execPath,
        [...(hold ? ['--import', preload] : []), bin, 'serve', '--workspace', ws, '--idle-ms', '0'],
        { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe', hold ? 'pipe' : 'ignore'] },
      );
      services.add(service);
      service.stderr.on('data', (b) => (errors = (errors + b).slice(-8000)));
      if (hold) {
        heldServices.add(service);
        captured = new Promise((resolve, reject) => {
          let bytes = '';
          const timer = setTimeout(
            () => reject(Error('owned service did not reach genuine captured checkpoint: ' + errors)),
            30000,
          );
          service.stdio[3].on('data', (b) => {
            bytes += b.toString();
            if (bytes === 'captured-checkpoint\n') {
              clearTimeout(timer);
              resolve();
            }
          });
          service.once('exit', () => {
            clearTimeout(timer);
            reject(Error('owned service exited before captured checkpoint: ' + errors));
          });
        });
        void captured.catch(() => {});
      }
      return service;
    };
    launch(holdCaptured);
    async function connect() {
      let last;
      for (let i = 0; i < 100; i++) {
        const client = new Client({ name: 'installed-preparation-consumer', version: '1' }, { capabilities: {} });
        try {
          await client.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: [bin, 'mcp', '--workspace', ws],
              cwd: ws,
              env,
              stderr: 'pipe',
            }),
          );
          clients.add(client);
          return client;
        } catch (e) {
          last = e;
          await client.close().catch(() => {});
          await wait(30);
        }
      }
      throw Error('MCP preparation connection: ' + last?.message + '; ' + errors);
    }
    const call = async (client, name, args) => {
      const v = await client.callTool({ name, arguments: args });
      assert.equal(v.isError, undefined, JSON.stringify(v));
      return v.structuredContent;
    };
    const prepared = async (key) => {
      for (let i = 0; i < 1000; i++) {
        const v = await owner('prepare', 'status', ...(key ? ['--request-key', key] : []));
        if (['prepared', 'failed', 'canceled', 'interrupted'].includes(v.facts.phase)) return v;
        await wait(10);
      }
      assert.fail('preparation did not settle: ' + errors);
    };
    const client = await connect();
    return {
      ws,
      env,
      owner,
      connect,
      call,
      prepared,
      client,
      launch,
      captured: () => captured,
      get service() {
        return service;
      },
    };
  }
  // Transparent local response fault: real service completes admission before its response is dropped. No input,
  // handshake or capability is forged. The owner CLI persists its private request key before dispatch.
  async function loseAccept(f) {
    const storePath = join(f.ws, '.farsight/sentinel/store'),
      descriptorPath = join(
        f.env.XDG_STATE_HOME,
        'farsight/sentinel/trust/services',
        createHash('sha256').update(storePath).digest('hex').slice(0, 32) + '.json',
      );
    const original = readFileSync(descriptorPath),
      descriptor = JSON.parse(original),
      dir = realpathSync.native(mkdtempSync('/tmp/sntl-prepare-ack-')),
      path = join(dir, 's');
    chmodSync(dir, 0o700);
    const sockets = new Set();
    let accepts = 0,
      dropped = 0;
    const frame = (v) => {
      const b = Buffer.from(JSON.stringify(v)),
        h = Buffer.alloc(4);
      h.writeUInt32BE(b.length);
      return Buffer.concat([h, b]);
    };
    const decode = (take) => {
      let saved = Buffer.alloc(0);
      return (b) => {
        saved = Buffer.concat([saved, b]);
        for (;;) {
          if (saved.length < 4) return;
          const n = saved.readUInt32BE(0);
          assert.ok(n > 0 && n <= 1048576);
          if (saved.length < n + 4) return;
          const v = JSON.parse(saved.subarray(4, n + 4));
          saved = saved.subarray(n + 4);
          take(v);
        }
      };
    };
    const server = createServer((incoming) => {
      const backend = netConnect(descriptor.address.socket);
      sockets.add(incoming);
      sockets.add(backend);
      incoming.on(
        'data',
        decode((v) => {
          if (v.type === 'request' && v.op === 'prepare.accept') accepts++;
        }),
      );
      incoming.pipe(backend);
      backend.on(
        'data',
        decode((v) => {
          if (v.type === 'response' && v.ok && v.value?.command === 'prepare' && v.value.outcome === 'submitted') {
            dropped++;
            incoming.destroy();
            backend.destroy();
          } else incoming.write(frame(v));
        }),
      );
      incoming.on('end', () => backend.end());
      backend.on('end', () => incoming.end());
      for (const [a, b] of [
        [incoming, backend],
        [backend, incoming],
      ]) {
        a.on('error', () => b.destroy());
        a.on('close', () => {
          sockets.delete(a);
          b.destroy();
        });
      }
    });
    await new Promise((r, j) => {
      server.once('error', j);
      server.listen(path, r);
    });
    chmodSync(path, 0o600);
    writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, address: { dir, socket: path } }), { mode: 0o600 });
    let closed = false;
    const p = {
      get accepts() {
        return accepts;
      },
      get dropped() {
        return dropped;
      },
      async close() {
        if (closed) return;
        closed = true;
        writeFileSync(descriptorPath, original, { mode: 0o600 });
        for (const s of sockets) s.destroy();
        await new Promise((r) => server.close(r));
        rmSync(dir, { recursive: true, force: true });
        proxies.delete(p);
      },
    };
    proxies.add(p);
    return p;
  }
  const f = await fixture('lost-ack'),
    key = 'installed_prepare_request_0001',
    tools = (await f.client.listTools()).tools;
  assert.equal(tools.length, 16);
  const preview = await f.call(f.client, 'sentinel_configuration_preview', { requestKey: key });
  assert.ok(validateEnvelope('configurationpreview', preview).ok);
  assert.equal(preview.sourceCaptured, false);
  assert.equal('confirmation' in preview, false);
  const denied = await f.call(f.client, 'sentinel_prepare_accept', { requestKey: key, previewId: preview.id });
  assert.equal(denied.reasonCode, 'sentinel.admission.noGrant');
  assert.equal(existsSync(join(f.ws, '.farsight/sentinel/store/preparation')), false);
  const awaiting = await f.owner('prepare');
  assert.equal(awaiting.outcome, 'awaiting-confirmation');
  const proxy = await loseAccept(f),
    unknown = await f.owner('prepare', '--confirm');
  assert.equal(unknown.reasonCode, 'sentinel.preparation.outcomeUnknown');
  assert.equal(proxy.accepts, 1);
  assert.equal(proxy.dropped, 1);
  await proxy.close();
  const final = await f.prepared();
  assert.equal(final.facts.phase, 'prepared', JSON.stringify(final));
  assert.equal(final.facts.preparedRevision, 2);
  assert.equal(final.facts.checksStartedByPreparation, false);
  const runId = final.facts.runId;
  rmSync(join(f.ws, 'src'), { recursive: true });
  await f.client.close();
  clients.delete(f.client);
  let client = await f.connect();
  const view = await f.call(client, 'sentinel_run_inspect', { runId });
  assert.ok(view.counts.inputs.n > 0);
  assert.equal(view.counts.attempts.n, 0, 'analysis work has no attempt before separate start');
  const page = await f.call(client, 'sentinel_view_page', { viewId: view.viewId, collection: 'inputs' });
  assert.ok(page.rows.length > 0);
  assert.doesNotMatch(JSON.stringify(page), /inert-|SELECT|sha256:/);
  const started = await f.owner('run', runId, '--detach', '--confirm');
  assert.equal(started.outcome, 'submitted');
  for (let i = 0; i < 600; i++) {
    const v = await f.call(client, 'sentinel_run_wait', { runId, timeoutMs: 100 });
    if (v.state === 'completed') break;
    assert.ok(i < 599);
  }
  const delivery = await f.call(client, 'sentinel_report_open', { runId, format: 'json' });
  assert.ok(validateEnvelope('reportdelivery', delivery).ok);
  assert.ok(delivery.formatBytes > 0);
  const chunks = [];
  let offset = 0;
  for (;;) {
    const chunk = await f.call(client, 'sentinel_delivery_read', { deliveryId: delivery.deliveryId, offset });
    chunks.push(Buffer.from(chunk.base64, 'base64'));
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  }
  const reportBytes = Buffer.concat(chunks);
  assert.equal(reportBytes.length, delivery.formatBytes);
  assert.equal('sha256:' + createHash('sha256').update(reportBytes).digest('hex'), delivery.formatDigest);
  assert.ok(validateEnvelope('report', JSON.parse(reportBytes)).ok);
  // A terminal prepared lookup is not a permanent capture pin: explicitly confirmed current-source requests
  // capture edits. An unchanged later inventory names the genuine existing run without resetting its deadline.
  mkdirSync(join(f.ws, 'src'), { recursive: true });
  writeFileSync(join(f.ws, 'src', 'edited.ts'), 'export const updatedInvoice = 2;\n');
  const editedKey = 'installed_edited_source_0002',
    edited = await f.owner('prepare', '--confirm', '--request-key', editedKey);
  assert.equal(edited.outcome, 'submitted');
  const editedReady = await f.prepared(editedKey);
  assert.equal(editedReady.facts.phase, 'prepared');
  assert.notEqual(editedReady.facts.runId, runId);
  const sameKey = 'installed_same_inventory_0003';
  assert.equal((await f.owner('prepare', '--confirm', '--request-key', sameKey)).outcome, 'submitted');
  const sameReady = await f.prepared(sameKey);
  assert.equal(sameReady.facts.phase, 'prepared');
  assert.equal(sameReady.facts.runId, editedReady.facts.runId);
  assert.equal(sameReady.facts.reasonCode, 'sentinel.preparation.alreadyPrepared');
  assert.equal(sameReady.facts.runDeadlineAt, editedReady.facts.runDeadlineAt);
  // Actual abrupt owner death after a captured association. Journal is observed as private test evidence only;
  // recovery still goes through public status plus fresh real CLI receipt, never a fabricated successful row.
  const crash = await fixture('crash', 8, true),
    crashKey = 'installed_crash_prepare_0001';
  await crash.client.close();
  clients.delete(crash.client);
  const accepting = crash.owner('prepare', '--confirm', '--request-key', crashKey);
  void accepting.catch(() => {});
  await crash.captured();
  const records = join(crash.ws, '.farsight/sentinel/store/preparation/records');
  const retained = readdirSync(records)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(records, name))));
  assert.equal(retained.length, 1);
  const before = retained[0];
  assert.equal(before.phase, 'captured');
  assert.ok(before, 'actual captured checkpoint was visible before owner kill');
  await stop(crash.service, 'SIGKILL');
  await accepting.catch(() => {});
  rmSync(join(crash.ws, 'src'), { recursive: true });
  crash.launch();
  client = await crash.connect();
  const interrupted = await crash.call(client, 'sentinel_prepare_status', { requestKey: crashKey });
  console.error(
    JSON.stringify({
      checkpoint: 'after-owned-sigkill',
      before: {
        phase: before.phase,
        checkpoint: before.checkpoint,
        acceptedAt: before.acceptedAt,
        runDeadlineAt: before.runDeadlineAt,
      },
      status: interrupted.status,
      now: new Date().toISOString(),
    }),
  );
  assert.equal(interrupted.status.phase, 'interrupted');
  assert.equal(interrupted.status.resumeAvailable, true);
  assert.equal(interrupted.status.runDeadlineAt, before.runDeadlineAt);
  const resumed = await crash.owner('prepare', 'resume', '--request-key', crashKey, '--confirm');
  assert.equal(resumed.outcome, 'submitted', JSON.stringify(resumed));
  const recovered = await crash.prepared(crashKey);
  assert.equal(recovered.facts.phase, 'prepared', JSON.stringify(recovered));
  assert.equal(recovered.facts.acceptedAt, before.acceptedAt);
  assert.equal(recovered.facts.deadlineAt, before.deadlineAt);
  assert.equal(recovered.facts.runDeadlineAt, before.runDeadlineAt);
  assert.equal(recovered.facts.checksStartedByPreparation, false);
  const retainedView = await crash.call(client, 'sentinel_run_inspect', { runId: recovered.facts.runId });
  assert.ok(retainedView.counts.inputs.n > 0);
  assert.equal(retainedView.counts.attempts.n, 0);
  console.log(
    JSON.stringify({
      schema: 'sentinel-preparation-consumer/draft-1',
      npmOnly: true,
      artifactSha256: createHash('sha256').update(readFileSync(artifact)).digest('hex'),
      tools: 16,
      purePreview: true,
      defaultAgentDenied: true,
      actualOwnerConfirmation: true,
      lostAcceptanceAck: true,
      persistedKeyDiscovery: true,
      noAutomaticReplay: true,
      sourceGone: true,
      retainedInputs: true,
      separateStart: true,
      exactReportDelivery: true,
      actualOwnerSigkill: true,
      deterministicCapturedGate: true,
      freshEditedCapture: true,
      sameInventoryExistingRun: true,
      explicitPinnedResume: true,
      originalDeadlinePreserved: true,
      browserOwnerConfirmation: false,
      preRunExpiredRetry: false,
    }),
  );
} finally {
  for (const p of proxies) await p.close();
  for (const client of clients) await client.close().catch(() => {});
  for (const service of services) await stop(service);
  c.cleanup();
}

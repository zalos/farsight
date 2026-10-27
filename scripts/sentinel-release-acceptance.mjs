// Actual owner commands against an installed package. No local models or scanner downloads.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function sentinelReleaseGates({
  record,
  exec,
  sentinel,
  app,
  env,
  scratch,
  caps,
  pendingByCapability,
  mcpHandshake,
  stopChild,
}) {
  const ws = join(scratch, 'sentinel-application'),
    state = join(scratch, 'sentinel-owner-state');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(
    join(ws, 'src/invoice.ts'),
    'export function findInvoice(id: string) { return db.query("SELECT * FROM invoice WHERE id = " + id); }\n',
  );
  const ownerEnv = { ...env, XDG_STATE_HOME: state };
  const invoke = async (args, raw = false) => {
    let r;
    try {
      r = await exec(sentinel, [...args, ...(raw ? [] : ['--json'])], { cwd: ws, env: ownerEnv, timeout: 60000 });
    } catch (e) {
      if (typeof e.code !== 'number' || !e.stdout) throw e;
      r = e;
    }
    return raw ? { status: r.code ?? 0, text: r.stdout } : { status: r.code ?? 0, body: JSON.parse(r.stdout) };
  };
  const gate = async (id, capability, what, fn) =>
    record(id, async () => {
      const c = caps?.capabilities?.find((c) => c.id === capability);
      if (!c || c.state === 'unavailable') return pendingByCapability(caps, { id, capability, what });
      return fn();
    });
  let runId;
  await gate('sentinel.init-twice-preserves-config', 'scan-cli', 'initialize twice', async () => {
    assert.equal((await invoke(['init'])).body.outcome, 'prepared');
    const config = join(ws, '.farsight/sentinel/settings.json'),
      bytes = readFileSync(config);
    assert.equal((await invoke(['init'])).body.outcome, 'kept');
    assert.deepEqual(readFileSync(config), bytes);
    return 'second initialization preserved exact settings bytes';
  });
  await gate('sentinel.adopt-plan-run', 'scan-cli', 'adopt, plan and execute the preview', async () => {
    assert.equal((await invoke(['settings', 'adopt', '--confirm'])).status, 0);
    assert.equal((await invoke(['rules', 'promote', 'builtin:foundation-preview', '--confirm'])).status, 0);
    const plan = await invoke(['plan']);
    assert.equal(plan.status, 0, JSON.stringify(plan));
    runId = plan.body.facts.runId ?? plan.body.facts.planId;
    assert.ok(runId);
    const result = await invoke(['run', runId, '--confirm']);
    assert.equal(result.status, 2, JSON.stringify(result));
    assert.equal(result.body.outcome, 'required-coverage-incomplete');
    assert.equal(result.body.facts.state, 'completed');
    return 'real retained preview completed; required security coverage remains explicitly incomplete';
  });
  await gate('sentinel.report-offline', 'reports', 'render retained standalone reports', async () => {
    assert.ok(runId, 'run admission must pass first');
    renameSync(join(ws, 'src'), join(scratch, 'retained-source-away'));
    const json = await invoke(['report', runId, '--full', '--format', 'json'], true);
    assert.equal(json.status, 0, json.text);
    const doc = JSON.parse(json.text);
    assert.equal(doc.schema, 'sentinel-report/draft-1');
    const md = await invoke(['report', runId, '--full', '--format', 'md'], true),
      html = await invoke(['report', runId, '--full', '--format', 'html'], true);
    assert.equal(md.status, 0);
    assert.ok(md.text.length > 100);
    assert.equal(html.status, 0);
    assert.match(html.text, /<!doctype html>/i);
    assert.doesNotMatch(html.text, /<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i);
    writeFileSync(join(scratch, 'report.html'), html.text);
    writeFileSync(join(scratch, 'report.md'), md.text);
    return 'JSON, Markdown and self-contained HTML rendered after source removal';
  });
  await gate('sentinel.compare', 'reports', 'compare retained runs', async () => {
    assert.ok(runId);
    const r = await invoke(['compare', runId, runId, '--format', 'json'], true);
    assert.equal(r.status, 0, r.text);
    assert.equal(JSON.parse(r.text).schema, 'sentinel-report/draft-1');
    return 'retained report comparison is readable';
  });
  let service;
  try {
    if (caps?.capabilities?.find((c) => c.id === 'mcp')?.state !== 'unavailable') {
      service = spawn(sentinel, ['serve', '--workspace', ws, '--idle-ms', '0'], {
        cwd: ws,
        env: ownerEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      service.stdout.resume();
      service.stderr.resume();
    }
    await gate('sentinel.mcp-handshake', 'mcp', 'connect to the owner service', async () => {
      let last;
      for (let i = 0; i < 25; i++) {
        try {
          const hello = await mcpHandshake(sentinel, ['mcp', '--workspace', ws], { cwd: ws, env: ownerEnv });
          assert.ok(hello.tools.includes('sentinel_run_inspect'));
          return `${hello.tools.length} installed service tools`;
        } catch (e) {
          last = e;
          if (service?.exitCode !== null) break;
          await delay(100);
        }
      }
      throw last;
    });
  } finally {
    if (service) await stopChild(service);
  }
  // Portable replay bundles are outside the owner-selected first release (#175).
  // Interruption recovery has its own installed-consumer CI gate; it is not replaced by a claimed pass here.
  return { workspace: ws, env: ownerEnv, runId };
}

export async function sentinelHostGate({
  record,
  caps,
  pendingByCapability,
  exec,
  binOf,
  app,
  scratch,
  env,
  freePort,
  stopChild,
  mcpHandshake,
}) {
  await record('combined.host-handshake', async () => {
    const id = 'combined.host-handshake',
      capability = 'farsight-host-bridge';
    if (caps?.capabilities?.find((c) => c.id === capability)?.state !== 'available-draft')
      return pendingByCapability(caps, { id, capability, what: 'discover the installed companion' });
    const ws = join(scratch, 'sentinel-application'),
      ownerEnv = { ...env, XDG_STATE_HOME: join(scratch, 'sentinel-owner-state') },
      port = await freePort();
    writeFileSync(join(ws, 'graph.json'), readFileSync(join(app, 'graph.json')));
    const children = [];
    const start = (command, args) => {
      const child = spawn(command, args, { cwd: ws, env: ownerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.resume();
      child.stderr.resume();
      children.push(child);
      return child;
    };
    const origin = `http://127.0.0.1:${port}`;
    const get = async (path) => {
      const r = await fetch(origin + path, { signal: AbortSignal.timeout(2000) });
      assert.equal(r.status, 200);
      return r.json();
    };
    const until = async (fn) => {
      let last;
      for (let i = 0; i < 100; i++) {
        try {
          return await fn();
        } catch (e) {
          last = e;
          await delay(100);
        }
      }
      throw last;
    };
    try {
      start(binOf('sentinel'), ['serve', '--workspace', ws, '--idle-ms', '0']);
      start(binOf('farsight'), ['serve', 'graph.json', '--port', String(port)]);
      const version = await until(() => get('/api/version'));
      assert.match(version.session.instance, /^host-[a-f0-9]{32}$/);
      assert.equal(version.session.readOnly, false);
      const absent = await get('/api/sentinel/companion');
      assert.equal(absent.available, false);
      // Wait for the already-owned service through a read-only status request. owner-ui never starts it.
      await until(() =>
        mcpHandshake(binOf('sentinel'), ['mcp', '--workspace', ws], { cwd: ws, env: ownerEnv, timeoutMs: 2000 }),
      );
      start(binOf('sentinel'), ['owner-ui', '--workspace', ws, '--farsight-origin', origin]);
      const ready = await until(async () => {
        const value = await get('/api/sentinel/companion');
        assert.equal(value.available, true);
        return value;
      });
      assert.deepEqual(Object.keys(ready).sort(), ['available', 'ownerOrigin']);
      assert.match(ready.ownerOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
      const frame = await fetch(ready.ownerOrigin + '/frame', { signal: AbortSignal.timeout(2000) });
      assert.equal(frame.status, 200);
      assert.match(await frame.text(), /<!doctype html>/i);
      return 'installed companion discovered; inert pairing frame only, no browser confirmation or model call';
    } finally {
      for (const child of children.reverse()) await stopChild(child);
    }
  });
}

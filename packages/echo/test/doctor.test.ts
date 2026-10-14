import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { defaultConfig, initConfig } from '../dist/config.js';
import { AGENTMEMORY_VERSION } from '../dist/runtime.js';
import type { CheckResult, EchoProfile } from '../dist/types.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

async function doctor(mode: 'off' | 'mock' | 'model' | undefined, provider: EchoProfile['model']['provider'], available = false) {
  const requests: string[] = [];
  const respond: RequestListener = (req, res) => {
    requests.push(req.url!);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/agentmemory/health') res.end(JSON.stringify({ service: 'agentmemory', version: AGENTMEMORY_VERSION }));
    else if (req.url === '/api/tags' && available) res.end(JSON.stringify({ models: [{ name: 'synthetic-model' }] }));
    else { res.writeHead(503); res.end('{}'); }
  };
  const backend = createServer(respond), model = createServer(respond);
  await Promise.all([backend, model].map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))));
  const backendPort = (backend.address() as { port: number }).port;
  const modelPort = (model.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'echo-doctor-fixture-'));
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(directory, 'state');
  try {
    const config = defaultConfig();
    const profile = config.profiles.personal!;
    profile.backend = { mode: 'external', url: `http://127.0.0.1:${backendPort}` };
    profile.model = { provider, baseUrl: `http://127.0.0.1:${modelPort}`, model: available ? 'synthetic-model' : '' };
    if (mode === undefined) delete profile.submind; else profile.submind!.mode = mode;
    const path = join(directory, 'settings.json');
    await initConfig(path, config);
    let output: string, exitCode = 0;
    try { output = (await run(process.execPath, [cli, 'doctor', '--config', path], { env: { ...process.env }, timeout: 5000 })).stdout; }
    catch (error) { const result = error as { stdout: string; code: number }; output = result.stdout; exitCode = result.code; }
    return { checks: JSON.parse(output) as CheckResult[], requests, exitCode };
  } finally {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousState;
    await Promise.all([backend, model].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const mode of ['off', 'mock', undefined] as const) {
  test(`doctor succeeds without model configuration or provider requests in ${mode ?? 'legacy'} mode`, async () => {
    for (const provider of ['ollama', 'openai-compatible'] as const) {
      const result = await doctor(mode, provider);
      assert.equal(result.exitCode, 0);
      assert.ok(result.checks.every(check => check.ok));
      assert.ok(result.checks.some(check => check.name === 'backend'));
      assert.ok(!result.checks.some(check => check.name.startsWith('model')));
      assert.ok(result.requests.length > 0);
      assert.ok(result.requests.every(path => path === '/agentmemory/health'));
    }
  });
}

test('doctor still checks selected model readiness in model mode without generating', async () => {
  const unavailable = await doctor('model', 'ollama');
  assert.equal(unavailable.exitCode, 1);
  assert.ok(unavailable.checks.some(check => check.name === 'model' && !check.ok));
  assert.equal(unavailable.requests.filter(path => path === '/api/tags').length, 1);
  const available = await doctor('model', 'ollama', true);
  assert.equal(available.exitCode, 0);
  assert.ok(available.checks.some(check => check.name === 'model' && check.ok));
  assert.ok(available.requests.every(path => path === '/agentmemory/health' || path === '/api/tags'));
  const compatible = await doctor('model', 'openai-compatible');
  assert.equal(compatible.exitCode, 1);
  assert.ok(compatible.checks.some(check => check.name === 'model-configuration' && !check.ok));
  assert.ok(compatible.requests.every(path => path === '/agentmemory/health'));
});

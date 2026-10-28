// Genuine retained scans for the viewer's read model: real adoption, preparation, a separately confirmed start and the
// owner service's own publication. No Docker and no live model: the deterministic preview check, and for an agent
// stage a local mock model endpoint behind the real review broker (as cli-review-e2e does). No forged records.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OwnerService } from '../../dist/service/owner-service.js';
import { publishOwnerCompanion } from '../../dist/owner-ui/descriptor.js';
import { openStore } from '../../dist/store/index.js';
import { workspaceOf } from '../../dist/service/local.js';
import { publicRegistry } from '../../dist/service/scanner-profile.js';
import { companionDirectory, companionWorkspaceDigest } from '@farsight/core/dist/sentinel-companion.js';
import { preparationFixture } from './preparation-fixture.ts';
import { scratch } from '../snapshot-helpers.ts';
import { mockEndpoint, json, ollamaReply, trustedPolicy } from '../provider-helpers.ts';

export const by = { principal: 'agent' as const, channel: 'owner-ui' as const };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CLI = new URL('../../dist/cli.js', import.meta.url).pathname;
export const HOST_INSTANCE = 'host-' + 'a'.repeat(32);
export const FARSIGHT_ORIGIN = 'http://127.0.0.1:4500';

/** Pairs a held service the way the companion does, and returns a reader with the proof and view revision bound. */
export async function pairedReader(t: any, service: InstanceType<typeof OwnerService>, wsPath: string) {
  const value = {
      schema: 'farsight-sentinel-companion/1' as const,
      workspaceDigest: companionWorkspaceDigest(wsPath),
      ownerOrigin: 'http://127.0.0.1:4501',
      farsightOrigin: FARSIGHT_ORIGIN,
      hostInstance: HOST_INSTANCE,
      processNonce: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    descriptor = await publishOwnerCompanion(companionDirectory(), value);
  t.after(() => descriptor.close());
  const pair: any = await service.handle(
    'owner-ui.pair',
    { farsightOrigin: value.farsightOrigin, hostInstance: HOST_INSTANCE, processNonce: value.processNonce },
    by,
  );
  await service.handle(
    'owner-ui.context',
    {
      proof: pair.proof,
      view: {
        frameNonce: 'frame-' + 'c'.repeat(32),
        documentId: 'document-' + 'd'.repeat(32),
        revision: 1,
        hostInstance: HOST_INSTANCE,
        mode: 'live',
        sync: null,
      },
    },
    by,
  );
  return (op: string, body: any = {}) => service.handle(op, { proof: pair.proof, revision: 1, ...body }, by) as any;
}

/** A completed foundation-preview scan through the owner panel's own two confirmations. */
export async function completedPreviewScan(t: any) {
  const f = await preparationFixture(t);
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(f.dir, 'owner');
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });
  const service = new OwnerService(f.store, f.ws, { registry: f.registry });
  t.after(() => service.stop());
  const call = await pairedReader(t, service, f.ws.path);
  const key = 'viewer_read_model_request_0001';
  const preview = await call('owner-ui.preview', { requestKey: key });
  const accepted = await call('owner-ui.accept', { requestKey: key, previewId: preview.id });
  if (accepted.outcome !== 'submitted') throw new Error('fixture preparation refused: ' + JSON.stringify(accepted));
  for (let i = 0; i < 600 && service.busy; i++) await wait(10);
  const status = await call('owner-ui.status', { requestKey: key });
  const runId: string = status.facts.runId;
  const control = await call('owner-ui.control-preview', { runId, action: 'start' });
  const started = await call('owner-ui.control', { previewId: control.id });
  if (started.outcome !== 'submitted') throw new Error('fixture start refused: ' + JSON.stringify(started));
  await service.handle('run.wait', { runId, timeoutMs: 25000 }, by);
  if (f.store.ledger.getRun(runId)?.state !== 'completed') throw new Error('fixture scan did not complete');
  return { ...f, service, call, runId };
}

/** A completed scan with both review stages, answered by a local mock model through the real broker. */
export async function completedReviewScan(t: any) {
  const dir = scratch(t, 'sentinel-viewer-review-'),
    root = join(dir, 'workspace');
  mkdirSync(join(root, 'src'), { recursive: true });
  // The second line names this computer's folders (the workspace, its store, the Node that runs the test): the
  // model is served it, and retained text in the read model must never show it.
  writeFileSync(
    join(root, 'src', 'original.ts'),
    'export const original = (x: string) => x;\n' +
      `// built in ${root} with its store at ${workspaceOf(root).storePath} by ${process.execPath}\n`,
  );
  const ep = await mockEndpoint(t, (q, r) => {
    const last = JSON.parse(JSON.parse(q.body).messages.at(-1).content),
      reply = last.evidence
        ? {
            action: 'final',
            verdict: 'finding',
            claims: [
              { statement: 'Original fixture review candidate.', citations: last.evidence.map((e: any) => e.id) },
            ],
            inspected: ['src/original.ts'],
          }
        : { action: 'read', path: 'src/original.ts', startLine: 1, endLine: 2 };
    json(r, 200, ollamaReply({ message: { role: 'assistant', content: JSON.stringify(reply) } }));
  });
  const env = { ...process.env, HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
  mkdirSync(env.HOME);
  const cli = (...args: string[]) =>
    new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args, '--workspace', root, '--json'], {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (b) => (out += b));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Error('owned CLI timeout'));
      }, 90000);
      child.on('exit', (status) => {
        clearTimeout(timer);
        try {
          resolve({ status, body: JSON.parse(out) });
        } catch {
          reject(Error('CLI output invalid ' + out.slice(0, 400)));
        }
      });
    });
  await cli('init');
  const path = join(root, '.farsight', 'sentinel', 'settings.json'),
    settings = JSON.parse(readFileSync(path, 'utf8')),
    fixture = trustedPolicy({ ollama: ep.origin }).settings;
  settings.providers = [structuredClone(fixture.providers[0])];
  settings.providers[0].models[0].capability.revision = null;
  settings.reviewModels = {
    stages: [
      { stage: 'guided', providerId: 'local-review', modelId: 'review' },
      { stage: 'general', providerId: 'local-review', modelId: 'review' },
    ],
    segments: [],
  };
  settings.grants.push({ actions: ['paid.admit'], principals: ['human'], confirm: 'always' });
  settings.grants[0].scope.effects = ['local-artifacts', 'paid-inference'];
  writeFileSync(path, JSON.stringify(settings));
  for (const args of [
    ['settings', 'adopt', '--confirm'],
    ['rules', 'promote', 'builtin:foundation-preview', '--confirm'],
  ])
    if ((await cli(...args)).status !== 0) throw new Error('fixture owner step refused: ' + args.join(' '));
  const planned = await cli('plan');
  const runId: string = planned.body.facts.planId;
  const run = await cli('run', runId, '--confirm', '--confirm-models');
  if (run.body.facts?.state !== 'completed') throw new Error('fixture review scan did not complete');
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });
  const ws = workspaceOf(root, env);
  const store = await openStore(ws.storePath);
  const service = new OwnerService(store, ws, { registry: publicRegistry(ws.trustDir) });
  t.after(async () => {
    await service.stop();
    if (store.held) store.close();
  });
  const call = await pairedReader(t, service, root);
  return { dir, ws, store, service, call, runId, endpoint: ep };
}

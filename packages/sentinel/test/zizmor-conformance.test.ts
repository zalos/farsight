// The pinned zizmor itself, offline, through PR 07's isolated execution service only (no host fallback, no pull, no
// network, no token). Runs with SENTINEL_ISOLATION=1; inputs are the original synthetic fixtures under their real names
// in a temporary captured tree.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { createExecutionService } from '../dist/execution/service.js';
import { ZIZMOR_ADAPTER, ZIZMOR_ONLINE_AUDITS, buildZizmorAdapter, runZizmorAttempt } from '../dist/adapters/zizmor/index.js';
import { removeScratch, scratch, storeIn } from './execution-helpers.ts';
import { ZIZMOR_LAYOUT, capturedTree } from './iac-helpers.ts';

const enabled = process.env.SENTINEL_ISOLATION === '1';
const skip = !enabled && 'real pinned engine: set SENTINEL_ISOLATION=1 with a qualified local Docker and the pinned zizmor image installed';
const QUALIFY = process.env.SENTINEL_IAC_QUALIFY?.replace(/^linux\//, '');
// A variant that runs with online audits allowed: with no network and no token they still cannot load, but the run is
// not the offline mode the adapter states, and a report saying they loaded would be refused.
const STRICT = buildZizmorAdapter({ id: 'ci-zizmor-strict', engineArgs: ['--offline', '--no-config', '--no-ignores', '--collect=workflows,actions,dependabot', '--format=json', '--no-progress', '--color=never', '--persona=regular', '--strict-collection', '-vv'] });

let root: { root: string; work: string };
let store: any;
let service: any;
let n = 0;
before(async () => {
  if (!enabled) return;
  root = scratch('zizmor');
  store = await storeIn(root.root);
  service = await createExecutionService(store, { scratchRoot: root.work, registry: createAdapterRegistry([ZIZMOR_ADAPTER, STRICT.definition]), containers: true });
});
after(async () => { if (enabled) { await store.close(); removeScratch(root.root); } });

const run = (targets: any[], extra: Record<string, unknown> = {}) => runZizmorAttempt(service, {
  attemptId: `att-zizmor-${n++}`, work: { id: 'work-zizmor', revision: 1 }, targets, scratch: root.root,
  ...(QUALIFY ? { qualifyingArchitecture: QUALIFY } : {}), ...extra,
});
const row = (r: any, p: string) => { const c = r.coverage.find((x: any) => x.relativePath === p); return `${c.status}:${c.limitations.map((l: string) => l.split('.').pop()).join(',')}`; };
const audits = (r: any, p: string) => r.findings.filter((f: any) => f.primary.relativePath === p).map((f: any) => f.audit).sort();

test('workflow, action and Dependabot positives, a true negative, files it cannot audit, and the offline gap', { skip }, async () => {
  const t0 = Date.now();
  const tree = capturedTree(join(root.root, `tree-${n++}`), ZIZMOR_LAYOUT);
  const r = await run(tree);
  const wall = Date.now() - t0;
  assert.equal(r.attempt, 'succeeded');
  assert.equal(r.platform.state, QUALIFY ? 'candidate' : 'measured');
  assert.equal(r.engineExit, 14, 'the highest finding is high');
  console.log(`# zizmor conformance: ${r.findings.length} findings, ${r.refused.length} refused, ${wall} ms`);
  for (const c of r.coverage) console.log(`# ${c.relativePath} ${c.status} ${c.limitations.join(',')} [${audits(r, c.relativePath).join(' ')}]`);
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.skippedAudits, [...ZIZMOR_ONLINE_AUDITS].sort(), 'exactly the online-only audits were skipped');
  const triage = audits(r, '.github/workflows/triage.yml');
  for (const a of ['dangerous-triggers', 'template-injection', 'unpinned-uses']) assert.ok(triage.includes(a), a);
  assert.ok(triage.includes('template-injection'), 'an ignore comment in the repository does not suppress a finding');
  assert.equal(row(r, '.github/workflows/triage.yml'), 'partial:onlineAuditsSkipped,offlineDegraded', 'online audits are a gap, never a pass');
  assert.deepEqual(audits(r, '.github/workflows/build.yaml'), [], 'the hardened workflow is a true negative');
  assert.deepEqual(audits(r, 'services/api/.github/workflows/ci.yml'), []);
  assert.equal(row(r, 'services/api/.github/workflows/ci.yml'), 'partial:onlineAuditsSkipped,offlineDegraded');
  assert.deepEqual(audits(r, '.github/actions/setup/action.yml'), ['template-injection']);
  assert.ok(audits(r, '.github/dependabot.yml').includes('dependabot-cooldown'));
  assert.equal(row(r, '.github/dependabot.yml'), 'complete:');
  assert.equal(row(r, '.github/workflows/broken.yml'), 'error:notAudited');
  assert.equal(row(r, '.github/workflows/notes.yml'), 'error:notAudited');
  // Spans are UTF-8 byte offsets into the captured bytes: the first line holds a multibyte dash.
  const trigger = r.findings.find((f: any) => f.audit === 'dangerous-triggers')!;
  const bytes = readFileSync(tree.find(t => t.relativePath === '.github/workflows/triage.yml')!.path);
  assert.equal(bytes.subarray(trigger.primary.span.startByte, trigger.primary.span.endByte).toString('utf8'), 'on: pull_request_target');
  assert.ok(!JSON.stringify(r).includes('pull_request.title'), 'the engine’s quoted features and annotations are not kept');
});

test('an empty workflow is collected and never audited, at exit 0: a gap, not a pass', { skip }, async () => {
  const r = await run(capturedTree(join(root.root, `tree-${n++}`), { '.github/workflows/empty.yml': { text: '' }, '.github/workflows/build.yml': 'zizmor/workflow-hardened.fixture' }));
  assert.equal(r.engineExit, 0);
  assert.equal(row(r, '.github/workflows/empty.yml'), 'error:notAudited');
  assert.equal(row(r, '.github/workflows/build.yml'), 'partial:onlineAuditsSkipped,offlineDegraded');
});

test('strict collection turns an unparseable workflow into an engine failure that counts nothing', { skip }, async () => {
  const r = await run(capturedTree(join(root.root, `tree-${n++}`), { '.github/workflows/broken.yml': 'zizmor/workflow-broken.fixture', '.github/workflows/triage.yml': 'zizmor/workflow-injection.fixture' }), { adapter: STRICT });
  assert.equal(r.engineFailure, 'sentinel.zizmor.engine.engineError', JSON.stringify({ attempt: r.attempt, exit: r.engineExit, coverage: r.coverage }));
  assert.equal(r.findings.length, 0);
  assert.ok(r.coverage.every((c: any) => c.status === 'error'));
});

test('only CI files are sent; nothing to send means nothing runs', { skip }, async () => {
  const r = await run(capturedTree(join(root.root, `tree-${n++}`), { 'README.md': { text: 'not CI\n' }, 'deploy/pod.yaml': 'trivy/k8s-privileged-pod.fixture' }));
  assert.equal(r.attempt, 'not-run');
  assert.equal(row(r, 'README.md'), 'not-applicable:notCiConfiguration');
});

test('changing or deleting the caller’s files after the worker copied them changes nothing', { skip }, async () => {
  const tree = capturedTree(join(root.root, `tree-${n++}`), { '.github/workflows/triage.yml': 'zizmor/workflow-injection.fixture', '.github/dependabot.yml': 'zizmor/dependabot.fixture' });
  const pending = run(tree);
  writeFileSync(tree[0]!.path, 'name: replaced\n');
  rmSync(tree[1]!.path);
  const r = await pending;
  assert.ok(audits(r, '.github/workflows/triage.yml').includes('template-injection'));
  assert.equal(row(r, '.github/dependabot.yml'), 'complete:');
});

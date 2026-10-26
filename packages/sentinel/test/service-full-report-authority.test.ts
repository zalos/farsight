import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  symlinkSync,
  readFileSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../dist/store/index.js';
import { workspaceOf, adoptedPolicy, adoptWorkspaceSettings, promoteRulePack } from '../dist/service/local.js';
import { scratchUnder } from './lease-helpers.ts';
import { initWorkspace } from '../dist/cli/init.js';
import { planWorkspaceCanonical, executeRun } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { loadPlan } from '../dist/execution/plans.js';
import {
  assessRun,
  fullReport,
  readContextGraph,
  workspaceInputs,
  MAX_CONTEXT_BYTES,
} from '../dist/service/full-report.js';
import { PREVIEW_FINDINGS_SCHEMA, PREVIEW_DETECTOR_ID } from '../dist/adapters/preview-detector.js';
import { publicRegistry, scannerExecution } from '../dist/service/scanner-profile.js';
import { adoptScannerAsset } from '../dist/service/scanner-assets.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { previewDriver } from '../dist/service/preview-driver.js';
import { createCheckDriverRegistry } from '../dist/execution/check-drivers.js';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { foundationProfile, OPERATIONS } from '../dist/service/trusted-profile.js';
import { unlock } from './snapshot-helpers.ts';
import { openSnapshot } from '../dist/snapshot/materialize.js';

// Every report assertion starts with a real owner-held store, admitted canonical plan, worker and publication.
// Faults are injected only into this test's trusted producer or its own accepted CAS files, never by fabricating
// a publication, store capability or receipt. The malformed worker is Sentinel's inert protocol fixture.
async function published(
  t: any,
  forged: boolean | 'json' | 'utf8' | 'line' | 'object' | 'shape' | 'auxiliary' | 'duplicate' = false,
  safe = false,
) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-full-report-')));
  const path = join(dir, 'workspace');
  mkdirSync(join(path, 'src'), { recursive: true });
  const file = join(path, 'src', 'lookup.ts');
  writeFileSync(
    file,
    safe
      ? 'export const lookup = (id: string) => db.query("SELECT * FROM invoice WHERE id = ?", [id]);\n'
      : 'export const lookup = (id: string) => db.query("SELECT * FROM invoice WHERE id = " + id);\n',
  );
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  initWorkspace({ workspace: path });
  assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now: new Date() }).outcome, 'prepared');
  assert.equal(
    promoteRulePack(ws, {
      packDir: realpathSync.native(builtinPackDir('foundation-preview')!),
      confirm: true,
      now: new Date(),
    }).outcome,
    'prepared',
  );
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath);
  t.after(() => {
    store.close();
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  const work = scratchUnder(store);
  const malformed = forged === 'json' || forged === 'utf8' || forged === 'object' || forged === 'shape';
  const worker = join(dir, 'malformed-worker.mjs');
  if (malformed)
    writeFileSync(
      worker,
      'globalThis.PAYLOAD = ' +
        JSON.stringify(forged) +
        '; await import(' +
        JSON.stringify(new URL('./fixtures/workers/report-malformed-worker.mjs', import.meta.url).href) +
        ');',
    );
  const registry = malformed
    ? createAdapterRegistry([
        {
          id: PREVIEW_DETECTOR_ID,
          version: 'test',
          kind: 'built-in',
          isolation: 'child',
          module: worker,
          coverage: 'per-file-per-rule',
        },
        ...Object.entries(OPERATIONS).map(([operation, id]) => ({
          id,
          version: '1',
          kind: 'operation' as const,
          operation: operation as any,
        })),
      ])
    : publicRegistry();
  const prepared = await planWorkspaceCanonical(store, {
    workspace: path,
    trustDir: ws.trustDir,
    policy: adopted.policy,
    scratchRoot: work,
    now: new Date(),
    registry,
    ...(malformed ? { profile: foundationProfile(registry) } : {}),
  });
  const runId = prepared.disclosure.runId;
  const base = previewDriver(registry);
  // Original fault injection at the trusted record producer, after a real worker and its real normalization.
  // The coordinator itself accepts the publication; no fabricated store or receipt capability stands in for it.
  const drivers = forged
    ? createCheckDriverRegistry(
        [
          {
            ...base,
            async normalize(ctx: any, v: any) {
              if (malformed) return { coverage: { ...v.result }, records: [] };
              const accepted = await base.normalize(ctx, v);
              if (forged === 'auxiliary')
                return {
                  ...accepted,
                  records: [
                    {
                      schema: 'application/json',
                      privacy: 'metadata' as const,
                      value: { schema: 'sentinel-preview-auxiliary/draft-1', note: 'not a finding document' },
                    },
                  ],
                };
              if (forged === 'duplicate') {
                const doc = JSON.parse(Buffer.from(v.output(v.outputs[0].id)).toString('utf8'));
                return {
                  ...accepted,
                  records: [
                    {
                      schema: 'application/json',
                      privacy: 'source-derived' as const,
                      value: { ...doc, duplicate: true },
                    },
                  ],
                };
              }
              if (forged === 'line') {
                const doc = JSON.parse(Buffer.from(v.output(v.outputs[0].id)).toString('utf8'));
                doc.findings[0].line = 999999;
                return {
                  ...accepted,
                  records: [{ schema: 'application/json', privacy: 'source-derived' as const, value: doc }],
                };
              }
              return {
                ...accepted,
                records: [
                  {
                    schema: 'application/json',
                    privacy: 'source-derived' as const,
                    value: { schema: PREVIEW_FINDINGS_SCHEMA, checks: ['foreign-check'], findings: [] },
                  },
                ],
              };
            },
          },
        ],
        registry,
      )
    : undefined;
  const summary = await executeRun(store, runId, { scratchRoot: work, ...(drivers ? { registry, drivers } : {}) });
  assert.equal(summary.state, 'completed');
  const admitted = await loadPlan(store, runId, 2);
  const unit = admitted.plan.units[0]!;
  const publication = store.ledger.getPublication({ id: unit.id, revision: unit.revision })!;
  assert.ok(publication?.attemptId);
  return {
    store,
    ws,
    file,
    runId,
    publication,
    request: { store, runId, workspace: path, trustDir: ws.trustDir, now: new Date() },
  };
}

test('real accepted publication: privacy and source-absent full-report replay', async (t) => {
  const f = await published(t);
  const a = await fullReport({ ...f.request, disclosure: 'shareable' });
  const b = await fullReport({ ...f.request, disclosure: 'private' });
  assert.equal(a.document.findings.length, 1);
  assert.ok(!a.json.includes('SELECT * FROM invoice WHERE id = '));
  assert.ok(b.json.includes('SELECT * FROM invoice WHERE id = '));
  rmSync(f.file);
  const replay = await fullReport({ ...f.request, disclosure: 'shareable' });
  assert.deepEqual(replay.document, a.document);
});

test('real accepted publication: missing finding bytes must refuse instead of report clean', async (t) => {
  const f = await published(t);
  assert.equal((await assessRun(f.store, f.runId, { trustDir: f.ws.trustDir })).observations.length, 1);
  let findingId: string | undefined;
  for (const o of f.publication.outputs) {
    if (o.schema !== 'application/json') continue;
    const value = JSON.parse((await f.store.readArtifact(o.id)).toString('utf8'));
    if (value.schema === PREVIEW_FINDINGS_SCHEMA) findingId = o.id;
  }
  assert.ok(findingId);
  const hex = findingId!.slice(7);
  const objectDir = join(f.store.storePath, 'objects', 'sha256', hex.slice(0, 2));
  const objects = readdirSync(objectDir).filter((name) => name.startsWith(hex + '.'));
  assert.ok(objects.length > 0);
  for (const name of objects) unlinkSync(join(objectDir, name));
  const observed = await fullReport({ ...f.request, disclosure: 'shareable' }).then(
    (r) => ({
      completeness: r.document.completeness,
      findings: r.document.findings.length,
      gaps: r.document.gaps.length,
    }),
    (e: any) => ({ refused: e.code }),
  );
  assert.deepEqual(observed, { refused: 'sentinel.report.evidenceUnbound' });
});

test('real accepted publication: forged check binding in a published finding is refused', async (t) => {
  const f = await published(t, true);
  await assert.rejects(
    assessRun(f.store, f.runId, { trustDir: f.ws.trustDir }),
    (e: any) => e.code === 'sentinel.report.evidenceUnbound',
  );
});

async function publishedPattern(t: any, mode: string) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-full-pattern-')));
  const path = join(dir, 'workspace');
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(
    join(path, 'src', 'lookup.ts'),
    'export function lookup(id: string) { return db.query("SELECT * FROM invoice WHERE id = " + id); }\n',
  );
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  initWorkspace({ workspace: path, profile: 'scanners' });
  assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now: new Date() }).outcome, 'prepared');
  assert.equal(
    promoteRulePack(ws, { packDir: realpathSync.native(builtinPackDir('pattern')!), confirm: true, now: new Date() })
      .outcome,
    'prepared',
  );
  assert.equal(
    (await adoptScannerAsset(ws, { kind: 'tool', id: 'pattern-semgrep', confirm: true, now: new Date() })).outcome,
    'prepared',
  );
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath);
  t.after(() => {
    store.close();
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  // Identical bytes at a distinct path remain distinct check scopes, even in one batched worker.
  writeFileSync(join(path, 'src', 'other.ts'), readFileSync(join(path, 'src', 'lookup.ts')));
  const work = scratchUnder(store);
  const prepared = await planWorkspaceCanonical(store, {
    workspace: path,
    trustDir: ws.trustDir,
    policy: adopted.policy,
    scratchRoot: work,
    now: new Date(),
  });
  const runId = prepared.disclosure.runId;
  const registry = publicRegistry();
  const assets = await scannerExecution(store, runId, ws.trustDir, work, registry);
  const driver = assets.drivers.driverFor('pattern-semgrep')!;
  let changed = 0;
  const drivers = createCheckDriverRegistry(
    [
      {
        ...driver,
        async normalize(ctx: any, v: any) {
          const normalized = await driver.normalize(ctx, v);
          return {
            ...normalized,
            records: normalized.records.map((r) => {
              if (r.schema !== 'sentinel-driver-finding/draft-1') return r;
              const f: any = structuredClone(r.value);
              assert.ok(f.assignedChecks.length > 0);
              if (mode === 'family') {
                const wrong = ctx.plan.pins.rules.find((p: any) => p.familyId !== f.assignedChecks[0].familyId)!;
                assert.ok(wrong);
                f.assignedChecks[0].familyId = wrong.familyId;
                f.assignedChecks[0].revision = wrong.revision;
              } else if (mode === 'scope') {
                const actual = ctx.checks.find((c: any) => c.id === f.assignedChecks[0].id)!;
                const wrong = ctx.checks.find(
                  (c: any) => c.familyId === actual.familyId && c.scopeId !== actual.scopeId,
                )!;
                assert.ok(wrong);
                f.assignedChecks = [{ id: wrong.id, familyId: wrong.familyId, revision: wrong.ruleRevision }];
              } else if (mode === 'duplicate') f.assignedChecks.push({ ...f.assignedChecks[0] });
              else if (mode === 'revision') f.assignedChecks[0].revision++;
              else if (mode === 'source') f.sourceId = 'other-source';
              else if (mode === 'kind') f.kind = 'advisory';
              else if (mode === 'attempt') f.attemptId = 'wrong-attempt';
              else if (mode === 'empty') f.assignedChecks = [];
              else if (mode === 'span') f.span.endByte = 999999;
              if (mode !== 'positive') changed++;
              return { ...r, value: f };
            }),
          };
        },
      },
    ],
    registry,
  );
  const done = await (await Coordinator.open({ ...assets, drivers, store, runId, registry, scratchRoot: work })).run();
  assert.equal(done.state, 'completed');
  assert.ok(
    mode === 'positive' || changed > 0,
    'the real pinned engine produced an accepted finding before fault injection',
  );
  const admitted = await loadPlan(store, runId, 2);
  assert.ok(admitted.plan.units.every((u) => store.ledger.getPublication({ id: u.id, revision: u.revision })));
  return { store, ws, runId };
}

const skip =
  process.env.SENTINEL_ISOLATION !== '1' && 'requires the existing pinned local Pattern image; no acquisition';
for (const mode of ['family', 'revision', 'scope', 'duplicate', 'source', 'kind', 'attempt', 'span', 'empty']) {
  test('real Pattern publication: forged ' + mode + ' binding is refused', { skip }, async (t) => {
    const f = await publishedPattern(t, mode);
    await assert.rejects(
      assessRun(f.store, f.runId, { trustDir: f.ws.trustDir }),
      (e: any) => e.code === 'sentinel.report.evidenceUnbound',
      'a genuinely published scanner record must agree with its exact assigned check',
    );
  });
}

test('new output is private and never overwrites existing files or links', async (t) => {
  const { writeNewFile } = await import('../dist/service/full-report.js');
  const { statSync, readFileSync, symlinkSync } = await import('node:fs');
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-report-file-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'report.json');
  writeNewFile(file, '{"fixture":true}');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(
    () => writeNewFile(file, 'replacement'),
    (e: any) => e.code === 'sentinel.report.outExists',
  );
  const link = join(dir, 'link.json');
  symlinkSync(file, link);
  assert.throws(
    () => writeNewFile(link, 'replacement'),
    (e: any) => e.code === 'sentinel.report.outExists',
  );
  assert.equal(readFileSync(file, 'utf8'), '{"fixture":true}');
});

test('FIFO context is refused without blocking', async (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-report-fifo-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fifo = join(dir, 'context.fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const module = pathToFileURL(new URL('../dist/service/full-report.js', import.meta.url).pathname).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'import {readContextGraph} from ' +
        JSON.stringify(module) +
        '; try { readContextGraph({path:' +
        JSON.stringify(fifo) +
        '}); process.exit(2) } catch { process.exit(0) }',
    ],
    { encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL' },
  );
  assert.equal(
    child.error,
    undefined,
    'a bounded context-file read must reject special files instead of blocking on their open',
  );
  assert.equal(child.status, 0);
});

for (const mode of ['json', 'utf8'] as const)
  test('accepted malformed ' + mode + ' output refuses a clean report', async (t) => {
    const f = await published(t, mode);
    const outputs = f.publication.outputs.filter((o) => o.schema === 'application/json');
    assert.equal(outputs.length, 1);
    await assert.rejects(assessRun(f.store, f.runId), (e: any) => e.code === 'sentinel.report.evidenceUnbound');
  });

test(
  'real Pattern publication: legitimate admitted tuples and distinct identical-byte scopes still report',
  { skip },
  async (t) => {
    const f = await publishedPattern(t, 'positive');
    const a = await assessRun(f.store, f.runId, { trustDir: f.ws.trustDir });
    assert.ok(a.observations.length >= 2);
    assert.deepEqual(
      new Set(a.observations.flatMap((o) => o.evidence.map((e) => e.relativePath))),
      new Set(['src/lookup.ts', 'src/other.ts']),
    );
  },
);

test('context regular-file bounds, UTF-8 and explicit repository positive', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'report-context-read-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'context.json');
  const graph = { nodes: [], edges: [] };
  writeFileSync(file, JSON.stringify(graph));
  assert.deepEqual(readContextGraph({ path: file, repo: 'fixture' }), { graph, repo: 'fixture' });
  const link = join(dir, 'link');
  symlinkSync(file, link);
  const invalid = (path: string) =>
    assert.throws(
      () => readContextGraph({ path, repo: 'fixture' }),
      (e: any) => e.code === 'sentinel.report.contextInvalid',
    );
  invalid(link);
  invalid(dir);
  writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
  invalid(file);
  writeFileSync(file, '{}');
  truncateSync(file, MAX_CONTEXT_BYTES + 1);
  invalid(file);
});

test('current workspace inputs stay bounded to genuine captured regular files without following links', async (t) => {
  const f = await published(t);
  const { snapshot } = await assessRun(f.store, f.runId);
  const root = f.request.workspace;
  const inputs = () => workspaceInputs(snapshot, 'workspace', root);
  assert.ok(inputs().some((i) => i.relativePath === 'src/lookup.ts'));
  const entry = snapshot.entries.find((e) => e.kind === 'file' && e.relativePath === 'src/lookup.ts') as any;
  const text = readFileSync(f.file);
  writeFileSync(f.file, Buffer.alloc(text.length, 0x61));
  assert.notEqual(
    inputs().find((i) => i.relativePath === entry.relativePath)?.content,
    entry.content,
    'same-size drift does not match',
  );
  writeFileSync(f.file, text);
  truncateSync(f.file, 128 * 1024 * 1024);
  assert.ok(!inputs().some((i) => i.relativePath === entry.relativePath), 'grown input exceeds its capture size');
  rmSync(f.file);
  const target = join(root, 'saved.ts');
  writeFileSync(target, text);
  symlinkSync(target, f.file);
  assert.ok(!inputs().some((i) => i.relativePath === entry.relativePath), 'final links are not inputs');
  rmSync(f.file);
  writeFileSync(f.file, text);
  const held = join(root, 'held');
  const { renameSync } = await import('node:fs');
  renameSync(join(root, 'src'), held);
  symlinkSync(held, join(root, 'src'));
  assert.ok(!inputs().some((i) => i.relativePath === entry.relativePath), 'parent links are not inputs');
  rmSync(join(root, 'src'));
  renameSync(held, join(root, 'src'));
  rmSync(f.file);
  assert.equal(spawnSync('mkfifo', [f.file]).status, 0);
  const module = new URL('../dist/service/full-report.js', import.meta.url).href;
  const script =
    'import {workspaceInputs} from ' +
    JSON.stringify(module) +
    '; const actual=workspaceInputs(' +
    JSON.stringify(snapshot) +
    ', "workspace", ' +
    JSON.stringify(root) +
    '); process.exit(actual.some(x=>x.relativePath==="src/lookup.ts")?2:0);';
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 1500,
    killSignal: 'SIGKILL',
  });
  assert.equal(child.error, undefined, 'a replaced FIFO cannot block a workspace read');
  assert.equal(child.status, 0, child.stderr);
});

test('accepted preview finding cannot cite a line beyond its captured source', async (t) => {
  const f = await published(t, 'line');
  await assert.rejects(assessRun(f.store, f.runId), (e: any) => e.code === 'sentinel.report.evidenceUnbound');
});

for (const mode of ['object', 'shape', 'duplicate'] as const)
  test('accepted preview requires one exact findings document: ' + mode, async (t) => {
    const f = await published(t, mode);
    await assert.rejects(
      fullReport({ ...f.request, disclosure: 'shareable' }),
      (e: any) => e.code === 'sentinel.report.evidenceUnbound',
    );
  });

// `.farsight/sentinel/settings.json` is ordinary captured source now. The preview rule applies to TypeScript,
// JavaScript and Java source files only, so no check is planned over the settings file: a genuine selection gap,
// not an accounting error. The report says so; nothing marks those bytes covered.
async function settingsOnlyUnchecked(f: any, doc: any) {
  assert.equal(doc.completeness, 'partial');
  assert.equal(doc.counts.unknownScopeBoundaries.n, 0);
  const admitted = await loadPlan(f.store, f.runId, 2);
  const snapshot = (await openSnapshot(f.store, admitted.plan.pins.snapshotId!)).snapshot;
  const included = snapshot.entries
    .filter((e: any) => e.kind === 'file' && e.disposition === 'included')
    .map((e: any) => e.relativePath);
  const planned = new Set(admitted.plan.units.flatMap((u: any) => u.inputs.map((i: any) => i.relativePath)));
  assert.deepEqual(
    included.filter((p: string) => !planned.has(p)),
    ['.farsight/sentinel/settings.json'],
  );
  assert.equal(doc.counts.seenByNoStage.n, 1);
}

test('accepted preview retains genuine findings beside unrelated auxiliary JSON', async (t) => {
  const f = await published(t, 'auxiliary');
  const report = await fullReport({ ...f.request, disclosure: 'shareable' });
  await settingsOnlyUnchecked(f, report.document);
  assert.equal(report.document.findings.length, 1);
  assert.equal(report.document.gaps.length, 0);
});

test('accepted preview retains an honest empty findings document', async (t) => {
  const f = await published(t, false, true);
  const report = await fullReport({ ...f.request, disclosure: 'shareable' });
  await settingsOnlyUnchecked(f, report.document);
  assert.equal(report.document.findings.length, 0);
  assert.equal(report.document.gaps.length, 0);
});

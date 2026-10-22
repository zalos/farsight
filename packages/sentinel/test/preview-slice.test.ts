// The foundation-preview path in one process: capture a synthetic workspace, plan the preview detector over it,
// run it through the real coordinator and supervisor, and read its published findings back from the ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, qualificationFor, SQLITE_RELEASE_POLICY } from '../dist/store/index.js';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { PREVIEW_ADAPTERS, previewPlan } from '../dist/service/preview-plan.js';
import { detect } from '../dist/adapters/preview-detector.js';
import { unlock } from './snapshot-helpers.ts';

const QUALIFIED = qualificationFor(SQLITE_RELEASE_POLICY, `${process.platform}-${process.arch}`, process.versions.sqlite ?? '') !== undefined;
const needsStore = QUALIFIED || process.env.CI ? {} : { skip: 'not a qualified store host' };

test('the preview detector flags SQL assembled from strings and nothing else', () => {
  assert.deepEqual(detect('a.ts', 'const q = "SELECT * FROM users WHERE id = " + id;', 'x').map(f => f.line), [1]);
  assert.deepEqual(detect('A.java', 'String q = "DELETE FROM t WHERE k = " + key;', 'x').length, 1);
  assert.equal(detect('a.ts', 'const q = `UPDATE t SET a = ${v}`;', 'x').length, 1);
  assert.equal(detect('a.ts', 'db.query("SELECT * FROM users WHERE id = ?", [id]);', 'x').length, 0, 'a parameterized query');
  assert.equal(detect('a.ts', '// "SELECT * FROM users WHERE id = " + id', 'x').length, 0, 'a comment');
  assert.equal(detect('a.py', 'q = "SELECT * FROM t WHERE x = " + y', 'x').length, 0, 'a language it does not check');
});

test('capture → preview plan → coordinator → published findings', needsStore, async t => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-slice-')));
  t.after(() => { unlock(dir); rmSync(dir, { recursive: true, force: true }); });
  const ws = join(dir, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src/users.ts'), 'export const find = (id: string) => db.query("SELECT * FROM users WHERE id = " + id);\n');
  writeFileSync(join(ws, 'src/Safe.java'), 'class Safe { String q = "SELECT * FROM t WHERE id = ?"; }\n');
  const store = await openStore(join(dir, 'store'));
  t.after(() => store.close());
  const captured = await captureSnapshot(store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/app', root: ws }] });
  const scratch = join(dir, 'scratch');
  mkdirSync(scratch, { mode: 0o700 });
  const plan = await previewPlan(store, { snapshotId: captured.record.snapshotId, policyRevision: `sha256:${'a'.repeat(64)}`, workDir: join(scratch, 'plan'), now: new Date().toISOString() });
  assert.deepEqual(plan.disclosure.effects, ['local-artifacts']);
  const coordinator = await Coordinator.open({ store, plan: plan.boundary, scratchRoot: scratch, registry: PREVIEW_ADAPTERS });
  const summary = await coordinator.run();
  assert.deepEqual([summary.state, summary.outcome, summary.published], ['completed', 'complete-coverage', 1], JSON.stringify(summary.failures));
  const pub = store.ledger.getPublication({ id: 'work-preview-detector', revision: 1 })!;
  const outputs = await Promise.all(pub.outputs.map(o => store.readArtifact(o.id)));
  const findings = outputs.map(b => { try { return JSON.parse(b.toString()); } catch { return null; } }).find(d => d?.schema === 'sentinel-preview-findings/draft-1');
  assert.deepEqual(findings.findings.map((f: any) => [f.path, f.line]), [['app/src/users.ts', 1]]);
  assert.equal(findings.checkedFiles, 2);
});

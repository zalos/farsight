import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStorageProbe } from '../sentinel-feasibility/storage.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('real child contenders, SIGKILL and release preserve the lock and revision ledger', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-storage-test-'));
  try {
    const workDir = join(root, 'work');
    const artifactDir = join(root, 'artifacts');
    const result = await runStorageProbe({ workDir, artifactDir });
    assert.equal(result.status, 'measured', JSON.stringify(result));
    assert.equal(result.experiment, 'E4');
    assert.ok(result.checks.length >= 11);
    assert.deepEqual(result.checks.filter(check => !check.passed), []);
    const byId = Object.fromEntries(result.checks.map(check => [check.id, check]));
    assert.deepEqual(byId['exclusive-contention'].evidence.outcomes.sort(), ['acquired', 'busy']);
    assert.equal(byId['sigkill-takeover'].evidence.signal, 'SIGKILL');
    assert.equal(byId['release-takeover'].evidence.takeover, 'acquired');
    assert.equal(result.metrics.childrenStarted, 5);
    assert.equal(result.metrics.childrenExited, 5);
    assert.equal(result.metrics.constraintRollbacks, 4);
    assert.equal(result.metrics.publications, 2);
    assert.equal(byId['independent-revisions-reopen'].evidence.journalMode, 'wal');
    assert.equal(byId['independent-revisions-reopen'].evidence.synchronous, 2);
    assert.equal(byId['exclusive-contention'].evidence.journalMode, 'delete');
    assert.deepEqual(await readdir(workDir), []);
    for (const artifact of result.artifacts) {
      assert.ok(!artifact.path.includes('/') && !artifact.path.includes('..'));
      const bytes = await readFile(join(artifactDir, artifact.path));
      assert.equal(bytes.length, artifact.bytes);
      assert.equal(sha256(bytes), artifact.sha256);
    }
    const { DatabaseSync } = await import('node:sqlite');
    const ledger = new DatabaseSync(join(artifactDir, 'E4-ledger.sqlite'), { readOnly: true });
    try {
      assert.equal(ledger.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(ledger.prepare('PRAGMA foreign_key_check').all(), []);
      const publications = ledger.prepare('SELECT work_id,work_revision,attempt_id FROM publications ORDER BY work_revision').all();
      assert.deepEqual(publications.map(row => ({ ...row })), [
        { work_id: 'logical-work', work_revision: 1, attempt_id: 'a1' },
        { work_id: 'logical-work', work_revision: 2, attempt_id: 'a2' },
      ]);
      assert.equal(ledger.prepare('SELECT active_attempt_id FROM work_units WHERE revision=1').get().active_attempt_id, 'a1');
    } finally { ledger.close(); }
    assert.ok(result.limitations.some(text => text.includes('twenty kills')));
    assert.ok(!JSON.stringify(result).includes(root));
    // A second complete run must acquire its own locks without leftovers from the first.
    const again = await runStorageProbe({ workDir, artifactDir: join(root, 'again') });
    assert.equal(again.status, 'measured', JSON.stringify(again));
    assert.ok(again.checks.every(check => check.passed));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid probe limits fail before spawning or opening SQLite', async () => {
  const result = await runStorageProbe({ workDir: 'unused', artifactDir: 'unused', timeoutMs: 0 });
  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0].evidence.reason, 'INVALID_PROBE_OPTIONS');
});

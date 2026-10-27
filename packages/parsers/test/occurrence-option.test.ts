import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestRepo } from '../dist/index.js';

test('application ingestion omits call sites by default and preserves them only on explicit opt-in', async () => {
  const root = mkdtempSync(join(tmpdir(), 'optional-sites-'));
  try {
    writeFileSync(join(root, 'main.ts'), 'export function save() {} export function run() { save(); save(); }');
    writeFileSync(join(root, 'Sample.java'), 'class Sample { void save() {} void run() { save(); save(); } }');
    const ordinary = await ingestRepo(root, { repoName: 'sample', stories: false });
    assert.ok(ordinary.edges.every((edge) => !('occurrences' in edge)));
    const detailed = await ingestRepo(root, { repoName: 'sample', stories: false, occurrences: true });
    assert.equal(detailed.edges.filter((edge) => edge.kind === 'calls' && edge.occurrences?.length === 2).length, 2);
    for (const edge of detailed.edges) delete edge.occurrences;
    assert.deepEqual(detailed, ordinary);
    assert.equal(JSON.stringify(detailed).length, JSON.stringify(ordinary).length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

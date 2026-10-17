// Baselines captured before extraction on 4bb662a. Only sourceHash (mtime-based) is volatile.
// Intentional additive occurrence evidence is checked separately, never folded into this baseline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestRepo } from '../dist/index.js';

function freezeTimes(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) freezeTimes(path);
    utimesSync(path, new Date('2000-01-01'), new Date('2000-01-01'));
  }
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
for (const [name, example] of [['tsjs', 'invoice-app'], ['java', 'spring-invoice-api'], ['workspace', 'nx-workspace'], ['mixed', '']] as const) {
  test(`package extraction preserves ${name} structure, evidence and enrichment`, async () => {
    const temp = mkdtempSync(join(tmpdir(), 'parser-compat-'));
    try {
      if (!example) {
        cpSync(join(root, 'examples/invoice-app'), join(temp, 'web'), { recursive: true });
        cpSync(join(root, 'examples/spring-invoice-api'), join(temp, 'service'), { recursive: true });
      }
      if (example) cpSync(join(root, 'examples', example), temp, { recursive: true });
      // The fixtures have file-derived design/report dates: fix their input mtimes, not their output evidence.
      freezeTimes(temp);
      const graph = await ingestRepo(temp, { repoName: 'compat', stories: false });
      const actual = JSON.parse(JSON.stringify(graph));
      delete actual.meta.sourceHash;
      const expected = JSON.parse(readFileSync(new URL(`./fixtures/extraction/${name}.json`, import.meta.url), 'utf8'));
      assert.deepEqual(actual, expected);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}

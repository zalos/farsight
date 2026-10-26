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
for (const [name, example] of [
  ['tsjs', 'invoice-app'],
  ['java', 'spring-invoice-api'],
  ['workspace', 'nx-workspace'],
  ['mixed', ''],
] as const) {
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
      assert.ok(actual.edges.every((edge: Record<string, unknown>) => !('occurrences' in edge)));
      const expected = JSON.parse(readFileSync(new URL(`./fixtures/extraction/${name}.json`, import.meta.url), 'utf8'));
      // This fixture intentionally declares a plumbing folder it does not contain. Keep the historical
      // graph baseline intact, but require the new diagnostic in both retained metadata and ingest output.
      if (name === 'workspace') {
        const warning =
          'apps/billing-web/farsight.config.json → plumbing: "src/plumbing/**" matches no indexed source file (missing, ignored, excluded or unsupported).';
        expected.meta.config.notes.push(warning);
        expected.specErrors = [warning];
      }
      if (name === 'mixed') {
        // Copied nested examples retain their original source-root document paths, and the
        // Java glossary contains three names that applyConfig does not bind to any node.
        const warnings = [
          'service/farsight.config.json:18 → glossary: "invoices" matches no indexed symbol name.',
          'service/farsight.config.json:38 → glossary: "invoice.sent" matches no indexed symbol name.',
          'service/farsight.config.json:39 → glossary: "payment.settled" matches no indexed symbol name.',
          'web/docs/design/screens.json:139 → flows.billing-cycle.docs: "docs/design/flows.md" names no readable source document.',
          'web/docs/design/screens.json:139 → flows.draft-and-send.docs: "docs/design/flows.md" names no readable source document.',
          'web/docs/design/screens.json:57 → flows.draft-and-send.docs: "docs/decisions/0001-approval-limits.md" names no readable source document.',
        ];
        expected.meta.config.notes.push(...warnings);
        expected.specErrors = warnings;
      }
      assert.deepEqual(actual, expected);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

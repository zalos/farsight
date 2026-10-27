import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { collectFiles, contentDigest } from '../dist/shared/files.js';
import { createParser } from '../dist/index.js';
import { tsJsAdapter } from '../dist/tsjs.js';

test('root and nested gitignore rules select sources, with negation, anchoring and explicit excludes', () => {
  const root = mkdtempSync(join(tmpdir(), 'farsight-ignore-'));
  const files = {
    '.gitignore': 'storybook-static/\n/root-only.ts\n*.generated.ts\n!keep.generated.ts\nignored/\n',
    'src/.gitignore': '!local.generated.ts\nnested.ts\ncase.ts\n',
    'root-only.ts': '',
    'src/root-only.ts': '',
    'src/live.ts': '',
    'src/nested.ts': '',
    'src/Case.ts': '',
    'drop.generated.ts': '',
    'keep.generated.ts': '',
    'src/local.generated.ts': '',
    'storybook-static/generated.ts': '',
    'apps/web/storybook-static/generated.ts': '',
    'ignored/.gitignore': '!child.ts\n',
    'ignored/child.ts': '',
  };
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const selected = (options = {}) =>
      collectFiles(root, ['.ts'], options)
        .map((p) => relative(root, p))
        .sort();
    assert.deepEqual(selected(), [
      'keep.generated.ts',
      'src/Case.ts',
      'src/live.ts',
      'src/local.generated.ts',
      'src/root-only.ts',
    ]);
    assert.deepEqual(selected({ exclude: ['**/*.generated.ts'] }), ['src/Case.ts', 'src/live.ts', 'src/root-only.ts']);
    assert.equal(selected({ gitignore: false }).length, 11);
    const before = contentDigest(root, collectFiles(root, ['.ts'], {}));
    writeFileSync(join(root, 'storybook-static/generated.ts'), 'export const generated = () => 1;');
    assert.equal(contentDigest(root, collectFiles(root, ['.ts'], {})), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('portable analysis fingerprints ignore bytes and directory evidence, including adding rules later', async () => {
  const root = mkdtempSync(join(tmpdir(), 'farsight-ignore-inputs-'));
  const parser = createParser({ adapters: [tsJsAdapter] });
  try {
    writeFileSync(join(root, 'live.ts'), 'export function live() {}');
    writeFileSync(join(root, 'generated.ts'), 'export function generated() {}');
    const before = await parser.parseRepository({ root, sourceId: 'demo' });
    writeFileSync(join(root, '.gitignore'), 'generated.ts\n');
    const after = await parser.parseRepository({ root, sourceId: 'demo' });
    assert.notEqual(after.analysis.fingerprint, before.analysis.fingerprint);
    assert.ok(after.analysis.inputs.some((i) => i.path === '.gitignore' && i.kind === 'content'));
    assert.ok(before.analysis.inputs.some((i) => i.path === '.' && i.kind === 'directory'));
    assert.ok(!after.graph.nodes.some((n) => n.loc?.path === 'generated.ts'));
    assert.equal(after.analysis.complete, true);
    const optOut = await parser.parseRepository({ root, sourceId: 'demo', gitignore: false });
    assert.ok(optOut.graph.nodes.some((n) => n.loc?.path === 'generated.ts'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

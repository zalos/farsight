// Doc-comment harvest: @see URLs and @design become links on the node, not
// prose (docs/ANNOTATIONS.md). Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDoc, parseDesignTag } from '../dist/shared/docs.js';
import { ingestRepo } from '../dist/index.js';

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-docs-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test('parseDoc: @see URLs are links, non-URL @see refs stay prose; @design joins a node to its design', () => {
  const d = parseDoc([
    'Quick submit — no login: vendor lookup, upload, submit.',
    '@see https://www.figma.com/design/EXAMPLE?node-id=26-9',
    '@see field-inventory SCR-07.6',
    '@design SCR-07 Quick submit',
    '@group contractor',
  ].join('\n'));
  assert.equal(d.docs, 'Quick submit — no login: vendor lookup, upload, submit. See: field-inventory SCR-07.6.');
  assert.deepEqual(d.links, [
    { kind: 'see', url: 'https://www.figma.com/design/EXAMPLE?node-id=26-9' },
    { kind: 'design', ref: 'SCR-07' },
  ]);
  assert.deepEqual(d.design, { status: 'both', origin: 'annotation', id: 'SCR-07', name: 'Quick submit' });
  assert.ok(d.tags.includes('design:scr-07'));
  assert.equal(d.group, 'contractor');
});

test('parseDesignTag: a Figma URL keeps its node id; a bare id is the docs name', () => {
  assert.deepEqual(parseDesignTag('https://www.figma.com/design/EXAMPLE/File?node-id=26-9&t=abc'), { status: 'both', origin: 'annotation', url: 'https://www.figma.com/design/EXAMPLE/File?node-id=26-9&t=abc', nodeId: '26-9' });
  assert.deepEqual(parseDesignTag('SCR-14a'), { status: 'both', origin: 'annotation', id: 'SCR-14a' });
  assert.equal(parseDesignTag(''), undefined);
});

test('ingestRepo carries links/design onto TS nodes and applies farsight.config.json itself (route guard reaches a spec-only route)', async () => {
  const dir = tempRepo({
    'farsight.config.json': JSON.stringify({ guards: { 'tracking token': ['GET /api/v1/track/{token}'] }, openapi: [{ path: 'docs/openapi.yaml' }] }),
    'docs/openapi.yaml': ['openapi: 3.1.0', 'info: {title: T, version: "1"}', 'paths:', '  /api/v1/track/{token}:', '    get:', '      operationId: track', '      summary: Track a submission.', '      description: Long form.', '      x-phase: 1', '      responses: {}'].join('\n'),
    'src/page.tsx': [
      '/**',
      ' * Tracking page for a contractor.',
      ' * @see https://example.com/docs/tracking',
      ' * @design https://www.figma.com/design/EXAMPLE?node-id=40-2 Tracking',
      ' */',
      'export function TrackingPage() { return <div/>; }',
    ].join('\n'),
  });
  const f = await ingestRepo(dir, { repoName: 'app' });
  assert.equal(f.configApplied, true);
  const page = f.nodes.find((n) => n.name === 'TrackingPage')!;
  assert.deepEqual(page.links, [{ kind: 'see', url: 'https://example.com/docs/tracking' }, { kind: 'design', url: 'https://www.figma.com/design/EXAMPLE?node-id=40-2' }]);
  assert.equal(page.design?.nodeId, '40-2');
  assert.equal(page.design?.name, 'Tracking');
  const route = f.nodes.find((n) => n.kind === 'route')!;
  assert.equal(route.contract?.status, 'spec-only');
  assert.equal(route.contract?.summary, 'Track a submission.');
  assert.ok(route.tags.includes('phase:1'));
  const guard = f.nodes.find((n) => n.kind === 'guard')!;
  assert.equal(guard.name, 'tracking token');
  assert.ok(f.edges.some((e) => e.kind === 'guards' && e.from === guard.id && e.to === route.id));
  // and config is not applied twice: the guard node exists once, the edge once
  assert.equal(f.nodes.filter((n) => n.kind === 'guard').length, 1);
  assert.equal(f.edges.filter((e) => e.kind === 'guards').length, 1);
});

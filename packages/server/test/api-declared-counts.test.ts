import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { apiSurface, applyConfig, buildIndex, type GraphNode, type GraphEdge } from '@farsight/core';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app');
const g = globalThis as any;
g.window = g;
g.document = { body: { className: 'lens-hybrid surface-apis' } };
const { STRINGS } = await import('../../core/dist/strings.js');
const { S } = await import(join(appDir, 'store.js'));
const { countsHtml } = await import(join(appDir, 'surfaces', 'apis.js'));
const { tipContentFor } = await import(join(appDir, 'lib', 'tooltip.js'));
S.STRINGS = STRINGS;
S.GRAPH = { nodes: [], edges: [] };

test('the API card and its tip name both sources of supplied operations in both registers', () => {
  const nodes: GraphNode[] = [
    {
      id: 'app::route::GET /found',
      kind: 'route',
      name: 'GET /found',
      tags: [],
      loc: { repo: 'app', path: 'routes.ts', line: 1 },
    },
  ];
  const edges: GraphEdge[] = [];
  applyConfig(nodes, { nodes: [{ kind: 'route', name: 'GET /manual' }] }, edges, { repo: 'app' });
  const counts = apiSurface(buildIndex(nodes, edges))[0]!.counts;
  for (const register of ['professional', 'hud']) {
    S.register = register;
    const html = countsHtml(counts, false);
    assert.match(html, /<b>2<\/b><span>supplied<\/span>/);
    assert.match(html, /1 found in code · 1 declared by a person/);
    const args = [...html.matchAll(/data-tip-args="([^"]+)"/g)]
      .map((m) => JSON.parse(m[1]!.replaceAll('&quot;', '"').replaceAll('&amp;', '&')))
      .find((a) => a.k === 'implemented');
    assert.deepEqual(args.breakdown, counts.implementedBreakdown);
    const tip = tipContentFor({ dataset: { tipId: 'apiCount', tipArgs: JSON.stringify(args) } }).content;
    assert.match(tip, /found in code/);
    assert.match(tip, /declared by a person/);
    assert.doesNotMatch(tip, /operations with a source location/);
  }
});

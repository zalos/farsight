import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyConfig,
  applySpecToFragment,
  buildIndex,
  businessSummary,
  journey,
  configFilesText,
  configSchemaProblem,
  readConfigFile,
  roleTable,
  scopeOfDir,
} from '../dist/index.js';
import type { FarsightConfig, GraphNode, GraphEdge, GraphFragment } from '../dist/index.js';
import { validate } from './validate.ts';

const handler = (path = 'src/bridge.ts'): GraphNode => ({
  id: `app::${path}::relayInvoice`,
  name: 'relayInvoice',
  kind: 'function',
  tags: [],
  loc: { repo: 'app', path, line: 1 },
});

test('declared routes resolve both handler forms, preserve business words and walk through the handler', () => {
  for (const ref of ['app::src/bridge.ts::relayInvoice', 'src/bridge.ts::relayInvoice']) {
    const nodes = [handler()];
    const edges: GraphEdge[] = [];
    const config: FarsightConfig = {
      nodes: [
        { kind: 'route', name: 'POST /legacy/{id}', handler: ref, business: 'A supplier posts an invoice.' },
        { kind: 'route', name: 'GET /unconnected' },
        { kind: 'external', name: 'Payments' },
        { kind: 'queue', name: 'invoices' },
      ],
    };
    applyConfig(nodes, config, edges);
    const route = nodes.find((n) => n.kind === 'route')!;
    assert.equal(route.id, 'app::route::POST /legacy/:param');
    assert.deepEqual(route.tags, ['declared']);
    assert.equal(route.loc, undefined);
    assert.equal(businessSummary(route), 'A supplier posts an invoice.');
    assert.deepEqual(
      edges.map((e) => [e.kind, e.from, e.to, e.resolution?.technique]),
      [['calls', route.id, handler().id, 'annotation-scan']],
    );
    assert.ok(journey(buildIndex(nodes, edges), route.id).steps.some((s) => s.nodeId === handler().id));
    assert.ok(nodes.some((n) => n.id === 'app::external::Payments' && n.tags.includes('declared')));
    assert.ok(nodes.some((n) => n.id === 'app::queue::invoices' && n.tags.includes('declared')));
    applyConfig(nodes, config, edges);
    assert.equal(nodes.length, 5);
    assert.equal(edges.length, 1);
  }
});

test('guard labels resolve config function guards, route guards and forward-declared manual guards', () => {
  const nodes = [handler(), { ...handler('src/auth.ts'), id: 'app::src/auth.ts::checkSession', name: 'checkSession' }];
  const edges: GraphEdge[] = [];
  applyConfig(
    nodes,
    {
      guards: { session: ['checkSession'], token: ['POST /legacy'], manual: ['POST /legacy'] },
      nodes: [
        { kind: 'route', name: 'POST /legacy', guards: ['session', 'token', 'manual', 'missing'] },
        { kind: 'guard', name: 'manual', tier: 'policy', business: 'A signed-in supplier.' },
      ],
    },
    edges,
  );
  const manual = nodes.find((n) => n.id === 'app::guard::manual')!;
  assert.deepEqual(manual.gateTier, { tier: 'policy', from: 'config' });
  assert.equal(nodes.filter((n) => n.name === 'manual').length, 1);
  assert.equal(edges.filter((e) => e.kind === 'guards').length, 3);
  assert.deepEqual(
    new Set(edges.map((e) => e.from)),
    new Set(['app::src/auth.ts::checkSession', 'app::guard::config:token', manual.id]),
  );
  assert.ok(edges.every((e) => e.resolution?.technique === 'annotation-scan'));
  assert.ok(!nodes.some((n) => n.name === 'missing'));
});

test('a reader route is augmented in place without losing its location or call evidence', () => {
  const route: GraphNode = { ...handler(), id: 'app::reader::GET /x/:id', kind: 'route', name: 'GET /x/:id' };
  const nodes = [route, handler()];
  const edges: GraphEdge[] = [
    {
      id: 'reader',
      kind: 'calls',
      from: route.id,
      to: handler().id,
      resolution: { status: 'resolved', technique: 'same-file', confidence: 'HIGH' },
    },
  ];
  const before = structuredClone(edges);
  applyConfig(
    nodes,
    { nodes: [{ kind: 'route', name: 'GET /x/{id}', loc: 'other.ts:99', handler: handler().id }] },
    edges,
  );
  assert.equal(nodes.filter((n) => n.kind === 'route').length, 1);
  assert.equal(route.id, 'app::reader::GET /x/:id');
  assert.deepEqual(route.loc, handler().loc);
  assert.deepEqual(edges, before);
});

test('a declared route reconciles as both with or without loc, including a second spec pass', () => {
  for (const loc of [undefined, 'legacy.pl:40']) {
    const fragment: GraphFragment = { repo: 'app', nodes: [], edges: [] };
    applyConfig(
      fragment.nodes,
      { nodes: [{ kind: 'route', name: 'POST /legacy', ...(loc ? { loc } : {}) }] },
      fragment.edges,
      { repo: 'app' },
    );
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Legacy', version: '1' },
      paths: { '/legacy': { post: { responses: { '200': { description: 'OK' } } } } },
    };
    for (const path of ['openapi.json', 'second.json']) {
      const result = applySpecToFragment(fragment, spec, { repo: 'app', path });
      assert.equal(result.matched.length, 1);
      assert.equal(result.specOnly.length, 0);
      assert.equal(fragment.nodes.find((n) => n.kind === 'route')!.contract?.status, 'both');
    }
    assert.equal(fragment.nodes.filter((n) => n.kind === 'route').length, 1);
  }
});

test('nested paths and handlers stay in the config folder, and absent targets never create stubs', () => {
  const nodes = [handler('nested/bridge.ts'), handler()];
  const edges: GraphEdge[] = [];
  applyConfig(
    nodes,
    {
      nodes: [
        { kind: 'route', name: 'POST /nested', loc: 'bridge.ts:8', handler: 'bridge.ts::relayInvoice' },
        { kind: 'route', name: 'GET /escape', loc: '../outside.ts:2', handler: 'app::src/bridge.ts::relayInvoice' },
        { kind: 'route', name: 'GET /unresolved', handler: 'missing.ts::missing' },
      ],
    },
    edges,
    { repo: 'app', dir: 'nested', scope: scopeOfDir('nested') },
  );
  assert.deepEqual(nodes.find((n) => n.name === 'POST /nested')!.loc, {
    repo: 'app',
    path: 'nested/bridge.ts',
    line: 8,
  });
  assert.equal(nodes.find((n) => n.name === 'GET /escape')!.loc, undefined);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.to, 'app::nested/bridge.ts::relayInvoice');
  assert.equal(nodes.length, 5);
});

test('the config schema refuses a bad kind, missing name and unknown node field with its path', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../../../schemas/farsight-config.schema.json', import.meta.url), 'utf8'),
  );
  for (const [node, path] of [
    [{ kind: 'table', name: 'x' }, 'kind'],
    [{ kind: 'route' }, 'name'],
    [{ kind: 'guard', name: 'session', typo: true }, 'typo'],
  ] as const) {
    assert.match(configSchemaProblem({ nodes: [node] }, 'config')!, new RegExp(`config\\.nodes\\[0\\]\\.${path}`));
    assert.ok(validate({ nodes: [node] }, schema).length);
  }
  assert.equal(
    configSchemaProblem({ nodes: [{ kind: 'route', name: 'POST /legacy', guards: ['session'] }] }, 'config'),
    null,
  );
  assert.match(configSchemaProblem({ nodes: [{ kind: 'route', name: 'not a route' }] }, 'config')!, /nodes\[0\].name/);
  const dir = mkdtempSync(join(tmpdir(), 'declared-config-'));
  try {
    writeFileSync(join(dir, 'farsight.config.json'), JSON.stringify({ nodes: [{ kind: 'guard' }] }));
    const read = readConfigFile(join(dir, 'farsight.config.json'));
    assert.ok('config' in read);
    assert.equal(read.config.nodes, undefined);
    assert.deepEqual(read.ignored, ['nodes']);
    assert.match(read.notes!.join('\n'), /nodes\[0\].name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config list prints declarations and the business sentence in either register', () => {
  for (const register of ['professional', 'hud'] as const) {
    const lines = configFilesText(
      {
        app: {
          files: [
            {
              path: 'farsight.config.json',
              dir: '.',
              root: true,
              fields: ['nodes'],
              ignored: [],
              nodes: [{ kind: 'route', name: 'POST /legacy', business: 'A supplier posts an invoice.' }],
            },
          ],
          conflicts: [],
          notes: [],
        },
      },
      'app',
      register,
    );
    assert.match(lines.join('\n'), /Declared · web address: POST \/legacy — A supplier posts an invoice\./);
  }
});

test('a grant word in a manual guard name does not manufacture a roles grant', () => {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  applyConfig(
    nodes,
    {
      nodes: [
        { kind: 'guard', name: 'role: ops.approver', tier: 'policy' },
        { kind: 'route', name: 'POST /approve', guards: ['role: ops.approver'] },
      ],
    },
    edges,
    { repo: 'app' },
  );
  const roles = roleTable(buildIndex(nodes, edges));
  assert.deepEqual(roles.roles, []);
  assert.deepEqual(roles.rows, []);
});

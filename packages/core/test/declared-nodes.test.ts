import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyConfig,
  apiSurface,
  apiImplementedCount,
  stateOfPlay,
  stateOfPlayLines,
  countedProblems,
  breakdownText,
  roleTableLines,
  t,
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
    assert.equal(route.id, 'app::route::POST /legacy/{id}');
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
  assert.ok(!route.tags.includes('declared'));
});

test('a declared route reconciles as both with or without loc, including a second spec pass', () => {
  for (const loc of [undefined, 'legacy.pl:40']) {
    const fragment: GraphFragment = { repo: 'app', nodes: [], edges: [] };
    applyConfig(
      fragment.nodes,
      { nodes: [{ kind: 'route', name: 'POST /legacy', ...(loc ? { loc } : {}) }] },
      fragment.edges,
      { repo: 'app', hasFile: (path) => path === 'legacy.pl' },
    );
    assert.equal(!!fragment.nodes[0]!.loc, !!loc);
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
    [{ kind: 'guard', name: 'session', handler: 'src/a.ts::run' }, 'handler'],
    [{ kind: 'queue', name: 'q', guards: ['session'] }, 'guards'],
    [{ kind: 'route', name: 'GET /x', tier: 'policy' }, 'tier'],
    [{ kind: 'external', name: 'Ledger', requires: 'admin' }, 'requires'],
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

test('an explicit manual guard grant reaches Roles, including a config route guard connection', () => {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  applyConfig(
    nodes,
    {
      guards: { approval: ['POST /approve'] },
      nodes: [
        { kind: 'guard', name: 'approval', tier: 'policy', requires: 'ops.approver' },
        { kind: 'route', name: 'POST /approve', guards: ['approval'], business: 'Approve the invoice.' },
      ],
    },
    edges,
    { repo: 'app', from: 'workspace config' },
  );
  const roles = roleTable(buildIndex(nodes, edges));
  assert.deepEqual(roles.roles, ['ops.approver']);
  assert.equal(roles.rows.length, 1);
  assert.equal(roles.rows[0]!.words, 'Approve the invoice.');
  assert.equal(roles.rows[0]!.requiresFrom, 'workspace config → nodes[approval]');
  assert.equal(edges.length, 1);
});

test('attaching a declaration to a reader guard preserves enforcement and produces no security drift', () => {
  const route: GraphNode = { ...handler(), id: 'app::route::GET /secure', kind: 'route', name: 'GET /secure' };
  const guard: GraphNode = {
    ...handler('src/auth.ts'),
    id: 'app::guard::requireRole(admin)',
    kind: 'guard',
    name: 'requireRole(admin)',
    tags: ['auth'],
  };
  const fragment: GraphFragment = {
    repo: 'app',
    nodes: [route, guard],
    edges: [{ id: 'reader-guard', from: guard.id, to: route.id, kind: 'guards' }],
  };
  applyConfig(
    fragment.nodes,
    {
      nodes: [
        {
          kind: 'guard',
          name: guard.name,
          business: 'An administrator may continue.',
          tier: 'policy',
          requires: 'admin',
        },
      ],
    },
    fragment.edges,
  );
  assert.deepEqual(guard.tags, ['auth']);
  assert.equal(guard.facets?.business?.description, 'An administrator may continue.');
  assert.equal(guard.gateTier?.tier, 'policy');
  assert.equal(fragment.edges[0]!.meta?.requires, 'admin');
  applySpecToFragment(
    fragment,
    {
      openapi: '3.0.0',
      info: { title: 'App', version: '1' },
      paths: { '/secure': { get: { 'x-guards': [guard.name], responses: { '200': { description: 'OK' } } } } },
    },
    { repo: 'app', path: 'openapi.json' },
  );
  assert.equal(fragment.nodes.find((n) => n.id === route.id)!.contract?.status, 'both');
  assert.deepEqual(fragment.nodes.find((n) => n.id === route.id)!.contract?.drift ?? [], []);
});

test('core refuses unsupported node kinds even when called without schema validation', () => {
  const nodes: GraphNode[] = [];
  applyConfig(
    nodes,
    {
      nodes: [
        { kind: 'table', name: 'evil_table' },
        { kind: 'function', name: 'injected' },
        { kind: 'route', name: 'not a route' },
      ],
    } as unknown as FarsightConfig,
    [],
    { repo: 'app' },
  );
  assert.deepEqual(nodes, []);
});

test('a route naming an unmatched config guard key creates one declared guard and reuses it', () => {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const config: FarsightConfig = {
    guards: { session: ['missingWrapper'] },
    nodes: [
      { kind: 'route', name: 'GET /one', guards: ['session'] },
      { kind: 'route', name: 'GET /two', guards: ['session'] },
    ],
  };
  applyConfig(nodes, config, edges, { repo: 'app' });
  applyConfig(nodes, config, edges, { repo: 'app' });
  assert.equal(nodes.filter((n) => n.kind === 'guard').length, 1);
  assert.equal(nodes.find((n) => n.kind === 'guard')!.id, 'app::guard::config:session');
  assert.equal(edges.length, 2);
  assert.ok(edges.every((e) => e.kind === 'guards' && e.resolution?.technique === 'annotation-scan'));
});

test('API and state counts separate reader evidence from hand-made routes, including declarations with locations', () => {
  const route: GraphNode = { ...handler(), id: 'app::route::GET /code', kind: 'route', name: 'GET /code' };
  const fragment: GraphFragment = { repo: 'app', nodes: [route], edges: [] };
  applyConfig(
    fragment.nodes,
    {
      nodes: [
        { kind: 'route', name: 'GET /manual' },
        { kind: 'route', name: 'GET /located', loc: 'src/bridge.ts:4' },
        { kind: 'route', name: 'GET /absent', guards: ['session'] },
        { kind: 'guard', name: 'session' },
      ],
    },
    fragment.edges,
  );
  const implied = apiSurface(buildIndex(fragment.nodes, fragment.edges));
  assert.equal(implied[0]!.counts.implemented, 4);
  assert.equal(implied[0]!.operations.find((o) => o.name === 'GET /located')!.loc?.line, 4);
  const report = applySpecToFragment(
    fragment,
    {
      openapi: '3.0.0',
      info: { title: 'App', version: '1' },
      paths: {
        '/code': { get: { responses: { '200': { description: 'OK' } } } },
        '/manual': { get: { responses: { '200': { description: 'OK' } } } },
        '/missing': { get: { responses: { '200': { description: 'OK' } } } },
      },
    },
    { repo: 'app', path: 'openapi.json' },
  );
  const index = buildIndex(fragment.nodes, fragment.edges);
  const api = apiSurface(index)[0]!;
  assert.equal(api.counts.operations, 5);
  assert.equal(api.counts.implemented, 4);
  const expected = [
    { n: 1, key: 'count.part.apiFoundInCode' },
    { n: 3, key: 'count.part.apiDeclaredByPerson' },
  ];
  assert.deepEqual(api.counts.implementedBreakdown, expected);
  assert.deepEqual(report.counts.implementedBreakdown, expected);
  assert.ok(
    report.codeOnly.every((r) =>
      r.contract.drift?.some(
        (d) => /declared by a person/.test(d.message) && !/implemented in the code/.test(d.message),
      ),
    ),
  );
  const state = stateOfPlay(index, undefined);
  assert.equal(state.built.operations.n, 4);
  assert.equal(state.built.operations.of, 5);
  assert.deepEqual(state.built.operations.breakdown, expected);
  assert.deepEqual(countedProblems(state.built.operations), []);
  assert.deepEqual(countedProblems(apiImplementedCount(api.counts)), []);
  for (const register of ['hud', 'professional'] as const) {
    assert.match(
      stateOfPlayLines(state, { register }).join('\n'),
      /4 of 5 operations found in code or declared by a person \(1 found in code · 3 declared by a person\)/,
    );
    assert.equal(breakdownText(apiImplementedCount(api.counts), register), '1 found in code · 3 declared by a person');
    assert.match(t('api.list.legend', register), /impl = found in code or declared by a person/);
    assert.match(t('roles.lead', register), /code or configuration/);
  }
  const noLoc = fragment.nodes.find((n) => n.name === 'GET /absent')!;
  assert.ok(!noLoc.contract?.drift?.some((d) => d.kind === 'security-declared-only'));
});

test('Roles text attributes explicit grants to configuration as well as code', () => {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  applyConfig(
    nodes,
    {
      nodes: [
        { kind: 'guard', name: 'approval', requires: 'ops.approver' },
        { kind: 'route', name: 'POST /approve', guards: ['approval'] },
      ],
    },
    edges,
    { repo: 'app' },
  );
  const lines = roleTableLines(roleTable(buildIndex(nodes, edges))).join('\n');
  assert.match(lines, /Roles named in code or configuration: ops.approver/);
  assert.match(lines, /farsight.config.json → nodes\[approval\]/);
  assert.doesNotMatch(lines, /roles the code names/);
});

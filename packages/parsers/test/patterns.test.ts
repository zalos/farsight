import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ingestRepo, testPatterns, applyPatterns, loadWorkspaceConfig, patternsTestText } from '../dist/index.js';
import { PATTERN_MAX_BYTES } from '../dist/patterns.js';
import { type PatternDecl, type GraphFragment, patternCounts } from '@farsight/core';
import { configSchemaProblem } from '@farsight/graph/config';

async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'pattern-test-'));
  try {
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const config = (patterns: PatternDecl[]) => JSON.stringify({ patterns }, null, 2);
const opts = { repoName: 'app', openapi: false, design: false, tests: false, stories: false, projects: false };
const route: PatternDecl = {
  id: 'route',
  files: ['**/*.ts'],
  match: { call: 'portal.$METHOD', args: { path: 0, handler: -1 } },
  emit: { kind: 'route', method: '$METHOD', path: '$path', handler: '$handler' },
  business: 'Accept a request at $path',
};

test('call captures, same-file resolution, distinct additions, unresolved first and source evidence', async () => {
  await fixture(
    {
      'farsight.config.json': config([route]),
      'main.ts': `export function submit() { return 1; }\nportal.post('/invoices/:id', submit);\nportal.post('/invoices/:id', submit);\nportal.get('/missing', absent);\n`,
      'other.ts': 'export function absent() { return 1; }',
    },
    async (root) => {
      const graph = await ingestRepo(root, opts);
      const node = graph.nodes.find((n) => n.id === 'app::route::POST /invoices/:param')!;
      assert.ok(node, JSON.stringify(graph.meta?.patterns));
      assert.equal(node.loc?.line, 2);
      assert.equal(node.snippet, "portal.post('/invoices/:id', submit)");
      assert.ok(node.tags.includes('pattern:route'));
      assert.equal(node.facets?.business?.description, 'Accept a request at /invoices/:id');
      const edge = graph.edges.find((e) => e.from === node.id && e.kind === 'calls')!;
      assert.equal(edge.resolution?.technique, 'config-pattern');
      assert.equal(edge.resolution?.confidence, 'HIGH');
      assert.match(edge.resolution?.note ?? '', /farsight.config.json → patterns\[route\] at main.ts:2/);
      assert.equal(graph.meta?.patterns?.rules[0]?.matched, 3);
      assert.equal(graph.meta?.patterns?.rules[0]?.nodes, 2);
      assert.equal(graph.meta?.patterns?.rules[0]?.edges, 1);
      assert.deepEqual(graph.meta?.patterns?.rules[0]?.unresolved, [{ path: 'main.ts', line: 4, capture: 'absent' }]);
      assert.ok(!graph.nodes.some((n) => n.name === '?'));
      const dry = await testPatterns(root, opts);
      assert.equal(dry.matches[0]?.name, 'GET /missing');
      assert.deepEqual(dry.report, graph.meta?.patterns);
      assert.match(patternsTestText(dry), /would emit route GET \/missing → unresolved/);
      assert.equal(patternCounts(dry.report)[0]?.matched.n, 3);
    },
  );
});

test('decorators, Java annotations and pair arguments join their enclosing methods', async () => {
  const rules: PatternDecl[] = [
    {
      id: 'decorator',
      files: ['*.ts'],
      match: { decorator: 'Endpoint', args: { path: 0 } },
      emit: { kind: 'route', path: '$path', handler: 'enclosing' },
    },
    {
      id: 'annotation',
      files: ['*.java'],
      match: { annotation: 'Endpoint', args: { path: 0, verb: 'pair:method' } },
      emit: { kind: 'route', method: '$verb', path: '$path', handler: 'enclosing' },
    },
    {
      id: 'marker',
      files: ['*.java'],
      match: { annotation: 'Privileged' },
      emit: { kind: 'guard', name: 'privileged', guards: 'enclosing', tier: 'policy' },
    },
  ];
  await fixture(
    {
      'farsight.config.json': config(rules),
      'main.ts': `class Controller {\n  @Endpoint('/decorated')\n  run() { return 1; }\n}\n`,
      'Controller.java': `class Controller {\n @Endpoint("/annotated", method = "POST")\n public String submit() { return "ok"; }\n @Privileged\n public void approve() {}\n}\n`,
    },
    async (root) => {
      const graph = await ingestRepo(root, opts);
      for (const name of ['GET /decorated', 'POST /annotated']) {
        const edge = graph.edges.find(
          (e) => e.from === `app::route::${name}` && e.resolution?.technique === 'config-pattern',
        );
        assert.ok(edge, JSON.stringify(graph.meta?.patterns));
        assert.equal(graph.nodes.find((n) => n.id === edge.to)?.kind, 'function');
      }
      const guard = graph.nodes.find((n) => n.id === 'app::guard::privileged');
      assert.equal(guard?.gateTier?.tier, 'policy');
      assert.ok(graph.edges.some((e) => e.kind === 'guards' && e.from === guard?.id));
    },
  );
});

test('raw query captures use bundled grammars, regex is per line with medium evidence', async () => {
  const rules: PatternDecl[] = [
    {
      id: 'query',
      files: ['*.ts'],
      match: {
        query:
          '((call_expression function: (identifier) @fn arguments: (arguments (string) @path (identifier) @handler)) @site (#eq? @fn "expose"))',
      },
      emit: { kind: 'route', path: '$path', handler: '$handler' },
    },
    {
      id: 'regex',
      files: ['routes.conf'],
      match: { regex: '^(?<verb>POST) (?<path>/\\S+) -> (?<handler>\\w+)$' },
      emit: { kind: 'route', method: '$verb', path: '$path', handler: '$handler' },
    },
    {
      id: 'python',
      files: ['*.py'],
      match: { query: '(function_definition name: (identifier) @name) @site' },
      emit: { kind: 'external', name: '$name' },
    },
  ];
  await fixture(
    {
      'farsight.config.json': config(rules),
      'main.ts': `export function save() {}\nexpose('/query', save);`,
      'routes.conf': 'ignored\nPOST /text -> save\nignored',
      'app.py': 'def outside():\n    pass\n',
    },
    async (root) => {
      const graph = await ingestRepo(root, opts);
      assert.ok(graph.edges.some((e) => e.from === 'app::route::GET /query' && e.resolution?.confidence === 'HIGH'));
      assert.equal(graph.nodes.find((n) => n.id === 'app::route::POST /text')?.loc?.line, 2);
      assert.ok(graph.nodes.some((n) => n.id === 'app::external::outside'));
      const fragment: GraphFragment = {
        repo: 'app',
        nodes: [
          {
            id: 'app::routes.conf::save',
            name: 'save',
            kind: 'function',
            tags: [],
            loc: { repo: 'app', path: 'routes.conf', line: 1, endLine: 3 },
          },
        ],
        edges: [],
      };
      await applyPatterns(fragment, root, opts, loadWorkspaceConfig(root), { rule: 'regex' });
      assert.equal(fragment.edges[0]?.resolution?.confidence, 'MEDIUM');
    },
  );
});

test('span join selects innermost declaration; member resolution is same-file and ambiguity stays unresolved', async () => {
  const rules: PatternDecl[] = [
    {
      id: 'guard',
      files: ['*.ts'],
      match: { call: 'assertRole', args: { role: 0 } },
      emit: { kind: 'guard', name: 'role: $role', guards: 'enclosing' },
    },
    route,
  ];
  await fixture(
    {
      'farsight.config.json': config(rules),
      'main.ts': `class C {\n  run() {\n    assertRole('staff');\n    portal.get('/member', this.handle);\n  }\n  handle() { return 1; }\n}\n`,
    },
    async (root) => {
      const graph = await ingestRepo(root, opts);
      const check = graph.edges.find((e) => e.from === 'app::guard::role: staff')!;
      assert.match(check.to, /C.run/);
      const routeEdge = graph.edges.find((e) => e.from === 'app::route::GET /member')!;
      assert.match(routeEdge.to, /C.handle/);
    },
  );
});

test('queue directions, rules, flags, external and entrypoint tagging use existing kinds', async () => {
  const rules: PatternDecl[] = [
    {
      id: 'queue',
      files: ['*.ts'],
      match: { call: 'send', args: { topic: 0 } },
      emit: { kind: 'queue', topic: '$topic', publishes: 'enclosing', consumes: 'receive' },
    },
    {
      id: 'rule',
      files: ['*.ts'],
      match: { call: 'validate' },
      emit: { kind: 'rule', name: 'invoice', validates: 'enclosing' },
    },
    { id: 'flag', files: ['*.ts'], match: { call: 'flag', args: { name: 0 } }, emit: { kind: 'flag', name: '$name' } },
    {
      id: 'external',
      files: ['*.ts'],
      match: { call: 'outside', args: { name: 0 } },
      emit: { kind: 'external', name: '$name' },
    },
    {
      id: 'entry',
      files: ['*.ts'],
      match: { call: 'start' },
      emit: { kind: 'entrypoint', name: 'nightly', handler: 'enclosing' },
    },
  ];
  await fixture(
    {
      'farsight.config.json': config(rules),
      'main.ts': `export function run() {\n send('invoices');\n validate();\n flag('ready');\n outside('erp');\n start();\n}\nexport function receive() {}\n`,
    },
    async (root) => {
      const graph = await ingestRepo(root, opts);
      assert.ok(graph.edges.some((e) => e.kind === 'publishes' && e.to === 'app::queue::invoices'));
      assert.ok(graph.edges.some((e) => e.kind === 'consumes' && e.from === 'app::queue::invoices'));
      assert.ok(graph.edges.some((e) => e.kind === 'validates' && e.from === 'app::rule::invoice'));
      assert.ok(graph.nodes.some((n) => n.kind === 'flag' && n.name === 'ready'));
      assert.ok(graph.nodes.some((n) => n.kind === 'external' && n.name === 'erp'));
      assert.ok(graph.nodes.find((n) => n.name === 'run')?.tags.includes('entrypoint'));
      assert.equal(graph.meta?.patterns?.rules.find((r) => r.id === 'entry')?.nodes, 0);
    },
  );
});

test('nested rules, source excludes, overlay origin and unmatched audit lines', async () => {
  const nested = { ...route, files: ['**/*.ts'] };
  const empty = { ...route, id: 'empty', match: { call: 'notCalled' } };
  await fixture(
    {
      'nested/farsight.config.json': config([nested, empty]),
      'nested/a.ts': `export function handle() {}\nportal.get('/nested', handle);`,
      'outside.ts': `portal.get('/outside', handle);`,
      'nested/skip.ts': `portal.get('/skip', handle);`,
    },
    async (root) => {
      const graph = await ingestRepo(root, {
        ...opts,
        exclude: ['nested/skip.ts'],
        configOverlay: { from: 'workspace-overlay', config: { patterns: [{ ...empty, id: 'overlay-empty' }] } },
      });
      assert.ok(graph.nodes.some((n) => n.id === 'app::route::GET /nested'));
      assert.ok(!graph.nodes.some((n) => n.name === 'GET /outside' || n.name === 'GET /skip'));
      assert.ok(
        graph.meta?.config?.notes.some((note) =>
          /nested\/farsight.config.json:\d+ → patterns: "empty" matched nothing/.test(note),
        ),
        JSON.stringify(graph.meta?.config),
      );
      assert.ok(
        graph.meta?.config?.notes.some((note) => note.startsWith('workspace-overlay → patterns: "overlay-empty"')),
      );
      const overlay = await ingestRepo(root, {
        ...opts,
        configOverlay: {
          from: 'workspace-overlay',
          config: {
            patterns: [{ ...route, id: 'overlay', files: ['outside.ts'], emit: { ...route.emit, handler: undefined } }],
          },
        },
      });
      assert.ok(overlay.nodes.find((n) => n.name === 'GET /outside')?.tags.includes('pattern:overlay'));
    },
  );
});

test('bounds: size, regex, source rule count, budget and missing grammar are reported; symlinks are not read', async () => {
  const textRule: PatternDecl = {
    id: 'text',
    files: ['*.txt'],
    match: { regex: '(?<name>outside)' },
    emit: { kind: 'external', name: '$name' },
  };
  assert.ok(configSchemaProblem({ patterns: [{ ...textRule, match: { regex: 'x'.repeat(513) } }] }, 'config'));
  assert.match(
    configSchemaProblem({ patterns: Array.from({ length: 65 }, (_, i) => ({ ...textRule, id: 'r' + i })) }, 'config')!,
    /64/,
  );
  await fixture(
    {
      'farsight.config.json': config([textRule]),
      'huge.txt': 'outside'.padEnd(PATTERN_MAX_BYTES + 1, ' '),
      'small.txt': 'outside',
    },
    async (root) => {
      const fragment: GraphFragment = { repo: 'app', nodes: [], edges: [] };
      const ws = loadWorkspaceConfig(root);
      let report = await applyPatterns(fragment, root, opts, ws);
      assert.match(report.rules[0]!.skipped[0]!.reason, /1 MiB/);
      report = await applyPatterns({ repo: 'app', nodes: [], edges: [] }, root, opts, ws, { budgetMs: 0 });
      assert.match(report.rules[0]!.skipped[0]!.reason, /budget/);
      ws.files[0]!.config.patterns = Array.from({ length: 65 }, (_, i) => ({
        ...textRule,
        id: 'r' + i,
        files: ['none.txt'],
      }));
      report = await applyPatterns(fragment, root, opts, ws);
      assert.match(report.rules[64]!.skipped[0]!.reason, /rule limit/);
      ws.files[0]!.config.patterns = [{ ...textRule, match: { call: 'outside' }, files: ['small.txt'] }];
      report = await applyPatterns(fragment, root, opts, ws);
      assert.match(report.rules[0]!.skipped[0]!.reason, /no grammar/);
      await fixture({ 'outside.txt': 'outside' }, async (outside) => {
        symlinkSync(join(outside, 'outside.txt'), join(root, 'linked.txt'));
        ws.files[0]!.config.patterns = [{ ...textRule, files: ['linked.txt'] }];
        report = await applyPatterns(fragment, root, opts, ws);
        assert.equal(report.rules[0]!.matched, 0);
      });
    },
  );
});

test('a pattern route merges with a spec route, preserving pattern metadata and handler', async () => {
  await fixture(
    {
      'farsight.config.json': config([route]),
      'main.ts': `export function submit() {}\nportal.post('/invoices/:id', submit);`,
      'openapi.json': JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Invoices', version: '1' },
        paths: { '/invoices/{id}': { post: { operationId: 'submit', responses: { 200: { description: 'ok' } } } } },
      }),
    },
    async (root) => {
      const graph = await ingestRepo(root, { ...opts, openapi: true, design: true });
      const routes = graph.nodes.filter((n) => n.id === 'app::route::POST /invoices/:param');
      assert.equal(routes.length, 1);
      assert.equal(routes[0]?.contract?.status, 'both');
      assert.equal(graph.meta?.patterns?.rules[0]?.matched, 1);
      assert.equal(graph.meta?.openapi?.applied.length, 1);
    },
  );
});

test('ambiguous names and expression arguments stay unresolved without inventing handler nodes', async () => {
  await fixture(
    {
      'farsight.config.json': config([route]),
      'main.ts': `class A { handle() {} }\nclass B { handle() {} }\nportal.get('/ambiguous', handle);\nportal.get('/expression', wrap(handle));`,
    },
    async (root) => {
      const result = await testPatterns(root, opts);
      assert.deepEqual(
        result.report.rules[0]?.unresolved.map((u) => u.capture),
        ['handle', '$handler'],
      );
      assert.equal(result.report.rules[0]?.nodes, 2);
      assert.equal(result.report.rules[0]?.edges, 0);
      assert.ok(result.matches.every((m) => m.unresolved.length && !m.handler));
    },
  );
});

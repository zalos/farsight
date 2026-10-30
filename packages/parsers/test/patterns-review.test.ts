import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { grammarQuery } from '@farsight/code-parser';
import { buildIndex, rolesFor, patternCounts, countedText, type PatternDecl, type GraphFragment } from '@farsight/core';
import { applyPatterns, ingestRepo, testPatterns, patternsTestText, loadWorkspaceConfig } from '../dist/index.js';
import { declaredPathWarnings } from '../dist/shared/declared-paths.js';

const opts = { repoName: 'app', openapi: false, design: false, tests: false, stories: false, projects: false };
const config = (patterns: PatternDecl[]) => JSON.stringify({ patterns }, null, 2);
const route: PatternDecl = {
  id: 'route',
  files: ['*.ts'],
  match: { call: 'router.$verb', args: { path: 0, handler: -1 } },
  emit: { kind: 'route', method: '$verb', path: '$path', handler: '$handler' },
};
const textRule: PatternDecl = {
  id: 'text',
  files: ['*.txt'],
  match: { regex: '(?<name>.+)' },
  emit: { kind: 'external', name: '$name' },
};
const fragment = (): GraphFragment => ({ repo: 'app', nodes: [], edges: [] });
async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'patterns-review-'));
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

test('a pattern reuses a parameterized Express route beside its spec and adds evidence to the existing edge', async () => {
  await fixture(
    {
      'farsight.config.json': config([route]),
      'app.ts': `import express from 'express';\nconst router = express.Router();\nexport function save() {}\nrouter.post('/users/:id', save);`,
      'openapi.json': JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Users', version: '1' },
        paths: { '/users/{id}': { post: { responses: { 200: { description: 'ok' } } } } },
      }),
    },
    async (root) => {
      const graph = await ingestRepo(root, { ...opts, openapi: true });
      const routes = graph.nodes.filter((n) => n.kind === 'route');
      assert.equal(routes.length, 1);
      assert.equal(routes[0]?.id, 'app::route::POST /users/:id');
      assert.equal(routes[0]?.contract?.status, 'both');
      assert.ok(routes[0]?.tags.includes('pattern:route'));
      assert.equal(graph.meta?.patterns?.rules[0]?.nodes, 0);
      assert.ok(!routes[0]?.contract?.drift?.some((d) => d.kind === 'code-only'));
      const edge = graph.edges.find((e) => e.from === routes[0]!.id && e.kind === 'calls');
      assert.match(edge?.resolution?.note ?? '', /patterns\[route\]/);
      assert.equal((await testPatterns(root, opts)).matches[0]?.name, 'POST /users/:id');
    },
  );
});

test('both Nest and Spring decorator orders select method declarations, never point routes or self-loops', async () => {
  for (const reverse of [false, true]) {
    const nest = ['@Get("/users")', '@Audited("ops.admin")'];
    const spring = ['@GetMapping("/users")', '@Audited("ops.admin")'];
    if (reverse) {
      nest.reverse();
      spring.reverse();
    }
    const rules: PatternDecl[] = [
      {
        id: 'nest-guard',
        files: ['*.ts'],
        match: { decorator: 'Audited', args: { grant: 0 } },
        emit: { kind: 'guard', name: 'audit', guards: 'enclosing', requires: '$grant' },
      },
      {
        id: 'nest-route',
        files: ['*.ts'],
        match: { decorator: 'Get', args: { path: 0 } },
        emit: { kind: 'route', path: '$path', handler: 'enclosing' },
      },
      {
        id: 'spring-guard',
        files: ['*.java'],
        match: { annotation: 'Audited', args: { grant: 0 } },
        emit: { kind: 'guard', name: 'audit-java', guards: 'enclosing', requires: '$grant' },
      },
      {
        id: 'spring-route',
        files: ['*.java'],
        match: { annotation: 'GetMapping', args: { path: 0 } },
        emit: { kind: 'route', path: '$path', handler: 'enclosing' },
      },
    ];
    await fixture(
      {
        'farsight.config.json': config(rules),
        'app.ts': `import { Controller, Get } from '@nestjs/common';\n@Controller('')\nclass Users {\n${nest.join('\n')}\nlist() { return []; }\n}`,
        'App.java': `@RestController\nclass Users {\n${spring.join('\n')}\npublic String list() { return "ok"; }\n}`,
      },
      async (root) => {
        const graph = await ingestRepo(root, opts);
        for (const label of ['audit', 'audit-java']) {
          const edge = graph.edges.find((e) => e.from === `app::guard::${label}` && e.kind === 'guards');
          assert.ok(edge, JSON.stringify(graph.meta?.patterns));
          assert.equal(graph.nodes.find((n) => n.id === edge.to)?.kind, 'function');
          assert.match(edge.to, /list/);
          assert.equal(edge.meta?.requires, 'ops.admin');
        }
        assert.ok(!graph.edges.some((e) => e.from === e.to));
        for (const e of graph.edges.filter((e) => e.kind === 'calls' && e.resolution?.technique === 'config-pattern'))
          assert.equal(graph.nodes.find((n) => n.id === e.to)?.kind, 'function');
      },
    );
  }
});

test('an overlay enclosing guard selects the enclosing function and ignores point locations', async () => {
  await fixture(
    {
      'app.ts': `import express from 'express';\nconst router = express.Router();\nexport function job() {\nrouter.get('/users', job);\n}\n`,
    },
    async (root) => {
      const graph = await ingestRepo(root, {
        ...opts,
        configOverlay: {
          from: 'workspace app',
          config: { patterns: [{ ...route, emit: { kind: 'guard', name: 'in-job', guards: 'enclosing' } }] },
        },
      });
      const edge = graph.edges.find((e) => e.from === 'app::guard::in-job' && e.kind === 'guards');
      assert.ok(edge?.to.endsWith('::job'));
      const point = fragment();
      point.nodes.push({
        id: 'point',
        kind: 'function',
        name: 'point',
        tags: [],
        loc: { repo: 'app', path: 'app.ts', line: 4 },
      });
      const ws = loadWorkspaceConfig(root, {
        configOverlay: {
          from: 'overlay',
          config: { patterns: [{ ...route, emit: { kind: 'guard', name: 'point', guards: 'enclosing' } }] },
        },
      });
      const report = await applyPatterns(point, root, opts, ws);
      assert.equal(point.edges.length, 0);
      assert.deepEqual(
        report.rules[0]?.unresolved.map((u) => u.capture),
        ['enclosing'],
      );
    },
  );
});

test('matched guards are enforced for drift and their requires capture reaches roles', async () => {
  const guard: PatternDecl = {
    id: 'guard',
    files: ['*.ts'],
    match: { call: 'policy', args: { grant: 0 } },
    emit: { kind: 'guard', name: 'permitted', guards: 'enclosing', requires: '$grant' },
  };
  await fixture(
    {
      'farsight.config.json': config([guard]),
      'app.ts': `import express from 'express';\nconst router = express.Router();\nexport function save() { policy('ops.editor'); }\nrouter.post('/users/:id', save);`,
      'openapi.json': JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Users', version: '1' },
        paths: { '/users/{id}': { post: { 'x-guards': ['permitted'], responses: { 200: { description: 'ok' } } } } },
      }),
    },
    async (root) => {
      const graph = await ingestRepo(root, { ...opts, openapi: true });
      const gate = graph.nodes.find((n) => n.id === 'app::guard::permitted')!;
      assert.ok(!gate.tags.includes('declared'));
      const route = graph.nodes.find((n) => n.kind === 'route')!;
      assert.ok(
        !route.contract?.drift?.some((d) => ['security-declared-only', 'security-missing-in-code'].includes(d.kind)),
      );
      const roles = rolesFor(buildIndex(graph.nodes, graph.edges), { guard: gate.id });
      assert.deepEqual(roles[0]?.roles, ['ops.editor']);
      assert.equal(roles[0]?.requiresFrom, 'farsight.config.json → patterns[guard]');
    },
  );
});

test('rules share a file tree and receive the remaining query timeout', async (t) => {
  const source = '(call_expression function: (identifier) @name) @site';
  const query = await grammarQuery('typescript', source);
  const matches = query.matches.bind(query);
  const roots: unknown[] = [];
  const mock = t.mock.method(query, 'matches', (root, options) => {
    roots.push(root);
    assert.ok(options.timeoutMicros > 0 && options.timeoutMicros <= 30_000_000);
    assert.equal(typeof options.progressCallback, 'function');
    return matches(root, options);
  });
  try {
    await fixture(
      {
        'farsight.config.json': config(
          [0, 1].map((i) => ({
            id: `r${i}`,
            files: ['*.ts'],
            match: { query: source },
            emit: { kind: 'external', name: '$name' },
          })),
        ),
        'app.ts': 'hello();',
      },
      async (root) => {
        const result = await testPatterns(root, opts);
        assert.deepEqual(
          result.report.rules.map((r) => r.matched),
          [1, 1],
        );
        assert.equal(roots.length, 2);
        assert.equal(roots[0], roots[1]);
      },
    );
  } finally {
    mock.mock.restore();
  }
});

test('deterministic file and byte stops warn even after matches, with file and overlay locations', async () => {
  await fixture(
    { 'farsight.config.json': config([textRule]), 'a.txt': 'alpha', 'b.txt': 'beta', 'c.txt': 'gamma' },
    async (root) => {
      const ws = loadWorkspaceConfig(root);
      const run = async (limits: { maxFiles?: number; maxBytes?: number; budgetMs?: number }) => {
        const graph = fragment();
        const report = await applyPatterns(graph, root, opts, ws, limits);
        graph.meta = { files: 0, sourceHash: '', patterns: report };
        return { report, warnings: declaredPathWarnings(graph, root, opts, ws, []) };
      };
      const first = await run({ maxFiles: 1 });
      assert.equal(first.report.rules[0]?.matched, 1);
      assert.deepEqual((await run({ maxFiles: 1 })).report, first.report);
      assert.match(first.warnings.join('\n'), /farsight.config.json:\d+ → patterns.*file budget/);
      const bytes = await run({ maxBytes: 5 });
      assert.equal(bytes.report.rules[0]?.matched, 1);
      assert.match(bytes.warnings.join('\n'), /byte budget/);
      assert.match((await run({ budgetMs: 0 })).warnings.join('\n'), /time budget/);
      ws.files[0]!.from = 'workspace';
      ws.files[0]!.path = 'workspace overlay';
      const overlay = await run({ maxFiles: 1 });
      assert.match(overlay.warnings.join('\n'), /workspace overlay → patterns/);
      assert.doesNotMatch(overlay.warnings.join('\n'), /workspace overlay:\d/);
    },
  );
});

test('literal dollars and placeholder-looking captures stay inert, and unresolved captures are individually named', async () => {
  const value = "/users/$&/$`/$'/{captures}/{name}";
  await fixture(
    {
      'farsight.config.json': config([route]),
      'app.ts': `function save() {}\nrouter.put(${JSON.stringify(value)}, save);`,
    },
    async (root) => {
      const result = await testPatterns(root, opts);
      const text = patternsTestText(result);
      assert.ok(text.includes(JSON.stringify(result.matches[0]?.captures)));
      assert.ok(text.includes(result.matches[0]!.name));
      assert.match(result.matches[0]!.name, /\$&/);
      const bad: PatternDecl = { ...route, emit: { kind: 'route', method: '$missingVerb', path: '$missingPath' } };
      writeFileSync(join(root, 'farsight.config.json'), config([bad]));
      const r = await testPatterns(root, opts);
      assert.deepEqual(
        r.report.rules[0]?.unresolved.map((u) => u.capture),
        ['$missingVerb', '$missingPath'],
      );
    },
  );
});

test('invalid matcher diagnostics name the selected branch and audit skipped rules without claiming no matches', async () => {
  await fixture(
    { 'farsight.config.json': config([{ ...textRule, match: { regex: 'a'.repeat(600) } }]), 'a.txt': 'a' },
    async (root) => {
      const graph = await ingestRepo(root, opts);
      assert.match(graph.meta?.patterns?.rules[0]?.skipped[0]?.reason ?? '', /regex.*512/);
      assert.doesNotMatch(graph.specErrors?.join('\n') ?? '', /matched nothing|match.call/);
      const ws = loadWorkspaceConfig(root);
      ws.files[0]!.config.patterns = Array.from({ length: 65 }, (_, i) => ({ ...textRule, id: 'r' + i }));
      const f = fragment();
      f.meta = { files: 0, sourceHash: '', patterns: await applyPatterns(f, root, opts, ws) };
      assert.match(declaredPathWarnings(f, root, opts, ws, []).join('\n'), /r64.*source rule limit/);
    },
  );
});

test('runtime confines traversal and symlinked directories and enforces regex and query limits before compilation', async () => {
  await fixture(
    { 'farsight.config.json': config([textRule]), 'a.txt': 'a'.repeat(512), 'app.ts': 'hello();' },
    async (root) => {
      const ws = loadWorkspaceConfig(root);
      const run = async (rule: PatternDecl) => {
        ws.files[0]!.config.patterns = [rule];
        return (await applyPatterns(fragment(), root, opts, ws)).rules[0]!;
      };
      assert.match((await run({ ...textRule, files: ['../**'] })).skipped[0]!.reason, /leaves the source/);
      await fixture({ 'external.txt': 'secret' }, async (outside) => {
        symlinkSync(outside, join(root, 'linked'));
        assert.equal((await run({ ...textRule, files: ['linked/**'] })).matched, 0);
      });
      assert.equal((await run({ ...textRule, match: { regex: 'a'.repeat(512) } })).matched, 1);
      assert.match((await run({ ...textRule, match: { regex: 'a'.repeat(513) } })).skipped[0]!.reason, /regex.*512/);
      assert.match(
        (await run({ ...textRule, files: ['*.ts'], match: { query: ' '.repeat(4097) } })).skipped[0]!.reason,
        /query.*4096/,
      );
      assert.match(
        (
          await run({
            ...textRule,
            files: ['*.ts'],
            match: { query: `((identifier) @name (#match? @name "${'a'.repeat(513)}"))` },
          })
        ).skipped[0]!.reason,
        /512/,
      );
    },
  );
});

test('dry runs with no selected rule return before reading source files', async (t) => {
  await fixture({ 'app.ts': 'a();' }, async (root) => {
    const original = fs.readFileSync;
    let reads = 0;
    const spy = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof original>) => {
      if (String(args[0]) === join(root, 'app.ts')) reads++;
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      assert.equal((await testPatterns(root, opts)).matches.length, 0);
      writeFileSync(join(root, 'farsight.config.json'), config([route]));
      assert.equal((await testPatterns(root, opts, { rule: 'absent' })).matches.length, 0);
      assert.equal(reads, 0);
      await ingestRepo(root, opts);
      assert.ok(reads > 0, 'the same read probe observes adapter extraction during ingest');
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

test('source previews and dry-run details are capped, with named counts and unresolved matches retained first', async () => {
  const query: PatternDecl = {
    id: 'long',
    files: ['*.ts'],
    match: { query: '(function_declaration name: (identifier) @handler) @site' },
    emit: { kind: 'guard', name: '$handler', handler: '$handler' },
  };
  await fixture(
    {
      'farsight.config.json': config([query]),
      'app.ts': `function long() {\n${'  hello();\n'.repeat(100)}}\nfunction other() {}\nfunction another() {}`,
    },
    async (root) => {
      const graph = await ingestRepo(root, opts);
      assert.ok(graph.nodes.find((n) => n.id === 'app::guard::long')!.snippet!.split('\n').length <= 15);
      const result = await testPatterns(root, opts, { maxMatches: 2 });
      assert.equal(result.matches.length, 2);
      assert.equal(result.matchCounts.returned.n, 2);
      assert.equal(result.matchCounts.omitted.n, 1);
      assert.ok(result.matches[0]!.text.split('\n').length <= 15);
      assert.ok(result.matches[0]!.captures.site!.split('\n').length <= 15);
      assert.match(patternsTestText(result), /2 matches returned in this source · 1 match omitted in this source/);
      assert.match(
        patternCounts(result.report, 'actual-source')[0]!.matched.source,
        /meta.patterns\["actual-source"\].rules\[0\].matched/,
      );
    },
  );
  await fixture(
    {
      'farsight.config.json': config([route]),
      'app.ts': `function save() {}\nrouter.get('/a', save);\nrouter.get('/b', save);\nrouter.get('/c', absent);`,
    },
    async (root) => {
      const r = await testPatterns(root, opts, { maxMatches: 1 });
      assert.equal(r.matches[0]!.unresolved[0], 'absent');
      assert.equal(r.matchCounts.omitted.n, 2);
    },
  );
});

test('only HTTP verbs emit routes, and invalid present captures name the affected variable', async () => {
  const verbs = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'];
  await fixture(
    {
      'farsight.config.json': config([route]),
      'app.ts': `function save() {}\n${[...verbs, 'use', 'on', 'all'].map((verb) => `router.${verb}('/users/:id', save);`).join('\n')}\nrouter.get(somePath, save);`,
    },
    async (root) => {
      const graph = fragment();
      const report = await applyPatterns(graph, root, opts, loadWorkspaceConfig(root));
      assert.deepEqual(
        graph.nodes.map((n) => n.name),
        verbs.map((verb) => `${verb.toUpperCase()} /users/:param`),
      );
      assert.equal(report.rules[0]!.unresolved.filter((u) => u.capture === '$verb').length, 3);
      assert.equal(report.rules[0]!.unresolved.filter((u) => u.capture === '$path').length, 1);
      assert.ok(!report.rules[0]!.unresolved.some((u) => u.capture === '$verb $path'));
    },
  );
});

test('invalid rule diagnostics retain the config array index and reject multiple matchers explicitly', async () => {
  await fixture(
    {
      'farsight.config.json': config([
        textRule,
        { ...textRule, id: 'long', match: { regex: 'a'.repeat(513) } },
        { ...textRule, id: 'two', match: { call: 'hello', regex: 'a' } } as PatternDecl,
      ]),
      'a.txt': 'a',
    },
    async (root) => {
      const report = await applyPatterns(fragment(), root, opts, loadWorkspaceConfig(root));
      assert.match(report.rules[1]!.skipped[0]!.reason, /config\.patterns\[1\]\.match\.regex.*512/);
      assert.match(report.rules[2]!.skipped[0]!.reason, /config\.patterns\[2\]\.match requires exactly one matcher/);
    },
  );
});

test('captured names and unresolved values are capped before graph emission and dry-run reporting', async () => {
  await fixture(
    {
      'farsight.config.json': config([textRule]),
      'a.txt': 'a'.repeat(200_000),
    },
    async (root) => {
      const graph = fragment();
      await applyPatterns(graph, root, opts, loadWorkspaceConfig(root));
      assert.equal(graph.nodes[0]!.name.length, 512);
      assert.equal(graph.nodes[0]!.id.length, 'app::external::'.length + 512);
      const dry = await testPatterns(root, opts);
      assert.equal(dry.matches[0]!.captures.name.length, 512);
      assert.equal(dry.matches[0]!.name.length, 512);
      writeFileSync(
        join(root, 'farsight.config.json'),
        config([{ ...textRule, emit: { kind: 'guard', name: 'long-handler', handler: '$name' } }]),
      );
      writeFileSync(join(root, 'a.txt'), 'h'.repeat(50_000));
      const unresolved = await testPatterns(root, opts);
      assert.equal(unresolved.report.rules[0]!.unresolved[0]!.capture.length, 512);
      assert.equal(unresolved.matches[0]!.unresolved[0]!.length, 512);
      assert.ok(!patternsTestText(unresolved).includes('h'.repeat(513)));
    },
  );
});

test('per-rule detail rows are bounded with accurate omitted Counteds, and budget warnings survive the cap', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 120 }, (_, i) => [`${String(i).padStart(3, '0')}.txt`, 'unknown']),
  );
  await fixture(
    {
      ...files,
      'farsight.config.json': config([
        { ...textRule, files: ['000.txt'], emit: { kind: 'guard', name: 'gate', handler: '$name' } },
        { ...route, id: 'unsupported', files: ['*.txt'] },
      ]),
    },
    async (root) => {
      writeFileSync(join(root, '000.txt'), 'missing\n'.repeat(120));
      const ws = loadWorkspaceConfig(root);
      const graph = fragment();
      const report = await applyPatterns(graph, root, opts, ws);
      assert.equal(report.rules[0]!.unresolved.length, 100);
      assert.equal(report.rules[0]!.unresolvedOmitted, 20);
      assert.equal(report.rules[1]!.skipped.length, 100);
      assert.equal(report.rules[1]!.skippedOmitted, 20);
      const counts = patternCounts(report, 'app');
      assert.equal(counts[0]!.unresolved.n, 120);
      assert.equal(counts[1]!.skipped.n, 120);
      for (const register of ['professional', 'hud'] as const) {
        assert.match(
          countedText(counts[0]!.unresolvedOmitted!, { register, lens: 'business' }),
          /… and 20 more unresolved references/,
        );
        assert.match(
          countedText(counts[1]!.skippedOmitted!, { register, lens: 'code' }),
          /… and 20 more skipped inputs/,
        );
      }
      assert.match(counts[0]!.unresolvedOmitted!.source, /meta.patterns\["app"\].rules\[0\].unresolvedOmitted/);
      assert.match(patternsTestText({ repo: 'app', report, matches: [] }), /… and 20 more unresolved references/);
      graph.meta = {
        files: 0,
        sourceHash: '',
        patterns: await applyPatterns(fragment(), root, opts, ws, { maxFiles: 105 }),
      };
      assert.equal(graph.meta.patterns!.rules[1]!.skipped.length, 100);
      assert.equal(graph.meta.patterns!.rules[1]!.skippedOmitted, 6);
      assert.match(declaredPathWarnings(graph, root, opts, ws, []).join('\n'), /file budget exhausted/);
    },
  );
});

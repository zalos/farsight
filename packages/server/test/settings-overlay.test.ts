import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { GraphStore, CONFIG_FIELDS, CONFIG_OVERLAY_FIELDS } from '@farsight/core';
import { settingsProblem, syncSources, type Settings } from '../dist/index.js';
import { isWriteRoute } from '../dist/guard.js';

const source = { id: 'app', name: 'app', type: 'local' as const, path: 'source', enabled: true };
const settings = (extra: Record<string, unknown> = {}) => ({
  defaultLens: 'code',
  collections: [],
  sources: [{ ...source, ...extra }],
});

test('settings overlay validation reports field paths in rule order without echoing secret values', () => {
  for (const config of [null, [], 1, 'bad'])
    assert.match(settingsProblem(settings({ config }))!, /sources\[0\].config must be an object/);
  for (const field of ['design', 'tests', 'storybook', 'plumbing', 'tooling', 'projects', 'journeys', 'openapi'])
    assert.match(
      settingsProblem(settings({ config: { [field]: [] } }))!,
      new RegExp(`sources\\[0\\].config.${field} is not a workspace overlay field`),
    );
  assert.match(
    settingsProblem(settings({ config: { glosary: {} } }))!,
    /sources\[0\].config.glosary is not a farsight.config.json field/,
  );
  for (const field of CONFIG_OVERLAY_FIELDS.filter((f) => !(CONFIG_FIELDS as readonly string[]).includes(f)))
    assert.equal(
      settingsProblem(settings({ config: { [field]: {} } })),
      `sources[0].config.${field} is not in this build`,
    );
  assert.match(
    settingsProblem(settings({ config: { tags: { billing: 42 } } }))!,
    /sources\[0\].config.tags.billing must be array/,
  );
  assert.match(
    settingsProblem(settings({ config: { glossary: { submit: {} } } }))!,
    /sources\[0\].config.glossary.submit.label is required/,
  );
  assert.equal(
    settingsProblem(settings({ config: { glossary: { submit: { label: 'Submit' } }, tags: { work: ['submit'] } } })),
    null,
  );
  const pasted = 'pasted-value-for-refusal';
  const problem = settingsProblem(settings({ auth: { secret: pasted }, config: null }))!;
  assert.match(problem, /sources\[0\].auth.secret/);
  assert.ok(!problem.includes(pasted));
});

test('OpenAPI registration shapes validate in the same settings validator', () => {
  for (const openapi of [null, {}, 'bad'])
    assert.match(settingsProblem(settings({ openapi }))!, /sources\[0\].openapi must be array/);
  for (const entry of [
    null,
    [],
    {},
    { path: 'x', url: 'https://example.com/x' },
    { path: '/etc/spec' },
    { path: '../spec' },
    { path: 'https://example.com/spec' },
    { path: 'docs/../../spec' },
    { path: 'docs/spec', phaseOrder: [1] },
    { path: 'C:\\spec' },
    { url: 'file:///etc/spec' },
    { url: 'https://' },
    { path: 'x', name: 4 },
    { path: 'x', phase: true },
    { path: 'x', extra: true },
  ])
    assert.match(settingsProblem(settings({ openapi: [entry] }))!, /sources\[0\].openapi\[0\]/);
  assert.equal(
    settingsProblem(
      settings({
        openapi: [
          { path: 'docs/v1..2.json', name: 'API', phase: 'draft', phaseOrder: ['draft', 'live'] },
          { url: 'https://example.com/spec' },
        ],
        openapiIgnore: ['old/spec.json'],
      }),
    ),
    null,
  );
  assert.match(settingsProblem(settings({ openapiIgnore: {} }))!, /sources\[0\].openapiIgnore/);
  assert.match(settingsProblem(settings({ openapiIgnore: [1] }))!, /sources\[0\].openapiIgnore\[0\]/);
});

async function server(t: { after: (fn: () => Promise<void>) => void }, readOnly?: 'flag' | 'as-of') {
  const ws = mkdtempSync(join(tmpdir(), 'farsight-settings-'));
  const graph = join(ws, 'graph.json');
  new GraphStore().save(graph);
  mkdirSync(join(ws, '.farsight'));
  mkdirSync(join(ws, 'source'));
  writeFileSync(join(ws, 'source', 'app.ts'), 'export function submit() { return 1; }');
  const file = join(ws, '.farsight', 'settings.json');
  writeFileSync(file, JSON.stringify(settings()));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const module = new URL('../dist/index.js', import.meta.url).href;
  const app = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { serveGraph } = await import(${JSON.stringify(module)}); serveGraph(${JSON.stringify(graph)}, ${address.port}, ${JSON.stringify(ws)}, ${JSON.stringify({ readOnly })});`,
    ],
    {
      cwd: ws,
      env: { ...process.env, MODELHUB_DIR: join(ws, 'modelhub'), FIGMA_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let logs = '';
  app.stdout.on('data', (data) => {
    logs += data;
  });
  app.stderr.on('data', (data) => {
    logs += data;
  });
  t.after(async () => {
    if (app.exitCode === null) {
      const stopped = once(app, 'exit');
      app.kill();
      await stopped;
    }
    rmSync(ws, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  for (let i = 0; i < 100; i++) {
    try {
      if ((await call('GET', '/api/settings')).status === 200) break;
    } catch {
      /* booting */
    }
    if (i === 99 || app.exitCode !== null) throw new Error(`server did not start: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { ws, file, graph, call, saved: () => JSON.parse(readFileSync(file, 'utf8')) as Settings };
}

test('settings check is read-only, has the validator sentence, and obeys the request guard', async (t) => {
  for (const readOnly of ['flag', 'as-of'] as const) {
    const s = await server(t, readOnly);
    const before = readFileSync(s.file, 'utf8');
    const invalid = settings({ config: { tests: {} } });
    assert.deepEqual(await s.call('POST', '/api/settings/check', invalid), {
      status: 200,
      body: { ok: false, problem: settingsProblem(invalid) },
    });
    assert.deepEqual(await s.call('POST', '/api/settings/check', settings()), { status: 200, body: { ok: true } });
    assert.equal(
      (await s.call('POST', '/api/settings/check', settings(), { origin: 'https://evil.example' })).status,
      403,
    );
    for (const [method, path] of [
      ['POST', '/api/sources/app/openapi'],
      ['DELETE', '/api/sources/app/openapi?path=docs/spec.json'],
    ]) {
      assert.equal(isWriteRoute(method, path), true);
      assert.equal(
        (await s.call(method!, path!, method === 'POST' ? { path: 'docs/spec.json' } : undefined)).status,
        403,
      );
    }
    assert.equal(readFileSync(s.file, 'utf8'), before);
    assert.equal(isWriteRoute('POST', '/api/settings/check'), false);
    const version = (await s.call('GET', '/api/version')).body;
    assert.deepEqual(version.configFields, CONFIG_FIELDS);
    assert.deepEqual(
      version.overlayFields,
      CONFIG_OVERLAY_FIELDS.filter((f) => (CONFIG_FIELDS as readonly string[]).includes(f)),
    );
  }
});

test('registration replaces, dismisses and restores references in workspace settings only', async (t) => {
  const s = await server(t);
  const sourceBytes = readFileSync(join(s.ws, 'source', 'app.ts'), 'utf8');
  for (const path of ['docs/spec.json', 'https://example.com/spec.json']) {
    const url = '/api/sources/app/openapi';
    for (const name of ['First', 'Updated']) {
      const res = await s.call('POST', url, {
        ...(path.startsWith('https:') ? { url: path } : { path }),
        name,
        phase: 'draft',
        phaseOrder: ['draft', 'live'],
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.next, 'POST /api/sync');
      assert.equal(s.saved().sources[0]?.openapi?.length, 1);
      assert.equal(s.saved().sources[0]?.openapi?.[0]?.name, name);
      assert.deepEqual(s.saved().sources[0]?.openapi?.[0]?.phaseOrder, ['draft', 'live']);
    }
    assert.equal((await s.call('DELETE', `${url}?path=${encodeURIComponent(path)}`)).status, 200);
    assert.deepEqual(s.saved().sources[0]?.openapi, []);
    assert.ok(s.saved().sources[0]?.openapiIgnore?.includes(path));
    await s.call('POST', url, path.startsWith('https:') ? { url: path } : { path });
    assert.ok(!s.saved().sources[0]?.openapiIgnore?.includes(path));
    await s.call('DELETE', `${url}?path=${encodeURIComponent(path)}`);
  }
  const before = readFileSync(s.file, 'utf8');
  assert.equal((await s.call('POST', '/api/sources/app/openapi', { path: '../escape' })).status, 400);
  assert.equal((await s.call('DELETE', '/api/sources/app/openapi?path=/absolute')).status, 400);
  assert.equal((await s.call('POST', '/api/sources/missing/openapi', { path: 'docs/spec.json' })).status, 404);
  assert.equal(
    (await s.call('POST', '/api/sources/app/openapi', { path: 'docs/spec.json' }, { origin: 'https://evil.example' }))
      .status,
    403,
  );
  assert.equal(readFileSync(s.file, 'utf8'), before);
  assert.equal(readFileSync(join(s.ws, 'source', 'app.ts'), 'utf8'), sourceBytes);
  const draft = s.saved();
  draft.sources[0]!.type = 'openapi';
  writeFileSync(s.file, JSON.stringify(draft));
  assert.equal((await s.call('POST', '/api/sources/app/openapi', { path: 'docs/spec.json' })).status, 404);
});

test('sync applies a source overlay and leaves the source unchanged', async (t) => {
  const s = await server(t);
  const draft = s.saved();
  draft.sources[0]!.config = { glossary: { submit: { label: 'Submit work' } } };
  await syncSources(s.ws, draft, s.graph);
  const graph = JSON.parse(readFileSync(s.graph, 'utf8'));
  assert.equal(graph.nodes.find((n: { name: string }) => n.name === 'submit')?.facets.business.label, 'Submit work');
  assert.ok(readFileSync(s.graph, 'utf8').includes('.farsight/settings.json → sources[app].config'));
});

test('sync forwards all three options for local and git sources', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const s = await server(t);
  const origin = join(s.ws, 'source');
  execFileSync('git', ['init', '--quiet', origin]);
  const overlay = { glossary: { submit: { label: 'Submit work' } } };
  const registered = [{ path: 'docs/custom.json', name: 'Custom' }];
  const ignored = ['docs/old.json'];
  const draft: Settings = {
    ...s.saved(),
    sources: ['local', 'git'].map((type) => ({
      ...source,
      id: type,
      name: type,
      type: type as 'local' | 'git',
      path: origin,
      config: overlay,
      openapi: registered,
      openapiIgnore: ignored,
    })),
  };
  const parserModule = new URL('../../parsers/dist/index.js', import.meta.url).href;
  const serverModule = new URL('../dist/index.js', import.meta.url).href;
  const program = `
    import { mock } from 'node:test';
    const actual = await import(${JSON.stringify(parserModule)});
    const calls = [];
    mock.module(${JSON.stringify(parserModule)}, { namedExports: { ...actual, ingestRepo: async (dir, options) => {
      calls.push(options);
      return { repo: options.repoName, nodes: [], edges: [], meta: { files: 0 } };
    } } });
    const { syncSources } = await import(${JSON.stringify(serverModule)});
    await syncSources(${JSON.stringify(s.ws)}, ${JSON.stringify(draft)}, ${JSON.stringify(s.graph)});
    console.log(JSON.stringify(calls));
  `;
  const output = execFileSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--input-type=module', '-e', program],
    {
      cwd: s.ws,
      encoding: 'utf8',
      env: { ...process.env, MODELHUB_DIR: join(s.ws, 'modelhub') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const calls = JSON.parse(output.trim().split('\n').at(-1)!);
  assert.equal(calls.length, 2);
  for (const [i, type] of ['local', 'git'].entries()) {
    assert.deepEqual(calls[i].configOverlay, {
      config: overlay,
      from: `.farsight/settings.json → sources[${type}].config`,
    });
    assert.deepEqual(calls[i].openapiRegistered, registered);
    assert.deepEqual(calls[i].openapiIgnored, ignored);
  }
});

test('settings ignores editor keys, confines ignored references and restricts overlays to code sources', () => {
  assert.equal(settingsProblem(settings({ config: { $schema: 'editor', '//note': 'example', tags: {} } })), null);
  for (const type of ['openapi', 'design', 'work'])
    for (const key of ['config', 'openapi', 'openapiIgnore'])
      assert.match(
        settingsProblem(settings({ type, [key]: key === 'config' ? {} : [] }))!,
        new RegExp(`sources\\[0\\].${key} is only supported`),
      );
  for (const ref of ['/absolute', '../escape', 'docs/../../escape', 'C:\\spec', 'file:///spec', 'bad\0path'])
    assert.match(settingsProblem(settings({ openapiIgnore: [ref] }))!, /sources\[0\].openapiIgnore\[0\]/);
  assert.equal(
    settingsProblem(settings({ openapiIgnore: ['docs/v1..2.json', 'docs/../spec.json', 'https://example.com/spec'] })),
    null,
  );
});

test('the scrubbed settings example validates', () => {
  const example = JSON.parse(
    readFileSync(new URL('../../../.farsight/settings.example.json', import.meta.url), 'utf8'),
  );
  assert.equal(settingsProblem(example), null);
  const source = example.sources.find((s: { id: string }) => s.id === 'invoice-app');
  assert.equal(source.openapi[0].name, 'Billing API (example)');
  assert.ok(existsSync(new URL(`../../../${source.path}/${source.openapi[0].path}`, import.meta.url)));
});

test('source names and ingest locations must be non-empty, through the single server check', async (t) => {
  for (const name of ['', '  ', undefined])
    assert.equal(settingsProblem(settings({ name })), 'sources[0].name must be a non-empty string');
  for (const type of ['local', 'git', 'openapi', 'design'])
    for (const path of ['', '  ', undefined])
      assert.equal(settingsProblem(settings({ type, path })), 'sources[0].path must be a non-empty string');
  assert.equal(settingsProblem(settings({ type: 'work', path: undefined })), null);
  const s = await server(t);
  const before = readFileSync(s.file, 'utf8');
  const invalid = settings({ name: '', path: '' });
  assert.deepEqual((await s.call('POST', '/api/settings/check', invalid)).body, {
    ok: false,
    problem: settingsProblem(invalid),
  });
  assert.equal((await s.call('PUT', '/api/settings', invalid)).status, 400);
  assert.equal(readFileSync(s.file, 'utf8'), before);
});

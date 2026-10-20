import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ingestRepo } from '../dist/index.js';

test('a declared external binds through an injected field typed as fetch, never just a fetch-like name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'farsight-transport-'));
  try {
    writeFileSync(join(root, 'client.ts'), `
      export class EmailTransport {
        private readonly request: typeof fetch;
        constructor(options) { this.request = options.request ?? ((input, init) => fetch(input, init)); }
        async send(body) { return this.request(\`\${this.url}/send\`, { method: 'POST', body }); }
      }
      export class Unrelated {
        private readonly fetchImpl: (value: string) => string;
        send(body) { return this.fetchImpl(body); }
      }
    `);
    writeFileSync(join(root, 'farsight.config.json'), JSON.stringify({ externals: [
      { import: 'client.ts::EmailTransport', name: 'Mail service', kind: 'email' },
      { import: 'client.ts::Unrelated', name: 'Unrelated service', kind: 'email' },
    ] }));
    const graph = await ingestRepo(root, { repoName: 'demo', tests: false, stories: false, projects: false });
    const external = graph.nodes.find(n => n.id === 'demo::external::Mail service');
    assert.ok(external);
    assert.equal(external.external?.source, 'config');
    assert.ok(graph.edges.some(e => e.kind === 'http' && e.from === 'demo::client.ts::EmailTransport.send'
      && e.to === external.id && e.meta?.method === 'POST'));
    assert.ok(!graph.nodes.some(n => n.id === 'demo::external::Unrelated service'));
    assert.ok(!graph.nodes.some(n => n.kind === 'unknown'), 'an external base URL is not an unresolved application route');
    assert.deepEqual(graph.specErrors ?? [], []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('moved files and missing symbols warn without manufacturing bindings; nested and unused classes resolve', async () => {
  const root = mkdtempSync(join(tmpdir(), 'farsight-declarations-'));
  const files: Record<string, string | object> = {
    '.gitignore': 'generated/\n',
    'src/client.ts': 'export class Client {}\nexport function build() {}',
    'src/empty.ts': 'export const value = 1;',
    'generated/client.ts': 'export class Client {}',
    'nested/src/client.ts': 'export class NestedClient {}',
    'nested/farsight.config.json': {
      externals: [{ import: 'src/client.ts::NestedClient', name: 'Nested', kind: 'other' }],
      plumbing: ['src/**'], setup: ['nested/src/client.ts notFound'],
    },
    'farsight.config.json': {
      externals: [
        { import: 'old/client.ts::Client', name: 'Moved', kind: 'other' },
        { import: 'src/client.ts::Missing', name: 'Missing', kind: 'other' },
        { import: 'src/client.ts::Client', name: 'Unused', kind: 'other' },
        { import: 'generated/client.ts::Client', name: 'Ignored', kind: 'other' },
        { import: '@example/sdk', name: 'SDK', kind: 'other' },
        { name: 'Partner', kind: 'party' },
      ],
      plumbing: ['old/http/**', 'src/empty.ts'],
      setup: ['demo::old/container.ts::build', 'demo::src/client.ts::build'],
      decisions: [{ id: 'D1', title: 'A decision', state: 'decided', affects: ['demo::old/client.ts::build'] }],
    },
  };
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
    }
    const graph = await ingestRepo(root, { repoName: 'demo', tests: false, stories: false, projects: false });
    const warnings = graph.specErrors ?? [];
    assert.equal(warnings.length, 7, warnings.join('\n'));
    assert.ok(warnings.some(w => w.includes('externals.import') && w.includes('old/client.ts')));
    assert.ok(warnings.some(w => w.includes('src/client.ts::Missing') && w.includes('no indexed class')));
    assert.ok(warnings.some(w => w.includes('generated/client.ts') && w.includes('ignored')));
    assert.ok(warnings.some(w => w.includes('plumbing') && w.includes('old/http')));
    assert.ok(warnings.some(w => w.includes('setup') && w.includes('old/container')));
    assert.ok(warnings.some(w => w.includes('nested/farsight.config.json') && w.includes('setup')));
    assert.ok(warnings.some(w => w.includes('affects') && w.includes('D1')));
    assert.equal(graph.meta?.config?.notes.length, 6);
    assert.ok(!graph.nodes.some(n => n.kind === 'external' && ['Missing', 'Moved', 'Unused'].includes(n.name)));
    assert.ok(graph.nodes.find(n => n.id === 'demo::src/client.ts::build')?.tags.includes('setup'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

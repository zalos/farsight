// The stories post-pass (ADR 9): CSF read into StoryRefs on the component the
// file names, Storybook discovery (config dir, globs, port and start command
// read off the repo's scripts), config overriding discovery, component
// resolution through a barrel, and every miss kept with its reason.
// Runs against the built packages: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ingestRepo, storiesGlobsOf, globBase } from '../dist/index.js';

const invoiceApp = resolve(import.meta.dirname, '../../../examples/invoice-app');

function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'farsight-stories-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test('stories globs and their bases, as main.ts writes them', () => {
  const main = `const config = {\n  stories: [\n    '../src/lib/**/*.@(mdx|stories.@(js|jsx|ts|tsx))',\n    { directory: '../../patterns/src', files: '**/*.stories.tsx', titlePrefix: 'Patterns' },\n  ],\n  addons: [],\n};\n`;
  assert.deepEqual(storiesGlobsOf(main), ['../src/lib/**/*.@(mdx|stories.@(js|jsx|ts|tsx))', '../../patterns/src']);
  assert.equal(globBase('../src/lib/**/*.stories.tsx'), '../src/lib');
  assert.equal(globBase('../src/Button.stories.tsx'), '../src');
});

test('a discovered Storybook: config dir, globs, the port its project.json starts it on and the command in the root scripts', async () => {
  const dir = tempRepo({
    'package.json': JSON.stringify({ name: 'mono', scripts: { storybook: 'nx run ui:storybook', 'build-storybook': 'nx run ui:build-storybook' } }),
    'libs/ui/project.json': JSON.stringify({ name: 'ui', targets: { storybook: { options: { args: ['--port=6123', '--exact-port'] } } } }),
    'libs/ui/.storybook/main.ts': `export default {\n  stories: ['../src/**/*.stories.tsx'],\n};\n`,
    'libs/ui/src/index.ts': `export * from './lib/button';\n`,
    'libs/ui/src/lib/button.tsx': `/** A button. */\nexport function Button() { return <button/>; }\n`,
    'libs/ui/src/lib/button.stories.tsx': [
      `import type { Meta, StoryObj } from '@storybook/react';`,
      `import { Button } from '../index';`,
      `const meta = { title: 'UI/Button', component: Button, excludeStories: ['helperData'] } satisfies Meta<typeof Button>;`,
      `export default meta;`,
      `export const Primary: StoryObj<typeof meta> = {};`,
      `/** The one that says no. */`,
      `export const DangerZone: StoryObj<typeof meta> = { name: 'Danger' };`,
      `export const Legacy = () => null;`,
      `Legacy.storyName = 'Old style';`,
      `export const helperData = { a: 1 };`,
      `export const __namedExportsOrder = ['Primary', 'DangerZone', 'Legacy'];`,
    ].join('\n'),
    'libs/ui/src/lib/orphan.stories.tsx': `export default { title: 'UI/Orphan' };\nexport const One = {};\n`,
  });
  const f = await ingestRepo(dir, { repoName: 'mono', openapi: false, design: false, tests: false });
  const sb = f.meta?.stories;
  assert.ok(sb, 'meta.stories recorded');
  assert.deepEqual(sb.storybooks, [{
    configDir: 'libs/ui/.storybook', root: 'libs/ui', url: 'http://localhost:6123', urlFrom: 'script',
    command: 'npm run storybook', source: 'discovered', globs: ['../src/**/*.stories.tsx'],
  }]);
  const button = f.nodes.find((n) => n.id === 'mono::libs/ui/src/lib/button.tsx::Button')!;
  assert.deepEqual(button.stories!.map((s) => [s.id, s.name, s.storybook]), [
    ['ui-button--primary', 'Primary', 'libs/ui/.storybook'],
    ['ui-button--danger-zone', 'Danger', 'libs/ui/.storybook'],
    ['ui-button--legacy', 'Old style', 'libs/ui/.storybook'],
  ]);
  assert.equal(button.stories![1]!.docs, 'The one that says no.');
  assert.equal(button.stories![1]!.line, 7);
  assert.deepEqual([sb.files, sb.stories, sb.components], [2, 3, 1]);
  assert.deepEqual(sb.unresolved, [{ file: 'libs/ui/src/lib/orphan.stories.tsx', reason: 'no-component', stories: 1 }]);
});

test('farsight.config.json → storybook names the url and command discovery cannot know; an unfound component is named, not guessed', async () => {
  const dir = tempRepo({
    'farsight.config.json': JSON.stringify({ storybook: { url: 'http://127.0.0.1:7000', command: 'make sb', name: 'Design system' } }),
    '.storybook/main.js': `module.exports = { stories: ['../src/**/*.stories.jsx'] };\n`,
    'src/Card.jsx': `export function Card() { return <div/>; }\n`,
    'src/Card.stories.jsx': `import { Card } from './Card';\nimport { Ghost } from 'somewhere-else';\nexport default { component: Card };\nexport const Plain = {};\n`,
    'src/Ghost.stories.jsx': `import { Ghost } from 'not-in-repo';\nexport default { title: 'Ghost', component: Ghost };\nexport const A = {};\n`,
  });
  const f = await ingestRepo(dir, { repoName: 'app', openapi: false, design: false, tests: false });
  const sb = f.meta!.stories!;
  assert.deepEqual(sb.storybooks[0], { configDir: '.storybook', root: '.', url: 'http://127.0.0.1:7000', urlFrom: 'config', command: 'make sb', name: 'Design system', source: 'config', globs: ['../src/**/*.stories.jsx'] });
  // no title: Storybook's auto-title from the path under the glob base
  const card = f.nodes.find((n) => n.id === 'app::src/Card.jsx::Card')!;
  assert.deepEqual(card.stories!.map((s) => [s.id, s.title, s.titleFrom]), [['card--plain', 'Card', 'auto']]);
  assert.deepEqual(sb.unresolved, [{ file: 'src/Ghost.stories.jsx', reason: 'component-unresolved', component: 'Ghost', stories: 1 }]);
});

test('the invoice-app fixture: one story file, three stories on CreateInvoiceForm, and no new nodes', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  const form = f.nodes.find((n) => n.id === 'invoice-app::src/ui/CreateInvoiceForm.tsx::CreateInvoiceForm')!;
  assert.deepEqual(form.stories!.map((s) => s.id), ['invoices-createinvoiceform--empty', 'invoices-createinvoiceform--with-line-items', 'invoices-createinvoiceform--invalid']);
  assert.equal(f.nodes.filter((n) => n.loc?.path.endsWith('.stories.tsx')).length, 0, 'a story file of plain objects adds no function or component nodes');
  const again = await ingestRepo(invoiceApp, { repoName: 'invoice-app', stories: false });
  assert.equal(again.nodes.length, f.nodes.length);
  assert.equal(again.meta?.stories, undefined);
});

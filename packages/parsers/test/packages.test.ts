// Packages as nodes (docs/proposals/dependencies-and-nx.md §2.1): every bare specifier becomes a
// package node, a workspace alias a workspace package, a built-in is counted and set aside, and the
// range comes from the nearest package.json that declares it. Built on a temp repo written here, plus
// the invoice-app fixture's two third-party imports and one aliased internal import.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphFragment } from '@farsight/core';
import { ingestRepo } from '../dist/index.js';
import { packageOf, isBuiltin, workspacePackageOf } from '../dist/shared/packages.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const invoiceApp = join(repoRoot, 'examples/invoice-app');

let dir: string;
let frag: GraphFragment;

function write(rel: string, text: string) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

before(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'farsight-pkgs-')));
  write('package.json', JSON.stringify({
    name: 'shop', private: true,
    dependencies: { lodash: '^4.17.21', zod: '^3.23.8', '@azure/storage-blob': '^12.0.0' },
    devDependencies: { vitest: '^2.0.0' },
  }));
  // a nested package.json that declares lodash at another range: its files see that one
  write('apps/admin/package.json', JSON.stringify({ name: 'admin', dependencies: { lodash: '^3.10.1' } }));
  write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: {
    '@acme/*': ['libs/*/src/index.ts'],
    '@shop/money': ['libs/money/src/index.ts'],
    '@/*': ['src/*'],
    '@ghost/*': ['libs/ghost/*'],
  } } }));
  write('libs/money/src/index.ts', 'export function cents(n: number) { return Math.round(n * 100); }\n');
  write('libs/text/src/index.ts', 'export function shout(s: string) { return s.toUpperCase(); }\n');
  write('src/util/pad.ts', 'export function pad(s: string) { return s.padStart(4); }\n');
  write('src/a.ts', [
    "import { readFileSync } from 'node:fs';",
    "import path from 'path';",
    "import fp from 'lodash/fp';",
    "import { z } from 'zod';",
    "import { BlobServiceClient } from '@azure/storage-blob';",
    "import type { Vitest } from 'vitest';",
    "import { shout } from '@acme/text';",
    "import { cents } from '@shop/money';",
    "import { pad } from '@/util/pad';",
    "import { nothing } from '@ghost/x';",
    "import 'reflect-metadata';",
    "export * from '@acme/text';",
    '',
    'export const Order = z.object({ id: z.string() });',
    '',
    'export function total(xs: number[]) {',
    '  const chalk = require("chalk");',
    '  return fp.sum(xs) + cents(1) + shout(pad("x")).length + chalk.length;',
    '}',
    '',
    'export async function upload(name: string) {',
    "  const svc = BlobServiceClient.fromConnectionString('x');",
    "  const { default: dayjs } = await import('dayjs');",
    '  return svc.getContainerClient(name) && dayjs && readFileSync && path;',
    '}',
    '',
  ].join('\n'));
  write('apps/admin/src/b.ts', "import _ from 'lodash';\nexport function first(xs: number[]) { return _.head(xs); }\n");
  frag = await ingestRepo(dir, { repoName: 'shop', openapi: false, design: false, tests: false, stories: false });
});

after(() => rmSync(dir, { recursive: true, force: true }));

const pkg = (name: string) => frag.nodes.find((n) => n.id === `shop::package::${name}`);
const importsInto = (name: string) => frag.edges.filter((e) => e.kind === 'imports' && e.to === `shop::package::${name}`);

test('packageOf: bare names and subpaths; relative paths, schemes, # imports and @/ aliases are no package', () => {
  assert.deepEqual(packageOf('lodash'), { name: 'lodash' });
  assert.deepEqual(packageOf('lodash/fp'), { name: 'lodash', subpath: 'fp' });
  assert.deepEqual(packageOf('@scope/pkg/sub/deep'), { name: '@scope/pkg', subpath: 'sub/deep' });
  for (const s of ['./x', '../x', '/abs', 'node:fs', 'virtual:x', 'https://cdn/x.js', '#internal', '@/components/x', '~/x', '@scope']) {
    assert.equal(packageOf(s), null, s);
  }
  assert.ok(isBuiltin('node:test') && isBuiltin('fs') && isBuiltin('fs/promises') && isBuiltin('path'));
  assert.ok(!isBuiltin('lodash') && !isBuiltin('fsevents'));
  assert.equal(workspacePackageOf({ path: 'src/x.ts', via: 'baseUrl' }, '/r'), null, 'a baseUrl lookup is a path, not a package');
  assert.equal(workspacePackageOf({ path: 'src/x.ts', via: 'paths', pattern: '@/*', target: 'src/*', baseDir: '/r', star: 'x' }, '/r'), null);
  assert.deepEqual(workspacePackageOf({ path: 'libs/a/src/index.ts', via: 'paths', pattern: '@acme/*', target: 'libs/*/src/index.ts', baseDir: '/r', star: 'a' }, '/r'),
    { name: '@acme/a', root: 'libs/a' });
});

test('every bare specifier is a package node; subpaths map to the package; built-ins are counted and set aside', () => {
  const names = frag.nodes.filter((n) => n.kind === 'package').map((n) => n.name).sort();
  assert.deepEqual(names, ['@acme/text', '@azure/storage-blob', '@shop/money', 'chalk', 'dayjs', 'lodash', 'reflect-metadata', 'vitest', 'zod']);
  assert.ok(!frag.nodes.some((n) => n.kind === 'package' && /^(node:|fs|path)/.test(n.name)), 'no package node for a built-in');
  assert.deepEqual(frag.meta?.packages?.builtins, [{ spec: 'node:fs', files: 1 }, { spec: 'node:path', files: 1 }]);
  assert.equal(frag.meta?.packages?.unresolvedAliases, 1, 'an alias that matched and named no file is counted, never a package');
  const fp = importsInto('lodash').find((e) => e.from === 'shop::module::src/a.ts')!;
  assert.deepEqual(fp.meta, { specifier: 'lodash/fp', line: 3, form: 'import', subpath: 'fp', names: 'fp' });
  assert.deepEqual(fp.resolution, { status: 'resolved', technique: 'static-import', confidence: 'HIGH', note: 'the import names the package' });
  assert.equal(importsInto('vitest')[0]!.meta?.typeOnly, true);
  assert.equal(importsInto('reflect-metadata')[0]!.meta?.form, 'import', 'a side-effect import is an importer too');
  assert.equal(importsInto('chalk').find((e) => e.from.startsWith('shop::module::'))!.meta?.form, 'require');
  assert.equal(importsInto('dayjs').find((e) => e.from.startsWith('shop::module::'))!.meta?.form, 'dynamic');
  const mod = frag.nodes.find((n) => n.id === 'shop::module::src/a.ts')!;
  assert.deepEqual({ kind: mod.kind, name: mod.name, loc: mod.loc }, { kind: 'module', name: 'src/a.ts', loc: { repo: 'shop', path: 'src/a.ts', line: 1 } });
});

test('a workspace alias is a workspace package and keeps the file edge; an app alias is no package at all', () => {
  assert.deepEqual(pkg('@acme/text')!.package, { scope: 'workspace', project: '@acme/text', root: 'libs/text' });
  assert.deepEqual(pkg('@shop/money')!.package, { scope: 'workspace', project: '@shop/money', root: 'libs/money/src' });
  assert.ok(!frag.nodes.some((n) => n.kind === 'package' && n.name.startsWith('@/')), '@/util/pad is a path inside the app');
  // the symbol edges the adapter already made through the alias are still there
  const calls = frag.edges.filter((e) => e.kind === 'calls' && e.from === 'shop::src/a.ts::total').map((e) => e.to).sort();
  assert.deepEqual(calls, ['shop::libs/money/src/index.ts::cents', 'shop::libs/text/src/index.ts::shout', 'shop::src/util/pad.ts::pad']);
  const reexport = importsInto('@acme/text').find((e) => e.from === 'shop::module::src/a.ts')!;
  assert.equal(reexport.meta?.specifier, '@acme/text');
});

test('the range comes from the nearest package.json that declares it; two that disagree both stay', () => {
  const lodash = pkg('lodash')!.package!;
  assert.deepEqual(lodash.declaredIn, ['apps/admin/package.json', 'package.json']);
  assert.equal(lodash.version, '^4.17.21', 'the root-most declaration speaks for the node when ranges differ');
  assert.deepEqual(lodash.declarations?.map((d) => `${d.path} ${d.range}`), ['apps/admin/package.json ^3.10.1', 'package.json ^4.17.21']);
  assert.match(lodash.note ?? '', /declared at 2 different ranges/);
  assert.deepEqual(pkg('vitest')!.package, { scope: 'third-party', version: '^2.0.0', declaredIn: ['package.json'], dev: true,
    declarations: [{ path: 'package.json', range: '^2.0.0', field: 'devDependencies' }] });
});

test('a package declared nowhere is still a node, with no version and a note', () => {
  const chalk = pkg('chalk')!.package!;
  assert.equal(chalk.version, undefined);
  assert.equal(chalk.declaredIn, undefined);
  assert.equal(chalk.note, 'imported by 1 file but declared in no package.json above it');
  assert.equal(frag.meta?.packages?.undeclared, 3, 'chalk, dayjs and reflect-metadata');
});

test('code that uses an imported binding gets its own imports edge; an SDK external links to its external node', () => {
  const users = (name: string) => importsInto(name).filter((e) => e.meta?.use).map((e) => e.from).sort();
  assert.deepEqual(users('lodash'), ['shop::apps/admin/src/b.ts::first', 'shop::src/a.ts::total']);
  assert.deepEqual(users('zod'), ['shop::src/a.ts::Order'], 'a zod schema uses zod');
  assert.deepEqual(users('chalk'), ['shop::src/a.ts::total'], 'a require inside the body is a use');
  assert.deepEqual(users('dayjs'), ['shop::src/a.ts::upload'], 'so is an import()');
  assert.deepEqual(users('vitest'), [], 'a type-only import is never a run-time use');
  const blob = pkg('@azure/storage-blob')!.package!;
  assert.equal(blob.externalId, 'shop::external::Azure Blob Storage');
  assert.ok(frag.nodes.some((n) => n.id === blob.externalId && n.kind === 'external'), 'the external keeps its node');
});

test('the invoice-app fixture: two third-party imports with their ranges, one aliased internal library, no new source file', async () => {
  const f = await ingestRepo(invoiceApp, { repoName: 'invoice-app' });
  const p = (name: string) => f.nodes.find((n) => n.id === `invoice-app::package::${name}`)?.package;
  assert.equal(p('date-fns')?.version, '^4.1.0');
  assert.equal(p('clsx')?.version, '^2.1.1');
  assert.deepEqual(p('@invoice/plumbing'), { scope: 'workspace', project: '@invoice/plumbing', root: 'src/server/plumbing' });
  assert.equal(p('@storybook/react'), undefined, 'a story file’s imports belong to the stories pass');
  assert.ok(f.edges.some((e) => e.kind === 'imports' && e.from === 'invoice-app::src/server/plumbing/format.ts::fmt' && e.to === 'invoice-app::package::date-fns'));
  assert.ok(f.edges.some((e) => e.kind === 'calls' && e.from === 'invoice-app::src/server/approvals.ts::receiptFor' && e.to === 'invoice-app::src/server/plumbing/format.ts::fmt'),
    'the aliased import still resolves the call');
  assert.equal(f.nodes.filter((n) => n.kind === 'package').length, 8);
});

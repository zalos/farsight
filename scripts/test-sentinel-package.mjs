#!/usr/bin/env node
// Installs the packed Sentinel tarball into a clean npm consumer and checks that it stands
// alone: the bin answers --help; every export imports and its public types compile in a
// strict TypeScript consumer that uses the contracts; the installed schemas are exactly the
// source set, one per envelope; the package's valid fixtures validate through the installed
// package and a changed version is refused; and no Farsight application package arrives. No scanner, container, model or network
// service is started; npm may fetch Sentinel's declared third-party dependencies.
//
//   pnpm test:sentinel:package        # builds Sentinel's closure, packs, then runs this
//   node scripts/test-sentinel-package.mjs [build/sentinel/farsight-sentinel-<v>.tgz]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmConsumer } from './npm-consumer.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'packages', 'sentinel');
const artifact = resolve(process.argv[2] ?? (() => {
  const source = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'));
  return join(root, 'build', 'sentinel', `farsight-sentinel-${source.version}.tgz`);
})());
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.json')).sort() : []);
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
if (!existsSync(artifact)) {
  console.error(`test-sentinel-package: ${artifact} is missing. Run \`pnpm pack:sentinel\` first.`);
  process.exit(1);
}

const consumer = await npmConsumer('sentinel-package-', [artifact]);
try {
  assert.ok(consumer.manifest().dependencies?.['farsight-sentinel'], 'npm recorded the dependency');
  const installed = join(consumer.dir, 'node_modules', 'farsight-sentinel');
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.ok(artifact.endsWith(`farsight-sentinel-${pkg.version}.tgz`), 'the tarball name carries the packaged version');
  // truthful runtime metadata: a floor this Node satisfies, and no workspace-only protocol leaking out
  const floor = /^>=(\d+)/.exec(pkg.engines?.node ?? '');
  assert.ok(floor && Number(process.versions.node.split('.')[0]) >= Number(floor[1]), `engines.node ${pkg.engines?.node}`);
  assert.ok(Object.values(pkg.dependencies ?? {}).every((spec) => !String(spec).startsWith('workspace:')), 'no workspace: dependency');

  const bins = Object.keys(pkg.bin ?? {});
  assert.ok(bins.length, 'the package declares a bin');
  for (const name of bins) {
    const help = await consumer.exec(consumer.bin(name), ['--help']);
    assert.match(help.stdout + help.stderr, /sentinel/i, `${name} --help names Sentinel`);
  }

  const evalModule = async (code) => (await consumer.exec(process.execPath, ['--input-type=module', '-e', code])).stdout;
  const subpaths = Object.keys(pkg.exports ?? {}).filter((key) => key !== './package.json' && !key.includes('*'));
  const specifierOf = (subpath) => (subpath === '.' ? 'farsight-sentinel' : `farsight-sentinel/${subpath.slice(2)}`);
  const runtimeKeys = {};
  for (const subpath of subpaths) {
    const entry = pkg.exports[subpath];
    assert.ok(typeof entry === 'object' && entry.types && existsSync(join(installed, entry.types)), `${subpath} ships its declaration`);
    runtimeKeys[subpath] = JSON.parse(await evalModule(`const m = await import(${JSON.stringify(specifierOf(subpath))}); console.log(JSON.stringify(Object.keys(m)));`));
    assert.ok(runtimeKeys[subpath].length > 0, `${specifierOf(subpath)} exposes named exports`);
  }
  assert.ok(subpaths.includes('.') && subpaths.includes('./contracts'), 'the root and ./contracts exports');

  // The envelope registry, as the installed package reports it.
  const registry = JSON.parse(await evalModule("const { ENVELOPES } = await import('farsight-sentinel'); console.log(JSON.stringify(ENVELOPES));"));
  const kinds = Object.keys(registry);
  assert.ok(kinds.length > 0, 'ENVELOPES names at least one envelope');

  // Schemas: exactly the source set, byte for byte, with one per envelope version.
  const expected = jsonFiles(join(sourceDir, 'schemas'));
  assert.ok(expected.length > 0, 'packages/sentinel/schemas holds the expected schemas');
  const installedSchemas = jsonFiles(join(installed, 'schemas'));
  assert.deepEqual(installedSchemas, expected, 'the installed schema set is the source set');
  for (const file of expected) {
    assert.equal(digest(join(installed, 'schemas', file)), digest(join(sourceDir, 'schemas', file)), `${file} is unchanged`);
    assert.equal(typeof JSON.parse(readFileSync(join(installed, 'schemas', file), 'utf8')), 'object', file);
  }
  for (const kind of kinds) {
    const file = `${registry[kind].schema.replace('/', '.')}.schema.json`;
    assert.ok(installedSchemas.includes(file), `${kind}: ${file} is packaged`);
    const viaExport = await evalModule(`import { createRequire } from 'node:module'; const r = createRequire(process.cwd() + '/'); console.log(r.resolve(${JSON.stringify(`farsight-sentinel/schemas/${file}`)}));`);
    assert.ok(viaExport.trim().endsWith(file), `farsight-sentinel/schemas/${file} resolves through the exports map`);
  }
  const schemaCount = installedSchemas.length;

  // Public types: a strict consumer that names every runtime export and uses each contract type.
  const contracts = [...new Set(kinds.map((kind) => registry[kind].type))];
  const lines = [
    "import * as root from 'farsight-sentinel';",
    "import * as contractValues from 'farsight-sentinel/contracts';",
    "import { ENVELOPES, validateEnvelope, type EnvelopeKind, type EnvelopeTypes, type ValidationResult } from 'farsight-sentinel';",
    `import type { ${contracts.join(', ')} } from 'farsight-sentinel/contracts';`,
    `export const rootKeys: Array<keyof typeof root> = ${JSON.stringify(runtimeKeys['.'])};`,
    `export const contractKeys: Array<keyof typeof contractValues> = ${JSON.stringify(runtimeKeys['./contracts'])};`,
    'const kinds: EnvelopeKind[] = Object.keys(ENVELOPES) as EnvelopeKind[];',
    ...kinds.map((kind, i) => [
      `const r${i}: ValidationResult<EnvelopeTypes[${JSON.stringify(kind)}]> = validateEnvelope(${JSON.stringify(kind)}, {} as unknown);`,
      `if (r${i}.ok) { const value: ${registry[kind].type} = r${i}.value; const back: EnvelopeTypes[${JSON.stringify(kind)}] = value; void back; }`,
      `else { const code: string = r${i}.errors[0]?.code ?? ''; const path: string = r${i}.errors[0]?.path ?? ''; void code; void path; }`,
    ].join('\n')),
    'void kinds;',
  ];
  writeFileSync(join(consumer.dir, 'consumer.mts'), lines.join('\n') + '\n');
  await consumer.exec(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--strict',
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.mts']).catch((error) => {
    throw new Error(`the installed types do not compile:\n${error.stdout}${error.stderr}`);
  });

  // Runtime contracts: the package's own valid fixtures pass through the installed package; a
  // fixture whose version is changed is refused, never coerced.
  const fixtures = join(sourceDir, 'test', 'contracts', 'valid');
  const cases = jsonFiles(fixtures).map((file) => ({ file, kind: kinds.find((kind) => file === `${kind}.json` || file.startsWith(`${kind}-`)) }));
  const unmatched = cases.filter((c) => !c.kind).map((c) => c.file);
  assert.deepEqual(unmatched, [], 'every valid fixture is named <kind>[-case].json');
  for (const kind of kinds) assert.ok(cases.some((c) => c.kind === kind), `a valid ${kind} fixture exists`);
  writeFileSync(join(consumer.dir, 'fixtures.mjs'), `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { validateEnvelope } from 'farsight-sentinel';
    for (const { file, kind } of ${JSON.stringify(cases.map((c) => ({ ...c, file: join(fixtures, c.file) })))}) {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      const ok = validateEnvelope(kind, value);
      assert.equal(ok.ok, true, file + ' ' + JSON.stringify(ok.errors));
      const field = ['schema', 'protocol'].find((f) => typeof value[f] === 'string' && value[f].startsWith('sentinel-'));
      assert.ok(field, file + ' names its version');
      const changed = validateEnvelope(kind, { ...value, [field]: value[field].replace(/\\/.*$/, '/v999') });
      assert.equal(changed.ok, false, file + ' with an unknown version is refused');
    }
    console.log(${cases.length});
  `);
  const validated = Number((await consumer.exec(process.execPath, ['fixtures.mjs'])).stdout);
  assert.equal(validated, cases.length);

  // Standalone: everything @farsight/* is inlined, and farsight-cli is not pulled in.
  const modules = readdirSync(join(consumer.dir, 'node_modules'));
  assert.ok(!modules.includes('farsight-cli'), 'farsight-cli is not installed with Sentinel');
  assert.ok(!modules.includes('@farsight'), 'no workspace package is resolved from a registry');

  console.log(`sentinel package ok: ${bins.join(', ')} --help, ${subpaths.length} typed exports (${contracts.length} contract types compiled), ${schemaCount} schemas, ${validated} fixtures, npm consumer`);
} finally {
  consumer.cleanup();
}

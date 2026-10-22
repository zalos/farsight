#!/usr/bin/env node
// Installs the packed Sentinel tarball into a clean npm consumer and checks that it stands
// alone: the bin answers --help, the root export imports, packaged schemas parse, and no
// Farsight application package arrives with it. No scanner, container, model or network
// service is started; npm may fetch Sentinel's declared third-party dependencies.
//
//   pnpm test:sentinel:package        # builds Sentinel's closure, packs, then runs this
//   node scripts/test-sentinel-package.mjs [build/sentinel/farsight-sentinel-<v>.tgz]
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmConsumer } from './npm-consumer.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const artifact = resolve(process.argv[2] ?? join(root, 'build', 'sentinel', `farsight-sentinel-${version}.tgz`));
if (!existsSync(artifact)) {
  console.error(`test-sentinel-package: ${artifact} is missing. Run \`pnpm pack:sentinel\` first.`);
  process.exit(1);
}

const consumer = await npmConsumer('sentinel-package-', [artifact]);
try {
  assert.ok(consumer.manifest().dependencies?.['farsight-sentinel'], 'npm recorded the dependency');
  const installed = join(consumer.dir, 'node_modules', 'farsight-sentinel');
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.version, version);

  const bins = Object.keys(pkg.bin ?? {});
  assert.ok(bins.length, 'the package declares a bin');
  for (const name of bins) {
    const help = await consumer.exec(consumer.bin(name), ['--help']);
    assert.match(help.stdout + help.stderr, /sentinel/i, `${name} --help names Sentinel`);
  }

  const imported = await consumer.exec(process.execPath, ['--input-type=module', '-e',
    "const m = await import('farsight-sentinel'); console.log(JSON.stringify(Object.keys(m)));"]);
  assert.ok(JSON.parse(imported.stdout).length > 0, 'the root export exposes named exports');

  const schemas = join(installed, 'schemas');
  let schemaCount = 0;
  if (existsSync(schemas)) {
    for (const file of readdirSync(schemas, { recursive: true }).map(String).filter((f) => f.endsWith('.json'))) {
      const schema = JSON.parse(readFileSync(join(schemas, file), 'utf8'));
      assert.equal(typeof schema, 'object', file);
      schemaCount++;
    }
  }

  // Standalone: everything @farsight/* is inlined, and farsight-cli is not pulled in.
  const modules = readdirSync(join(consumer.dir, 'node_modules'));
  assert.ok(!modules.includes('farsight-cli'), 'farsight-cli is not installed with Sentinel');
  assert.ok(!modules.includes('@farsight'), 'no workspace package is resolved from a registry');

  console.log(`sentinel package ok: ${bins.join(', ')} --help, import (${JSON.parse(imported.stdout).length} exports), ${schemaCount} schemas, npm consumer`);
} finally {
  consumer.cleanup();
}

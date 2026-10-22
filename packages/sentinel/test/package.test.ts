import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES } from '../dist/index.js';

const pkgDir = fileURLToPath(new URL('../', import.meta.url));
const packagesDir = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(`${pkgDir}package.json`, 'utf8'));
const cli = (...args: string[]) => spawnSync(process.execPath, [`${pkgDir}dist/cli.js`, ...args], { encoding: 'utf8' });

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]);
}

test('the package is optional, private and exports only files that exist', () => {
  assert.equal(manifest.name, '@farsight/sentinel');
  assert.equal(manifest.private, true);
  assert.match(manifest.version, /-draft\./);
  // core supplies the shared catalog (and later counts/placement/grants); no scanner or model SDK dependency.
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ['@farsight/core', 'ajv']);
  assert.equal(manifest.bin['farsight-sentinel'], './dist/cli.js');
  for (const [key, target] of Object.entries(manifest.exports as Record<string, any>)) {
    if (key.includes('*')) continue;
    for (const file of typeof target === 'string' ? [target] : Object.values(target) as string[]) {
      assert.ok(existsSync(join(pkgDir, file)), `${key} → ${file}`);
    }
  }
  assert.ok(existsSync(`${pkgDir}schemas/sentinel-report.draft-1.schema.json`));
});

test('no Farsight package depends on or imports Sentinel', () => {
  for (const dir of readdirSync(packagesDir)) {
    if (dir === 'sentinel' || !existsSync(join(packagesDir, dir, 'package.json'))) continue;
    const m = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      assert.ok(!m[field]?.['@farsight/sentinel'], `${dir} ${field}`);
    }
    const src = join(packagesDir, dir, 'src');
    if (!existsSync(src)) continue;
    for (const file of filesUnder(src).filter(f => /\.(ts|js|mjs)$/.test(f))) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /@farsight\/sentinel|packages\/sentinel\//, file);
    }
  }
});

test('the library imports nothing that could start work', () => {
  const forbidden = /from ['"](node:)?(child_process|net|http|https|dgram|worker_threads|cluster|sqlite)['"]|from ['"]@farsight\//;
  for (const file of filesUnder(`${pkgDir}dist`).filter(f => f.endsWith('.js'))) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('cli.js')) {
      // The executable reads its words from the catalog, and nothing else from Farsight.
      const farsight = [...text.matchAll(/from ['"](@farsight\/[^'"]+)['"]/g)].map(m => m[1]);
      assert.deepEqual(farsight, ['@farsight/core/dist/strings-sentinel-cli.js']);
      continue;
    }
    assert.doesNotMatch(text, forbidden, file);
  }
  // Importing the facade leaves no handle open and prints nothing.
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(`${pkgDir}dist/index.js`)});`], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, '');
});

test('help and version say plainly that no scanner exists', () => {
  const help = cli('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /no scanner yet/);
  assert.match(help.stdout, /never downloads a tool, starts a container or contacts a model provider/);
  assert.match(help.stdout, /4 awaiting owner confirmation/);
  const version = cli('--version');
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), `farsight-sentinel ${manifest.version}, contracts draft-1`);
});

test('every analysis capability is explicitly unavailable', () => {
  const r = cli('capabilities', '--json');
  assert.equal(r.status, 0);
  const listed = JSON.parse(r.stdout).capabilities as typeof CAPABILITIES;
  assert.deepEqual(listed, JSON.parse(JSON.stringify(CAPABILITIES)));
  assert.deepEqual(listed.filter(c => c.state !== 'unavailable').map(c => c.id), ['contract-validation']);
  for (const c of listed) assert.match(c.reasonCode, /^sentinel\.capability\./);
  assert.equal(listed.find(c => c.id === 'interprocedural-flow')?.reasonCode, 'sentinel.capability.noQualifiedEngine');
});

test('planned commands refuse with exit 3 and start nothing', () => {
  for (const command of ['plan', 'run', 'status', 'serve', 'report', 'bundle', 'rules']) {
    const r = cli(command, '--json');
    assert.equal(r.status, 3, command);
    assert.match(r.stderr, new RegExp(`^unavailable: ${command} is not implemented in this draft build \\(planned in PR \\d+\\)\\. Nothing was started\\.`));
    assert.equal(r.stdout, '');
  }
  assert.equal(cli('scan-everything').status, 3);
});

test('validate checks a file against its draft schema', () => {
  const valid = fileURLToPath(new URL('./contracts/valid/report.json', import.meta.url));
  const ok = cli('validate', 'report', valid);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), 'valid sentinel-report/draft-1');
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-validate-'));
  try {
    const bad = join(dir, 'run.json');
    writeFileSync(bad, JSON.stringify({ schema: 'sentinel-run/v9' }));
    const r = cli('validate', 'run', bad, '--json');
    assert.equal(r.status, 3);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.errors[0].code, 'sentinel.contract.unsupportedVersion');
    assert.deepEqual(body.errors[0].supported, ['sentinel-run/draft-1']);
    const human = cli('validate', 'run', bad);
    assert.equal(human.stderr, 'invalid sentinel-run/draft-1\n  sentinel.contract.unsupportedVersion /schema version not supported\n');
    assert.equal(cli('validate', 'run', dir).status, 3, 'a directory is refused');
    assert.equal(cli('validate', 'run', join(dir, 'missing.json')).status, 3);
    assert.equal(cli('validate', 'ledger', bad).status, 3, 'an unknown kind is refused');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every printed word is a registered catalog entry with a definition', async () => {
  const { STRINGS } = await import('@farsight/core/dist/strings.js');
  const cliText = readFileSync(`${pkgDir}src/cli.ts`, 'utf8');
  const used = new Set([...cliText.matchAll(/word\('(sentinel\.[^']+)'/g)].map(m => m[1]!));
  for (const c of CAPABILITIES) used.add(c.reasonCode);
  for (const code of ['unknownKind', 'tooLarge', 'malformedJson', 'missingVersion', 'wrongKind', 'unsupportedVersion', 'invalid', 'invariant']) used.add(`sentinel.contract.${code}`);
  used.add('sentinel.protocol.noSharedVersion');
  assert.ok(used.size > 30);
  for (const key of used) {
    const entry = STRINGS[key];
    assert.ok(entry, `${key} is not in the catalog`);
    assert.ok(entry.define && entry.hud && entry.professional, `${key} needs both registers and a define`);
  }
});

test('the PR 01 feasibility fixtures are still in place', () => {
  for (const f of ['feasibility/cases.json', 'engine-feasibility/index.json', 'framework-feasibility/cases.json']) {
    assert.ok(existsSync(`${pkgDir}test/fixtures/${f}`), f);
  }
});

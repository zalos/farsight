import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, POLICY_ERROR_CODES, POLICY_REASON_CODES } from '../dist/index.js';

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
  // core supplies the shared catalog (and later counts/placement/grants); @types/node because the public store
  // declarations name Node built-ins. No scanner, container client or model SDK dependency.
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ['@farsight/code-parser', '@farsight/core', '@farsight/graph', '@types/node', 'ajv']);
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

// Every module import outside the package, per built file. A new import fails here until it is reviewed and
// added; nothing networked, no worker or cluster, and no static node:sqlite import anywhere.
const ALLOWED_IMPORTS: Record<string, readonly string[]> = {
  'cli.js': ['@farsight/core/dist/strings-sentinel-cli.js', 'node:fs'],
  // Worker execution (PR 07). Only processes.js may start a process (asserted below); nothing networked.
  'execution/coordinator.js': ['node:crypto'],
  'execution/durability.js': ['node:fs'],
  'execution/plan.js': ['node:crypto'],
  'execution/errors.js': ['@farsight/core/dist/strings-sentinel-execution.js'],
  'execution/isolation.js': ['node:crypto', 'node:fs', 'node:os', 'node:path'],
  'execution/launch-gate.js': ['node:fs'],
  'execution/processes.js': ['node:child_process'],
  'execution/publication.js': ['node:fs'],
  'execution/recovery.js': ['node:fs', 'node:path'],
  'execution/registry.js': ['node:crypto', 'node:fs', 'node:path'],
  'execution/supervisor.js': ['node:crypto', 'node:fs', 'node:path'],
  // Trusted policy (ADR 21): core's pure grant matcher and credential-shape check; user state through node:fs only.
  'policy/admission.js': ['@farsight/core/dist/grants.js'],
  'policy/adoption.js': ['node:fs', 'node:os', 'node:path'],
  'policy/digest.js': ['node:crypto'],
  'policy/owner-receipts.js': ['node:crypto'],
  'policy/receipts.js': ['node:path'],
  'policy/settings.js': ['@farsight/core/dist/credential-shapes.js'],
  'policy/user-state.js': ['node:crypto', 'node:fs', 'node:path'],
  // Rule packs are read as data: listed and opened, never imported, evaluated or spawned.
  'rules/pack.js': ['node:fs', 'node:path'],
  'validate.js': ['ajv'],
  // The planner's reason codes are catalog words.
  'planner/errors.js': ['@farsight/core/dist/strings-sentinel-plan.js'],
  'planner/boundary.js': ['node:crypto'],
  // The store's reason codes are catalog words; core's catalog is the only Farsight module the library reads.
  'store/errors.js': ['@farsight/core/dist/strings-sentinel-store.js'],
  'store/ledger-json.js': ['node:crypto'],
  'store/ledger.js': ['node:fs', 'node:path'],
  'store/migrations.js': ['node:crypto', 'node:fs', 'node:path'],
  'store/objects.js': ['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'node:util', 'node:zlib'],
  'store/owner.js': ['node:crypto', 'node:fs'],
  // One fixed spawn: the macOS mount table, read while a store is opened (asserted below).
  'store/paths.js': ['node:child_process', 'node:fs', 'node:path'],
  // node:sqlite is imported lazily, by the first store open, never at module load.
  'store/runtime.js': ['dynamic:node:sqlite'],
  // Source capture reads files and Git objects itself: no child process, so no git, hook, filter or fetch.
  'snapshot/capture.js': ['node:crypto', 'node:fs', 'node:path'],
  'snapshot/errors.js': ['@farsight/core/dist/strings-sentinel-capture.js'],
  'snapshot/git.js': ['node:crypto', 'node:fs', 'node:path', 'node:zlib'],
  'snapshot/inventory.js': ['node:crypto', 'node:fs', 'node:path'],
  'snapshot/materialize.js': ['node:fs', 'node:path'],
  // The public parser, loaded on first parse only (its TS/JS adapter has a native binding); graph is pure JSON helpers.
  'snapshot/parser.js': ['@farsight/core/dist/strings-sentinel-parser.js', '@farsight/graph', 'dynamic:@farsight/code-parser', 'dynamic:@farsight/code-parser/adapters/java',
    'dynamic:@farsight/code-parser/adapters/tsjs', 'node:crypto', 'node:fs', 'node:path'],
  'snapshot/policy.js': ['node:crypto', 'node:path'],
  'snapshot/worktree.js': ['node:fs'],
};

test('the library imports only its reviewed modules, and nothing that could start work at import', () => {
  const dist = `${pkgDir}dist/`;
  const found: Record<string, string[]> = {};
  for (const file of filesUnder(dist).filter(f => f.endsWith('.js'))) {
    const text = readFileSync(file, 'utf8');
    const specs = new Set<string>();
    for (const m of text.matchAll(/(?:^|[\s;])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm)) {
      const spec = m[1] ?? m[2]!;
      if (!spec.startsWith('.')) specs.add(spec);
    }
    for (const m of text.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
      const literal = /^['"]([^'"]+)['"]$/.exec(m[1]!.trim());
      assert.ok(literal, `${file}: a dynamic import must name a literal module`);
      if (!literal[1]!.startsWith('.')) specs.add(`dynamic:${literal[1]}`);
    }
    assert.doesNotMatch(text, /\brequire\s*\(/, `${file} uses require()`);
    if (specs.size) found[file.slice(dist.length)] = [...specs].sort();
  }
  assert.deepEqual(found, ALLOWED_IMPORTS);
  const paths = readFileSync(`${dist}store/paths.js`, 'utf8');
  const spawns = [...paths.matchAll(/(?<![.\w])(spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(([^,)]*)/g)].map(m => `${m[1]}(${m[2]!.trim()}`);
  assert.deepEqual(spawns, ["spawnSync('/sbin/mount'"], 'the only process the store may start is the macOS mount table');
  // Worker execution starts processes in exactly one module, always with an argument list and never a shell.
  const processes = readFileSync(`${dist}execution/processes.js`, 'utf8');
  assert.equal([...processes.matchAll(/shell: false/g)].length, 3);
  assert.doesNotMatch(processes, /shell: true|execSync|exec\(/);
});

/** Runs `code` in a fresh process that records every child spawn, then reports spawns, SQLite and new files. */
function probe(code: string): { spawns: string[]; sqlite: boolean; files: string[]; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-probe-'));
  try {
    const script = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const spawns = [];
      for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        const original = cp[name];
        cp[name] = (...args) => { spawns.push(name + ' ' + String(args[0])); return original(...args); };
      }
      syncBuiltinESMExports();
      ${code}
      const sqlite = process.moduleLoadList.some(m => /\\bsqlite\\b/.test(m));
      process.stderr.write('\\n@@' + JSON.stringify({ spawns, sqlite }) + '\\n');
    `;
    writeFileSync(join(dir, 'probe.mjs'), script);
    const r = spawnSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, HOME: dir, TMPDIR: dir } });
    assert.equal(r.status, 0, r.stderr);
    const marker = r.stderr.lastIndexOf('\n@@');
    const facts = JSON.parse(r.stderr.slice(marker + 3));
    return { ...facts, files: readdirSync(dir).filter(f => f !== 'probe.mjs'), stdout: r.stdout, stderr: r.stderr.slice(0, marker) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('importing the root and the store, and asking the CLI for help, start nothing', () => {
  const lib = probe(`await import(${JSON.stringify(`${pkgDir}dist/index.js`)}); await import(${JSON.stringify(`${pkgDir}dist/store/index.js`)}); await import(${JSON.stringify(`${pkgDir}dist/snapshot/index.js`)});`);
  assert.deepEqual(lib.spawns, [], 'no child process at import');
  assert.equal(lib.sqlite, false, 'node:sqlite is not loaded until a store is opened');
  assert.deepEqual(lib.files, [], 'no file is created at import');
  assert.equal(lib.stdout + lib.stderr, '', 'importing prints nothing');
  const help = probe(`process.argv.push('--help'); await import(${JSON.stringify(`${pkgDir}dist/cli.js`)});`);
  assert.deepEqual(help.spawns, []);
  assert.equal(help.sqlite, false);
  assert.deepEqual(help.files, []);
  assert.match(help.stdout, /no scanner yet/);
  // Positive controls: the probe sees SQLite once loaded, and a spawn made through a named import.
  assert.equal(probe(`await import('node:sqlite');`).sqlite, true);
  assert.deepEqual(probe(`const { spawnSync } = await import('node:child_process'); spawnSync(process.execPath, ['-e', '0']);`).spawns,
    [`spawnSync ${process.execPath}`]);
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

test('draft contracts, store, capture, parser, policy and planner are available; scanners remain unavailable', () => {
  const r = cli('capabilities', '--json');
  assert.equal(r.status, 0);
  const listed = JSON.parse(r.stdout).capabilities as typeof CAPABILITIES;
  assert.deepEqual(listed, JSON.parse(JSON.stringify(CAPABILITIES)));
  assert.deepEqual(listed.filter(c => c.state !== 'unavailable').map(c => c.id), ['contract-validation', 'ledger', 'source-capture', 'parser-reconciliation', 'trusted-policy', 'rules-and-planning']);
  assert.equal(listed.find(c => c.id === 'parser-reconciliation')?.reasonCode, 'sentinel.capability.draftParser');
  for (const id of ['scan-cli', 'pattern-scan', 'coordinator', 'reports']) assert.equal(listed.find(c => c.id === id)?.state, 'unavailable', id);
  assert.equal(listed.find(c => c.id === 'rules-and-planning')?.state, 'available-draft');
  assert.ok(listed.filter(c => c.state !== 'unavailable').every(c => c.state === 'available-draft'));
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
  for (const code of ['unknownKind', 'tooLarge', 'malformedJson', 'missingVersion', 'wrongKind', 'unsupportedVersion', 'invalid', 'invariant', 'errorLimit']) used.add(`sentinel.contract.${code}`);
  used.add('sentinel.protocol.noSharedVersion');
  for (const code of [...POLICY_ERROR_CODES, ...POLICY_REASON_CODES]) used.add(code);
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

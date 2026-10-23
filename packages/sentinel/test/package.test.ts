import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, POLICY_ERROR_CODES, POLICY_REASON_CODES } from '../dist/index.js';
import { NEST_REASON_CODES } from '../dist/frameworks/nest/index.js';

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
  // declarations name Node built-ins. Only the lazy MCP protocol SDK and its pinned required peer are added; no scanner, container client or model SDK dependency.

  // oxc-parser (the version the public parser pins) because the Express pack reads source syntax itself (ADR 31).
  assert.equal(manifest.dependencies?.zod, '3.25.76');
  assert.equal(manifest.dependencies?.['@modelcontextprotocol/sdk'], '1.32.0');
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ['@farsight/code-parser', '@farsight/core', '@farsight/graph', '@modelcontextprotocol/sdk', '@types/node', '@vscode/tree-sitter-wasm', 'ajv', 'oxc-parser', 'zod']);
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
  // Exact-owned native memory witness: bounded fixed proc/cgroup reads and one filesystem notification watcher.
  'execution/cgroup-memory.js': ['node:fs'],
  'service/controls.js': ['@farsight/core/dist/strings.js'],
  'service/readonly.js': ['@farsight/core/dist/strings.js', 'node:crypto', 'node:perf_hooks'],
  'service/mcp.js': ['@farsight/core/dist/strings-sentinel-service.js', '@farsight/core/dist/strings.js', '@modelcontextprotocol/sdk/server/index.js', '@modelcontextprotocol/sdk/server/stdio.js', '@modelcontextprotocol/sdk/types.js'],
  'service/path-request-file.js': ['node:fs'],
  'service/path-adapter.js': ['node:path'],
  'service/scanner-assets.js': ['node:crypto', 'node:fs', 'node:path'],
  'reports/accepted-secrets.js': ['@farsight/graph', 'node:crypto'],
  'reports/selected-privacy.js': ['@farsight/graph'],
  'reports/scanner.js': ['@farsight/core/dist/counts.js', '@farsight/core/dist/strings.js'],
  // The pattern adapter (PR 10): hashing and its own job files only; the engine runs through execution/ in a container.
  'adapters/drivers/canonical.js': ['node:fs'],
  'adapters/drivers/common.js': ['node:crypto'],
  'adapters/pattern/adapter.js': ['node:crypto'],
  'adapters/pattern/job.js': ['node:crypto', 'node:fs', 'node:path'],
  'adapters/pattern/normalize.js': ['node:crypto'],
  'adapters/pattern/resolved.js': ['node:crypto'],
  'adapters/pattern/run.js': ['node:fs', 'node:path'],
  // The OSV advisory adapter (PR 12): hashing, its own job and snapshot files; the engine runs through execution/.
  'adapters/osv/acquire.js': ['node:crypto', 'node:fs', 'node:path'],
  'adapters/osv/adapter.js': ['node:crypto'],
  'adapters/osv/job.js': ['node:crypto', 'node:fs', 'node:path'],
  'adapters/osv/normalize.js': ['node:crypto'],
  'adapters/osv/run.js': ['node:fs', 'node:path'],
  'adapters/sealed-input.js': ['node:fs', 'node:path'],
  // The Trivy misconfiguration adapter (PR 13): its job and bundle files and hashing; the engine runs through execution/.
  'adapters/trivy/adapter.js': ['node:crypto'],
  'adapters/trivy/bundle.js': ['node:crypto', 'node:fs', 'node:path'],
  'adapters/trivy/job.js': ['node:crypto', 'node:fs', 'node:path'],
  'adapters/trivy/normalize.js': ['node:crypto'],
  'adapters/trivy/run.js': ['node:fs', 'node:path'],
  // The zizmor CI-configuration adapter (PR 13): its job file and hashing; the engine runs through execution/.
  'adapters/zizmor/adapter.js': ['node:crypto'],
  'adapters/zizmor/job.js': ['node:crypto', 'node:fs', 'node:path'],
  'adapters/zizmor/normalize.js': ['node:crypto'],
  'adapters/zizmor/run.js': ['node:fs', 'node:path'],
  // The Gitleaks secret-scan adapter (PR 11): hashing and its own job files; the engine runs through execution/.
  'adapters/gitleaks/adapter.js': ['node:crypto'],
  'adapters/gitleaks/job.js': ['node:crypto', 'node:fs', 'node:path'],
  'adapters/gitleaks/normalize.js': ['node:crypto'],
  'adapters/gitleaks/run.js': ['node:fs', 'node:path'],
  // Worker execution (PR 07). Only processes.js may start a process (asserted below); nothing networked.
  'execution/assets.js': ['node:crypto', 'node:fs', 'node:path', 'node:url'],
  'execution/bootstrap.js': ['node:fs', 'node:path'],
  'execution/check-drivers.js': ['node:crypto', 'node:fs', 'node:path'],
  'execution/coordinator.js': ['node:crypto', 'node:fs', 'node:path'],
  'execution/coverage.js': ['node:crypto'],
  'execution/durability.js': ['node:fs'],
  // Accepted-source hashing moved from retained-analysis into the shared bounded verifier.
  'execution/retained-source.js': ['node:crypto'],
  'execution/plan.js': ['node:crypto', 'node:path'],
  'execution/plans.js': ['node:crypto'],
  'execution/errors.js': ['@farsight/core/dist/strings-sentinel-execution.js'],
  'execution/isolation.js': ['node:crypto', 'node:fs', 'node:os', 'node:path'],
  'execution/launch-gate.js': ['node:fs'],
  'execution/processes.js': ['node:child_process'],
  'execution/publication.js': ['node:fs'],
  'execution/recovery.js': ['node:fs', 'node:path'],
  'execution/scratch.js': ['node:fs', 'node:path'],
  'execution/registry.js': ['node:crypto', 'node:fs', 'node:path', 'node:url'],
  'execution/supervisor.js': ['node:crypto', 'node:fs', 'node:path'],
  // The Nest pack (PR 16) reads captured bytes with the parser's own pinned oxc-parser, loaded on first analysis only.
  'frameworks/nest/analyze.js': ['node:crypto'],
  'frameworks/nest/errors.js': ['@farsight/core/dist/strings-sentinel-nest.js'],
  'frameworks/nest/syntax.js': ['dynamic:oxc-parser'],

  // Model providers (PR 21): the only network client in the package, and the keychain read through core's reader.
  'review/providers/broker.js': ['node:crypto'],
  'review/providers/budget.js': ['node:crypto', 'node:path'],
  'review/providers/credentials.js': ['@farsight/core/dist/keychain.js'],
  'review/providers/errors.js': ['@farsight/core/dist/strings-sentinel-providers.js'],
  'review/providers/transport.js': ['node:http', 'node:https'],

  // The Next pack (PR 14) reads literal syntax with Oxc, loaded on first read only; it never runs application code.
  'frameworks/next/analyze.js': ['node:crypto'],
  'frameworks/next/config.js': ['dynamic:oxc-parser'],
  'frameworks/next/errors.js': ['@farsight/core/dist/strings-sentinel-next.js'],
  // Trusted policy (ADR 21): core's pure grant matcher and credential-shape check; user state through node:fs only.
  // The Spring pack: tree-sitter's Java grammar, loaded on first analysis only; graph is pure JSON helpers.
  'frameworks/spring/pack.js': ['@farsight/graph', 'node:crypto'],
  'frameworks/spring/syntax.js': ['dynamic:@vscode/tree-sitter-wasm', 'node:path', 'node:url'],
  'policy/admission.js': ['@farsight/core/dist/grants.js'],
  'policy/adoption.js': ['node:fs', 'node:os', 'node:path'],
  'policy/digest.js': ['node:crypto'],
  'policy/owner-receipts.js': ['node:crypto'],
  'policy/receipts.js': ['node:path'],
  'policy/settings.js': ['@farsight/core/dist/credential-shapes.js'],
  'policy/user-state.js': ['node:crypto', 'node:fs', 'node:path'],
  // Rule packs are read as data: listed and opened, never imported, evaluated or spawned.
  'rules/pack.js': ['node:fs', 'node:path'],
  'cli.js': ['@farsight/core/dist/strings-sentinel-cli.js', '@farsight/core/dist/strings-sentinel-decisions.js', '@farsight/core/dist/strings-sentinel-service.js', 'node:fs', 'node:path'],
  // The full report: reads the store's accepted evidence, an owner-supplied graph file, and writes one new file.
  // The per-store report key: random bytes kept once in the owner's trust folder.
  'service/report-key.js': ['node:crypto', 'node:path'],
  'service/full-report.js': ['@farsight/core/dist/strings.js', '@farsight/graph', 'node:crypto', 'node:fs', 'node:path'],
  'cli/init.js': ['node:crypto', 'node:fs', 'node:path'],
  // The foundation-preview detector, a built-in worker: it reads its copied inputs and writes one artifact.
  'adapters/preview-detector.js': ['node:crypto', 'node:fs'],
  // This package's own executable and shipped rule packs, found from the module's folder upward.
  'service/package-paths.js': ['node:fs', 'node:path', 'node:url'],
  'service/framework-adapter.js': ['node:path'],
  'service/inspection-report.js': ['@farsight/core/dist/strings.js', '@farsight/graph'],
  // The CLI's canonical path: the planner, admission, bootstrap and coordinator in their order; digests only.
  'service/canonical.js': ['node:crypto'],
  'service/local.js': ['node:crypto', 'node:fs', 'node:path'],
  'service/owner-service.js': ['node:crypto', 'node:fs', 'node:path'],
  // A run's scratch lease inside the held store: no-follow folder checks and a bounded post-order removal.
  'service/scratch-lease.js': ['node:crypto', 'node:fs', 'node:path'],
  // Fatal-run diagnostics compose a private journal path; filesystem access stays in reviewed journal helpers.
  'service/run-failure.js': ['node:path'],
  // The owner's rule locks: content-addressed revisions and one pointer in private state, through policy/user-state.
  'service/rule-locks.js': ['node:path'],
  // Owner-private records published whole: a synced temporary name linked to its final one, never replaced.
  'service/publish-once.js': ['node:crypto', 'node:fs', 'node:path'],
  // The CLI's trusted profile: its canonical document's digest.
  'service/trusted-profile.js': ['node:crypto', 'node:fs'],
  // The owner's background service is the one process the command line starts itself (asserted below).
  'service/launch.js': ['node:child_process'],
  // The local service socket: an owner-only Unix socket, used only when a service runs; nothing at import.
  'transport/ipc.js': ['node:crypto', 'node:fs', 'node:net', 'node:path'],
  // The report checks every count with core's own countedProblems, over the whole catalog.
  'reports/preview.js': ['@farsight/core/dist/counts.js', '@farsight/core/dist/strings.js'],
  'validate.js': ['ajv'],
  // The planner's reason codes are catalog words.
  'planner/errors.js': ['@farsight/core/dist/strings-sentinel-plan.js'],
  'planner/boundary.js': ['node:crypto'],
  // The store's reason codes are catalog words; core's catalog is the only Farsight module the library reads.
  'store/errors.js': ['@farsight/core/dist/strings-sentinel-store.js'],
  'evidence/owner-cli.js': ['@farsight/core/dist/strings-sentinel-cli.js', '@farsight/core/dist/strings-sentinel-service.js', 'node:path'],
  'evidence/import-operation.js': ['node:crypto'],
  'evidence/owner-context.js': ['node:fs', 'node:path'],
  'evidence/audit.js': ['node:fs', 'node:path'],
  'store/ledger-json.js': ['node:crypto'],
  // Scope-local counters and a monotonic clock; neither performs I/O or starts work on import.
  'store/read-budget.js': ['node:async_hooks', 'node:perf_hooks', 'node:timers/promises'],
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
  // Findings and reports (ADR 38): pure folds over observations, captured bytes and a pinned context; core's own
  // journey, impact and persona folds and its catalog; no process, no network, no file access.
  'findings/owner-journal.js': ['node:crypto','node:fs','node:path'],
  'findings/owner-cli.js': ['@farsight/core/dist/strings.js','node:path'],
  'findings/owner-report.js': ['@farsight/core/dist/strings.js'],
  'findings/dispositions.js': ['node:crypto', 'node:fs', 'node:path'],
  'findings/correlate.js': ['@farsight/graph', 'node:crypto'],
  'findings/normalize.js': ['node:crypto'],
  'reports/context.js': ['@farsight/graph', 'node:crypto'],
  'reports/document.js': ['@farsight/core/dist/strings.js', '@farsight/graph', 'node:crypto'],
  'reports/index.js': ['@farsight/graph'],
  'reports/place.js': ['@farsight/core/dist/affected.js', '@farsight/core/dist/impact.js', '@farsight/core/dist/journeys.js', '@farsight/core/dist/query.js'],
  // Bounded call paths and attested deep import (ADR 36): pure over parser evidence and captured bytes; no engine, no process.
  'analysis/paths/paths.js': ['@farsight/graph', 'node:crypto'],
  'analysis/paths/protocol.js': ['node:crypto'],
  // The fixed structural child reads only sealed files; its driver writes the private prepared request.
  'analysis/paths/worker.js': ['node:crypto', 'node:fs', 'node:url'],
  'analysis/paths/driver.js': ['node:fs', 'node:path'],
  'analysis/deep/import.js': ['@farsight/graph', 'node:crypto'],
  // Imported report readers (PR 20 Stage A): one bounded no-follow file read, hashing and canonical JSON; no network,
  // no process, no decompression, no store or receipt.
  'imports/bounded-file.js': ['node:fs', 'node:path'],
  'imports/collect.js': ['node:crypto'],
  'imports/normalize.js': ['@farsight/graph', 'node:crypto'],
  'imports/sarif.js': ['@farsight/graph'],
  // The Express pack (ADR 31): Oxc loaded by the first analysis, never at import; graph for canonical digests.
  // The framework inspection worker (ADR 44): sealed inputs by digest, one output file; it runs only as its own entry.
  'frameworks/controls/closure.js': ['node:crypto', 'node:fs', 'node:module', 'node:path', 'node:url', 'require:oxc-parser'],
  'frameworks/controls/worker.js': ['node:crypto', 'node:fs', 'node:url'],
  'frameworks/express/pack.js': ['@farsight/graph', 'node:crypto'],
  'frameworks/express/syntax.js': ['dynamic:oxc-parser'],
  'snapshot/worktree.js': ['node:fs'],
};

test('the library imports only its reviewed modules, and nothing that could start work at import', () => {
  const dist = `${pkgDir}dist/`;
  const found: Record<string, string[]> = {};
  for (const file of filesUnder(dist).filter(f => f.endsWith('.js'))) {
    let text = readFileSync(file, 'utf8');
    // The framework inspection worker's entry is generated text (ADR 44): it must import the worker dynamically, after
    // checking the closure, so its template is not this module's own imports. Exactly that one template is set aside.
    if (file.slice(dist.length) === 'frameworks/controls/closure.js') {
      const template = /return `\/\/ Generated: the framework inspection worker[\s\S]*?`;\n/g;
      assert.equal(text.match(template)?.length, 1, 'closure.js holds exactly one generated entry template');
      text = text.replace(template, '');
    }
    const specs = new Set<string>();
    for (const m of text.matchAll(/\bcreateRequire\(import\.meta\.url\)\(['"]([^'"]+)['"]\)/g)) specs.add(`require:${m[1]}`);
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
  // Outside it, only the service launcher starts a process: this executable's `serve`, an argument list, no shell.
  const launch = readFileSync(`${dist}service/launch.js`, 'utf8');
  assert.deepEqual([...launch.matchAll(/(?<![.\w])(spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(([^,)]*)/g)].map(m => `${m[1]}(${m[2]!.trim()}`),
    ['spawn(process.execPath']);
  assert.match(launch, /shell: false/);
  assert.match(launch, /'serve', '--workspace'/);
  // The Gitleaks adapter starts nothing itself: its worker is shell text the container runs.
  for (const f of ['adapter', 'job', 'normalize', 'run', 'rules', 'worker-source', 'index']) {
    assert.doesNotMatch(readFileSync(`${dist}adapters/gitleaks/${f}.js`, 'utf8'), /node:child_process|(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(/, `adapters/gitleaks/${f}.js starts no process`);
  }
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
  assert.match(help.stdout, /pinned scanners/);
  // Positive controls: the probe sees SQLite once loaded, and a spawn made through a named import.
  assert.equal(probe(`await import('node:sqlite');`).sqlite, true);
  assert.deepEqual(probe(`const { spawnSync } = await import('node:child_process'); spawnSync(process.execPath, ['-e', '0']);`).spawns,
    [`spawnSync ${process.execPath}`]);
});

test('help and version describe explicit pinned scanner execution', () => {
  const help = cli('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /pinned scanners/);
  assert.match(help.stdout, /Scans never acquire assets/);
  assert.match(help.stdout, /4 awaiting owner confirmation/);
  const version = cli('--version');
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), `farsight-sentinel ${manifest.version}, contracts draft-1`);
});

test('public scanner command support is conditional on explicit adopted pinned assets', () => {
  const r = cli('capabilities', '--json');
  assert.equal(r.status, 0);
  const listed = JSON.parse(r.stdout).facts.capabilities as typeof CAPABILITIES;
  assert.deepEqual(listed, JSON.parse(JSON.stringify(CAPABILITIES)));
  assert.deepEqual(listed.filter(c => c.state !== 'unavailable').map(c => c.id), ['contract-validation', 'ledger', 'source-capture', 'parser-reconciliation', 'trusted-policy', 'rules-and-planning', 'worker-isolation', 'coordinator', 'scan-cli', 'pattern-scan', 'secrets-scan', 'dependency-advisories', 'infrastructure-ci-checks', 'framework-express', 'framework-spring', 'bounded-call-paths', 'deep-import', 'reports', 'report-imports', 'dispositions', 'mcp']);
  assert.equal(listed.find(c => c.id === 'framework-express')?.reasonCode, 'sentinel.capability.draftExpress');
  assert.equal(listed.find(c => c.id === 'parser-reconciliation')?.reasonCode, 'sentinel.capability.draftParser');
  assert.deepEqual([listed.find(c=>c.id==='dispositions')?.state,listed.find(c=>c.id==='dispositions')?.reasonCode],['available-draft','sentinel.capability.draftDecisions']);
  assert.equal(listed.find(c => c.id === 'interprocedural-flow')?.state, 'unavailable', 'no deep engine is claimed');
  assert.equal(listed.find(c => c.id === 'framework-spring')?.reasonCode, 'sentinel.capability.draftSpring');
  assert.equal(listed.find(c => c.id === 'rules-and-planning')?.state, 'available-draft');
  assert.ok(listed.filter(c => c.state !== 'unavailable').every(c => c.state === 'available-draft'));
  for (const c of listed) assert.match(c.reasonCode, /^sentinel\.capability\./);
  assert.equal(listed.find(c => c.id === 'interprocedural-flow')?.reasonCode, 'sentinel.capability.noQualifiedEngine');
});

test('planned commands refuse with exit 3 and start nothing', () => {
  for (const command of ['bundle']) {
    const r = cli(command, '--json');
    assert.equal(r.status, 3, command);
    assert.match(r.stderr, new RegExp(`^unavailable: ${command} is not implemented in this draft build \\(planned in PR \\d+\\)\\. Nothing was started\\.`));
    // JSON says unavailable, with every verdict not asked: never a scan result.
    const body = JSON.parse(r.stdout);
    assert.equal(body.outcome, 'unavailable', command);
    assert.equal(body.exitCode, 3);
    for (const v of Object.values(body.verdicts) as Array<{ asked: boolean; allowed: boolean }>) assert.deepEqual([v.asked, v.allowed], [false, false]);
    assert.equal(cli(command).stdout, '', 'without --json nothing is printed to stdout');
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
    assert.deepEqual([body.outcome, body.exitCode, body.reasonCode], ['refused', 3, 'sentinel.cli.invalid']);
    assert.equal(body.facts.ok, false);
    assert.equal(body.facts.errors[0].code, 'sentinel.contract.unsupportedVersion');
    assert.deepEqual(body.facts.errors[0].supported, ['sentinel-run/draft-1']);
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
  for (const code of [...POLICY_ERROR_CODES, ...POLICY_REASON_CODES, ...NEST_REASON_CODES]) used.add(code);
  assert.deepEqual(Object.keys(STRINGS).filter(k => k.startsWith('sentinel.nest.')).sort(), [...NEST_REASON_CODES].sort(), 'the Nest catalog and the pack\'s codes are one list');
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


test('decision fault injection stays outside the named package and findings exports',async()=>{
  const findings=await import('../dist/findings/index.js');
  assert.equal('setOwnerDecisionAppendFailureForTest' in findings,false);
  assert.equal(Object.hasOwn(manifest.exports,'./findings/owner-decision-test-hooks'),false);
  assert.equal(Object.hasOwn(manifest.exports,'./findings/*'),false);
});

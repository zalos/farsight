#!/usr/bin/env node
// Coarse CI boundaries, not a per-test dependency graph. Unknown inputs run everything.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildClosure, workspacePackages } from './pack-preflight.mjs';

const all = () => ({
  validate: true,
  e2e: true,
  echo: true,
  sentinel: true,
  isolation: true,
  recovery: true,
  service: true,
  scannerCli: true,
});

/** validate's unit tests over every package, and over none (only the skills trees changed). */
const EVERY = Object.freeze({ scope: 'all', packages: Object.freeze([]), also: Object.freeze([]) });
const NONE = Object.freeze({ scope: 'none', packages: Object.freeze([]), also: Object.freeze([]) });

/** The only package names the selector emits or the test step hands to pnpm: one output word, no separators. */
const PACKAGE_NAME = /^@farsight\/[a-z0-9-]+$/;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The package directories `sentinel-package` packs: farsight-cli's whole workspace dependency
 * closure (its clean-consumer startup without Sentinel is checked there) and Sentinel's own.
 * Read from the manifests, so a new dependency of the CLI joins the set without editing this file.
 */
export function sentinelPackageInputs(root = repoRoot) {
  const dirs = new Set(['graph', 'code-parser', 'core']);
  for (const entry of ['@farsight/cli', '@farsight/sentinel']) {
    const { closure, missing } = buildClosure(root, entry);
    if (entry === '@farsight/cli' && (!closure.length || missing.length)) throw new Error('CLI closure unreadable');
    for (const pkg of closure) dirs.add(basename(pkg.dir));
  }
  dirs.delete('sentinel'); // its own rules below
  return dirs;
}

/**
 * The package directories `sentinel-isolation` depends on: Sentinel's own workspace build closure (public parser,
 * core and graph today), read from the manifests. Sentinel itself has its own rule below.
 */
export function sentinelIsolationInputs(root = repoRoot) {
  const { closure, missing } = buildClosure(root, '@farsight/sentinel');
  if (!closure.length || missing.length) throw new Error('Sentinel closure unreadable');
  const dirs = new Set(closure.map((pkg) => basename(pkg.dir)));
  dirs.delete('sentinel');
  return dirs;
}

/**
 * The package directories the sentinel-scanner-cli workflow builds and runs over: Sentinel's workspace closure and
 * the parsers' (its full-report tests ingest an application through `packages/parsers/dist`), read from the manifests.
 */
export function scannerCliInputs(root = repoRoot) {
  const dirs = new Set(['sentinel']);
  for (const entry of ['@farsight/sentinel', '@farsight/parsers']) {
    const { closure, missing } = buildClosure(root, entry);
    if (!closure.length || missing.length) throw new Error(`${entry} closure unreadable`);
    for (const pkg of closure) dirs.add(basename(pkg.dir));
  }
  return dirs;
}

/**
 * What that workflow does not exercise, though it lies inside those packages: agent review and its providers, the
 * owner UI, their tests and fixtures, and their string catalogs. None of its tests or installed consumers imports them.
 */
const SCANNER_CLI_SKIPS = [
  /^packages\/sentinel\/src\/(?:review|owner-ui)\//,
  /^packages\/sentinel\/src\/service\/review-adapter\.ts$/,
  /^packages\/sentinel\/test\/(?:review[-.]|providers\.|provider-helpers\.|cli-copilot|cli-native|cli-review|model-budget|agentic-only|retained-wire|owner-ui-)/,
  /^packages\/sentinel\/test\/fixtures\/(?:model-budget|model-review|retained-wire|stage-packs)\//,
  /^packages\/sentinel\/test\/fixtures\/review-instructions-runner\.mjs$/,
  /^packages\/core\/src\/(?:strings-sentinel-(?:providers|review|instructions|owner-ui|viewer)|sentinel-companion)\.ts$/,
];

/** The scripts the scanner workflow runs, besides the selector and the workflow (which select every check). */
const SCANNER_CLI_SCRIPTS =
  /^scripts\/(?:pack-sentinel|sentinel-evidence-provenance|test-sentinel-report-browser|test-sentinel-(?:scanner|framework|mcp|evidence|decisions|paths)-consumer)\.mjs$/;

/** Whether one changed path reaches the sentinel-scanner-cli workflow. */
function reachesScannerCli(path, scanner) {
  if (SCANNER_CLI_SKIPS.some((skip) => skip.test(path))) return false;
  if (SCANNER_CLI_SCRIPTS.test(path) || path.startsWith('packages/sentinel/')) return true;
  // the other packages' code, not their own tests
  const dir = /^packages\/([^/]+)\/(?!test\/)/.exec(path)?.[1];
  return Boolean(dir && scanner.has(dir));
}

/** The skills trees: read only by the script tests (scripts/check-skills-mirror.mjs), never by a package's tests. */
const SKILLS = /^\.(?:claude|agents)\/skills\//;

/** The checks one changed path selects, or `null` when it selects every check. */
function pathChecks(path, inputs, isolation, scanner) {
  const checks = { validate: false, e2e: false, echo: false, sentinel: false, isolation: false };
  checks.scannerCli = scanner ? reachesScannerCli(path, scanner) : false;
  // These Markdown files are shipped in the Echo tarball, so still check packaging.
  if (
    [
      'docs/ECHO.md',
      'packages/echo/README.md',
      'scripts/pack-echo.mjs',
      'scripts/test-echo-package.mjs',
      '.echo/settings.example.json',
      '.echo/connection.example.json',
    ].includes(path)
  ) {
    checks.echo = true;
  } else if (
    [
      'scripts/npm-acceptance.mjs',
      'scripts/sentinel-release-acceptance.mjs',
      'scripts/sentinel-native-helper.mjs',
    ].includes(path)
  ) {
    // The clean npm acceptance both packages' tarballs run through in sentinel-package, and its script tests.
    // (npm-consumer.mjs, which it builds on, is shared packaging and selects everything below.)
    checks.validate = checks.sentinel = true;
  } else if (path === 'scripts/pack-sentinel.mjs') {
    // Sentinel's tarball; its review-package unit test packs it too.
    checks.validate = checks.sentinel = true;
  } else if (['packages/sentinel/README.md', 'scripts/test-sentinel-package.mjs'].includes(path)) {
    // Sentinel's tarball and its packaging; Farsight's package does not include it.
    checks.sentinel = true;
  } else if (SKILLS.test(path)) {
    // The two skills trees must stay identical: scripts/check-skills-mirror.mjs runs under pnpm test:scripts.
    checks.validate = true;
  } else if (/^(?:[^/]+\.md|docs\/.*\.md|\.(?:github|claude|agents)\/.*\.md)$/s.test(path) || path === 'LICENSE') {
    // Only known documentation locations; Markdown in fixtures can affect tests.
  } else if (path === 'scripts/synth-graph.mjs') {
    // The perf suite's synthetic workspace; the server's search and fold tests import it too.
    checks.e2e = checks.validate = true;
  } else if (path.startsWith('e2e/') || /^scripts\/(?:e2e|e2e-perf)\.mjs$/.test(path)) {
    checks.e2e = true;
  } else if (/^packages\/sentinel\/(?!test\/)/.test(path)) {
    // Sentinel's offline HTML delivery is checked by the browser-provisioned e2e job. The isolation
    // canaries exercise the execution code and everything it is built on, so any Sentinel code selects them.
    checks.validate = checks.e2e = checks.sentinel = checks.isolation = true;
  } else if (path.startsWith('packages/sentinel/test/')) {
    checks.validate = checks.e2e = checks.isolation = true;
  } else if (
    /^packages\/[^/]+\/test\//.test(path) ||
    path.startsWith('scripts/test/') ||
    /^scripts\/(?:changelog|release|release-manifest|verify-release|install-hooks|lint-commits)\.mjs$/.test(path)
  ) {
    checks.validate = true;
  } else if (/^(?:packages|examples|schemas)\//.test(path)) {
    checks.validate = checks.e2e = true;
    if (/^packages\/(?:graph|core|echo)\//.test(path)) checks.echo = true;
    // farsight-cli's closure (it must still pack and start without Sentinel) and Sentinel's own;
    // the package smoke also ingests the invoice example.
    if (inputs.has(/^packages\/([^/]+)\//.exec(path)?.[1]) || path.startsWith('examples/invoice-app/'))
      checks.sentinel = true;
    if (isolation.has(/^packages\/([^/]+)\//.exec(path)?.[1])) checks.isolation = true;
  } else {
    return null; // includes build/config/dependencies, workflows and this selector
  }
  return checks;
}

export function selectChecks(paths, { root = repoRoot, packageInputs, isolationInputs, scannerInputs } = {}) {
  let inputs, isolation, scanner;
  try {
    inputs = packageInputs ?? sentinelPackageInputs(root);
    isolation = isolationInputs ?? sentinelIsolationInputs(root);
    scanner = scannerInputs ?? scannerCliInputs(root);
  } catch {
    return all();
  } // unreadable manifests: everything
  const checks = {
    validate: false,
    e2e: false,
    echo: false,
    sentinel: false,
    isolation: false,
    recovery: false,
    service: false,
    scannerCli: false,
  };
  for (const path of paths) {
    const selected = pathChecks(path, inputs, isolation, scanner);
    if (!selected) return all();
    for (const [name, run] of Object.entries(selected)) if (run) checks[name] = true;
  }
  // The recovery smoke runs the coordinator over the same execution and store code as the isolation canaries.
  checks.recovery = checks.isolation;
  // Sentinel's process suite (packages/sentinel/test/process-suite.txt) runs only in sentinel-service and validate
  // runs the rest, so that job runs exactly when validate tests Sentinel.
  if (checks.validate) {
    const tests = selectTests(paths, { root, packageInputs: inputs, isolationInputs: isolation });
    checks.service = tests.scope === 'all' || tests.packages.includes('@farsight/sentinel');
  }
  return checks;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * The workspace's dependency graph: package directory → its name and the directories of the packages that depend on
 * it, over every dependency field (devDependencies too, as pnpm's own workspace graph counts them).
 */
export function workspaceGraph(root = repoRoot) {
  const packages = workspacePackages(root);
  if (!packages.size) throw new Error('No workspace packages');
  // A name is written into the step outputs and onto pnpm's command line; anything else selects every check.
  for (const name of packages.keys())
    if (!PACKAGE_NAME.test(name)) throw new Error(`Unexpected workspace package name: ${JSON.stringify(name)}`);
  const dirOf = new Map([...packages].map(([name, { dir }]) => [name, basename(dir)]));
  const graph = new Map([...packages].map(([name, { dir }]) => [basename(dir), { name, dependents: new Set() }]));
  for (const [name, { manifest }] of packages)
    for (const field of DEPENDENCY_FIELDS)
      for (const dep of Object.keys(manifest[field] ?? {}))
        if (dirOf.has(dep) && dep !== name) graph.get(dirOf.get(dep)).dependents.add(dirOf.get(name));
  return graph;
}

// A test reaching into another workspace package: `packages/<dir>/dist`, `../../<dir>/dist`, or
// `join(here, '..', '..', '<dir>', 'dist')`, for the folders a package's tests can read.
const READS = 'dist|src|test|public|bin';
const REFERENCE = new RegExp(
  String.raw`(?:packages/|(?:\.\./)+)([a-z0-9][\w.-]*)/(?:${READS})(?=[/'"\x60])` +
    String.raw`|['"]\.\.['"],\s*['"]\.\.['"],\s*['"]([a-z0-9][\w.-]*)['"],\s*['"](?:${READS})['"]`,
  'g',
);

/**
 * Test files whose reference to another package's files runs only outside validate, so validate need not test them
 * when that package changes. `gate` is the condition in the file that keeps it out of validate; the selector test
 * fails if the file loses it.
 */
export const OUTSIDE_VALIDATE = {
  // The CLI's dist is read only with SENTINEL_OWNER_UI_BROWSER=1, which the e2e job alone sets (and e2e runs for
  // every package change).
  'packages/sentinel/test/owner-ui-browser.test.ts': {
    packages: ['cli'],
    gate: "process.env.SENTINEL_OWNER_UI_BROWSER !== '1'",
  },
};

function sourceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return []; // a package with no tests
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Package tests that read the files of a workspace package their manifest does not depend on (an ingest through the
 * parsers' dist, a spawned CLI), which pnpm's dependency walk cannot see: consumer directory → provider directories.
 * Read from every package's `test/` folder, whole-line comments ignored, so a new reference joins without editing
 * this file. Unreadable test folders throw.
 */
export function testReach(root = repoRoot, graph = workspaceGraph(root)) {
  const reach = new Map();
  for (const consumer of graph.keys()) {
    const tests = join(root, 'packages', consumer, 'test');
    for (const file of sourceFiles(tests)) {
      const relative = `packages/${consumer}/test/${file
        .slice(tests.length + 1)
        .split(/[\\/]/)
        .join('/')}`;
      const outside = OUTSIDE_VALIDATE[relative]?.packages ?? [];
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
        .join('\n');
      for (const match of code.matchAll(REFERENCE)) {
        const provider = match[1] ?? match[2];
        if (provider === consumer || !graph.has(provider) || outside.includes(provider)) continue;
        if (!reach.has(consumer)) reach.set(consumer, new Set());
        reach.get(consumer).add(provider);
      }
    }
  }
  return reach;
}

/**
 * The package tests validate runs: every package with a changed path (both sides of a rename, from the selector's
 * `--no-renames` diff), every package that depends on one (from the manifests), and the packages whose tests read a
 * selected package's files without depending on it (`also`; alone, because their own code did not change, so their
 * dependents need nothing). validate passes the names to pnpm, one `--filter` each; the selector is the only place
 * the set is worked out. A path that selects validate from outside a workspace package (root files, the lockfile,
 * `scripts/`, `schemas/`, `examples/`, workflows) or an unreadable workspace tests every package: `scope` is `all`.
 * An empty set (only the skills trees changed) is `scope: 'none'`: no package's tests; the script tests still run.
 */
export function selectTests(paths, { root = repoRoot, graph, reach, packageInputs, isolationInputs } = {}) {
  let inputs, isolation;
  try {
    graph ??= workspaceGraph(root);
    reach ??= testReach(root, graph);
    inputs = packageInputs ?? sentinelPackageInputs(root);
    isolation = isolationInputs ?? sentinelIsolationInputs(root);
  } catch {
    return EVERY;
  }
  const changed = new Set();
  for (const path of paths) {
    const checks = pathChecks(path, inputs, isolation);
    // documentation, e2e and packaging inputs, and the skills trees: no package's unit test reads them
    if ((checks && !checks.validate) || SKILLS.test(path)) continue;
    const dir = /^packages\/([^/]+)\//.exec(path)?.[1];
    if (!checks || !graph.has(dir)) return EVERY;
    changed.add(dir);
  }
  const selected = new Set(changed);
  for (const queue = [...changed]; queue.length;)
    for (const dependent of graph.get(queue.pop()).dependents)
      if (!selected.has(dependent)) (selected.add(dependent), queue.push(dependent));
  const also = [...reach.keys()].filter(
    (consumer) => !selected.has(consumer) && [...reach.get(consumer)].some((provider) => selected.has(provider)),
  );
  const names = (dirs) => dirs.map((dir) => graph.get(dir).name).sort();
  const packages = names([...selected, ...also]);
  if (!packages.every((name) => PACKAGE_NAME.test(name))) return EVERY;
  return packages.length ? { scope: 'packages', packages, also: names(also) } : NONE;
}

/**
 * The selector's step outputs. Each check is `true` or `false`; `testScope` is `packages` with at least one name,
 * or `all` or `none` with none, and every name has the strict package shape, so no value can carry a separator
 * into another output record. Anything else is written as every check and every package.
 */
export function selectorOutput(checks, tests) {
  const safe =
    Object.values(checks).every((run) => typeof run === 'boolean') &&
    ['all', 'packages', 'none'].includes(tests?.scope) &&
    Array.isArray(tests.packages) &&
    tests.packages.every((name) => typeof name === 'string' && PACKAGE_NAME.test(name)) &&
    (tests.scope === 'packages') === tests.packages.length > 0;
  const [emitted, scope] = safe ? [checks, tests] : [all(), EVERY];
  return (
    Object.entries(emitted)
      .map(([name, run]) => `${name}=${run}`)
      .join('\n') + `\ntestScope=${scope.scope}\ntestPackages=${scope.packages.join(' ')}\n`
  );
}

/**
 * The pnpm arguments validate's test step runs, from the selector's two outputs as the workflow hands them over:
 * one `--filter <name>` per package when `scope` is `packages`; `null` (no package tests) only for `none` with no
 * names; every package for anything else, including `packages` with a missing or empty list and a missing scope.
 * A name without the package shape, or (given `members`, the workspace's names) not a workspace package, throws
 * rather than reaching pnpm, where it would match nothing.
 */
export function pnpmTestArgs(scope, packages = '', members) {
  const names = String(packages ?? '')
    .split(/\s+/)
    .filter(Boolean);
  if (scope === 'none' && !names.length) return null;
  if (scope !== 'packages' || !names.length) return ['-r', 'test'];
  for (const name of names) {
    if (!PACKAGE_NAME.test(name)) throw new Error(`Unexpected package name: ${JSON.stringify(name)}`);
    if (members && !members.has(name)) throw new Error(`Not a workspace package: ${name}`);
  }
  return ['-r', ...names.flatMap((name) => ['--filter', name]), 'test'];
}

/** The changed paths: a PR's from its merge base, a push's across every pushed commit. */
export function changedPaths({ base, head, event, cwd = process.cwd() }) {
  // Only event-provided commit IDs; never accept a revision option from an input.
  if (![base, head].every((sha) => /^[a-f0-9]{40,64}$/.test(sha ?? '') && !/^0+$/.test(sha))) {
    throw new Error('No usable base/head commit');
  }
  if (!['pull_request', 'push'].includes(event)) throw new Error('Unknown event');
  const git = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
  // PRs compare from their branch point, pushes compare the entire pushed range.
  const from = event === 'pull_request' ? git(['merge-base', base, head]).trim() : base;
  // No rename detection: consider BOTH the deleted old path and the added new path.
  // NUL delimiters preserve spaces/newlines; no GitHub API file-list limit.
  return git(['diff', '--name-only', '--no-renames', '-z', from, head, '--']).split('\0').filter(Boolean);
}

export function detectChecks({ root = repoRoot, ...range } = {}) {
  try {
    const paths = changedPaths(range);
    workspaceGraph(root); // an unreadable workspace, or a package name unsafe to emit, selects every check
    const checks = selectChecks(paths, {
      root,
      packageInputs: sentinelPackageInputs(root),
      isolationInputs: sentinelIsolationInputs(root),
    });
    return {
      checks,
      tests: checks.validate ? selectTests(paths, { root }) : EVERY,
      reason: `${paths.length} changed paths`,
    };
  } catch {
    return { checks: all(), tests: EVERY, reason: 'Change range or workspace unavailable; running every check' };
  }
}

function testsLine({ scope, packages, also }) {
  if (scope === 'none') return '- validate tests: no package (the script tests still run)';
  if (scope !== 'packages') return '- validate tests: every package';
  const extra = also.length ? `, with ${also.join(', ')}, whose tests read a reached package's files` : '';
  return `- validate tests: ${packages.join(', ')} (the changed packages and their dependents${extra})`;
}

/**
 * `--run-tests`: validate's test step. In CI it reads the selector's outputs from `TEST_SCOPE` and `TEST_PACKAGES`;
 * run locally with `BASE_SHA`, `HEAD_SHA` and `GITHUB_EVENT_NAME` instead, it selects the same way first.
 */
function runTests() {
  let tests;
  if (process.env.TEST_SCOPE !== undefined) {
    tests = { scope: process.env.TEST_SCOPE, packages: [process.env.TEST_PACKAGES ?? ''] };
  } else {
    const local = detectChecks({
      base: process.env.BASE_SHA,
      head: process.env.HEAD_SHA,
      event: process.env.GITHUB_EVENT_NAME,
    });
    console.log(`${local.reason}\n${testsLine(local.tests).slice(2)}`);
    if (!local.checks.validate) {
      console.log('validate is not selected for these changes; no package tests to run.');
      return 0;
    }
    tests = local.tests;
  }
  let members = null;
  try {
    members = new Set([...workspaceGraph().values()].map(({ name }) => name));
  } catch {
    // the workspace cannot be read, so membership cannot be checked: every package
  }
  const args = members ? pnpmTestArgs(tests.scope, tests.packages.join(' '), members) : ['-r', 'test'];
  if (!args) {
    console.log('No package is reached; no package tests to run.');
    return 0;
  }
  console.log(`pnpm ${args.join(' ')}`);
  const run = spawnSync('pnpm', args, { stdio: 'inherit' });
  if (run.error) throw run.error;
  return run.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--run-tests') process.exit(runTests());
  const { checks, tests, reason } = detectChecks({
    base: process.env.BASE_SHA,
    head: process.env.HEAD_SHA,
    event: process.env.GITHUB_EVENT_NAME,
  });
  const output = selectorOutput(checks, tests);
  console.log(`${reason}\n${output}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Affected checks\n\n${reason}.\n\n` +
        Object.entries(checks)
          .map(
            ([name, run]) =>
              `- ${{ echo: 'echo-package', sentinel: 'sentinel-package', isolation: 'sentinel-isolation', recovery: 'sentinel-recovery', service: 'sentinel-service', scannerCli: 'sentinel-scanner-cli (its own workflow)' }[name] ?? name}: ${run ? 'run' : 'skip'}`,
          )
          .join('\n') +
        (checks.validate ? `\n${testsLine(tests)}` : '') +
        '\n\nSecret scanning and PR commit conventions run independently.\n',
    );
  }
}

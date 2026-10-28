#!/usr/bin/env node
// Coarse CI boundaries, not a per-test dependency graph. Unknown inputs run everything.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildClosure, workspacePackages } from './pack-preflight.mjs';

const all = () => ({ validate: true, e2e: true, echo: true, sentinel: true, isolation: true, recovery: true });

/** validate's unit tests over every package. */
const EVERY = Object.freeze({ scope: 'all', packages: Object.freeze([]), also: Object.freeze([]) });

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

/** The skills trees: read only by the script tests (scripts/check-skills-mirror.mjs), never by a package's tests. */
const SKILLS = /^\.(?:claude|agents)\/skills\//;

/** The checks one changed path selects, or `null` when it selects every check. */
function pathChecks(path, inputs, isolation) {
  const checks = { validate: false, e2e: false, echo: false, sentinel: false, isolation: false };
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

export function selectChecks(paths, { packageInputs, isolationInputs } = {}) {
  let inputs, isolation;
  try {
    inputs = packageInputs ?? sentinelPackageInputs();
    isolation = isolationInputs ?? sentinelIsolationInputs();
  } catch {
    return all();
  } // unreadable manifests: everything
  const checks = { validate: false, e2e: false, echo: false, sentinel: false, isolation: false, recovery: false };
  for (const path of paths) {
    const selected = pathChecks(path, inputs, isolation);
    if (!selected) return all();
    for (const [name, run] of Object.entries(selected)) if (run) checks[name] = true;
  }
  // The recovery smoke runs the coordinator over the same execution and store code as the isolation canaries.
  checks.recovery = checks.isolation;
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
 * An empty set (only the skills trees changed) runs no package's tests; validate's script tests still run.
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
  return { scope: 'packages', packages: names([...selected, ...also]), also: names(also) };
}

const PACKAGE_NAME = /^@farsight\/[a-z0-9-]+$/;

/**
 * The pnpm arguments validate's test step runs, from the selector's two outputs as the workflow hands them over:
 * one `--filter <name>` per package when `scope` is exactly `packages`, `null` when that set is empty, and every
 * package for anything else, a missing or empty output included. A name that is not a workspace package's shape
 * throws rather than reaching pnpm.
 */
export function pnpmTestArgs(scope, packages = '') {
  if (scope !== 'packages') return ['-r', 'test'];
  const names = packages.split(/\s+/).filter(Boolean);
  for (const name of names) if (!PACKAGE_NAME.test(name)) throw new Error(`Unexpected package name: ${name}`);
  return names.length ? ['-r', ...names.flatMap((name) => ['--filter', name]), 'test'] : null;
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

export function detectChecks(options) {
  try {
    const paths = changedPaths(options);
    const checks = selectChecks(paths);
    return { checks, tests: checks.validate ? selectTests(paths) : EVERY, reason: `${paths.length} changed paths` };
  } catch {
    return { checks: all(), tests: EVERY, reason: 'Change range unavailable; running every check' };
  }
}

function testsLine({ scope, packages, also }) {
  if (scope !== 'packages') return '- validate tests: every package';
  if (!packages.length) return '- validate tests: no package (the script tests still run)';
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
    tests = { scope: process.env.TEST_SCOPE, packages: (process.env.TEST_PACKAGES ?? '').split(/\s+/).filter(Boolean) };
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
  const args = pnpmTestArgs(tests.scope, tests.packages.join(' '));
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
  const output =
    Object.entries(checks)
      .map(([name, run]) => `${name}=${run}`)
      .join('\n') + `\ntestScope=${tests.scope}\ntestPackages=${tests.packages.join(' ')}\n`;
  console.log(`${reason}\n${output}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Affected checks\n\n${reason}.\n\n` +
        Object.entries(checks)
          .map(
            ([name, run]) =>
              `- ${{ echo: 'echo-package', sentinel: 'sentinel-package', isolation: 'sentinel-isolation', recovery: 'sentinel-recovery' }[name] ?? name}: ${run ? 'run' : 'skip'}`,
          )
          .join('\n') +
        (checks.validate ? `\n${testsLine(tests)}` : '') +
        '\n\nSecret scanning and PR commit conventions run independently.\n',
    );
  }
}

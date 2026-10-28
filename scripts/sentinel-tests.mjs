#!/usr/bin/env node
// Sentinel's test files in two suites. The process suite is the list in packages/sentinel/test/process-suite.txt:
// the files that start a Node.js process or a package manager (the CLI, the detached owner service, workers,
// scripts, a packed tarball), which the `sentinel-service` CI job runs on native amd64 as a non-root user with zero
// skips. The unit suite is every other `test/*.test.ts`, which validate runs. Inside it, the files
// packages/sentinel/test/no-skip-suite.txt lists must not skip either: `--suite unit` runs them first as their own
// group and fails if any of their tests was skipped, then runs the rest, where environment-gated skips are normal.
// `no-skip` runs that group alone. `all` is every file in one run, which is what `pnpm -r test` does locally.
// Within each group the files packages/sentinel/test/serial-suite.txt lists run first, one at a time: their cases
// race the wall clock or a SIGKILL checkpoint.
//
//   node scripts/sentinel-tests.mjs [--suite unit|process|no-skip|all] [--concurrency N] [--list] [--launches]
//                                   [--summary <file>] [-- <node --test options>]
//
// `--summary` writes the summed `# tests`, `# pass`, `# fail`, `# cancelled`, `# skipped` and `# todo` lines of
// every run, for a CI step to check. A run that writes no TAP summary fails.
//
// The suite defaults to SENTINEL_TEST_SUITE, else `all`; concurrency to the machine's available parallelism. Files
// run from packages/sentinel. A listed file that does not exist, a duplicate, or a line that is not
// `test/<name>.test.ts` fails before anything runs, so a renamed file cannot drop out of the process suite unseen.
// `--launches` (or SENTINEL_TEST_LAUNCHES=1) records every child process each test file's process starts, from the
// test or the code under test, and after a passing run fails when a unit file started a Node.js process or a package
// manager without being named in test/unit-launchers.txt, or a process-suite file started none: the list is enforced.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SUITES = ['unit', 'process', 'no-skip', 'all'];
const LISTED = /^test\/[a-z0-9][a-z0-9.-]*\.test\.ts$/;

export const sentinelDir = (root = fileURLToPath(new URL('..', import.meta.url))) => join(root, 'packages', 'sentinel');

/** A list file's paths, as `test/<name>.test.ts`, read and checked. */
function readList(dir, name, { allowEmpty = false } = {}) {
  const text = readFileSync(join(dir, 'test', name), 'utf8');
  const files = [];
  const problems = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const where = `${name}:${index + 1}`;
    if (!LISTED.test(line)) problems.push(`${where}: not a test/<name>.test.ts path: ${JSON.stringify(line)}`);
    else if (files.includes(line)) problems.push(`${where}: listed twice: ${line}`);
    else if (!existsSync(join(dir, line))) problems.push(`${where}: no such file: ${line}`);
    else files.push(line);
  }
  if (!files.length && !problems.length && !allowEmpty) problems.push(`${name} lists no files`);
  if (problems.length) throw new Error(problems.join('\n'));
  return files;
}

/** The process suite's files, from `test/process-suite.txt`. */
export function processSuite(dir = sentinelDir()) {
  return readList(dir, 'process-suite.txt');
}

/**
 * The unit-suite files that must not skip on CI, from `test/no-skip-suite.txt`. A file there cannot also be in the
 * process suite, whose own job already allows no skip.
 */
export function noSkipSuite(dir = sentinelDir()) {
  const files = readList(dir, 'no-skip-suite.txt');
  const listed = processSuite(dir);
  const both = files.filter((file) => listed.includes(file));
  if (both.length) throw new Error(`no-skip-suite.txt lists process-suite files: ${both.join(' ')}`);
  return files;
}

/**
 * Files that run one at a time, before the rest of their group: tests whose cases race the wall clock or a SIGKILL
 * checkpoint and fail when other files load the machine. From `test/serial-suite.txt`; each is in whichever suite and
 * group it belongs to and keeps that group's skip rule.
 */
export function serialSuite(dir = sentinelDir()) {
  return readList(dir, 'serial-suite.txt', { allowEmpty: true });
}

/**
 * The unit-suite files allowed to start a Node.js process or a package manager: their launching cases skip on CI by
 * design (an opt-in, a container, a host check), so the zero-skip service job cannot hold them. From
 * `test/unit-launchers.txt`; a file there cannot also be in the process suite.
 */
export function unitLaunchers(dir = sentinelDir()) {
  const files = readList(dir, 'unit-launchers.txt', { allowEmpty: true });
  const both = files.filter((file) => processSuite(dir).includes(file));
  if (both.length) throw new Error(`unit-launchers.txt lists process-suite files: ${both.join(' ')}`);
  return files;
}

/** Every test file of a suite, as `test/<name>.test.ts`, in name order. */
export function suiteFiles(suite, dir = sentinelDir()) {
  if (!SUITES.includes(suite)) throw new Error(`Unknown suite ${JSON.stringify(suite)}: one of ${SUITES.join(', ')}`);
  const listed = processSuite(dir);
  const every = readdirSync(join(dir, 'test'))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `test/${name}`)
    .sort();
  if (suite === 'process') return listed;
  if (suite === 'all') return every;
  const noSkip = noSkipSuite(dir);
  if (suite === 'no-skip') return noSkip;
  // the no-skip group first, then the rest of the unit suite: the order --suite unit runs them in
  return [...noSkip, ...every.filter((file) => !listed.includes(file) && !noSkip.includes(file))];
}

/**
 * How a suite runs: its groups (for `unit`, the no-skip group with skips refused and then the rest; the process suite
 * refuses skips too, as its CI job does), each split into the files that run serially, at concurrency 1, and then the
 * rest at the configured concurrency.
 */
export function suiteGroups(suite, dir = sentinelDir()) {
  const noSkip = suite === 'unit' ? noSkipSuite(dir) : [];
  const groups =
    suite === 'unit'
      ? [
          { label: 'unit suite, no-skip files', files: noSkip, noSkips: true },
          { label: 'unit suite, the rest', files: suiteFiles('unit', dir).slice(noSkip.length), noSkips: false },
        ]
      : [
          {
            label: suite === 'no-skip' ? 'no-skip files' : `${suite} suite`,
            files: suiteFiles(suite, dir),
            noSkips: suite === 'no-skip' || suite === 'process',
          },
        ];
  const serial = serialSuite(dir);
  return groups.flatMap((group) => [
    { ...group, label: `${group.label}, serial`, files: group.files.filter((f) => serial.includes(f)), serial: true },
    { ...group, files: group.files.filter((f) => !serial.includes(f)), serial: false },
  ]);
}

const COUNTS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

/** The summary counts of a TAP report; a report missing any of them reads as unknown (null). */
export function tapCounts(tap) {
  const counts = {};
  for (const name of COUNTS) counts[name] = Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(tap)?.[1] ?? NaN);
  return Object.values(counts).every(Number.isInteger) ? counts : null;
}

/** The skipped and todo counts from a TAP report's summary, or null without one. */
export function tapSkips(tap) {
  const counts = tapCounts(tap);
  return counts ? { skipped: counts.skipped, todo: counts.todo } : null;
}

/** Several runs' summaries summed, in the TAP comment form a `grep -qx '# skipped 0'` check reads. */
export function summaryText(all) {
  return COUNTS.map((name) => `# ${name} ${all.reduce((sum, counts) => sum + counts[name], 0)}`).join('\n') + '\n';
}

/** The node arguments a suite runs with; `preload` is a module URL every test file's process imports first. */
export function nodeArgs(files, { concurrency = availableParallelism(), extra = [], preload } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`Bad concurrency ${concurrency}`);
  return [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    ...(preload ? ['--import', preload] : []),
    '--test',
    `--test-concurrency=${concurrency}`,
    ...extra,
    ...files,
  ];
}

// The preload --launches uses: wraps child_process in each test file's process and appends one line per start.
// The wrappers keep util.promisify's {stdout, stderr} form for execFile and exec.
const LAUNCH_HOOK = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { promisify } from 'node:util';
const cp = createRequire(import.meta.url)('node:child_process');
const log = process.env.SENTINEL_LAUNCH_LOG, file = process.argv[1] ?? '';
for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = cp[fn];
  const record = (command) => {
    try {
      const bin = fn === 'fork' ? process.execPath : String(command).trim().split(/\\s+/)[0];
      appendFileSync(log, file + '\\t' + (bin === process.execPath ? 'node' : bin.split('/').pop()) + '\\n');
    } catch {}
  };
  const wrapper = function (command, ...rest) {
    record(command);
    return original.call(this, command, ...rest);
  };
  const custom = original[promisify.custom];
  if (custom)
    Object.defineProperty(wrapper, promisify.custom, {
      value: function (command, ...rest) {
        record(command);
        return custom.call(this, command, ...rest);
      },
    });
  cp[fn] = wrapper;
}
syncBuiltinESMExports();
`;

/** The commands that count as starting a process for the suites: Node.js itself and the package managers. */
export const LAUNCHERS = new Set(['node', 'npm', 'npx', 'pnpm', 'tar']);

/**
 * From a `--launches` log (`<test file path>\t<command>` lines): for each test file, the number of starts that
 * count, by `test/<name>.test.ts`.
 */
export function launchCounts(log) {
  const counts = new Map();
  for (const line of log.split('\n')) {
    const [path, command] = line.split('\t');
    const name = /[\\/](test[\\/][^\\/]+\.test\.ts)$/.exec(path ?? '')?.[1]?.replace('\\', '/');
    if (name && LAUNCHERS.has(command)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

export function parseArgs(argv, env = process.env) {
  const options = {
    suite: env.SENTINEL_TEST_SUITE || 'all',
    concurrency: undefined,
    list: false,
    launches: Boolean(env.SENTINEL_TEST_LAUNCHES),
    summary: undefined,
    extra: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      options.extra = argv.slice(i + 1);
      break;
    } else if (arg === '--suite') options.suite = argv[++i];
    else if (arg === '--concurrency') options.concurrency = Number(argv[++i]);
    else if (arg === '--list') options.list = true;
    else if (arg === '--launches') options.launches = true;
    else if (arg === '--summary') options.summary = argv[++i];
    else throw new Error(`Unknown option ${JSON.stringify(arg)}`);
  }
  return options;
}

/** Prints which files started a Node.js process or a package manager, against the process list. */
/**
 * The launch rule over a `--launches` run: a unit-suite file may start a Node.js process or a package manager only
 * when `test/unit-launchers.txt` names it (its launching cases skip on CI, so the zero-skip service job cannot hold
 * it), and a process-suite file must start one. Returns the report lines and the violations.
 */
export function launchVerdict(counts, files, dir = sentinelDir()) {
  const listed = new Set(processSuite(dir));
  const allowed = new Set(unitLaunchers(dir));
  const unlisted = files.filter((file) => !listed.has(file) && !allowed.has(file) && counts.has(file));
  const idle = files.filter((file) => listed.has(file) && !counts.has(file));
  const lines = [`Node.js or package-manager starts, by file (${counts.size} of ${files.length} files started one):`];
  for (const file of files.filter((f) => counts.has(f)))
    lines.push(
      `  ${String(counts.get(file)).padStart(4)}  ${file}${allowed.has(file) ? '  (unit-launchers.txt)' : ''}`,
    );
  lines.push(
    `Unit files that started one, not in unit-launchers.txt (list them in process-suite.txt): ${unlisted.join(' ') || 'none'}`,
  );
  lines.push(`Process files that started none (move them to the unit suite): ${idle.join(' ') || 'none'}`);
  return { lines, unlisted, idle };
}

/** Prints the launch report and, after a passing run, refuses one that breaks the launch rule. Returns the status. */
function enforceLaunches(log, files, dir, status, { out, err }) {
  const verdict = launchVerdict(launchCounts(existsSync(log) ? readFileSync(log, 'utf8') : ''), files, dir);
  out(`\n${verdict.lines.join('\n')}`);
  // enforced only over a run that passed: a failing file can stop before it starts anything
  if (status !== 0 || (!verdict.unlisted.length && !verdict.idle.length)) return status;
  const prefix = process.env.GITHUB_ACTIONS ? '::error::' : 'sentinel-tests: ';
  err(`${prefix}the process suite is out of date: see the launch report above (scripts/sentinel-tests.mjs)`);
  return 1;
}

/** The refusal for a no-skip group whose TAP summary shows a skip (or has no summary), else null. */
function noSkipRefusal(counts, label) {
  if (counts && !counts.skipped && !counts.todo) return null;
  const what = counts ? `${counts.skipped} skipped, ${counts.todo} todo` : 'no TAP summary';
  const prefix = process.env.GITHUB_ACTIONS ? '::error::' : 'sentinel-tests: ';
  return `${prefix}the ${label} must not skip (no-skip-suite.txt): ${what}`;
}

/** Every run writes TAP beside the spec output; its summary says how many tests ran, failed and were skipped. */
const runReporters = (tap) => [
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=tap',
  `--test-reporter-destination=${tap}`,
];

/**
 * Runs a suite from packages/sentinel (or `dir`): each group in turn, a no-skip group failing on any skipped or todo
 * test, and with `launches` the report of which files started a Node.js process. Returns the exit status.
 */
export function runSuite(
  options,
  { dir = sentinelDir(), out = console.log, err = console.error, stdio = 'inherit' } = {},
) {
  const files = suiteFiles(options.suite, dir);
  const concurrency = options.concurrency ?? availableParallelism();
  const scratch = mkdtempSync(join(tmpdir(), 'sentinel-tests-'));
  const hook = join(scratch, 'hook.mjs');
  if (options.launches) writeFileSync(hook, LAUNCH_HOOK);
  const preload = options.launches ? pathToFileURL(hook).href : undefined;
  // NODE_TEST_CONTEXT would make the child runner report to a parent runner (when this runs inside node --test)
  const { NODE_TEST_CONTEXT: _parentRunner, ...inherited } = process.env;
  const env = { ...inherited, SENTINEL_LAUNCH_LOG: join(scratch, 'launches.tsv') };
  let status = 0;
  const summaries = [];
  try {
    for (const [index, group] of suiteGroups(options.suite, dir).entries()) {
      if (!group.files.length) continue;
      const tap = join(scratch, `run-${index}.tap`);
      const width = group.serial ? 1 : concurrency;
      const extra = [...runReporters(tap), ...(options.extra ?? [])];
      out(`Sentinel ${group.label}: ${group.files.length} files, --test-concurrency=${width}`);
      const run = spawnSync(process.execPath, nodeArgs(group.files, { concurrency: width, extra, preload }), {
        cwd: dir,
        stdio,
        env,
      });
      if (run.error) throw run.error;
      if (run.status !== 0) status ||= run.status ?? 1;
      const counts = tapCounts(existsSync(tap) ? readFileSync(tap, 'utf8') : '');
      if (counts) summaries.push(counts);
      else status ||= 1; // a run with no summary is not a pass
      const refusal = group.noSkips ? noSkipRefusal(counts, group.label) : null;
      if (refusal) {
        err(refusal);
        status ||= 1;
      }
    }
    if (options.summary) writeFileSync(options.summary, summaryText(summaries));
    if (options.launches) status = enforceLaunches(env.SENTINEL_LAUNCH_LOG, files, dir, status, { out, err });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.list) {
      console.log(suiteFiles(options.suite).join('\n'));
      process.exit(0);
    }
    suiteGroups(options.suite); // a bad list fails here, before anything runs
  } catch (error) {
    console.error(`sentinel-tests: ${error.message}`);
    process.exit(1);
  }
  process.exit(runSuite(options));
}

#!/usr/bin/env node
// Sentinel's test files in two suites. The process suite is the list in packages/sentinel/test/process-suite.txt:
// the files that start a Node.js process or a package manager (the CLI, the detached owner service, workers,
// scripts, a packed tarball), which the `sentinel-service` CI job runs on native amd64 as a non-root user with zero
// skips. The unit suite is every other `test/*.test.ts`, which validate runs. `all` is both in one run, which is what
// `pnpm -r test` does locally.
//
//   node scripts/sentinel-tests.mjs [--suite unit|process|all] [--concurrency N] [--list] [--launches]
//                                   [-- <node --test options>]
//
// The suite defaults to SENTINEL_TEST_SUITE, else `all`; concurrency to the machine's available parallelism. Files
// run from packages/sentinel. A listed file that does not exist, a duplicate, or a line that is not
// `test/<name>.test.ts` fails before anything runs, so a renamed file cannot drop out of the process suite unseen.
// `--launches` records every child process each test file's process starts (from the test or the code under test)
// and, after the run, names the unit files that started a Node.js process or a package manager and the process files
// that started none: how the list is kept honest.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SUITES = ['unit', 'process', 'all'];
const LISTED = /^test\/[a-z0-9][a-z0-9.-]*\.test\.ts$/;

export const sentinelDir = (root = fileURLToPath(new URL('..', import.meta.url))) => join(root, 'packages', 'sentinel');

/** The process suite's files, as `test/<name>.test.ts`, read and checked from `test/process-suite.txt`. */
export function processSuite(dir = sentinelDir()) {
  const text = readFileSync(join(dir, 'test', 'process-suite.txt'), 'utf8');
  const files = [];
  const problems = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const where = `process-suite.txt:${index + 1}`;
    if (!LISTED.test(line)) problems.push(`${where}: not a test/<name>.test.ts path: ${JSON.stringify(line)}`);
    else if (files.includes(line)) problems.push(`${where}: listed twice: ${line}`);
    else if (!existsSync(join(dir, line))) problems.push(`${where}: no such file: ${line}`);
    else files.push(line);
  }
  if (!files.length && !problems.length) problems.push('process-suite.txt lists no files');
  if (problems.length) throw new Error(problems.join('\n'));
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
  return every.filter((file) => !listed.includes(file));
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
    launches: false,
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
    else throw new Error(`Unknown option ${JSON.stringify(arg)}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options, files;
  try {
    options = parseArgs(process.argv.slice(2));
    files = suiteFiles(options.suite);
  } catch (error) {
    console.error(`sentinel-tests: ${error.message}`);
    process.exit(1);
  }
  if (options.list) {
    console.log(files.join('\n'));
    process.exit(0);
  }
  const concurrency = options.concurrency ?? availableParallelism();
  const record = options.launches ? mkdtempSync(join(tmpdir(), 'sentinel-launches-')) : null;
  if (record) writeFileSync(join(record, 'hook.mjs'), LAUNCH_HOOK);
  const preload = record ? pathToFileURL(join(record, 'hook.mjs')).href : undefined;
  const args = nodeArgs(files, { concurrency, extra: options.extra, preload });
  console.log(`Sentinel ${options.suite} suite: ${files.length} files, --test-concurrency=${concurrency}`);
  const env = record ? { ...process.env, SENTINEL_LAUNCH_LOG: join(record, 'launches.tsv') } : process.env;
  const run = spawnSync(process.execPath, args, { cwd: sentinelDir(), stdio: 'inherit', env });
  if (record) {
    const counts = launchCounts(
      existsSync(env.SENTINEL_LAUNCH_LOG) ? readFileSync(env.SENTINEL_LAUNCH_LOG, 'utf8') : '',
    );
    rmSync(record, { recursive: true, force: true });
    const listed = new Set(processSuite());
    const unlisted = files.filter((file) => !listed.has(file) && counts.has(file));
    const idle = files.filter((file) => listed.has(file) && !counts.has(file));
    console.log(`\nNode.js or package-manager starts, by file (${counts.size} of ${files.length} files started one):`);
    for (const file of files.filter((f) => counts.has(f)))
      console.log(`  ${String(counts.get(file)).padStart(4)}  ${file}`);
    console.log(`Unit files that started one (list them unless a case skips on CI): ${unlisted.join(' ') || 'none'}`);
    console.log(`Process files that started none (move them to the unit suite): ${idle.join(' ') || 'none'}`);
  }
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}

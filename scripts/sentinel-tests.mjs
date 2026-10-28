#!/usr/bin/env node
// Sentinel's test files in two suites. The process suite is the list in packages/sentinel/test/process-suite.txt:
// the files that spawn the CLI, the detached owner service and its sockets, which the `sentinel-service` CI job runs
// on native amd64 as a non-root user with zero skips. The unit suite is every other `test/*.test.ts`, which validate
// runs. `all` is both in one run, which is what `pnpm -r test` does locally.
//
//   node scripts/sentinel-tests.mjs [--suite unit|process|all] [--concurrency N] [--list] [-- <node --test options>]
//
// The suite defaults to SENTINEL_TEST_SUITE, else `all`; concurrency to the machine's available parallelism. Files
// run from packages/sentinel. A listed file that does not exist, a duplicate, or a line that is not
// `test/<name>.test.ts` fails before anything runs, so a renamed file cannot drop out of the process suite unseen.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
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

/** The node arguments a suite runs with. */
export function nodeArgs(files, { concurrency = availableParallelism(), extra = [] } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`Bad concurrency ${concurrency}`);
  return [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    '--test',
    `--test-concurrency=${concurrency}`,
    ...extra,
    ...files,
  ];
}

export function parseArgs(argv, env = process.env) {
  const options = { suite: env.SENTINEL_TEST_SUITE || 'all', concurrency: undefined, list: false, extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      options.extra = argv.slice(i + 1);
      break;
    } else if (arg === '--suite') options.suite = argv[++i];
    else if (arg === '--concurrency') options.concurrency = Number(argv[++i]);
    else if (arg === '--list') options.list = true;
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
  const args = nodeArgs(files, { concurrency, extra: options.extra });
  console.log(`Sentinel ${options.suite} suite: ${files.length} files, --test-concurrency=${concurrency}`);
  const run = spawnSync(process.execPath, args, { cwd: sentinelDir(), stdio: 'inherit' });
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}

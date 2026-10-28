#!/usr/bin/env node
// Sentinel's clean npm-only consumers, a few at a time, after one pack. Each consumer installs the packed
// farsight-sentinel tarball into its own scratch prefix (scripts/npm-consumer.mjs), so they share nothing but the
// tarball; they read a private copy of it, because the evidence consumer re-packs build/sentinel/ while it runs.
// Every line a consumer prints is prefixed with its name; a summary of each one's result and time ends the run.
//
//   node scripts/test-sentinel-consumers.mjs [--jobs N] [--only <name,…>] [--acceptance [-- <npm-acceptance options>]]
//
// `--jobs` is how many consumers run at once (default 3). `--acceptance` also runs the npm-only acceptance of both
// tarballs (scripts/npm-acceptance.mjs) beside them, on private copies of build/farsight-cli-<v>.tgz and the Sentinel
// tarball, with the expected versions and commit of this checkout; options after `--` are passed to it. Run after
// `pnpm pack:sentinel` (and `pnpm pack:cli` for the acceptance). Exits 1 when any task fails.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The consumer scripts, longest first so the last ones to start are short. */
export const CONSUMERS = [
  'test-sentinel-package',
  'test-sentinel-framework-consumer',
  'test-sentinel-evidence-consumer',
  'test-sentinel-mcp-consumer',
  'test-sentinel-decisions-consumer',
  'test-sentinel-preparation-consumer',
  'test-sentinel-mcp-controls-consumer',
  'test-sentinel-paths-consumer',
];

export function parseArgs(argv) {
  const options = { jobs: 3, only: null, acceptance: false, acceptanceArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      options.acceptanceArgs = argv.slice(i + 1);
      break;
    } else if (arg === '--jobs') options.jobs = Number(argv[++i]);
    else if (arg === '--only')
      options.only = String(argv[++i] ?? '')
        .split(',')
        .filter(Boolean);
    else if (arg === '--acceptance') options.acceptance = true;
    else throw new Error(`Unknown option ${JSON.stringify(arg)}`);
  }
  if (!Number.isInteger(options.jobs) || options.jobs < 1) throw new Error(`Bad --jobs ${options.jobs}`);
  for (const name of options.only ?? [])
    if (!CONSUMERS.includes(name)) throw new Error(`Unknown consumer ${JSON.stringify(name)}`);
  if (options.acceptanceArgs.length && !options.acceptance) throw new Error('Options after -- need --acceptance');
  return options;
}

const manifestVersion = (path) => JSON.parse(readFileSync(join(root, path), 'utf8')).version;

/** The tasks a run starts: each consumer on the Sentinel copy, and the acceptance when asked for. */
export async function plannedTasks(options, copies) {
  const tasks = (options.only ?? CONSUMERS).map((name) => ({
    name,
    args: [join(root, 'scripts', `${name}.mjs`), copies.sentinel],
    pooled: true,
  }));
  if (options.acceptance) {
    const { gitIdentity } = await import(pathToFileURL(join(root, 'packages/core/dist/version.js')).href);
    tasks.push({
      name: 'npm-acceptance',
      args: [
        join(root, 'scripts/npm-acceptance.mjs'),
        ...['--farsight', copies.farsight, '--expect-farsight', manifestVersion('package.json')],
        ...['--sentinel', copies.sentinel, '--expect-sentinel', manifestVersion('packages/sentinel/package.json')],
        ...['--expect-commit', gitIdentity(root).commit],
        ...options.acceptanceArgs,
      ],
      pooled: false, // beside the consumers, not in their pool
    });
  }
  return tasks;
}

function run(task, out) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, task.args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr])
      createInterface({ input: stream }).on('line', (line) => out(`[${task.name}] ${line}`));
    const finish = (status, signal) =>
      resolve({ name: task.name, status, signal, seconds: (Date.now() - started) / 1000 });
    child.on('error', (error) => {
      out(`[${task.name}] ${error.message}`);
      finish(1, null);
    });
    child.on('close', finish);
  });
}

/** Runs the tasks: pooled ones `jobs` at a time in order, the others at once beside them. */
export async function runTasks(tasks, { jobs, out = console.log }) {
  const pooled = tasks.filter((task) => task.pooled);
  const results = await Promise.all([
    ...tasks.filter((task) => !task.pooled).map((task) => run(task, out)),
    (async () => {
      const done = [];
      let next = 0;
      const lane = async () => {
        while (next < pooled.length) done.push(await run(pooled[next++], out));
      };
      await Promise.all(Array.from({ length: Math.min(jobs, pooled.length) }, lane));
      return done;
    })(),
  ]);
  const flat = results.flat();
  return tasks.map((task) => flat.find((result) => result.name === task.name));
}

function verdict({ status, signal }) {
  if (status === 0) return 'passed';
  return signal ? `stopped by ${signal}` : `failed (exit ${status})`;
}

export function summary(results) {
  const width = Math.max(...results.map((r) => r.name.length));
  return results
    .map((r) => `${r.name.padEnd(width)}  ${verdict(r).padEnd(18)} ${r.seconds.toFixed(0).padStart(5)} s`)
    .join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`test-sentinel-consumers: ${error.message}`);
    process.exit(1);
  }
  const sentinel = join(
    root,
    'build/sentinel',
    `farsight-sentinel-${manifestVersion('packages/sentinel/package.json')}.tgz`,
  );
  const farsight = join(root, 'build', `farsight-cli-${manifestVersion('package.json')}.tgz`);
  for (const [path, how] of [
    [sentinel, 'pnpm pack:sentinel'],
    ...(options.acceptance ? [[farsight, 'pnpm pack:cli']] : []),
  ])
    if (!existsSync(path)) {
      console.error(`test-sentinel-consumers: ${path} is missing; run ${how} first`);
      process.exit(1);
    }
  const scratch = mkdtempSync(join(tmpdir(), 'sentinel-consumers-'));
  // the copies keep the tarballs' own names, which carry the packaged versions the consumers check
  const copies = { sentinel: join(scratch, basename(sentinel)), farsight: join(scratch, basename(farsight)) };
  copyFileSync(sentinel, copies.sentinel);
  if (options.acceptance) copyFileSync(farsight, copies.farsight);
  let status;
  try {
    const tasks = await plannedTasks(options, copies);
    const started = Date.now();
    console.log(
      `Sentinel consumers: ${tasks.filter((t) => t.pooled).length} at most ${options.jobs} at a time` +
        (options.acceptance ? ', the npm acceptance beside them' : ''),
    );
    const results = await runTasks(tasks, { jobs: options.jobs });
    console.log(`\n${summary(results)}\nall tasks: ${((Date.now() - started) / 1000).toFixed(0)} s`);
    status = results.every((r) => r.status === 0) ? 0 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(status);
}

// scripts/test-sentinel-consumers.mjs: Sentinel's installed consumers a few at a time, the acceptance beside them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONSUMERS, parseArgs, plannedTasks, runTasks, summary } from '../test-sentinel-consumers.mjs';

const root = new URL('../../', import.meta.url);

test('the runner knows every installed consumer the package job ran in its chain, once each', () => {
  assert.deepEqual([...new Set(CONSUMERS)], CONSUMERS);
  assert.equal(CONSUMERS.length, 8);
  for (const name of CONSUMERS) {
    const source = readFileSync(new URL(`scripts/${name}.mjs`, root), 'utf8');
    // each one installs the tarball it is handed, so the runner's private copy is what it installs
    assert.match(source, /process\.argv\[2\]/, `${name} takes the tarball path as its argument`);
  }
  const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  assert.match(ci, /node scripts\/test-sentinel-consumers\.mjs --jobs 3 --acceptance -- --allow-pending --report/);
});

test('options: a pool size, a subset, and acceptance options only with --acceptance', () => {
  assert.deepEqual(parseArgs([]), { jobs: 3, only: null, acceptance: false, acceptanceArgs: [] });
  assert.deepEqual(parseArgs(['--jobs', '2', '--only', 'test-sentinel-mcp-consumer', '--acceptance', '--', '--x']), {
    jobs: 2,
    only: ['test-sentinel-mcp-consumer'],
    acceptance: true,
    acceptanceArgs: ['--x'],
  });
  assert.throws(() => parseArgs(['--jobs', '0']), /Bad --jobs/);
  assert.throws(() => parseArgs(['--only', 'test-sentinel-nope']), /Unknown consumer/);
  assert.throws(() => parseArgs(['--', '--allow-pending']), /need --acceptance/);
  assert.throws(() => parseArgs(['--parallel']), /Unknown option/);
});

test('every consumer installs the private copy; the acceptance takes both copies and this checkout', async () => {
  const copies = { sentinel: '/tmp/x/farsight-sentinel.tgz', farsight: '/tmp/x/farsight-cli.tgz' };
  const tasks = await plannedTasks(parseArgs(['--acceptance', '--', '--allow-pending']), copies);
  assert.deepEqual(
    tasks.map((t) => t.name),
    [...CONSUMERS, 'npm-acceptance'],
  );
  for (const task of tasks.slice(0, -1)) {
    assert.equal(task.args.at(-1), copies.sentinel, task.name);
    assert.equal(task.pooled, true);
  }
  const acceptance = tasks.at(-1);
  assert.equal(acceptance.pooled, false, 'beside the pool, not in it');
  const arg = (flag) => acceptance.args[acceptance.args.indexOf(flag) + 1];
  assert.equal(arg('--farsight'), copies.farsight);
  assert.equal(arg('--sentinel'), copies.sentinel);
  assert.equal(arg('--expect-farsight'), JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version);
  assert.equal(
    arg('--expect-sentinel'),
    JSON.parse(readFileSync(new URL('packages/sentinel/package.json', root), 'utf8')).version,
  );
  assert.match(arg('--expect-commit'), /^[0-9a-f]{7,40}/);
  assert.equal(acceptance.args.at(-1), '--allow-pending');
  assert.deepEqual(
    (await plannedTasks(parseArgs(['--only', 'test-sentinel-paths-consumer']), copies)).map((t) => t.name),
    ['test-sentinel-paths-consumer'],
  );
});

test('the pool runs at most --jobs at once, the others beside it, prefixes every line and keeps every result', async () => {
  const lines = [];
  const task = (name, ms, code = 0, pooled = true) => ({
    name,
    pooled,
    args: [
      '-e',
      `const t=Date.now();console.log('start '+t);setTimeout(()=>{console.log('end '+Date.now());process.exit(${code})},${ms});`,
    ],
  });
  const results = await runTasks(
    [task('a', 300), task('b', 300), task('c', 300, 3), task('d', 50), task('side', 600, 0, false)],
    { jobs: 2, out: (line) => lines.push(line) },
  );
  assert.deepEqual(
    results.map((r) => [r.name, r.status]),
    [
      ['a', 0],
      ['b', 0],
      ['c', 3],
      ['d', 0],
      ['side', 0],
    ],
  );
  for (const line of lines) assert.match(line, /^\[(a|b|c|d|side)\] (start|end) \d+$/);
  // never more than two pooled tasks at once; the one beside them overlaps the pool
  const spans = Object.fromEntries(
    ['a', 'b', 'c', 'd', 'side'].map((n) => {
      const at = (word) =>
        Number(
          lines
            .find((l) => l.startsWith(`[${n}] ${word}`))
            .split(' ')
            .at(-1),
        );
      return [n, [at('start'), at('end')]];
    }),
  );
  const pooled = ['a', 'b', 'c', 'd'];
  for (const n of pooled) {
    const [start] = spans[n];
    const running = pooled.filter((m) => spans[m][0] <= start && spans[m][1] > start);
    assert.ok(running.length <= 2, `${running.join(', ')} at once`);
  }
  assert.ok(spans.side[0] < spans.c[0], 'the side task started with the pool, not after it');
  const table = summary(results);
  assert.match(table, /^c\s+failed \(exit 3\)\s+\d+ s$/m);
  assert.match(table, /^side\s+passed\s+\d+ s$/m);
});

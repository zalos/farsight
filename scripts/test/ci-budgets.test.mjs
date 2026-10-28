// Every CI job's timeout is its budget: 1.5 x the target in docs/CI.md's "Job budgets" table, rounded up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/sentinel-scanner-cli.yml'];

/** A workflow's jobs as displayed (their `name:`, else their id) with their `timeout-minutes`. */
export function workflowJobs(text) {
  const jobs = [];
  let inJobs = false;
  for (const line of text.split('\n')) {
    if (/^jobs:\s*$/.test(line)) inJobs = true;
    else if (/^\S/.test(line)) inJobs = false;
    else if (inJobs && /^ {2}([A-Za-z0-9_-]+):\s*$/.test(line))
      jobs.push({ id: /^ {2}([A-Za-z0-9_-]+):/.exec(line)[1], name: null, timeout: null });
    else if (inJobs && jobs.length) {
      const job = jobs.at(-1);
      const name = /^ {4}name: (.+)$/.exec(line)?.[1];
      const timeout = /^ {4}timeout-minutes: (\d+)\s*$/.exec(line)?.[1];
      if (name && job.name === null) job.name = name.trim();
      if (timeout) job.timeout = Number(timeout);
    }
  }
  return jobs.map((job) => ({ ...job, name: job.name ?? job.id }));
}

/** The rows of docs/CI.md's "Job budgets" table: job, measured, target (minutes or null), timeout (minutes). */
export function budgetRows(markdown) {
  const section = markdown.slice(markdown.indexOf('### Job budgets'));
  const table = section.slice(0, section.indexOf('\n\n', section.indexOf('| job |')));
  return table
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| job |'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .map(([job, measured, target, timeout]) => ({
      job,
      measured,
      target: target === '—' ? null : Number(target),
      timeout: Number(timeout),
    }));
}

test('every job in ci.yml and the scanner workflow has a timeout and one budget row', () => {
  const rows = budgetRows(read('docs/CI.md'));
  assert.ok(rows.length >= 10, `${rows.length} budget rows`);
  const jobs = WORKFLOWS.flatMap((path) => workflowJobs(read(path)).map((job) => ({ ...job, path })));
  assert.deepEqual(
    jobs.map((job) => job.name).sort(),
    rows.map((row) => row.job).sort(),
    'the table lists exactly the jobs',
  );
  for (const job of jobs) {
    const row = rows.find((r) => r.job === job.name);
    assert.ok(Number.isInteger(job.timeout), `${job.path} ${job.id} has timeout-minutes`);
    assert.equal(job.timeout, row.timeout, `${job.name}: the workflow's timeout is the table's`);
  }
});

test("a budget row's timeout is 1.5 x its target, rounded up, and its measurement names the runs", () => {
  for (const row of budgetRows(read('docs/CI.md'))) {
    if (row.target !== null) {
      assert.ok(row.target > 0, row.job);
      assert.equal(row.timeout, Math.ceil(row.target * 1.5), `${row.job}: 1.5 x ${row.target} min`);
    }
    assert.match(row.measured, /\b\d{11}\b/, `${row.job} cites the run ids it was measured on`);
  }
  // the one row without a target: the secrets job, which the CI-speed lane leaves as it was
  assert.deepEqual(
    budgetRows(read('docs/CI.md'))
      .filter((row) => row.target === null)
      .map((row) => row.job),
    ['secrets'],
  );
});

test('the readers: job names and timeouts from a workflow, rows from a table', () => {
  const yaml = [
    'name: x',
    'jobs:',
    '  first:',
    '    name: first check',
    '    timeout-minutes: 4',
    '    steps:',
    '      - name: not a job name',
    '        timeout-minutes: 99',
    '  second:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 2',
  ].join('\n');
  assert.deepEqual(workflowJobs(yaml), [
    { id: 'first', name: 'first check', timeout: 4 },
    { id: 'second', name: 'second', timeout: 2 },
  ]);
  const md =
    '### Job budgets\n\ntext\n\n| job | measured | target (min) | timeout (min) |\n|---|---|---:|---:|\n' +
    '| a | 5 s (12345678901) | 2 | 3 |\n| b | 1 s (12345678901) | — | 10 |\n\nafter\n';
  assert.deepEqual(budgetRows(md), [
    { job: 'a', measured: '5 s (12345678901)', target: 2, timeout: 3 },
    { job: 'b', measured: '1 s (12345678901)', target: null, timeout: 10 },
  ]);
});

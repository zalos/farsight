import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { patternsTestText } from '@farsight/parsers';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const pattern = {
  id: 'route',
  files: ['*.ts'],
  match: { call: 'portal.$METHOD', args: { path: 0, handler: -1 } },
  emit: { kind: 'route', method: '$METHOD', path: '$path', handler: '$handler' },
};

test('patterns test shares the engine output, selects source and rule, and writes no graph or snapshot', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'patterns-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source);
  mkdirSync(join(root, '.farsight'));
  writeFileSync(
    join(source, 'app.ts'),
    `export function handle() {}\nportal.get('/known', handle);\nportal.post('/missing', missing);`,
  );
  const settings = JSON.stringify({
    sources: [{ id: 'source-id', name: 'app', type: 'local', path: 'source', config: { patterns: [pattern] } }],
  });
  writeFileSync(join(root, '.farsight/settings.json'), settings);
  const run = (args: string[]) =>
    spawnSync(process.execPath, [cli, 'patterns', 'test', ...args], { cwd: root, encoding: 'utf8' });
  const json = run(['--repo', 'source-id', '--rule', 'route', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const result = JSON.parse(json.stdout)[0];
  assert.equal(result.matches[0].name, 'POST /missing');
  assert.equal(result.matches.length, 2);
  const text = run(['--repo', 'app']);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout.trim(), patternsTestText(result));
  assert.deepEqual(JSON.parse(run(['--rule', 'no-rule', '--json']).stdout)[0].report.rules, []);
  assert.notEqual(run(['--repo', 'unknown']).status, 0);
  assert.deepEqual(readdirSync(join(root, '.farsight')), ['settings.json']);
  assert.deepEqual(readdirSync(root).sort(), ['.farsight', 'source']);
  assert.equal(readFileSync(join(root, '.farsight/settings.json'), 'utf8'), settings);
});

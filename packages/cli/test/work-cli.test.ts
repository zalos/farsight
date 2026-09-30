// `farsight work` driven the way a consumer drives it: the built dist/cli.js in a
// temp workspace whose settings name a copy of the recorded fixture source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repoRoot, 'packages/cli/dist/cli.js');
const ws = mkdtempSync(join(tmpdir(), 'work-cli-'));
cpSync(join(repoRoot, 'packages/work-fixture/fixtures/invoice-app'), join(ws, 'invoice-app'), { recursive: true });
mkdirSync(join(ws, '.farsight'));
writeFileSync(join(ws, '.farsight', 'settings.json'), JSON.stringify({
  sources: [{ id: 'invoice-jira', type: 'work', provider: 'fixture', path: 'invoice-app', scope: { projects: ['INV'] } }],
}));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'work', ...args], { cwd: ws, encoding: 'utf8' });

test('work sync → list → show → links on the fixture source', () => {
  const s1 = run('sync');
  assert.equal(s1.status, 0, s1.stderr);
  assert.match(s1.stdout, /in this sync: 8 items the tracker sent · 8 items changed · 0 items gone from the tracker/);
  assert.match(s1.stdout, /in this work source: 8 work items \(2 to do · 3 in progress · 3 done\)/);
  assert.equal(run('sync').status, 0);
  const l = run('list', '--state', 'done');
  assert.match(l.stdout, /read-only · synced/);
  assert.match(l.stdout, /INV-6 .*Done · done/);
  const doc = JSON.parse(run('list', '--json').stdout);
  assert.equal(doc.schema, 'farsight-work v1');
  assert.equal(doc.items.length, 9);
  const sh = run('show', 'INV-4');
  assert.match(sh.stdout, /on this item: 1 comment · 1 field change · 0 links to the graph/);
  assert.equal(JSON.parse(run('show', 'INV-2', '--json').stdout).key, 'INV-2');
  assert.match(run('links', 'INV-2').stdout, /parent → INV-1/);
  const miss = run('show', 'INV-99');
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /no work item INV-99/);
  assert.ok(readFileSync(join(ws, '.farsight', 'work.db')).length > 0);
});

test('work status and the write verbs print the three verdicts, the dry run and the outcome', () => {
  const ew = mkdtempSync(join(tmpdir(), 'work-cli-edit-'));
  cpSync(join(repoRoot, 'packages/work-fixture/fixtures/invoice-app'), join(ew, 'invoice-app'), { recursive: true });
  mkdirSync(join(ew, '.farsight'));
  writeFileSync(join(ew, '.farsight', 'settings.json'), JSON.stringify({
    sources: [{
      id: 'invoice-jira', type: 'work', provider: 'fixture', path: 'invoice-app', scope: { projects: ['INV'] }, mode: 'edit',
      permissions: { grants: [
        { actions: ['comment'], principals: ['human'] },
        { actions: ['transition'], to: ['in-progress', 'done'], principals: ['human'], confirm: 'always' },
      ] },
    }],
  }));
  const w = (...args: string[]) => spawnSync(process.execPath, [cli, 'work', ...args], { cwd: ew, encoding: 'utf8' });
  assert.equal(w('sync').status, 0);
  const st = w('status');
  assert.match(st.stdout, /invoice-jira · fixture · edit · synced/);
  assert.match(st.stdout, /conflicts found by revision · deletions seen · dry run before a write/);
  assert.match(st.stdout, /0 writes waiting for a person · 0 writes in conflict/);

  const c = w('comment', 'INV-5', 'on', 'it');
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /your policy: yes[\s\S]*the tracker: yes[\s\S]*the credential: yes[\s\S]*dry run: ok[\s\S]*written/);
  const m = w('move', 'INV-5', 'in-progress');
  assert.equal(m.status, 2);
  assert.match(m.stdout, /waiting for a person to confirm/);
  assert.match(w('status').stdout, /1 write waiting for a person/);
  const ok = w('move', 'INV-5', 'in-progress', '--confirm');
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(w('status').stdout, /0 writes waiting for a person/, 'confirming the waiting write confirms that intent');
  const no = w('assign', 'INV-5', 'none');
  assert.equal(no.status, 1);
  assert.match(no.stdout, /your policy: no — no grant allows assign[\s\S]*not asked[\s\S]*not written/);
  const tr = w('move', 'INV-8', 'in-progress', '--confirm');
  assert.equal(tr.status, 1);
  assert.match(tr.stdout, /the tracker: no — the workflow has no transition out of Done/);
  assert.match(w('show', 'INV-5').stdout, /In Progress · in progress/);
});

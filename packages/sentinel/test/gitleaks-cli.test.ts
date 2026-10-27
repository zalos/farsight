// Original inert synthetic values only. Failure messages never print a value, file name or raw scanner output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceOf } from '../dist/service/local.js';
import { loadPlan } from '../dist/execution/plans.js';
import { openStore } from '../dist/store/index.js';
import { openSnapshot } from '../dist/snapshot/materialize.js';
import { resolveWithheldLocation } from '../dist/snapshot/locations.js';
import { VALUE, GENERIC_VALUE, absent } from './secrets-helpers.ts';
import { unlock } from './snapshot-helpers.ts';
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const skip =
  process.env.SENTINEL_ISOLATION !== '1' && 'requires the existing pinned Gitleaks Linux image, never downloads';

test(
  'public Gitleaks CLI binds all captured file kinds, withheld locations, explicit omissions and retained reports',
  { skip },
  async (t) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-gitleaks-cli-')));
    t.after(() => {
      unlock(dir);
      rmSync(dir, { recursive: true, force: true });
    });
    const root = join(dir, 'workspace');
    mkdirSync(root);
    mkdirSync(join(root, 'skipped.png'));
    const files: Record<string, string> = {
      '.env': `token=${VALUE}\n`,
      'safe.txt': 'this contains no credential\n',
      'first.txt': `api_key = "${GENERIC_VALUE}"\n`,
      'second.txt': `api_key = "${GENERIC_VALUE}"\n`,
      [GENERIC_VALUE]: 'ordinary safe content\n',
      [VALUE]: `token=${VALUE}\n`,
      'skipped.png/file.env': `token=${VALUE}\n`,
    };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, XDG_STATE_HOME: join(dir, 'state') };
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, [CLI, ...args, '--json'], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: 8 << 20,
      });
      absent(r.stdout, 'public output', VALUE);
      absent(r.stdout, 'public output', GENERIC_VALUE);
      absent(r.stderr, 'public diagnostics', VALUE);
      absent(r.stderr, 'public diagnostics', GENERIC_VALUE);
      return { status: r.status, body: JSON.parse(r.stdout) };
    };
    assert.equal(cli('init', '--profile', 'secrets').status, 0);
    assert.equal(cli('settings', 'adopt', '--confirm').status, 0);
    assert.equal(cli('rules', 'promote', 'builtin:secrets', '--confirm').status, 0);
    const missing = cli('plan');
    assert.deepEqual([missing.status, missing.body.reasonCode], [3, 'sentinel.assets.missing']);
    assert.equal(cli('assets', 'adopt-tool', 'secrets-gitleaks', '--confirm').status, 0);
    const planned = cli('plan');
    assert.equal(planned.status, 0);
    assert.deepEqual(planned.body.facts.effects, ['local-artifacts', 'tool-execution']);
    const id = planned.body.facts.runId;
    const ran = cli('run', id, '--confirm');
    if (ran.status === 3) {
      const ws = workspaceOf(root, env);
      const st = await openStore(ws.storePath);
      try {
        const p = await loadPlan(st, id, st.ledger.getRun(id)!.planRevision);
        for (const u of p.plan.units)
          for (const a of st.ledger.listAttempts({ id: u.id, revision: u.revision })) {
            const v = st.ledger.getAttempt(a.id)!;
            t.diagnostic(
              JSON.stringify({ code: v.envelope.error?.code, detail: v.errorDetail })
                .replaceAll(VALUE, '[withheld]')
                .replaceAll(GENERIC_VALUE, '[withheld]'),
            );
          }
      } finally {
        st.close();
      }
    }
    assert.equal(ran.status, 2, JSON.stringify(ran.body));
    assert.equal(ran.body.facts.state, 'completed');
    assert.ok(ran.body.facts.observations >= 4);
    const report = cli('report', id).body.facts.report;
    const observations = report.observations.filter((o: any) => o.value.adapter === 'secrets-gitleaks');
    const scan = report.reports.find((r: any) => r.value.adapter === 'secrets-gitleaks').value;
    assert.equal(scan.status, 'partial');
    assert.ok(scan.skipped.some((r: any) => r.reasonCode === 'sentinel.secrets.toolAllowlisted'));
    assert.ok(scan.scanned.every((s: string) => /^workspace#entry:\d+$/.test(s)));
    const ws = workspaceOf(root, env);
    const store = await openStore(ws.storePath);
    try {
      const snapshot = (await openSnapshot(store, report.snapshotId)).snapshot;
      const duplicates = new Set<number>();
      for (const row of observations) {
        const observation = row.value;
        assert.ok(observation.evidence.every((e: any) => e.location === 'withheld' && !('relativePath' in e)));
        for (const evidence of observation.evidence) {
          const location = resolveWithheldLocation(snapshot, evidence);
          assert.equal(location.ok, true);
          if (location.ok && ['first.txt', 'second.txt'].includes(location.entry.relativePath))
            duplicates.add(evidence.entry);
        }
      }
      assert.equal(duplicates.size, 2, 'identical bytes still cite two distinct capture entries');
      const database = new DatabaseSync(join(ws.storePath, 'ledger.sqlite'), { readOnly: true });
      try {
        let privateJobs = 0;
        for (const row of database.prepare('SELECT id, privacy_floor FROM artifacts').all()) {
          const bytes = await store.readArtifact(String(row.id));
          if (row.privacy_floor === 'metadata') {
            absent(bytes, 'redacted metadata projection', VALUE);
            absent(bytes, 'redacted metadata projection', GENERIC_VALUE);
          }
          if (bytes.includes(Buffer.from(GENERIC_VALUE))) {
            assert.notEqual(
              row.privacy_floor,
              'metadata',
              'captured names and source-derived jobs cannot enter a redacted bundle',
            );
            privateJobs++;
          }
        }
        assert.ok(privateJobs > 0, 'the private exact-source provenance remains retained');
      } finally {
        database.close();
      }
    } finally {
      store.close();
    }
    for (const path of Object.keys(files)) rmSync(join(root, path));
    const regenerated = cli('report', id).body.facts.report;
    assert.deepEqual(regenerated.observations, report.observations);
    assert.deepEqual(regenerated.coverage, report.coverage);
  },
);

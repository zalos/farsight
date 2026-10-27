// The full report over a real Gitleaks run: a genuine owner-adopted workspace, an admitted canonical plan, the pinned
// official image in its Linux container (existing locally, never pulled), the coordinator's own accepted publication.
// Faults are injected only at the trusted driver's normalize output, after the real engine ran, never by fabricating
// a publication, store capability or receipt. Original inert synthetic values only; no assertion message prints one.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../dist/store/index.js';
import { workspaceOf, adoptedPolicy, adoptWorkspaceSettings, promoteRulePack } from '../dist/service/local.js';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { initWorkspace } from '../dist/cli/init.js';
import { planWorkspaceCanonical } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { publicRegistry, scannerExecution } from '../dist/service/scanner-profile.js';
import { adoptScannerAsset } from '../dist/service/scanner-assets.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { createCheckDriverRegistry } from '../dist/execution/check-drivers.js';
import { VALUE, GENERIC_VALUE } from './secrets-helpers.ts';
import { unlock } from './snapshot-helpers.ts';

// Native evidence fixtures run only in the explicitly opted-in scanner job. Pure projection tests stay ungated.
export const nativeSecrets = {
  skip: process.env.SENTINEL_ISOLATION !== '1' && 'requires the existing pinned local Gitleaks image; no acquisition',
};
const DUPLICATE = `api_key = "${GENERIC_VALUE}"\n`;

export async function publishedSecrets(t: any, mode: string, extra: Record<string, string> = {}) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-report-secrets-')));
  const path = join(dir, 'workspace');
  mkdirSync(join(path, 'config'), { recursive: true });
  const files: Record<string, string> = {
    'config/service.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`,
    // Identical bytes in two files: two locations, never one finding.
    'first.txt': DUPLICATE,
    'second.txt': DUPLICATE,
    // A file whose name is the secret: matched by name, and its name never printed.
    [VALUE]: 'ordinary safe content\n',
    'clean.txt': 'nothing secret here\n',
    ...extra,
  };
  for (const [p, text] of Object.entries(files)) writeFileSync(join(path, p), text);
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  initWorkspace({ workspace: path, profile: 'secrets' });
  assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now: new Date() }).outcome, 'prepared');
  assert.equal(
    promoteRulePack(ws, { packDir: realpathSync.native(builtinPackDir('secrets')!), confirm: true, now: new Date() })
      .outcome,
    'prepared',
  );
  assert.equal(
    (await adoptScannerAsset(ws, { kind: 'tool', id: 'secrets-gitleaks', confirm: true, now: new Date() })).outcome,
    'prepared',
  );
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* closed */
    }
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  const work = scratchUnder(store);
  t.after(() => removeScratch(work));
  const prepared = await planWorkspaceCanonical(store, {
    workspace: path,
    trustDir: ws.trustDir,
    policy: adopted.policy,
    scratchRoot: work,
    now: new Date(),
  });
  const runId = prepared.disclosure.runId;
  const registry = publicRegistry();
  const assets = await scannerExecution(store, runId, ws.trustDir, work, registry);
  const driver = assets.drivers.driverFor('secrets-gitleaks')!;
  assert.ok(driver, 'the shipped Gitleaks driver');
  let changed = 0;
  const drivers = createCheckDriverRegistry(
    [
      {
        ...driver,
        async normalize(ctx: any, v: any) {
          const normalized = await driver.normalize(ctx, v);
          let records = normalized.records;
          const findings = records.filter((r: any) => r.schema === 'sentinel-driver-finding/draft-1');
          assert.ok(findings.length >= 3, 'the real engine found the synthetic secrets before any fault');
          if (mode === 'drop') {
            records = records.filter((r: any) => r !== findings[0]);
            changed++;
          } else if (
            [
              'extra',
              'no-summary',
              'double-summary',
              'count-low',
              'count-high',
              'count-type',
              'count-fraction',
              'count-run',
              'count-work',
              'count-attempt',
            ].includes(mode)
          ) {
            const summary = records.find((r: any) => r.schema === 'sentinel-driver-report/draft-1')!;
            if (mode === 'extra') {
              const f: any = structuredClone(findings[0]);
              f.value.id += '-extra';
              records = [...records, f];
            } else if (mode === 'no-summary') records = records.filter((r: any) => r !== summary);
            else if (mode === 'double-summary') {
              const s: any = structuredClone(summary);
              s.value.extra = 'different';
              records = [...records, s];
            } else
              records = records.map((r: any) => {
                if (r !== summary) return r;
                const x: any = structuredClone(r);
                if (mode === 'count-low') x.value.findings--;
                if (mode === 'count-high') x.value.findings++;
                if (mode === 'count-type') x.value.findings = String(x.value.findings);
                if (mode === 'count-fraction') x.value.findings += 0.5;
                if (mode === 'count-run') x.value.runId = 'run-foreign';
                if (mode === 'count-work') x.value.work.revision++;
                if (mode === 'count-attempt') x.value.attemptId = 'attempt-foreign';
                return x;
              });
            changed++;
          } else if (mode !== 'positive') {
            records = records.map((r: any) => {
              if (r !== findings[0]) return r;
              const f: any = structuredClone(r.value);
              const e = f.evidence[0];
              if (mode === 'entry') e.entry = ctx.plan.pins && 0 === e.entry ? 1 : 0;
              else if (mode === 'path') e.relativePath = 'first.txt';
              else if (mode === 'message') f.message = `the value is ${VALUE}`;
              else if (mode === 'kind') f.kind = 'pattern';
              else if (mode === 'checks') f.assignedChecks = [];
              else if (mode === 'producer') f.producer.adapterId = 'pattern-semgrep';
              else if (mode === 'detector') f.producerRuleId = 'made-up-detector';
              else if (mode === 'attempt') f.attemptId = 'attempt-elsewhere';
              else if (mode === 'snapshot') e.snapshotId = 'snap-elsewhere';
              else if (mode === 'span') e.span.endByte = 999999;
              else if (mode === 'rule')
                f.rule = { familyId: 'sentinel.secrets.other', revisionDigest: `sha256:${'0'.repeat(64)}` };
              else throw new Error(`unknown mode ${mode}`);
              changed++;
              return { ...r, value: f };
            });
          }
          return { ...normalized, records };
        },
      },
    ],
    registry,
  );
  const done = await (await Coordinator.open({ ...assets, drivers, store, runId, registry, scratchRoot: work })).run();
  assert.equal(done.state, 'completed');
  assert.ok(mode === 'positive' || changed > 0);
  return { dir, path, ws, store, runId, files, work, policy: adopted.policy };
}

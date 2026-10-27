// Genuine pinned native scanner evidence followed by the public retained owner workflow. A matched ancestor
// donates privacy knowledge only, never findings, observations or security coverage to a structural child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathOwnerFixture } from './path-owner-helpers.ts';
import { PATHS_APP } from './paths-fixtures.ts';
import { GENERIC_VALUE, absent } from './secrets-helpers.ts';
import { nativeSecrets } from './sol-report-helpers.ts';
import {
  followWorkspaceRun,
  runPlan,
  fullReportIn,
  previewReport,
  prepareWorkspacePaths,
  adoptedPolicy,
} from '../dist/service/local.js';
import { openStore } from '../dist/store/index.js';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { planWorkspaceCanonical, executeRun } from '../dist/service/canonical.js';
import { loadPlan, admitPlan } from '../dist/execution/plans.js';
import { retainedBootstrapForReport } from '../dist/execution/retained-bootstrap.js';
import { RuleLockBook } from '../dist/service/rule-locks.js';
import { publicProfile, publicRegistry } from '../dist/service/scanner-profile.js';
import {
  planAnalysis,
  plannerAnalysisFrom,
  plannerLockFrom,
  plannerPolicyFrom,
  plannerSnapshotFrom,
} from '../dist/planner/index.js';
const files = {
  ...PATHS_APP,
  '.env': `api_key = "${GENERIC_VALUE}"\n`,
  [`src/${GENERIC_VALUE}.ts`]:
    "import {getUser} from './routes.js';export function start(){return getUser({query:{id:'original'}})}\n",
};
async function report(f: any, id: string, baselineRunId?: string) {
  const minimal: any = await previewReport(f.ws, { runId: id, now: new Date() });
  absent(JSON.stringify(minimal), 'minimal retained paths', GENERIC_VALUE);
  for (const disclosure of ['private', 'shareable'] as const)
    for (const format of ['json', 'md', 'html', 'sarif'] as const) {
      const out = await fullReportIn(f.ws, {
        runId: id,
        baselineRunId,
        disclosure,
        format,
        confirm: false,
        now: new Date(),
      });
      assert.ok(out.text, JSON.stringify(out.result));
      absent(out.text, 'retained paths ' + format, GENERIC_VALUE);
      if (format === 'json') {
        const doc = JSON.parse(out.text);
        assert.equal(doc.findings.length, 0);
        assert.ok(doc.gaps.length);
        assert.equal(doc.structuralPaths.length, 1);
        assert.ok(doc.structuralPaths[0].detailLoss);
        assert.ok(
          doc.structuralPaths[0].evidence.results.every((r: any) =>
            r.paths.every((p: any) => p.steps.every((s: any) => s.sites.length === 0)),
          ),
        );
        assert.match(doc.structuralPaths[0].evidence.results[0].from, /^withheld-/);
      }
    }
}
for (const canceled of [false, true])
  test(
    `native paths privacy authenticates ${canceled ? 'canceled request' : 'selected grandchild request'} ancestry and baseline without inheriting security results`,
    nativeSecrets,
    async (t) => {
      const f = await pathOwnerFixture(t, { files, secrets: true, canceled });
      let anchor = f.plan.plan;
      if (!canceled) {
        for (let i = 0; i < 2; i++) {
          const secret = anchor.units.find((u: any) => u.adapterId === 'secrets-gitleaks');
          assert.ok(secret);
          const child: any = await followWorkspaceRun(f.ws, {
            mode: 'rerun',
            runId: anchor.runId,
            stages: [secret.id],
            confirm: true,
            now: new Date(),
          });
          assert.equal(child.outcome, 'prepared', JSON.stringify(child));
          assert.equal(
            (await runPlan(f.ws, { planId: child.facts.runId, confirm: true, now: new Date() })).facts.state,
            'completed',
          );
          const store = await openStore(f.ws.storePath);
          try {
            anchor = (await loadPlan(store, child.facts.runId, child.facts.revision)).plan;
          } finally {
            store.close();
          }
        }
      }
      f.request.ancestor = { runId: anchor.runId, revision: anchor.revision, planDigest: anchor.digest };
      f.request.queries = [{ from: `workspace::src/${GENERIC_VALUE}.ts::start`, to: 'workspace::src/db.ts::query' }];
      writeFileSync(f.requestFile, JSON.stringify(f.request), { mode: 0o600 });
      const waiting: any = await f.call();
      assert.equal(waiting.exitCode, 4);
      absent(JSON.stringify(waiting), 'owner preparation disclosure', GENERIC_VALUE);
      const child: any = await f.call(true);
      assert.equal(child.outcome, 'prepared', JSON.stringify(child));
      assert.equal(
        (await runPlan(f.ws, { planId: child.facts.runId, confirm: true, now: new Date() })).facts.state,
        'completed',
      );
      await report(f, child.facts.runId);
      const selected: any = await followWorkspaceRun(f.ws, {
        mode: 'rerun',
        runId: child.facts.runId,
        stages: child.facts.unitIds,
        confirm: true,
        now: new Date(),
      });
      assert.equal(selected.outcome, 'prepared', JSON.stringify(selected));
      assert.equal(
        (await runPlan(f.ws, { planId: selected.facts.runId, confirm: true, now: new Date() })).facts.state,
        'completed',
      );
      await report(f, selected.facts.runId, child.facts.runId);
      // A merely admitted future ancestor must not replace its actual executed revision or erase accepted privacy.
      let store = await openStore(f.ws.storePath),
        work = scratchUnder(store);
      try {
        const ancestor = await loadPlan(store, anchor.runId, anchor.revision),
          evidence = await retainedBootstrapForReport(store, anchor.runId, ancestor),
          book = new RuleLockBook(f.ws.trustDir),
          current = book.current()!,
          packs = book.packsOf(current.lock),
          policy = adoptedPolicy(f.ws);
        assert.ok('policy' in policy);
        const profile = publicProfile(
          publicRegistry(f.ws.trustDir),
          new Set(['secrets-gitleaks', 'bounded-paths']),
          packs,
        );
        const future = planAnalysis({
          runId: anchor.runId,
          revision: anchor.revision + 1,
          previous: anchor,
          bootstrap: anchor.reused,
          profile: profile.planner,
          snapshot: plannerSnapshotFrom(evidence.snapshot),
          analyses: evidence.analyses.map((a) => plannerAnalysisFrom(a)),
          lock: plannerLockFrom(current.lock, packs, current.digest),
          policy: plannerPolicyFrom(policy.policy),
          limits: { maxScopesPerWork: 32 },
        });
        await admitPlan(store, {
          plan: future,
          ruleLock: current.lock,
          policy: policy.policy,
          profile: profile.record,
        });
        assert.equal(store.ledger.getRun(anchor.runId).planRevision, anchor.revision);
        assert.equal(store.ledger.latestPlan(anchor.runId).revision, future.revision);
      } finally {
        removeScratch(work);
        store.close();
      }
      await report(f, selected.facts.runId);
      // A clean current capture is useful by itself; comparison with the secret path baseline withholds details.
      mkdirSync(join(f.path, 'src'));
      for (const [path, text] of Object.entries(PATHS_APP)) writeFileSync(join(f.path, path), text);
      writeFileSync(join(f.path, '.env'), 'EXAMPLE_SETTING=public\n');
      const policy = adoptedPolicy(f.ws);
      assert.ok('policy' in policy);
      store = await openStore(f.ws.storePath);
      work = scratchUnder(store);
      let clean: any;
      try {
        clean = await planWorkspaceCanonical(store, {
          workspace: f.path,
          trustDir: f.ws.trustDir,
          policy: policy.policy,
          scratchRoot: work,
          now: new Date(),
        });
        assert.equal(
          (await executeRun(store, clean.disclosure.runId, { scratchRoot: work, trustDir: f.ws.trustDir })).state,
          'completed',
        );
      } finally {
        removeScratch(work);
        store.close();
      }
      const request = {
        ...f.request,
        ancestor: {
          runId: clean.disclosure.runId,
          revision: clean.disclosure.revision,
          planDigest: clean.disclosure.planDigest,
        },
        snapshotId: clean.disclosure.snapshotId,
        queries: [{ from: 'workspace::src/routes.ts::getUser', to: 'workspace::src/db.ts::query' }],
      };
      writeFileSync(f.requestFile, JSON.stringify(request));
      const cleanChild: any = await prepareWorkspacePaths(f.ws, {
        ancestorRunId: request.ancestor.runId,
        requestFile: f.requestFile,
        confirm: true,
        now: new Date(),
      });
      assert.equal(cleanChild.outcome, 'prepared', JSON.stringify(cleanChild));
      assert.equal(
        (await runPlan(f.ws, { planId: cleanChild.facts.runId, confirm: true, now: new Date() })).facts.state,
        'completed',
      );
      const plain: any = await previewReport(f.ws, { runId: cleanChild.facts.runId, now: new Date() });
      assert.equal(plain.structuralPaths[0].detailLoss, undefined);
      assert.equal(plain.structuralPaths[0].evidence.results[0].from, request.queries[0].from);
      await report(f, cleanChild.facts.runId, selected.facts.runId);
    },
  );

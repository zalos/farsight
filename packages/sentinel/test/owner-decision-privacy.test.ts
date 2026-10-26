// Actual pinned Gitleaks publications; decision text is never accepted as scanner authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { objectRelPath } from '../dist/store/objects.js';
import { ownerFixture, input } from './owner-decision-helpers.ts';
import { VALUE, GENERIC_VALUE, absent } from './secrets-helpers.ts';
import { adoptedPolicy } from '../dist/service/local.js';
import { planWorkspaceCanonical, executeRun, rerunRun } from '../dist/service/canonical.js';
import { loadPlan } from '../dist/execution/plans.js';
import { assessRun, fullReport } from '../dist/service/full-report.js';
import { findingsOf } from '../dist/reports/document.js';
import { GITLEAKS_SUPPORTED_RULES } from '../dist/adapters/drivers/index.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { scannerExecution, publicRegistry } from '../dist/service/scanner-profile.js';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
const native = {
  skip: process.env.SENTINEL_ISOLATION !== '1' && 'requires the existing pinned local Gitleaks image; no acquisition',
  timeout: 240000,
};
for (const secret of [true, false])
  test(
    `genuine ${secret ? 'secret' : 'clean'} accepted decisions preserve current baseline and canceled selected privacy`,
    native,
    async (t) => {
      const s = await ownerFixture(t),
        clean = s.runId;
      s.store.close();
      const configPath = join(s.path, '.farsight/sentinel/settings.json'),
        config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.mandatoryRules = [
        'sentinel.preview.sql-string-concat',
        ...GITLEAKS_SUPPORTED_RULES.map((r) => r.familyId),
      ];
      writeFileSync(configPath, JSON.stringify(config));
      assert.equal(s.command('settings', 'adopt', '--confirm').status, 0);
      assert.equal(s.command('rules', 'promote', 'builtin:secrets', '--confirm').status, 0);
      assert.equal(s.command('assets', 'adopt-tool', 'secrets-gitleaks', '--confirm').status, 0);
      const source = `export const lookup = (id) => db.query("SELECT * FROM invoice WHERE ${secret ? `api_key = '${GENERIC_VALUE}' AND ` : ''}id = " + id);\n`;
      writeFileSync(join(s.path, 'src/lookup.ts'), source);
      writeFileSync(join(s.path, 'src', secret ? VALUE + '.ts' : 'named.ts'), 'export const named = 1;\n');
      await s.reopen();
      let scratch = scratchUnder(s.store);
      const release = () => removeScratch(scratch);
      t.after(() => {
        if (s.store.held) release();
      });
      const policy = adoptedPolicy(s.ws);
      assert.ok('policy' in policy);
      const terms = () => ({
        workspace: s.path,
        trustDir: s.ws.trustDir,
        policy: policy.policy,
        scratchRoot: scratch,
        now: new Date(),
      });
      const parent = (await planWorkspaceCanonical(s.store, terms())).disclosure.runId;
      assert.equal(
        (await executeRun(s.store, parent, { scratchRoot: scratch, trustDir: s.ws.trustDir })).state,
        'completed',
      );
      const actual = await assessRun(s.store, parent, { trustDir: s.ws.trustDir });
      assert.equal(
        actual.observations.some((o) => o.producer.kind === 'scanner' && o.producer.adapterId === 'secrets-gitleaks'),
        secret,
      );
      async function fid(run: string) {
        const a = await assessRun(s.store, run, { trustDir: s.ws.trustDir });
        const f = await findingsOf(a.observations, (id) => s.store.readArtifact(id), { withheldKey: a.withheldKey });
        const selected = f.find((x) => x.ruleFamilyId === 'sentinel.preview.sql-string-concat');
        assert.ok(selected);
        return selected.id;
      }
      const parentFinding = await fid(parent),
        parentPlan = (await loadPlan(s.store, parent)).plan;
      const child = (
        await rerunRun(
          s.store,
          parent,
          [
            parentPlan.units.find(
              (u) =>
                u.adapterId === 'sentinel.preview.detector' && u.inputs.some((i) => i.relativePath === 'src/lookup.ts'),
            )!.id,
          ],
          terms(),
        )
      ).disclosure.runId;
      assert.equal(
        (await executeRun(s.store, child, { scratchRoot: scratch, trustDir: s.ws.trustDir })).state,
        'completed',
      );
      const childFinding = await fid(child);
      // A new real parent is canceled only after its genuine Gitleaks publication, then selected execution holds that scan.
      writeFileSync(join(s.path, 'src/lookup.ts'), source + '// distinct canceled capture\n');
      const canceled = (await planWorkspaceCanonical(s.store, terms())).disclosure.runId,
        cp = (await loadPlan(s.store, canceled)).plan,
        scan = cp.units.find((u) => u.adapterId === 'secrets-gitleaks')!;
      const registry = publicRegistry(),
        coordinator = await Coordinator.open({
          ...(await scannerExecution(s.store, canceled, s.ws.trustDir, scratch, registry)),
          store: s.store,
          runId: canceled,
          registry,
          scratchRoot: scratch,
          hooks: {
            at(boundary, ctx) {
              if (boundary === 'after-publish' && ctx.work.id === scan.id) coordinator.cancel();
            },
          },
        });
      assert.equal((await coordinator.run()).state, 'canceled');
      assert.ok(s.store.ledger.getPublication(scan));
      const canceledChild = (
        await rerunRun(
          s.store,
          canceled,
          [
            cp.units.find(
              (u) =>
                u.adapterId === 'sentinel.preview.detector' && u.inputs.some((i) => i.relativePath === 'src/lookup.ts'),
            )!.id,
          ],
          terms(),
        )
      ).disclosure.runId;
      rmSync(join(s.path, 'src'), { recursive: true });
      assert.equal(
        (await executeRun(s.store, canceledChild, { scratchRoot: scratch, trustDir: s.ws.trustDir })).state,
        'completed',
      );
      const canceledFinding = await fid(canceledChild);
      release();
      s.store.close();
      const rationale = secret ? VALUE + ' ' + GENERIC_VALUE : 'Original useful owner rationale';
      const file = join(s.root, 'owner-input.json');
      let previous: string | null = null,
        previousFinding = '';
      const decisions = new Map<string, string>();
      for (const [run, finding, withheld] of [
        [clean, s.finding.id, false],
        [parent, parentFinding, secret],
        [child, childFinding, secret],
        [canceledChild, canceledFinding, secret],
      ] as const) {
        writeFileSync(
          file,
          JSON.stringify(
            input('accepted-risk', { rationale, supersedes: finding === previousFinding ? previous : null }),
          ),
        );
        const proposed = s.command('decision', 'propose', run, '--finding', finding, '--proposal', file);
        assert.equal(proposed.value.outcome, 'proposed');
        const id = proposed.value.facts.decisionId;
        decisions.set(run, id);
        assert.equal(s.command('decision', 'approve', id).status, 4);
        const approved = s.command('decision', 'approve', id, '--confirm');
        assert.equal(approved.value.outcome, 'applied');
        for (const view of [proposed, approved, s.command('decision', 'read', id)]) {
          assert.equal(view.value.facts.document.withheld, withheld);
          assert.equal(view.value.facts.document.decision.rationale === null, withheld);
          if (withheld) {
            absent(view.stdout, 'public decision acknowledgement', VALUE);
            absent(view.stdout, 'public decision acknowledgement', GENERIC_VALUE);
          }
        }
        const list = s.command('decision', 'list', run);
        assert.equal(list.status, 0);
        absent(list.stdout, 'metadata-only decision page', VALUE);
        absent(list.stdout, 'metadata-only decision page', GENERIC_VALUE);
        if (run === clean) {
          const baseline = s.command('decision', 'read', id, '--baseline', parent);
          assert.equal(baseline.value.facts.document.withheld, secret);
          assert.equal(baseline.value.facts.document.decision.rationale === null, secret);
          if (secret) absent(baseline.stdout, 'explicit baseline decision', GENERIC_VALUE);
        }
        await s.reopen();
        scratch = scratchUnder(s.store);
        for (const disclosure of ['private', 'shareable'] as const) {
          const r = await fullReport({
            store: s.store,
            workspace: s.path,
            trustDir: s.ws.trustDir,
            runId: run,
            disclosure,
            now: new Date(),
            ...(run === clean ? { baselineRunId: parent } : {}),
          });
          for (const text of [r.json, r.markdown, r.html, JSON.stringify(r.sarif)]) {
            absent(text, 'current/baseline/selected decision report', VALUE);
            absent(text, 'current/baseline/selected decision report', GENERIC_VALUE);
          }
          if (!secret)
            assert.equal(
              r.json.includes(rationale),
              disclosure === 'private',
              'only private reports retain owner rationale',
            );
        }
        release();
        s.store.close();
        previous = id;
        previousFinding = finding;
      }
      await s.reopen();
      scratch = scratchUnder(s.store);
      const containers = new Set<string>();
      for (const run of [parent, child, canceled, canceledChild])
        for (const u of (await loadPlan(s.store, run)).plan.units) {
          const pub = s.store.ledger.getPublication(u),
            a = pub && s.store.ledger.getAttempt(pub.attemptId);
          if (a?.envelope.worker?.kind === 'owned-container') {
            assert.equal(a.envelope.worker.ownershipLabels.store, s.store.storeId);
            containers.add(a.envelope.worker.containerId);
          }
        }
      for (const id of containers) {
        const listed = spawnSync(
          'docker',
          ['container', 'ls', '--all', '--no-trunc', '--filter', 'id=' + id, '--format', '{{.ID}}'],
          { encoding: 'utf8', timeout: 10000 },
        );
        assert.equal(listed.status, 0);
        assert.equal(listed.stdout.trim(), '');
      }
      // Damage an actually accepted invocation. The caller cannot make its observation label count as privacy authority.
      const accepted = s.store.ledger.getPublication(
          parentPlan.units.find((u) => u.adapterId === 'secrets-gitleaks')!,
        )!,
        invocation = s.store.ledger.getAttempt(accepted.attemptId)!.envelope.invocation!;
      const copies = s.store.ledger.objectsOf(invocation).map((o) => ({
        path: join(s.ws.storePath, objectRelPath(invocation.slice(7), o.codec)),
        bytes: readFileSync(join(s.ws.storePath, objectRelPath(invocation.slice(7), o.codec))),
      }));
      assert.ok(copies.length);
      for (const copy of copies) unlinkSync(copy.path);
      release();
      s.store.close();
      try {
        const refused = s.command('decision', 'read', decisions.get(clean)!, '--baseline', parent);
        assert.equal(refused.value.outcome, 'refused');
        assert.equal(refused.value.facts.document, undefined);
        absent(refused.stdout, 'unproven privacy refusal', VALUE);
        absent(refused.stdout, 'unproven privacy refusal', GENERIC_VALUE);
      } finally {
        for (const copy of copies) writeFileSync(copy.path, copy.bytes, { mode: 0o400 });
      }
      t.diagnostic(
        JSON.stringify({
          ownContainers: [...containers],
          cleaned: true,
          secret,
          current: true,
          baseline: true,
          selectedSourceGone: true,
          canceledAncestor: true,
          publicAcknowledgements: true,
          publicReadList: true,
          bothProfilesFourFormats: true,
        }),
      );
    },
  );

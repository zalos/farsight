// Genuine executable plan -> admitted coordinator-operation -> accepted prompt/request closure. Fixture model only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scratch, needsStore, unlock } from './snapshot-helpers.ts';
import { mockEndpoint, json, ollamaReply, trustedPolicy } from './provider-helpers.ts';
import { openStore } from '../dist/store/index.js';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { publicRegistry } from '../dist/service/scanner-profile.js';
import { executablePlan } from '../dist/execution/plan.js';
import { runAdmittedReview, prepareAdmittedReview, requireHostedSecretCoverage } from '../dist/review/dispatch.js';
import { BudgetLedger } from '../dist/review/providers/budget.js';
import { readReviewSpec, reviewSeedsOfSpecs, reviewUnitOf, verifyReviewInputs } from '../dist/review/plan.js';
import { adoptedPolicy, workspaceOf } from '../dist/service/local.js';
import { reviewIdentityIn } from '../dist/service/review-adapter.js';
import { OwnerService } from '../dist/service/owner-service.js';
import { currentPlan } from '../dist/service/canonical.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { OWNER, receiptBook, runWriteBinding } from '../dist/service/local.js';
import { loadPlan } from '../dist/execution/plans.js';
import { readPublishedInstructions } from '../dist/review/instructions.js';
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
test(
  'actual owner executable runs both configured review modes and retains genuine parent-stored work/invocation after source removal without replay',
  needsStore,
  async (t) => {
    const dir = scratch(t, 'sentinel-model-public-'),
      ws = join(dir, 'workspace');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'original.ts'), 'export const original = (x: string) => x;\n');
    const ep = await mockEndpoint(t, (q, r) => {
      const last = JSON.parse(JSON.parse(q.body).messages.at(-1).content),
        reply = last.evidence
          ? {
              action: 'final',
              verdict: 'finding',
              claims: [
                { statement: 'Original fixture review candidate.', citations: last.evidence.map((e: any) => e.id) },
              ],
              inspected: ['src/original.ts'],
            }
          : { action: 'read', path: 'src/original.ts', startLine: 1, endLine: 1 };
      json(r, 200, ollamaReply({ message: { role: 'assistant', content: JSON.stringify(reply) } }));
    });
    const env = { ...process.env, HOME: join(dir, 'home'), XDG_STATE_HOME: join(dir, 'state') };
    mkdirSync(env.HOME);
    const calls: any[] = [];
    const cli = (...args: string[]) =>
      new Promise<any>((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, ...args, '--workspace', ws, '--json'], {
          cwd: ws,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '',
          err = '';
        child.stdout.on('data', (b) => (out += b));
        child.stderr.on('data', (b) => (err += b));
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(Error('owned CLI timeout'));
        }, 90000);
        child.on('error', reject);
        child.on('exit', (status) => {
          clearTimeout(timer);
          try {
            const body = JSON.parse(out);
            calls.push({ args, status, body });
            resolve({ status, body, err });
          } catch {
            reject(Error('CLI output invalid ' + err.slice(0, 500) + ' ' + out.slice(0, 500)));
          }
        });
      });
    assert.equal((await cli('init')).status, 0);
    const path = join(ws, '.farsight', 'sentinel', 'settings.json'),
      settings = JSON.parse(readFileSync(path, 'utf8')),
      fixture = trustedPolicy({ ollama: ep.origin }).settings;
    settings.providers = [structuredClone(fixture.providers[0])];
    settings.providers[0].models[0].capability.revision = null;
    settings.reviewModels = {
      stages: [
        { stage: 'guided', providerId: 'local-review', modelId: 'review' },
        { stage: 'general', providerId: 'local-review', modelId: 'review' },
      ],
      segments: [],
    };
    settings.grants.push({ actions: ['paid.admit'], principals: ['human'], confirm: 'always' });
    settings.grants[0].scope.effects = ['local-artifacts', 'paid-inference'];
    writeFileSync(path, JSON.stringify(settings));
    const adopted = await cli('settings', 'adopt', '--confirm');
    assert.equal(adopted.status, 0, JSON.stringify(adopted));
    const promoted = await cli('rules', 'promote', 'builtin:foundation-preview', '--confirm');
    assert.equal(promoted.status, 0, JSON.stringify(promoted));
    const planned = await cli('plan');
    assert.equal(planned.status, 0, JSON.stringify(planned));
    assert.equal(planned.body.facts.reviews.length, 2);
    const id = planned.body.facts.planId;
    // A detached start of a plan with model stages waits for the composite confirmation (--confirm-models): nothing
    // is issued, no service is asked and no model is called.
    const detached = await cli('run', id, '--confirm', '--detach');
    assert.equal(detached.status, 4, JSON.stringify(detached));
    assert.equal(detached.body.reasonCode, 'sentinel.service.needsOwnerConfirm');
    assert.equal(detached.body.facts.requiredFlag, '--confirm-models');
    assert.equal(ep.seen.length, 0);
    const waiting = await cli('run', id, '--confirm');
    assert.equal(waiting.status, 4, JSON.stringify(waiting));
    assert.equal(ep.seen.length, 0);
    const run = await cli('run', id, '--confirm', '--confirm-models');
    assert.equal(run.status, 2, JSON.stringify(run));
    assert.equal(run.body.facts.state, 'completed', JSON.stringify(run));
    assert.equal(ep.seen.length, 4, 'read and cited final fixture response for each mode');
    let store = await openStore(join(ws, '.farsight', 'sentinel', 'store'));
    const admitted = await loadPlan(store, id, 2),
      units = admitted.plan.units.filter((u) => u.review);
    assert.equal(units.length, 2);
    const first = [];
    for (const unit of units) {
      const row = store.ledger.getWork(unit)!,
        pub = store.ledger.getPublication(unit)!,
        attempt = store.ledger.getAttempt(pub.attemptId)!;
      assert.equal(row.envelope.stage.kind, 'agentic');
      assert.equal(attempt.envelope.worker.kind, 'coordinator-operation');
      const trace = await readPublishedInstructions(store, unit);
      assert.equal(trace.authority, 'accepted-coordinator-review');
      assert.equal(trace.record.deterministicCoverage, false);
      assert.equal(trace.observations.length, 1);
      assert.equal(trace.observations[0]!.message, 'Original fixture review candidate.');
      assert.equal(trace.instructions.skills.length, 0);
      assert.equal(trace.instructions.vendorInstructions, 'unobserved');
      assert.equal(trace.requests[0]!.selection!.bindingDigest, unit.review!.selection.bindingDigest);
      first.push(trace.requests);
    }
    const livePolicy = adoptedPolicy(workspaceOf(ws, env));
    assert.ok('policy' in livePolicy);
    if (!('policy' in livePolicy)) throw Error('missing genuine policy');
    // Admission re-derives the admitted plan's review inputs from its own stored specs with the planning seed builder.
    const specs = await Promise.all(units.map((u) => readReviewSpec(store, u))),
      terms = new Map(units.map((u) => [u.review!.selection.bindingDigest, u.review!.terms])),
      rebuilt = { plan: admitted.plan, ...reviewSeedsOfSpecs(admitted.plan, specs, terms) };
    await verifyReviewInputs(store, rebuilt.plan, livePolicy.policy, rebuilt.artifacts);
    await assert.rejects(
      requireHostedSecretCoverage(store, id, admitted, units[0]!.sourceId!),
      (e: any) => e.code === 'sentinel.review.secretCoverageRequired',
    );
    const modelLedger = await BudgetLedger.open(join(store.storePath, 'review-budget.sqlite'));
    try {
      assert.equal(
        modelLedger.listEnvelopes({ runId: id, limit: 10 }).length,
        1,
        'one genuine shared envelope for both stages',
      );
    } finally {
      modelLedger.close();
    }
    const lease = scratchUnder(store);
    try {
      const bound = await executablePlan(
        store,
        admitted,
        store.ledger.getRun(id)!.envelope,
        2,
        publicRegistry(workspaceOf(ws, env).trustDir),
        lease,
      );
      await assert.rejects(prepareAdmittedReview(store, { ...bound } as any, units[0]!, {} as any));
      await assert.rejects(
        runAdmittedReview(
          store,
          bound,
          units[0]!,
          'fake-attempt',
          {} as any,
          new AbortController().signal,
          Date.now() + 1000,
        ),
      );
    } finally {
      removeScratch(lease);
    }
    const beforeEvents = store.ledger.currentSequence();
    const altered = rebuilt.artifacts.map((a, i) =>
      i ? a : { ...a, bytes: Buffer.from('changed exact original bytes') },
    );
    await assert.rejects(verifyReviewInputs(store, rebuilt.plan, livePolicy.policy, altered));
    // A review unit placed, as the planner would, from a spec that names a file the capture does not hold: refused.
    const wrongSeeds = reviewSeedsOfSpecs(
      admitted.plan,
      specs.map((s, i) =>
        i
          ? s
          : {
              ...s,
              scope: { ...s.scope, files: s.scope.files.map((f) => ({ ...f, relativePath: 'foreign-unassigned.ts' })) },
            },
      ),
      terms,
    );
    let k = 0;
    const wrongScope = {
      plan: {
        ...admitted.plan,
        units: admitted.plan.units.map((u) => (u.review ? reviewUnitOf(admitted.plan, wrongSeeds.seeds[k++]!) : u)),
      },
      artifacts: wrongSeeds.artifacts,
    };
    await assert.rejects(verifyReviewInputs(store, wrongScope.plan, livePolicy.policy, wrongScope.artifacts));
    // A planned review unit that is not where the planner places its seed (another dependency set): refused.
    const misplaced = {
      ...admitted.plan,
      units: admitted.plan.units.map((u) => (u.review ? { ...u, dependencies: [] } : u)),
    };
    await assert.rejects(verifyReviewInputs(store, misplaced, livePolicy.policy, rebuilt.artifacts));
    await assert.rejects(
      verifyReviewInputs(store, rebuilt.plan, livePolicy.policy, [
        ...rebuilt.artifacts,
        { ...rebuilt.artifacts[0]!, id: 'sha256:' + 'e'.repeat(64), bytes: Buffer.alloc(4194305) },
      ]),
    );
    assert.equal(store.ledger.currentSequence(), beforeEvents);
    const identities = await reviewIdentityIn(store, id);
    assert.equal(identities.status, 'available');
    assert.equal(JSON.stringify(identities).includes('content'), false);
    assert.equal(JSON.stringify(identities).includes('Sentinel'), false);
    assert.deepEqual(await reviewIdentityIn(store, 'run-absent'), { status: 'unavailable', reviews: [] });
    await assert.rejects(readPublishedInstructions(store, { id: units[0]!.id, revision: 2 }));
    store.close();
    unlock(join(ws, 'src'));
    rmSync(join(ws, 'src'), { recursive: true });
    store = await openStore(join(ws, '.farsight', 'sentinel', 'store'));
    try {
      for (let i = 0; i < units.length; i++)
        assert.deepEqual((await readPublishedInstructions(store, units[i]!)).requests, first[i]);
      await assert.rejects(readPublishedInstructions({ ...store } as any, units[0]!));
    } finally {
      store.close();
    }
    const privateRead = await cli('report', id, '--instructions');
    assert.equal(privateRead.status, 0, JSON.stringify(privateRead));
    assert.equal(privateRead.body.facts.traces.length, 2);
    assert.equal(privateRead.body.facts.traces[0].observations[0].message, 'Original fixture review candidate.');
    assert.equal(
      privateRead.body.facts.traces[0].requests[0].messages[0].content,
      privateRead.body.facts.traces[0].contents.find(
        (c: any) => c.id === privateRead.body.facts.traces[0].instructions.assembled.content,
      ).text,
    );
    const defaultRead = await cli('report', id);
    assert.equal(defaultRead.status, 0);
    assert.equal(JSON.stringify(defaultRead.body).includes('sentinel-review-request'), false);
    const bad = await cli('report', id, '--instructions', '--full');
    assert.notEqual(bad.status, 0);
    const repeated = await cli('run', id, '--confirm', '--confirm-models');
    assert.equal(repeated.status, 2);
    assert.equal(ep.seen.length, 4, 'no repeated inference');
    const other = structuredClone(settings.providers[0]);
    other.id = 'second-provider';
    settings.providers.push(other);
    settings.reviewModels.stages[1].providerId = other.id;
    writeFileSync(path, JSON.stringify(settings));
    assert.equal((await cli('settings', 'adopt', '--confirm')).status, 0);
    const mixed = await cli('rerun', id, '--confirm');
    assert.equal(mixed.status, 0, JSON.stringify(mixed));
    const mixedId = mixed.body.facts.runId;
    const refused = await cli('run', mixedId, '--confirm', '--confirm-models');
    assert.equal(refused.body.reasonCode, 'sentinel.provider.bindingChanged');
    assert.equal(refused.body.facts.limitation, 'one-model-binding-per-run');
    assert.equal(ep.seen.length, 4);
    const preserved = await cli('report', id, '--instructions');
    assert.equal(preserved.status, 0);
    assert.deepEqual(
      preserved.body.facts.traces.map((x: any) => x.requests),
      first,
    );
    // A genuine mixed-binding plan has paid effects but no single model. Service refusal must precede receipt spend.
    store = await openStore(join(ws, '.farsight', 'sentinel', 'store'));
    const serviceWs = workspaceOf(ws, env),
      service = new OwnerService(store, serviceWs);
    try {
      const record = await currentPlan(store, mixedId);
      assert.ok(record && record.kind === 'analysis');
      if (!record || record.kind !== 'analysis') throw Error('analysis absent');
      assert.equal(record.model, undefined);
      assert.equal(record.modelConflict, true);
      assert.ok(record.effects.includes('paid-inference'));
      const policy = adoptedPolicy(serviceWs);
      assert.ok('policy' in policy);
      if (!('policy' in policy)) throw Error('policy absent');
      const binding = {
          ...runWriteBinding(serviceWs, 'run.start', record, { storeId: store.storeId, runId: mixedId }),
          policyRevision: policy.policy.revision,
        },
        book = receiptBook(serviceWs),
        now = new Date(),
        receipt = issueReceipt(book, OWNER, binding, { now, ttlMs: 60000 }),
        sequence = store.ledger.currentSequence();
      for (const receiptId of [undefined, receipt.id]) {
        const response = await service.handle(
          'run.start',
          { planId: mixedId, ...(receiptId ? { receiptId } : {}) },
          { principal: 'agent', channel: 'mcp' },
        );
        assert.equal(response.reasonCode, 'sentinel.review.foregroundRequired');
        assert.equal(store.ledger.currentSequence(), sequence, 'no work/admission events');
        assert.equal(
          existsSync(join(book.directory, receipt.id + '.spent')),
          false,
          'service does not spend the owner receipt',
        );
      }
      const budget = await BudgetLedger.open(join(store.storePath, 'review-budget.sqlite'));
      try {
        assert.equal(budget.listEnvelopes({ runId: mixedId, limit: 10 }).length, 0, 'no model envelope or spend');
      } finally {
        budget.close();
      }
      assert.ok(
        book.consume(receipt.id, binding, new Date()).digest,
        'positive control: exact receipt remains genuinely consumable',
      );
      assert.equal(ep.seen.length, 4, 'no new model dispatch');
    } finally {
      await service.stop();
      store.close();
    }
    t.diagnostic(
      JSON.stringify({
        bothModes: true,
        actualExecutable: true,
        genuineCoordinatorAttempts: true,
        sourceRemoved: true,
        noReplay: true,
        fixtureModel: true,
        realInferenceQualified: false,
      }),
    );
  },
);

// Actual private model operation in an owned child; the provider is a local fixture, not real inference qualification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../dist/store/index.js';
import { captureSnapshot } from '../dist/snapshot/index.js';
import {
  guidedSpec,
  planReviewWork,
  prepareInstructions,
  GUIDED_PROMPT,
  instructionManifest,
} from '../dist/review/index.js';
import { readPublishedInstructions } from '../dist/review/instructions.js';
import { bindProvider } from '../dist/review/providers/index.js';
import { digestOf } from '../dist/store/ledger-json.js';
import { scratch, needsStore } from './snapshot-helpers.ts';
import { trustedPolicy, mockEndpoint, json, ollamaReply } from './provider-helpers.ts';
const RESOURCE = { deadlineMs: 120000, memoryBytes: 268435456, cpuQuota: 1, maxPids: 8, maxOutputBytes: 4194304 };
test(
  'genuine self-planned owned-child publication cannot impersonate an admitted canonical review operation before or after reopen',
  needsStore,
  async (t) => {
    const dir = scratch(t, 'sentinel-instructions-'),
      src = join(dir, 'source');
    mkdirSync(src);
    const original = 'export const original = "original captured data";\n';
    writeFileSync(join(src, 'original.ts'), original);
    const endpoint = await mockEndpoint(t, (req, res) => {
      const messages = JSON.parse(req.body).messages,
        last = JSON.parse(messages.at(-1).content);
      json(
        res,
        200,
        ollamaReply({
          message: {
            role: 'assistant',
            content: JSON.stringify(
              last.evidence
                ? { action: 'final', verdict: 'no-finding', claims: [], inspected: ['original.ts'] }
                : { action: 'read', path: 'original.ts', startLine: 1, endLine: 1 },
            ),
          },
        }),
      );
    });
    let store = await openStore(join(dir, 'store'));
    t.after(() => {
      if (store.held) store.close();
    });
    const { snapshot } = await captureSnapshot(store, {
        mode: 'working-copy',
        sources: [{ sourceId: 'web', repositoryId: 'original/fixture', root: src }],
      }),
      entry = snapshot.entries.find((e) => e.kind === 'file' && e.disposition === 'included')!;
    assert.equal(entry.kind, 'file');
    assert.equal(entry.disposition, 'included');
    if (entry.kind !== 'file' || entry.disposition !== 'included') throw Error('captured file missing');
    const policy = trustedPolicy({ ollama: endpoint.origin }),
      binding = bindProvider(policy, 'local-review', 'review'),
      skills = [
        {
          id: 'owner.original',
          revision: 2,
          text: 'Use only the fixed tools and original captured evidence.\n',
          resources: [{ id: 'owner.reference', revision: 1, text: 'Original included reference café <&> `text`.\n' }],
        },
      ];
    const request = {
      runId: 'run-instructions',
      attemptId: 'att-instructions',
      snapshotId: snapshot.id,
      sourceId: 'web',
      check: {
        checkId: 'check-original',
        familyId: 'original.rule',
        revisionDigest: digestOf({ original: 'rule' }),
        ruleText: 'Original bounded review rule.',
        files: [{ relativePath: entry.relativePath, content: entry.content, bytes: entry.bytes }],
      },
      limits: { maxSliceLines: 10, maxSliceBytes: 65536, maxToolCalls: 10, maxServedBytes: 262144 },
      budget: { maxSteps: 4, maxInvalidReplies: 1, maxInputBytes: 1048576, maxOutputTokens: 64, deadlineMs: 60000 },
    };
    const instructions = prepareInstructions({ prompt: GUIDED_PROMPT, skills }),
      spec = {
        ...guidedSpec(request),
        instructions,
        segmentId: 'segment-original',
        requestedSelection: { providerId: binding.providerId, modelId: binding.modelId, bindingDigest: binding.digest },
      },
      plan = {
        runId: request.runId,
        planRevision: 2,
        coordinatorEpoch: store.epoch,
        createdAt: new Date().toISOString(),
        dependencies: [],
        resources: RESOURCE,
      },
      [unit] = planReviewWork({ ...plan, specs: [spec] });
    const invocation = {
      format: 'sentinel-private-model-fixture/1',
      specDigest: unit!.manifest.spec,
      instructionDigest: instructionManifest(instructions).digest,
    };
    const initial = [unit!.manifest, invocation],
      initialIds = initial.map((v) => store.objects.identifyCanonicalJson(v));
    store.ledger.registerStaging(
      'stage-instruction-inputs',
      initialIds.map((i) => ({ id: i.id, schema: 'application/json', privacy: 'source-derived' })),
    );
    for (let i = 0; i < initial.length; i++)
      await store.objects.putCanonicalJson(initial[i], { expect: initialIds[i] });
    const active = JSON.parse(readFileSync(new URL('./contracts/valid/run-active.json', import.meta.url), 'utf8'));
    store.ledger.createRun({
      ...active,
      id: request.runId,
      coordinatorEpoch: store.epoch,
      snapshotId: snapshot.id,
      requestedScope: { sourceIds: ['web'], profile: 'original-review' },
      state: 'running',
    });
    store.ledger.createWork({ ...unit!.work, state: 'ready' });
    const startedAt = new Date().toISOString(),
      child = fork(new URL('./fixtures/review-instructions-runner.mjs', import.meta.url), [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    store.ledger.startAttempt({
      schema: 'sentinel-attempt/draft-1',
      id: request.attemptId,
      work: { id: unit!.work.id, revision: 1 },
      ordinal: 1,
      coordinatorEpoch: store.epoch,
      operationId: 'operation-original',
      worker: { kind: 'owned-child', pid: child.pid!, processStartedAt: startedAt },
      startedAt,
      usage: { certainty: 'unknown' },
      invocation: initialIds[1]!.id,
      state: 'running',
    });
    const replyPromise = new Promise<any>((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code) reject(Error('fixed model fixture exited'));
      });
    });
    child.send({
      runId: request.runId,
      origin: endpoint.origin,
      ledger: join(dir, 'model-budget.sqlite'),
      epoch: store.epoch,
      request,
      plan,
      skills,
      contents: { [entry.content]: Buffer.from(original).toString('base64') },
    });
    const result = await replyPromise;
    assert.equal(result.ok, true, result.code);
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    assert.equal(child.exitCode, 0);
    assert.deepEqual(result.coverage, []);
    assert.equal(endpoint.seen.length, 2);
    for (const received of endpoint.seen) {
      const m = JSON.parse(received.body).messages;
      assert.ok(m[0].content.includes(skills[0].text));
      assert.ok(m[0].content.includes(skills[0].resources[0].text));
    }
    const artifacts = new Map(
      result.artifacts.map((a: any) => [a.id, { ...a, bytes: Buffer.from(a.bytes, 'base64') }]),
    ) as Map<string, any>;
    for (const r of result.records) {
      const bytes = Buffer.from((await import('../dist/store/objects.js')).canonicalJsonBytes(r.value)),
        id = store.objects.identify(bytes).id;
      artifacts.set(id, { id, bytes, schema: r.schema, links: [...artifacts.keys()] });
    }
    store.ledger.registerStaging(
      'stage-instruction-results',
      [...artifacts.values()].map((a) => ({ id: a.id, schema: a.schema, privacy: 'source-derived', links: a.links })),
      { work: unit!.work, attemptId: request.attemptId },
    );
    const receipts = [];
    for (const a of artifacts.values())
      receipts.push(await store.objects.put(a.bytes, { expect: { id: a.id, rawSize: a.bytes.length } }));
    store.ledger.publish({
      work: unit!.work,
      attemptId: request.attemptId,
      stageId: 'stage-instruction-results',
      receipts,
      outputs: [...artifacts.keys()],
      endedAt: new Date().toISOString(),
    });
    // This older private fixture genuinely published bytes, but self-planned owned-child work is not a modern admitted review operation.
    await assert.rejects(readPublishedInstructions(store, unit!.work));
    rmSync(src, { recursive: true });
    store.close();
    store = await openStore(join(dir, 'store'));
    await assert.rejects(readPublishedInstructions(store, unit!.work));
    assert.equal(endpoint.seen.length, 2, 'refusal launches no additional model call');
    await assert.rejects(readPublishedInstructions({ ...store } as any, unit!.work));
    t.diagnostic(
      JSON.stringify({
        actualOwnedChild: true,
        localFixtureProvider: true,
        realInferenceQualified: false,
        acceptedBytesNotCoordinatorAuthority: true,
        refused: true,
      }),
    );
  },
);

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { publishedSecrets, nativeSecrets } from './sol-report-helpers.ts';
import { VALUE, GENERIC_VALUE, absent } from './secrets-helpers.ts';
import { assessRun, fullReport, contextIntentFor } from '../dist/service/full-report.js';
import { ReceiptBook } from '../dist/policy/receipts.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { planWorkspaceCanonical } from '../dist/service/canonical.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { publicRegistry, scannerExecution } from '../dist/service/scanner-profile.js';
const noLeak = (r: any, where: string) => {
  for (const v of [VALUE, GENERIC_VALUE])
    for (const [n, x] of Object.entries({
      json: r.json,
      md: r.markdown,
      html: r.html,
      sarif: JSON.stringify(r.sarif),
      compare: JSON.stringify(r.comparison),
      context: JSON.stringify(r.context),
    }))
      absent(String(x), `${where}:${n}`, v);
};
for (const mode of [
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
])
  test(`independent count attestation refuses ${mode}`, nativeSecrets, async (t) => {
    const f = await publishedSecrets(t, mode);
    await assert.rejects(
      fullReport({
        store: f.store,
        runId: f.runId,
        workspace: f.path,
        trustDir: f.ws.trustDir,
        disclosure: 'shareable',
        now: new Date(),
      }),
      (e: any) => {
        absent(`${e.message} ${JSON.stringify(e.facts ?? {})}`, 'refusal');
        return e.code === 'sentinel.report.evidenceUnbound';
      },
    );
  });

test(
  'independent actual capture: stable same-store withheld keys across a changed capture; duplicate bytes remain distinct',
  nativeSecrets,
  async (t) => {
    const f = await publishedSecrets(t, 'positive');
    const first = await assessRun(f.store, f.runId, { trustDir: f.ws.trustDir });
    const keys = (a: any) =>
      new Map(
        a.observations.flatMap((o: any) =>
          o.evidence.map((e: any) => [a.snapshot.entries[e.entry].relativePath, a.withheldKey(e)]),
        ),
      );
    const before = keys(first);
    assert.notEqual(before.get('first.txt'), before.get('second.txt'));
    writeFileSync(join(f.path, 'clean.txt'), 'a changed safe file\n');
    const prepared = await planWorkspaceCanonical(f.store, {
      workspace: f.path,
      trustDir: f.ws.trustDir,
      policy: f.policy,
      scratchRoot: f.work,
      now: new Date(),
    });
    const next = prepared.disclosure.runId;
    assert.notEqual(next, f.runId);
    const registry = publicRegistry();
    const assets = await scannerExecution(f.store, next, f.ws.trustDir, f.work, registry);
    const done = await (
      await Coordinator.open({ ...assets, store: f.store, runId: next, registry, scratchRoot: f.work })
    ).run();
    assert.equal(done.state, 'completed');
    const second = await assessRun(f.store, next, { trustDir: f.ws.trustDir });
    assert.notEqual(first.snapshot.id, second.snapshot.id);
    const after = keys(second);
    for (const path of ['first.txt', 'second.txt'])
      assert.equal(after.get(path), before.get(path), 'same file location is stable across captures');
    const r = await fullReport({
      store: f.store,
      runId: next,
      baselineRunId: f.runId,
      workspace: f.path,
      trustDir: f.ws.trustDir,
      disclosure: 'shareable',
      now: new Date(),
    });
    noLeak(r, 'cross-capture comparison');
    assert.ok(r.comparison.current.filter((x: any) => x.label === 'persistent').length >= 4);
  },
);

test(
  'independent actual capture: confirmed context cannot disclose a matched filename through ordinary gap labels',
  nativeSecrets,
  async (t) => {
    const f = await publishedSecrets(t, 'positive', {
      'safe.ts': 'export function safe(){ return 1; }\n',
      'skip.bin': 'safe excluded binary fixture\n',
    });
    const a = await assessRun(f.store, f.runId, { trustDir: f.ws.trustDir });
    assert.ok(
      a.coverage.some((c: any) => c.status !== 'complete'),
      'genuine omitted input is a gap',
    );
    const graph: any = {
      nodes: [
        { id: 'fixture::flow::safe', kind: 'flow', name: VALUE, tags: [] },
        {
          id: 'fixture::page::safe',
          kind: 'page',
          name: VALUE,
          tags: [],
          loc: { repo: 'fixture', path: 'safe.ts', line: 1 },
          design: { id: VALUE },
        },
      ],
      edges: [
        {
          id: 'renders-safe',
          kind: 'renders',
          from: 'fixture::flow::safe',
          to: 'fixture::page::safe',
          meta: { line: 1 },
        },
      ],
      meta: { custom: VALUE },
    };
    const { intent } = contextIntentFor(a.snapshot, 'workspace', f.path, graph, 'fixture');
    assert.ok(intent);
    const now = new Date();
    const book = new ReceiptBook(join(f.dir, 'context-receipts'));
    const bind: any = { intent, stateDigest: 'sha256:' + 'a'.repeat(64), policyRevision: f.policy.revision };
    const receipt = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, bind, { now, ttlMs: 600000 });
    const authorization = book.consume(receipt.id, bind, now);
    for (const disclosure of ['shareable', 'private'] as const) {
      const r = await fullReport({
        store: f.store,
        runId: f.runId,
        baselineRunId: f.runId,
        workspace: f.path,
        trustDir: f.ws.trustDir,
        disclosure,
        now,
        context: { graph, repo: 'fixture', authorization },
      });
      assert.equal(r.context?.binding, 'matched');
      assert.ok(
        r.document.gaps.some((g: any) => g.place.screens.length > 0),
        'actual pinned graph placed an ordinary gap',
      );
      noLeak(r, `confirmed context ${disclosure}`);
    }
  },
);

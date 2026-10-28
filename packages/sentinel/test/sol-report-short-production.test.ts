import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { publishedSecrets, nativeSecrets } from './sol-report-helpers.ts';
import { assessRun, fullReport, contextIntentFor } from '../dist/service/full-report.js';
import { ReceiptBook } from '../dist/policy/receipts.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
const PUNCT = ['abc', ':', 'def'].join('');
const sha = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');
function authenticate(f: any, a: any, label: string) {
  const graph: any = {
    nodes: [
      { id: 'fixture::flow::safe', kind: 'flow', name: label, tags: [] },
      {
        id: 'fixture::page::safe',
        kind: 'page',
        name: label,
        tags: [],
        loc: { repo: 'fixture', path: 'safe.ts', line: 1 },
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
    meta: {},
  };
  const { intent } = contextIntentFor(a.snapshot, 'workspace', f.path, graph, 'fixture');
  assert.ok(intent);
  const now = new Date();
  const book = new ReceiptBook(join(f.dir, 'context-neighbor'));
  const bind: any = { intent, stateDigest: 'sha256:' + 'a'.repeat(64), policyRevision: f.policy.revision };
  const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, bind, { now, ttlMs: 600000 });
  return { graph, repo: 'fixture', authorization: book.consume(r.id, bind, now) };
}
test(
  'independent supported seven-character curl secret remains withheld from confirmed context',
  nativeSecrets,
  async (t) => {
    const text = `curl -u ${PUNCT} https://example.invalid\n`;
    const f = await publishedSecrets(t, 'positive', {
      'punct.env': text,
      'safe.ts': 'export const safe=1;\n',
      'skip.bin': 'safe ignored file\n',
    });
    const a = await assessRun(f.store, f.runId, { trustDir: f.ws.trustDir });
    assert.ok(
      a.observations.some(
        (o: any) => o.producerRuleId === 'curl-auth-user' && o.evidence.some((e: any) => e.content === sha(text)),
      ),
      'the pinned engine actually detected this punctuation-separated inert value',
    );
    const context = authenticate(f, a, PUNCT);
    const results = [];
    for (const disclosure of ['shareable', 'private'] as const) {
      const r = await fullReport({
        store: f.store,
        runId: f.runId,
        baselineRunId: f.runId,
        workspace: f.path,
        trustDir: f.ws.trustDir,
        disclosure,
        now: new Date(),
        context,
      });
      assert.equal(r.context?.binding, 'matched');
      assert.ok(r.document.gaps.some((g: any) => g.place.screens.length > 0));
      const leaks = Object.fromEntries(
        Object.entries({
          json: r.json,
          html: r.html,
          markdown: r.markdown,
          sarif: JSON.stringify(r.sarif),
          comparison: JSON.stringify(r.comparison),
        }).map(([k, v]) => [k, v.includes(PUNCT)]),
      );
      results.push({ disclosure, leaks, hasWholeToken: a.secretTokens.has(PUNCT) });
    }
    writeFileSync(join(f.dir, 'short-production.json'), JSON.stringify(results, null, 2));
    assert.ok(
      results.every((x) => Object.values(x.leaks).every((v) => !v)),
      'every rendering must withhold the actual matched punctuation-separated value',
    );
  },
);

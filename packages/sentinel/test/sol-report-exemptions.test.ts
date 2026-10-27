import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { publishedSecrets, nativeSecrets } from './sol-report-helpers.ts';
import { assessRun, fullReport, contextIntentFor } from '../dist/service/full-report.js';
import { ReceiptBook } from '../dist/policy/receipts.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
const HEX = ['86a19f04bc72d3e5', '91a7c6f209b4d8e3'].join('');
const ID = 'finding.' + HEX;
const sha = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex');
test(
  'independent actual secret cannot bypass context redaction by looking like a generated finding id',
  nativeSecrets,
  async (t) => {
    const text = `facebook_app_secret = "${HEX}"\n`;
    const f = await publishedSecrets(t, 'positive', {
      'id.env': text,
      'safe.ts': 'export function safe(){return 1;}\n',
      'skip.bin': 'safe ignored file\n',
    });
    const a = await assessRun(f.store, f.runId, { trustDir: f.ws.trustDir });
    assert.ok(
      a.observations.some(
        (o: any) => o.producerRuleId === 'facebook-secret' && o.evidence.some((e: any) => e.content === sha(text)),
      ),
      'actual pinned engine matched the inert generated-looking value',
    );
    assert.ok(a.secretTokens.has(HEX), 'whole value is a known redaction candidate');
    const graph: any = {
      nodes: [
        { id: 'fixture::flow::safe', kind: 'flow', name: 'Safe journey', tags: [] },
        { id: ID, kind: 'page', name: '/safe', tags: [] },
        {
          id: 'fixture::safe.ts::safe',
          kind: 'function',
          name: 'safe',
          tags: [],
          loc: { repo: 'fixture', path: 'safe.ts', line: 1 },
        },
      ],
      edges: [
        { id: 'render-safe', kind: 'renders', from: 'fixture::flow::safe', to: ID, meta: { line: 1 } },
        { id: 'call-safe', kind: 'calls', from: ID, to: 'fixture::safe.ts::safe' },
      ],
      meta: {},
    };
    const { intent } = contextIntentFor(a.snapshot, 'workspace', f.path, graph, 'fixture');
    assert.ok(intent);
    const now = new Date();
    const book = new ReceiptBook(join(f.dir, 'generated-context'));
    const bind: any = { intent, stateDigest: 'sha256:' + 'a'.repeat(64), policyRevision: f.policy.revision };
    const r = issueReceipt(book, { channel: 'owner-cli', principal: 'owner' }, bind, { now, ttlMs: 600000 });
    const context = { graph, repo: 'fixture', authorization: book.consume(r.id, bind, now) };
    const results = [];
    for (const disclosure of ['shareable', 'private'] as const) {
      const out = await fullReport({
        store: f.store,
        runId: f.runId,
        workspace: f.path,
        trustDir: f.ws.trustDir,
        disclosure,
        now,
        context,
      });
      assert.equal(out.context?.binding, 'matched');
      assert.ok(out.document.gaps.some((g: any) => g.place.screens.length > 0));
      results.push({
        disclosure,
        jsonLeak: out.json.includes(HEX),
        htmlLeak: out.html.includes(HEX),
        screenIdKept: out.document.gaps.some((g: any) => g.place.screens.some((s: any) => s.id === ID)),
      });
    }
    writeFileSync(join(f.dir, 'exemptions.json'), JSON.stringify(results, null, 2));
    assert.ok(
      results.every((x) => !x.jsonLeak && !x.htmlLeak),
      'context-owned ids require provenance, not a generated-looking spelling',
    );
  },
);

// A retained ledger from the intercepted native Copilot fixture in review-native-dispatch.test.ts. The fixture holds
// the accepted publication and source bytes, but no source checkout, credential, executable or adapter runtime. A
// report must read its native observations and provenance through that publication and regenerate from the same
// ledger without a CLI process or model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { canonicalJson } from '@farsight/graph';
import { openStore } from '../dist/store/index.js';
import { fullReport } from '../dist/service/full-report.js';
import { reportIn } from '../dist/service/local.js';
import { renderPreviewMarkdown } from '../dist/reports/preview.js';
import { loadPlan } from '../dist/execution/plans.js';
import { readPublishedNativeReview } from '../dist/review/native-dispatch.js';
import { COPILOT_AGENT_PROFILE } from '../dist/review/providers/cli-copilot-profile.js';
import { validateEnvelope } from '../dist/validate.js';
import { needsStore } from './snapshot-helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/report-native-ledger.tgz', import.meta.url));
function unpackRetainedLedger(dir: string): void {
  const archive = gunzipSync(readFileSync(fixture));
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').split('\0')[0];
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').split('\0')[0]!.trim(), 8);
    assert.match(name, /^(?:store|trust)\/[a-zA-Z0-9/._-]+$/);
    assert.ok(!name.split('/').includes('..'));
    assert.equal(header[156], 0x30, 'the retained fixture contains regular files only');
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    const destination = join(dir, name);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, archive.subarray(offset + 512, offset + 512 + size), { mode: 0o600 });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}
const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digests = (report: Awaited<ReturnType<typeof fullReport>>) => ({
  json: sha(report.json),
  markdown: sha(report.markdown),
  html: sha(report.html),
  sarif: sha(canonicalJson(report.sarif)),
});

test(
  'a retained native Copilot scan regenerates four reports with cited observations and provenance',
  needsStore,
  async (t) => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-report-native-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    unpackRetainedLedger(dir);
    assert.equal(existsSync(join(dir, 'src')), false, 'the fixture has no source checkout');
    const now = new Date('2026-10-28T09:00:00Z');
    const render = async (disclosure: 'private' | 'shareable') => {
      const store = await openStore(join(dir, 'store'));
      try {
        const [run] = store.ledger.listRuns();
        assert.ok(run);
        assert.equal(run.state, 'completed');
        const admitted = await loadPlan(store, run.id, run.planRevision);
        const review = admitted.plan.units.find((u) => u.review);
        assert.ok(review);
        const trace = await readPublishedNativeReview(store, review);
        assert.equal(trace.provenance.mode, 'native');
        assert.equal(trace.observations.length, 2);
        return await fullReport({
          store,
          runId: run.id,
          workspace: dir,
          trustDir: join(dir, 'trust'),
          disclosure,
          now,
        });
      } finally {
        store.close();
      }
    };

    const first = await render('private');
    assert.ok(validateEnvelope('report', first.document).ok);
    assert.equal(first.document.reviews?.length, 2);
    assert.equal(first.document.counts.reviewObservations.n, 2);
    assert.equal(first.document.findings.length, 0, 'model claims do not become findings');
    assert.deepEqual(first.document.reviews?.map((r) => r.evidence[0]?.location?.relativePath).sort(), [
      'src/auth.ts',
      'upstream/auth.ts',
    ]);
    const agent = first.document.provenance?.find((p) => p.kind === 'agent');
    assert.ok(agent && agent.kind === 'agent');
    assert.equal(agent.mode, 'native');
    assert.equal(agent.runner, 'copilot-cli');
    assert.equal(agent.runnerVersion, '1.0.105');
    assert.equal(agent.executableDigest, COPILOT_AGENT_PROFILE.executableDigest);
    assert.deepEqual(agent.model, {
      requested: 'gpt-6-luna',
      reported: 'gpt-6-luna',
      identitySource: 'host-reported',
    });
    assert.match(agent.transcript!, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(agent.tokens, { input: 1234, output: 56, certainty: 'confirmed' });
    assert.deepEqual(agent.cost, { basis: 'unobserved', reason: 'subscription' });
    assert.deepEqual(
      first.document.definitions.find((d) => d.key === 'sentinel.report.provenance.executableDigest')?.text,
      { business: 'executable pinned', code: 'executable digest' },
    );
    assert.deepEqual(first.document.definitions.find((d) => d.key === 'sentinel.report.provenance.transcript')?.text, {
      business: 'transcript retained',
      code: 'transcript handle',
    });
    assert.match(first.markdown, /The token is compared with ==/);
    assert.match(first.html, /cost unobserved · subscription/);
    assert.match(first.markdown.replace(/\\(.)/g, '$1'), /copilot-cli 1\.0\.105 native/);
    for (const text of [first.markdown, first.html]) {
      assert.ok(text.includes(agent.executableDigest!));
      assert.ok(text.includes(agent.transcript!));
    }
    assert.equal(first.sarif.version, '2.1.0');
    assert.equal(first.sarif.runs[0]?.results.length, 0, 'SARIF carries findings, not model claims');

    const retained = await render('private');
    assert.deepEqual(digests(retained), digests(first), 'every format regenerates from the same retained ledger');
    const shared = await render('shareable');
    assert.equal(shared.document.reviews?.[0]?.evidence[0]?.state, 'withheld');
    assert.doesNotMatch(shared.markdown, /The token is compared with ==/);
    assert.deepEqual(digests(await render('shareable')), digests(shared));

    const store = await openStore(join(dir, 'store'));
    try {
      const [run] = store.ledger.listRuns();
      assert.ok(run);
      const preview = await reportIn(
        store,
        { path: dir, storePath: join(dir, 'store'), trustDir: join(dir, 'trust') },
        { runId: run.id, now },
      );
      if (!('schema' in preview) || preview.schema !== 'sentinel-preview-report/draft-1')
        assert.fail('the native fixture should produce a foundation preview');
      const markdown = renderPreviewMarkdown(preview);
      assert.match(markdown, /A model review ran/);
      assert.doesNotMatch(markdown, /No pinned scanner, framework check or model review ran/);
    } finally {
      store.close();
    }
  },
);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { brokeredCostRecord } from '../dist/review/dispatch.js';
import { provenanceLine } from '../dist/reports/markdown.js';
import { validateEnvelope } from '../dist/validate.js';
import { FileCheckpointStore, guidedSpec, runSession } from '../dist/review/index.js';
import { scratchDir } from './provider-helpers.ts';

const mockRun = () => JSON.parse(readFileSync(new URL('./contracts/valid/review.json', import.meta.url), 'utf8'));

async function mockBrokeredRun(t: any) {
  const bytes = Buffer.from('export const allowed = true;\n');
  const digest = (value: Uint8Array | string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
  const file = { relativePath: 'src/auth.ts', content: digest(bytes), bytes: bytes.byteLength };
  const spec = guidedSpec({
    runId: 'run-1',
    attemptId: 'attempt-1',
    snapshotId: 'snap-1',
    sourceId: 'web',
    limits: { maxSliceLines: 100, maxSliceBytes: 65536, maxToolCalls: 10, maxServedBytes: 65536 },
    budget: { maxSteps: 4, maxInvalidReplies: 1, maxInputBytes: 65536, maxOutputTokens: 256, deadlineMs: 30000 },
    check: {
      checkId: 'check-1',
      familyId: 'sentinel.sql.dynamic-query',
      revisionDigest: digest('rule'),
      ruleText: 'Review the captured file.',
      files: [file],
    },
  });
  let calls = 0;
  const result = await runSession(spec, {
    caller: {
      kind: 'provider',
      async call() {
        calls++;
        return {
          content:
            calls === 1
              ? JSON.stringify({ action: 'read', path: 'src/auth.ts', startLine: 1, endLine: 1 })
              : JSON.stringify({ action: 'final', verdict: 'no-finding', claims: [], inspected: ['src/auth.ts'] }),
          truncated: false,
          identity: {
            requestedModel: 'gpt-6-luna',
            returnedModel: 'gpt-6-luna',
            immutableRevision: null,
            source: 'host-reported',
          },
          usage: { inputTokens: 30, outputTokens: 10 },
        };
      },
    },
    checkpoints: new FileCheckpointStore(join(scratchDir(t), 'cost-cp')),
    read: async (id: string) => {
      assert.equal(id, file.content);
      return bytes;
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.record.outcome, 'completed');
  return result.record;
}

test('a mock brokered subscription run retains and prints unobserved cost after token settlement', async (t) => {
  const record = brokeredCostRecord(await mockBrokeredRun(t), 'subscription-quota', {
    certainty: 'confirmed',
    inputTokens: 30,
    outputTokens: 10,
  });
  assert.deepEqual(record.cost, { basis: 'unobserved', reason: 'subscription' });
  assert.ok(validateEnvelope('review', record).ok);
  const line = provenanceLine(
    {
      definitions: [
        {
          key: 'sentinel.report.provenance.where.sandboxed-cli',
          text: { business: 'through a sandboxed command-line tool', code: 'through a sandboxed command-line tool' },
        },
        {
          key: 'sentinel.report.provenance.cost.subscription',
          text: { business: 'cost unobserved · subscription', code: 'cost unobserved · subscription' },
        },
      ],
    } as any,
    {
      kind: 'agent',
      stage: 'review-general',
      unit: { id: 'review-unit', revision: 1 },
      where: 'sandboxed-cli',
      durationMs: 1,
      runner: 'copilot-cli',
      mode: 'brokered',
      model: { requested: 'gpt-6-luna', reported: 'gpt-6-luna' },
      turns: 1,
      tokens: { input: 30, output: 10, certainty: 'confirmed' },
      cost: record.cost,
    } as any,
  );
  assert.match(line, /cost unobserved · subscription/);
  assert.doesNotMatch(line, /\$0/);
});

test('a mock brokered subscription run with unsettled usage keeps the unknown reason', () => {
  const record = brokeredCostRecord(mockRun(), 'subscription-quota', { certainty: 'unknown' });
  assert.deepEqual(record.cost, { basis: 'unobserved', reason: 'usage-unknown' });
  assert.ok(validateEnvelope('review', record).ok);
});

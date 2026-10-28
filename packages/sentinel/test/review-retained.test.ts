// A refused native run's private record (`sentinel-attempt-retained/draft-1`): what `retainedAttemptOf` builds from
// the runner's failed attempt, and what a `NativeRunFailure` carries for the store. Synthetic bytes only: no CLI,
// model, keychain or store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NativeRunFailure } from '../dist/review/runner.js';
import { ATTEMPT_RETAINED_SCHEMA, retainedAttemptOf } from '../dist/review/retained.js';
import { canonicalDigest } from '../dist/policy/digest.js';
import { canonicalJsonBytes } from '../dist/store/objects.js';
import { validateEnvelope } from '../dist/index.js';

const sha = (b: Uint8Array | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const bytes = (s: string) => Uint8Array.from(Buffer.from(s));

function failedAttempt(over: Record<string, unknown> = {}) {
  const completed = (over.completed as boolean | undefined) ?? true;
  return {
    disclosure: 'private-only' as const,
    withholding: 'accepted-secret-fold-before-read' as const,
    failure: 'sentinel.provider.budgetExhausted',
    completed,
    finalAnswer: '{"observations":[]}',
    filesRead: ['src/server/auth.ts'],
    tools: [{ tool: 'Read', path: 'src/server/auth.ts' }],
    transcript: bytes('{"type":"system"}\n'),
    share: bytes('# Session\n'),
    instructions: bytes('Review the inputs.\n'),
    task: 'Review src/server/auth.ts.',
    provenance: {
      mode: 'native' as const,
      runner: 'claude-cli' as const,
      runnerVersion: '2.1.282',
      profileId: 'claude-code-2.1.282-darwin-arm64-native-v1',
      executableDigest: sha('claude'),
      installation: { source: 'path', executablePath: '/original/bin/claude' },
      model: {
        requested: 'claude-sonnet-5-5',
        reported: 'claude-sonnet-5-5',
        identitySource: 'host-reported' as const,
      },
      promptDigest: sha('Review the inputs.\n'),
      skillDigests: [],
      turns: 3,
      tokens: completed
        ? { input: 9000, output: 100, certainty: 'confirmed' as const }
        : { input: null, output: null, certainty: 'uncertain' as const },
      cost: completed
        ? { basis: 'unobserved' as const, reason: 'subscription' as const }
        : { basis: 'unobserved' as const, reason: 'usage-unknown' as const },
      deadline: { grantedMs: 180000, usedMs: 4000 },
      where: 'sandboxed-cli' as const,
    },
    instructionRecord: {
      schema: 'sentinel-native-instructions/draft-1' as const,
      disclosure: 'private-only' as const,
      withholding: 'accepted-secret-fold-before-read' as const,
      stage: 'review-general',
      instructions: { ref: null, digest: sha('Review the inputs.\n'), bytes: bytes('Review the inputs.\n') },
      inputs: [{ relativePath: 'src/server/auth.ts', digest: sha('export const a = 1;\n') }],
      task: { digest: sha('Review src/server/auth.ts.'), text: 'Review src/server/auth.ts.' },
      skills: [],
      packs: [],
    },
    ...over,
  } as any;
}

test('a refused run keeps one private record that links its stream, session export and instructions by handle', () => {
  const failed = failedAttempt();
  const { record, artifacts } = retainedAttemptOf(failed);
  assert.equal(record.schema, ATTEMPT_RETAINED_SCHEMA);
  const checked = validateEnvelope('attemptretained', record);
  assert.ok(checked.ok, JSON.stringify(!checked.ok && checked.errors));
  assert.deepEqual(
    [record.privacy, record.disclosure, record.withholding, record.failure, record.completed, record.truncated],
    ['source', 'private-only', 'accepted-secret-fold-before-read', 'sentinel.provider.budgetExhausted', true, false],
  );
  // The owner record keeps the exact executable path; the instruction record keeps digests, never bytes.
  assert.equal(record.provenance.installation?.executablePath, '/original/bin/claude');
  assert.equal(JSON.stringify(record.instructionRecord).includes('bytes'), false);
  assert.deepEqual(
    record.links.map((l) => [l.role, l.handle, l.bytes, l.privacy]),
    [
      ['transcript', sha(failed.transcript), failed.transcript.byteLength, 'source'],
      ['share', sha(failed.share), failed.share.byteLength, 'source'],
      ['instructions', sha(failed.instructions), failed.instructions.byteLength, 'source'],
    ],
  );
  // The record first, under its canonical identity, linking the three byte artifacts; every one `source`.
  const [own, ...linked] = artifacts;
  assert.equal(own!.id, canonicalDigest(record));
  assert.deepEqual(Buffer.from(own!.bytes), canonicalJsonBytes(record));
  assert.deepEqual(
    own!.links,
    record.links.map((l) => l.handle),
  );
  assert.deepEqual(
    linked.map((a) => [a.id, sha(a.bytes), a.schema]),
    record.links.map((l) => [l.handle, l.handle, l.schema]),
  );
  assert.ok(artifacts.every((a) => a.privacy === 'source'));
  // No path names a retained artifact: only handles reach the record.
  assert.equal(
    record.links.some((l) => (l as any).path !== undefined),
    false,
  );
});

test('a run stopped before completing links no empty session export, and its cost stays unknown', () => {
  const { record, artifacts } = retainedAttemptOf(
    failedAttempt({
      completed: false,
      finalAnswer: null,
      share: new Uint8Array(),
      failure: 'sentinel.provider.malformedResponse',
    }),
  );
  assert.ok(validateEnvelope('attemptretained', record).ok);
  assert.deepEqual(
    record.links.map((l) => l.role),
    ['transcript', 'instructions'],
  );
  assert.equal(artifacts.length, 3);
  assert.deepEqual(record.provenance.cost, { basis: 'unobserved', reason: 'usage-unknown' });
  assert.equal(record.finalAnswer, null);
});

test('an over-long answer or tool list is cut to the contract and says so; the transcript keeps the whole', () => {
  const { record } = retainedAttemptOf(
    failedAttempt({
      finalAnswer: 'x'.repeat(300000),
      tools: Array.from({ length: 5000 }, (_, i) => ({ tool: 'Read', path: `f${i}.ts` })),
    }),
  );
  assert.ok(validateEnvelope('attemptretained', record).ok);
  assert.equal(record.truncated, true);
  assert.equal(record.finalAnswer!.length, 262144);
  assert.equal(record.tools.length, 4096);
});

test('a NativeRunFailure carries its record for the store beside the raw failed attempt', () => {
  const failed = failedAttempt();
  const failure = new NativeRunFailure('sentinel.provider.budgetExhausted', failed, new Error('over budget'));
  assert.equal(failure.retained, failed);
  assert.ok(failure.record);
  assert.deepEqual(failure.record.record, retainedAttemptOf(failed).record);
  // A record that cannot be built leaves the refusal standing, with no record.
  const broken = new NativeRunFailure(
    'sentinel.provider.budgetExhausted',
    failedAttempt({ failure: 'not a key' }),
    null,
  );
  assert.equal(broken.code, 'sentinel.provider.budgetExhausted');
  assert.equal(broken.record, null);
});

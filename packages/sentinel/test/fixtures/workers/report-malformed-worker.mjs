// Original inert protocol fixture: a genuine accepted worker output with invalid JSON, UTF-8 or findings shape. This tests the
// report consuming boundary, not the worker's ability to attest semantics; no application code is executed.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const protocol = 'sentinel-worker/draft-1';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const input = createInterface({ input: process.stdin });
send({ protocol, type: 'hello', supported: [protocol], adapterId: process.env.SENTINEL_ADAPTER_ID, adapterDigest: process.env.SENTINEL_ADAPTER_DIGEST });
for await (const text of input) {
  const start = JSON.parse(text);
  if (start.type !== 'start') continue;
  const bytes = globalThis.PAYLOAD === 'object' ? Buffer.from(JSON.stringify({ schema: 'not-the-preview-schema', findings: [] }))
    : globalThis.PAYLOAD === 'shape' ? Buffer.from(JSON.stringify({ schema: 'sentinel-preview-findings/draft-1', checks: start.checks, findings: [] }))
      : globalThis.PAYLOAD === 'json' ? Buffer.from('{broken') : Buffer.from([0x7b, 0xff, 0x7d]);
  const hex = createHash('sha256').update(bytes).digest('hex');
  const id = `sha256:${hex}`;
  writeFileSync(`${process.env.SENTINEL_OUTPUT}/${hex}`, bytes);
  send({ protocol, type: 'result', attemptId: start.attemptId, work: start.work, coordinatorEpoch: start.coordinatorEpoch, seq: 0,
    inputFingerprint: start.inputFingerprint, granularity: 'per-file-per-rule', artifacts: [{ id, mediaType: 'application/json', bytes: bytes.length }],
    observations: [id], coveredChecks: start.checks.map(checkId => ({ checkId, coverage: id })), scannedSet: start.scopes,
    skipped: [], actualReadSet: start.scopes, unresolvedFrontiers: [], diagnostics: [] });
  input.close();
  break;
}

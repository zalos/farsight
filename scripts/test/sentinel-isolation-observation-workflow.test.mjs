import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
const job = workflow.slice(workflow.indexOf('  sentinel-isolation:'), workflow.indexOf("  # Sentinel's crash recovery"));
test('normal isolation gate keeps original seven-file command, concurrency, pins and strict assertions', () => {
  const command = 'test/execution-isolation.test.ts test/execution-protocol.test.ts test/execution-container-faults.test.ts test/execution-framing-budget.test.ts test/execution-container-recovery.test.ts test/secrets-conformance.test.ts test/gitleaks-cli.test.ts';
  assert.ok(job.includes(command));assert.doesNotMatch(job, /--test-concurrency/);
  assert.ok(job.includes('node@sha256:ebc216c22db53dbde85719a874978d5aec04e6e405ad26a3804c6f9abc4ca1a9'));
  assert.ok(job.includes('ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f'));
  for (const counter of ['skipped', 'fail', 'cancelled']) assert.ok(job.includes(`grep -qx '# ${counter} 0' isolation.tap`));
  assert.ok(job.includes('node scripts/test-sentinel-secrets-consumer.mjs'));
});
test('observation controls and real native provenance preflight precede canaries and preserve failures', () => {
  assert.ok(job.indexOf('test/isolation-diagnostic-controls.test.ts') < job.indexOf('Isolation canaries and the worker protocol'));
  assert.ok(job.indexOf('...await diagnosticProvenance()') < job.indexOf('Isolation canaries and the worker protocol'));
  assert.ok(job.includes("SENTINEL_ISOLATION_DIAGNOSTIC: '1'"));
  assert.ok(job.includes('runner-preflight-failure.json'));assert.ok(job.includes('throw error;'));
  assert.match(job, /if: always\(\)[\s\S]*uses: actions\/upload-artifact@v7/);
  assert.match(job, /retention-days: 3/);assert.match(job, /if-no-files-found: error/);
  assert.ok(job.includes('packages/sentinel/isolation.tap'));assert.ok(job.includes('packages/sentinel/isolation-diagnostic-controls.tap'));
  assert.doesNotMatch(job, /continue-on-error|sudo|docker (?:system prune|rm)|pkill|killall/);
});

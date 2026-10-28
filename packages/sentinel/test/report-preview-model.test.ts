import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPreviewReport, previewLimitationsOf, renderPreviewMarkdown } from '../dist/reports/preview.js';

test('preview limitations name a published model review without claiming that none ran', () => {
  const doc = {
    schema: 'sentinel-preview-report/draft-1',
    label: 'foundation-preview',
    runId: 'run-fixture',
    snapshotId: 'snap-fixture',
    ledgerSequence: 1,
    generatedAt: '2026-10-28T00:00:00Z',
    counts: [],
    limitations: previewLimitationsOf(true),
  } as const;
  assert.doesNotThrow(() => checkPreviewReport(doc));
  const markdown = renderPreviewMarkdown(doc);
  assert.match(markdown, /A model review ran/);
  assert.doesNotMatch(markdown, /No pinned scanner, framework check or model review ran/);
  assert.deepEqual(previewLimitationsOf(false), ['sentinel.report.previewOnly', 'sentinel.report.noScannerCoverage']);
  assert.throws(
    () =>
      checkPreviewReport({ ...doc, limitations: [...previewLimitationsOf(true), 'sentinel.report.noScannerCoverage'] }),
    /sentinel.report.invalid/,
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from '../dist/cli/args.js';
import { openStore } from '../dist/store/index.js';
import { digestOf } from '../dist/store/ledger-json.js';
import { evidenceLedgerFor } from '../dist/store/evidence-binding.js';
import { acceptReportImportFiles } from '../dist/evidence/accept.js';
import { evidenceIo } from '../dist/evidence/test-hooks.js';
import {
  IMPORT_CLI_LIMITS,
  ownerEvidenceCommand,
  renderImportDocument,
  evidenceWire,
} from '../dist/evidence/owner-cli.js';
import { countedProblems } from '@farsight/core/dist/counts.js';
import { validateEnvelope } from '../dist/validate.js';
import { acceptFixture, timing, confirm, report } from './evidence-acceptance-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const names = (s: any) => readdirSync(s.book.directory).sort();
function call(s: any, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, 'evidence', ...args, '--workspace', s.ws.path, '--json'], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, XDG_STATE_HOME: join(s.dir, 'owner-state') },
  });
  assert.equal(r.error, undefined);
  return { status: r.status, body: JSON.parse(r.stdout), stderr: r.stderr };
}
const command = (...argv: string[]) => {
  const p = parseArgs(['evidence', ...argv, '--json']);
  assert.ok(p.ok);
  return p.parsed;
};
const importing = (s: any) => [
  'import',
  s.ancestor.runId,
  '--source',
  s.ancestor.sourceId,
  '--report',
  s.files.reportPath,
  '--manifest',
  s.files.manifestPath,
];

test('evidence subcommands reject unrelated flags, unsupported output and raw argument diagnostics', () => {
  for (const args of [
    ['read', 'sha256:' + 'a'.repeat(64), '--confirm'],
    ['list', 'run', '--source', 'app', '--report', 'private'],
    ['abandon', 'old', '--baseline', 'run'],
    ['import', 'r', '--actor', 'human'],
  ])
    assert.equal(parseArgs(['evidence', ...args]).ok, false);
  const secret = 'original-private-member';
  const r = spawnSync(process.execPath, [CLI, 'evidence', 'read', 'x', '--' + secret, 'value', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 3);
  assert.equal((r.stdout + r.stderr).includes(secret), false);
});

test(
  'live genuine owner refuses busy before inputs, receipt or import effects; denied policy precedes unreadable inputs',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t),
      before = names(s),
      seq = s.store.ledger.currentSequence();
    const busy = call(s, ...importing(s), '--confirm');
    assert.equal(busy.status, 3);
    assert.equal(busy.body.reasonCode, 'sentinel.evidence.ownerBusy');
    assert.deepEqual(names(s), before);
    assert.equal(s.store.ledger.currentSequence(), seq);
    s.settings(['run.start']);
    const deniedBefore = names(s);
    s.store.close();
    const denied = call(
      s,
      'import',
      s.ancestor.runId,
      '--source',
      'app',
      '--report',
      '/missing-original-input',
      '--manifest',
      '/missing-original-manifest',
      '--confirm',
    );
    assert.equal(denied.status, 3);
    assert.equal(denied.body.reasonCode, 'sentinel.evidence.denied');
    assert.deepEqual(names(s), deniedBefore, 'denied imports issue and spend nothing');
    const reopened = await openStore(s.ws.storePath);
    try {
      assert.equal(
        evidenceLedgerFor(reopened).page(
          digestOf({ domain: 'report-import', storeId: reopened.storeId, ancestor: s.ancestor }),
          null,
          100,
        ).length,
        0,
      );
      assert.equal(reopened.ledger.listOpenStages(100, { domain: 'evidence' }).length, 0);
    } finally {
      reopened.close();
    }
  },
);

test(
  'public executable previews, confirms once, reuses, reads source-gone, lists exact metadata and preserves acceptance on failed export',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t);
    s.store.close();
    const before = names(s);
    const preview = call(s, ...importing(s));
    assert.equal(preview.status, 4);
    assert.deepEqual(names(s), before);
    const digest = preview.body.facts.candidateDigest;
    assert.match(digest, /^sha256:/);
    const stale = call(s, ...importing(s), '--confirm', '--expect-candidate', 'sha256:' + 'f'.repeat(64));
    assert.equal(stale.body.reasonCode, 'sentinel.evidence.confirmationStale');
    assert.deepEqual(names(s), before);
    const accepted = call(s, ...importing(s), '--confirm', '--expect-candidate', digest);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.body.outcome, 'accepted');
    assert.equal(accepted.body.facts.acceptance, 'accepted');
    assert.equal(accepted.body.facts.document.withheld, false);
    assert.equal(validateEnvelope('importview', accepted.body.facts.document).ok, true);
    for (const c of Object.values(accepted.body.facts.document.counts)) assert.deepEqual(countedProblems(c as any), []);
    const spent = names(s).filter((n) => n.endsWith('.spent')).length;
    const reused = call(s, ...importing(s), '--confirm');
    assert.equal(reused.body.facts.reused, true);
    assert.equal(names(s).filter((n) => n.endsWith('.spent')).length, spent);
    const path = join(s.dir, 'original-existing.md');
    writeFileSync(path, 'unchanged');
    const failed = call(s, ...importing(s), '--confirm', '--format', 'md', '--out', path);
    assert.equal(failed.status, 3);
    assert.equal(failed.body.outcome, 'delivery-failed');
    assert.equal(failed.body.facts.acceptance, 'accepted');
    assert.equal(failed.body.facts.candidateDigest, digest);
    assert.equal(readFileSync(path, 'utf8'), 'unchanged');
    assert.ok(Buffer.byteLength(JSON.stringify(failed.body)) <= IMPORT_CLI_LIMITS.ackBytes);
    assert.equal(existsSync(s.repo), false, 'original capture fixture already removed its live source');
    assert.equal(existsSync(s.otherRepo), false);
    const read = call(s, 'read', digest);
    assert.equal(read.status, 0);
    assert.equal(read.body.outcome, 'read');
    assert.deepEqual(read.body.facts.document, accepted.body.facts.document);
    const md = join(s.dir, 'new.md'),
      written = call(s, 'read', digest, '--format', 'md', '--out', md);
    assert.equal(written.status, 0);
    assert.equal(written.body.facts.delivery, 'written');
    assert.equal(JSON.stringify(written.body).includes(md), false);
    assert.match(readFileSync(md, 'utf8'), /Imported claims/);
    const listed = call(s, 'list', s.ancestor.runId, '--source', 'app', '--limit', '1');
    assert.equal(listed.status, 0);
    assert.equal(listed.body.facts.document.items.length, 1);
    assert.equal(listed.body.facts.document.items[0].candidateDigest, digest);
    assert.equal(listed.body.facts.document.items[0].availability, 'not-evaluated');
    assert.equal(listed.body.facts.document.next, null);
    const foreign = call(s, 'list', s.ancestor.runId, '--source', 'other');
    assert.equal(foreign.status, 0);
    assert.deepEqual(foreign.body.facts.document.items, []);
    assert.equal(call(s, 'read', digest, '--format', 'sarif').body.reasonCode, 'sentinel.evidence.inputRefused');
    const unverified = 'sha256:' + 'e'.repeat(64),
      missing = call(s, 'read', unverified);
    assert.equal(missing.status, 3);
    assert.equal(
      JSON.stringify(missing.body).includes(unverified),
      false,
      'unverified generated-looking input is not exported as generated metadata',
    );
  },
);

test(
  'changed original bytes between preparation and receipt spend are refused without consuming the receipt',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t),
      preview = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() });
    assert.equal(preview.status, 'awaiting-confirmation');
    const receiptId = confirm(s, preview.binding);
    writeFileSync(
      s.files.reportPath,
      JSON.stringify({ ...report, runs: [{ ...report.runs[0], tool: { driver: { name: 'changed-original' } } }] }),
    );
    const done = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, {
      timing: timing(),
      receiptId,
      expectCandidate: preview.binding!.intent.input,
    });
    assert.equal(done.status, 'confirmationStale');
    assert.equal(existsSync(join(s.book.directory, receiptId + '.spent')), false);
  },
);

test(
  'metadata cursor is scoped and bounded; exact old pending operation can be explicitly abandoned through executable',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t);
    let operationId = '';
    const previous = evidenceIo.after;
    evidenceIo.after = (point) => {
      if (point === 'after-stage') throw Error('original interrupted operation');
    };
    try {
      const p = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, { timing: timing() });
      assert.equal(p.status, 'awaiting-confirmation');
      const done = await acceptReportImportFiles(s.store, s.ws, s.ancestor, s.files, {
        timing: timing(),
        receiptId: confirm(s, p.binding),
      });
      assert.equal(done.status, 'spentNotPublished');
      operationId = (done as any).operationId;
    } finally {
      evidenceIo.after = previous;
    }
    const stages = s.store.ledger.listOpenStages(100, { domain: 'evidence' });
    assert.equal(stages.length, 1);
    s.store.close();
    assert.equal(call(s, 'abandon', operationId).status, 4);
    const abandoned = call(s, 'abandon', operationId, '--confirm');
    assert.equal(abandoned.status, 0);
    assert.equal(abandoned.body.outcome, 'abandoned');
    assert.equal(abandoned.body.facts.objectBytesDeleted, false);
    const reopened = await openStore(s.ws.storePath);
    try {
      assert.equal(reopened.ledger.listOpenStages(100, { domain: 'evidence' }).length, 0);
      assert.equal(evidenceLedgerFor(reopened).operation(operationId)!.state, 'aborted');
    } finally {
      reopened.close();
    }
    const listed = call(s, 'list', s.ancestor.runId, '--source', 'app');
    assert.equal(listed.body.facts.document.items[0].state, 'aborted');
    assert.equal(call(s, 'list', s.ancestor.runId, '--source', 'app', '--after', 'not-a-cursor').status, 3);
    assert.equal(
      call(s, 'list', s.ancestor.runId, '--source', 'app', '--limit', '101').body.reasonCode,
      'sentinel.evidence.inputRefused',
    );
  },
);

test(
  'two real accepted candidates page by bound cursor, and foreign-source cursor cannot select its rows',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t);
    s.store.close();
    assert.equal(call(s, ...importing(s), '--confirm').status, 0);
    writeFileSync(
      s.files.reportPath,
      JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'second-original' } }, results: [] }] }),
    );
    assert.equal(call(s, ...importing(s), '--confirm').status, 0);
    const first = call(s, 'list', s.ancestor.runId, '--source', 'app', '--limit', '1');
    assert.equal(first.status, 0);
    const cursor = first.body.facts.document.next;
    assert.ok(cursor);
    const next = call(s, 'list', s.ancestor.runId, '--source', 'app', '--limit', '1', '--after', cursor);
    assert.equal(next.status, 0);
    assert.equal(next.body.facts.document.next, null);
    assert.notEqual(next.body.facts.document.items[0].operationId, first.body.facts.document.items[0].operationId);
    assert.equal(call(s, 'list', s.ancestor.runId, '--source', 'other', '--after', cursor).status, 3);
  },
);

test(
  'recorded acceptance with failed readback has a bounded uncertain acknowledgement and can be read without another spend',
  needsStore,
  async (t) => {
    const s = await acceptFixture(t);
    s.store.close();
    const previous = evidenceIo.after;
    evidenceIo.after = (point) => {
      if (point === 'after-commit') throw Error('original lost acknowledgement');
    };
    let output;
    try {
      output = await ownerEvidenceCommand(s.ws, command(...importing(s), '--confirm'));
    } finally {
      evidenceIo.after = previous;
    }
    assert.equal(output.result.reasonCode, 'sentinel.evidence.acceptedReadbackUnverified');
    assert.equal(output.result.facts.acceptance, 'recorded-unverified');
    assert.ok(Buffer.byteLength(JSON.stringify(output.result)) <= IMPORT_CLI_LIMITS.ackBytes);
    const spent = names(s).filter((n) => n.endsWith('.spent')).length;
    const read = call(s, 'read', String(output.result.facts.candidateDigest));
    assert.equal(read.status, 0);
    assert.equal(names(s).filter((n) => n.endsWith('.spent')).length, spent);
  },
);

test('render bound is exact for pretty JSON; Markdown preserves data in inert indented code', () => {
  const base: any = JSON.parse(readFileSync(new URL('./contracts/valid/importview.json', import.meta.url), 'utf8'));
  const size = Buffer.byteLength(JSON.stringify({ ...base, document: '' }, null, 2));
  base.document = 'x'.repeat(IMPORT_CLI_LIMITS.outputBytes - size);
  assert.equal(Buffer.byteLength(renderImportDocument(base, 'json')), IMPORT_CLI_LIMITS.outputBytes);
  base.document += 'x';
  assert.throws(() => renderImportDocument(base, 'json'), /too large/);
  base.document = '</pre><script>original</script>\n```';
  const md = renderImportDocument(base, 'md');
  assert.ok(md.includes('<script>'));
  assert.equal(md.includes('&lt;script&gt;'), false);
  assert.deepEqual(
    JSON.parse(
      md
        .split('\n')
        .filter((l) => l.startsWith('    '))
        .map((l) => l.slice(4))
        .join('\n'),
    ),
    base,
  );
  assert.match(md, /no control or coverage/);
});

test('complete wire budget includes wrapper and newline; overflow preserves accepted IDs without emitting caller payload', () => {
  const candidateDigest = 'sha256:' + 'a'.repeat(64),
    root = 'sha256:' + 'b'.repeat(64);
  const base: any = {
    command: 'evidence.import',
    outcome: 'accepted',
    exitCode: 0,
    verdicts: {},
    facts: { acceptance: 'accepted', candidateDigest, root, document: '' },
  };
  const size = Buffer.byteLength(JSON.stringify(base) + '\n');
  base.facts.document = 'x'.repeat(IMPORT_CLI_LIMITS.outputBytes - size);
  const exact = evidenceWire({ result: base }, true);
  assert.equal(Buffer.byteLength(exact.text), IMPORT_CLI_LIMITS.outputBytes);
  assert.equal(exact.result.outcome, 'accepted');
  base.facts.document += 'x';
  const over = evidenceWire({ result: base }, true);
  assert.equal(over.result.outcome, 'delivery-failed');
  assert.equal(over.result.facts.acceptance, 'accepted');
  assert.equal(over.result.facts.candidateDigest, candidateDigest);
  assert.equal(over.result.facts.root, root);
  assert.equal(over.result.facts.document, undefined);
  assert.ok(Buffer.byteLength(over.text) <= IMPORT_CLI_LIMITS.ackBytes + 1);
  const before = JSON.parse(readFileSync(new URL('./contracts/valid/importview.json', import.meta.url), 'utf8'));
  assert.equal(validateEnvelope('importview', { ...before, authority: 'verified-control' }).ok, false);
  assert.equal(validateEnvelope('importview', { ...before, receipt: {} }).ok, false);
});

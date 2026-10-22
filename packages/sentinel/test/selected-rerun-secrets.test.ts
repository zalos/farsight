// Genuine pinned Pattern + Gitleaks publications over original inert source; a selected child may not discard
// already accepted same-capture privacy knowledge merely by holding the secret scanner. No target code executes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../dist/store/index.js';
import { workspaceOf, adoptWorkspaceSettings, adoptedPolicy, promoteRulePack, scratchUnder, removeScratch } from '../dist/service/local.js';
import { initWorkspace } from '../dist/cli/init.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { adoptScannerAsset } from '../dist/service/scanner-assets.js';
import { PATTERN_SUPPORTED_RULES, GITLEAKS_SUPPORTED_RULES } from '../dist/adapters/drivers/index.js';
import { planWorkspaceCanonical, rerunRun, executeRun } from '../dist/service/canonical.js';
import { loadPlan } from '../dist/execution/plans.js';
import { scannerReportOf } from '../dist/reports/scanner.js';
import { assessRun, fullReport, contextIntentFor } from '../dist/service/full-report.js';
import { VALUE, GENERIC_VALUE, absent } from './secrets-helpers.ts';
import { unlock } from './snapshot-helpers.ts';
import { ReceiptBook } from '../dist/policy/receipts.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const native = { skip: process.env.SENTINEL_ISOLATION !== '1' && 'requires existing pinned local Pattern and Gitleaks images; no acquisition' };
for (const hasSecret of [true, false]) test('Pattern-only child respects ' + (hasSecret ? 'accepted same-capture parent secret evidence' : 'a clean accepted secret scan without withholding useful details'), native, async t => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-selected-secrets-')));
  const path = join(dir, 'workspace'); mkdirSync(join(path, 'src'), { recursive: true });
  const source = (secret: boolean) => `export function lookup(id: string) { return db.query("SELECT * FROM invoice WHERE ${secret ? `api_key = '${GENERIC_VALUE}' AND ` : ''}id = " + id); }\n`;
  writeFileSync(join(path, 'src/lookup.ts'), source(hasSecret));
  writeFileSync(join(path, 'src', hasSecret ? `${VALUE}.ts` : 'named.ts'), 'export function named(id: string) { return db.query("SELECT * FROM named WHERE id = " + id); }\n');
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  initWorkspace({ workspace: path, profile: 'scanners' });
  const settingsPath = join(path, '.farsight/sentinel/settings.json'), settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.mandatoryRules = [...PATTERN_SUPPORTED_RULES, ...GITLEAKS_SUPPORTED_RULES].map(r => r.familyId);
  writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now: new Date() }).outcome, 'prepared');
  for (const pack of ['pattern', 'secrets']) assert.equal(promoteRulePack(ws, { packDir: realpathSync.native(builtinPackDir(pack)!), confirm: true, now: new Date() }).outcome, 'prepared');
  for (const id of ['pattern-semgrep', 'secrets-gitleaks']) assert.equal((await adoptScannerAsset(ws, { kind: 'tool', id, confirm: true, now: new Date() })).outcome, 'prepared');
  const adopted = adoptedPolicy(ws); assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath), work = scratchUnder(ws);
  t.after(() => { try { store.close(); } catch { /* closed for the actual CLI read below */ } removeScratch(work); unlock(dir); rmSync(dir, { recursive: true, force: true }); });
  const terms = { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date() };
  const parentId = (await planWorkspaceCanonical(store, terms)).disclosure.runId;
  assert.equal((await executeRun(store, parentId, { scratchRoot: work, trustDir: ws.trustDir })).state, 'completed');
  const parent = await assessRun(store, parentId, { trustDir: ws.trustDir });
  assert.equal(parent.observations.some(o => o.producer.kind === 'scanner' && o.producer.adapterId === 'secrets-gitleaks'), hasSecret, 'real parent accepted exactly the expected secret evidence');
  const now = new Date(), base = { store, workspace: path, trustDir: ws.trustDir, now, disclosure: 'private' as const };
  const parentReport = (await fullReport({ ...base, runId: parentId })).json;
  const parentEvents = JSON.stringify(store.ledger.readEvents({ runId: parentId, limit: 500 }));
  const plan = (await loadPlan(store, parentId)).plan;
  const pattern = plan.units.find(u => u.adapterId === 'pattern-semgrep')!;
  const prepared: any = await rerunRun(store, parentId, [pattern.id], terms), childId = prepared.disclosure.runId;
  assert.equal((await executeRun(store, childId, { scratchRoot: work, trustDir: ws.trustDir })).state, 'completed');
  const child = await assessRun(store, childId, { trustDir: ws.trustDir });
  assert.ok(child.observations.some(o => o.producer.kind === 'scanner' && o.producer.adapterId === 'pattern-semgrep'));
  assert.ok(!child.observations.some(o => o.producer.kind === 'scanner' && o.producer.adapterId === 'secrets-gitleaks'), 'parent findings must never be copied into child findings');
  const nodeId = child.observations.flatMap(o => o.evidence).find(e => e.nodeId)?.nodeId;
  assert.ok(nodeId, 'the genuine finding has a captured parser symbol');
  const label = hasSecret ? GENERIC_VALUE : 'Lookup screen';
  const screen = 'workspace::page::lookup', flow = 'workspace::flow::lookup';
  const loc = { repo: 'workspace', path: 'src/lookup.ts', line: 1 };
  const graph: any = { nodes: [{ id: flow, kind: 'flow', name: label, tags: [] }, { id: screen, kind: 'page', name: label, tags: [], loc },
    { id: nodeId, kind: 'function', name: 'lookup', tags: [], loc }], edges: [{ id: 'renders', kind: 'renders', from: flow, to: screen, meta: { line: 1 } },
    { id: 'calls', kind: 'calls', from: screen, to: nodeId, meta: { line: 1 } }], meta: {} };
  const { intent } = contextIntentFor(child.snapshot, 'workspace', path, graph, 'workspace'); assert.ok(intent);
  const receipts = new ReceiptBook(join(dir, 'context-receipts'));
  const binding: any = { intent, stateDigest: `sha256:${'a'.repeat(64)}`, policyRevision: adopted.policy.revision };
  const receipt = issueReceipt(receipts, { channel: 'owner-cli', principal: 'owner' }, binding, { now, ttlMs: 600000 });
  const authorization = receipts.consume(receipt.id, binding, now);
  const contextual = await fullReport({ ...base, runId: childId, context: { graph, repo: 'workspace', authorization } });
  assert.equal(contextual.context?.binding, 'matched');
  assert.ok(contextual.document.findings.some(f => f.place.screens.length > 0), 'a genuine spent owner receipt places the ordinary finding');
  assert.equal(contextual.withheldForSecrets, hasSecret);
  if (hasSecret) absent(contextual.json, 'known-secret child with genuine context', GENERIC_VALUE);
  else assert.ok(contextual.json.includes(label), 'clean ancestor keeps useful context labels');
  let cleanId: string | undefined;
  if (hasSecret) {
    const againstParent = await fullReport({ ...base, runId: childId, baselineRunId: parentId });
    const parentSecretIds = JSON.parse(parentReport).findings.filter((f: any) => f.ruleFamilyId.startsWith('sentinel.secrets.')).map((f: any) => f.id);
    assert.ok(parentSecretIds.length > 0);
    for (const id of parentSecretIds) assert.equal(againstParent.comparison?.historical.find(h => h.baselineFindingId === id)?.label,
      'unassessed-in-current-scope', 'holding Gitleaks never resolves or reuses its parent findings');
    // A genuinely new clean capture, with this selected child as its explicit comparison baseline. The current run
    // has no own or inherited match: only the baseline's verified selected ancestry supplies the privacy restriction.
    writeFileSync(join(path, 'src/lookup.ts'), source(false));
    rmSync(join(path, 'src', `${VALUE}.ts`));
    cleanId = (await planWorkspaceCanonical(store, terms)).disclosure.runId;
    assert.notEqual(cleanId, parentId);
    assert.equal((await executeRun(store, cleanId, { scratchRoot: work, trustDir: ws.trustDir })).state, 'completed');
    assert.equal((await fullReport({ ...base, runId: cleanId })).withheldForSecrets, false);
  }
  rmSync(join(path, 'src'), { recursive: true });
  const reports = [];
  for (const disclosure of ['shareable', 'private'] as const) reports.push({ disclosure, report: await fullReport({ ...base, runId: childId, disclosure }) });
  t.diagnostic(JSON.stringify(reports.map(({ disclosure, report }) => ({ disclosure, withheld: report.withheldForSecrets, rawValueInJson: report.json.includes(GENERIC_VALUE) }))));
  for (const { disclosure, report } of reports) {
    assert.equal(report.withheldForSecrets, hasSecret, 'a held scanner preserves exactly known same-capture privacy evidence');
    for (const [name, text] of Object.entries({ json: report.json, html: report.html, markdown: report.markdown, sarif: JSON.stringify(report.sarif) })) absent(text, `selected child ${disclosure} ${name}`, GENERIC_VALUE);
    if (disclosure === 'private') assert.equal(report.json.includes('SELECT * FROM invoice'), !hasSecret, 'clean ancestors preserve ordinary excerpts');
    assert.equal(report.document.completeness, 'partial');
  }
  if (cleanId) {
    const compared = await fullReport({ ...base, runId: cleanId, baselineRunId: childId });
    assert.equal(compared.withheldForSecrets, true, 'explicit selected baseline retains ancestor privacy too');
    assert.ok(compared.comparison?.current.length, 'the actual clean capture still has its ordinary SQL finding');
    assert.ok(compared.comparison.current.some(c => c.match?.baselineFindingIds.length), 'comparison pairs only the selected baseline findings');
    absent(compared.json, 'selected-baseline comparison', GENERIC_VALUE);
  }
  assert.equal((await fullReport({ ...base, runId: parentId })).json, parentReport);
  assert.equal(JSON.stringify(store.ledger.readEvents({ runId: parentId, limit: 500 })), parentEvents, 'no ancestor evidence or events changed');
  // A genuinely admitted successor has no execution or publications. It must never replace the exact ancestor
  // revision the selected child pinned, whether that executed revision had matches or was clean.
  const { RuleLockBook } = await import('../dist/service/rule-locks.js');
  const { publicProfile, publicRegistry } = await import('../dist/service/scanner-profile.js');
  const { planAnalysis, plannerAnalysisFrom, plannerLockFrom, plannerPolicyFrom, plannerSnapshotFrom } = await import('../dist/planner/index.js');
  const { admitPlan } = await import('../dist/execution/plans.js');
  const book = new RuleLockBook(ws.trustDir), current = book.current()!, packs = book.packsOf(current.lock);
  const profile = publicProfile(publicRegistry(), new Set(['pattern-semgrep', 'secrets-gitleaks']), packs);
  const future = planAnalysis({ runId: parentId, revision: plan.revision + 1, previous: plan,
    bootstrap: plan.reused, profile: profile.planner, snapshot: plannerSnapshotFrom(parent.snapshot),
    analyses: parent.analyses.map(a => plannerAnalysisFrom(a)), lock: plannerLockFrom(current.lock, packs, current.digest),
    policy: plannerPolicyFrom(adopted.policy), limits: { maxScopesPerWork: 32 } });
  await admitPlan(store, { plan: future, ruleLock: current.lock, policy: adopted.policy, profile: profile.record });
  assert.equal(store.ledger.getRun(parentId)!.planRevision, plan.revision);
  assert.equal(store.ledger.latestPlan(parentId)!.revision, future.revision);
  assert.ok(future.units.every(u => !store.ledger.getPublication({ id: u.id, revision: u.revision })));
  const futureEvents = JSON.stringify(store.ledger.readEvents({ runId: parentId, limit: 500 }));
  const futureFull = await fullReport({ ...base, runId: childId });
  const futureMinimal = await scannerReportOf(store, childId, now);
  t.diagnostic(JSON.stringify({ admittedSuccessor: future.revision, executedParent: plan.revision, withheld: futureFull.withheldForSecrets,
    rawValue: futureFull.json.includes(GENERIC_VALUE), rawFilename: JSON.stringify(futureMinimal).includes(VALUE) }));
  assert.equal(futureFull.withheldForSecrets, hasSecret, 'an unexecuted successor cannot erase executed-ancestor privacy');
  absent(futureFull.json, 'full report after successor admission', GENERIC_VALUE);
  absent(JSON.stringify(futureMinimal), 'minimal report after successor admission', VALUE);
  if (cleanId) assert.equal((await fullReport({ ...base, runId: cleanId, baselineRunId: childId })).withheldForSecrets, true);
  assert.equal(JSON.stringify(store.ledger.readEvents({ runId: parentId, limit: 500 })), futureEvents, 'reporting never advances or executes the future revision');
  if (hasSecret) {
    const ref = plan.units.find(u => u.adapterId === 'secrets-gitleaks')!;
    const output = store.ledger.getPublication({ id: ref.id, revision: ref.revision })!.outputs.find(o => o.schema === 'sentinel-driver-finding/draft-1')!;
    const hex = output.id.slice(7), dir = join(store.storePath, 'objects', 'sha256', hex.slice(0, 2));
    const { readdirSync, unlinkSync, chmodSync, statSync } = await import('node:fs');
    const copies = readdirSync(dir).filter(n => n.startsWith(hex + '.')).map(n => ({ path: join(dir, n), bytes: readFileSync(join(dir, n)), mode: statSync(join(dir, n)).mode & 0o777 }));
    assert.ok(copies.length > 0);
    for (const mode of ['corrupt', 'missing']) {
      for (const copy of copies) {
        if (mode === 'corrupt') { chmodSync(copy.path, 0o600); writeFileSync(copy.path, '[]'); }
        else unlinkSync(copy.path);
      }
      await assert.rejects(fullReport({ ...base, runId: childId }), (e: any) => e.code === 'sentinel.report.evidenceUnbound', 'lost privacy evidence refuses full report');
      await assert.rejects(scannerReportOf(store, childId, now), (e: any) => e.code === 'sentinel.execution.bootstrapEvidence', 'lost privacy evidence refuses minimal report');
      for (const copy of copies) { writeFileSync(copy.path, copy.bytes, { mode: 0o600 }); chmodSync(copy.path, copy.mode); }
    }
  }
  store.close();
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'report', childId, '--json'],
    { cwd: path, env: { ...process.env, XDG_STATE_HOME: join(dir, 'state') }, encoding: 'utf8', timeout: 30000 });
  assert.equal(cli.status, 0, 'the public read answers without executing work');
  const minimal = JSON.parse(cli.stdout).facts.report;
  assert.ok(minimal.observations.length > 0);
  assert.equal(minimal.coverage.complete, false, 'held required checks remain incomplete');
  absent(cli.stdout, 'public minimal selected-child report', VALUE);
  if (!hasSecret) assert.ok(cli.stdout.includes('named.ts'), 'clean ancestor retains useful ordinary file names');
});

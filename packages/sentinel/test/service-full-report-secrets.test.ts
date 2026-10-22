// The full report over a real Gitleaks run: a genuine owner-adopted workspace, an admitted canonical plan, the pinned
// official image in its Linux container (existing locally, never pulled), the coordinator's own accepted publication.
// Faults are injected only at the trusted driver's normalize output, after the real engine ran, never by fabricating
// a publication, store capability or receipt. Original inert synthetic values only; no assertion message prints one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../dist/store/index.js';
import { workspaceOf, adoptedPolicy, adoptWorkspaceSettings, promoteRulePack, scratchUnder, removeScratch } from '../dist/service/local.js';
import { initWorkspace } from '../dist/cli/init.js';
import { planWorkspaceCanonical } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { loadPlan } from '../dist/execution/plans.js';
import { assessRun, fullReport, renderingOf } from '../dist/service/full-report.js';
import { publicRegistry, scannerExecution } from '../dist/service/scanner-profile.js';
import { adoptScannerAsset } from '../dist/service/scanner-assets.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { createCheckDriverRegistry } from '../dist/execution/check-drivers.js';
import { VALUE, GENERIC_VALUE, absent } from './secrets-helpers.ts';
import { unlock } from './snapshot-helpers.ts';

const skip = process.env.SENTINEL_ISOLATION !== '1' && 'requires the existing pinned local Gitleaks image; no acquisition';
const DUPLICATE = `api_key = "${GENERIC_VALUE}"\n`;

/** Every rendering and fact of a report, checked for both synthetic values and the secret-shaped file name. */
function noSecret(r: any, where: string) {
  const all = [r.json, r.markdown, r.html, JSON.stringify(r.sarif), JSON.stringify(r.comparison ?? null), JSON.stringify(r.context)];
  for (const [i, text] of all.entries()) for (const value of [VALUE, GENERIC_VALUE]) absent(text, `${where} rendering ${i}`, value);
}

async function publishedSecrets(t: any, mode: string) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-report-secrets-')));
  const path = join(dir, 'workspace');
  mkdirSync(join(path, 'config'), { recursive: true });
  const files: Record<string, string> = {
    'config/service.env': `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`,
    // Identical bytes in two files: two locations, never one finding.
    'first.txt': DUPLICATE, 'second.txt': DUPLICATE,
    // A file whose name is the secret: matched by name, and its name never printed.
    [VALUE]: 'ordinary safe content\n',
    'clean.txt': 'nothing secret here\n',
  };
  for (const [p, text] of Object.entries(files)) writeFileSync(join(path, p), text);
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  initWorkspace({ workspace: path, profile: 'secrets' });
  assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now: new Date() }).outcome, 'prepared');
  assert.equal(promoteRulePack(ws, { packDir: realpathSync.native(builtinPackDir('secrets')!), confirm: true, now: new Date() }).outcome, 'prepared');
  assert.equal((await adoptScannerAsset(ws, { kind: 'tool', id: 'secrets-gitleaks', confirm: true, now: new Date() })).outcome, 'prepared');
  const adopted = adoptedPolicy(ws); assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath);
  t.after(() => { try { store.close(); } catch { /* closed */ } unlock(dir); rmSync(dir, { recursive: true, force: true }); });
  const work = scratchUnder(ws);
  t.after(() => removeScratch(work));
  const prepared = await planWorkspaceCanonical(store, { workspace: path, trustDir: ws.trustDir, policy: adopted.policy, scratchRoot: work, now: new Date() });
  const runId = prepared.disclosure.runId;
  const registry = publicRegistry();
  const assets = await scannerExecution(store, runId, ws.trustDir, work, registry);
  const driver = assets.drivers.driverFor('secrets-gitleaks')!;
  assert.ok(driver, 'the shipped Gitleaks driver');
  let changed = 0;
  const drivers = createCheckDriverRegistry([{ ...driver, async normalize(ctx: any, v: any) {
    const normalized = await driver.normalize(ctx, v);
    let records = normalized.records;
    const findings = records.filter((r: any) => r.schema === 'sentinel-driver-finding/draft-1');
    assert.ok(findings.length >= 3, 'the real engine found the synthetic secrets before any fault');
    if (mode === 'drop') { records = records.filter((r: any) => r !== findings[0]); changed++; }
    else if (mode !== 'positive') {
      records = records.map((r: any) => {
        if (r !== findings[0]) return r;
        const f: any = structuredClone(r.value);
        const e = f.evidence[0];
        if (mode === 'entry') e.entry = ctx.plan.pins && 0 === e.entry ? 1 : 0;
        else if (mode === 'path') e.relativePath = 'first.txt';
        else if (mode === 'message') f.message = `the value is ${VALUE}`;
        else if (mode === 'kind') f.kind = 'pattern';
        else if (mode === 'checks') f.assignedChecks = [];
        else if (mode === 'producer') f.producer.adapterId = 'pattern-semgrep';
        else if (mode === 'detector') f.producerRuleId = 'made-up-detector';
        else if (mode === 'attempt') f.attemptId = 'attempt-elsewhere';
        else if (mode === 'snapshot') e.snapshotId = 'snap-elsewhere';
        else if (mode === 'span') e.span.endByte = 999999;
        else if (mode === 'rule') f.rule = { familyId: 'sentinel.secrets.other', revisionDigest: `sha256:${'0'.repeat(64)}` };
        else throw new Error(`unknown mode ${mode}`);
        changed++;
        return { ...r, value: f };
      });
    }
    return { ...normalized, records };
  } }], registry);
  const done = await (await Coordinator.open({ ...assets, drivers, store, runId, registry, scratchRoot: work })).run();
  assert.equal(done.state, 'completed');
  assert.ok(mode === 'positive' || changed > 0);
  return { dir, path, ws, store, runId, files };
}

test('real Gitleaks publication: secret findings report with withheld locations, distinct duplicates and no secret in any rendering', { skip }, async t => {
  const f = await publishedSecrets(t, 'positive');
  const a = await assessRun(f.store, f.runId, { trustDir: f.ws.trustDir });
  const secrets = a.observations.filter(o => o.producer.kind === 'scanner' && o.producer.adapterId === 'secrets-gitleaks');
  assert.ok(secrets.length >= 4, 'the content, both duplicates and the name');
  assert.ok(secrets.every(o => o.rule?.familyId === 'sentinel.secrets.current-tree' && o.evidence.every(e => 'location' in e && !('relativePath' in e))));
  // The two identical files cite one content artifact and stay two findings.
  const dupContent = `sha256:${(await import('node:crypto')).createHash('sha256').update(DUPLICATE).digest('hex')}`;
  for (const disclosure of ['shareable', 'private'] as const) {
    const r = await fullReport({ store: f.store, runId: f.runId, workspace: f.path, trustDir: f.ws.trustDir, disclosure, now: new Date() });
    noSecret(r, disclosure);
    absent(r.json, `${disclosure} json`, 'first.txt');
    const docSecrets = r.document.findings.filter((x: any) => x.ruleFamilyId === 'sentinel.secrets.current-tree');
    assert.ok(docSecrets.length >= 4, `${disclosure}: one finding per location`);
    assert.equal(docSecrets.filter((x: any) => x.evidence.some((e: any) => e.content === dupContent)).length, 2, `${disclosure}: identical bytes in two files are two findings`);
    assert.ok(docSecrets.every((x: any) => x.place.binding !== 'matched' && x.evidence.every((e: any) => e.state === 'withheld' && !e.location && !e.excerpt)));
    for (const format of ['md', 'json', 'html', 'sarif'] as const) for (const value of [VALUE, GENERIC_VALUE]) absent(renderingOf(r, format), `${disclosure} ${format}`, value);
  }
  // Delivered without the source: the same document from the store alone.
  const before = await fullReport({ store: f.store, runId: f.runId, workspace: f.path, trustDir: f.ws.trustDir, disclosure: 'shareable', now: new Date('2026-10-22T12:00:00Z') });
  for (const p of Object.keys(f.files)) rmSync(join(f.path, p), { force: true });
  rmSync(join(f.path, 'config'), { recursive: true, force: true });
  const after = await fullReport({ store: f.store, runId: f.runId, workspace: f.path, trustDir: f.ws.trustDir, disclosure: 'shareable', now: new Date('2026-10-22T12:00:00Z') });
  assert.equal(after.json, before.json);
  // A comparison of the run with itself continues every secret finding (stable store-keyed identity) and leaks nothing.
  const self = await fullReport({ store: f.store, runId: f.runId, baselineRunId: f.runId, workspace: f.path, trustDir: f.ws.trustDir, disclosure: 'shareable', now: new Date() });
  noSecret(self, 'compare');
  assert.ok(self.comparison!.current.filter(o => o.label === 'persistent').length >= 4);
  assert.equal(self.comparison!.historical.length, 0);
});

for (const mode of ['drop', 'entry', 'path', 'message', 'kind', 'checks', 'producer', 'detector', 'attempt', 'snapshot', 'span', 'rule']) {
  test(`real Gitleaks publication: a forged or missing secret record (${mode}) refuses the report and prints no secret`, { skip }, async t => {
    const f = await publishedSecrets(t, mode);
    await assert.rejects(fullReport({ store: f.store, runId: f.runId, workspace: f.path, trustDir: f.ws.trustDir, disclosure: 'shareable', now: new Date() }), (e: any) => {
      for (const value of [VALUE, GENERIC_VALUE]) absent(`${e.message} ${JSON.stringify(e.facts ?? {})}`, `refusal (${mode})`, value);
      return e.code === 'sentinel.report.evidenceUnbound';
    });
  });
}
void readFileSync;

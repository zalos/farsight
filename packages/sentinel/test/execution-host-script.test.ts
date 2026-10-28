// The host script stage on the invoice-app example (four of its server files, so the preview has few units): the
// foundation-preview path planned canonically (capture, the
// coordinator's bootstrap operations, the preview analysis), then a revision of the same run planned from a declared
// pipeline that adds a host script reading the preview's findings, admitted with the pipeline and the script's entry
// digest in its profile, and run by the coordinator. The script runs as a child of this process with an empty
// environment over a folder holding only its declared inputs; its output document and its provenance are published.
// Refused at start, never run: an entry whose bytes are not the pinned ones, and any host script while the adopted
// settings leave host scripts off. Each refusal is held on the unit with its reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../dist/store/index.js';
import { adoptedPolicy, adoptWorkspaceSettings, promoteRulePack, workspaceOf } from '../dist/service/local.js';
import { planWorkspaceCanonical } from '../dist/service/canonical.js';
import { builtinPackDir } from '../dist/service/package-paths.js';
import { publicProfile, publicRegistry, scannerExecution } from '../dist/service/scanner-profile.js';
import { RuleLockBook } from '../dist/service/rule-locks.js';
import { initWorkspace } from '../dist/cli/init.js';
import { admitPlan, loadPlan } from '../dist/execution/plans.js';
import { withPipeline } from '../dist/execution/profile.js';
import { createAdapterRegistry } from '../dist/execution/registry.js';
import { retainedBootstrapForReport } from '../dist/execution/retained-bootstrap.js';
import { Coordinator } from '../dist/execution/coordinator.js';
import { impliedPipelineOf } from '../dist/execution/stage-inputs.js';
import { SCRIPT_PROVENANCE_SCHEMA, SCRIPT_RUNNER_DEFINITION } from '../dist/execution/script-runner.js';
import {
  planPipelineAnalysis,
  plannerAnalysisFrom,
  plannerLockFrom,
  plannerPolicyFrom,
  plannerSnapshotFrom,
} from '../dist/planner/index.js';
import { PREVIEW_FINDINGS_SCHEMA } from '../dist/adapters/preview-detector.js';
import { scratchUnder, removeScratch } from './lease-helpers.ts';
import { needsStore, unlock } from './snapshot-helpers.ts';

const EXAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../examples/invoice-app');
const sha = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
/** The coded step: count the findings documents it was given and the findings in them, and say what it could see. */
const ENTRY = Buffer.from(
  [
    "import { readFileSync, readdirSync } from 'node:fs';",
    "const manifest = JSON.parse(readFileSync('inputs.json', 'utf8'));",
    'let documents = 0;',
    'let findings = 0;',
    'for (const input of manifest.inputs)',
    '  for (const file of input.files) {',
    "    const doc = JSON.parse(readFileSync(file, 'utf8'));",
    '    documents += 1;',
    '    findings += (doc.findings ?? []).length;',
    '  }',
    "const folder = readdirSync('.').sort();",
    'const environment = Object.keys(process.env).sort();',
    "process.stdout.write(JSON.stringify({ schema: 'sentinel.notes/v1', documents, findings, folder, environment }));",
    '',
  ].join('\n'),
);
const SERVER_FILES = [
  'package.json',
  ...['invoiceService', 'db', 'routes', 'approvals'].map((f) => `src/server/${f}.ts`),
];
/** What an operating system puts in every process's environment by itself (macOS: the text encoding). */
const OS_INJECTED = new Set(['__CF_USER_TEXT_ENCODING']);
const NOTES = {
  id: 'notes',
  kind: 'script',
  runner: 'host',
  interpreter: 'node',
  entry: 'stages/notes@1#notes.mjs',
  needs: [{ stage: 'preview', output: 'findings' }],
  produces: [{ name: 'notes', schema: 'sentinel.notes/v1' }],
};

/** A run of the invoice-app example whose current revision is the preview plus the host script, not yet run. */
async function scripted(t: any, options: { hostScripts: boolean }) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-host-script-')));
  t.after(() => {
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'ws');
  for (const file of SERVER_FILES) cpSync(join(EXAMPLE, file), join(path, file), { recursive: true });
  const ws = workspaceOf(path, { ...process.env, XDG_STATE_HOME: join(dir, 'state') });
  initWorkspace({ workspace: path });
  const file = join(path, '.farsight/sentinel/settings.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), hostScripts: options.hostScripts }));
  adoptWorkspaceSettings(ws, { confirm: true, now: new Date() });
  promoteRulePack(ws, {
    packDir: realpathSync.native(builtinPackDir('foundation-preview')!),
    confirm: true,
    now: new Date(),
  });
  const adopted = adoptedPolicy(ws);
  assert.ok('policy' in adopted);
  const store = await openStore(ws.storePath);
  t.after(() => {
    try {
      store.close();
    } catch {
      /* closed */
    }
  });
  const work = scratchUnder(store);
  t.after(() => removeScratch(work));
  const planned = await planWorkspaceCanonical(store, {
    workspace: path,
    trustDir: ws.trustDir,
    policy: adopted.policy,
    scratchRoot: work,
    now: new Date(),
  });
  const runId = planned.disclosure.runId;
  const derived = await loadPlan(store, runId, planned.disclosure.revision);
  // The same run's next revision, from a declaration: today's implied pipeline and the host script after the preview.
  const implied = impliedPipelineOf(derived);
  const pipeline = { ...implied, id: 'with-notes', stages: [...implied.stages, NOTES] };
  const base = publicRegistry(ws.trustDir);
  const registry = createAdapterRegistry([...base.ids.map((id) => base.get(id) as any), SCRIPT_RUNNER_DEFINITION]);
  const book = new RuleLockBook(ws.trustDir);
  const current = book.current()!;
  const packs = book.packsOf(current.lock);
  const profile = publicProfile(registry, new Set(), packs);
  const evidence = await retainedBootstrapForReport(store, runId, derived);
  const digest = sha(ENTRY);
  const plan = planPipelineAnalysis({
    runId,
    revision: derived.plan.revision + 1,
    previous: derived.plan,
    bootstrap: derived.plan.reused,
    profile: profile.planner,
    snapshot: plannerSnapshotFrom(evidence.snapshot),
    analyses: evidence.analyses.map((a: any) => plannerAnalysisFrom(a)),
    lock: plannerLockFrom(current.lock, packs, current.digest),
    policy: plannerPolicyFrom(adopted.policy),
    limits: { maxScopesPerWork: 1 },
    pipeline,
    scripts: new Map([['notes', digest]]),
  });
  await admitPlan(store, {
    plan,
    ruleLock: current.lock,
    policy: adopted.policy,
    profile: withPipeline(profile.record, pipeline, [{ stage: 'notes', entry: NOTES.entry, digest }]),
  });
  store.ledger.advanceRunPlan(runId, plan.revision);
  const unit = plan.units.find((u: any) => u.stage === 'notes')!;
  const run = (entries: ReadonlyMap<string, Uint8Array>) =>
    (async () => {
      const coordinator = await Coordinator.open({
        ...(await scannerExecution(store, runId, ws.trustDir, work, registry)),
        store,
        runId,
        registry,
        scratchRoot: work,
        scripts: entries,
      });
      return coordinator.run();
    })();
  return { store, runId, plan, unit, digest, run };
}

test(
  'a host script reads the preview findings it declared, with an empty environment, and publishes its notes and provenance',
  needsStore,
  async (t) => {
    const s = await scripted(t, { hostScripts: true });
    const preview = s.plan.units.filter((u: any) => u.stage === 'check');
    assert.ok(preview.length > 1);
    assert.deepEqual(
      s.unit.dependencies.filter((d: any) => preview.some((u: any) => u.id === d.id)).length,
      preview.length,
      'the script waits for every preview unit',
    );
    const summary = await s.run(new Map([[s.digest, ENTRY]]));
    assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
    const publication = s.store.ledger.getPublication({ id: s.unit.id, revision: 1 })!;
    assert.ok(publication, 'the script unit published');
    const read = async (schema: string) => {
      const o = publication.outputs.find((x: any) => x.schema === schema)!;
      return JSON.parse((await s.store.readArtifact(o.id)).toString('utf8'));
    };
    // What it was given: one findings document per preview unit, nothing else in its folder, no environment.
    let documents = 0;
    let findings = 0;
    for (const u of preview)
      for (const o of s.store.ledger.getPublication({ id: u.id, revision: 1 })!.outputs) {
        if (o.schema !== 'application/json') continue;
        const doc = JSON.parse((await s.store.readArtifact(o.id)).toString('utf8'));
        if (doc.schema !== PREVIEW_FINDINGS_SCHEMA) continue;
        documents += 1;
        findings += doc.findings.length;
      }
    const notes = await read('sentinel.notes/v1');
    assert.deepEqual(
      { ...notes, environment: undefined },
      {
        schema: 'sentinel.notes/v1',
        documents,
        findings,
        folder: ['entry.mjs', 'inputs', 'inputs.json'],
        environment: undefined,
      },
    );
    // Nothing of this process's environment reached the script: only what the operating system adds to every process.
    assert.deepEqual(
      notes.environment.filter((name: string) => !OS_INJECTED.has(name)),
      [],
      JSON.stringify(notes.environment),
    );
    assert.equal(documents, preview.length);
    const provenance = await read(SCRIPT_PROVENANCE_SCHEMA);
    assert.deepEqual(
      {
        kind: provenance.kind,
        stage: provenance.stage,
        where: provenance.where,
        entryDigest: provenance.entryDigest,
        interpreter: [provenance.interpreter.name, provenance.interpreter.version],
        argv: provenance.argv,
        environmentNames: provenance.environmentNames,
        image: provenance.image,
      },
      {
        kind: 'script',
        stage: 'notes',
        where: 'host',
        entryDigest: s.digest,
        interpreter: ['node', process.version],
        argv: ['entry.mjs'],
        environmentNames: [],
        image: null,
      },
    );
    assert.match(provenance.interpreter.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(provenance.read.length, 1 + documents, 'the entry and every input it was given');
    // The invocation accepted with the attempt's start seals the entry, the interpreter and the resolved inputs.
    const attempt = s.store.ledger.getAttempt(publication.attemptId)!;
    const invocation = JSON.parse((await s.store.readArtifact(attempt.envelope.invocation)).toString('utf8'));
    assert.equal(invocation.script.entryDigest, s.digest);
    assert.deepEqual(
      invocation.stageInputs.map((i: any) => [i.state, i.artifacts.length, i.secretFold]),
      [['resolved', documents, 'applied']],
    );
  },
);

test(
  'a changed entry and host scripts left off are refused at start and held with their reason',
  needsStore,
  async (t) => {
    const tampered = await scripted(t, { hostScripts: true });
    const changed = Buffer.concat([ENTRY, Buffer.from('// one more line\n')]);
    const one = await tampered.run(new Map([[tampered.digest, changed]]));
    assert.equal(one.state, 'completed', JSON.stringify(one.failures));
    const row = tampered.store.ledger.getWork({ id: tampered.unit.id, revision: 1 })!;
    assert.deepEqual([row.state, row.reason], ['blocked', 'sentinel.execution.inputMismatch']);
    assert.equal(tampered.store.ledger.countAttempts({ id: tampered.unit.id, revision: 1 }), 0);

    const off = await scripted(t, { hostScripts: false });
    const two = await off.run(new Map([[off.digest, ENTRY]]));
    assert.equal(two.state, 'completed', JSON.stringify(two.failures));
    const held = off.store.ledger.getWork({ id: off.unit.id, revision: 1 })!;
    assert.deepEqual([held.state, held.reason], ['blocked', 'sentinel.execution.featureOff']);
    assert.equal(off.store.ledger.countAttempts({ id: off.unit.id, revision: 1 }), 0);
    // The preview units of both runs published: a refused script holds only itself.
    for (const s of [tampered, off])
      for (const u of s.plan.units.filter((x: any) => x.stage === 'check'))
        assert.ok(s.store.ledger.getPublication({ id: u.id, revision: 1 }));
  },
);

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
import { spawn } from 'node:child_process';
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
/** The declared output schema: a notes document must say what it read. */
const SCHEMA = Buffer.from(
  JSON.stringify({
    type: 'object',
    required: ['schema', 'documents', 'findings', 'folder', 'environment'],
    properties: {
      schema: { const: 'sentinel.notes/v1' },
      documents: { type: 'integer', minimum: 0 },
      findings: { type: 'integer', minimum: 0 },
      folder: { type: 'array', items: { type: 'string' } },
      environment: { type: 'array', items: { type: 'string' } },
      sleeper: { type: 'integer' },
    },
  }),
);
/**
 * The coded step, and around it a descendant that keeps the output stream open and outlives the interpreter; the
 * interpreter lingers long enough for a listing to see its descendant, then exits (`exitAfter`, 0: at once).
 */
const forking = (exitAfter: number) =>
  Buffer.from(
    [
      "import { spawn } from 'node:child_process';",
      "const sleeper = spawn('/bin/sleep', ['30'], { stdio: ['ignore', 'inherit', 'inherit'] });",
      "process.stdout.write(JSON.stringify({ schema: 'sentinel.notes/v1', documents: 0, findings: 0, folder: [], environment: [], sleeper: sleeper.pid }));",
      exitAfter ? `setTimeout(() => process.exit(0), ${exitAfter});` : 'process.exit(0);',
      '',
    ].join('\n'),
  );
const FORKING = forking(400);
/**
 * The coded step, and beside it a descendant in a session of its own (`detached: true`, so not in the interpreter's
 * group) that outlives the interpreter; the interpreter lingers long enough for its tree to be listed, then exits.
 */
const DETACHING = Buffer.from(
  [
    "import { spawn } from 'node:child_process';",
    "const sleeper = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });",
    'sleeper.unref();',
    "process.stdout.write(JSON.stringify({ schema: 'sentinel.notes/v1', documents: 0, findings: 0, folder: [], environment: [], sleeper: sleeper.pid }));",
    'setTimeout(() => process.exit(0), 600);',
    '',
  ].join('\n'),
);
/** Waits until `pid` no longer exists (killed and reaped), or fails after a few seconds. */
async function gone(pid: number, what: string) {
  for (let i = 0; i < 60; i++) {
    try {
      process.kill(pid, 0);
    } catch (e: any) {
      if (e.code === 'ESRCH') return;
      throw e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* ended between the last probe and this one */
  }
  assert.fail(`${what} (pid ${pid}) was still running`);
}
/** A document that names its schema and nothing else the schema requires. */
const BARE = Buffer.from("process.stdout.write(JSON.stringify({ schema: 'sentinel.notes/v1' }));\n");
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
async function scripted(t: any, options: { hostScripts: boolean; entry?: Buffer }) {
  const entryBytes = options.entry ?? ENTRY;
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
  const digest = sha(entryBytes);
  const schemaDigest = sha(SCHEMA);
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
    scripts: new Map([['notes', { entry: digest, schema: schemaDigest }]]),
  });
  await admitPlan(store, {
    plan,
    ruleLock: current.lock,
    policy: adopted.policy,
    profile: withPipeline(profile.record, pipeline, [
      { stage: 'notes', entry: NOTES.entry, digest, schema: { id: 'sentinel.notes/v1', digest: schemaDigest } },
    ]),
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
  /** The bytes the owner supplies: an entry (the adopted one unless given) and the adopted output schema. */
  const supplied = (entry: Buffer = entryBytes) =>
    new Map([
      [digest, entry],
      [schemaDigest, SCHEMA],
    ]);
  return { store, runId, plan, unit, digest, schemaDigest, run, supplied };
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
    const summary = await s.run(s.supplied());
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
        confinement: provenance.confinement,
        interpreterPath: provenance.interpreter.path,
        outputSchema: provenance.outputSchema,
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
        confinement: 'none',
        interpreterPath: process.execPath,
        outputSchema: { id: 'sentinel.notes/v1', digest: s.schemaDigest },
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
    const one = await tampered.run(tampered.supplied(changed));
    assert.equal(one.state, 'completed', JSON.stringify(one.failures));
    const row = tampered.store.ledger.getWork({ id: tampered.unit.id, revision: 1 })!;
    assert.deepEqual([row.state, row.reason], ['blocked', 'sentinel.execution.inputMismatch']);
    assert.equal(tampered.store.ledger.countAttempts({ id: tampered.unit.id, revision: 1 }), 0);

    const off = await scripted(t, { hostScripts: false });
    const two = await off.run(off.supplied());
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

test(
  'a document that only names its schema fails its attempt: it is validated against the pinned schema first',
  needsStore,
  async (t) => {
    const s = await scripted(t, { hostScripts: true, entry: BARE });
    const summary = await s.run(s.supplied());
    assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
    const ref = { id: s.unit.id, revision: 1 };
    assert.equal(s.store.ledger.getPublication(ref), null, 'nothing is published');
    assert.ok(
      summary.failures.some((f: any) => f.work.id === s.unit.id && f.code === 'sentinel.execution.outputMismatch'),
    );
    assert.ok(s.store.ledger.countAttempts(ref) >= 1, 'the attempt ran and failed');
  },
);

test(
  'a descendant keeping the output open cannot hold the attempt: the group is killed when the interpreter exits',
  needsStore,
  async (t) => {
    const s = await scripted(t, { hostScripts: true, entry: FORKING });
    const t0 = performance.now();
    const summary = await s.run(s.supplied());
    const elapsed = performance.now() - t0;
    assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
    const publication = s.store.ledger.getPublication({ id: s.unit.id, revision: 1 })!;
    assert.ok(publication, 'the script published once its interpreter exited');
    const o = publication.outputs.find((x: any) => x.schema === 'sentinel.notes/v1')!;
    const notes = JSON.parse((await s.store.readArtifact(o.id)).toString('utf8'));
    assert.ok(Number.isSafeInteger(notes.sleeper) && notes.sleeper > 0);
    assert.throws(
      () => process.kill(notes.sleeper, 0),
      (e: any) => e.code === 'ESRCH',
      'the sleeper was killed with the group',
    );
    assert.ok(elapsed < 25_000, `the attempt settled in ${Math.round(elapsed)} ms, not after the sleeper's 30 s`);
  },
);

test(
  'a descendant in a group of its own cannot outlive the attempt: the tree listed while it ran is killed at the exit',
  needsStore,
  async (t) => {
    const s = await scripted(t, { hostScripts: true, entry: DETACHING });
    const summary = await s.run(s.supplied());
    assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
    const publication = s.store.ledger.getPublication({ id: s.unit.id, revision: 1 })!;
    assert.ok(publication, 'the script published once its interpreter exited');
    const o = publication.outputs.find((x: any) => x.schema === 'sentinel.notes/v1')!;
    const notes = JSON.parse((await s.store.readArtifact(o.id)).toString('utf8'));
    assert.ok(Number.isSafeInteger(notes.sleeper) && notes.sleeper > 0);
    await gone(notes.sleeper, 'the detached sleeper');
  },
);

test('at the deadline every descendant is killed, one whose parent exited and one in a session of its own', async (t) => {
  const { spawnBounded } = await import('../dist/execution/script-runner.js');
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-host-tree-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The interpreter starts a detached child; the child starts a detached grandchild and exits, so the grandchild's
  // parent is no longer in the tree when the deadline comes. The interpreter itself never exits.
  writeFileSync(
    join(dir, 'child.mjs'),
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const grandchild = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });",
      'grandchild.unref();',
      "writeFileSync('grandchild.pid', String(grandchild.pid));",
      'setTimeout(() => process.exit(0), 500);',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'entry.mjs'),
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const child = spawn(process.execPath, ['child.mjs'], { detached: true, stdio: 'ignore' });",
      'child.unref();',
      "writeFileSync('child.pid', String(child.pid));",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
  const t0 = performance.now();
  await assert.rejects(
    spawnBounded(process.execPath, ['entry.mjs'], dir, {
      signal: new AbortController().signal,
      deadlineMs: 2_000,
      maxOutputBytes: 1_024,
    }),
    (e: any) => e.code === 'sentinel.execution.deadlineExceeded',
  );
  assert.ok(performance.now() - t0 < 10_000, 'the attempt settled after its deadline, not after its descendants');
  await gone(Number(readFileSync(join(dir, 'grandchild.pid'), 'utf8')), 'the grandchild whose parent exited');
});

test('a script tree is its known processes by start time and their descendants, never a reused pid', async () => {
  const { treeOf } = await import('../dist/execution/script-runner.js');
  const table = [
    { pid: 10, ppid: 1, pgid: 10, state: 'S', started: 'a' },
    { pid: 11, ppid: 10, pgid: 10, state: 'S', started: 'b' },
    { pid: 12, ppid: 1, pgid: 12, state: 'S', started: 'c' },
    { pid: 13, ppid: 12, pgid: 12, state: 'S', started: 'd' },
    { pid: 14, ppid: 1, pgid: 14, state: 'S', started: 'reused' },
    { pid: 15, ppid: 14, pgid: 14, state: 'S', started: 'e' },
  ];
  const pids = (rows: any[]) => rows.map((r) => r.pid).sort((a, b) => a - b);
  // The live interpreter (10) and its child; 12 is known by its start, with its child; 14 reuses a known pid.
  const known = new Map([
    [12, 'c'],
    [14, 'old'],
  ]);
  assert.deepEqual(pids(treeOf(table, known, 10)), [10, 11, 12, 13]);
  assert.deepEqual(pids(treeOf(table, known)), [12, 13], 'without the live interpreter, only the known identities');
  assert.deepEqual(pids(treeOf([], known, 10)), []);
});

test('a listed pid that another process took before it was stopped is continued and left alone', async (t) => {
  const { reapTree, SYSTEM_PROCESSES } = await import('../dist/execution/script-runner.js');
  // An unrelated process of this computer's user, not the script's.
  const other = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  other.unref();
  const pid = other.pid!;
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already ended */
    }
  });
  const [real] = await SYSTEM_PROCESSES.rows([pid]);
  assert.ok(real, 'the unrelated process is listed');
  // The listing the reap reads says this pid is a script process that started earlier: by the time it is stopped,
  // the pid belongs to another process (the real one, which started later). The reap re-reads it from the system.
  const listed = { ...real, started: `${real.started} (earlier)` };
  const known = new Map([[pid, listed.started]]);
  // The reader waits (up to 2 s) to see the real process stopped before answering, so the test proves the reap sent
  // SIGSTOP before it read the row again: a stop takes effect when the process next runs, not when it is sent.
  const signalled: string[] = [];
  const reader = {
    table: async () => [listed],
    rows: async (pids: readonly number[]) => {
      let rows = await SYSTEM_PROCESSES.rows(pids);
      for (let i = 0; i < 100 && !rows.every((r: any) => r.state.includes('T')); i++) {
        await new Promise((r) => setTimeout(r, 20));
        rows = await SYSTEM_PROCESSES.rows(pids);
      }
      signalled.push(...rows.map((r: any) => r.state));
      return rows;
    },
  };
  await reapTree(undefined, known, () => false, reader);
  assert.ok(
    signalled.some((s) => s.includes('T')),
    'the reap stopped the pid before reading it again',
  );
  const [after] = await SYSTEM_PROCESSES.rows([pid]);
  assert.ok(after, 'the unrelated process was not killed');
  assert.equal(after.started, real.started);
  assert.ok(!after.state.includes('T'), `the unrelated process was continued (state ${after.state})`);

  // The exited interpreter's group id now names that unrelated process's own group: the group is not signalled, and
  // its leader is not the interpreter first listed, so none of its members is taken for the script's.
  const rows: string[] = [];
  await reapTree(pid, new Map([[pid, listed.started]]), () => false, {
    table: async () => SYSTEM_PROCESSES.rows([pid]),
    rows: async (pids: readonly number[]) => {
      rows.push(...pids.map(String));
      return SYSTEM_PROCESSES.rows(pids);
    },
  });
  assert.deepEqual(rows, [], 'no process of a group another process now leads was stopped or read again');
  const [still] = await SYSTEM_PROCESSES.rows([pid]);
  assert.ok(still && !still.state.includes('T'), 'the unrelated group was neither stopped nor killed');
});

test('a script process still listed as sleeping right after its stop is read again until stopped, then killed', async (t) => {
  const { reapTree, SYSTEM_PROCESSES } = await import('../dist/execution/script-runner.js');
  // A process the script started (recorded by its identity), whose first rows after SIGSTOP still say it sleeps, as
  // /proc can on Linux before the stop takes effect: three reads, as many as the reap's listing rounds, so one read
  // per round would continue it every time and leave it running.
  const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid!;
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already ended */
    }
  });
  const [real] = await SYSTEM_PROCESSES.rows([pid]);
  assert.ok(real);
  const states: string[] = [];
  let reads = 0;
  await reapTree(undefined, new Map([[pid, real.started]]), () => false, {
    table: async () => SYSTEM_PROCESSES.rows([pid]),
    rows: async (pids: readonly number[]) => {
      reads++;
      let rows = await SYSTEM_PROCESSES.rows(pids);
      // The first three reads say it sleeps; later reads are the system's own, once it is seen stopped.
      if (reads <= 3) rows = rows.map((r: any) => ({ ...r, state: 'S' }));
      else
        for (let i = 0; i < 100 && !rows.every((r: any) => r.state.includes('T')); i++) {
          await new Promise((r) => setTimeout(r, 20));
          rows = await SYSTEM_PROCESSES.rows(pids);
        }
      states.push(...rows.map((r: any) => r.state));
      return rows;
    },
  });
  assert.deepEqual(states.slice(0, 3), ['S', 'S', 'S']);
  assert.ok(
    reads >= 4 && states.slice(3).some((x) => x.includes('T')),
    `read again until stopped: ${states.join(',')}`,
  );
  await new Promise((r) => child.once('exit', r));
  assert.equal(child.signalCode, 'SIGKILL', 'the verified, stopped process was killed');
});

test('a Linux process row is read after the command name, which may hold spaces and parentheses', async () => {
  const { procRow } = await import('../dist/execution/script-runner.js');
  const line = '4242 (a (b) c) T 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1234 56\n';
  assert.deepEqual(procRow(4242, line), { pid: 4242, state: 'T', ppid: 1, pgid: 4242, started: 'ticks:987654' });
  assert.equal(procRow(1, '1 (init) S 0'), undefined);
});

test(
  'the limit: a descendant started and left before any listing saw it does not hold the attempt either',
  needsStore,
  async (t) => {
    const s = await scripted(t, { hostScripts: true, entry: forking(0) });
    const t0 = performance.now();
    const summary = await s.run(s.supplied());
    const elapsed = performance.now() - t0;
    assert.equal(summary.state, 'completed', JSON.stringify(summary.failures));
    const publication = s.store.ledger.getPublication({ id: s.unit.id, revision: 1 })!;
    assert.ok(publication, 'the script published once its interpreter exited');
    const o = publication.outputs.find((x: any) => x.schema === 'sentinel.notes/v1')!;
    const notes = JSON.parse((await s.store.readArtifact(o.id)).toString('utf8'));
    // Whether a listing saw this sleeper is a race; if none did, it is left running (the stated limit), so this test
    // ends it by its recorded pid.
    try {
      process.kill(notes.sleeper, 'SIGKILL');
    } catch {
      /* a listing saw it and the reap killed it */
    }
    assert.ok(elapsed < 25_000, `the attempt settled in ${Math.round(elapsed)} ms, not after the sleeper's 30 s`);
  },
);

test("an orphaned group whose leader is gone is not the script's: nothing in it is stopped, read or killed", async (t) => {
  const { reapTree, SYSTEM_PROCESSES } = await import('../dist/execution/script-runner.js');
  // An unrelated group: a shell leads it and starts a sleeper in it, then the shell is killed, so the group keeps its
  // id (the shell's pid) with no leader listed, as a recycled id of an exited interpreter's group would.
  const shell = spawn('/bin/sh', ['-c', '/bin/sleep 30 & echo $!; wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const member = await new Promise<number>((resolve) => shell.stdout!.once('data', (d) => resolve(Number(String(d)))));
  const group = shell.pid!;
  t.after(() => {
    for (const pid of [member, group])
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already ended */
      }
  });
  process.kill(group, 'SIGKILL');
  await new Promise((r) => shell.once('exit', r));
  const [orphan] = await SYSTEM_PROCESSES.rows([member]);
  assert.ok(orphan && orphan.pgid === group, 'the sleeper is still in the group whose leader is gone');
  const read: number[] = [];
  await reapTree(group, new Map(), () => false, {
    table: SYSTEM_PROCESSES.table,
    rows: async (pids: readonly number[]) => {
      read.push(...pids);
      return SYSTEM_PROCESSES.rows(pids);
    },
  });
  assert.deepEqual(read, [], 'no member of the orphaned group was stopped or read again');
  const [after] = await SYSTEM_PROCESSES.rows([member]);
  assert.ok(after && after.started === orphan.started, 'the orphaned member was not killed');
  assert.ok(!after.state.includes('T'), `the orphaned member was not stopped (state ${after.state})`);
});

test('an interpreter is measured before a script runs: its path, its digest and its version', async () => {
  const { interpreterOf, SH_UNVERSIONED } = await import('../dist/execution/script-runner.js');
  const node = interpreterOf('node');
  assert.deepEqual([node.path, node.version], [process.execPath, process.version]);
  assert.equal(node.digest, sha(readFileSync(process.execPath)));
  const sh = interpreterOf('sh');
  assert.equal(sh.path, '/bin/sh');
  assert.equal(sh.digest, sha(readFileSync('/bin/sh')));
  assert.ok(sh.version === SH_UNVERSIONED || sh.version.length > 0);
  assert.notEqual(sh.version, 'posix-sh');
});

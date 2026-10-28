// The declared pipeline (`.farsight/sentinel/pipeline.json`): parsing, the cross-stage checks with their codes, the
// profiles init writes, adoption by digest, the plan gate and the browser's write. Nothing here runs a stage.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkPipeline,
  parsePipeline,
  PipelineError,
  PIPELINE_ERROR_CODES,
  PIPELINE_PATH,
  previewPipeline,
  stageOutputs,
  type PipelineEnvironment,
} from '../dist/app/pipeline.js';
import {
  adoptPipeline,
  loadPipeline,
  NO_PACKS,
  pipelineAdoptionIntent,
  promotedPacks,
  readWorkspacePipeline,
} from '../dist/app/pipeline-adoption.js';
import { promoteStagePack } from '../dist/review/packs.js';
import { profilePipeline } from '../dist/app/pipeline-profiles.js';
import { requireBootstrap, stageModel } from '../dist/planner/pipeline.js';
import { initWorkspace, PROFILES } from '../dist/cli/init.js';
import { DEFAULT_SETTINGS, ReceiptBook, validateEnvelope } from '../dist/index.js';
import type { PipelineDefinition, SettingsEnvelope, StageDefinition } from '../dist/index.js';
import { issueReceipt } from '../dist/policy/owner-receipts.js';
import { adoptionIntent } from '../dist/policy/adoption.js';
import {
  adoptWorkspacePipeline,
  adoptWorkspaceSettings,
  confirmPipelineWrite,
  pipelineGate,
  planWorkspace,
  showWorkspacePipeline,
  workspaceOf,
  writeWorkspacePipeline,
  adoptedPolicy,
} from '../dist/service/local.js';
import { OwnerService, ServiceError } from '../dist/service/owner-service.js';
import { openStore } from '../dist/store/index.js';
import { STRINGS } from '@farsight/core/dist/strings.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const example = (): PipelineDefinition =>
  JSON.parse(readFileSync(here('./contracts/valid/pipeline-example.json'), 'utf8'));
const bytes = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
const scratch = (t: TestContext) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-pipeline-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const refused = (problems: readonly { class: string; code: string }[]) =>
  problems.filter((p) => p.class === 'refused').map((p) => p.code);
const unavailable = (problems: readonly { class: string; code: string }[]) =>
  problems.filter((p) => p.class === 'unavailable').map((p) => p.code);
const pipelineOf = (stages: StageDefinition[], extra: Partial<PipelineDefinition> = {}): PipelineDefinition => ({
  schema: 'sentinel-pipeline/draft-1',
  id: 'p',
  revision: 1,
  stages,
  ...extra,
});
const BOOT: StageDefinition[] = [
  { id: 'capture', kind: 'builtin', operation: 'capture' },
  { id: 'parse', kind: 'builtin', operation: 'parse', needs: ['capture'] },
  { id: 'inventory', kind: 'builtin', operation: 'inventory', needs: ['parse'] },
];
const settingsWith = (extra: Partial<SettingsEnvelope>): SettingsEnvelope => ({ ...DEFAULT_SETTINGS, ...extra });

test('every pipeline code is in the catalog with a define', () => {
  for (const code of PIPELINE_ERROR_CODES) {
    const entry = STRINGS[code];
    assert.ok(entry?.hud && entry.professional && entry.define, code);
  }
});

test('parsing refuses what is not a pipeline, and a credential-shaped value without echoing it', () => {
  const code = (b: Buffer) => {
    try {
      parsePipeline(b);
      return 'parsed';
    } catch (e) {
      assert.ok(e instanceof PipelineError);
      return e.code;
    }
  };
  assert.equal(code(bytes(example())), 'parsed');
  assert.equal(code(Buffer.from('{"schema":')), 'sentinel.pipeline.invalid');
  assert.equal(code(Buffer.from([0xff, 0xfe])), 'sentinel.pipeline.invalid');
  assert.equal(code(bytes({ ...example(), schema: 'sentinel-pipeline/1' })), 'sentinel.pipeline.invalid');
  const secret = 'ghp_' + 'a'.repeat(36);
  const withSecret = example();
  (withSecret.stages[5] as { model: string }).model = secret;
  try {
    parsePipeline(bytes(withSecret));
    assert.fail('accepted a credential-shaped model name');
  } catch (e) {
    assert.ok(e instanceof PipelineError && e.code === 'sentinel.pipeline.credentialValue');
    assert.doesNotMatch(e.message, new RegExp(secret));
  }
});

test('outputs: the walkthrough is wired as walkthrough, scanners make findings and coverage, a model observations', () => {
  const byId = new Map(example().stages.map((s) => [s.id, s]));
  assert.deepEqual(
    stageOutputs(byId.get('walk')!).map((o) => [o.name, o.type]),
    [['walkthrough', 'walkthrough-md']],
  );
  assert.deepEqual(
    stageOutputs(byId.get('secrets')!).map((o) => o.name),
    ['findings', 'coverage'],
  );
  assert.deepEqual(
    stageOutputs(byId.get('triage')!).map((o) => [o.name, o.type, o.schema]),
    [
      ['observations', 'observations', undefined],
      ['triage', 'custom', 'sentinel.triage/v1'],
    ],
  );
});

test('the pipeline-wide and per-stage checks refuse each mistake with its code', () => {
  const cases: Array<[string, PipelineDefinition, string, PipelineEnvironment?]> = [
    [
      'a stage declared twice',
      pipelineOf([...BOOT, { id: 'parse', kind: 'builtin', operation: 'inventory', needs: ['parse'] }]),
      'sentinel.pipeline.duplicateStage',
    ],
    [
      'reading a stage that is not declared',
      pipelineOf([BOOT[0]!, { id: 'parse', kind: 'builtin', operation: 'parse', needs: ['capturer'] }]),
      'sentinel.pipeline.unknownStage',
    ],
    [
      'waiting for a stage that is not declared',
      pipelineOf([...BOOT, { id: 'report', kind: 'builtin', operation: 'report', needs: ['parse'], after: ['x'] }]),
      'sentinel.pipeline.unknownStage',
    ],
    [
      'two stages that wait on each other',
      pipelineOf([
        ...BOOT,
        { id: 'a', kind: 'builtin', operation: 'walkthrough', needs: ['parse'], after: ['b'] },
        { id: 'b', kind: 'builtin', operation: 'report', needs: ['a'] },
      ]),
      'sentinel.pipeline.cycle',
    ],
    [
      'a stage that reads itself',
      pipelineOf([...BOOT, { id: 'r', kind: 'builtin', operation: 'report', needs: ['parse', 'r'] }]),
      'sentinel.pipeline.cycle',
    ],
    [
      'reading an output its stage does not produce',
      pipelineOf([
        ...BOOT,
        { id: 'r', kind: 'builtin', operation: 'report', needs: [{ stage: 'parse', output: 'findings' }] },
      ]),
      'sentinel.pipeline.missingInput',
    ],
    [
      'a scanner with no captured source',
      pipelineOf([
        ...BOOT,
        {
          id: 't',
          kind: 'tool',
          adapter: 'secrets-gitleaks',
          rules: ['sentinel.secrets.current-tree'],
          needs: ['parse'],
        },
      ]),
      'sentinel.pipeline.missingInput',
    ],
    [
      'graph context no workspace supplies',
      pipelineOf([
        ...BOOT,
        {
          id: 'a',
          kind: 'agent',
          mode: 'native',
          runner: 'copilot-cli',
          model: 'm',
          needs: ['parse', 'farsight.secrets'],
        },
      ]),
      'sentinel.pipeline.missingInput',
    ],
    [
      'a scanner reading findings',
      pipelineOf([
        ...BOOT,
        {
          id: 't',
          kind: 'tool',
          adapter: 'secrets-gitleaks',
          rules: ['sentinel.secrets.current-tree'],
          needs: ['capture'],
        },
        {
          id: 'u',
          kind: 'tool',
          adapter: 'pattern-semgrep',
          rules: 'pack:builtin:pattern',
          needs: ['capture', { stage: 't', output: 'findings' }],
        },
      ]),
      'sentinel.pipeline.incompatibleType',
    ],
    [
      'a model stage making coverage',
      pipelineOf([
        ...BOOT,
        {
          id: 'a',
          kind: 'agent',
          mode: 'native',
          runner: 'copilot-cli',
          model: 'm',
          needs: ['parse'],
          produces: ['coverage'],
        },
      ]),
      'sentinel.pipeline.incompatibleType',
    ],
    [
      'a required model stage',
      pipelineOf([
        ...BOOT,
        { id: 'a', kind: 'agent', mode: 'native', runner: 'copilot-cli', model: 'm', needs: ['parse'], required: true },
      ]),
      'sentinel.pipeline.incompatibleType',
    ],
    [
      'a brokered stage with instructions',
      pipelineOf([
        ...BOOT,
        {
          id: 'a',
          kind: 'agent',
          mode: 'brokered',
          runner: 'copilot-cli',
          model: 'm',
          needs: ['parse'],
          instructions: 'stages/a@1#a.md',
        },
      ]),
      'sentinel.pipeline.incompatibleType',
    ],
    [
      'a skill that names a stage pack file',
      pipelineOf([
        ...BOOT,
        {
          id: 'a',
          kind: 'agent',
          mode: 'native',
          runner: 'copilot-cli',
          model: 'm',
          needs: ['parse'],
          skills: ['stages/a@1#a.md'],
        },
      ]),
      'sentinel.pipeline.incompatibleType',
    ],
    [
      'a native stage on a runner without its own loop',
      pipelineOf([...BOOT, { id: 'a', kind: 'agent', mode: 'native', runner: 'ollama', model: 'm', needs: ['parse'] }]),
      'sentinel.pipeline.modeUnsupported',
    ],
    [
      'a native stage through a hosted API',
      pipelineOf([
        ...BOOT,
        { id: 'a', kind: 'agent', mode: 'native', runner: 'hosted-api', model: 'm', needs: ['parse'] },
      ]),
      'sentinel.pipeline.modeUnsupported',
    ],
    [
      "a custom output that takes the name of the stage's own",
      pipelineOf([
        ...BOOT,
        {
          id: 'a',
          kind: 'agent',
          mode: 'native',
          runner: 'copilot-cli',
          model: 'm',
          needs: ['parse'],
          produces: [{ name: 'observations', schema: 'sentinel.notes/v1' }],
        },
      ]),
      'sentinel.pipeline.incompatibleType',
    ],
    [
      'a model stage fanned out per check',
      pipelineOf([
        ...BOOT,
        {
          id: 'a',
          kind: 'agent',
          mode: 'native',
          runner: 'copilot-cli',
          model: 'm',
          needs: ['parse'],
          fanOut: 'per-check',
        },
      ]),
      'sentinel.pipeline.incompatibleType',
    ],
    [
      'a host script while host scripts are off',
      pipelineOf([
        ...BOOT,
        { id: 's', kind: 'script', runner: 'host', interpreter: 'node', entry: 'stages/s@1#run.mjs', needs: ['parse'] },
      ]),
      'sentinel.pipeline.flagDisabled',
      { settings: DEFAULT_SETTINGS },
    ],
    [
      'a Claude stage while the Claude runner is off',
      pipelineOf([
        ...BOOT,
        { id: 'a', kind: 'agent', mode: 'native', runner: 'claude-cli', model: 'm', needs: ['parse'] },
      ]),
      'sentinel.pipeline.flagDisabled',
      { settings: DEFAULT_SETTINGS },
    ],
    [
      'a pipeline that asks for a feature the settings leave off',
      pipelineOf(BOOT, { flags: { 'review.hosted-api': true } }),
      'sentinel.pipeline.flagDisabled',
      { settings: DEFAULT_SETTINGS },
    ],
    [
      'a stage that needs a feature the pipeline itself turns off',
      pipelineOf(
        [...BOOT, { id: 'a', kind: 'agent', mode: 'native', runner: 'copilot-cli', model: 'm', needs: ['parse'] }],
        {
          flags: { 'runner.copilot-cli': false },
        },
      ),
      'sentinel.pipeline.flagDisabled',
    ],
    [
      'a prompt from a pack that is not promoted',
      pipelineOf([
        ...BOOT,
        {
          id: 'a',
          kind: 'agent',
          mode: 'brokered',
          runner: 'copilot-cli',
          model: 'm',
          needs: ['parse'],
          prompt: 'stages/a@1#p.md',
        },
      ]),
      'sentinel.pipeline.unknownPack',
      { pack: NO_PACKS },
    ],
    [
      'a rule pack that is not shipped',
      pipelineOf([
        ...BOOT,
        { id: 't', kind: 'tool', adapter: 'pattern-semgrep', rules: 'pack:builtin:nothing', needs: ['capture'] },
      ]),
      'sentinel.pipeline.unknownPack',
      { rulePack: () => undefined },
    ],
    [
      'an adapter this build does not register',
      pipelineOf([
        ...BOOT,
        { id: 't', kind: 'tool', adapter: 'semgrep', rules: ['sentinel.secrets.current-tree'], needs: ['capture'] },
      ]),
      'sentinel.pipeline.unknownAdapter',
      { adapters: new Map([['secrets-gitleaks', new Set(['sentinel.secrets.current-tree'])]]) },
    ],
    [
      'a rule its adapter does not run',
      pipelineOf([
        ...BOOT,
        {
          id: 't',
          kind: 'tool',
          adapter: 'secrets-gitleaks',
          rules: ['sentinel.sql.concatenated-query-tsjs'],
          needs: ['capture'],
        },
      ]),
      'sentinel.pipeline.unknownRule',
      { adapters: new Map([['secrets-gitleaks', new Set(['sentinel.secrets.current-tree'])]]) },
    ],
  ];
  for (const [name, pipeline, code, env] of cases) {
    assert.ok(validateEnvelope('pipeline', pipeline).ok, `${name}: schema-valid`);
    const problems = checkPipeline(pipeline, env ?? {});
    assert.ok(refused(problems).includes(code), `${name}: wanted ${code}, got ${JSON.stringify(problems)}`);
    for (const p of problems) assert.ok(STRINGS[p.code], `${name}: ${p.code} is cataloged`);
  }
});

test("a pipeline the planner cannot plan is refused by the check too, in the planner's words", () => {
  // The planner's own judgement (stage model, then bootstrap rule): every case here throws there.
  const plannerRefuses = (p: PipelineDefinition) => {
    try {
      requireBootstrap(stageModel(p));
      return false;
    } catch {
      return true;
    }
  };
  const cases: Array<[string, PipelineDefinition, string, string]> = [
    [
      'capture only',
      pipelineOf([{ id: 'capture', kind: 'builtin', operation: 'capture' }]),
      'sentinel.pipeline.bootstrapMissing',
      'parse, inventory',
    ],
    ['no inventory stage', pipelineOf([BOOT[0]!, BOOT[1]!]), 'sentinel.pipeline.bootstrapMissing', 'inventory'],
    [
      'two stages that both capture',
      pipelineOf([...BOOT, { id: 'capture-again', kind: 'builtin', operation: 'capture' }]),
      'sentinel.pipeline.notPlannable',
      'two stages run the capture operation',
    ],
  ];
  for (const [name, pipeline, code, detail] of cases) {
    assert.ok(validateEnvelope('pipeline', pipeline).ok, `${name}: schema-valid`);
    assert.ok(plannerRefuses(pipeline), `${name}: the planner refuses it`);
    const problems = checkPipeline(pipeline, {});
    assert.deepEqual(
      problems.map((p) => [p.class, p.code, p.stage, p.detail]),
      [['refused', code, null, detail]],
      name,
    );
    assert.ok(STRINGS[code], `${name}: ${code} is cataloged`);
  }
  // The other way round: the sound bootstrap passes both.
  assert.equal(plannerRefuses(pipelineOf(BOOT)), false);
  assert.deepEqual(checkPipeline(pipelineOf(BOOT), {}), []);
  // Every profile init writes is plannable, by the same reading.
  for (const profile of PROFILES) assert.equal(plannerRefuses(profilePipeline(profile)), false, profile);
});

test('what the workspace has not made available is reported, not refused', () => {
  const tool: StageDefinition = {
    id: 't',
    kind: 'tool',
    adapter: 'secrets-gitleaks',
    rules: ['sentinel.secrets.current-tree'],
    needs: ['capture'],
  };
  const agent: StageDefinition = {
    id: 'a',
    kind: 'agent',
    mode: 'native',
    runner: 'copilot-cli',
    model: 'gpt-6-luna',
    needs: ['parse'],
  };
  const pipeline = pipelineOf([...BOOT, tool, agent]);
  const env = (extra: Partial<PipelineEnvironment> = {}): PipelineEnvironment => ({
    settings: DEFAULT_SETTINGS,
    adapters: new Map([['secrets-gitleaks', new Set(['sentinel.secrets.current-tree'])]]),
    locked: new Map(),
    installed: new Set(),
    ...extra,
  });
  const none = checkPipeline(pipeline, env());
  assert.deepEqual(refused(none), []);
  assert.deepEqual(unavailable(none), [
    'sentinel.pipeline.notPromoted',
    'sentinel.pipeline.toolNotAdopted',
    'sentinel.pipeline.runnerNotConfigured',
  ]);
  const provider = {
    id: 'copilot',
    kind: 'copilot-cli' as const,
    endpoint: 'https://api.githubcopilot.com',
    credential: null,
    disclosure: 'hosted' as const,
    budget: { maxTokens: 1000, maxCost: null, currency: null },
    models: [{ id: 'luna', model: 'gpt-6-luna', capability: { schema: 'sentinel-model-capability/draft-1' } }],
  } as unknown as SettingsEnvelope['providers'][number];
  const ready = checkPipeline(
    pipeline,
    env({
      settings: settingsWith({ providers: [provider] }),
      locked: new Map([['sentinel.secrets.current-tree', 'secrets-gitleaks']]),
      installed: new Set(['secrets-gitleaks']),
    }),
  );
  assert.deepEqual(ready, []);
  // A local model server binds only an Ollama provider that keeps the source here; it needs no gated feature.
  const local = pipelineOf([
    ...BOOT,
    { id: 'l', kind: 'agent', mode: 'brokered', runner: 'ollama', model: 'qwen3:4b', needs: ['parse'] },
  ]);
  const ollama = (disclosure: 'local-only' | 'hosted') =>
    ({
      ...provider,
      id: 'local',
      kind: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      disclosure,
      models: [{ id: 'q', model: 'qwen3:4b', capability: {} }],
    }) as never;
  assert.deepEqual(checkPipeline(local, { settings: settingsWith({ providers: [ollama('local-only')] }) }), []);
  assert.deepEqual(unavailable(checkPipeline(local, { settings: settingsWith({ providers: [ollama('hosted')] }) })), [
    'sentinel.pipeline.runnerNotConfigured',
  ]);
  // A model the provider lists but the owner never probed and adopted does not bind.
  const unprobed = { ...provider, models: [{ id: 'luna', model: 'gpt-6-luna', capability: null }] } as never;
  assert.deepEqual(
    unavailable(checkPipeline(pipeline, env({ settings: settingsWith({ providers: [unprobed] }) }))).at(-1),
    'sentinel.pipeline.runnerNotConfigured',
  );
});

test('the profiles init writes are sound pipelines; the agentic one names what this build does not have yet', () => {
  for (const profile of PROFILES) {
    const pipeline = profilePipeline(profile);
    assert.ok(validateEnvelope('pipeline', pipeline).ok, profile);
    assert.deepEqual(refused(checkPipeline(pipeline)), [], `${profile}: its own meaning`);
    const here = checkPipeline(pipeline, { settings: DEFAULT_SETTINGS, pack: NO_PACKS });
    if (profile === 'agentic')
      assert.deepEqual([...new Set(refused(here))].sort(), [
        'sentinel.pipeline.flagDisabled',
        'sentinel.pipeline.unknownPack',
      ]);
    else assert.deepEqual(refused(here), [], `${profile}: under the defaults`);
  }
  // The agentic profile is the plan's example with this build's adapter ids.
  const agentic = profilePipeline('agentic');
  assert.deepEqual(
    agentic.stages.map((s) => `${s.id}:${s.kind}`),
    [
      'capture:builtin',
      'parse:builtin',
      'inventory:builtin',
      'secrets:tool',
      'patterns:tool',
      'walk:builtin',
      'review:agent',
      'triage:agent',
      'report:builtin',
    ],
  );
  const runners = agentic.stages.flatMap((s) => (s.kind === 'agent' ? [`${s.mode}:${s.runner}`] : []));
  assert.deepEqual(runners, ['brokered:copilot-cli', 'native:claude-cli']);
  // Under settings that turn the Claude runner on and packs that resolve, it is sound.
  const digest = 'sha256:' + 'a'.repeat(64);
  assert.deepEqual(
    refused(
      checkPipeline(agentic, { settings: settingsWith({ nativeClaudeReviewEnabled: true }), pack: () => digest }),
    ),
    [],
  );
  // The shipped example twin is the agentic profile.
  const twin = JSON.parse(readFileSync(here('../../../.farsight/sentinel/pipeline.example.json'), 'utf8'));
  assert.deepEqual(twin, JSON.parse(JSON.stringify(agentic)));
});

test("init writes each profile's pipeline once, beside its settings, and keeps both after", (t) => {
  for (const profile of PROFILES) {
    const ws = scratch(t);
    const first = initWorkspace({ workspace: ws, profile });
    assert.deepEqual(
      [first.outcome, first.settings.outcome, first.pipeline.outcome],
      ['prepared', 'prepared', 'prepared'],
    );
    const path = join(ws, PIPELINE_PATH);
    assert.equal(first.pipeline.path, path);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), JSON.parse(JSON.stringify(profilePipeline(profile))));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual([first.settings.holds, first.pipeline.holds], [profile, profile]);
    const before = readFileSync(path);
    const second = initWorkspace({ workspace: ws, profile });
    assert.deepEqual([second.outcome, second.settings.outcome, second.pipeline.outcome], ['kept', 'kept', 'kept']);
    assert.deepEqual(readFileSync(path), before);
  }
  // A kept file says which profile it holds; an edited one holds none.
  const ws = scratch(t);
  initWorkspace({ workspace: ws });
  const other = initWorkspace({ workspace: ws, profile: 'scanners' });
  assert.deepEqual([other.outcome, other.settings.holds, other.pipeline.holds], ['kept', 'static', 'static']);
  const p = join(ws, PIPELINE_PATH);
  writeFileSync(p, readFileSync(p, 'utf8').replace('"revision": 1', '"revision": 2'));
  assert.equal(initWorkspace({ workspace: ws }).pipeline.holds, null);
  // An existing pipeline file that is not a pipeline is reported and left as it is.
  writeFileSync(p, 'not json');
  const foreign = initWorkspace({ workspace: ws });
  assert.deepEqual([foreign.outcome, foreign.pipeline.recognised], ['kept', false]);
  assert.equal(readFileSync(p, 'utf8'), 'not json');
});

/** A workspace with initialized, adopted settings and its own private owner state. */
function workspace(t: TestContext, profile = 'static') {
  const root = scratch(t);
  const path = join(root, 'w');
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'src', 'a.ts'), 'export const a = 1;\n');
  const ws = workspaceOf(path, { XDG_STATE_HOME: join(root, 'state') });
  initWorkspace({ workspace: path, profile });
  return ws;
}

test('adoption pins the pipeline digest; a changed byte or an unpromoted pack is not adopted', (t) => {
  const ws = workspace(t);
  const now = new Date();
  assert.equal(loadPipeline({ workspace: ws.path, trustDir: ws.trustDir, readOnly: true }).trust, 'not-adopted');
  const waiting = adoptWorkspaceSettings(ws, { confirm: false, now });
  assert.equal(waiting.outcome, 'awaiting-confirmation');
  const pending = waiting.facts.pipeline as { digest: string };
  assert.match(pending.digest, /^sha256:[0-9a-f]{64}$/);
  // One confirmed owner action adopts the settings and the pipeline, each for its own bytes.
  const adopted = adoptWorkspaceSettings(ws, { confirm: true, now });
  assert.equal(adopted.outcome, 'prepared');
  assert.equal((adopted.facts.pipeline as { digest: string }).digest, pending.digest);
  const loaded = loadPipeline({ workspace: ws.path, trustDir: ws.trustDir });
  assert.deepEqual([loaded.trust, loaded.read?.digest], ['adopted', pending.digest]);
  // A changed byte is no longer adopted; re-adopting pins the new digest.
  const p = join(ws.path, PIPELINE_PATH);
  writeFileSync(p, readFileSync(p, 'utf8').replace('"revision": 1', '"revision": 2'));
  assert.equal(loadPipeline({ workspace: ws.path, trustDir: ws.trustDir }).trust, 'changed');
  assert.equal(adoptWorkspacePipeline(ws, { confirm: false, now }).outcome, 'awaiting-confirmation');
  const again = adoptWorkspacePipeline(ws, { confirm: true, now });
  assert.equal(again.outcome, 'prepared', JSON.stringify(again));
  assert.equal(loadPipeline({ workspace: ws.path, trustDir: ws.trustDir }).trust, 'adopted');
  // The digest covers the bytes of every pack the pipeline names.
  const agentic = profilePipeline('agentic');
  writeFileSync(p, bytes(agentic));
  const a = readWorkspacePipeline(ws.path, () => 'sha256:' + 'a'.repeat(64))!;
  const b = readWorkspacePipeline(ws.path, () => 'sha256:' + 'b'.repeat(64))!;
  assert.equal(a.fileDigest, b.fileDigest);
  assert.notEqual(a.digest, b.digest);
  assert.throws(
    () => pipelineAdoptionIntent(ws.path, NO_PACKS),
    (e: unknown) => e instanceof PipelineError && e.code === 'sentinel.pipeline.unknownPack',
  );
  const refusal = adoptWorkspacePipeline(ws, { confirm: true, now });
  assert.deepEqual([refusal.outcome, refusal.reasonCode], ['configuration-failure', 'sentinel.pipeline.unknownPack']);
});

test('adopting the settings names each feature the adopted pipeline still waits on', (t) => {
  const ws = workspace(t);
  const now = new Date();
  const p = join(ws.path, PIPELINE_PATH);
  const base = profilePipeline('static');
  writeFileSync(
    p,
    bytes({
      ...base,
      stages: [
        ...base.stages,
        {
          id: 'triage',
          kind: 'agent',
          mode: 'native',
          runner: 'claude-cli',
          model: 'claude-sonnet-5-5',
          needs: ['parse'],
        },
      ],
    }),
  );
  const adopted = adoptWorkspaceSettings(ws, { confirm: true, now });
  const pipeline = adopted.facts.pipeline as { digest: string; waitingOn: string[]; problems: { code: string }[] };
  assert.match(pipeline.digest, /^sha256:/, 'the pipeline is adopted as it is');
  assert.deepEqual(pipeline.waitingOn, ['runner.claude-cli']);
  assert.ok(pipeline.problems.some((x) => x.code === 'sentinel.pipeline.flagDisabled'));
});

test('the adopted digest covers the promoted pack bytes: one changed byte undoes the adoption', (t) => {
  const ws = workspace(t);
  const now = new Date();
  assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now }).outcome, 'prepared');
  const packs = here('./fixtures/stage-packs/');
  promoteStagePack(ws.trustDir, join(packs, 'stages/review'), { confirm: true });
  promoteStagePack(ws.trustDir, join(packs, 'skills/invoice-approvals'), { confirm: true });
  const p = join(ws.path, PIPELINE_PATH);
  const base = profilePipeline('static');
  writeFileSync(
    p,
    bytes({
      ...base,
      stages: [
        ...base.stages,
        {
          id: 'review',
          kind: 'agent',
          mode: 'native',
          runner: 'copilot-cli',
          model: 'gpt-6-luna',
          instructions: 'stages/review@1#instructions.md',
          skills: ['skills/invoice-approvals@1'],
          needs: ['parse'],
        },
      ],
    }),
  );
  const adopted = adoptWorkspacePipeline(ws, { confirm: true, now });
  assert.equal(adopted.outcome, 'prepared', JSON.stringify(adopted));
  const loaded = loadPipeline({ workspace: ws.path, trustDir: ws.trustDir, resolve: promotedPacks(ws.trustDir) });
  assert.equal(loaded.trust, 'adopted');
  assert.deepEqual(
    loaded.read!.packs.map((x) => x.ref),
    ['stages/review@1#instructions.md', 'skills/invoice-approvals@1'],
  );
  assert.ok(loaded.read!.packs.every((x) => /^sha256:/.test(x.digest ?? '')));
  // One byte of the promoted instructions changes in the trust folder: the pack no longer resolves, the digest moves,
  // and the adoption no longer holds; plan refuses the stage's pack.
  const file = join(ws.trustDir, 'stage-packs', 'stages', 'review@1', 'instructions.md');
  chmodSync(file, 0o600);
  const original = readFileSync(file);
  const flipped = Buffer.from(original);
  flipped[0] = flipped[0]! ^ 0x01;
  writeFileSync(file, flipped);
  const after = loadPipeline({ workspace: ws.path, trustDir: ws.trustDir, resolve: promotedPacks(ws.trustDir) });
  assert.equal(after.trust, 'changed');
  assert.notEqual(after.read!.digest, loaded.read!.digest);
  const policy = (adoptedPolicy(ws) as { policy: never }).policy;
  assert.equal(
    (pipelineGate(ws, policy) as { refusal: { reasonCode: string } }).refusal.reasonCode,
    'sentinel.pipeline.unknownPack',
  );
  assert.equal(adoptWorkspacePipeline(ws, { confirm: true, now }).reasonCode, 'sentinel.pipeline.unknownPack');
  // The byte restored, the original adoption holds again: the digest is of the bytes, not of the moment.
  writeFileSync(file, original);
  assert.equal(
    loadPipeline({ workspace: ws.path, trustDir: ws.trustDir, resolve: promotedPacks(ws.trustDir) }).trust,
    'adopted',
  );
});

test('a settings receipt cannot adopt the pipeline, nor a pipeline receipt the settings', (t) => {
  const ws = workspace(t);
  const now = new Date();
  mkdirSync(join(ws.trustDir, 'receipts'), { recursive: true, mode: 0o700 });
  const book = new ReceiptBook(join(ws.trustDir, 'receipts'));
  const owner = { principal: 'human', channel: 'owner-cli' } as const;
  const { intent, settingsDigest } = adoptionIntent(ws.path);
  const binding = { intent, stateDigest: settingsDigest, policyRevision: 'sha256:' + '0'.repeat(64) };
  const receipt = issueReceipt(book, owner, binding, { now, ttlMs: 60000 });
  const spent = book.consume(receipt.id, binding, now);
  assert.throws(
    () => adoptPipeline({ workspace: ws.path, trustDir: ws.trustDir, receipt: spent, now }),
    (e: unknown) => e instanceof PipelineError && e.code === 'sentinel.pipeline.adoptionUnauthorized',
  );
  assert.equal(pipelineAdoptionIntent(ws.path).intent.scope.targets.at(-1), 'sentinel.pipeline');
  assert.notDeepEqual(pipelineAdoptionIntent(ws.path).intent, intent);
});

test('plan refuses a cycle, a missing input, a wrong type, a disabled feature and an unknown pack, each with its code', async (t) => {
  const ws = workspace(t);
  const now = new Date();
  assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now }).outcome, 'prepared');
  const p = join(ws.path, PIPELINE_PATH);
  const write = (pipeline: PipelineDefinition, adopt = true) => {
    writeFileSync(p, bytes(pipeline));
    if (adopt) assert.equal(adoptWorkspacePipeline(ws, { confirm: true, now }).outcome, 'prepared');
  };
  const base = profilePipeline('static');
  const cases: Array<[string, PipelineDefinition, string, boolean?]> = [
    [
      'a cycle',
      { ...base, stages: base.stages.map((s) => (s.id === 'capture' ? { ...s, after: ['report'] } : s)) },
      'sentinel.pipeline.cycle',
    ],
    [
      'a missing input',
      {
        ...base,
        stages: base.stages.map((s) =>
          s.id === 'report' ? { ...s, needs: [{ stage: 'preview', output: 'walkthrough' }] } : s,
        ),
      },
      'sentinel.pipeline.missingInput',
    ],
    [
      'an incompatible type',
      {
        ...base,
        stages: base.stages.map((s) =>
          s.id === 'preview' ? { ...s, needs: ['capture', { stage: 'report', output: 'report' }] } : s,
        ),
      },
      'sentinel.pipeline.incompatibleType',
    ],
    [
      'a disabled feature',
      {
        ...base,
        stages: [
          ...base.stages,
          {
            id: 'notes',
            kind: 'script',
            runner: 'host',
            interpreter: 'node',
            entry: 'stages/notes@1#run.mjs',
            needs: ['parse'],
          },
        ],
      },
      'sentinel.pipeline.flagDisabled',
      false,
    ],
    [
      'an unknown pack',
      {
        ...base,
        stages: [
          ...base.stages,
          {
            id: 'review',
            kind: 'agent',
            mode: 'brokered',
            runner: 'copilot-cli',
            model: 'm',
            needs: ['parse'],
            prompt: 'stages/review@3#prompt.md',
          },
        ],
      },
      'sentinel.pipeline.unknownPack',
      false,
    ],
    // What the planner refuses, the plan refuses before anything is captured (planner/pipeline.ts decides).
    [
      'a capture-only pipeline',
      { ...base, stages: base.stages.filter((s) => s.id === 'capture') },
      'sentinel.pipeline.bootstrapMissing',
    ],
    [
      'two capture stages',
      { ...base, stages: [...base.stages, { id: 'capture-again', kind: 'builtin', operation: 'capture' }] },
      'sentinel.pipeline.notPlannable',
    ],
  ];
  for (const [name, pipeline, code, adoptable] of cases) {
    write(pipeline, adoptable !== false);
    const r = await planWorkspace(ws, { confirm: false, now });
    assert.deepEqual([r.outcome, r.reasonCode], ['configuration-failure', code], `${name}: ${JSON.stringify(r)}`);
    assert.equal((r.facts.pipeline as { id: string }).id, 'default', name);
  }
  // Not adopted, or changed since: refused before anything is captured; a sound adopted pipeline passes the gate.
  write(base, false);
  const policy = (adoptedPolicy(ws) as { policy: never }).policy;
  assert.equal(
    (pipelineGate(ws, policy) as { refusal: { reasonCode: string } }).refusal.reasonCode,
    'sentinel.pipeline.changed',
  );
  write(base);
  const gate = pipelineGate(ws, policy) as { facts: { pipeline: { trust: string; problems: { class: string }[] } } };
  assert.equal(gate.facts.pipeline.trust, 'adopted');
  assert.deepEqual(refused(gate.facts.pipeline.problems as never), []);
  const shown = showWorkspacePipeline(ws);
  assert.deepEqual([shown.outcome, shown.facts.trust, shown.facts.stages], ['answered', 'adopted', 5]);
});

test("pipeline.write validates and previews; it writes only on the owner's receipt, never adopts, never overwrites an edit", async (t) => {
  const ws = workspace(t);
  const now = new Date();
  assert.equal(adoptWorkspaceSettings(ws, { confirm: true, now }).outcome, 'prepared');
  const p = join(ws.path, PIPELINE_PATH);
  const { createHash } = await import('node:crypto');
  const digestOf = () => `sha256:${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
  const original = readFileSync(p);
  const scanners = profilePipeline('scanners');
  const owner = (pipeline: unknown, expect: string | null) => {
    const receipt = confirmPipelineWrite(ws, pipeline, expect, now);
    return (binding: never) => {
      void binding;
      return { facts: { receipt } };
    };
  };
  const nobody = () =>
    ({
      refusal: {
        outcome: 'configuration-failure',
        reasonCode: 'sentinel.admission.ownerOnly',
        verdicts: undefined,
        facts: {},
      },
    }) as never;
  // The preview runs nothing: each stage's place in the order, where it would run, its effects, and what it reruns.
  const refusedWrite = writeWorkspacePipeline(ws, scanners, digestOf(), nobody);
  assert.deepEqual([refusedWrite.outcome, refusedWrite.facts.written], ['configuration-failure', false]);
  assert.deepEqual(readFileSync(p), original, 'nothing is written without the owner');
  const preview = refusedWrite.facts.preview as { stages: any[]; removed: string[] };
  assert.deepEqual(
    preview.stages.map((x) => [x.id, x.order, x.where, x.change]),
    [
      ['capture', 0, 'in-process', 'unchanged'],
      ['parse', 1, 'child', 'unchanged'],
      ['inventory', 2, 'child', 'unchanged'],
      ['patterns', 3, 'container', 'added'],
      ['advisories', 4, 'container', 'added'],
      ['infrastructure', 5, 'container', 'added'],
      ['ci', 6, 'container', 'added'],
      ['secrets', 7, 'container', 'added'],
      ['report', 8, 'in-process', 'changed'],
    ],
  );
  assert.deepEqual(preview.removed, ['preview']);
  assert.deepEqual(preview.stages.find((x) => x.id === 'secrets').effects, ['tool-execution', 'local-artifacts']);
  // A broken pipeline is refused before any authority is asked, and the file stays as it was.
  const broken = writeWorkspacePipeline(
    ws,
    { ...scanners, stages: [...scanners.stages, scanners.stages[0]] },
    digestOf(),
    nobody,
  );
  assert.deepEqual(
    [broken.outcome, broken.reasonCode, broken.facts.written],
    ['configuration-failure', 'sentinel.pipeline.duplicateStage', false],
  );
  // With the owner's receipt the bytes are written (0600) and not adopted; a stale expected digest is refused.
  const stale = writeWorkspacePipeline(
    ws,
    scanners,
    'sha256:' + '0'.repeat(64),
    owner(scanners, 'sha256:' + '0'.repeat(64)),
  );
  assert.deepEqual([stale.outcome, stale.reasonCode], ['configuration-failure', 'sentinel.pipeline.changed']);
  const written = writeWorkspacePipeline(ws, scanners, digestOf(), owner(scanners, digestOf()));
  assert.deepEqual([written.outcome, written.facts.written, written.facts.trust], ['prepared', true, 'changed']);
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), JSON.parse(JSON.stringify(scanners)));
  assert.equal(statSync(p).mode & 0o777, 0o600);
  // Through the owner service: an agent alone is refused (an owner action no grant gives it), the owner's receipt for
  // exactly these bytes over exactly this file writes once, and a receipt for other bytes, or spent, writes nothing.
  const store = await openStore(ws.storePath);
  t.after(() => store.close());
  const service = new OwnerService(store, ws);
  const by = { principal: 'agent', channel: 'owner-ui' } as const;
  const secrets = profilePipeline('secrets');
  const before = readFileSync(p);
  const agent = (await service.handle('pipeline.write', { pipeline: secrets, expectDigest: digestOf() }, by)) as any;
  assert.deepEqual(
    [agent.outcome, agent.reasonCode, agent.facts.written],
    ['configuration-failure', 'sentinel.admission.ownerOnly', false],
  );
  assert.deepEqual(readFileSync(p), before);
  const wrong = confirmPipelineWrite(ws, profilePipeline('static'), digestOf(), now);
  const mismatch = (await service.handle(
    'pipeline.write',
    { pipeline: secrets, expectDigest: digestOf(), receiptId: wrong },
    by,
  )) as any;
  assert.deepEqual([mismatch.outcome, mismatch.reasonCode], ['configuration-failure', 'sentinel.receipt.mismatch']);
  const receipt = confirmPipelineWrite(ws, secrets, digestOf(), now);
  const ok = (await service.handle(
    'pipeline.write',
    { pipeline: secrets, expectDigest: digestOf(), receiptId: receipt },
    by,
  )) as any;
  assert.deepEqual([ok.outcome, ok.facts.written], ['prepared', true]);
  assert.match(ok.facts.receipt, /^sha256:/);
  const replay = (await service.handle(
    'pipeline.write',
    { pipeline: secrets, expectDigest: digestOf(), receiptId: receipt },
    by,
  )) as any;
  assert.equal(replay.outcome, 'configuration-failure');
  for (const body of [
    { pipeline: scanners },
    { pipeline: scanners, expectDigest: 'x' },
    { pipeline: [], expectDigest: null },
    { pipeline: scanners, expectDigest: null, adopt: true },
    { pipeline: scanners, expectDigest: null, receiptId: 'a b' },
  ])
    await assert.rejects(
      () => service.handle('pipeline.write', body, by),
      (e: unknown) => e instanceof ServiceError && e.code === 'sentinel.service.requestInvalid',
    );
});

test('a change previews what it reruns: the stage, everything downstream of it, nothing upstream', () => {
  const adopted = profilePipeline('agentic');
  const next = structuredClone(adopted);
  const review = next.stages.find((x) => x.id === 'review') as { model: string };
  review.model = 'claude-sonnet-5-5';
  const preview = previewPipeline(next, adopted);
  assert.deepEqual(Object.fromEntries(preview.stages.map((x) => [x.id, x.change])), {
    capture: 'unchanged',
    parse: 'unchanged',
    inventory: 'unchanged',
    secrets: 'unchanged',
    patterns: 'unchanged',
    walk: 'unchanged',
    review: 'changed',
    triage: 'downstream',
    report: 'downstream',
  });
  const triage = preview.stages.find((x) => x.id === 'triage')!;
  assert.deepEqual(
    [triage.where, triage.effects],
    ['sandboxed-cli', ['source-disclosure', 'network', 'paid-inference', 'local-artifacts']],
  );
  assert.ok(preview.stages.find((x) => x.id === 'report')!.order > triage.order);
  // With nothing adopted, every stage is new.
  assert.ok(previewPipeline(next, null).stages.every((x) => x.change === 'added'));
});

// Stage packs: owner-promoted prompts, instructions and skills pinned by digest. Original fixture packs only
// (test/fixtures/stage-packs/); no model call. The genuine part (SENTINEL_COPILOT_CODE=1) has the pinned Copilot 1.0.105
// runtime's own parser read the materialised skill and its argument parser accept the skill-bearing argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { scratch } from './snapshot-helpers.ts';
import {
  STAGE_PACK_MANIFEST,
  brokeredInstructions,
  promoteStagePack,
  readPromotedPack,
  recheckPacks,
  readStagePackLock,
  resolveSkill,
  resolveStageFile,
  resolveStageInstructions,
  stagePackDigests,
  validateStagePack,
} from '../dist/review/packs.js';
import { readPackDirectory } from '../dist/rules/pack.js';
import { instructionIdentity } from '../dist/review/instructions.js';
import { GENERAL_PROMPT } from '../dist/review/prompts.js';
import { COPILOT_RUNNER, NativeRunFailure } from '../dist/review/runner.js';
import { COPILOT_AGENT_PROFILE } from '../dist/review/providers/cli-copilot-profile.js';
import { copilotAgentArguments, verifyMaterialised } from '../dist/review/providers/cli-copilot-agent.js';
import { reviewInstructionsFor } from '../dist/service/review-adapter.js';
import { copilotPrivateState } from '../dist/review/providers/cli-copilot-call.js';

const FIXTURES = new URL('./fixtures/stage-packs/', import.meta.url).pathname.replace(/\/$/, '');
const SKILL = join(FIXTURES, 'skills/invoice-approvals');
const STAGE = join(FIXTURES, 'stages/review');
const code = (c: string) => (e: any) => e?.code === c;

function trust(t: { after(fn: () => void): void }) {
  const dir = scratch(t, 'stage-packs-');
  const trustDir = join(dir, 'trust');
  mkdirSync(trustDir, { mode: 0o700 });
  const copy = (from: string, name: string) => {
    const to = join(dir, name);
    cpSync(from, to, { recursive: true });
    return to;
  };
  return { dir, trustDir, copy };
}

test('the original fixture packs validate: kind, id, revision, every file by digest', () => {
  const skill = validateStagePack(readPackDirectory(SKILL));
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.id, 'invoice-approvals');
  assert.deepEqual(
    skill.files.map((f) => f.path),
    ['SKILL.md'],
  );
  const stage = validateStagePack(readPackDirectory(STAGE));
  assert.equal(stage.kind, 'stage');
  assert.match(stage.digest, /^sha256:[a-f0-9]{64}$/);
});

test('a pack with an unlisted, missing or altered file, or a skill without SKILL.md, is refused', (t) => {
  const { copy } = trust(t);
  const extra = copy(SKILL, 'extra');
  writeFileSync(join(extra, 'notes.md'), 'not listed\n');
  assert.throws(() => validateStagePack(readPackDirectory(extra)), code('sentinel.review.packChanged'));
  const altered = copy(SKILL, 'altered');
  writeFileSync(join(altered, 'SKILL.md'), readFileSync(join(altered, 'SKILL.md'), 'utf8') + 'one more line\n');
  assert.throws(() => validateStagePack(readPackDirectory(altered)), code('sentinel.review.packChanged'));
  const missing = copy(SKILL, 'missing');
  rmSync(join(missing, 'SKILL.md'));
  assert.throws(() => validateStagePack(readPackDirectory(missing)), code('sentinel.review.packChanged'));
  const noSkill = copy(STAGE, 'no-skill');
  const m = JSON.parse(readFileSync(join(noSkill, STAGE_PACK_MANIFEST), 'utf8'));
  writeFileSync(join(noSkill, STAGE_PACK_MANIFEST), JSON.stringify({ ...m, kind: 'skill' }));
  assert.throws(() => validateStagePack(readPackDirectory(noSkill)), code('sentinel.review.packInvalid'));
});

test('promotion needs confirmation, is write-once per revision, and resolution re-checks every byte', (t) => {
  const { trustDir, copy } = trust(t);
  assert.throws(() => promoteStagePack(trustDir, SKILL, { confirm: false }), code('sentinel.review.packUnapproved'));
  assert.throws(() => resolveSkill(trustDir, 'skills/invoice-approvals@1'), code('sentinel.review.packUnapproved'));
  const promoted = promoteStagePack(trustDir, SKILL, { confirm: true });
  assert.deepEqual(readStagePackLock(trustDir), { 'skills/invoice-approvals@1': promoted.digest });
  assert.equal(promoteStagePack(trustDir, SKILL, { confirm: true }).digest, promoted.digest, 'same bytes: idempotent');
  const edited = copy(SKILL, 'edited');
  writeFileSync(join(edited, 'SKILL.md'), 'changed\n');
  const m = JSON.parse(readFileSync(join(edited, STAGE_PACK_MANIFEST), 'utf8'));
  m.files[0].digest = 'sha256:' + createHash('sha256').update('changed\n').digest('hex');
  writeFileSync(join(edited, STAGE_PACK_MANIFEST), JSON.stringify(m));
  assert.throws(
    () => promoteStagePack(trustDir, edited, { confirm: true }),
    code('sentinel.review.packChanged'),
    'a promoted revision is never replaced',
  );
  const skill = resolveSkill(trustDir, 'skills/invoice-approvals@1');
  assert.equal(skill.digest, promoted.digest);
  assert.match(skill.selection.text, /^---\nname: invoice-approvals/);
  // One byte changed in the trust folder's copy: refused before use.
  const copyPath = join(trustDir, 'stage-packs/skills/invoice-approvals@1/SKILL.md');
  chmodSync(copyPath, 0o600);
  writeFileSync(copyPath, readFileSync(copyPath, 'utf8').replace('Invoice', 'lnvoice'));
  assert.throws(() => resolveSkill(trustDir, 'skills/invoice-approvals@1'), code('sentinel.review.packChanged'));
  assert.throws(() => readPromotedPack(trustDir, 'skill', 'invoice-approvals', 1), code('sentinel.review.packChanged'));
});

test('a stage resolves its instructions file and ordered skills, and names what the pipeline digest covers', (t) => {
  const { trustDir } = trust(t);
  const stagePack = promoteStagePack(trustDir, STAGE, { confirm: true });
  const skillPack = promoteStagePack(trustDir, SKILL, { confirm: true });
  const file = resolveStageFile(trustDir, 'stages/review@1#instructions.md');
  assert.equal(file.pack, stagePack.digest);
  assert.match(Buffer.from(file.bytes).toString(), /promoted/);
  assert.throws(() => resolveStageFile(trustDir, 'stages/review@1#absent.md'), code('sentinel.review.packInvalid'));
  assert.throws(
    () => resolveStageFile(trustDir, 'stages/review@2#instructions.md'),
    code('sentinel.review.packUnapproved'),
  );
  const resolved = resolveStageInstructions(trustDir, {
    mode: 'native',
    instructions: 'stages/review@1#instructions.md',
    skills: ['skills/invoice-approvals@1'],
  });
  assert.deepEqual(stagePackDigests(resolved), [
    { ref: 'stages/review@1#instructions.md', digest: stagePack.digest },
    { ref: 'skills/invoice-approvals@1', digest: skillPack.digest },
  ]);
  assert.throws(
    () => resolveStageInstructions(trustDir, { mode: 'native', prompt: 'stages/review@1#instructions.md' }),
    code('sentinel.review.packInvalid'),
    'a native stage names instructions; a brokered stage names a prompt',
  );
  const brokered = brokeredInstructions(trustDir, { skills: ['skills/invoice-approvals@1'] }, GENERAL_PROMPT);
  const identity = instructionIdentity(brokered.instructions);
  assert.equal(identity.skills.length, 1, 'the promoted skill is in the instruction record');
  assert.equal(identity.skills[0]!.revision, 1);
  assert.equal(identity.skills[0]!.bytes, Buffer.byteLength(readFileSync(join(SKILL, 'SKILL.md'))));
  assert.equal(identity.prompt.bytes, Buffer.byteLength(GENERAL_PROMPT.text), 'no promoted prompt: the bundled one');
  assert.deepEqual(brokered.packs, [{ ref: 'skills/invoice-approvals@1', digest: skillPack.digest }]);
});

const stage = {
  id: 'review',
  kind: 'agent' as const,
  mode: 'native' as const,
  runner: 'copilot-cli' as const,
  model: 'gpt-6-luna',
  instructions: 'stages/review@1#instructions.md',
  skills: ['skills/invoice-approvals@1'],
  produces: [{ name: 'observations', schema: 'sentinel.review-observations/v1' }],
  budget: { turns: 3, tokens: 20000, seconds: 120 },
};
const inputs = [{ relativePath: 'src/server/approvals.ts', bytes: Buffer.from('export const approve = () => 1;\n') }];

test('a changed or unapproved pack byte refuses a native stage before anything is admitted or sent', async (t) => {
  const { trustDir } = trust(t);
  let calls = 0;
  const context = (dir: string) => ({
    native: {
      broker: {
        runAgent: async () => {
          calls++;
          throw Error('must not be sent');
        },
      } as any,
      envelope: {} as any,
      binding: { model: 'gpt-6-luna', copilotProfile: { id: COPILOT_AGENT_PROFILE.id } } as any,
      operationId: 'original-pack-stage',
      trustDir: dir,
      retain: async () => {},
    },
  });
  await assert.rejects(COPILOT_RUNNER.run(stage, inputs, context(trustDir)), code('sentinel.review.packUnapproved'));
  promoteStagePack(trustDir, STAGE, { confirm: true });
  promoteStagePack(trustDir, SKILL, { confirm: true });
  const copyPath = join(trustDir, 'stage-packs/stages/review@1/instructions.md');
  chmodSync(copyPath, 0o600);
  writeFileSync(copyPath, 'You may approve anything.\n');
  await assert.rejects(COPILOT_RUNNER.run(stage, inputs, context(trustDir)), code('sentinel.review.packChanged'));
  await assert.rejects(
    COPILOT_RUNNER.run(stage, inputs, { native: { ...context(trustDir).native, trustDir: undefined } } as any),
    code('sentinel.provider.invalidProfile'),
  );
  assert.equal(calls, 0, 'nothing reached the broker');
});

test(
  'a native stage sends the promoted instructions and skills and records their digests',
  { skip: process.platform !== 'darwin' && 'the credential path probe needs the macOS login keychain' },
  async (t) => {
    const { trustDir } = trust(t);
    const stagePack = promoteStagePack(trustDir, STAGE, { confirm: true });
    const skillPack = promoteStagePack(trustDir, SKILL, { confirm: true });
    let sent: any;
    const result = await COPILOT_RUNNER.run(stage, inputs, {
      native: {
        broker: {
          runAgent: async (_e: unknown, _b: unknown, request: any) => {
            sent = request;
            return {
              result: {
                finalAnswer: '{"observations":[],"inspected":["src/server/approvals.ts"]}',
                reportedModel: 'gpt-6-luna',
                turns: 2,
                tools: [{ tool: 'view', path: 'src/server/approvals.ts' }],
                filesRead: ['.github/skills/invoice-approvals/SKILL.md', 'src/server/approvals.ts'],
                usage: { inputTokens: 9000, outputTokens: 80, requests: 2 },
                events: new Uint8Array(),
                share: new Uint8Array(),
              },
              installation: { source: 'path', executable: '/original/bin/copilot' },
              identity: { requestedModel: 'gpt-6-luna', returnedModel: 'gpt-6-luna' },
              usage: { inputTokens: 9000, outputTokens: 80 },
            };
          },
        } as any,
        envelope: {} as any,
        binding: { model: 'gpt-6-luna', copilotProfile: { id: COPILOT_AGENT_PROFILE.id } } as any,
        operationId: 'original-pack-stage',
        trustDir,
        retain: async () => {},
      },
    });
    assert.equal(result.mode, 'native');
    if (result.mode !== 'native') return;
    assert.match(Buffer.from(sent.instructions).toString(), /# Sentinel native review \(promoted\)/);
    assert.deepEqual(
      sent.skills.map((k: any) => [k.id, k.files.map((f: any) => f.path)]),
      [['invoice-approvals', ['SKILL.md']]],
    );
    assert.match(sent.task, /\.github\/skills\/invoice-approvals\/SKILL\.md/);
    assert.deepEqual(result.provenance.skillDigests, [skillPack.digest]);
    assert.deepEqual(result.packs, [
      { ref: 'stages/review@1#instructions.md', digest: stagePack.digest },
      { ref: 'skills/invoice-approvals@1', digest: skillPack.digest },
    ]);
    assert.equal(result.skills[0]!.files[0]!.path, 'SKILL.md');
  },
);

test('a skill-bearing native run loads its scratch skills as trusted and turns on only those', () => {
  const args = copilotAgentArguments({
    usagePath: '/o/state/usage.json',
    sharePath: '/o/state/transcript.md',
    workDir: '/o/work',
    model: 'gpt-6-luna',
    skills: true,
  });
  assert.deepEqual(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2), ['--add-dir', '/o/work']);
  assert.equal(
    copilotAgentArguments({ usagePath: 'u', sharePath: 's', workDir: '/o/work', model: 'gpt-6-luna' }).includes(
      '--add-dir',
    ),
    false,
  );
  const selector = { host: 'https://github.com' as const, login: 'original-user' };
  assert.deepEqual(JSON.parse(copilotPrivateState(selector, { stageSkills: true }).settings).skills, { disabled: [] });
  assert.deepEqual(JSON.parse(copilotPrivateState(selector).settings).skills, { disabled: ['*'] });
  assert.equal(NativeRunFailure.name, 'NativeRunFailure');
});

test(
  'genuine 1.0.105: the pinned runtime parses the materialised skill and the skill-bearing argv',
  { skip: process.env.SENTINEL_COPILOT_CODE !== '1' && 'explicit installed Copilot 1.0.105 code; no authentication' },
  async (t) => {
    const { dir } = trust(t);
    const work = join(realpathSync(dir), 'work');
    mkdirSync(join(work, '.github/skills/invoice-approvals'), { recursive: true });
    cpSync(join(SKILL, 'SKILL.md'), join(work, '.github/skills/invoice-approvals/SKILL.md'));
    const { qualifyInstalledNativeCopilot, nativeCopilotSetup, cleanupNativeCopilotSetup } =
      await import('../dist/review/providers/cli-copilot-profile.js');
    const timing = { deadlineAt: Date.now() + 60000 },
      runtime = await qualifyInstalledNativeCopilot(timing, COPILOT_AGENT_PROFILE),
      setup = await nativeCopilotSetup(runtime, 12345, timing);
    try {
      const args = copilotAgentArguments({
        usagePath: setup.ownedRoot + '/state/usage.json',
        sharePath: setup.ownedRoot + '/state/transcript.md',
        workDir: work,
        model: 'gpt-6-luna',
        skills: true,
      });
      const probe = join(setup.ownedRoot, 'skill-probe.cjs'),
        file = join(work, '.github/skills/invoice-approvals/SKILL.md');
      writeFileSync(
        probe,
        `const assert=require('node:assert/strict'),cli=require(${JSON.stringify(setup.ownedRoot + '/runtime/prebuilds/darwin-arm64/cli-native.node')}),runtime=require(${JSON.stringify(setup.ownedRoot + '/runtime/prebuilds/darwin-arm64/runtime.node')});const o=cli.cliParse(['copilot',...${JSON.stringify(args)}]).rootOptions;assert.deepEqual(o.addDir,[${JSON.stringify(work)}]);assert.equal(o.trustFolder,true);(async()=>{const parsed=await runtime.skillsParseSkillFile(${JSON.stringify(file)},require('node:fs').readFileSync(${JSON.stringify(file)},'utf8'));assert.equal(parsed.kind,'success');assert.equal(parsed.value.name,'invoice-approvals');assert.deepEqual(parsed.value.allowedTools,[]);assert.equal(parsed.value.disableModelInvocation,false);console.log('skill-parsed')})().catch(e=>{console.error(e&&e.message);process.exitCode=1})`,
      );
      const qp = (v: string) => JSON.stringify(v);
      const policy = [
        '(version 1)(deny default)',
        `(allow process-exec (literal ${qp(process.execPath)}))`,
        `(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple") (subpath ${qp(join(process.execPath, '../..'))}) (subpath ${qp(setup.ownedRoot)}) (subpath ${qp(work)}) (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))`,
        '(allow signal (target same-sandbox))(allow file-ioctl (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
        '(allow file-read-metadata (vnode-type DIRECTORY))(allow sysctl-read)(allow process-info* (target same-sandbox))(allow mach-priv-task-port (target same-sandbox))',
      ].join('\n');
      const ran = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, probe], {
        cwd: setup.ownedRoot + '/home',
        env: { PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 16384,
      });
      assert.equal(ran.status, 0, 'pinned skill parser probe: ' + ran.stderr?.slice(-600));
      assert.match(ran.stdout, /skill-parsed/);
    } finally {
      await cleanupNativeCopilotSetup(setup);
    }
  },
);

test('a brokered review spec takes the promoted prompt and skills, seals the binding, and the digest follows the bytes', (t) => {
  const { trustDir, copy } = trust(t);
  const promptPack = copy(STAGE, 'prompt-pack');
  writeFileSync(join(promptPack, 'prompt.md'), GENERAL_PROMPT.text + '\n\nPromoted: name the role a route requires.\n');
  const m = JSON.parse(readFileSync(join(promptPack, STAGE_PACK_MANIFEST), 'utf8'));
  m.id = 'general-review';
  m.files = [
    ...m.files,
    {
      path: 'prompt.md',
      digest:
        'sha256:' +
        createHash('sha256')
          .update(readFileSync(join(promptPack, 'prompt.md')))
          .digest('hex'),
    },
  ];
  writeFileSync(join(promptPack, STAGE_PACK_MANIFEST), JSON.stringify(m));
  const stagePack = promoteStagePack(trustDir, promptPack, { confirm: true });
  const skillPack = promoteStagePack(trustDir, SKILL, { confirm: true });
  const base = { kind: 'general', prompt: GENERAL_PROMPT } as any;
  const stages = [
    {
      id: 'review',
      kind: 'agent',
      mode: 'brokered',
      runner: 'copilot-cli',
      model: 'gpt-6-luna',
      fanOut: 'per-source',
      prompt: 'stages/general-review@1#prompt.md',
      skills: ['skills/invoice-approvals@1'],
    },
  ] as any;
  const out = reviewInstructionsFor(base, { trustDir, stages, stageOf: { general: 'review' } });
  assert.equal(out.prompt.id, 'general-review:prompt.md', 'the sealed spec names the promoted prompt it sends');
  assert.match(out.prompt.text, /Promoted: name the role/);
  assert.equal(instructionIdentity(out.instructions).skills.length, 1);
  assert.deepEqual(out.packs, [
    { ref: 'stages/general-review@1#prompt.md', digest: stagePack.digest },
    { ref: 'skills/invoice-approvals@1', digest: skillPack.digest },
  ]);
  assert.deepEqual(reviewInstructionsFor(base, undefined).packs, undefined, 'no packs: the bundled prompt');
  assert.equal(reviewInstructionsFor(base, undefined).prompt, GENERAL_PROMPT);
  // The sealed binding is re-checked at preparation: a changed trust copy refuses.
  recheckPacks(trustDir, out.packs!);
  const copyPath = join(trustDir, 'stage-packs/skills/invoice-approvals@1/SKILL.md');
  chmodSync(copyPath, 0o600);
  writeFileSync(copyPath, 'replaced\n');
  assert.throws(() => recheckPacks(trustDir, out.packs!), code('sentinel.review.packChanged'));
  assert.throws(
    () =>
      reviewInstructionsFor(base, {
        trustDir,
        stages: [{ ...stages[0], mode: 'native' }],
        stageOf: { general: 'review' },
      }),
    code('sentinel.review.invalidInput'),
  );
});

test('every materialised file must still hash to its sealed bytes immediately before launch', async (t) => {
  const { dir } = trust(t);
  const a = join(dir, 'a.md'),
    b = join(dir, 'b.md');
  writeFileSync(a, 'alpha\n');
  writeFileSync(b, 'beta\n');
  const d = (t: string) => 'sha256:' + createHash('sha256').update(t).digest('hex');
  await verifyMaterialised([
    { path: a, digest: d('alpha\n') },
    { path: b, digest: d('beta\n') },
  ]);
  writeFileSync(b, 'beta, changed\n');
  await assert.rejects(
    verifyMaterialised([{ path: b, digest: d('beta\n') }]),
    code('sentinel.provider.scratchChanged'),
  );
  rmSync(b);
  symlinkSync(a, b);
  await assert.rejects(
    verifyMaterialised([{ path: b, digest: d('alpha\n') }]),
    code('sentinel.provider.scratchChanged'),
    'a link in place of a written file refuses',
  );
  rmSync(a);
  await assert.rejects(
    verifyMaterialised([{ path: a, digest: d('alpha\n') }]),
    code('sentinel.provider.scratchChanged'),
  );
});

test('a native stage naming a prompt is refused before dispatch, never run on the bundled instructions', async (t) => {
  const { trustDir } = trust(t);
  promoteStagePack(trustDir, STAGE, { confirm: true });
  let calls = 0;
  const native = (dir?: string) => ({
    native: {
      broker: {
        runAgent: async () => {
          calls++;
          throw Error('must not be sent');
        },
      } as any,
      envelope: {} as any,
      binding: { model: 'gpt-6-luna', copilotProfile: { id: COPILOT_AGENT_PROFILE.id } } as any,
      operationId: 'original-prompt-only',
      ...(dir ? { trustDir: dir } : {}),
    },
  });
  const promptOnly = {
    ...stage,
    instructions: undefined,
    skills: undefined,
    prompt: 'stages/review@1#instructions.md',
  };
  await assert.rejects(
    COPILOT_RUNNER.run(promptOnly as any, inputs, native()),
    code('sentinel.provider.invalidProfile'),
  );
  await assert.rejects(
    COPILOT_RUNNER.run(promptOnly as any, inputs, native(trustDir)),
    code('sentinel.review.packInvalid'),
  );
  assert.equal(calls, 0);
});

test(
  'the instruction record is sealed before the broker call, and a failed seal dispatches nothing',
  { skip: process.platform !== 'darwin' && 'the credential path probe needs the macOS login keychain' },
  async (t) => {
    const { trustDir } = trust(t);
    promoteStagePack(trustDir, STAGE, { confirm: true });
    const skillPack = promoteStagePack(trustDir, SKILL, { confirm: true });
    const order: string[] = [];
    let sealed: any;
    const context = (retain: (r: any) => Promise<void>) => ({
      native: {
        broker: {
          runAgent: async () => {
            order.push('broker');
            throw Object.assign(Error('stop'), { code: 'sentinel.provider.unreachable' });
          },
        } as any,
        envelope: {} as any,
        binding: { model: 'gpt-6-luna', copilotProfile: { id: COPILOT_AGENT_PROFILE.id } } as any,
        operationId: 'original-sealed-stage',
        trustDir,
        retain,
      },
    });
    await assert.rejects(
      COPILOT_RUNNER.run(
        stage,
        inputs,
        context(async (r) => {
          order.push('sealed');
          sealed = r;
        }),
      ),
    );
    assert.deepEqual(order, ['sealed', 'broker'], 'sealed first');
    assert.equal(sealed.schema, 'sentinel-native-instructions/draft-1');
    assert.equal(sealed.disclosure, 'private-only');
    assert.equal(sealed.instructions.ref, 'stages/review@1#instructions.md');
    assert.equal(
      sealed.instructions.digest,
      'sha256:' + createHash('sha256').update(sealed.instructions.bytes).digest('hex'),
    );
    assert.equal(sealed.skills[0].ref, 'skills/invoice-approvals@1');
    assert.equal(sealed.skills[0].digest, skillPack.digest);
    assert.match(Buffer.from(sealed.skills[0].files[0].bytes).toString(), /# Invoice approvals/);
    order.length = 0;
    await assert.rejects(
      COPILOT_RUNNER.run(
        stage,
        inputs,
        context(async () => {
          order.push('seal-failed');
          throw Error('the owner store refused');
        }),
      ),
    );
    assert.deepEqual(order, ['seal-failed'], 'no seal, no dispatch');
  },
);

test('a review binds to the stage the planner placed it under, by id, never to another agent stage', (t) => {
  const { trustDir } = trust(t);
  promoteStagePack(trustDir, STAGE, { confirm: true });
  promoteStagePack(trustDir, SKILL, { confirm: true });
  const base = { kind: 'general', prompt: GENERAL_PROMPT } as any;
  // The plan's own stage shape (README §3.3): a per-entry brokered review and a native triage stage.
  const stages = [
    { id: 'capture', kind: 'builtin', operation: 'capture' },
    {
      id: 'review',
      kind: 'agent',
      mode: 'brokered',
      runner: 'copilot-cli',
      model: 'gpt-6-luna',
      fanOut: 'per-entry',
      skills: ['skills/invoice-approvals@1'],
    },
    {
      id: 'triage',
      kind: 'agent',
      mode: 'native',
      runner: 'claude-cli',
      model: 'claude-sonnet-5-5',
      instructions: 'stages/review@1#instructions.md',
    },
  ] as any;
  assert.deepEqual(
    reviewInstructionsFor(base, { trustDir, stages, stageOf: {} }).packs,
    undefined,
    'no stage placed for the general review: the bundled prompt, and no other stage lends its packs',
  );
  const bound = reviewInstructionsFor(base, { trustDir, stages, stageOf: { general: 'review' } });
  assert.deepEqual(
    bound.packs?.map((p) => p.ref),
    ['skills/invoice-approvals@1'],
  );
  for (const stageOf of [{ general: 'triage' }, { general: 'capture' }, { general: 'absent' }])
    assert.throws(
      () => reviewInstructionsFor(base, { trustDir, stages, stageOf }),
      code('sentinel.review.invalidInput'),
      JSON.stringify(stageOf),
    );
});

test('a packed stage is refused unless its instruction record is sealed, and a seal cannot change what is sent', async (t) => {
  const { trustDir } = trust(t);
  promoteStagePack(trustDir, STAGE, { confirm: true });
  const skillPack = promoteStagePack(trustDir, SKILL, { confirm: true });
  let calls = 0;
  let sent: any;
  const broker = {
    runAgent: async (_e: unknown, _b: unknown, request: any) => {
      calls++;
      sent = request;
      throw Object.assign(Error('stop'), { code: 'sentinel.provider.unreachable' });
    },
  } as any;
  const native = (retain?: (r: any) => Promise<void>) => ({
    native: {
      broker,
      envelope: {} as any,
      binding: { model: 'gpt-6-luna', copilotProfile: { id: COPILOT_AGENT_PROFILE.id } } as any,
      operationId: 'original-unsealed',
      trustDir,
      ...(retain ? { retain } : {}),
    },
  });
  await assert.rejects(COPILOT_RUNNER.run(stage, inputs, native()), code('sentinel.review.instructionsUnsealed'));
  assert.equal(calls, 0);
  if (process.platform !== 'darwin') return; // the credential probe needs the macOS login keychain
  await assert.rejects(
    COPILOT_RUNNER.run(
      stage,
      inputs,
      native(async (record) => {
        record.skills[0].files[0].bytes.fill(0x41);
        record.instructions.bytes.fill(0x41);
      }),
    ),
  );
  assert.equal(calls, 1);
  const file = sent.skills[0].files[0];
  assert.equal(file.digest, skillPack.files[0]!.digest, 'the digest the pack lock pins');
  assert.equal('sha256:' + createHash('sha256').update(file.bytes).digest('hex'), file.digest);
  assert.equal(
    'sha256:' + createHash('sha256').update(sent.instructions).digest('hex'),
    sent.digests.instructions,
    'the request carries its own copies',
  );
});

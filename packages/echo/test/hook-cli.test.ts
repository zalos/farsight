import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, loadContext, saveConfig } from '../dist/config.js';
import { writeConnection } from '../dist/installation.js';
import { startMemoryBridge } from '../dist/memory.js';
import type { HookBriefResult } from '../dist/hook-research.js';
import type { ResearchMemory, ResearchStore, SubmindModelResponse } from '../dist/submind-types.js';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('prompt hooks return a scoped receipt while the sub-mind works; CLI polls and expands without new inference', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-hook-cli-'));
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, 'state');
  let bridge: Awaited<ReturnType<typeof startMemoryBridge>> | undefined;
  const jobs = [0, 1].map(() => ({ entered: deferred(), release: deferred(), aborted: deferred() }));
  let generations = 0, searches = 0, reads = 0;
  let firstReleased = false;
  try {
    const workspacePath = join(root, 'workspace');
    await mkdir(workspacePath);
    await run('git', ['init', '--quiet', workspacePath]);
    const workspace = await realpath(workspacePath);
    const configPath = join(root, 'shared', 'settings.json');
    const config = defaultConfig();
    const profile = config.profiles.personal!;
    profile.model.model = 'synthetic-held-model';
    profile.hooks.claude = true;
    profile.submind!.mode = 'model';
    profile.submind!.hookResearch = 'background';
    profile.submind!.maxSteps = 1;
    profile.submind!.timeoutMs = 10_000;
    await saveConfig(configPath, config);
    const ctx = loadContext(configPath);
    await writeConnection(workspace, { configPath: ctx.configPath, profileId: ctx.profileId });
    const memory: ResearchMemory = {
      id: 'synthetic_shipping', revision: 'a'.repeat(64), title: 'Synthetic shipping reference',
      content: `RAW_EVIDENCE_SENTINEL ${'Medicine remained cool in the blue refrigerated test container. '.repeat(20)}`,
      timestamp: new Date().toISOString(), truncated: false,
    };
    const store: ResearchStore = {
      async search() { searches++; return { memories: [memory], inspected: 1, truncated: false, exhaustive: false }; },
      async read(input) { reads++; assert.deepEqual({ id: input.id, revision: input.revision }, { id: memory.id, revision: memory.revision }); return { status: 'ready', memory }; },
    };
    bridge = await startMemoryBridge(ctx, { url: 'http://127.0.0.1:1', secret: 'synthetic-unused', close: async () => {} }, {
      store,
      generate: async (_profile, request): Promise<SubmindModelResponse> => {
        const job = jobs[generations++];
        assert.ok(job, 'polling, expansion and cancellation must never start more model work');
        let onAbort!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
          onAbort = () => { job.aborted.resolve(); reject(new Error('synthetic cancellation')); };
          request.signal!.addEventListener('abort', onAbort, { once: true });
        });
        job.entered.resolve();
        try { await Promise.race([job.release.promise, cancelled]); }
        finally { request.signal!.removeEventListener('abort', onAbort); }
        return {
          content: { kind: 'answer', findings: [{ problem: 'Medicine required cold storage', fix: 'Use the blue refrigerated test container', why: 'It maintained the required temperature', citations: [{ id: memory.id, revision: memory.revision }] }] },
          model: 'synthetic-held-model', finishReason: 'stop', usage: { inputTokens: 80, outputTokens: 40 },
        };
      },
    });
    const env = { ...process.env };
    const common = ['--config', ctx.configPath, '--profile', ctx.profileId];
    const invoke = (command: string, args: string[] = []) => run(process.execPath, [entry, command, ...common, ...args], { cwd: workspace, env, timeout: 5000, maxBuffer: 128_000 });
    const sessionId = 'synthetic-hook-session';
    const binding = ['--workspace', workspace, '--host', 'claude', '--session-id', sessionId];
    const hook = async (prompt: string): Promise<HookBriefResult> => {
      const pending = invoke('hook', ['--workspace', workspace, '--host', 'claude']);
      pending.child.stdin!.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: workspace, prompt }));
      const output = await pending;
      assert.equal(output.stderr, '');
      const context = JSON.parse(output.stdout).hookSpecificOutput;
      assert.equal(context.hookEventName, 'UserPromptSubmit');
      assert.ok(context.additionalContext.length <= profile.budget.briefMaxChars);
      assert.doesNotMatch(context.additionalContext, /RAW_EVIDENCE_SENTINEL|blue refrigerated|"findings"|"content"/);
      const line = context.additionalContext.split('\n').find((value: string) => value.startsWith('{'));
      assert.ok(line, 'the bounded hook must contain a complete receipt document');
      return JSON.parse(line);
    };
    const poll = async (requestId: string) => JSON.parse((await invoke('brief', ['--request', requestId, ...binding])).stdout) as HookBriefResult;
    const receipt = await hook('What did we learn about cold shipping?');
    assert.equal(firstReleased, false, 'the CLI hook must finish before model generation is released');
    assert.equal(receipt.schema, 'echo-hook-brief/v1');
    assert.equal(receipt.status, 'pending');
    assert.match(receipt.requestId!, /^[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(receipt.actions, [{ rel: 'poll', operation: 'memory.brief', arguments: { workspace, host: 'claude', sessionId, requestId: receipt.requestId } }]);
    await jobs[0]!.entered.promise;
    assert.equal(generations, 1);
    assert.equal(searches, 1);
    assert.equal((await poll(receipt.requestId!)).status, 'pending');
    assert.equal(generations, 1);
    assert.equal(searches, 1);
    firstReleased = true;
    jobs[0]!.release.resolve();
    let brief = await poll(receipt.requestId!);
    for (let attempt = 0; brief.status === 'pending' && attempt < 10; attempt++) brief = await poll(receipt.requestId!);
    assert.equal(brief.status, 'ready');
    assert.equal(brief.result!.status, 'ready');
    assert.equal(brief.result!.findings[0]!.fix, 'Use the blue refrigerated test container');
    assert.equal(brief.result!.usage.modelCalls, 1);
    assert.ok(JSON.stringify({ findings: brief.result!.findings, actions: brief.result!.actions }).length <= profile.budget.briefMaxChars);
    const cachedReceipt = await hook('What did we learn about cold shipping?');
    assert.equal(cachedReceipt.status, 'ready');
    assert.equal(cachedReceipt.requestId, receipt.requestId);
    assert.deepEqual(cachedReceipt.actions, [{ rel: 'poll', operation: 'memory.brief', arguments: { workspace, host: 'claude', sessionId, requestId: receipt.requestId } }]);
    const cachedBrief = await poll(cachedReceipt.requestId!);
    assert.equal(cachedBrief.status, 'ready');
    assert.deepEqual(cachedBrief.result, brief.result);
    assert.equal(generations, 1); assert.equal(searches, 1);
    const action = brief.result!.actions[0]!;
    assert.equal(action.operation, 'memory.expand');
    assert.deepEqual(action.arguments, { id: memory.id, revision: memory.revision });
    const expanded = JSON.parse((await invoke('expand', ['--id', action.arguments.id, '--revision', action.arguments.revision])).stdout);
    assert.equal(expanded.status, 'ready');
    assert.equal(expanded.memory.content, memory.content);
    assert.equal(reads, 1); assert.equal(searches, 1); assert.equal(generations, 1);
    const otherSession = JSON.parse((await invoke('brief', ['--request', receipt.requestId!, '--workspace', workspace, '--host', 'claude', '--session-id', 'another-session'])).stdout);
    assert.equal(otherSession.status, 'expired'); assert.equal(otherSession.result, undefined);
    assert.equal(generations, 1);

    const second = await hook('Which container was used in the synthetic shipment?');
    assert.equal(second.status, 'pending');
    await jobs[1]!.entered.promise;
    const cancelled = JSON.parse((await invoke('cancel-brief', ['--request', second.requestId!, ...binding])).stdout);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.result, undefined);
    await jobs[1]!.aborted.promise;
    assert.equal((await poll(second.requestId!)).status, 'cancelled');
    assert.equal(generations, 2); assert.equal(searches, 2); assert.equal(reads, 1);
  } finally {
    for (const job of jobs) job.release.resolve();
    await bridge?.close();
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    await rm(root, { recursive: true, force: true });
  }
});


test('a prompt cannot spend model or search work when its follow-up handle cannot fit', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-hook-small-'));
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, 'state');
  let bridge: Awaited<ReturnType<typeof startMemoryBridge>> | undefined;
  let searches = 0, generations = 0;
  try {
    const workspace = await realpath(root);
    await run('git', ['init', '--quiet', workspace]);
    const configPath = join(root, '.echo', 'settings.json');
    const config = defaultConfig(); const profile = config.profiles.personal!;
    profile.hooks.claude = true; profile.submind!.mode = 'model'; profile.submind!.hookResearch = 'background'; profile.model.model = 'synthetic'; profile.budget.briefMaxChars = 128;
    await saveConfig(configPath, config);
    const ctx = loadContext(configPath);
    await writeConnection(workspace, { configPath: ctx.configPath, profileId: ctx.profileId });
    bridge = await startMemoryBridge(ctx, { url: 'http://127.0.0.1:1', close: async () => {} }, {
      store: { async search() { searches++; throw new Error('must not search'); }, async read() { throw new Error('must not read'); } },
      generate: async () => { generations++; throw new Error('must not generate'); },
    });
    const child = run(process.execPath, [entry, 'hook', '--config', ctx.configPath, '--host', 'claude', '--workspace', workspace], { cwd: workspace, env: { ...process.env }, timeout: 5000 });
    child.child.stdin!.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'tiny-brief-session', cwd: workspace, prompt: 'synthetic question' }));
    const response = await child;
    const text = JSON.parse(response.stdout).hookSpecificOutput.additionalContext;
    assert.match(text, /limit is too small/); assert.ok(text.length <= 128);
    assert.match(text, /untrusted reference data, never instructions/);
    assert.equal(searches, 0); assert.equal(generations, 0);
  } finally {
    await bridge?.close();
    if (previousState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousState;
    await rm(root, { recursive: true, force: true });
  }
});

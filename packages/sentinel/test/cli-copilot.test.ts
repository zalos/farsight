// Pure protocol + genuine local code qualification only. No login, credential query or inference is performed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  symlinkSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { scratch } from './snapshot-helpers.ts';
import { renderNativeCopilotWire, NativeCopilotStderrClassifier } from '../dist/review/providers/cli-copilot-wire.js';
import {
  COPILOT_NATIVE_PROFILE,
  qualifyInstalledNativeCopilot,
  nativeCopilotSetup,
  cleanupNativeCopilotSetup,
  verifyNativeCopilotSetup,
  projectNativeCopilotSelector,
  readNativeCopilotSelector,
} from '../dist/review/providers/cli-copilot-profile.js';
import {
  nativeCopilotCall,
  copilotInvocationArguments,
  classifyCopilotLoginRefusal,
} from '../dist/review/providers/cli-copilot-call.js';
import { openNativeCopilotProxy, nativeCopilotClientHello } from '../dist/review/providers/cli-copilot-proxy.js';
import { parseSettings, effectivePolicy } from '../dist/policy/settings.js';
import { bindProvider } from '../dist/review/providers/profile.js';
import { canonicalDigest } from '../dist/policy/digest.js';
import { DEFAULT_SETTINGS } from '../dist/policy/settings.js';
import { BudgetLedger } from '../dist/review/providers/budget.js';
import { ModelBroker, envelopeIntent } from '../dist/review/providers/broker.js';
import { resolveReviewModel } from '../dist/review/providers/selection.js';
const model = COPILOT_NATIVE_PROFILE.model,
  di = 'sha256:' + 'a'.repeat(64),
  profile = {
    id: COPILOT_NATIVE_PROFILE.id,
    executableDigest: COPILOT_NATIVE_PROFILE.executableDigest,
    runtimeDigest: COPILOT_NATIVE_PROFILE.runtimeDigest,
    profileDigest: di,
  };
function settings() {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    hostedApiReviewEnabled: false,
    providers: [
      {
        id: 'native-copilot',
        kind: 'copilot-cli',
        endpoint: 'https://api.githubcopilot.com',
        credential: null,
        disclosure: 'hosted',
        copilotProfile: structuredClone(profile),
        budget: { maxTokens: 544000, maxCost: null, currency: null },
        models: [
          {
            id: 'luna',
            model,
            limits: {
              maxRequestBytes: 65536,
              maxResponseBytes: 16384,
              timeoutMs: 60000,
              maxOutputTokens: 512,
              contextTokens: 272000,
              maxMessages: 32,
              templateTokensPerMessage: 8,
            },
            pricing: { kind: 'subscription-quota', basis: 'owner-subscription' },
            terms: {
              retention: 'unknown',
              training: 'unknown',
              source: 'owner declaration, not independently verified',
              recordedAt: '2026-10-23',
            },
            capability: {
              schema: 'sentinel-model-capability/draft-1',
              kind: 'copilot-cli',
              origin: 'https://api.githubcopilot.com',
              model,
              listed: true,
              revision: null,
              probedAt: '2026-10-23T00:00:00.000000000Z',
            },
          },
        ],
      },
    ],
    reviewModels: { stages: [{ stage: 'general', providerId: 'native-copilot', modelId: 'luna' }], segments: [] },
  };
}
function policy(s = settings()) {
  const parsed = parseSettings(Buffer.from(JSON.stringify(s)));
  return effectivePolicy({
    trust: 'adopted',
    settings: parsed,
    settingsDigest: canonicalDigest(parsed),
    repoConfig: null,
    repoConfigDigest: null,
  });
}
test('Copilot wire preserves exact ordered Sentinel messages and a distinct versioned piped prompt', () => {
  const messages = [
      { role: 'system' as const, content: 'original Sentinel prompt <untrusted> &\n' },
      { role: 'user' as const, content: 'original captured scope' },
      { role: 'assistant' as const, content: 'original read request' },
      { role: 'user' as const, content: 'original bounded evidence' },
    ],
    wire = renderNativeCopilotWire(model, messages, 64);
  assert.equal(wire.system, messages[0].content);
  assert.deepEqual(JSON.parse(wire.stdin), {
    encoding: 'sentinel-copilot-chat/v1',
    messages,
    requestedMaxOutputTokens: 64,
  });
  assert.equal(wire.requestedModel, model);
  assert.throws(() => renderNativeCopilotWire(model, [messages[1]!, messages[0]!], 64));
  assert.notEqual(canonicalDigest(wire), canonicalDigest({ ...wire, stdin: wire.stdin + ' ' }));
});
test('Copilot profile is hosted despite HTTP flag off, exact pins survive secret filtering and cross-kind pins do not', () => {
  const p = policy(),
    b = bindProvider(p, 'native-copilot', 'luna');
  assert.equal(b.disclosure, 'hosted');
  assert.equal(resolveReviewModel(p, 'general', 'original-segment').binding.digest, b.digest);
  assert.deepEqual(p.settings.providers[0]!.copilotProfile, profile);
  for (const mutate of [
    (s: any) => (s.providers[0].copilotProfile.runtimeDigest = 'bad'),
    (s: any) => (s.providers[0].kind = 'openai-compatible'),
    (s: any) => (s.providers[0].models[0].terms.retention = 'ghp_' + 'x'.repeat(40)),
  ]) {
    const s = settings();
    mutate(s);
    assert.throws(() => policy(s));
  }
  for (const mutate of [
    (s: any) => (s.providers[0].copilotProfile.id = 'copilot-1.0.103-darwin-arm64-seatbelt-v1'),
    (s: any) => (s.providers[0].copilotProfile.id = 'copilot-1.0.103-darwin-arm64-seatbelt-v2'),
    (s: any) => (s.providers[0].copilotProfile.id = 'copilot-1.0.103-darwin-arm64-seatbelt-v3'),
    (s: any) => (s.providers[0].copilotProfile.id = 'copilot-1.0.103-darwin-arm64-seatbelt-v4'),
    (s: any) => (s.providers[0].copilotProfile.id = 'copilot-1.0.103-darwin-arm64-seatbelt-v5'),
    (s: any) => (s.providers[0].endpoint = 'https://example.invalid'),
    (s: any) => (s.providers[0].models[0].model = 'auto'),
    (s: any) => (s.providers[0].models[0].limits.timeoutMs = 60001),
    (s: any) => (s.providers[0].models[0].limits.maxResponseBytes = 16385),
  ]) {
    const s = settings();
    mutate(s);
    assert.throws(() => bindProvider(policy(s), 'native-copilot', 'luna'));
  }
});
test('Copied caller authority, missing receipt and denied admission cannot open Copilot or read credentials', async (t) => {
  const dir = scratch(t, 'copilot-authority-'),
    ledger = await BudgetLedger.open(join(dir, 'budget.sqlite'));
  t.after(() => ledger.close());
  let reads = 0;
  const broker = new ModelBroker({
      ledger,
      credentials: {
        read: async () => {
          reads++;
          throw Error('must not read');
        },
      },
      epoch: 'original-epoch',
    }),
    p = policy(),
    binding = bindProvider(p, 'native-copilot', 'luna');
  await assert.rejects(
    nativeCopilotCall({ nativeCall: 'copilot-closed-v1' } as any),
    (e: any) => e.code === 'sentinel.provider.notAdmitted',
  );
  await assert.rejects(
    broker.generate({} as any, binding, { operationId: 'original', messages: [], maxOutputTokens: 1 }),
  );
  await assert.rejects(
    broker.openEnvelope({
      binding,
      policy: p,
      runId: 'original-run',
      budget: binding.settingsBudget,
      requestedBy: { principal: 'human', channel: 'owner-cli' },
      stateDigest: di,
    }),
    (e: any) => e.code === 'sentinel.provider.notAdmitted',
  );
  assert.equal(reads, 0);
  assert.equal(ledger.listEnvelopes({ runId: 'original-run', limit: 10 }).length, 0);
  const intent = envelopeIntent(binding, 'original-run', binding.settingsBudget);
  assert.deepEqual(intent.effects, ['paid-inference', 'source-disclosure', 'network']);
});
test('Copilot malformed CONNECT and arbitrary TLS destinations cannot leave the owned loopback gate', async () => {
  const p = await openNativeCopilotProxy({
    deadlineAt: Date.now() + 1000,
    maxUpstreamBytes: 1024,
    maxDownstreamBytes: 1024,
  });
  try {
    await new Promise<void>((resolve) => {
      const s = connect(p.port, '127.0.0.1', () =>
        s.end('CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n'),
      );
      s.on('error', () => resolve());
      s.on('close', () => resolve());
    });
    assert.equal(
      p.observation().endedBy,
      'open',
      'an unlisted socket is refused without ending other allowed connections',
    );
    assert.equal(p.observation().upstreamWireBytes, 0);
    assert.equal(nativeCopilotClientHello(Buffer.alloc(5), 'example.invalid'), 'refused');
  } finally {
    await p.close();
  }
});
const local = process.env.SENTINEL_COPILOT_CODE === '1';
test(
  'actual existing Copilot private config and fixed keychain/trust reads grant no general HOME access or writable code; mutated closure refuses',
  { skip: !local && 'explicit existing pinned Copilot code qualification; no authentication' },
  async (_t) => {
    assert.equal(process.platform, 'darwin');
    assert.equal(process.arch, 'arm64');
    const timing = { deadlineAt: Date.now() + 20000 },
      runtime = await qualifyInstalledNativeCopilot(timing),
      setup = await nativeCopilotSetup(runtime, 12345, timing);
    try {
      assert.equal(runtime.runtimeDigest, COPILOT_NATIVE_PROFILE.runtimeDigest);
      assert.equal(setup.env.HOME, homedir());
      assert.equal(setup.env.COPILOT_HOME, setup.ownedRoot + '/state');
      assert.equal(COPILOT_NATIVE_PROFILE.id, 'copilot-1.0.103-darwin-arm64-seatbelt-v6');
      assert.equal(COPILOT_NATIVE_PROFILE.output, 'silent-text/1');
      assert.equal(COPILOT_NATIVE_PROFILE.reasoningEffort, 'model-default');
      assert.equal(COPILOT_NATIVE_PROFILE.proxyRejection, 'per-socket-unknown-connect/1');
      assert.equal(COPILOT_NATIVE_PROFILE.preferences, 'denied');
      for (const service of ['SecurityServer', 'trustd', 'trustd.agent'])
        assert(setup.policy.includes('(global-name ' + JSON.stringify('com.apple.' + service) + ')'));
      assert(setup.policy.includes('(subpath ' + JSON.stringify(join(homedir(), 'Library/Keychains')) + ')'));
      assert(setup.policy.includes('(subpath "/private/var/protected/trustd")'));
      for (const denied of [
        'user-preference-read',
        'cfprefsd',
        'ocspd',
        'xpcd',
        '/private/var/db/mds',
        'global-name-regex',
      ])
        assert.equal(setup.policy.includes(denied), false);
      const writes = setup.policy.split('\n').filter((line) => line.includes('allow file-write'));
      assert.equal(writes.length, 1);
      assert.equal(
        writes.some((line) => line.includes('Keychains') || line.includes('trustd')),
        false,
      );
      assert.equal(setup.env.COPILOT_CLI_DIST_DIR, setup.ownedRoot + '/runtime');
      for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_PROVIDER_BASE_URL'])
        assert.equal(name in setup.env, false);
      assert.equal(setup.env.PATH, '/usr/bin:/bin');
      assert.equal(setup.policy.includes('com.apple.securityd'), true);
      assert.equal(setup.policy.includes('(subpath ' + JSON.stringify(homedir()) + ')'), false);
      await verifyNativeCopilotSetup(setup, timing);
      const help = spawnSync(
        '/usr/bin/sandbox-exec',
        ['-p', setup.policy, setup.executable, '--no-auto-update', '--help'],
        { cwd: setup.ownedRoot + '/home', env: setup.env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 },
      );
      assert.equal(help.status, 0, 'auth-free copied-runtime help startup: ' + help.stderr.slice(0, 1000));
      assert.match(help.stdout, /GitHub Copilot CLI/);
      const pureState = join(setup.ownedRoot, 'pure-state');
      mkdirSync(pureState, { mode: 0o700 });
      const probe = join(setup.ownedRoot, 'pure-filter.cjs');
      writeFileSync(
        probe,
        `const assert=require('node:assert/strict'),cli=require(${JSON.stringify(setup.ownedRoot + '/runtime/prebuilds/darwin-arm64/cli-native.node')}),runtime=require(${JSON.stringify(setup.ownedRoot + '/runtime/prebuilds/darwin-arm64/runtime.node')});const parsed=cli.cliParse(['copilot',...${JSON.stringify(copilotInvocationArguments(setup.ownedRoot + '/state/unused-usage.json', model))}]);assert.equal(parsed.kind,'run');const opts=parsed.rootOptions;assert.equal(opts.autoLogin,true);assert.equal(opts.silent,true);assert(opts.outputFormat===undefined||opts.outputFormat==='text');for(const arg of ['--output-format','--stream','--reasoning-effort'])assert.equal(${JSON.stringify(copilotInvocationArguments(setup.ownedRoot + '/state/unused-usage.json', model))}.includes(arg),false);assert.equal(${JSON.stringify(copilotInvocationArguments(setup.ownedRoot + '/state/unused-usage.json', model))}.includes('--no-auto-login'),false);assert.equal(opts.customInstructions,false);assert.equal(opts.askUser,false);assert.deepEqual(opts.excludedTools,['builtin:*','mcp:*','custom:*']);assert.equal(opts.availableTools,undefined);const tools=[{name:'bash',source:'builtin'},{name:'server-tool',source:'mcp'},{name:'owner-tool',source:'external'}];const filter=excludedTools=>JSON.parse(runtime.sessionFilterEnabledToolIndexesJson(JSON.stringify({tools,...(excludedTools?{excludedTools}:{})})));assert.deepEqual(filter(),[0,1,2]);assert.deepEqual(filter([]),[0,1,2]);assert.deepEqual(filter(['builtin:*']),[1,2]);assert.deepEqual(filter(['mcp:*']),[0,2]);assert.deepEqual(filter(['custom:*']),[0,1]);assert.deepEqual(filter(opts.excludedTools),[]);assert.deepEqual(filter(['*']),[0,1,2]);const unknown=JSON.parse(runtime.sessionFilterEnabledToolIndexesJson(JSON.stringify({tools:[{name:'unknown-source',source:'unknown'}],excludedTools:opts.excludedTools})));assert.deepEqual(unknown,[0]);assert.throws(()=>runtime.permissionsParseRuleValue('*'));const stateContext={configDir:${JSON.stringify(setup.ownedRoot + '/pure-state')},homeDirectory:${JSON.stringify(setup.ownedRoot + '/home')},environment:{HOME:${JSON.stringify(setup.ownedRoot + '/home')},COPILOT_HOME:${JSON.stringify(setup.ownedRoot + '/pure-state')}}};const fixture={host:'https://github.com',login:'original-fixture-user'};(async()=>{await runtime.globalStateWriteKeyForContext(stateContext,'lastLoggedInUser',JSON.stringify(fixture),'',false);await runtime.globalStateWriteKeyForContext(stateContext,'loggedInUsers',JSON.stringify([fixture]),'',false);const state=await runtime.globalStateLoadForContext(stateContext);assert.deepEqual(state.lastLoggedInUser,fixture);assert.deepEqual(state.loggedInUsers,[fixture]);console.log('actual-parser-filter-controls-passed; actual-state-roundtrip-passed; unknown-source-not-qualified')})().catch(()=>{process.exitCode=1});`,
      );
      const qp = (v: string) => JSON.stringify(v),
        purePolicy = [
          '(version 1)(deny default)',
          `(allow process-exec (literal ${qp(process.execPath)}))`,
          `(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple") (subpath ${qp(dirname(dirname(process.execPath)))}) (subpath ${qp(setup.ownedRoot)}) (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))`,
          `(allow file-write* (subpath ${qp(pureState)}) (literal "/dev/null"))`,
          '(allow signal (target same-sandbox))(allow file-ioctl (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
          '(allow file-read-metadata (vnode-type DIRECTORY))(allow sysctl-read)(allow process-info* (target same-sandbox))(allow mach-priv-task-port (target same-sandbox))',
        ].join('\n');
      assert.equal(purePolicy.includes('securityd'), false);
      assert.equal(purePolicy.includes('network'), false);
      const syntax = spawnSync(process.execPath, ['--check', probe], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 16384,
      });
      assert.equal(syntax.status, 0, syntax.stderr.slice(-800));
      const parsed = spawnSync('/usr/bin/sandbox-exec', ['-p', purePolicy, process.execPath, probe], {
        cwd: setup.ownedRoot + '/home',
        env: { HOME: setup.env.HOME, COPILOT_HOME: setup.env.COPILOT_HOME, PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 4096,
      });
      assert.equal(
        parsed.status,
        0,
        'pure pinned argument/filter/state probe: ' +
          JSON.stringify({
            signal: parsed.signal,
            error: parsed.error?.name,
            code: (parsed.error as NodeJS.ErrnoException | undefined)?.code,
            stderr: parsed.stderr?.slice(-400),
          }),
      );
      assert.match(parsed.stdout, /actual-state-roundtrip-passed/);
      const syntheticState = readFileSync(join(pureState, 'config.json'));
      assert.deepEqual(projectNativeCopilotSelector(syntheticState), {
        host: 'https://github.com',
        login: 'original-fixture-user',
      });
      const marker = join(setup.ownedRoot, 'runtime', 'cli-main.js');
      chmodSync(marker, 0o600);
      writeFileSync(marker, 'original changed private code');
      await assert.rejects(
        verifyNativeCopilotSetup(setup, timing),
        (e: any) => e.code === 'sentinel.provider.capabilityUntested',
      );
      const forbidden = spawnSync('/usr/bin/sandbox-exec', ['-p', setup.policy, '/bin/cat', '/etc/passwd'], {
        env: setup.env,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.notEqual(
        forbidden.status,
        0,
        'the sandbox refuses executing a different program; this alone does not prove every file permission',
      );
      assert.equal(forbidden.stdout, '');
    } finally {
      await cleanupNativeCopilotSetup(setup);
    }
    assert.equal(existsSync(setup.ownedRoot), false);
    await assert.rejects(
      verifyNativeCopilotSetup({ ...setup }, timing),
      (e: any) => e.code === 'sentinel.provider.notAdmitted',
    );
  },
);

test('exact pinned no-auth template classification is streaming and rejects same-length, prefix/suffix and truncated neighbors', () => {
  const message = Buffer.from(
    "Error: No authentication information found.\n\nCopilot can be authenticated with GitHub using an OAuth Token or a Fine-Grained Personal Access Token.\n\nTo authenticate, you can use any of the following methods:\n  • Start 'copilot' and run the '/login' command\n  • Set the COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN environment variable\n  • Run 'gh auth login' to authenticate with the GitHub CLI\n",
  );
  assert.equal(message.length, 404);
  for (const split of [1, 2, 7, 403, 404]) {
    const d = new NativeCopilotStderrClassifier();
    for (let i = 0; i < message.length; i += split) d.push(message.subarray(i, i + split));
    assert.equal(d.noAuthenticationInformation, true);
  }
  const wrong = Buffer.from(message);
  wrong[100] ^= 1;
  for (const bytes of [
    wrong,
    Buffer.concat([Buffer.from('x'), message]),
    Buffer.concat([message, Buffer.from('x')]),
    message.subarray(0, -1),
    Buffer.alloc(404, 120),
  ]) {
    const d = new NativeCopilotStderrClassifier();
    d.push(bytes);
    assert.equal(d.noAuthenticationInformation, false);
  }
  const d = new NativeCopilotStderrClassifier();
  d.push(message);
  assert.equal(JSON.stringify(d), '{}', 'no raw native bytes or internal state are exposed');
  const stubbedCli = {
    code: 1,
    signal: null,
    spawned: true,
    stdoutBytes: 0,
    frames: 0,
    connections: 0,
    upstreamBytes: 0,
  };
  assert.equal(classifyCopilotLoginRefusal(stubbedCli, d), 'none', 'the stubbed CLI sent no request');
  assert.equal(classifyCopilotLoginRefusal({ ...stubbedCli, connections: 1 }, d), 'possible');
  assert.equal(classifyCopilotLoginRefusal({ ...stubbedCli, stdoutBytes: 1 }, d), null);
  const nativeText = new NativeCopilotStderrClassifier();
  nativeText.push(Buffer.concat([message, Buffer.from('original-private-token')]));
  assert.equal(classifyCopilotLoginRefusal(stubbedCli, nativeText), null);
});

test('selected native metadata projection preserves only unique supported host/login and never unrelated or other-account data', () => {
  const selected = { host: 'https://github.com', login: 'original-user' },
    other = { host: 'https://github.com', login: 'other-original-user' },
    state = {
      lastLoggedInUser: selected,
      loggedInUsers: [selected, other],
      copilotUser: { subscription: 'private-extra' },
      token: 'original-private-token',
      unrelated: 'data // with comment characters',
    };
  const projected = projectNativeCopilotSelector(Buffer.from('// original JSONC header\n' + JSON.stringify(state)));
  assert.deepEqual(projected, selected);
  assert(Object.isFrozen(projected));
  assert.equal(JSON.stringify(projected).includes('private'), false);
  assert.equal(JSON.stringify(projected).includes(other.login), false);
  for (const invalid of [
    {},
    { ...state, lastLoggedInUser: undefined },
    { ...state, loggedInUsers: [other] },
    { ...state, loggedInUsers: [selected, selected] },
    { ...state, lastLoggedInUser: { ...selected, token: 'original-private-token' } },
    { ...state, lastLoggedInUser: { ...selected, derivedFrom: 'other' } },
    { ...state, lastLoggedInUser: { ...selected, host: 'https://example.invalid' } },
    { ...state, lastLoggedInUser: { ...selected, login: '../credential' } },
    { ...state, loggedInUsers: Array(65).fill(selected) },
  ])
    assert.throws(
      () => projectNativeCopilotSelector(Buffer.from(JSON.stringify(invalid))),
      (e: any) => e.code === 'sentinel.provider.credentialUnavailable' && !e.message.includes('original-private-token'),
    );
  assert.throws(() => projectNativeCopilotSelector(Buffer.alloc(262145)));
  assert.throws(() => projectNativeCopilotSelector(Buffer.from('/* unterminated')));
});
test('native selector file read refuses missing, symlink, hardlink, FIFO and expired proof without native auth', async (t) => {
  const dir = scratch(t, 'copilot-selector-'),
    prior = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = dir;
  t.after(() => {
    if (prior === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = prior;
  });
  const timing = { deadlineAt: Date.now() + 2000 };
  await assert.rejects(
    readNativeCopilotSelector(timing),
    (e: any) => e.code === 'sentinel.provider.credentialUnavailable' && e.spend === 'none',
  );
  const path = join(dir, 'config.json'),
    value = { host: 'https://github.com', login: 'original-user' },
    bytes = JSON.stringify({ lastLoggedInUser: value, loggedInUsers: [value] });
  writeFileSync(path, bytes);
  assert.deepEqual(await readNativeCopilotSelector(timing), value);
  linkSync(path, join(dir, 'linked'));
  await assert.rejects(
    readNativeCopilotSelector(timing),
    (e: any) => e.code === 'sentinel.provider.credentialUnavailable' && e.spend === 'none',
  );
  unlinkSync(join(dir, 'linked'));
  unlinkSync(path);
  writeFileSync(join(dir, 'target'), bytes);
  symlinkSync(join(dir, 'target'), path);
  await assert.rejects(
    readNativeCopilotSelector(timing),
    (e: any) => e.code === 'sentinel.provider.credentialUnavailable' && e.spend === 'none',
  );
  unlinkSync(path);
  const fifo = spawnSync('/usr/bin/mkfifo', [path]);
  assert.equal(fifo.status, 0);
  await assert.rejects(
    readNativeCopilotSelector(timing),
    (e: any) => e.code === 'sentinel.provider.credentialUnavailable' && e.spend === 'none',
  );
  await assert.rejects(
    readNativeCopilotSelector({ deadlineAt: Date.now() - 1 }),
    (e: any) => e.code === 'sentinel.provider.timeout',
  );
});

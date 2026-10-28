// The browser half of a composite start (U-3): a paid.admit receipt the paired owner panel issued and its own book
// spent opens a model envelope, and reaches a native run and a brokered CLI-runner call, through the broker's one
// `spentForIntent` rule; an unconsumed, copied, replayed or other-intent receipt is refused at each of the three sites,
// and the CLI book path is unchanged. No provider process, credential, endpoint or inference: for this file only, the
// claude-cli kind is replaced by a fake whose qualify, call and run start nothing. Its issue, begin and finish are the
// real authority.ts functions, so their re-checks run on the held object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const REGISTRY = new URL('../dist/review/providers/registry.js', import.meta.url).href;
const FAKE = REGISTRY + '?fake-cli';
const MODEL = 'claude-haiku-4-5-20251001';
const fake = {
  mode: 'brokered' as 'brokered' | 'native',
  loose: false,
  runtime: Object.freeze({ fakeCli: true }),
  calls: 0,
  runs: 0,
  reply: Object.freeze({
    content: 'fine',
    returnedModel: MODEL,
    usage: Object.freeze({ inputTokens: 40, outputTokens: 3 }),
    finish: 'complete',
  }),
  result: Object.freeze({
    finalAnswer: 'fine',
    reportedModel: MODEL,
    turns: 1,
    tools: Object.freeze([]),
    filesRead: Object.freeze([]),
    usage: Object.freeze({ inputTokens: 40, outputTokens: 3, requests: 1 }),
    events: new Uint8Array(),
    share: new Uint8Array(),
  }),
};
(globalThis as any).__sentinelFakeCli = fake;
const FAKE_SOURCE = `
import * as real from './registry.js?real';
import { issueNativeCall, beginNativeCall, finishNativeCall, issueClaudeAgentCall, beginClaudeAgentCall,
  finishClaudeAgentCall } from './authority.js';
export * from './registry.js?real';
const hooks = globalThis.__sentinelFakeCli;
const base = real.providerKind('claude-cli');
const cli = Object.freeze({
  ...base.cli,
  checkBinding(settings, model, limits) { if (!hooks.loose) base.cli.checkBinding(settings, model, limits); },
  async qualify() { return hooks.runtime; },
  mode: () => hooks.mode,
  // the fake reads no keychain: its native run is handed the test's synthetic token below
  credentialSource: () => 'vendor',
  releaseGate: undefined,
  issue: (c) => issueNativeCall(c),
  async call(authority) { beginNativeCall(authority); hooks.calls++; return hooks.reply; },
  release: (authority) => finishNativeCall(authority),
  agent: Object.freeze({
    ...base.cli.agent,
    // the real Claude agent authority, with a synthetic token in place of the owner's
    issue: (c) => issueClaudeAgentCall({ ...c, credential: hooks.secret }),
    async call(authority) { beginClaudeAgentCall(authority); hooks.runs++; return hooks.result; },
    release: (authority) => finishClaudeAgentCall(authority),
    installation: () => Object.freeze({ source: 'fake', executable: 'fake-cli' }),
  }),
});
const entry = Object.freeze({ ...base, cli });
export function providerKind(kind) { return kind === 'claude-cli' ? entry : real.providerKind(kind); }
export const cliKind = (kind) => providerKind(kind).cli;
export const PROVIDER_KIND_ENTRIES = Object.freeze(real.PROVIDER_KIND_ENTRIES.map((e) => (e.kind === 'claude-cli' ? entry : e)));
`;
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    return resolved.url === REGISTRY && context.parentURL !== FAKE
      ? { ...resolved, url: FAKE, shortCircuit: true }
      : resolved;
  },
  load(url, context, next) {
    return url === FAKE ? { format: 'module', source: FAKE_SOURCE, shortCircuit: true } : next(url, context);
  },
});

// Everything that reaches the providers loads after the hook, so it sees the fake kind.
const { DEFAULT_SETTINGS, effectivePolicy, ReceiptBook } = await import('../dist/policy/index.js');
const { BudgetLedger, ModelBroker, bindProvider, envelopeIntent } = await import('../dist/review/providers/index.js');
const authority = await import('../dist/review/providers/authority.js');
const { issueReceipt } = await import('../dist/policy/owner-receipts.js');
const { canonicalDigest } = await import('../dist/policy/digest.js');
const { OwnerUiAuthority, activeOwnerUiProof } = await import('../dist/owner-ui/authority.js');
const { OwnerUiReceiptBook, issueOwnerUiReceipt } = await import('../dist/owner-ui/receipts.js');
const { publishOwnerCompanion } = await import('../dist/owner-ui/descriptor.js');
const { companionDirectory, companionWorkspaceDigest } = await import('@farsight/core/dist/sentinel-companion.js');
const { preparationFixture } = await import('./helpers/preparation-fixture.ts');
const { needsStore } = await import('./snapshot-helpers.ts');
const { D, TERMS, LIMITS } = await import('./provider-helpers.ts');

// Several native turns per run: each brokered one reserves its model's whole 200,000-token context first.
const BUDGET = { maxTokens: 1_000_000, maxCost: null, currency: null };
const PROFILE = {
  id: 'claude-cli-native-v1',
  executableDigest: '',
  helperDigest: D('synthetic-helper'),
  profileDigest: D('synthetic-profile'),
};
{
  const { CLAUDE_NATIVE_PROFILE } = await import('../dist/review/providers/cli-native-profile.js');
  PROFILE.id = CLAUDE_NATIVE_PROFILE.id;
  PROFILE.executableDigest = CLAUDE_NATIVE_PROFILE.executableDigest;
}
const { Secret } = await import('../dist/review/providers/credentials.js');
(fake as any).secret = new Secret('fixture-native-token');
const code = (c: string) => (e: any) => e?.code === c;

/** The adopted native-claude policy; `local` makes the provider loopback-only, so opening needs no receipt. */
function policy(local = false) {
  const endpoint = local ? 'http://127.0.0.1:9' : 'https://api.anthropic.com';
  return effectivePolicy({
    trust: 'adopted',
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      nativeClaudeReviewEnabled: true,
      grants: [
        {
          actions: ['paid.admit'],
          principals: ['human'],
          // A local envelope is confirmed by its grant, so admission itself spends the receipt it is handed.
          confirm: local ? 'always' : 'never',
          scope: { providers: ['native-claude'] },
        },
      ],
      providers: [
        {
          id: 'native-claude',
          kind: 'claude-cli',
          endpoint,
          credential: null,
          disclosure: local ? 'local-only' : 'hosted',
          nativeProfile: PROFILE,
          // Room for several envelopes of one run: a native turn reserves its whole fixed context.
          budget: { ...BUDGET, maxTokens: 10_000_000 },
          models: [
            {
              id: 'haiku',
              model: MODEL,
              limits: { ...LIMITS, contextTokens: 200000 },
              pricing: { kind: 'subscription-quota', basis: 'owner-subscription' },
              terms: TERMS,
              capability: {
                schema: 'sentinel-model-capability/draft-1',
                kind: 'claude-cli',
                origin: endpoint,
                model: MODEL,
                listed: true,
                revision: null,
                probedAt: '2026-10-22T11:00:00.000000000Z',
              },
            },
          ],
        },
      ],
    } as any,
    settingsDigest: D(local ? 'local' : 'hosted'),
    repoConfig: null,
    repoConfigDigest: null,
  });
}

let tick = 0;
/** A paired owner panel on a real held store: the authority, its session token and a live view at revision 1. */
async function panel(t: any) {
  const f = await preparationFixture(t),
    previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(f.dir, 'owner');
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });
  const owner = new OwnerUiAuthority(f.store, f.ws);
  const hostInstance = 'host-' + 'b'.repeat(32),
    nonce = 'c'.repeat(64);
  const descriptor = await publishOwnerCompanion(companionDirectory(), {
    schema: 'farsight-sentinel-companion/1',
    workspaceDigest: companionWorkspaceDigest(f.ws.path),
    ownerOrigin: 'http://127.0.0.1:4501',
    farsightOrigin: 'http://127.0.0.1:4500',
    hostInstance,
    processNonce: nonce,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  t.after(() => descriptor.close());
  /** Pairs a panel session with a live view; pairing again replaces the earlier session, as the companion does. */
  const session = () => {
    const { proof } = owner.pair({ farsightOrigin: 'http://127.0.0.1:4500', hostInstance, processNonce: nonce });
    owner.context(proof, {
      frameNonce: 'frame-' + 'd'.repeat(32),
      documentId: 'document-' + 'e'.repeat(32),
      revision: 1,
      hostInstance,
      mode: 'live',
      sync: null,
    });
    return proof;
  };
  const token = session();
  const ledger = await BudgetLedger.open(join(f.dir, 'budget.db'));
  t.after(() => ledger.close());
  const broker = new ModelBroker({
    ledger,
    credentials: async () => {
      throw new Error('no credential is read for a CLI kind');
    },
    epoch: 'e',
    // Strictly later each time it is asked, so two admissions never share a decision time (and an envelope id).
    now: () => new Date(Date.now() + ++tick),
  });
  return { f, owner, token, session, ledger, broker, receipts: join(f.ws.trustDir, 'receipts') };
}

/** Inside one confirming request (a run.start scope): the panel's book, and a paid.admit receipt per binding given. */
async function confirm(p: Awaited<ReturnType<typeof panel>>, bindings: any[], token = p.token) {
  return p.owner.with(token, 1, 'run.start', () => {
    const book = new OwnerUiReceiptBook(p.receipts, activeOwnerUiProof()!);
    return { book, ids: bindings.map((b) => issueOwnerUiReceipt(book, b, new Date()).id as string) };
  });
}

const bindingFor = (pol: any, binding: any, runId: string) => ({
  intent: envelopeIntent(binding, runId, BUDGET),
  stateDigest: D('plan'),
  policyRevision: pol.revision,
});
const requestFor = (pol: any, binding: any, runId = 'run-1') => ({
  binding,
  policy: pol,
  runId,
  budget: BUDGET,
  requestedBy: { principal: 'human' as const, channel: 'owner-ui' as const },
  stateDigest: D('plan'),
});
const messages = [
  { role: 'system' as const, content: 'review this' },
  { role: 'user' as const, content: 'tiny source' },
];
let op = 0;
async function call(broker: any, env: any, binding: any) {
  fake.mode = 'brokered';
  const wire = broker.renderRequest(binding, messages, 64);
  return broker.generate(env, binding, {
    operationId: `op-${++op}`,
    messages,
    maxOutputTokens: 64,
    expectedWireDigest: canonicalDigest(wire),
    deadlineAt: Date.now() + 1500,
  });
}
async function run(broker: any, env: any, binding: any) {
  fake.mode = 'native';
  return broker.runAgent(env, binding, {
    operationId: `op-${++op}`,
    files: [],
    instructions: new TextEncoder().encode('review this'),
    digests: { instructions: D('review this'), files: [] },
    task: 'review',
    maxTurns: 1,
    tokens: 1000,
    deadlineAt: Date.now() + 60000,
  });
}
/** A book with only `consume`, which hands back whatever object the case names: the broker trusts nothing it returns. */
const handing = (value: unknown) => ({ consume: () => value as any });

test(
  "an owner-UI book's consumed paid.admit receipt opens the envelope and reaches a brokered CLI-runner call and a native run",
  needsStore,
  async (t) => {
    const p = await panel(t),
      pol = policy(),
      binding = bindProvider(pol, 'native-claude', 'haiku');
    const { book, ids } = await confirm(p, [bindingFor(pol, binding, 'run-1')]);
    // The confirming request has returned and its scope is closed: the run's book still spends its envelope receipt.
    const env = await p.broker.openEnvelope({ ...requestFor(pol, binding), receipt: { book, id: ids[0]! } });
    assert.match(env.receiptDigest!, /^sha256:/);
    const before = { calls: fake.calls, runs: fake.runs };
    assert.equal((await call(p.broker, env, binding)).content, 'fine');
    assert.equal((await run(p.broker, env, binding)).result.finalAnswer, 'fine');
    assert.deepEqual({ calls: fake.calls, runs: fake.runs }, { calls: before.calls + 1, runs: before.runs + 1 });
  },
);

test(
  'openEnvelope refuses an unconsumed, copied, replayed or other-intent owner-UI receipt; the real book refuses another binding and a second spend itself',
  needsStore,
  async (t) => {
    const p = await panel(t),
      pol = policy(),
      binding = bindProvider(pol, 'native-claude', 'haiku'),
      mine = bindingFor(pol, binding, 'run-1'),
      other = bindingFor(pol, binding, 'run-2');
    const { book, ids } = await confirm(p, [mine, other, mine, other, mine]);
    const [first, forOther, copied, spentOther, unspent] = ids as [string, string, string, string, string];
    const req = requestFor(pol, binding);
    // The real owner-UI book checks the binding and the spend itself.
    await assert.rejects(
      p.broker.openEnvelope({ ...req, receipt: { book, id: forOther } }),
      code('sentinel.receipt.mismatch'),
    );
    await p.broker.openEnvelope({ ...req, receipt: { book, id: first } });
    await assert.rejects(
      p.broker.openEnvelope({ ...req, receipt: { book, id: first } }),
      code('sentinel.receipt.alreadyUsed'),
    );
    const envelopes = p.ledger.listEnvelopes({ limit: 50 }).length;
    // Whatever a book hands back, only an object a book's consume returned, for this intent, opening this envelope, passes.
    const genuineOther = book.consume(spentOther, other, new Date());
    const genuineMine = book.consume(copied, mine, new Date());
    const record = JSON.parse(readFileSync(join(p.receipts, `${unspent}.json`), 'utf8'));
    for (const [what, value] of [
      ['never through consume', { receipt: record, digest: canonicalDigest(record) }],
      ['a JSON copy of a spent receipt', JSON.parse(JSON.stringify(genuineMine))],
      ['spent for another intent', genuineOther],
    ] as const) {
      await assert.rejects(
        p.broker.openEnvelope({ ...req, receipt: { book: handing(value), id: 'receipt-x' } }),
        code('sentinel.provider.receiptRequired'),
        what,
      );
    }
    // Replayed: a spent receipt opens the first envelope it is handed to, and a second envelope never takes it over.
    await p.broker.openEnvelope({ ...req, receipt: { book: handing(genuineMine), id: 'r' } });
    await assert.rejects(
      p.broker.openEnvelope({ ...req, receipt: { book: handing(genuineMine), id: 'r' } }),
      code('sentinel.provider.receiptRequired'),
      'the same spent receipt handed back for a second envelope',
    );
    assert.equal(p.ledger.listEnvelopes({ limit: 50 }).length, envelopes + 1, 'only the genuine first open recorded');
  },
);

test(
  'the native run and the brokered CLI-runner call refuse a copied, unconsumed, replayed or other-intent receipt an envelope holds',
  needsStore,
  async (t) => {
    // A loopback provider opens with no receipt check of its own, so whatever its book handed back is what the two
    // inner sites see; the fake kind skips only the fixed hosted-endpoint bounds for it.
    fake.loose = true;
    t.after(() => {
      fake.loose = false;
    });
    const p = await panel(t),
      pol = policy(true),
      binding = bindProvider(pol, 'native-claude', 'haiku'),
      mine = bindingFor(pol, binding, 'run-1'),
      other = bindingFor(pol, binding, 'run-2');
    const { book, ids } = await confirm(p, [mine, mine, other, mine, mine]);
    const [genuine, toCopy, forOther, toReplay, unspent] = ids as [string, string, string, string, string];
    const req = requestFor(pol, binding);
    // The genuine one: admission spends it through the owner-UI book, and both inner sites accept it.
    const good = await p.broker.openEnvelope({ ...req, receipt: { book, id: genuine } });
    assert.equal((await call(p.broker, good, binding)).content, 'fine');
    assert.equal((await run(p.broker, good, binding)).result.finalAnswer, 'fine');
    const spent = book.consume(toCopy, mine, new Date()),
      spentOther = book.consume(forOther, other, new Date()),
      replayed = book.consume(toReplay, mine, new Date()),
      record = JSON.parse(readFileSync(join(p.receipts, `${unspent}.json`), 'utf8'));
    // Replayed: the spent receipt serves the first envelope it opened; handed back for a second, that one is refused.
    const owner = await p.broker.openEnvelope({ ...req, receipt: { book: handing(replayed), id: 'r' } });
    assert.equal((await call(p.broker, owner, binding)).content, 'fine');
    for (const [what, value] of [
      ['never through consume', { receipt: record, digest: canonicalDigest(record) }],
      ['a JSON copy of a spent receipt', JSON.parse(JSON.stringify(spent))],
      ['spent for another intent', spentOther],
      ['replayed into a second envelope', replayed],
    ] as const) {
      const env = await p.broker.openEnvelope({ ...req, receipt: { book: handing(value), id: 'receipt-x' } });
      const before = { calls: fake.calls, runs: fake.runs };
      await assert.rejects(call(p.broker, env, binding), code('sentinel.provider.notAdmitted'), `${what}: call`);
      await assert.rejects(run(p.broker, env, binding), code('sentinel.provider.notAdmitted'), `${what}: run`);
      assert.deepEqual({ calls: fake.calls, runs: fake.runs }, before, `${what}: nothing started`);
    }
  },
);

test(
  'the owner CLI book path is unchanged: its receipt opens, calls and runs; a copy of it opens nothing',
  needsStore,
  async (t) => {
    const p = await panel(t),
      pol = policy(),
      binding = bindProvider(pol, 'native-claude', 'haiku'),
      cliBook = new ReceiptBook(join(p.f.dir, 'cli-receipts'));
    const issue = () =>
      issueReceipt(cliBook, { channel: 'owner-cli', principal: 'owner' }, bindingFor(pol, binding, 'run-1'), {
        now: new Date(),
        ttlMs: 600_000,
      }).id;
    const req = {
      ...requestFor(pol, binding),
      requestedBy: { principal: 'human' as const, channel: 'owner-cli' as const },
    };
    const env = await p.broker.openEnvelope({ ...req, receipt: { book: cliBook, id: issue() } });
    assert.equal((await call(p.broker, env, binding)).content, 'fine');
    assert.equal((await run(p.broker, env, binding)).result.finalAnswer, 'fine');
    const spent = cliBook.consume(issue(), bindingFor(pol, binding, 'run-1'), new Date());
    await assert.rejects(
      p.broker.openEnvelope({ ...req, receipt: { book: handing(JSON.parse(JSON.stringify(spent))), id: 'r' } }),
      code('sentinel.provider.receiptRequired'),
    );
  },
);

test(
  "authority.ts: a call or a native run (Claude's included) begins only under a receipt a book's consume returned, whichever book",
  needsStore,
  async (t) => {
    const p = await panel(t),
      pol = policy(),
      binding = bindProvider(pol, 'native-claude', 'haiku'),
      mine = bindingFor(pol, binding, 'run-1');
    const { book, ids } = await confirm(p, [mine]);
    const spent = book.consume(ids[0]!, mine, new Date());
    const ledger = { reservation: () => ({ state: 'dispatched' }) } as any;
    const limits = { deadlineAt: Date.now() + 60000, maxResponseBytes: 1024, maxOutputTokens: 64 };
    const wire = { requestedModel: MODEL, system: 's', stdin: 'u' } as any;
    const request = {
      model: MODEL,
      files: [],
      instructions: new Uint8Array(),
      digests: {},
      task: 't',
      maxTurns: 1,
    } as any;
    const starts = (receipt: any) => [
      () =>
        authority.beginNativeCall(
          authority.issueNativeCall({ runtime: {}, wire, limits, ledger, reservationId: 'r', receipt } as any),
        ),
      () =>
        authority.beginCopilotCall(
          authority.issueCopilotCall({ runtime: {}, wire, limits, ledger, reservationId: 'r', receipt } as any),
        ),
      () =>
        authority.beginCopilotAgentCall(
          authority.issueCopilotAgentCall({ runtime: {}, request, limits, ledger, reservationId: 'r', receipt } as any),
        ),
      () =>
        authority.beginClaudeAgentCall(
          authority.issueClaudeAgentCall({
            runtime: {},
            request,
            limits,
            ledger,
            reservationId: 'r',
            receipt,
            credential: (fake as any).secret,
          } as any),
        ),
    ];
    for (const begin of starts(spent)) assert.doesNotThrow(begin, 'the owner-UI book spent it');
    for (const copy of [JSON.parse(JSON.stringify(spent)), { ...spent }, spent.receipt])
      for (const begin of starts(copy)) assert.throws(begin, code('sentinel.provider.notAdmitted'));
  },
);

test(
  'a paid.admit receipt is issued only inside a run.start scope, and spent after it closes only by the issuing session',
  needsStore,
  async (t) => {
    const p = await panel(t),
      pol = policy(),
      binding = bindProvider(pol, 'native-claude', 'haiku'),
      mine = bindingFor(pol, binding, 'run-1');
    for (const action of [null, 'run.pause', 'run.cancel', 'capture.source', 'settings.adopt'] as const)
      await assert.rejects(
        p.owner.with(p.token, 1, action, () =>
          issueOwnerUiReceipt(new OwnerUiReceiptBook(p.receipts, activeOwnerUiProof()!), mine, new Date()),
        ),
        (e: any) => typeof e?.code === 'string',
        `no paid.admit receipt inside a ${action ?? 'read'} scope`,
      );
    const { ids } = await confirm(p, [mine]);
    // A run.start receipt, unlike an envelope one, needs its confirming request's scope still open.
    const { book, startId } = await p.owner.with(p.token, 1, 'run.start', () => {
      const b = new OwnerUiReceiptBook(p.receipts, activeOwnerUiProof()!);
      const start = {
        intent: { ...mine.intent, action: 'run.start' },
        stateDigest: mine.stateDigest,
        policyRevision: mine.policyRevision,
      };
      return { book: b, startId: issueOwnerUiReceipt(b, start as any, new Date()).id, start };
    });
    assert.throws(() =>
      book.consume(
        startId,
        {
          intent: { ...mine.intent, action: 'run.start' },
          stateDigest: mine.stateDigest,
          policyRevision: mine.policyRevision,
        } as any,
        new Date(),
      ),
    );
    // The envelope receipt lives ten minutes from its confirmation, a run.start one thirty seconds.
    const issued = JSON.parse(readFileSync(join(p.receipts, `${ids[0]}.json`), 'utf8'));
    assert.equal(
      Date.parse(issued.expiresAt.replace(/(\.\d{3})\d+Z$/, '$1Z')) -
        Date.parse(issued.issuedAt.replace(/(\.\d{3})\d+Z$/, '$1Z')),
      600_000,
    );
    // Another paired panel session (pairing again replaces this one) cannot spend it, even inside its own start.
    const otherToken = p.session();
    const { book: otherBook } = await confirm(p, [], otherToken);
    assert.throws(() => otherBook.consume(ids[0]!, mine, new Date()), code('sentinel.receipt.mismatch'));
  },
);

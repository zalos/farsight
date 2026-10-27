// Silent visible text/owned usage only. These portable controls never invoke native authentication or a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeCopilotDecoder } from '../dist/review/providers/cli-copilot-wire.js';
import { copilotInvocationArguments, cleanCopilotExit } from '../dist/review/providers/cli-copilot-call.js';
import { COPILOT_NATIVE_PROFILE } from '../dist/review/providers/cli-copilot-profile.js';
import { NativeCopilotError, copilotFailureEvent } from '../dist/review/providers/errors.js';
import { ModelCallError } from '../dist/review/providers/broker.js';
import { validateReply } from '../dist/review/validator.js';
const model = 'gpt-6-luna';
const usage = () => ({
  currentModel: model,
  totalUserRequests: 1,
  modelMetrics: {
    [model]: {
      requests: { count: 1, cost: 0 },
      usage: { inputTokens: 51, outputTokens: 9, cacheReadTokens: 20, cacheWriteTokens: 0 },
    },
  },
});
function decode(raw: Uint8Array | string = 'original visible reply\n', u: unknown = usage(), limit = 16384) {
  const d = new NativeCopilotDecoder(limit, model);
  d.push(typeof raw === 'string' ? Buffer.from(raw) : raw);
  return d.finish(Buffer.from(JSON.stringify(u)));
}
test('silent profile and argv select rendered text with model-default effort and the same mechanical tool exclusions', () => {
  const args = copilotInvocationArguments('/private/tmp/original-usage.json', model);
  assert.equal(COPILOT_NATIVE_PROFILE.id, 'copilot-1.0.103-darwin-arm64-seatbelt-v6');
  assert.equal(COPILOT_NATIVE_PROFILE.output, 'silent-text/1');
  assert.equal(COPILOT_NATIVE_PROFILE.reasoningEffort, 'model-default');
  assert.equal(COPILOT_NATIVE_PROFILE.decoder, 'fatal-utf8-visible-and-owned-usage/1');
  assert(args.includes('-s'));
  for (const flag of ['--output-format', '--stream', '--reasoning-effort', '--no-auto-login', '--resume', '--continue'])
    assert.equal(args.includes(flag), false);
  assert.deepEqual(args.slice(args.indexOf('--excluded-tools') + 1, args.indexOf('--excluded-tools') + 4), [
    'builtin:*',
    'mcp:*',
    'custom:*',
  ]);
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', model]);
  assert.deepEqual(args.slice(args.indexOf('--usage-output-file'), args.indexOf('--usage-output-file') + 2), [
    '--usage-output-file',
    '/private/tmp/original-usage.json',
  ]);
});
test('rendered visible bytes need no session event and preserve all text except at most one final LF', () => {
  assert.deepEqual(decode(), {
    content: 'original visible reply',
    returnedModel: model,
    usage: { inputTokens: 51, outputTokens: 9 },
    finish: 'complete',
  });
  for (const text of [
    'original\n\n',
    ' original \n',
    '\ufefforiginal\n',
    'original\r\n',
    'first visible\n\nsecond visible',
  ])
    assert.equal(decode(text).content, text.endsWith('\n') ? text.slice(0, -1) : text);
  const d = new NativeCopilotDecoder(16384, model),
    raw = Buffer.from('original € visible\n');
  for (const byte of raw) d.push(Buffer.from([byte]));
  assert.equal(d.finish(Buffer.from(JSON.stringify(usage()))).content, 'original € visible');
  assert.deepEqual(d.observation(), { bytes: raw.length, frames: 0, eventClass: 'visible' });
});
for (const [name, text] of [
  ['empty', ''],
  ['blank', ' \n\t'],
  ['NUL', 'original\u0000private'],
  ['ANSI CSI', '\u001b[31moriginal'],
  ['ANSI OSC', '\u001b]0;original\u0007'],
  ['C1 CSI', '\u009boriginal'],
  ['invalid UTF8', Buffer.from([0xff])],
  ['truncated UTF8', Buffer.from([0xe2, 0x82])],
] as const)
  test('silent codec refuses ' + name, () =>
    assert.throws(
      () => decode(text),
      (e: any) =>
        e instanceof NativeCopilotError && e.spend === 'possible' && e.nativeCopilot.reason === 'visible-message',
    ),
  );
test('combined visible and owned usage byte boundary is exact and never accepts a prefix', () => {
  const text = 'original',
    bytes = Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(usage()));
  assert.equal(decode(text, usage(), bytes).content, text);
  assert.throws(
    () => decode(text, usage(), bytes - 1),
    (e: any) => e.code === 'sentinel.provider.responseTooLarge' && e.spend === 'possible',
  );
  const d = new NativeCopilotDecoder(3, model);
  assert.throws(
    () => d.push(Buffer.from('four')),
    (e: any) => e.code === 'sentinel.provider.responseTooLarge',
  );
});
for (const [name, make] of [
  ['missing usage', () => ({})],
  ['wrong model', () => ({ ...usage(), currentModel: 'other' })],
  [
    'extra model',
    () => ({ ...usage(), modelMetrics: { ...usage().modelMetrics, other: usage().modelMetrics[model] } }),
  ],
  ['no user request', () => ({ ...usage(), totalUserRequests: 0 })],
  ['two user requests', () => ({ ...usage(), totalUserRequests: 2 })],
  [
    'multiple requests',
    () => ({ ...usage(), modelMetrics: { [model]: { ...usage().modelMetrics[model], requests: { count: 2 } } } }),
  ],
  [
    'missing cache counts',
    () => ({
      ...usage(),
      modelMetrics: { [model]: { ...usage().modelMetrics[model], usage: { inputTokens: 51, outputTokens: 9 } } },
    }),
  ],
  [
    'negative counts',
    () => ({
      ...usage(),
      modelMetrics: {
        [model]: { ...usage().modelMetrics[model], usage: { ...usage().modelMetrics[model].usage, inputTokens: -1 } },
      },
    }),
  ],
  [
    'fraction counts',
    () => ({
      ...usage(),
      modelMetrics: {
        [model]: { ...usage().modelMetrics[model], usage: { ...usage().modelMetrics[model].usage, outputTokens: 1.5 } },
      },
    }),
  ],
  [
    'unsafe counts',
    () => ({
      ...usage(),
      modelMetrics: {
        [model]: {
          ...usage().modelMetrics[model],
          usage: { ...usage().modelMetrics[model].usage, cacheReadTokens: Number.MAX_SAFE_INTEGER + 1 },
        },
      },
    }),
  ],
] as const)
  test('silent codec refuses ' + name, () =>
    assert.throws(
      () => decode('original', make()),
      (e: any) => e.spend === 'possible',
    ),
  );
test('usage JSON is fatal UTF8 and complete JSON, not a prefix', () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{}trailing'), Buffer.from('{')]) {
    const d = new NativeCopilotDecoder(16384, model);
    d.push(Buffer.from('original'));
    assert.throws(
      () => d.finish(bytes),
      (e: any) => e.nativeCopilot.reason === 'usage-shape',
    );
  }
});
test('visible codec does not invent session/event authority; downstream Sentinel grammar still rejects telemetry and invented actions', () => {
  for (const raw of [
    '{"type":"tool.execution_start","data":{}}',
    '{"action":"shell","command":"original"}',
    'first visible\n\n{"action":"list"}',
  ]) {
    const parsed = decode(raw);
    assert.equal(parsed.content, raw);
    assert.equal(validateReply(parsed.content, {} as any, new Set(['list'])).ok, false);
  }
  const parsed = decode('{"action":"list"}\n');
  assert.deepEqual(validateReply(parsed.content, {} as any, new Set(['list'])), {
    ok: true,
    kind: 'tool',
    request: { action: 'list' },
  });
});
test('silent failure diagnostics retain only closed counts and do not retain visible content', () => {
  const secret = 'original-private-shaped-value',
    d = new NativeCopilotDecoder(16384, model);
  d.push(Buffer.from(secret + '\u0000'));
  let e: any;
  try {
    d.finish(Buffer.from(JSON.stringify(usage())));
  } catch (error) {
    e = error;
  }
  assert(e instanceof NativeCopilotError);
  assert.equal(e.nativeCopilot.frames, 0);
  assert.equal(e.nativeCopilot.eventClass, 'visible');
  assert.equal(e.nativeCopilot.reason, 'visible-message');
  const retained = copilotFailureEvent(e);
  assert(retained.length <= 200);
  assert.equal(retained.includes(secret), false);
  assert.deepEqual(new ModelCallError(e, null).nativeCopilot, e.nativeCopilot);
  assert.throws(() => new NativeCopilotError(e.code, 'possible', { ...e.nativeCopilot, raw: secret } as any));
});

test('only a clean exit-zero native process with zero stderr can reach accepted text/usage decoding', () => {
  assert.equal(cleanCopilotExit(0, null, true, 0), true);
  for (const args of [
    [1, null, true, 0],
    [null, null, true, 0],
    [0, 'SIGKILL', true, 0],
    [0, null, false, 0],
    [0, null, true, 1],
    [0, null, true, 75],
    [0, null, true, NaN],
  ] as const)
    assert.equal(cleanCopilotExit(...args), false);
});

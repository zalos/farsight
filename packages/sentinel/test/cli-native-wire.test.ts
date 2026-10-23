// Synthetic vendor frames only. No keychain read, subprocess, network or model request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeClaudeDecoder, renderNativeClaudeWire } from '../dist/review/providers/cli-native-wire.js';
import { canonicalDigest } from '../dist/policy/digest.js';
const model = 'claude-haiku-4-5-20251001';
const init = { type: 'system', subtype: 'init', model };
const result = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, stop_reason: 'end_turn', result: 'NO_FINDING',
  usage: { input_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 4 }, modelUsage: { [model]: {} } };
const decode = (events: unknown[], cap = 10000) => { const d = new NativeClaudeDecoder(cap); for (const e of events) d.push(Buffer.from(JSON.stringify(e) + '\n')); return d.finish(); };
const refused = (fn: () => unknown) => assert.throws(fn, (e: any) => e.code?.startsWith('sentinel.provider.'));
test('native wire retains exact assembled system and canonical role-tagged history with requested model/output bound', () => {
  const messages = [{ role: 'system', content: 'base\nselected skill verbatim\n' }, { role: 'user', content: 'bounded source' }, { role: 'assistant', content: 'visible prior answer' }, { role: 'user', content: 'continue' }];
  const wire = renderNativeClaudeWire(model, messages as any, 128);
  assert.equal(wire.system, messages[0]!.content); assert.deepEqual(JSON.parse(wire.stdin), { encoding: wire.encoding, maxOutputTokens: 128, messages: messages.slice(1) });
  assert.equal(wire.requestedModel, model); assert.ok(Object.isFrozen(wire));
  assert.notEqual(canonicalDigest(wire), canonicalDigest({ ...wire, encoding: 'changed-version' }));
  assert.notEqual(canonicalDigest(wire), canonicalDigest(renderNativeClaudeWire(model, messages as any, 129)));
  refused(() => renderNativeClaudeWire(model, messages.slice(1) as any, 128));
  refused(() => renderNativeClaudeWire(model, [messages[0], messages[0]] as any, 128));
});
test('native decoder exposes only final visible result and actual reported token counts including caches', () => {
  const out = decode([init, { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private reasoning never retained' }, { type: 'text', text: 'intermediate' }] } }, result]);
  assert.equal(out.content, 'NO_FINDING'); assert.equal(out.returnedModel, model); assert.deepEqual(out.usage, { inputTokens: 15, outputTokens: 4 });
  assert.ok(!JSON.stringify(out).includes('private reasoning')); assert.ok(!JSON.stringify(out).includes('intermediate'));
});
test('EOF0, partial/failed results, multiple results, unknown usage and model disagreement cannot become accepted completion', () => {
  for (const events of [[], [init], [init, { ...result, subtype: 'error_during_execution' }], [init, { ...result, is_error: true }], [init, { ...result, num_turns: 2 }],
    [init, result, result], [result], [init, { ...result, modelUsage: { other: {} } }], [init, { ...result, usage: { input_tokens: 10, output_tokens: 4 } }],
    [init, { type: 'assistant', message: { content: [{ type: 'tool_use' }] } }, result]]) refused(() => decode(events));
});
test('native frames have a total byte/count bound, strict UTF8/JSON and survive ordinary arbitrary chunk boundaries', () => {
  const bytes = Buffer.from([init, result].map(e => JSON.stringify(e)).join('\n') + '\n'), d = new NativeClaudeDecoder(bytes.length);
  for (const byte of bytes) d.push(Buffer.from([byte])); assert.equal(d.finish().content, 'NO_FINDING');
  refused(() => decode([init, result], bytes.length - 1));
  refused(() => { const d = new NativeClaudeDecoder(1000); d.push(Buffer.from([255,10])); });
  refused(() => decode(Array.from({ length: 129 }, () => ({ type: 'system', subtype: 'status' }))));
});

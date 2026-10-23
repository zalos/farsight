// Synthetic only: no real native keychain read, OAuth token, model call or external connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { PassThrough, Writable } from 'node:stream';
import { connect } from 'node:net';
import { parseNativeClaudeToken, sendNativeClaudeToken, discardNativeClaudeToken } from '../dist/review/providers/cli-native-auth.js';
import { qualifyNativeClaude, nativeClaudeSetup } from '../dist/review/providers/cli-native-profile.js';
import { isNativePublicAddress, nativeClaudeClientHello, openNativeClaudeProxy } from '../dist/review/providers/cli-native-proxy.js';

const synthetic = 'synthetic-nonsecret-descriptor-control';
const original = () => Date.now() + 2000;
const raw = (over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: synthetic, expiresAt: Date.now() + 10000, scopes: ['user:inference'], ...over } }));
const code = (c: string) => (e: any) => e?.code === c;

test('native token parsing retains only a redacted, one-send memory handle', async () => {
  const at = original(), token = parseNativeClaudeToken(raw({ refreshToken: 'ignored-nonsecret-control' }), at);
  assert.equal(JSON.stringify(token), '"[redacted]"'); assert.ok(!inspect(token).includes(synthetic)); assert.equal(String(token), '[redacted]');
  assert.deepEqual(Object.keys(token), ['expiresAt']); assert.ok(Object.isFrozen(token));
  const pipe = new PassThrough(); const chunks: Buffer[] = []; pipe.on('data', x => chunks.push(Buffer.from(x)));
  await sendNativeClaudeToken(token, pipe, at);
  assert.equal(Buffer.concat(chunks).toString(), synthetic);
  await assert.rejects(sendNativeClaudeToken(token, new PassThrough(), at), code('sentinel.provider.credentialUnavailable'));
});

test('native credential shape, scopes, expiry, text and byte limits fail closed without echoing input', () => {
  const at = original();
  for (const bytes of [Buffer.from('{}'), Buffer.from('invalid'), Buffer.from([0xff]), Buffer.alloc(65537), raw({ accessToken: '' }), raw({ accessToken: 'x'.repeat(8193) }),
    raw({ accessToken: 'two words' }), raw({ accessToken: 'line\nbreak' }), raw({ expiresAt: at }), raw({ expiresAt: at + 5000 }), raw({ expiresAt: Infinity }), raw({ expiresAt: at + 0.5 }),
    raw({ accessToken: 'nonasciié' }), raw({ scopes: ['user:inference','user:inference'] }), raw({ scopes: [] }), raw({ scopes: ['user:inference', 'unknown:scope'] }), raw({ scopes: 'user:inference' })]) {
    assert.throws(() => parseNativeClaudeToken(bytes, at), (e: any) => e.code === 'sentinel.provider.credentialUnavailable' && !e.message.includes(synthetic));
  }
});

test('cancel, expired deadline, forged/discarded handles cannot deliver a token', async () => {
  const c = new AbortController(); c.abort();
  assert.throws(() => parseNativeClaudeToken(raw(), original(), c.signal), code('sentinel.provider.canceled'));
  assert.throws(() => parseNativeClaudeToken(raw(), Date.now() - 1), code('sentinel.provider.timeout'));
  const token = parseNativeClaudeToken(raw(), original()); discardNativeClaudeToken(token);
  for (const value of [token, { expiresAt: Date.now() + 10000 }]) await assert.rejects(sendNativeClaudeToken(value, new PassThrough(), original()), code('sentinel.provider.credentialUnavailable'));
});

test('cancel while anonymous descriptor delivery is pending cannot complete late or reuse the token', async () => {
  let release!: (error?: Error | null) => void;
  const pipe = new Writable({ write(_chunk, _encoding, callback) { release = callback; } });
  const c = new AbortController(), at = original(), token = parseNativeClaudeToken(raw(), at);
  const pending = sendNativeClaudeToken(token, pipe, at, c.signal); c.abort();
  await assert.rejects(pending, code('sentinel.provider.canceled')); release();
  assert.equal(pipe.destroyed, true);
  await assert.rejects(sendNativeClaudeToken(token, new PassThrough(), at), code('sentinel.provider.credentialUnavailable'));
});

test('a qualified native runtime cannot be forged or substituted with another executable', async () => {
  await assert.rejects(nativeClaudeSetup({ profileId: 'fake', executableDigest: 'fake' }, 1, { deadlineAt: original() }), code('sentinel.provider.notTrusted'));
  await assert.rejects(qualifyNativeClaude('/usr/bin/true'), code('sentinel.provider.capabilityUntested'));
});

test('egress address classification excludes local inference, private, mapped, documentation and multicast targets', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '224.0.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff00::1', '2001:db8::1', 'localhost']) assert.equal(isNativePublicAddress(address), false, address);
  assert.equal(isNativePublicAddress('8.8.8.8'), true); assert.equal(isNativePublicAddress('2606:4700::1111'), true);
});

async function request(bytes: string, options: Record<string, unknown> = {}) {
  const p = await openNativeClaudeProxy({ deadlineAt: original(), maxUpstreamBytes: 1024, maxDownstreamBytes: 1024, ...options });
  try {
    await new Promise<void>((resolve, reject) => {
      const client = connect(p.port, '127.0.0.1'); client.on('error', reject); client.resume(); client.once('connect', () => client.write(Buffer.from(bytes, 'latin1'))); client.once('close', () => resolve());
    });
    return p.observation();
  } finally { await p.close(); }
}

test('actual owned loopback gate refuses arbitrary hosts, local models, HTTP forwarding and malformed CONNECT before DNS', async () => {
  for (const bytes of ['CONNECT 127.0.0.1:11434 HTTP/1.1\r\nHost: 127.0.0.1:11434\r\n\r\n',
    'CONNECT other.example:443 HTTP/1.1\r\nHost: other.example:443\r\n\r\n',
    'CONNECT statsig.anthropic.com:443 HTTP/1.1\r\nHost: statsig.anthropic.com:443\r\n\r\n',
    'GET https://api.anthropic.com/ HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n',
    'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nHost: other.example:443\r\n\r\n']) {
    const observation = await request(bytes);
    assert.equal(observation.endedBy, 'refused'); assert.equal(observation.upstreamWireBytes, 0); assert.equal(observation.downstreamWireBytes, 0);
  }
});

test('egress header, total deadline and cancellation bounds close owned sockets without external traffic', async () => {
  assert.equal((await request('x'.repeat(2049))).endedBy, 'bounds');
  assert.equal((await request('', { deadlineAt: Date.now() + 30 })).endedBy, 'deadline');
  const c = new AbortController();
  const p = await openNativeClaudeProxy({ deadlineAt: original(), signal: c.signal, maxUpstreamBytes: 1, maxDownstreamBytes: 1 });
  c.abort(); await p.close(); assert.equal(p.observation().endedBy, 'canceled');
  await assert.rejects(openNativeClaudeProxy({ deadlineAt: original(), maxUpstreamBytes: NaN, maxDownstreamBytes: 1 }), code('sentinel.provider.invalidProfile'));
});


function hello(host: string) {
  const name = Buffer.from(host);
  const extension = Buffer.alloc(9 + name.length);
  extension.writeUInt16BE(0, 0); extension.writeUInt16BE(5 + name.length, 2); extension.writeUInt16BE(3 + name.length, 4);
  extension[6] = 0; extension.writeUInt16BE(name.length, 7); name.copy(extension, 9);
  const body = Buffer.alloc(43 + extension.length); body.writeUInt16BE(0x0303, 0); body[34] = 0; body.writeUInt16BE(2, 35); body.writeUInt16BE(0x1301, 37);
  body[39] = 1; body[40] = 0; body.writeUInt16BE(extension.length, 41); extension.copy(body, 43);
  const out = Buffer.alloc(9 + body.length); out[0] = 22; out.writeUInt16BE(0x0301, 1); out.writeUInt16BE(4 + body.length, 3);
  out[5] = 1; out.writeUIntBE(body.length, 6, 3); body.copy(out, 9); return out;
}

test('TLS authority must match the fixed CONNECT host before any external connection', async () => {
  const valid = hello('api.anthropic.com');
  assert.equal(nativeClaudeClientHello(valid), 'matched');
  assert.equal(nativeClaudeClientHello(valid.subarray(0, 10)), 'incomplete');
  assert.equal(nativeClaudeClientHello(hello('other.example')), 'refused');
  assert.equal(nativeClaudeClientHello(Buffer.concat([valid, Buffer.from('extra')])), 'refused');
  const observation = await request('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n' + hello('other.example').toString('latin1'));
  assert.equal(observation.endedBy, 'refused'); assert.equal(observation.upstreamWireBytes, 0);
});

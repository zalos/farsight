// PR 20 Stage A: SARIF 2.1.0 and ZAP traditional JSON (plain and plus) normalized from original synthetic reports
// shaped like the formats' documented samples. Every fact is about the supplied bytes; nothing binds, places, verifies
// or mitigates, and no report, absent alert or pass label clears anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importFromFiles, normalizeImport } from '../dist/imports/normalize.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/imports/${name}`, import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(fixture(name), 'utf8'));
const bytes = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));
const run = (report: unknown, manifest: unknown, options = {}): any => normalizeImport(bytes(report), bytes(manifest), options);
const ok = (report: unknown, manifest: unknown, options = {}): any => {
  const r = run(report, manifest, options);
  assert.equal(r.status, 'normalized', JSON.stringify(r).slice(0, 300));
  return r;
};
const refused = (r: any, code: string) => { assert.equal(r.status, 'refused'); assert.equal(r.code, code); };
const facts = (doc: any, name: string) => {
  const c = doc.cookies.find((x: any) => x.name === name);
  assert.ok(c, `cookie ${name}`);
  return Object.fromEntries(c.observations.map((o: any) => [o.property, o]));
};
const codes = (doc: any) => doc.unknowns.map((u: any) => u.code);
const clone = (v: any) => JSON.parse(JSON.stringify(v));

const plus = load('zap-plus.json');
const plusManifest = load('zap-plus.manifest.json');
const plain = load('zap-plain.json');
const plainManifest = load('zap-plain.manifest.json');
const sarif = load('sarif-cookies.sarif.json');
const sarifManifest = load('sarif.manifest.json');

test('ZAP plus: Set-Cookie facts from a consistent request and response, in the stated scope', () => {
  const { document: d, canonical } = ok(plus, plusManifest);
  assert.equal(d.format, 'zap-traditional-json-plus');
  const sid = facts(d, 'sid');
  assert.deepEqual(Object.values(sid).map((o: any) => [o.outcome, o.scope]), [['present', 'stated'], ['present', 'stated'], ['present', 'stated']]);
  assert.equal(sid['cookie-same-site'].sameSite, 'lax');
  const theme = facts(d, 'theme');
  assert.deepEqual(Object.values(theme).map((o: any) => o.outcome), ['absent', 'absent', 'absent']);
  assert.equal(d.cookies.find((c: any) => c.name === 'theme').lifetime, 'expires-stated');
  assert.ok(Object.values(sid).every((o: any) => o.direction === 'outbound'));
  assert.deepEqual(d.exchanges[0].inboundCookieNames, ['pref'], 'inbound: names only');
  assert.equal(d.exchanges[0].origin, 'https://app.example.test');
  assert.ok(codes(d).includes('sentinel.import.sequenceUnsupported'), 'a sequence step is a claim, never an exchange');
  assert.equal(d.tool.programName, null, 'the current template has no @programName; nothing is assumed');
  assert.equal(d.tool.createdClaim, '2026-10-22T10:00:00.000000000Z');
  assert.ok(d.ignored.some((i: any) => i.objectKind === 'zap.report' && i.key === 'insights'));
  assert.ok(d.ignored.some((i: any) => i.objectKind === 'zap.alert' && i.key === 'tags'));
  assert.ok(d.ignored.some((i: any) => i.objectKind === 'zap.instance' && i.key === 'nodeName'));
  assert.deepEqual(d.limitationKeys.slice(0, 3), ['sentinel.import.importedNotExecuted', 'sentinel.import.toolScopeOnly', 'sentinel.import.noWholeApplicationClaim']);
  assert.doesNotMatch(canonical, /synthetic-session-value/, 'cookie values are never in the normalized document');
  assert.doesNotMatch(canonical, /"cookie-(integrity|confidentiality)"/, 'no integrity or confidentiality fact');
  assert.doesNotMatch(canonical, /mitigat|verified|coverage/);
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.cookies[0]));
});

test('normalization is deterministic for the same bytes, manifest and adapter', () => {
  const a = ok(plus, plusManifest);
  const b = ok(plus, plusManifest);
  assert.equal(a.canonical, b.canonical);
  assert.equal(a.digest, b.digest);
  const reordered = clone(plusManifest);
  reordered.tested.methods = ['POST', 'GET'];
  assert.notEqual(ok(plus, reordered).digest, a.digest, 'the manifest bytes are part of the identity');
});

test('ZAP plain: alerts are claims only, documented fields are accepted, HTTP payloads are refused', () => {
  const { document: d } = ok(plain, plainManifest);
  assert.equal(d.cookies.length, 0);
  assert.equal(d.claims.length, 1);
  assert.ok(codes(d).includes('sentinel.import.noExchange'));
  const withPayload = clone(plain);
  withPayload.site[0].alerts[0].instances[0]['response-header'] = 'HTTP/1.1 200\r\n\r\n';
  refused(run(withPayload, plainManifest), 'sentinel.import.formatMismatch');
  const stepPayload = clone(plain);
  stepPayload.sequences[0].steps[0].original['response-header'] = 'HTTP/1.1 200\r\n\r\n';
  refused(run(stepPayload, plainManifest), 'sentinel.import.formatMismatch');
  const undocumented = clone(plain);
  undocumented.site[0].alerts[0].verified = true;
  refused(run(undocumented, plainManifest), 'sentinel.import.formatMalformed');
  refused(run(sarif, plainManifest), 'sentinel.import.formatMismatch');
  refused(run(plain, { ...sarifManifest, producer: { name: null, version: null } }), 'sentinel.import.formatMismatch');
});

test('ZAP producer metadata is compared only where the report states it', () => {
  const want = { ...plainManifest, producer: { name: 'ZAP', version: '2.16.0' } };
  const missing = ok(plain, want).document;
  assert.ok(codes(missing).includes('sentinel.import.producerUnknown'), 'no @programName: unknown, not refused, not assumed');
  refused(run({ ...plain, '@programName': 'Other' }, want), 'sentinel.import.producerMismatch');
  refused(run({ ...plain, '@version': '2.15.0' }, want), 'sentinel.import.producerMismatch');
  assert.equal(ok({ ...plain, '@programName': 'ZAP' }, want).document.tool.programName, 'ZAP');
});

test('ZAP plus: a request that disagrees with its instance, or lies outside the stated scope, stays unbound', () => {
  const inconsistent = clone(plus);
  inconsistent.site[0].alerts[0].instances[0].method = 'GET';
  const a = facts(ok(inconsistent, plusManifest).document, 'sid');
  assert.deepEqual(Object.values(a).map((o: any) => [o.outcome, o.scope, o.scopeReason]), Array(3).fill(['present', 'unbound', 'sentinel.import.requestInconsistent']));
  const originForm = clone(plus);
  originForm.site[0].alerts[0].instances[0]['request-header'] = 'POST /login HTTP/1.1\r\nHost: app.example.test\r\n\r\n';
  assert.equal(facts(ok(originForm, plusManifest).document, 'sid')['cookie-secure'].scopeReason, 'sentinel.import.requestInconsistent');
  const elsewhere = { ...plusManifest, tested: { ...plusManifest.tested, origins: ['https://other.example.test'] } };
  assert.equal(facts(ok(plus, elsewhere).document, 'sid')['cookie-secure'].scopeReason, 'sentinel.import.outsideStatedScope');
  const getOnly = { ...plusManifest, tested: { ...plusManifest.tested, methods: ['GET'] } };
  assert.equal(facts(ok(plus, getOnly).document, 'sid')['cookie-secure'].scope, 'unbound');
  const secureOnly = { ...plusManifest, tested: { ...plusManifest.tested, properties: ['cookie-secure'] } };
  const s = facts(ok(plus, secureOnly).document, 'sid');
  assert.deepEqual([s['cookie-secure'].scope, s['cookie-http-only'].scope, s['cookie-http-only'].scopeReason], ['stated', 'unbound', 'sentinel.import.outsideStatedScope']);
  const inboundOnly = { ...plusManifest, tested: { ...plusManifest.tested, directions: ['inbound'] } };
  assert.equal(facts(ok(plus, inboundOnly).document, 'sid')['cookie-secure'].scope, 'unbound');
});

test('ZAP plus: redirects, folded, truncated, missing and repeated cookies are unknown with their reasons', () => {
  const head = (h: string) => { const r = clone(plus); r.site[0].alerts[0].instances[0]['response-header'] = h; return ok(r, plusManifest).document; };
  const redirect = head('HTTP/1.1 302 Found\r\nLocation: /x\r\nSet-Cookie: sid=v; Secure; HttpOnly\r\n\r\n');
  assert.deepEqual(redirect.cookies[0].observations.map((o: any) => o.reason), Array(3).fill('sentinel.import.redirect'));
  assert.equal(head('HTTP/1.1 200\r\nSet-Cookie: sid=v;\r\n Secure\r\n\r\n').cookies.length, 0);
  assert.ok(codes(head('HTTP/1.1 200\r\nSet-Cookie: sid=v;\r\n Secure\r\n\r\n')).includes('sentinel.import.headerFolded'));
  assert.ok(codes(head('HTTP/1.1 200\r\nSet-Cookie: sid=v; Secure')).includes('sentinel.import.headerTruncated'));
  const dup = head('HTTP/1.1 200\r\nSet-Cookie: sid=a; Secure\r\nSet-Cookie: sid=b; Path=/x\r\n\r\n');
  assert.equal(dup.cookies.length, 2);
  assert.ok(dup.cookies.every((c: any) => c.observations.every((o: any) => o.reason === 'sentinel.import.duplicateInResponse')));
  const missing = clone(plus);
  delete missing.site[0].alerts[0].instances[0]['response-header'];
  assert.ok(codes(ok(missing, plusManifest).document).includes('sentinel.import.missingHeader'));
  const bad = head('HTTP/1.1 200\r\nSet-Cookie: sid="x; Secure; HttpOnly\r\n\r\n');
  assert.equal(bad.cookies[0].parse, 'unknown');
  assert.ok(bad.cookies[0].observations.every((o: any) => o.outcome === 'unknown' && o.reason === 'sentinel.import.cookieMalformed'));
});

test('SARIF: inline and indexed exchanges give cookie facts; a response alone stays unbound; pass and empty results clear nothing', () => {
  const { document: d, canonical } = ok(sarif, sarifManifest);
  const sid = facts(d, 'sid');
  assert.deepEqual(Object.values(sid).map((o: any) => [o.outcome, o.scope]), Array(3).fill(['present', 'stated']));
  const acct = facts(d, 'acct');
  assert.deepEqual(Object.values(acct).map((o: any) => o.outcome), ['present', 'absent', 'present'], 'a strict Expires-date comma keeps its facts');
  assert.equal(acct['cookie-same-site'].sameSite, 'strict');
  assert.equal(d.exchanges.find((e: any) => e.source === 'sarif-indexed').inboundCookieNames[0], 'sid');
  assert.equal(facts(d, 'solo')['cookie-secure'].scopeReason, 'sentinel.import.noExchange');
  const pass = d.claims.find((c: any) => c.kind === 'pass');
  assert.equal(pass.ruleId, 'example-pass');
  assert.equal(d.cookies.length, 3, 'the pass result adds no fact');
  const loc = d.claims[0].locations[0];
  assert.deepEqual([loc.binding, loc.path, loc.hash, loc.region.byteOffset], ['unbound', 'src/app.ts', `sha256:${'ab'.repeat(32)}`, 10]);
  assert.ok(d.ignored.some((i: any) => i.objectKind === 'sarif.result' && i.key === 'codeFlows'), 'code flows are never read as flows');
  assert.equal(d.tool.tools[0].name, 'ExampleDAST');
  assert.doesNotMatch(canonical, /synthetic-session-value|Session cookie flags observed/);
  const empty = ok({ ...sarif, runs: [{ tool: sarif.runs[0].tool, results: [] }] }, sarifManifest).document;
  assert.deepEqual([empty.claims.length, empty.cookies.length], [0, 0]);
  assert.ok(empty.limitationKeys.includes('sentinel.import.noWholeApplicationClaim'));
});

test('SARIF: index references resolve only within the run and only when the inline object agrees', () => {
  const mutate = (f: (r: any) => void) => { const s = clone(sarif); f(s.runs[0]); return ok(s, sarifManifest).document; };
  assert.ok(codes(mutate(r => { r.results[1].webResponse = { index: 5 }; })).includes('sentinel.import.referenceUnresolved'));
  assert.ok(codes(mutate(r => { r.results[1].webResponse = { index: 0, statusCode: 201 }; })).includes('sentinel.import.referenceConflict'));
  assert.ok(codes(mutate(r => { r.results[1].webResponse = { index: 0, reasonPhrase: 'OK' }; })).includes('sentinel.import.referenceConflict'));
  assert.ok(codes(mutate(r => { r.webResponses[0].index = 3; })).includes('sentinel.import.referenceConflict'));
  assert.equal(facts(mutate(r => { r.results[1].webResponse = { index: 0, statusCode: 200 }; }), 'acct')['cookie-secure'].outcome, 'present');
  assert.ok(codes(mutate(r => { delete r.webResponses; })).includes('sentinel.import.referenceUnresolved'));
});

test('SARIF: one headers object cannot carry two cookies, controls or conflicts', () => {
  const resp = (webResponse: any) => { const s = clone(sarif); s.runs[0].results[0].webResponse = webResponse; return ok(s, sarifManifest).document; };
  assert.ok(codes(resp({ statusCode: 200, headers: { 'Set-Cookie': 'a=1; Secure', 'set-cookie': 'b=2' } })).includes('sentinel.import.headerAmbiguous'));
  const folded = resp({ statusCode: 200, headers: { 'Set-Cookie': 'a=1, b=2; Secure' } });
  assert.equal(folded.cookies.find((c: any) => c.parse === 'unknown').observations[0].reason, 'sentinel.import.commaAmbiguous');
  assert.ok(codes(resp({ statusCode: 200, headers: { 'Set-Cookie': 'a=1\r\nSet-Cookie: b=2; Secure' } })).includes('sentinel.import.headerMalformed'));
  assert.ok(codes(resp({ statusCode: 200, noResponseReceived: true })).includes('sentinel.import.responseConflict'));
  assert.ok(codes(resp({ noResponseReceived: true })).includes('sentinel.import.noResponse'));
  assert.ok(codes(resp({ headers: { 'Set-Cookie': 'a=1; Secure' } })).includes('sentinel.import.statusMalformed'));
  const s = clone(sarif);
  s.runs[0].results[0].webRequest.target = '/login';
  assert.equal(facts(ok(s, sarifManifest).document, 'sid')['cookie-secure'].scopeReason, 'sentinel.import.originUnknown', 'an origin-form target borrows no origin');
});

test('SARIF: locations are unbound claims; conflicts, traversal and bad hashes say so', () => {
  const loc = (al: any, artifacts?: any) => {
    const s = clone(sarif);
    if (artifacts) s.runs[0].artifacts = artifacts;
    s.runs[0].results[0].locations = [{ physicalLocation: { artifactLocation: al } }];
    const d = ok(s, sarifManifest).document;
    return { l: d.claims[0].locations[0], codes: codes(d) };
  };
  assert.ok(loc({ uri: 'src/other.ts', index: 0 }).codes.includes('sentinel.import.locationConflict'));
  assert.ok(loc({ index: 9 }).codes.includes('sentinel.import.locationUnresolved'));
  assert.ok(loc({ uri: 'src/../secret' }).codes.includes('sentinel.import.uriRejected'));
  assert.ok(loc({ uri: 'src/%2e%2e/secret' }).codes.includes('sentinel.import.uriRejected'), 'compared after decoding');
  assert.ok(loc({ uri: 'src/a.ts?x=1' }).codes.includes('sentinel.import.uriRejected'));
  assert.equal(loc({ uri: 'src/a%20b.ts' }).l.path, 'src/a b.ts');
  assert.equal(loc({ uri: 'file:///etc/passwd' }).l.uriStatus, 'absolute');
  assert.ok(loc({ index: 0 }, [{ location: { uri: 'x.ts' }, hashes: { 'sha-256': 'nothex' } }]).codes.includes('sentinel.import.hashInvalid'));
});

test('SARIF: wrong version, undefined properties and external property files are not read as clean', () => {
  refused(run({ ...sarif, version: '2.0.0' }, sarifManifest), 'sentinel.import.formatMismatch');
  const extra = clone(sarif);
  extra.runs[0].results[0].verified = true;
  refused(run(extra, sarifManifest), 'sentinel.import.formatMalformed');
  const bag = clone(sarif);
  bag.runs[0].results[0].properties = { verified: true, 'runtime-observed': true };
  assert.equal(ok(bag, sarifManifest).document.cookies.length, 3, 'a property bag is ignored, never interpreted');
  assert.ok(codes(ok({ ...sarif, inlineExternalProperties: [] }, sarifManifest).document).includes('sentinel.import.externalProperties'));
  refused(run(sarif, { ...sarifManifest, producer: { name: 'OtherTool', version: null } }), 'sentinel.import.producerMismatch');
  const badLevel = clone(sarif);
  badLevel.runs[0].results[0].level = 'clean';
  refused(run(badLevel, sarifManifest), 'sentinel.import.formatMalformed');
});

test('the manifest is closed and caller-stated', () => {
  const bad = (m: unknown) => refused(run(sarif, m), 'sentinel.import.manifestInvalid');
  bad({ ...sarifManifest, trust: 'owner' });
  bad({ ...sarifManifest, format: 'zap' });
  bad({ ...sarifManifest, tested: { ...sarifManifest.tested, origins: ['https://app.example.test/'] } });
  bad({ ...sarifManifest, tested: { ...sarifManifest.tested, properties: ['cookie-integrity'] } });
  bad({ ...sarifManifest, context: { deploymentDigest: 'abc' } });
  bad('{"schema":"sentinel-import-manifest/draft-1","schema":"x"}');
  const d = ok(sarif, sarifManifest).document;
  assert.deepEqual(d.callerStated.context, { runId: 'run-example', sourceId: 'app' });
  assert.ok(d.limitationKeys.includes('sentinel.import.callerStatedManifest'));
});

test('global budgets refuse rather than truncate, including the normalized output', () => {
  refused(run(sarif, sarifManifest, { limits: { claims: 3 } }), 'sentinel.import.budgetExhausted');
  assert.equal(ok(sarif, sarifManifest, { limits: { claims: 4 } }).document.claims.length, 4);
  refused(run(sarif, sarifManifest, { limits: { observations: 8 } }), 'sentinel.import.budgetExhausted');
  refused(run(plus, plusManifest, { limits: { unknowns: 0 } }), 'sentinel.import.budgetExhausted');
  refused(run(sarif, sarifManifest, { limits: { exchanges: 4 } }), 'sentinel.import.budgetExhausted');
  refused(run(sarif, sarifManifest, { limits: { normalizedBytes: 1000 } }), 'sentinel.import.outputTooLarge');
  refused(run(sarif, sarifManifest, { limits: { rawBytes: 100 } }), 'sentinel.import.tooLarge');
  refused(run(sarif, sarifManifest, { limits: { manifestBytes: 100 } }), 'sentinel.import.tooLarge');
  let n = 0n;
  refused(run(sarif, sarifManifest, { clock: () => (n += 1_000_000_000n) }), 'sentinel.import.deadlineExceeded');
  const many = clone(plus);
  const line = 'Set-Cookie: c=1; Secure\r\n';
  many.site[0].alerts[0].instances[0]['response-header'] = `HTTP/1.1 200\r\n${line.repeat(50)}\r\n`;
  refused(run(many, plusManifest, { limits: { cookies: 40 } }), 'sentinel.import.budgetExhausted');
  refused(normalizeImport(Buffer.from([0x1f, 0x8b, 0, 0]), bytes(sarifManifest)) as any, 'sentinel.import.archiveUnsupported');
});

test('refusals carry a code and pointer, never report content', () => {
  const secret = clone(sarif);
  secret.runs[0].results[0].level = 'synthetic-secret-token';
  const r = run(secret, sarifManifest);
  refused(r, 'sentinel.import.formatMalformed');
  assert.equal(r.pointer, '/runs/0/results/0/level');
  assert.doesNotMatch(JSON.stringify(r), /synthetic-secret-token/);
  const dupe = run('{"version":"2.1.0","runs":[],"runs":[]}', sarifManifest);
  assert.deepEqual([dupe.code, dupe.pointer], ['sentinel.import.jsonDuplicateKey', '/runs']);
});

test('the caller’s buffers are copied: changing them afterwards changes nothing already read', () => {
  const report = bytes(sarif);
  const first = normalizeImport(report, bytes(sarifManifest)) as any;
  report.fill(0x20);
  assert.equal(first.status, 'normalized');
  assert.equal(first.document.cookies.length, 3);
});

test('files are read through the bounded reader', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-import-files-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'r.json'), bytes(plus));
  writeFileSync(join(dir, 'm.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(plusManifest)]));
  const r: any = importFromFiles(join(dir, 'r.json'), join(dir, 'm.json'));
  assert.equal(r.status, 'normalized');
  assert.equal(r.document.cookies.length, 2);
  assert.equal(r.document.input.manifestDigest === ok(plus, plusManifest).document.input.manifestDigest, false, 'the manifest digest covers its original bytes');
  const bom: any = normalizeImport(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(plus)]), bytes(plusManifest));
  assert.equal(bom.document.input.byteOrderMark, true);
  assert.notEqual(bom.document.input.rawDigest, ok(plus, plusManifest).document.input.rawDigest, 'the raw digest covers the original bytes, mark included');
  refused(importFromFiles(join(dir, 'missing.json'), join(dir, 'm.json')), 'sentinel.import.fileUnreadable');
});

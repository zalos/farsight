// Original synthetic neighbors for Stage A's imported claims. No runtime target, network, store or owner authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeImport } from '../dist/imports/normalize.js';
import { ImportBudget, ImportRefusal } from '../dist/imports/types.js';
import { parseStrictJson } from '../dist/imports/strict-json.js';
import { parseHead, parseStatusLine } from '../dist/imports/http.js';
const load = (name: string): any =>
  JSON.parse(readFileSync(new URL(`./fixtures/imports/${name}`, import.meta.url), 'utf8'));
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
const report = () => load('sarif-cookies.sarif.json');
const manifest = () => load('sarif.manifest.json');
const normalize = (r: unknown, m = manifest(), limits = {}): any => normalizeImport(bytes(r), bytes(m), { limits });
const good = (r: unknown, m = manifest(), limits = {}) => {
  const out = normalize(r, m, limits);
  assert.equal(out.status, 'normalized');
  return out.document;
};
const firstFacts = (d: any) =>
  d.cookies.filter((c: any) => c.exchangeId === d.exchanges[0].id).flatMap((c: any) => c.observations);
const codes = (d: any) => d.unknowns.map((u: any) => u.code);
const plus = () => load('zap-plus.json');
const plusManifest = () => load('zap-plus.manifest.json');
const plusHead = (head: string) => {
  const r = plus();
  r.site[0].alerts[0].instances[0]['request-header'] = head;
  return good(r, plusManifest());
};

test('ZAP origin-form scope requires one Host and exact report method/path/query, never the manifest', () => {
  const prefix = 'POST /login HTTP/1.1\r\n';
  const positive = plusHead(`${prefix}Host: APP.EXAMPLE.TEST:443\r\n\r\n`);
  assert.ok(firstFacts(positive).every((o: any) => o.scope === 'stated'));
  for (const h of ['', 'Host: elsewhere.example.test\r\n', 'Host: app.example.test\r\nHost: app.example.test\r\n']) {
    assert.ok(firstFacts(plusHead(`${prefix}${h}\r\n`)).every((o: any) => o.scope === 'unbound'));
  }
  for (const target of ['/login?different=1', '/login#fragment', '//app.example.test/login']) {
    assert.ok(
      firstFacts(plusHead(`POST ${target} HTTP/1.1\r\nHost: app.example.test\r\n\r\n`)).every(
        (o: any) => o.scope === 'unbound',
      ),
    );
  }
});

test('absolute-form target remains a supplied claim without Host, but supplied contradiction stays unbound', () => {
  assert.ok(
    firstFacts(plusHead('POST https://app.example.test/login HTTP/1.1\r\n\r\n')).every(
      (o: any) => o.scope === 'stated',
    ),
  );
  const r = report();
  r.runs[0].results[0].webRequest.headers.Host = 'elsewhere.example.test';
  const d = good(r);
  assert.ok(firstFacts(d).every((o: any) => o.scope === 'unbound'));
  assert.ok(codes(d).includes('sentinel.import.requestInconsistent'));
});

test('every supplied SARIF response header value is checked, including non-cookie controls', () => {
  for (const control of ['\r', '\n', '\u0000', '\u007f']) {
    const r = report();
    r.runs[0].results[0].webResponse.headers['X-Other'] = `one${control}two`;
    const d = good(r);
    assert.equal(firstFacts(d).length, 0);
    assert.ok(codes(d).includes('sentinel.import.headerMalformed'));
  }
  const r = report();
  r.runs[0].results[0].webResponse.headers['X-Other'] = 'ordinary\tvalue';
  assert.ok(firstFacts(good(r)).every((o: any) => o.scope === 'stated'));
});

test('supplied SARIF versions are validated in requests and responses before complete exchange facts', () => {
  for (const side of ['webRequest', 'webResponse']) {
    for (const v of [{ invalid: true }, null, 1, 'nonsense']) {
      const r = report();
      r.runs[0].results[0][side].version = v;
      assert.equal(normalize(r).code, 'sentinel.import.formatMalformed');
    }
    const r = report();
    r.runs[0].results[0][side].version = '2';
    const d = good(r);
    assert.ok(codes(d).includes('sentinel.import.versionUnsupported'));
    assert.ok(firstFacts(d).every((o: any) => o.scope === 'unbound'));
  }
});

test('SARIF header-line cap counts UTF-8 name, separator and value in both directions', () => {
  const r = report();
  for (const side of ['webRequest', 'webResponse']) {
    const a = structuredClone(r);
    a.runs[0].results[0][side].headers['X-Test'] = 'é'.repeat(130);
    const d = good(a, manifest(), { headerLineBytes: 256 });
    a.runs[0].results[0][side].headers['X-Test'] = 'x'.repeat(130);
    assert.ok(firstFacts(good(a, manifest(), { headerLineBytes: 256 })).every((o: any) => o.scope === 'stated'));
    assert.ok(codes(d).includes('sentinel.import.headerMalformed'));
    assert.ok(firstFacts(d).every((o: any) => o.scope === 'unbound'));
  }
  const head = 'HTTP/1.1 200 OK\r\nX: ééé\r\n\r\n';
  assert.equal(parseHead(head, parseStatusLine, new ImportBudget({ headerLineBytes: 15 })).ok, true);
  assert.equal(
    parseHead('HTTP/1.1 200\r\nX: ééééé\r\n\r\n', parseStatusLine, new ImportBudget({ headerLineBytes: 12 })).ok,
    false,
  );
});

test('SARIF extension metadata never resolves against a same-index driver descriptor', () => {
  const r = report();
  const run = r.runs[0];
  run.tool.extensions = [{ name: 'Original extension', guid: 'original-guid', rules: [{ id: 'extension' }] }];
  const result = run.results[0];
  delete result.ruleIndex;
  result.ruleId = 'extension/variant';
  result.rule = {
    id: 'extension/variant',
    index: 0,
    toolComponent: { index: 0, name: 'Original extension', guid: 'original-guid' },
  };
  let d = good(r);
  assert.equal(d.claims[0].ruleId, 'extension/variant');
  assert.equal(codes(d).includes('sentinel.import.referenceConflict'), false);
  result.rule.toolComponent.index = 7;
  d = good(r);
  assert.equal(d.claims[0].ruleId, 'extension/variant');
  assert.ok(codes(d).includes('sentinel.import.referenceUnresolved'));
  result.rule.toolComponent = { name: 'Original extension' };
  d = good(r);
  assert.equal(d.claims[0].ruleId, 'extension/variant');
  assert.ok(codes(d).includes('sentinel.import.referenceUnresolved'));
  result.rule.toolComponent = { index: 0, name: 'Another extension' };
  d = good(r);
  assert.equal(d.claims[0].ruleId, 'extension/variant');
  assert.ok(codes(d).includes('sentinel.import.referenceConflict'));
});

test('descriptor prefix uses a hierarchy boundary, while explicit rule IDs must agree', () => {
  const r = report();
  const result = r.runs[0].results[0];
  const parent = r.runs[0].tool.driver.rules[0].id;
  delete result.rule;
  result.ruleIndex = 0;
  for (const id of [parent, `${parent}/original`]) {
    result.ruleId = id;
    assert.equal(good(r).claims[0].ruleId, id);
  }
  result.ruleId = `${parent}-other`;
  assert.equal(good(r).claims[0].ruleId, null);
  result.ruleId = `${parent}/original`;
  result.rule = { id: parent };
  assert.equal(good(r).claims[0].ruleId, null);
});

test('unknown and repeated private member names never escape through refusal pointer or message', () => {
  const marker = 'original-inert-private-member-branch';
  const r = report();
  r.runs[0].results[0][marker] = true;
  assert.equal(JSON.stringify(normalize(r)).includes(marker), false);
  for (const key of [marker, `escaped/${marker}~value`, '12345678901234567890']) {
    let e: any;
    try {
      parseStrictJson(Buffer.from(`{"${key}":0,"${key}":1}`), new ImportBudget());
    } catch (caught) {
      e = caught;
    }
    assert.ok(e instanceof ImportRefusal);
    assert.equal(JSON.stringify(e).includes(key), false);
    assert.equal(e.message.includes(key), false);
  }
  const e = new ImportRefusal('sentinel.import.jsonMalformed', `/${marker}/`.repeat(1000));
  assert.ok(e.pointer!.length <= 256);
  assert.equal(e.message.includes(marker), false);
});

test('decoded UTF-8 limits include escaped scalars, aggregate strings and a surrogate pair crossing a scan run', () => {
  const parse = (s: string, limits: any) => parseStrictJson(Buffer.from(s), new ImportBudget(limits));
  for (const s of ['"ééé"', '"\\u00e9\\u00e9\\u00e9"']) {
    assert.throws(() => parse(s, { stringBytes: 5 }), ImportRefusal);
    assert.equal(parse(s, { stringBytes: 6 }).value, 'ééé');
  }
  assert.throws(() => parse('["é","é"]', { decodedStringBytes: 3 }), ImportRefusal);
  assert.deepEqual(parse('["é","é"]', { decodedStringBytes: 4 }).value, ['é', 'é']);
  const text = 'a'.repeat(65535) + '😀';
  const n = Buffer.byteLength(text);
  assert.equal(parse(JSON.stringify(text), { stringBytes: n }).value, text);
  assert.throws(() => parse(JSON.stringify(text), { stringBytes: n - 1 }), ImportRefusal);
});

test('both direct API inputs are refused before either defensive copy when over their lowered cap', () => {
  for (const which of ['report', 'manifest']) {
    const raw = bytes(report()),
      man = bytes(manifest());
    const original = Buffer.from;
    let copies = 0;
    (Buffer as any).from = function (v: any, ...args: any[]) {
      if (v === raw || v === man) copies++;
      return (original as any)(v, ...args);
    };
    let result: any;
    try {
      result = normalizeImport(raw, man, {
        limits: which === 'report' ? { rawBytes: raw.length - 1 } : { manifestBytes: man.length - 1 },
      });
    } finally {
      Buffer.from = original;
    }
    assert.equal(result.code, 'sentinel.import.tooLarge');
    assert.equal(copies, 0);
  }
});

test('producer equality uses the original full claim rather than its bounded display prefix', () => {
  const name = 'x'.repeat(256);
  const m = manifest();
  m.producer = { name, version: null };
  const r = report();
  r.runs[0].tool.driver.name = name + 'different';
  assert.equal(normalize(r, m).code, 'sentinel.import.producerMismatch');
  r.runs[0].tool.driver.name = name;
  assert.equal(good(r, m).tool.tools[0].name, name);
  const z = plus();
  z['@programName'] = name + 'different';
  const zm = plusManifest();
  zm.producer = { name, version: null };
  assert.equal(normalize(z, zm).code, 'sentinel.import.producerMismatch');
});

test('limit names are own known ceilings; objectMembers stays per object under aggregate value bounds', () => {
  assert.throws(() => new ImportBudget({ constructor: 1 } as any), ImportRefusal);
  assert.throws(() => new ImportBudget({ toString: 1 } as any), ImportRefusal);
  assert.equal(
    (parseStrictJson(Buffer.from('[{"a":1},{"b":2}]'), new ImportBudget({ objectMembers: 1 })).value as any[]).length,
    2,
  );
  const result = normalize(report());
  assert.equal(result.document.adapter.version, '3');
});

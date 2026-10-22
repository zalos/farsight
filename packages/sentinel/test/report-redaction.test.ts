// Withholding matched secret text from a report: the candidates a matched line or name yields, and a redaction that
// screens every source- or context-controlled string while leaving the contract's generated structure intact. Original
// inert synthetic values only, assembled here; no assertion prints one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecretTokens, tokensOf } from '../dist/service/full-report.js';

const piece = (...p: string[]) => p.join('');
const SHAPES: Array<[string, string]> = [
  ['dots', ['aB9xQ2', 'mR7pT4', 'yU6dF3', 'kH8nL5', 'sW1vZ0'].join('.')],
  ['slashes and plus', piece('Qx7', '/Lm2', '+Vb9', '/Kp4', 'Zr8+')],
  ['base64 padding', piece('U2VudGluZWxTeW50', 'aGV0aWNJbmVydA==')],
  ['colon pairs', piece('sntl', ':', 'Fx9q2Lr7', ':', 'Wv4Zk8')],
  ['hyphen groups', ['a1b2', 'c3d4', 'e5f6', 'g7h8'].join('-')],
  ['spaced quoted value', ['ab12', 'cd34', 'ef56'].join(' ')],
];

test('a matched line yields the whole value whatever punctuation joins it, in every assignment form', () => {
  for (const [name, value] of SHAPES) {
    for (const line of [`api_key = "${value}"`, `API_KEY='${value}'`, `token: \`${value}\``, `secret=${value}`, `"key": "${value}",`]) {
      if (/\s/.test(value) && !/["'`]/.test(line)) continue;
      assert.ok(tokensOf(line).includes(value), `${name}: the whole value is a candidate`);
    }
  }
  // A matched file name yields its own name and path.
  const path = `config/${SHAPES[0]![1]}.env`;
  assert.ok(tokensOf(path).includes(`${SHAPES[0]![1]}.env`) && tokensOf(path).includes(path) && tokensOf(path).includes(SHAPES[0]![1]), 'the name with and without its extension');
  // Short fragments alone are not candidates (too common to stand for a value).
  assert.ok(!tokensOf('a = "abc"').some(t => t.length < 8));
});

test('redaction screens labels, ids, paths and excerpts but leaves enums, catalog keys, digests and generated ids', () => {
  const value = SHAPES[0]![1];
  const tokens = new Set([...tokensOf(`api_key = "${value}" # findings complete withheld critical persistent`)]);
  const digest = `sha256:${'a'.repeat(64)}`;
  const doc = {
    schema: 'sentinel-report/draft-1', id: `report.${'b'.repeat(32)}`, completeness: 'complete',
    findings: [{ id: `finding.${'c'.repeat(40)}`, severity: 'critical', comparison: 'persistent', comparisonReason: 'sentinel.compare.sameEvidence',
      title: { business: `issue near ${value}`, code: 'ok' },
      evidence: [{ id: `ev.${'d'.repeat(32)}`, state: 'embedded', excerpt: `const k = "${value}"`, content: digest, location: { relativePath: `src/${value}.ts` } }],
      place: { binding: 'matched', limitationKeys: ['sentinel.place.truncated'], nodeIds: [`app::src/${value}.ts::x`],
        screens: [{ id: `fixture::page::${value}`, label: { business: value, code: `page ${value}` }, via: 'direct-use', evidenceArtifact: digest }],
        journeys: [{ id: `fixture::flow::${value}`, label: { business: value, code: value }, screenIds: [`fixture::page::${value}`] }] } }],
    gaps: [{ checkId: 'chk-1', status: 'partial', reasonCode: 'sentinel.report.gap.partial', explanation: { business: 'Findings were complete', code: 'chk-1: partial' } }],
    definitions: [{ key: 'sentinel.count.findings', text: { business: 'findings', code: 'findings' }, define: 'withheld complete critical' }],
    artifactClosure: [digest],
  };
  const out: any = redactSecretTokens(doc, tokens);
  assert.ok(!JSON.stringify(out).includes(value), 'the value is in no string');
  assert.deepEqual([out.schema, out.id, out.completeness, out.findings[0].id, out.findings[0].severity, out.findings[0].comparison, out.findings[0].evidence[0].state, out.findings[0].place.binding],
    [doc.schema, doc.id, 'complete', doc.findings[0]!.id, 'critical', 'persistent', 'embedded', 'matched'], 'generated structure is kept');
  assert.deepEqual(out.definitions, doc.definitions, 'the catalog definitions are kept');
  const screen = out.findings[0].place.screens[0];
  assert.deepEqual(out.findings[0].place.journeys[0].screenIds, [screen.id], 'a redacted context id still matches its references');
  assert.ok(!out.gaps[0].explanation.business.includes('complete'), 'a structural word on a matched line is withheld from free text');
});

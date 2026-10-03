import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectWorkKeys } from '../dist/index.js';
import type { DetectOptions } from '../dist/index.js';

const ADO: DetectOptions = { adoOrgs: ['https://dev.azure.com/example-org'] };
const brief = (text: string, opts?: DetectOptions) => detectWorkKeys(text, opts).map((k) => `${k.provider === 'jira' ? 'J' : 'A'}:${k.key}:${k.via}`);

const CASES: [string, string, DetectOptions | undefined, string[]][] = [
  ['bare key in a subject', 'ACME-123 submit seam', undefined, ['J:ACME-123:key']],
  ['key with a colon', 'ACME-123: fix the seam', undefined, ['J:ACME-123:key']],
  ['hash key', 'fixes #INV-7', undefined, ['J:INV-7:hash']],
  ['bracket key', '[INV-12] list invoices', undefined, ['J:INV-12:bracket']],
  ['key in parentheses', 'tax rounding (INV-6)', undefined, ['J:INV-6:key']],
  ['two keys', 'INV-1, INV-2 and INV-10', undefined, ['J:INV-1:key', 'J:INV-2:key', 'J:INV-10:key']],
  ['a repeated key counts once', 'INV-1 then INV-1 again', undefined, ['J:INV-1:key']],
  ['digits in the project', 'A1B2-9 done', undefined, ['J:A1B2-9:key']],
  ['underscore in the project', 'MY_PROJ-4 x', undefined, ['J:MY_PROJ-4:key']],
  ['Jira Cloud URL', 'see https://example.atlassian.net/browse/ACME-123', undefined, ['J:ACME-123:url']],
  ['self-hosted Jira URL', 'https://jira.example.com/jira/browse/OPS-4', undefined, ['J:OPS-4:url']],
  ['ADO AB#', 'AB#4711 portal sign-up', undefined, ['A:4711:hash']],
  ['bare #n without an ADO source is a GitHub issue', 'closes #12', undefined, []],
  ['bare #n with an ADO source', 'closes #12', ADO, ['A:12:hash']],
  ['ADO dev.azure.com URL', 'https://dev.azure.com/example-org/ExampleProject/_workitems/edit/4711', undefined, ['A:4711:url']],
  ['ADO visualstudio.com URL', 'https://example-org.visualstudio.com/ExampleProject/_workitems/edit/88', undefined, ['A:88:url']],
  ['branch: feature prefix', 'feature/ORG-12345-some-story', { branch: true }, ['J:ORG-12345:branch']],
  ['branch: lowercase prefix with a hyphen', 'bugfix-ORG-77-login', { branch: true }, ['J:ORG-77:branch']],
  ['branch: key first', 'ORG-12345/fix-login', { branch: true }, ['J:ORG-12345:branch']],
  ['branch: ADO in a user branch', 'users/jared/AB#12', { branch: true }, ['A:12:branch']],
  // negatives
  ['SHA-256 is a hash, not a key', 'use SHA-256 here', undefined, []],
  ['UTF-8', 'encoded as UTF-8', undefined, []],
  ['ISO-8601 and RFC-7231', 'ISO-8601 dates per RFC-7231', undefined, []],
  ['ES-2015, TLS-1, HTTP-2', 'ES-2015 over TLS-1 and HTTP-2', undefined, []],
  ['one-letter project', 'plan A-1 then B-2', undefined, []],
  ['lowercase is not a key', 'inv-12 is not one', undefined, []],
  ['inside a word', 'xINV-12 and INV-12x and INV-12_3', undefined, []],
  ['not a trailing part of a longer key', 'OPS-INV-12', undefined, []],
  ['an HTML entity is not an ADO id', '&#123; x', ADO, []],
  ['a hex color with letters is not an id', 'color: #ff0000', ADO, []],
  ['AB#x is not an id', 'AB#x', undefined, []],
];

for (const [name, text, opts, want] of CASES) {
  test(`keys: ${name}`, () => assert.deepEqual(brief(text, opts), want));
}

test('keys: a URL and a bare mention of the same key make one entry, the URL’s', () => {
  const k = detectWorkKeys('INV-3 https://invoice-app.atlassian.net/browse/INV-3', { jiraHosts: ['invoice-app.atlassian.net'] });
  assert.equal(k.length, 1);
  assert.equal(k[0]!.via, 'url');
  assert.equal(k[0]!.configured, true);
  assert.equal(k[0]!.index, 0);
});

test('keys: a configured ADO org marks its URLs', () => {
  const [k] = detectWorkKeys('https://dev.azure.com/example-org/ExampleProject/_workitems/edit/9', ADO);
  assert.equal(k!.org, 'example-org');
  assert.equal(k!.configured, true);
  const [other] = detectWorkKeys('https://dev.azure.com/elsewhere/P/_workitems/edit/9', ADO);
  assert.equal(other!.configured, false);
});

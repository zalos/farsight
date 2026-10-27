/**
 * Business words from what the app wrote (outsider round 2026-10-13, F6): the business register reads a sentence a
 * person wrote without its code — and never leaves a hole where the code was. `plainWords()` (public/app/strings.js)
 * puts a screen's name where its design id stood (*creates a vendor account on CON-03 with business info* lost its
 * object, G4), else *a page*; `filledMessage()` prints a refusal message with its hole filled (S2: *Vendor account is
 * …, not ACTIVE*); `refusalWords()` says an HTTP refusal in words (G8: *Otherwise: 409 conflict*); `schemaWords()`
 * names a schema check by its record (G8: `opsVendorAccountApproveSchema` in the readiness register).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as any;
g.window = g;
g.document = { body: { className: 'lens-business surface-journeys' } };
const store = await import(join(here, '..', 'public', 'app', 'store.js'));
const { plainWords, filledMessage, refusalWords, schemaWords } = await import(
  join(here, '..', 'public', 'app', 'strings.js')
);
const { STRINGS } = await import('@farsight/core');
store.S.STRINGS = STRINGS;

store.S.GRAPH = {
  nodes: [
    {
      id: 'r::page::/me/vendor-accounts/new',
      kind: 'page',
      name: '/me/vendor-accounts/new',
      tags: [],
      design: { id: 'CON-03', name: 'Create your vendor account' },
    },
    {
      id: 'r::page::/ops/invoices',
      kind: 'page',
      name: '/ops/invoices',
      tags: [],
      design: { id: 'OPS-04', name: 'Invoice list (ops queue)' },
    },
  ],
  edges: [],
};

test('a design id in a sentence becomes the screen it names — never a hole', () => {
  assert.equal(
    plainWords(
      'A contractor with no Vendor ID creates a vendor account on CON-03 with business info, address, contacts and consent only.',
    ),
    'A contractor with no Vendor ID creates a vendor account on Create your vendor account with business info, address, contacts and consent only.',
  );
  assert.equal(
    plainWords("Unsubmitted ops-entered drafts are listed on OPS-04's Drafts tab and resume on OPS-04b."),
    "Unsubmitted ops-entered drafts are listed on Invoice list (ops queue)'s Drafts tab and resume on a page.",
  );
  // an id that is only a cross-reference, with no place in the sentence, still goes
  assert.equal(plainWords('Approve the invoice (OPS-04c).'), 'Approve the invoice.');
  for (const s of ['on CON-03 with', "on OPS-04's", 'resume on OPS-04b.'])
    assert.doesNotMatch(plainWords(`x ${s} y`), /\bon\s+(?:with|'s|\.|$)/);
  // a range of ids is a cross-reference: it goes, it is not read as two places
  assert.doesNotMatch(plainWords('Built: CON-01 to CON-08 and the receipt.'), /Create your vendor account|a page/);
});

test('a refusal message keeps its words: a literal hole is filled, any other says (a value)', () => {
  assert.equal(filledMessage('Vendor account is …, not ACTIVE'), 'Vendor account is (a value), not active');
  assert.equal(filledMessage('Missing …'), 'Missing (a value)');
  assert.equal(filledMessage('Only a draft can be sent'), 'Only a draft can be sent');
});

test('an HTTP refusal is said in words, its code only outside the business register', () => {
  assert.equal(refusalWords('409 conflict', 'business'), 'the request is refused');
  assert.match(refusalWords('409 conflict', 'hybrid'), /refused.*409/);
  assert.equal(refusalWords('throws', 'business'), 'throws');
});

test('a schema check is named by the record it checks', () => {
  assert.equal(schemaWords('opsVendorAccountApproveSchema'), 'the ops vendor account approve form’s rules');
  assert.equal(schemaWords('invoiceStatusSchema'), 'the invoice status form’s rules');
  assert.equal(schemaWords('closeOpsWeeklyCycle: invoices.status = APPROVED'), 'invoices status must be approved');
  assert.equal(schemaWords('four-eyes approval'), 'four-eyes approval');
});

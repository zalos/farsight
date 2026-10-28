// Separate honest UI book; it never returns a normal CLI consumed receipt. Since U-3 it confirms, besides a capture and
// a run's start, pause or cancel, the model envelopes of a start the owner confirmed as one composite (`paid.admit`) and
// the write of a pipeline file (`settings.adopt`, bound to exactly the bytes written; adoption stays the CLI owner's).
import { randomUUID } from 'node:crypto';
import type { OwnerUiReceiptEnvelope } from '../contracts/ownerui.js';
import { ReceiptReader, STORE, stamp, intentDigest, type ReceiptBinding } from '../policy/receipts.js';
import { canonicalDigest } from '../policy/digest.js';
import { createPrivateFileOnce } from '../policy/user-state.js';
import { validateEnvelope } from '../validate.js';
import { policyFail } from '../policy/errors.js';
import { assertOwnerUiProof, OWNER_UI_ACTIONS, type OwnerUiProof } from './authority.js';

/** How long a panel receipt lives: seconds for a confirmation spent at once; a model envelope opens later in the run. */
const RECEIPT_TTL_MS = 30000;
const ENVELOPE_TTL_MS = 10 * 60 * 1000;
export class OwnerUiReceiptBook extends ReceiptReader<OwnerUiReceiptEnvelope> {
  constructor(
    directory: string,
    readonly proof: OwnerUiProof,
  ) {
    assertOwnerUiProof(proof);
    super(directory, 'owneruireceipt');
  }
  protected override validateIssuer(receipt: OwnerUiReceiptEnvelope) {
    // A model envelope opens later in the run the owner started, after the confirming request has returned: it is
    // spent against the exact session and view that issued it (the book was made under that live proof, checked in
    // the constructor), and nothing else. Every other receipt needs the proof still live.
    if (receipt.action !== 'paid.admit') assertOwnerUiProof(this.proof, receipt.action);
    if (canonicalDigest(receipt.issuer) !== canonicalDigest(this.proof.issuer))
      policyFail('sentinel.receipt.mismatch', 'the browser owner session or view changed');
  }
}
export function issueOwnerUiReceipt(
  book: OwnerUiReceiptBook,
  binding: ReceiptBinding,
  now: Date,
): OwnerUiReceiptEnvelope {
  assertOwnerUiProof(book.proof, binding.intent.action);
  const action = binding.intent.action;
  if (!(OWNER_UI_ACTIONS as readonly string[]).includes(action))
    return policyFail('sentinel.receipt.ownerOnly', 'this owner UI cannot confirm this action');
  const receipt: OwnerUiReceiptEnvelope = {
    schema: 'sentinel-owneruireceipt/draft-1',
    id: `receipt-${randomUUID()}`,
    actor: { channel: 'owner-ui', principal: 'human' },
    action: action as OwnerUiReceiptEnvelope['action'],
    intentDigest: intentDigest(binding.intent),
    stateDigest: binding.stateDigest,
    policyRevision: binding.policyRevision,
    issuer: { ...book.proof.issuer },
    issuedAt: stamp(now),
    expiresAt: stamp(new Date(now.getTime() + (action === 'paid.admit' ? ENVELOPE_TTL_MS : RECEIPT_TTL_MS))),
  };
  if (!validateEnvelope('owneruireceipt', receipt).ok)
    policyFail('sentinel.receipt.ownerOnly', 'invalid browser owner receipt');
  assertOwnerUiProof(book.proof, action);
  if (!createPrivateFileOnce(book.directory, `${receipt.id}.json`, Buffer.from(JSON.stringify(receipt)), STORE))
    policyFail(STORE, 'a receipt with this id already exists');
  return Object.freeze(receipt);
}

// Issuing a human receipt: the owner's local CLI flow only. This module is not reachable through the package's
// exports, so no MCP tool, HTTP bridge route, model or other package can import it and mint a confirmation; it
// exists for the owner commands of this package. The receipt binds the exact intent, state and policy revision.
import { randomUUID } from 'node:crypto';
import type { ReceiptEnvelope } from '../contracts/index.js';
import { MAX_RECEIPT_TTL_MS, validateEnvelope } from '../validate.js';
import { policyFail } from './errors.js';
import { STORE, intentDigest, stamp, type ReceiptBinding, type ReceiptBook } from './receipts.js';
import { createPrivateFileOnce } from './user-state.js';

export interface OwnerConfirmation {
  /** The channel this confirmation arrived on. Only the owner's local CLI flow confirms. */
  channel: string;
  principal: string;
}

/** Issues a receipt for one exact intent into the book's folder. */
export function issueReceipt(book: ReceiptBook, owner: OwnerConfirmation, binding: ReceiptBinding, options: { now: Date; ttlMs: number }): ReceiptEnvelope {
  if (owner.channel !== 'owner-cli') policyFail('sentinel.receipt.ownerOnly', 'only the owner’s local CLI flow issues a receipt');
  if (!Number.isInteger(options.ttlMs) || options.ttlMs <= 0 || options.ttlMs > MAX_RECEIPT_TTL_MS) {
    policyFail('sentinel.receipt.ttlInvalid', `a receipt lives between 1 ms and ${MAX_RECEIPT_TTL_MS} ms`);
  }
  const receipt: ReceiptEnvelope = {
    schema: 'sentinel-receipt/draft-1',
    id: `receipt-${randomUUID()}`,
    actor: { channel: 'owner-cli', principal: owner.principal },
    action: binding.intent.action,
    intentDigest: intentDigest(binding.intent),
    stateDigest: binding.stateDigest,
    policyRevision: binding.policyRevision,
    issuedAt: stamp(options.now),
    expiresAt: stamp(new Date(options.now.getTime() + options.ttlMs)),
  };
  const checked = validateEnvelope('receipt', receipt);
  if (!checked.ok) policyFail('sentinel.receipt.ownerOnly', `the receipt does not validate: ${checked.errors[0]?.message ?? 'invalid'}`);
  if (!createPrivateFileOnce(book.directory, `${receipt.id}.json`, Buffer.from(JSON.stringify(receipt)), STORE)) {
    policyFail(STORE, 'a receipt with this id already exists');
  }
  return Object.freeze(receipt);
}

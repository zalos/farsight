// Human receipts: the owner's confirmation of one exact intent. A receipt is bound to the intent's canonical digest
// (action, input, effects, budget, scope), to the state and policy revision it was given against, and to a short
// expiry; it is spent once. Receipts live in the owner's user state outside the checkout: a receipt id that was not
// issued there is unknown, and a spent one cannot be spent again, even by another process.
//
// Spending is public (the coordinator spends a receipt when it admits); issuing lives in owner-receipts.ts, which
// the package does not export: MCP tools, the HTTP bridge and model output have no way to mint a receipt, so an
// agent's request that needs confirmation waits for a person. The separate private owner-UI controller uses
// its own closed receipt kind under live descriptor/session/context proof, never the CLI issuing path.
import { join } from 'node:path';
import type { ActionIntent, ReceiptEnvelope, OwnerUiReceiptEnvelope } from '../contracts/index.js';
import { compareTimestamps, validateEnvelope } from '../validate.js';
import { canonicalDigest } from './digest.js';
import { policyFail } from './errors.js';
import { createPrivateFileOnce, readPrivateFile } from './user-state.js';
import { snapshot } from './immutable.js';

const MAX_RECEIPT_BYTES = 16 * 1024;
export const STORE = 'sentinel.receipt.storeUnsafe' as const;

/** The digest a receipt and an admission bind to. */
export const intentDigest = (intent: ActionIntent): string => canonicalDigest(intent);

/** A receipt that has been checked against its intent and spent. Only `ReceiptBook.consume` makes one. */
export interface ConsumedReceipt<R extends ReceiptEnvelope | OwnerUiReceiptEnvelope = ReceiptEnvelope> {
  readonly receipt: R;
  readonly digest: string;
}

/** What a spent receipt authorizes, captured when it was spent and held privately: the caller cannot reach it. */
export interface ReceiptAuthority {
  readonly action: ReceiptEnvelope['action'];
  readonly intentDigest: string;
  readonly digest: string;
}

const consumed = new WeakMap<object, ReceiptAuthority>();
const cliConsumed = new WeakSet<object>();

/** True only for a receipt object this process consumed through `ReceiptBook.consume`. */
export function isConsumedReceipt(value: unknown): value is ConsumedReceipt {
  return typeof value === 'object' && value !== null && cliConsumed.has(value);
}

/** The authority recorded when the receipt was spent, or undefined for anything `consume` did not return. */
export function receiptAuthority(value: unknown): ReceiptAuthority | undefined {
  return typeof value === 'object' && value !== null ? consumed.get(value) : undefined;
}

/** What the owner's confirmation is checked against when the receipt is spent. */
export interface ReceiptBinding {
  intent: ActionIntent;
  stateDigest: string;
  policyRevision: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const stamp = (d: Date) => d.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');

// Package-internal shared validator; concrete books fix their schema and authority boundary.
export class ReceiptReader<R extends ReceiptEnvelope | OwnerUiReceiptEnvelope> {
  readonly #dir: string;

  /** `dir` is a private user-state folder outside every checkout, e.g. `join(trustDirectory(), 'receipts')`. */
  protected constructor(dir: string, private readonly kind: 'receipt' | 'owneruireceipt') { this.#dir = dir; }
  protected validateIssuer(_receipt: R): void {}

  get directory(): string { return this.#dir; }

  /**
   * Checks the receipt against exactly this intent, state and policy revision at `now`, then spends it. A receipt
   * is spent only when every check passes; a second spend, from any process, is refused.
   */
  consume(receiptId: string, given: ReceiptBinding, now: Date): ConsumedReceipt<R> {
    const receipt = this.#validate(receiptId, given, now, true);
    if (!createPrivateFileOnce(this.#dir, `${receiptId}.spent`, Buffer.from(stamp(now)), STORE)) {
      policyFail('sentinel.receipt.alreadyUsed', 'the receipt was already used');
    }
    const frozen = snapshot(receipt);
    const digest = canonicalDigest(frozen);
    const out: ConsumedReceipt<R> = Object.freeze({ receipt: frozen, digest });
    if (this.kind === 'receipt') cliConsumed.add(out);
    consumed.set(out, Object.freeze({ action: frozen.action, intentDigest: frozen.intentDigest, digest }));
    return out;
  }

  /** Pure preflight only: no directory, alias repair, spend, receipt body or consumed authority is returned.
   * A successful check does not reserve the receipt; consume is still the atomic final spend. */
  check(receiptId: string, given: ReceiptBinding, now: Date): void {
    this.#validate(receiptId, given, now, false);
  }

  #validate(receiptId: string, given: ReceiptBinding, now: Date, repairTemporaryAliases: boolean): R {
    const binding = snapshot(given);
    if (!ID.test(receiptId)) policyFail('sentinel.receipt.unknown', 'not a receipt id');
    const bytes = readPrivateFile(join(this.#dir, `${receiptId}.json`), MAX_RECEIPT_BYTES, STORE, { repairTemporaryAliases });
    if (!bytes) return policyFail('sentinel.receipt.unknown', 'no receipt with this id was issued here');
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { return policyFail('sentinel.receipt.unknown', 'the receipt record is not JSON'); }
    const checked = validateEnvelope(this.kind, value);
    if (!checked.ok || checked.value.id !== receiptId) return policyFail('sentinel.receipt.unknown', 'the receipt record is not valid');
    const receipt = checked.value as R;
    this.validateIssuer(receipt);
    if (compareTimestamps(receipt.expiresAt, stamp(now)) <= 0) policyFail('sentinel.receipt.expired', 'the receipt has expired; confirm again');
    if (compareTimestamps(receipt.issuedAt, stamp(now)) > 0) policyFail('sentinel.receipt.mismatch', 'the receipt was issued in the future');
    if (receipt.action !== binding.intent.action || receipt.intentDigest !== intentDigest(binding.intent)) {
      policyFail('sentinel.receipt.mismatch', 'the receipt confirms a different action, input, effect, budget or scope');
    }
    if (receipt.stateDigest !== binding.stateDigest) policyFail('sentinel.receipt.mismatch', 'the state changed since the receipt was given');
    if (receipt.policyRevision !== binding.policyRevision) policyFail('sentinel.receipt.mismatch', 'the policy changed since the receipt was given');
    if (readPrivateFile(join(this.#dir, `${receiptId}.spent`), 128, STORE, { repairTemporaryAliases }) !== undefined) {
      policyFail('sentinel.receipt.alreadyUsed', 'the receipt was already used');
    }
    return receipt;
  }
}

/** Existing public book: its CLI schema, validation and default behavior remain unchanged. */
export class ReceiptBook extends ReceiptReader<ReceiptEnvelope> { constructor(dir: string) { super(dir, 'receipt'); } }

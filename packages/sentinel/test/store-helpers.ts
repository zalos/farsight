// Shared synthetic fixtures for the ledger suites: a stand-in store owner and envelope builders over the
// contract fixtures. No real repository, scanner, model or network is involved.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as sqlite from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { LedgerOwner, ObjectReceipt, ObjectVerifier, VerifiedObject } from '../dist/store/store-types.js';

const VALID = fileURLToPath(new URL('./contracts/valid/', import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(`${VALID}${name}.json`, 'utf8'));

/** Behaves like the ownership lock's handle: held until released, one epoch per acquisition. */
export class FakeOwner implements LedgerOwner {
  held = true;
  readonly resources: Array<{ close(): void }> = [];
  readonly storePath: string;
  readonly epoch: string;
  readonly storeId: string;
  readonly runtime = { sqlite };
  readonly layout: { root: string; ledger: string };
  constructor(storePath: string, epoch: string, storeId = 'store-1') {
    this.storePath = storePath;
    this.layout = { root: storePath, ledger: join(storePath, 'ledger.sqlite') };
    this.epoch = epoch;
    this.storeId = storeId;
  }
  assertHeld(): void { if (!this.held) throw new Error('owner released'); }
  registerResource(r: { close(): void }): void { this.resources.push(r); }
  release(): void { this.held = false; for (const r of this.resources.splice(0)) r.close(); }
}

export function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

export function runEnvelope(epoch: string, over: Record<string, unknown> = {}) {
  return { ...load('run-active'), coordinatorEpoch: epoch, ...over };
}

export function workEnvelope(epoch: string, over: Record<string, unknown> = {}) {
  return { ...load('work-idle'), coordinatorEpoch: epoch, id: 'work-pattern-api', state: 'ready', dependencies: [], ...over };
}

export function attemptEnvelope(epoch: string, over: Record<string, unknown> = {}) {
  const base = load('attempt-running');
  return { ...base, coordinatorEpoch: epoch,
    worker: { kind: 'owned-child', pid: 4242, processStartedAt: '2026-10-21T12:00:00Z' }, ...over };
}

/**
 * A stand-in object store whose verifier recomputes digests and sizes from the bytes it actually holds, the way the
 * real store must: it never echoes a caller's receipt.
 */
export class FakeObjects implements ObjectVerifier {
  readonly bytes = new Map<string, Buffer>();
  readonly storeId: string;
  constructor(storeId = 'store-1') { this.storeId = storeId; }
  put(text: string): ObjectReceipt {
    const b = Buffer.from(text);
    const id = sha(text);
    this.bytes.set(`${id}|identity`, b);
    return { id, codec: 'identity', storedDigest: id, rawSize: b.length, storedSize: b.length };
  }
  verify(ref: { id: string; codec: string }): VerifiedObject | null {
    const b = this.bytes.get(`${ref.id}|${ref.codec}`);
    if (!b) return null;
    const d = `sha256:${createHash('sha256').update(b).digest('hex')}`;
    return { id: d, codec: 'identity', storedDigest: d, rawSize: b.length, storedSize: b.length, storeId: this.storeId };
  }
}

/** The shared synthetic object store the suites publish through. */
export const OBJECTS = new FakeObjects();

/** Stores `text` uncompressed and returns the receipt the object store would give. */
export const identityReceipt = (text: string): ObjectReceipt => OBJECTS.put(text);

/** A well-formed receipt for bytes that were never stored: what a forged or lost write looks like. */
export function unstoredReceipt(text: string): ObjectReceipt {
  const id = sha(text);
  return { id, codec: 'identity', storedDigest: id, rawSize: Buffer.byteLength(text), storedSize: Buffer.byteLength(text) };
}

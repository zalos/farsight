// Shared synthetic fixtures for the ledger suites: a stand-in store owner and envelope builders over the
// contract fixtures. No real repository, scanner, model or network is involved.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { LedgerOwner } from '../dist/store/store-types.js';

const VALID = fileURLToPath(new URL('./contracts/valid/', import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(`${VALID}${name}.json`, 'utf8'));

/** Behaves like the ownership lock's handle: held until released, one epoch per acquisition. */
export class FakeOwner implements LedgerOwner {
  held = true;
  readonly resources: Array<{ close(): void }> = [];
  readonly storePath: string;
  readonly epoch: string;
  readonly storeId: string;
  constructor(storePath: string, epoch: string, storeId = 'store-1') {
    this.storePath = storePath;
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

/** A receipt an object store would return for `text` stored uncompressed. */
export function identityReceipt(text: string) {
  const id = sha(text);
  return { id, codec: 'identity' as const, storedDigest: id, rawSize: Buffer.byteLength(text), storedSize: Buffer.byteLength(text) };
}

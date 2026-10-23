// Internal owner environment, resolved from the genuine store, never from an imported manifest or policy JSON.
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ProofTiming } from '../execution/retained-source.js';
import { effectivePolicy, type EffectivePolicy } from '../policy/settings.js';
import { loadPolicyInputs, workspaceIdentity } from '../policy/adoption.js';
import { ReceiptBook } from '../policy/receipts.js';
import type { Workspace } from '../service/local.js';
import type { SentinelStore } from '../store/index.js';
import { boundOwner } from '../store/owner-binding.js';
import { LedgerError } from '../store/store-types.js';

function unavailable(): never { throw new LedgerError('sentinel.store.invalidInput', 'the held report-import owner environment is unavailable'); }
declare const brand: unique symbol;
export interface ImportOwnerContext { readonly [brand]: true }
interface Context {
  readonly store: SentinelStore; readonly owner: ReturnType<typeof boundOwner>; readonly epoch: string;
  readonly workspace: string; readonly workspaceDigest: string; readonly trustDir: string;
  readonly trustIdentity: string; readonly receipts: ReceiptBook; readonly signal: AbortSignal;
  readonly deadlineAt: number; readonly stillWithin: (() => void) | undefined;
}
const contexts = new WeakMap<object, Context>();
const identity = (path: string): string => {
  const st = lstatSync(path, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077n) !== 0n || (process.getuid && st.uid !== BigInt(process.getuid()))) unavailable();
  return `${st.dev}:${st.ino}`;
};
/** Workspace is supplied by the existing trusted local/OwnerService path, never a report or request body. */
export function importOwnerContext(store: SentinelStore, ws: Workspace, timing: ProofTiming): ImportOwnerContext {
  const owner = boundOwner(store); owner.assertHeld();
  // This private slice supports the current default Workspace layout only; it does not infer a workspace from an
  // arbitrary store path. A later alternate-layout transport needs its own explicit binding, not path guessing.
  if (!ws || join(ws.path, '.farsight', 'sentinel', 'store') !== ws.storePath || ws.storePath !== owner.storePath) unavailable();
  const workspace = workspaceIdentity(ws.path), trustDir = ws.trustDir;
  // An adopted environment already exists. Refuse missing/aliased folders rather than allowing the existing
  // policy reader's ensurePrivateDir to create anything during this preflight/read-only path.
  if (realpathSync.native(trustDir) !== trustDir) unavailable();
  const trustIdentity = identity(trustDir);
  const signal = timing.signal, deadline = timing.deadlineAt, stillWithin = timing.stillWithin;
  if (!(signal instanceof AbortSignal) || (deadline !== undefined && !Number.isFinite(deadline)) || (stillWithin !== undefined && typeof stillWithin !== 'function')) unavailable();
  const state: Context = { store, owner, epoch: owner.epoch, workspace: workspace.path, workspaceDigest: workspace.digest, trustDir, trustIdentity,
    receipts: new ReceiptBook(join(trustDir, 'receipts')), signal, deadlineAt: Math.min(deadline ?? Infinity, performance.now() + 120000), stillWithin };
  const token = Object.freeze({}) as ImportOwnerContext; contexts.set(token, state);
  ownerContextOf(token); return token;
}
/** With callbacks false, the commit boundary invokes no caller code and opens no nested ledger read transaction. */
export function ownerContextOf(token: ImportOwnerContext, callbacks = true): Context {
  const c = contexts.get(token); if (!c) unavailable();
  if (callbacks) c.stillWithin?.();
  c.owner.assertHeld();
  if (c.owner !== boundOwner(c.store) || c.owner.epoch !== c.epoch || c.store.epoch !== c.epoch || c.owner.storeId !== c.store.storeId
    || c.signal.aborted || performance.now() >= c.deadlineAt || workspaceIdentity(c.workspace).digest !== c.workspaceDigest
    || realpathSync.native(c.trustDir) !== c.trustDir || identity(c.trustDir) !== c.trustIdentity) unavailable();
  return c;
}
export function currentImportPolicy(token: ImportOwnerContext, expected?: string, callbacks = true): EffectivePolicy {
  const c = ownerContextOf(token, callbacks), inputs = loadPolicyInputs({ workspace: c.workspace, trustDir: c.trustDir });
  if (inputs.trust !== 'adopted') unavailable();
  const policy = effectivePolicy(inputs);
  if (expected !== undefined && policy.revision !== expected) unavailable();
  ownerContextOf(token, callbacks); return policy;
}

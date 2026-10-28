// Private companion proof. A hello remains an agent; only a live exact private descriptor can pair.
// Browser capabilities and launch/reload tokens never travel to the owner service or Farsight parent.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { companionDirectory, companionWorkspaceDigest, readCompanion } from '@farsight/core/dist/sentinel-companion.js';
import type { OwnerCompanionDescriptor } from './descriptor.js';
import type { SentinelStore } from '../store/index.js';
import { boundOwner } from '../store/owner-binding.js';
import type { Workspace } from '../service/local.js';
import type { OwnerUiIssuer } from '../contracts/ownerui.js';
import { canonicalDigest } from '../policy/digest.js';
import { OwnerUiError, readOwnerContext, type OwnerViewContext } from './session.js';
export type OwnerUiAction = 'capture.source' | 'run.start' | 'run.pause' | 'run.cancel';
interface Pair {
  readonly store: SentinelStore;
  readonly descriptor: OwnerCompanionDescriptor;
  readonly directory: string;
  readonly issuer: Omit<OwnerUiIssuer, 'contextRevision'>;
  context: OwnerViewContext | null;
  active: boolean;
  readonly until: number;
}
export interface OwnerUiProof {
  readonly issuer: OwnerUiIssuer;
  readonly requestedBy: { readonly principal: 'human'; readonly channel: 'owner-ui' };
}
interface Scope {
  readonly pair: Pair;
  readonly action: OwnerUiAction | null;
  readonly revision: number;
  closed: boolean;
}
const scopes = new AsyncLocalStorage<{ proof: OwnerUiProof; scope: Scope }>(),
  proofs = new WeakMap<object, Scope>();
function check(pair: Pair) {
  pair.store.assertHeld();
  if (!pair.active || performance.now() >= pair.until || pair.issuer.ownerEpoch !== pair.store.epoch)
    throw new OwnerUiError('sentinel.ownerUi.expired');
  const actual = readCompanion(pair.directory, pair.descriptor);
  if (
    !actual ||
    actual.processNonce !== pair.descriptor.processNonce ||
    actual.ownerOrigin !== pair.descriptor.ownerOrigin
  )
    throw new OwnerUiError('sentinel.ownerUi.replaced');
}
export function assertOwnerUiProof(proof: OwnerUiProof, action?: string) {
  const scope = proofs.get(proof),
    current = scopes.getStore();
  if (!scope || current?.proof !== proof || scope.closed) throw new OwnerUiError();
  check(scope.pair);
  if (
    !scope.pair.context ||
    scope.pair.context.revision !== scope.revision ||
    (scope.action !== null && (scope.pair.context.mode !== 'live' || scope.pair.context.sync !== null))
  )
    throw new OwnerUiError('sentinel.ownerUi.readOnly');
  if (
    action !== undefined &&
    (scope.action !== action || !['capture.source', 'run.start', 'run.pause', 'run.cancel'].includes(action))
  )
    throw new OwnerUiError();
}
export function activeOwnerUiProof(): OwnerUiProof | null {
  const value = scopes.getStore();
  if (!value || value.scope.closed) return null;
  assertOwnerUiProof(value.proof);
  return value.proof;
}
export class OwnerUiAuthority {
  readonly #store: SentinelStore;
  readonly #ws: Workspace;
  readonly #pairs = new Map<string, Pair>();
  constructor(store: SentinelStore, ws: Workspace) {
    boundOwner(store).assertHeld();
    this.#store = store;
    this.#ws = ws;
  }
  pair(value: unknown) {
    const v = value as Record<string, unknown>;
    if (
      !v ||
      typeof v !== 'object' ||
      Array.isArray(v) ||
      Object.keys(v).sort().join(',') !== 'farsightOrigin,hostInstance,processNonce' ||
      typeof v.farsightOrigin !== 'string' ||
      typeof v.hostInstance !== 'string' ||
      typeof v.processNonce !== 'string' ||
      !/^([a-f0-9]{64})$/.test(v.processNonce)
    )
      throw new OwnerUiError();
    const directory = companionDirectory(),
      expected = {
        workspaceDigest: companionWorkspaceDigest(this.#ws.path),
        farsightOrigin: v.farsightOrigin,
        hostInstance: v.hostInstance,
      },
      descriptor = readCompanion(directory, expected);
    if (!descriptor || descriptor.processNonce !== v.processNonce) throw new OwnerUiError();
    this.#store.assertHeld();
    for (const [token, pair] of this.#pairs)
      if (
        !pair.active ||
        Date.parse(pair.descriptor.expiresAt) <= Date.now() ||
        performance.now() >= pair.until ||
        pair.descriptor.processNonce === descriptor.processNonce
      ) {
        pair.active = false;
        this.#pairs.delete(token);
      }
    if (this.#pairs.size >= 4) throw new OwnerUiError('sentinel.ownerUi.busy');
    const token = randomBytes(32).toString('hex'),
      issuer = {
        workspaceDigest: expected.workspaceDigest,
        storeId: this.#store.storeId,
        ownerEpoch: this.#store.epoch,
        hostInstance: descriptor.hostInstance,
        sessionDigest: canonicalDigest(token),
      };
    this.#pairs.set(token, {
      store: this.#store,
      descriptor,
      directory,
      issuer,
      context: null,
      active: true,
      until: performance.now() + Math.min(3600000, Date.parse(descriptor.expiresAt) - Date.now()),
    });
    return { proof: token, expiresAt: descriptor.expiresAt };
  }
  #pair(token: unknown) {
    if (typeof token !== 'string' || !/^([a-f0-9]{64})$/.test(token)) throw new OwnerUiError();
    const pair = this.#pairs.get(token);
    if (!pair) throw new OwnerUiError();
    check(pair);
    return pair;
  }
  context(token: unknown, value: unknown) {
    const pair = this.#pair(token),
      next = readOwnerContext(value, pair.descriptor.hostInstance),
      old = pair.context;
    if (
      old &&
      (old.documentId !== next.documentId ||
        old.frameNonce !== next.frameNonce ||
        next.revision < old.revision ||
        (next.revision === old.revision && JSON.stringify(next) !== JSON.stringify(old)))
    )
      throw new OwnerUiError();
    pair.context = next;
    return { revision: next.revision };
  }
  async with<T>(
    token: unknown,
    revision: unknown,
    action: OwnerUiAction | null,
    read: () => Promise<T> | T,
  ): Promise<T> {
    const pair = this.#pair(token);
    if (typeof revision !== 'number' || !pair.context || pair.context.revision !== revision)
      throw new OwnerUiError('sentinel.ownerUi.changed');
    const scope: Scope = { pair, revision, action, closed: false },
      proof: OwnerUiProof = Object.freeze({
        issuer: Object.freeze({ ...pair.issuer, contextRevision: revision }),
        requestedBy: Object.freeze({ principal: 'human', channel: 'owner-ui' }),
      });
    proofs.set(proof, scope);
    try {
      return await scopes.run({ scope, proof }, async () => {
        assertOwnerUiProof(proof);
        return read();
      });
    } finally {
      scope.closed = true;
    }
  }
  get retaining() {
    for (const [token, pair] of this.#pairs)
      if (!pair.active || Date.parse(pair.descriptor.expiresAt) <= Date.now() || performance.now() >= pair.until) {
        pair.active = false;
        this.#pairs.delete(token);
      }
    return this.#pairs.size > 0;
  }
  revoke(token: unknown) {
    const pair = this.#pair(token);
    pair.active = false;
    this.#pairs.delete(token as string);
  }
  close() {
    for (const pair of this.#pairs.values()) pair.active = false;
    this.#pairs.clear();
  }
}

// One absolutely expiring browser session. Only reload token persists in owner-origin sessionStorage.
import { randomBytes, timingSafeEqual } from 'node:crypto';
export class OwnerUiError extends Error {
  constructor(readonly code = 'sentinel.ownerUi.invalid') {
    super(code);
  }
}
const token = () => randomBytes(32).toString('hex'),
  same = (a: unknown, b: string | null) =>
    typeof a === 'string' &&
    b !== null &&
    a.length === 64 &&
    /^[a-f0-9]{64}$/.test(a) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
export interface OwnerViewContext {
  readonly frameNonce: string;
  readonly documentId: string;
  readonly revision: number;
  readonly hostInstance: string;
  readonly mode: 'live' | 'historical' | 'unavailable';
  readonly sync: number | null;
}
export function readOwnerContext(value: unknown, instance: string): OwnerViewContext {
  const v = value as OwnerViewContext;
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(',') !== 'documentId,frameNonce,hostInstance,mode,revision,sync' ||
    typeof v.frameNonce !== 'string' ||
    typeof v.documentId !== 'string' ||
    !/^frame-[a-f0-9]{32}$/.test(v.frameNonce) ||
    !/^document-[a-f0-9]{32}$/.test(v.documentId) ||
    v.hostInstance !== instance ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 1 ||
    v.revision > 1000000 ||
    !['live', 'historical', 'unavailable'].includes(v.mode) ||
    (v.mode !== 'historical' ? v.sync !== null : !Number.isSafeInteger(v.sync) || v.sync! < 1)
  )
    throw new OwnerUiError();
  return Object.freeze({
    frameNonce: v.frameNonce,
    documentId: v.documentId,
    revision: v.revision,
    hostInstance: v.hostInstance,
    mode: v.mode,
    sync: v.sync,
  });
}
export class OwnerUiSession {
  readonly createdAt = Date.now();
  readonly expiresAt: number;
  readonly #launchCode = token();
  readonly #instance: string;
  readonly #started = performance.now();
  #lastWall = this.createdAt;
  #revoked = false;
  #launchUsed = false;
  #bootstrapServed = false;
  #capability: string | null = null;
  #reload: string | null = null;
  #used = new Set<string>();
  #context: OwnerViewContext | null = null;
  #challenges = new Map<string, { revision: number; action: string; expiresAt: number }>();
  constructor(instance: string) {
    if (typeof instance !== 'string' || !/^host-[a-f0-9]{32}$/.test(instance)) throw new OwnerUiError();
    this.#instance = instance;
    this.expiresAt = this.createdAt + 3600000;
  }
  bootstrap(): string {
    this.#time();
    if (
      this.#bootstrapServed ||
      this.#launchUsed ||
      Date.now() >= this.createdAt + 120000 ||
      performance.now() - this.#started >= 120000
    )
      throw new OwnerUiError('sentinel.ownerUi.expired');
    this.#bootstrapServed = true;
    return this.#launchCode;
  }
  #time() {
    const now = Date.now();
    if (
      this.#revoked ||
      now < this.#lastWall ||
      now >= this.expiresAt ||
      performance.now() - this.#started >= 3600000
    ) {
      this.revoke();
      throw new OwnerUiError('sentinel.ownerUi.expired');
    }
    this.#lastWall = now;
  }
  get revoked() {
    return this.#revoked;
  }
  revoke() {
    this.#revoked = true;
    this.#capability = null;
    this.#reload = null;
    this.#context = null;
    this.#challenges.clear();
  }
  activate(kind: 'launch' | 'reload', secret: unknown, view: unknown) {
    this.#time();
    if (kind !== 'launch' && kind !== 'reload') throw new OwnerUiError();
    const current = readOwnerContext(view, this.#instance);
    if (kind === 'launch') {
      if (
        !this.#bootstrapServed ||
        this.#launchUsed ||
        Date.now() >= this.createdAt + 120000 ||
        performance.now() - this.#started >= 120000 ||
        !same(secret, this.#launchCode)
      )
        throw new OwnerUiError();
      this.#launchUsed = true;
    } else {
      if (typeof secret === 'string' && this.#used.has(secret)) {
        this.revoke();
        throw new OwnerUiError('sentinel.ownerUi.replayed');
      }
      if (!same(secret, this.#reload)) throw new OwnerUiError();
      if (this.#used.size >= 128) {
        this.revoke();
        throw new OwnerUiError('sentinel.ownerUi.expired');
      }
      this.#used.add(secret as string);
    }
    this.#capability = token();
    this.#reload = token();
    this.#context = current;
    this.#challenges.clear();
    return {
      capability: this.#capability,
      reloadToken: this.#reload,
      expiresAt: new Date(this.expiresAt).toISOString(),
    };
  }
  authenticate(capability: unknown) {
    this.#time();
    if (!same(capability, this.#capability)) throw new OwnerUiError();
    return this.#context!;
  }
  update(capability: unknown, value: unknown) {
    const old = this.authenticate(capability),
      next = readOwnerContext(value, this.#instance);
    if (next.documentId !== old.documentId || next.frameNonce !== old.frameNonce || next.revision < old.revision)
      throw new OwnerUiError();
    if (next.revision === old.revision && JSON.stringify(next) !== JSON.stringify(old)) throw new OwnerUiError();
    if (next.revision !== old.revision) this.#challenges.clear();
    this.#context = next;
    return next;
  }
  writable(capability: unknown, revision: number) {
    const view = this.authenticate(capability);
    if (view.mode !== 'live' || view.sync !== null || view.revision !== revision)
      throw new OwnerUiError('sentinel.ownerUi.readOnly');
    return view;
  }
  challenge(capability: unknown, action: string) {
    const view = this.authenticate(capability);
    this.writable(capability, view.revision);
    this.#challenges.clear();
    const id = token();
    this.#challenges.set(id, { revision: view.revision, action, expiresAt: Date.now() + 30000 });
    return { id, revision: view.revision, expiresAt: new Date(Date.now() + 30000).toISOString() };
  }
  consume(capability: unknown, id: string, action: string, revision: number) {
    const value = this.#challenges.get(id);
    this.#challenges.delete(id);
    this.writable(capability, revision);
    if (!value || value.action !== action || value.revision !== revision || Date.now() >= value.expiresAt)
      throw new OwnerUiError('sentinel.ownerUi.changed');
  }
}

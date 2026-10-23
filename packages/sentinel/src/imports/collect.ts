// What one import collects as it reads: the tool's claims, the exchanges a report recorded, the cookie facts read
// from their Set-Cookie lines, and every unknown with its pointer. An attribute observation is a fact about one line
// of the supplied bytes; it is `stated` (inside the scope the caller said was tested) only when the report itself
// records a well-formed request whose absolute target gives the origin (or ZAP's matching instance URI and Host
// establish that claimed origin), whose method agrees with the report, and both are in the caller's stated scope.
// Missing or inconsistent report evidence stays unbound: the manifest's origin is never borrowed to fill the gap.
import { createHash } from 'node:crypto';
import { COOKIE_PROPERTIES, ImportBudget, type CookieProperty, type ImportUnknownCode, type Json } from './types.js';
import type { ImportManifest } from './manifest.js';
import { parseSetCookie, requestCookieNames, type AttributeFact } from './set-cookie.js';

export type RequestInfo =
  | { readonly ok: true; readonly method: string; readonly target: string; readonly origin: string | undefined; readonly cookieHeaders: readonly string[] }
  | { readonly ok: false; readonly reason: ImportUnknownCode };
export type ResponseInfo =
  | { readonly ok: true; readonly status: number; readonly setCookies: readonly string[] | { readonly reason: ImportUnknownCode } }
  | { readonly ok: false; readonly reason: ImportUnknownCode };

export interface CookieObservation {
  readonly property: CookieProperty;
  readonly direction: 'outbound';
  readonly outcome: 'present' | 'absent' | 'unknown';
  readonly sameSite?: 'strict' | 'lax' | 'none';
  readonly reason?: ImportUnknownCode;
  readonly scope: 'stated' | 'unbound';
  readonly scopeReason?: ImportUnknownCode;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const bounded = (s: string, n: number) => s.length > n ? s.slice(0, n) : s;

export class Collector {
  readonly claims: Json[] = [];
  readonly exchanges: Json[] = [];
  readonly cookies: Json[] = [];
  readonly unknowns: { pointer: string; code: ImportUnknownCode }[] = [];
  readonly #ignored = new Map<string, { objectKind: string; key: string; count: number }>();

  constructor(readonly rawDigest: string, readonly manifest: ImportManifest, readonly budget: ImportBudget) {}

  /** A stable id for a part of this exact document: its raw digest and JSON pointer. */
  id(kind: string, pointer: string): string {
    this.budget.work(Math.ceil(pointer.length / 64) + 1);
    return `${kind}.${sha(`${this.rawDigest}\u0000${pointer}`).slice(0, 40)}`;
  }

  unknown(pointer: string, code: ImportUnknownCode): void {
    this.budget.count('unknowns');
    this.unknowns.push({ pointer: bounded(pointer, 256), code });
  }

  /** A documented field this adapter reads past without interpreting. */
  ignore(objectKind: string, key: string): void {
    const k = `${objectKind}\u0000${key}`;
    const e = this.#ignored.get(k);
    if (e) { e.count++; this.budget.work(); return; }
    this.budget.count('ignored');
    this.#ignored.set(k, { objectKind, key: bounded(key, 128), count: 1 });
  }

  get ignored(): Json[] {
    return [...this.#ignored.values()].sort((a, b) => a.objectKind.localeCompare(b.objectKind) || a.key.localeCompare(b.key)).map(e => ({ ...e }));
  }

  claim(pointer: string, body: { readonly [k: string]: Json }): void {
    this.budget.count('claims');
    this.claims.push({ id: this.id('claim', pointer), pointer: bounded(pointer, 256), ...body });
  }

  digest(text: string): string {
    this.budget.work(Math.ceil(text.length / 64) + 1);
    return `sha256:${sha(text)}`;
  }

  exchange(pointer: string, source: 'sarif-inline' | 'sarif-indexed' | 'zap-instance', request: RequestInfo | null, response: ResponseInfo | null): void {
    this.budget.count('exchanges');
    const id = this.id('exchange', pointer);
    const reasons: ImportUnknownCode[] = [];
    if (!request) reasons.push('sentinel.import.noExchange');
    else if (!request.ok) reasons.push(request.reason);
    if (!response) reasons.push('sentinel.import.noResponse');
    else if (!response.ok) reasons.push(response.reason);
    for (const r of reasons) this.unknown(pointer, r);

    // The scope every attribute fact of this exchange is read in.
    let scopeReason: ImportUnknownCode | undefined;
    if (!request) scopeReason = 'sentinel.import.noExchange';
    else if (!request.ok) scopeReason = request.reason;
    else if (request.origin === undefined) scopeReason = 'sentinel.import.originUnknown';
    else if (!this.manifest.tested.origins.includes(request.origin) || !this.manifest.tested.methods.includes(request.method)
      || !this.manifest.tested.directions.includes('outbound')) scopeReason = 'sentinel.import.outsideStatedScope';

    let inbound: string[] | null = null;
    if (request?.ok && request.cookieHeaders.length) {
      inbound = [];
      for (const h of request.cookieHeaders) {
        const names = requestCookieNames(h);
        if (!names) { this.unknown(pointer, 'sentinel.import.cookieMalformed'); continue; }
        this.budget.count('cookies', names.length);
        for (const n of names) inbound.push(bounded(n, 256));
      }
    }

    this.exchanges.push({
      id, pointer: bounded(pointer, 256), source,
      method: request?.ok ? bounded(request.method, 32) : null,
      origin: request?.ok ? request.origin ?? null : null,
      targetDigest: request?.ok ? this.digest(request.target) : null,
      status: response?.ok ? response.status : null,
      completeness: reasons.length ? 'partial' : 'complete',
      reasons,
      // Inbound cookies carry names only: a request never shows Secure, HttpOnly or SameSite.
      inboundCookieNames: inbound,
    });

    if (!response?.ok) return;
    const lines = response.setCookies;
    if (!Array.isArray(lines)) { this.unknown(`${pointer}/set-cookie`, (lines as { reason: ImportUnknownCode }).reason); return; }
    const status = response.status;
    const statusReason: ImportUnknownCode | undefined = status >= 300 && status < 400 ? 'sentinel.import.redirect' : status < 200 ? 'sentinel.import.statusMalformed' : undefined;
    const parsed = (lines as readonly string[]).map(l => { this.budget.work(Math.ceil(l.length / 64) + 1); return statusReason ? null : parseSetCookie(l); });
    const perName = new Map<string, number>();
    for (const p of parsed) if (p?.ok) perName.set(p.name, (perName.get(p.name) ?? 0) + 1);
    parsed.forEach((p, occurrence) => {
      this.budget.count('cookies');
      const cp = `${pointer}/set-cookie/${occurrence}`;
      const duplicate = p?.ok && (perName.get(p.name) ?? 0) > 1;
      const lineReason: ImportUnknownCode | undefined = statusReason ?? (p && !p.ok ? p.reason : undefined) ?? (duplicate ? 'sentinel.import.duplicateInResponse' : undefined);
      if (lineReason) this.unknown(cp, lineReason);
      const facts: Record<CookieProperty, AttributeFact> | undefined = p?.ok && !lineReason
        ? { 'cookie-secure': p.secure, 'cookie-http-only': p.httpOnly, 'cookie-same-site': p.sameSite } : undefined;
      const observations: CookieObservation[] = COOKIE_PROPERTIES.map(property => {
        this.budget.count('observations');
        const fact: AttributeFact = facts ? facts[property] : { outcome: 'unknown', reason: lineReason! };
        const propertyScope = scopeReason ?? (this.manifest.tested.properties.includes(property) ? undefined : 'sentinel.import.outsideStatedScope');
        return {
          property, direction: 'outbound', outcome: fact.outcome,
          ...(fact.outcome === 'present' && fact.value ? { sameSite: fact.value } : {}),
          ...(fact.outcome === 'unknown' ? { reason: fact.reason } : {}),
          scope: propertyScope ? 'unbound' : 'stated',
          ...(propertyScope ? { scopeReason: propertyScope } : {}),
        };
      });
      this.cookies.push({
        id: this.id('cookie', cp), exchangeId: id, pointer: bounded(cp, 256), occurrence,
        parse: p?.ok ? 'ok' : 'unknown',
        ...(p?.ok ? {
          name: bounded(p.name, 256), valueBytes: p.valueBytes, quoted: p.quoted, domain: p.domain, path: p.path,
          lifetime: p.lifetime, partitioned: p.partitioned, extensions: [...p.extensions],
        } : {}),
        observations: observations as unknown as Json[],
      });
    });
  }
}

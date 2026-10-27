import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { contextFingerprint } from './sessions.js';
import { createResearchStore } from './research-store.js';
import type { BackendConnection, EchoContext } from './types.js';
import type { PortalBrowseInput, PortalBrowseResult, PortalCallbacks, ResearchCatalog } from './portal-types.js';

export class PortalFailure extends Error {
  constructor(readonly code: 'invalid' | 'unavailable' | 'stale' | 'timeout' | 'failed') {
    super(code);
    this.name = 'PortalFailure';
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(): never {
  throw new PortalFailure('invalid');
}
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function validatePortalBrowse(input: unknown): PortalBrowseInput {
  if (!object(input) || Object.keys(input).some((key) => !['query', 'since', 'until', 'cursor'].includes(key)))
    invalid();
  if (
    (input.query !== undefined && !text(input.query, 4000)) ||
    (input.since !== undefined && !date(input.since)) ||
    (input.until !== undefined && !date(input.until)) ||
    (input.since !== undefined && input.until !== undefined && String(input.since) > String(input.until)) ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || !/^[a-zA-Z0-9_.-]{1,8192}$/.test(input.cursor)))
  )
    invalid();
  return {
    ...(input.query === undefined ? {} : { query: (input.query as string).trim() }),
    ...(input.since === undefined ? {} : { since: input.since as string }),
    ...(input.until === undefined ? {} : { until: input.until as string }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }),
  };
}
export function validatePortalExpand(input: unknown): { id: string; revision: string } {
  if (
    !object(input) ||
    Object.keys(input).some((key) => !['id', 'revision'].includes(key)) ||
    typeof input.id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(input.id) ||
    typeof input.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.revision)
  )
    invalid();
  return { id: input.id as string, revision: input.revision as string };
}
export function validatePortalAsk(input: unknown): { query: string } {
  if (
    !object(input) ||
    Object.keys(input).some((key) => key !== 'query') ||
    !text(input.query, 4000) ||
    !input.query.trim()
  )
    invalid();
  return { query: input.query.trim() };
}

/** A read-only browser over the already connected backend. It never starts a model or a memory engine. */
export function createMemoryPortal(
  ctx: EchoContext,
  connection: BackendConnection,
  supplied?: ResearchCatalog,
): Pick<PortalCallbacks, 'browse'> {
  const snapshot = structuredClone(ctx);
  const store = supplied ?? createResearchStore(snapshot, connection);
  const fingerprint = contextFingerprint(snapshot);
  const cursorSecret = randomBytes(32);
  const sign = (payload: string): string => createHmac('sha256', cursorSecret).update(payload).digest('base64url');
  return {
    async browse(raw, signal): Promise<PortalBrowseResult> {
      const input = validatePortalBrowse(raw);
      const selection = { query: input.query ?? '', since: input.since ?? null, until: input.until ?? null };
      const binding = createHash('sha256')
        .update(JSON.stringify([fingerprint, selection]))
        .digest('hex');
      let cursor: string | undefined;
      if (input.cursor) {
        const parts = input.cursor.split('.');
        if (parts.length !== 2) invalid();
        const [payload, signature] = parts as [string, string];
        const expected = Buffer.from(sign(payload));
        const actual = Buffer.from(signature);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) invalid();
        try {
          const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
          if (
            !object(decoded) ||
            decoded.binding !== binding ||
            typeof decoded.cursor !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,4096}$/.test(decoded.cursor)
          )
            invalid();
          cursor = decoded.cursor;
        } catch {
          invalid();
        }
      }
      const page = await store.browse({ ...selection, ...(cursor ? { cursor } : {}) }, signal);
      let nextCursor: string | null = null;
      if (page.nextCursor) {
        const payload = Buffer.from(JSON.stringify({ binding, cursor: page.nextCursor })).toString('base64url');
        nextCursor = `${payload}.${sign(payload)}`;
        if (nextCursor.length > 8192) throw new PortalFailure('failed');
      }
      return {
        schema: 'echo-portal/v1',
        profileId: snapshot.profileId,
        identity: { ...snapshot.profile.identity },
        ...selection,
        ...page,
        nextCursor,
        counts: {
          shown: {
            n: page.memories.length,
            unit: 'echo.portal.countShown',
            bizUnit: 'echo.portal.countShown',
            scope: 'echo.portal.scope',
            source: 'echo.portal.browse.memories',
          },
        },
      };
    },
  };
}

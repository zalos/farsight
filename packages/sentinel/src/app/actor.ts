// Who asks, decided where the request enters the product, never by what the request says. The owner's own command
// line, running in this process, is the only owner channel. Every client of the local service, the owner's CLI
// included, is a non-owner (`agent`) on a service channel: nothing it sends (a hello, a client kind, a body) can
// select owner authority. A request body that names an actor, a principal or a channel is refused. Owner authority
// reaches ordinary service operations as a genuine CLI receipt after its confirm step. The separate closed
// owner-UI controller can issue its own honest receipt only under private descriptor/session/context proof;
// it never changes a socket grant or mints CLI authority. A connection body cannot select either issuer.
// Code running as the same OS account is outside this boundary.
import type { DecisionChannel, Principal } from '../contracts/index.js';

export type { Principal };

/** The channel a local service connection is recorded under: any channel but the owner's own. */
export type ServiceChannel = Exclude<DecisionChannel, 'owner-cli'>;

export interface RequestedBy {
  readonly principal: Principal;
  readonly channel: DecisionChannel;
}

/** What a service connection is granted: never the owner, never human authority. */
export interface ServiceGrant {
  readonly principal: 'agent';
  readonly channel: ServiceChannel;
}

/** The ways into the product. Each fixes its actor; none reads one from the request. */
export type Entrypoint =
  /** This executable, run by the user at a terminal or in their own script. */
  | { readonly kind: 'owner-cli' }
  /** A client of the local service: always a non-owner, on the channel its connection was accepted for. */
  | { readonly kind: 'service-connection'; readonly granted: ServiceGrant };

export function requestedByOf(entry: Entrypoint): RequestedBy {
  if (entry.kind === 'owner-cli') return Object.freeze({ principal: 'human', channel: 'owner-cli' });
  const g = entry.granted as { principal: string; channel: string };
  // The owner channel and human authority are the command line's own; a connection is never granted either.
  if (g.channel === 'owner-cli' || g.principal !== 'agent')
    throw new ActorError('sentinel.actor.ownerChannelNotGrantable');
  return Object.freeze({ principal: 'agent', channel: g.channel as ServiceChannel });
}

export type ActorErrorCode =
  | 'sentinel.actor.payloadClaim'
  | 'sentinel.actor.confirmNotOwner'
  | 'sentinel.actor.ownerChannelNotGrantable'
  | 'sentinel.actor.payloadTooDeep'
  | 'sentinel.actor.ownerMintClaimed'
  | 'sentinel.actor.ownerMintNotEntry';

/** Request bodies nest at most this deep; a deeper one is refused, never skipped. */
export const MAX_BODY_DEPTH = 32;

export class ActorError extends Error {
  constructor(
    readonly code: ActorErrorCode,
    readonly field?: string,
  ) {
    super(field === undefined ? code : `${code}: ${field}`);
    this.name = 'ActorError';
  }
}

/** Fields a request body may never carry: who is asking is the entrypoint's to say. */
// A receipt's id may travel (the service verifies it against the receipt book); a claim of who confirmed may not.
const CLAIM_FIELDS = new Set([
  'actor',
  'principal',
  'channel',
  'who',
  'requestedBy',
  'requested_by',
  'owner',
  'confirmedBy',
]);

/** Refuses a request body (at any depth) that names a requester. Returns the body unchanged otherwise. */
export function refuseActorClaims<T>(body: T): T {
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    // Refused rather than skipped: a claim nested past the bound must not slip through unseen.
    if (depth > MAX_BODY_DEPTH) throw new ActorError('sentinel.actor.payloadTooDeep');
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1));
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (CLAIM_FIELDS.has(k)) throw new ActorError('sentinel.actor.payloadClaim', k);
      walk(x, depth + 1);
    }
  };
  walk(body, 0);
  return body;
}

/**
 * Whether this requester may confirm an action awaiting the owner. Only the owner channel can, and only through
 * its own confirm step (`--confirm`): an agent, the HTTP bridge or a model never confirms, including its own request.
 */
export function assertMayConfirm(by: RequestedBy): void {
  if (by.channel !== 'owner-cli' || by.principal !== 'human') throw new ActorError('sentinel.actor.confirmNotOwner');
}

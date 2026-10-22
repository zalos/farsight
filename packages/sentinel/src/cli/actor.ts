// Who asks, decided where the request enters the product, never by what the request says. The owner's own command
// line is the owner channel; a client of the local service is whatever its connection was granted when it was
// accepted. A request body that names an actor, a principal or a channel is refused, so no payload can claim a
// more privileged requester. Only the owner channel can confirm (and so lead to an owner receipt); an agent cannot
// confirm its own request. Code running as the same OS account is outside this boundary.
import type { DecisionChannel } from '../contracts/index.js';

/** Mirrors PR 06's `Principal` (contracts/policy.ts on its branch); replaced by the import once it is merged. */
export type Principal = 'human' | 'agent';

export interface RequestedBy {
  readonly principal: Principal;
  readonly channel: DecisionChannel;
}

/** The ways into the product. Each fixes its actor; none reads one from the request. */
export type Entrypoint =
  /** This executable, run by the user at a terminal or in their own script. */
  | { readonly kind: 'owner-cli' }
  /** A client of the local service: its principal and channel are what the connection was granted at handshake. */
  | { readonly kind: 'service-connection'; readonly granted: RequestedBy };

export function requestedByOf(entry: Entrypoint): RequestedBy {
  if (entry.kind === 'owner-cli') return Object.freeze({ principal: 'human', channel: 'owner-cli' });
  const g = entry.granted;
  if (g.channel === 'owner-cli') {
    // The owner channel is the command line itself; a connection can never be granted it.
    throw new ActorError('sentinel.actor.ownerChannelNotGrantable');
  }
  return Object.freeze({ principal: g.principal, channel: g.channel });
}

export type ActorErrorCode = 'sentinel.actor.payloadClaim' | 'sentinel.actor.confirmNotOwner' | 'sentinel.actor.ownerChannelNotGrantable';

export class ActorError extends Error {
  constructor(readonly code: ActorErrorCode, readonly field?: string) {
    super(field === undefined ? code : `${code}: ${field}`);
    this.name = 'ActorError';
  }
}

/** Fields a request body may never carry: who is asking is the entrypoint's to say. */
const CLAIM_FIELDS = new Set(['actor', 'principal', 'channel', 'who', 'requestedBy', 'requested_by', 'owner', 'receipt', 'confirmedBy']);

/** Refuses a request body (at any depth) that names a requester. Returns the body unchanged otherwise. */
export function refuseActorClaims<T>(body: T): T {
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (v === null || typeof v !== 'object' || seen.has(v) || depth > 32) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
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

// Who calls the facade (app/service.ts). Every method takes a principal; what it may do follows from which kind it
// is, never from what it says about itself.
//
// - The owner principal is minted only by the command line's own entry, in the owner's own process (ADR 37): it can
//   confirm, which issues the owner's receipts here. The mint is handed out once per process (`claimOwnerMint`), to
//   cli.ts as it loads; the owner exists only as an object that mint made and this module remembers, so a copy, a
//   parsed request body or any object built to look like one is not it, and is refused.
// - An agent principal is what every connection to the local service is, the owner's own CLI included: built by the
//   transport from the channel it accepted, never the owner channel. It confirms nothing; owner authority reaches it
//   only as an owner receipt issued by the command line after its --confirm.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requestedByOf, ActorError, type RequestedBy, type ServiceChannel } from './actor.js';

export interface OwnerPrincipal {
  readonly kind: 'owner';
  readonly requestedBy: RequestedBy;
}
export interface AgentPrincipal {
  readonly kind: 'agent';
  readonly requestedBy: RequestedBy;
}
export type Principal = OwnerPrincipal | AgentPrincipal;

/** The owner principals this module minted: the only objects `isOwner` accepts. */
const OWNERS = new WeakSet<object>();
/** Whether the mint was handed out: once per process, to the command line's entry (cli.ts claims it as it loads). */
let mintClaimed = false;
/** This package's command line (dist/cli.js beside dist/app/): the only entry an owner can exist under. */
const CLI_ENTRY = fileURLToPath(new URL('../cli.js', import.meta.url));

/**
 * Whether this process's entry is this package's command line: `process.argv[1]`, resolved through any link (the
 * installed `farsight-sentinel` bin is one), is exactly its `cli.js`. A test, a library importer, `node -e` or another
 * program is not, whatever it imports.
 */
export function entryIsOwnerCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync.native(entry) === realpathSync.native(CLI_ENTRY);
  } catch {
    return false;
  }
}

/**
 * Hands the owner mint to the command line's own entry, once per process. An owner exists only in a process whose
 * entry is the owner's command line: in any other process the claim is refused (`sentinel.actor.ownerMintNotEntry`),
 * so a library importer, a test or another program cannot make one even first. In the command line's own process,
 * cli.ts claims it as it loads, before any command runs, and keeps it module-private; any later claim (a second
 * importer, a transport) is refused with `sentinel.actor.ownerMintClaimed`.
 */
export function claimOwnerMint(): () => OwnerPrincipal {
  if (!entryIsOwnerCli()) throw new ActorError('sentinel.actor.ownerMintNotEntry');
  if (mintClaimed) throw new ActorError('sentinel.actor.ownerMintClaimed');
  mintClaimed = true;
  return () => {
    const owner: OwnerPrincipal = Object.freeze({ kind: 'owner', requestedBy: requestedByOf({ kind: 'owner-cli' }) });
    OWNERS.add(owner);
    return owner;
  };
}

/** A connection's principal, from the channel its transport accepted: always an agent, never the owner channel. */
export function agentPrincipal(by: RequestedBy): AgentPrincipal {
  if (by.channel === 'owner-cli' || by.principal !== 'agent')
    throw new ActorError('sentinel.actor.ownerChannelNotGrantable');
  const granted = requestedByOf({
    kind: 'service-connection',
    granted: { principal: 'agent', channel: by.channel as ServiceChannel },
  });
  return Object.freeze({ kind: 'agent', requestedBy: granted });
}

/** True only for an owner principal this module minted. */
export const isOwner = (p: unknown): p is OwnerPrincipal => typeof p === 'object' && p !== null && OWNERS.has(p);

/** True for an agent principal; anything that is neither is refused by the facade. */
const isAgent = (p: unknown): p is AgentPrincipal =>
  typeof p === 'object' &&
  p !== null &&
  !OWNERS.has(p) &&
  (p as { kind?: unknown }).kind === 'agent' &&
  (p as AgentPrincipal).requestedBy?.principal === 'agent' &&
  (p as AgentPrincipal).requestedBy?.channel !== 'owner-cli';

/**
 * The principal a facade method acts for, checked: the owner it minted, or an agent. An object that claims to be the
 * owner but was not minted here (a forged or copied one) is refused with `sentinel.actor.confirmNotOwner`.
 */
export function principalOf(p: unknown): Principal {
  if (isOwner(p)) return p;
  if (isAgent(p)) return p;
  throw new ActorError('sentinel.actor.confirmNotOwner');
}

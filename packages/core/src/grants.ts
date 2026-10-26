// The shared grant matcher (ADR 20): verdict 1 of every three-verdict gate, the consumer's own policy.
//
// Default deny; grants are additive; there is no deny grant. A grant names its principals, and one that names
// none is for people only. An agent waits for a person unless the policy allows agent writes or the grant says
// `confirm: 'never'`. Of the grants that allow an action, the first that needs no confirmation wins over one that
// does. Pure: no call leaves the process, and nothing here knows a tracker, a code host or a scanner. Each consumer
// supplies its own grant shape, its own target check (`miss`) and its own other two verdicts.

/** Who asks for an action. */
export type GrantPrincipal = 'human' | 'agent';

/** When an allowed action still waits for a person to press apply. */
export type GrantConfirm = 'always' | 'agent' | 'never';

/** Whether agents act without a person by default: `confirm` (the default) means they never do. */
export type AgentWritesPolicy = 'confirm' | 'allow';

/** One verdict: whether it is allowed, and why in one plain sentence. */
export interface GrantVerdict {
  allowed: boolean;
  reason: string;
}

/** A policy verdict over any grant shape. */
export interface GrantDecision<G> {
  verdict: GrantVerdict;
  grant?: G;
  requiresConfirmation: boolean;
}

/** The fields of a grant the shared policy reads — a tracker's `Grant`, a code host's, any later consumer's. */
export interface GrantLike<A extends string = string> {
  actions: A[];
  principals?: GrantPrincipal[];
  confirm?: GrantConfirm;
}

/**
 * Verdict 1, the shared half: of the grants that allow `action` for `who`, the first that needs no
 * confirmation wins over one that does; a grant names its principals, and one that names none is for people
 * only. `miss(g)` says why a grant that allows the action does not cover this target (a tracker item's
 * project, a field…), or null. Default deny. Pure; no call leaves the process. Tracker writes and code-host
 * posts (`farsight affected --post`) both decide here, so the two cannot drift.
 */
export function decideGrants<A extends string, G extends GrantLike<A>>(
  grants: readonly G[] | undefined,
  action: A,
  who: GrantPrincipal,
  opts: { agentWrites?: AgentWritesPolicy; miss?: (g: G) => string | null } = {},
): GrantDecision<G> {
  const allowing = (grants ?? []).filter((g) => g.actions.includes(action));
  if (!allowing.length)
    return { verdict: { allowed: false, reason: `no grant allows ${action}` }, requiresConfirmation: false };
  let closest: string | null = null;
  let best: GrantDecision<G> | null = null;
  for (const g of allowing) {
    const principals = g.principals ?? ['human'];
    if (!principals.includes(who)) {
      closest ??= `no grant allows ${action} for ${who === 'agent' ? 'an agent' : 'a person'}`;
      continue;
    }
    const miss = opts.miss ? opts.miss(g) : null;
    if (miss) {
      closest = miss;
      continue;
    }
    const confirm = g.confirm;
    const agentConfirm = who === 'agent' && (opts.agentWrites ?? 'confirm') === 'confirm' && confirm !== 'never';
    const requiresConfirmation = confirm === 'always' || (confirm === 'agent' && who === 'agent') || agentConfirm;
    const d = {
      verdict: { allowed: true, reason: `granted: ${g.actions.join(', ')} for ${principals.join(' and ')}` },
      grant: g,
      requiresConfirmation,
    };
    if (!requiresConfirmation) return d;
    best ??= d;
  }
  if (best) return best;
  return { verdict: { allowed: false, reason: closest ?? `no grant allows ${action}` }, requiresConfirmation: false };
}

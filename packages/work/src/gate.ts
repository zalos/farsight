// The permission gate and write-back (docs/proposals/work-items-sync.md §7, §8, ADR 12).
//
// A write needs three yeses, ANDed, and the audit row keeps all three:
//   1. the consumer's policy (settings `permissions`) — evaluated here, locally, before any call;
//   2. the tracker's own answer — `provider.can()`, plus what the provider declares it can do;
//   3. the credential's scope — recorded on the session at connect.
// Default deny; grants are additive; there is no deny grant.
//
// Write-back: intent → gate → freshness check → provider.apply() → re-read → replace in cache → audit.
// A stale revision is a conflict and is never applied.
import type { WorkItem, WorkAction, Intent, Verdict, Verdicts, IntentState, ApplyResult } from './contract.js';
import type { Permissions, Grant, SourceConfig, WorkProvider, Session } from './provider.js';
import type { WorkCache, PreviewFact } from './cache.js';

export interface PolicyDecision {
  verdict: Verdict;
  /** the grant that allowed it */
  grant?: Grant;
  /** a person must press apply before this write happens */
  requiresConfirmation: boolean;
}

/** The project an item belongs to: `fields.project` when the provider set it, else the Jira-shaped key prefix. */
export function projectOf(item: WorkItem): string | undefined {
  const p = item.fields.project;
  if (typeof p === 'string') return p;
  return /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(item.key)?.[1];
}

function scopeMiss(g: Grant, item: WorkItem): string | null {
  const s = g.scope;
  if (!s) return null;
  if (s.projects?.length) {
    const p = projectOf(item);
    if (!p || !s.projects.includes(p)) return `${item.key} is outside the granted projects`;
  }
  if (s.types?.length && !s.types.includes(item.type.category)) return `the grant does not cover a ${item.type.category}`;
  if (s.areas?.length && !(item.area && s.areas.some((a) => item.area === a || item.area!.startsWith(a + '\\') || item.area!.startsWith(a + '/')))) {
    return `${item.key} is outside the granted areas`;
  }
  if (s.states?.length && !s.states.includes(item.state.category)) return `the grant does not cover an item that is ${item.state.category}`;
  return null;
}

function actionMiss(g: Grant, intent: Intent): string | null {
  if (intent.action === 'edit' && g.fields) {
    const outside = Object.keys(intent.payload.fields ?? {}).filter((f) => !g.fields!.includes(f));
    if (outside.length) return `the grant does not let edit touch ${outside.join(', ')}`;
  }
  if (intent.action === 'transition' && g.to) {
    if (!intent.payload.to || !g.to.includes(intent.payload.to)) return `the grant does not allow moving to ${intent.payload.to ?? 'an unnamed state'}`;
  }
  return null;
}

/** Verdict 1 — the consumer's policy. Pure; no call leaves the process. */
export function evaluatePolicy(
  permissions: Permissions | undefined,
  intent: Intent,
  item: WorkItem,
  opts: { mode?: SourceConfig['mode'] } = {},
): PolicyDecision {
  if ((opts.mode ?? 'read-only') !== 'edit') {
    return { verdict: { allowed: false, reason: 'this source is read-only' }, requiresConfirmation: false };
  }
  const who = intent.requestedBy.kind;
  const grants = (permissions?.grants ?? []).filter((g) => g.actions.includes(intent.action));
  if (!grants.length) return { verdict: { allowed: false, reason: `no grant allows ${intent.action}` }, requiresConfirmation: false };
  let closest: string | null = null;
  for (const g of grants) {
    // a grant names its principals; one that names none is for people only — an agent needs an explicit grant
    const principals = g.principals ?? ['human'];
    if (!principals.includes(who)) { closest ??= `no grant allows ${intent.action} for ${who === 'agent' ? 'an agent' : 'a person'}`; continue; }
    const miss = scopeMiss(g, item) ?? actionMiss(g, intent);
    if (miss) { closest = miss; continue; }
    const confirm = g.confirm;
    const agentConfirm = who === 'agent' && (permissions?.agentWrites ?? 'confirm') === 'confirm' && confirm !== 'never';
    const requiresConfirmation = confirm === 'always' || (confirm === 'agent' && who === 'agent') || agentConfirm;
    return { verdict: { allowed: true, reason: `granted: ${g.actions.join(', ')} for ${principals.join(' and ')}` }, grant: g, requiresConfirmation };
  }
  return { verdict: { allowed: false, reason: closest ?? `no grant allows ${intent.action}` }, requiresConfirmation: false };
}

/** What the provider declares it cannot do at all (§7.2: *this source cannot*). */
export function capabilityMiss(provider: WorkProvider, action: WorkAction): string | null {
  const c = provider.capabilities;
  if (c.actions && !c.actions.includes(action)) return `this source cannot ${action}`;
  if (action === 'comment' && !c.comments.write) return 'this source cannot write comments';
  return null;
}

/** Verdict 3 — the credential's scope, as checked at connect. */
export function credentialVerdict(session: Session): Verdict {
  const c = session.credentialScope;
  if (!c) return { allowed: false, reason: 'the credential’s write scope is unknown' };
  return c.write
    ? { allowed: true, reason: c.detail ? `the credential can write (${c.detail})` : 'the credential can write' }
    : { allowed: false, reason: c.detail ? `the credential is read-only (${c.detail})` : 'the credential is read-only' };
}

/** A session, or a way to open one only when a call must leave the process. */
export type SessionRef = Session | (() => Promise<Session>);

const opened = new WeakMap<() => Promise<Session>, Promise<Session>>();
function sessionOf(ref: SessionRef): Promise<Session> {
  if (typeof ref !== 'function') return Promise.resolve(ref);
  let p = opened.get(ref);
  if (!p) { p = ref(); opened.set(ref, p); }
  return p;
}

export interface Decision {
  verdicts: Verdicts;
  allowed: boolean;
  requiresConfirmation: boolean;
}

const NOT_ASKED = (why: string): Verdict => ({ allowed: false, reason: `not asked — ${why}` });

/** All three verdicts. The tracker is not asked when the local policy already said no. */
export async function decide(
  intent: Intent,
  ctx: { cfg: SourceConfig; provider: WorkProvider; session: SessionRef; item: WorkItem },
): Promise<Decision> {
  const policy = evaluatePolicy(ctx.cfg.permissions, intent, ctx.item, { mode: ctx.cfg.mode });
  let tracker: Verdict;
  let credential: Verdict;
  if (!policy.verdict.allowed) {
    // local policy said no: nothing leaves the process, not even a connect
    tracker = NOT_ASKED('the policy denied it first');
    credential = NOT_ASKED('the policy denied it first');
  } else {
    const session = await sessionOf(ctx.session);
    credential = credentialVerdict(session);
    const miss = capabilityMiss(ctx.provider, intent.action);
    tracker = miss ? { allowed: false, reason: miss } : await ctx.provider.can(session, ctx.item, intent.action);
  }
  const allowed = policy.verdict.allowed && tracker.allowed && credential.allowed;
  return { verdicts: { policy: policy.verdict, tracker, credential }, allowed, requiresConfirmation: allowed && policy.requiresConfirmation };
}

export interface ApplyOutcome {
  intent: Intent;
  /** outbox state after this call; `queued` + `pending` = waiting for a person */
  state: IntentState;
  pending: boolean;
  verdicts?: Verdicts;
  result?: ApplyResult;
  /** the tracker's current record after the call (re-read on success and on conflict) */
  item?: WorkItem;
  reason?: string;
  /** the tracker's dry-run answer, when the provider has preview() — printed *dry run: ok* / *dry run: <reason>* */
  preview?: PreviewFact;
}

export interface ApplyContext {
  cfg: SourceConfig;
  provider: WorkProvider;
  /** a connected session, or a function that connects — called only once the policy allows the write */
  session: SessionRef;
  cache: WorkCache;
  now?: () => Date;
  /** a person pressed apply (in the HUD or CLI) — clears a `confirm` requirement */
  confirmed?: boolean;
}

/** The agent attribution prefix (§7.4), unless the policy says `attribution: none`. */
export function attributed(intent: Intent, permissions: Permissions | undefined): Intent {
  if (intent.action !== 'comment' || intent.requestedBy.kind !== 'agent' || permissions?.attribution === 'none') return intent;
  const body = intent.payload.body ?? '';
  if (body.startsWith('via Farsight (agent)')) return intent;
  return { ...intent, payload: { ...intent.payload, body: `via Farsight (agent): ${body}` } };
}

/** intent → gate → freshness check → apply → re-read → replace → audit. */
export async function applyIntent(intent: Intent, ctx: ApplyContext): Promise<ApplyOutcome> {
  const now = ctx.now ?? (() => new Date());
  const { cache, cfg, provider } = ctx;
  const stamp = () => now().toISOString();
  const base = { source: cfg.id, intent: intent.id, item: intent.item, action: intent.action, requestedBy: intent.requestedBy };

  const cached = cache.getItem(intent.item);
  if (!cached) {
    cache.audit({ ...base, at: stamp(), outcome: 'failed', detail: 'the item is not in the cache' });
    return { intent, state: 'failed', pending: false, reason: `${intent.item} is not in the cache — sync first` };
  }
  const withBase: Intent = { ...intent, baseRevision: intent.baseRevision ?? cached.revision };
  if (!cache.getIntent(intent.id)) cache.enqueueIntent(cfg.id, withBase, stamp());

  const d = await decide(withBase, { cfg, provider, session: ctx.session, item: cached });
  if (!d.allowed) {
    cache.updateIntent(intent.id, { state: 'denied', verdicts: d.verdicts, at: stamp() });
    cache.audit({ ...base, at: stamp(), verdicts: d.verdicts, outcome: 'denied' });
    return { intent: withBase, state: 'denied', pending: false, verdicts: d.verdicts };
  }
  if (d.requiresConfirmation && !ctx.confirmed) {
    cache.updateIntent(intent.id, { state: 'queued', verdicts: d.verdicts, at: stamp() });
    cache.audit({ ...base, at: stamp(), verdicts: d.verdicts, outcome: 'confirm-pending' });
    return { intent: withBase, state: 'queued', pending: true, verdicts: d.verdicts, reason: 'waiting for a person to confirm' };
  }

  const session = await sessionOf(ctx.session);
  // freshness: the cached revision must still be the tracker's
  const [fresh] = await provider.hydrate(session, [intent.item]);
  if (!fresh) {
    cache.updateIntent(intent.id, { state: 'failed', verdicts: d.verdicts, at: stamp() });
    cache.audit({ ...base, at: stamp(), verdicts: d.verdicts, outcome: 'failed', detail: 'the tracker no longer has the item' });
    return { intent: withBase, state: 'failed', pending: false, verdicts: d.verdicts, reason: 'the tracker no longer has the item' };
  }
  if (fresh.revision !== withBase.baseRevision) {
    cache.replaceItem(cfg.id, fresh, cache.writeSync(cfg.id, stamp()));
    cache.updateIntent(intent.id, { state: 'conflict', verdicts: d.verdicts, at: stamp() });
    cache.audit({ ...base, at: stamp(), verdicts: d.verdicts, outcome: 'conflict', detail: { cached: withBase.baseRevision, tracker: fresh.revision } });
    return { intent: withBase, state: 'conflict', pending: false, verdicts: d.verdicts, item: fresh, reason: 'the item changed on the tracker since it was read' };
  }

  const sent = attributed(withBase, cfg.permissions);

  // the tracker's dry run, when it has one: a fact beside the three verdicts; a refusal stops the write
  let preview: PreviewFact | undefined;
  if (provider.preview && provider.capabilities.dryRun) {
    const p = await provider.preview(session, sent);
    preview = { ok: p.ok, reason: p.ok ? 'ok' : p.error ?? 'the tracker would refuse it' };
    if (!p.ok) {
      const state: IntentState = p.conflict ? 'conflict' : 'denied';
      cache.updateIntent(intent.id, { state, verdicts: d.verdicts, result: p, at: stamp() });
      cache.audit({ ...base, at: stamp(), verdicts: d.verdicts, preview, outcome: p.conflict ? 'conflict' : 'dry-run-refused', detail: p.error });
      return { intent: withBase, state, pending: false, verdicts: d.verdicts, preview, result: p, reason: preview.reason };
    }
  }

  cache.updateIntent(intent.id, { state: 'applying', verdicts: d.verdicts, at: stamp() });
  const result = await provider.apply(session, sent);
  if (!result.ok) {
    const state: IntentState = result.conflict ? 'conflict' : 'failed';
    cache.updateIntent(intent.id, { state, result, at: stamp() });
    cache.audit({ ...base, at: stamp(), verdicts: d.verdicts, ...(preview ? { preview } : {}), outcome: state, detail: result.error });
    return { intent: withBase, state, pending: false, verdicts: d.verdicts, result, reason: result.error, ...(preview ? { preview } : {}) };
  }

  // the full record after the write: hydrate carries comments and history, which a provider's own
  // post-write read does not (Jira re-reads fields only) — the provider's item is the fallback
  const hydrated = (await provider.hydrate(session, [intent.item]).catch(() => [] as WorkItem[]))[0];
  const after = hydrated ?? result.item;
  if (after) cache.replaceItem(cfg.id, after, cache.writeSync(cfg.id, stamp()));
  // the outbox keeps the result without the item (the cache holds that)
  const { item: _item, ...kept } = result;
  cache.updateIntent(intent.id, { state: 'confirmed', result: kept, at: stamp() });
  cache.audit({ ...base, at: stamp(), verdicts: d.verdicts, ...(preview ? { preview } : {}), outcome: 'confirmed', detail: { revision: result.revision } });
  return { intent: withBase, state: 'confirmed', pending: false, verdicts: d.verdicts, result, ...(after ? { item: after } : {}), ...(preview ? { preview } : {}) };
}

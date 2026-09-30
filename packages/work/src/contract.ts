// farsight-work v1 — the one record every work-item provider maps INTO.
// Frozen and additive-only like farsight-diff v1: every closed set below is a
// literal array, pinned by test/contract.test.ts against an explicit list AND
// against schemas/farsight-work-v1.schema.json. Prose contract:
// docs/contracts/farsight-work-v1.md. Design: docs/proposals/work-items-sync.md §3, §7.

/** The document identity of the frozen list document (`farsight work list --json`). */
export const WORK_SCHEMA = 'farsight-work v1' as const;

/** Providers v1 knows. Additive: 'github' | 'linear' | 'manifest' later; 'fixture' is the recorded CI provider. */
export const WORK_PROVIDERS = ['jira', 'azure-devops', 'fixture'] as const;
export type WorkProviderId = typeof WORK_PROVIDERS[number];

/** Type category — decided once by the provider from the tracker's own type/hierarchy, never from a name. */
export const WORK_TYPES = ['epic', 'feature', 'story', 'task', 'bug', 'other'] as const;
export type WorkType = typeof WORK_TYPES[number];

/**
 * State category — decided from the tracker's own category field, never a state name
 * (ADO *Resolved* → in-progress, name kept). Surfaces print `state.name` beside it.
 */
export const STATE_CATEGORIES = ['todo', 'in-progress', 'done', 'removed'] as const;
export type StateCategory = typeof STATE_CATEGORIES[number];

export const BODY_FORMATS = ['markdown', 'html', 'adf', 'wiki'] as const;
export type BodyFormat = typeof BODY_FORMATS[number];

export const LINK_KINDS = ['parent', 'child', 'relates', 'blocks', 'blocked-by', 'duplicates', 'other'] as const;
export type LinkKind = typeof LINK_KINDS[number];

export const ESTIMATE_UNITS = ['points', 'hours', 'days'] as const;
export type EstimateUnit = typeof ESTIMATE_UNITS[number];

/** §7.2 — the closed action set. No provider adds an eighth; one that cannot declares it and the gate denies. */
export const WORK_ACTIONS = ['comment', 'edit', 'assign', 'transition', 'link', 'label', 'create'] as const;
export type WorkAction = typeof WORK_ACTIONS[number];

/** Who asked for a write (§7.4). */
export const PRINCIPALS = ['human', 'agent'] as const;
export type Principal = typeof PRINCIPALS[number];

/** Outbox life of an intent (§5). */
export const INTENT_STATES = ['queued', 'applying', 'confirmed', 'conflict', 'denied', 'failed'] as const;
export type IntentState = typeof INTENT_STATES[number];

export interface Person {
  /** Jira accountId · ADO descriptor (fallback id). Stable; names are not. */
  id: string;
  name: string;
  /** may be absent — trackers hide it for privacy */
  email?: string;
}

export interface Body {
  format: BodyFormat;
  /** the tracker's own representation (ADF JSON, HTML string, …) */
  raw: unknown;
  /** plain-text rendering, for search and the business register */
  text: string;
}

export interface Link {
  kind: LinkKind;
  /** a WorkItem id when the target is known to Farsight, else the tracker's key/url */
  target: string;
  /** the tracker's own link-type name */
  native: string;
}

export interface Comment {
  id: string;
  author: Person;
  created: string;
  updated?: string;
  body: Body;
}

export interface Change {
  at: string;
  by?: Person;
  field: string;
  from?: string;
  to?: string;
}

export interface WorkItem {
  /** graph node id: `work::<sourceId>::<key>` */
  id: string;
  /** the Farsight source id this came from */
  source: string;
  provider: WorkProviderId;
  /** ACME-123 · 4711 — what people say */
  key: string;
  url: string;
  type: { name: string; category: WorkType };
  title: string;
  body?: Body;
  state: { name: string; category: StateCategory; since?: string };
  priority?: { name: string; rank?: number };
  assignee?: Person;
  reporter?: Person;
  /** Jira labels · ADO tags */
  labels: string[];
  /** ADO AreaPath · Jira component (first) */
  area?: string;
  iteration?: { name: string; start?: string; end?: string };
  /** parent WorkItem id */
  parent?: string;
  links: Link[];
  estimate?: { value: number; unit: EstimateUnit };
  /** ISO 8601 UTC */
  created: string;
  updated: string;
  resolved?: string;
  /** ADO `rev` · Jira `fields.updated` — what compare-before-write checks */
  revision: string;
  comments: Comment[];
  /** field changes, newest last */
  history: Change[];
  /** custom fields by canonical name (§4.3), values as read */
  fields: Record<string, unknown>;
  /** the provider's record, verbatim — never rendered in the business register */
  raw: unknown;
}

/** The graph node id of a work item. */
export function workItemId(sourceId: string, key: string): string {
  return `work::${sourceId}::${key}`;
}

/** The frozen list document: `farsight work list --json`. */
export interface WorkListDocument {
  schema: typeof WORK_SCHEMA;
  /** ISO 8601 UTC, when the document was produced */
  generatedAt: string;
  /** source ids the items came from */
  sources: string[];
  items: WorkItem[];
}

// ── writes (§7, §8) ────────────────────────────────────────────────────────

export interface Verdict {
  allowed: boolean;
  /**
   * The reason in words. Providers (and the gate) write it in the PROFESSIONAL
   * register, as one plain sentence. Consumers print it verbatim in the hybrid
   * and code lenses; the business lens prints a catalog key's words instead
   * where one exists for the case (e.g. `work.mode.readOnly`), and the verbatim
   * reason otherwise. A reason never carries a secret, a field id or a key the
   * reader did not name.
   */
  reason: string;
}

/** §7.3 — three verdicts, ANDed, every one recorded in the audit row. */
export interface Verdicts {
  policy: Verdict;
  tracker: Verdict;
  credential: Verdict;
}

/** The tracker's own answer (`provider.can()`). */
export type ProviderVerdict = Verdict;

export interface RequestedBy {
  kind: Principal;
  /** a user id for a human; the MCP session id for an agent */
  id: string;
  /** the MCP tool that asked, for an agent */
  tool?: string;
}

/**
 * Action-specific payload. Field names are canonical (§4.3), never provider field ids.
 * comment: { body }; edit: { fields }; assign: { assignee }; transition: { to, toName? };
 * link: { kind, target }; label: { add?, remove? }; create: { type, title, … }.
 */
export interface IntentPayload {
  body?: string;
  fields?: Record<string, unknown>;
  assignee?: string | null;
  to?: StateCategory;
  toName?: string;
  kind?: LinkKind;
  target?: string;
  add?: string[];
  remove?: string[];
  type?: WorkType;
  title?: string;
  [extra: string]: unknown;
}

export interface Intent {
  id: string;
  /** WorkItem id (for `create`: the parent or a placeholder id) */
  item: string;
  action: WorkAction;
  payload: IntentPayload;
  requestedBy: RequestedBy;
  /** the cached revision the request was made against — the freshness check compares it */
  baseRevision?: string;
}

export interface ApplyResult {
  ok: boolean;
  /** the item's revision after the write, when the tracker reports it */
  revision?: string;
  /** the tracker's error, verbatim in words, when !ok */
  error?: string;
  /** true when the tracker refused on concurrency (stale revision, 409, failed `test /rev`) */
  conflict?: boolean;
  /** the provider-native response, for the developer register */
  raw?: unknown;
  /** the item as the tracker holds it after the write, when the provider re-read it (saves the engine a hydrate) */
  item?: WorkItem;
}

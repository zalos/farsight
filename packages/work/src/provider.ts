// The provider plugin interface (docs/proposals/work-items-sync.md §4).
//
// A provider maps ONE tracker into farsight-work v1. It owns paging, rate
// limits, retries and version capping. It NEVER touches the cache and NEVER
// decides a permission: the engine (engine.ts) owns the cache and the cursor,
// the gate (gate.ts) owns policy. `can()` reports the tracker's own answer only.
import type {
  WorkItem, WorkType, StateCategory, WorkAction, Intent, ApplyResult, ProviderVerdict,
  LinkKind, Principal, BodyFormat,
} from './contract.js';

/** A resolved secret value. Held in memory only — never logged, thrown or written. */
export type Secret = string;

/** Opaque, provider-owned watermark (ADO continuationToken · Jira last `updated` − overlap). */
export type Cursor = string;

/** §4.4 — declared, printed, tested; never assumed. */
export interface Capabilities {
  comments: { read: boolean; write: boolean; format: 'markdown' | 'adf' | 'html' };
  /** ADO: the type's transition map · Jira: ask per issue */
  transitions: 'graph' | 'per-item';
  /** ADO: `test /rev` · Jira: re-GET `updated` before write */
  concurrency: 'revision' | 'compare-updated';
  permissionsProbe: 'per-item' | 'per-area' | 'none';
  /** deletions are visible in the incremental feed (else only by reconcile scan) */
  deletesVisible: boolean;
  /** both 'none' for a desktop tool (§6.3) */
  push: 'none' | 'webhook';
  dryRun: boolean;
  /** actions this provider can perform at all; the gate denies the rest with *this source cannot*. Absent = all of §7.2. */
  actions?: WorkAction[];
}

/** What to pull. */
export interface Scope {
  projects: string[];
  /** ADO AreaPath / Jira component */
  areas?: string[];
  /**
   * Set by the engine on every `reconcileEvery`-th sync: the WorkItem ids the cache
   * holds. A provider that cannot see deletions in its incremental feed answers with
   * the ones no longer in scope on its last page's `deleted[]`. Providers that
   * ignore it simply never report deletions that way.
   */
  reconcile?: { known: string[] };
}

export type SourceMode = 'read-only' | 'edit';

export type AuthKind =
  | 'api-token' | 'scoped-token' | 'oauth-3lo'                          // Jira
  | 'entra-device-code' | 'entra-auth-code' | 'az-cli' | 'pat'          // Azure DevOps
  | 'none';                                                             // fixture

export interface AuthConfig {
  kind: AuthKind;
  /** a secret reference (`keychain:` / `env:`) or a literal user name */
  user?: string;
  /** a secret reference — never the value */
  secret?: string;
  clientId?: string;
  tenant?: string;
}

// ── policy (§7.3 verdict 1) — the consumer's, evaluated by gate.ts ─────────

export interface GrantScope {
  projects?: string[];
  /** type categories */
  types?: WorkType[];
  areas?: string[];
  /** current state categories */
  states?: StateCategory[];
}

export interface Grant {
  actions: WorkAction[];
  principals?: Principal[];
  scope?: GrantScope;
  /** for `edit`: canonical field names it may touch */
  fields?: string[];
  /** for `transition`: target state categories */
  to?: StateCategory[];
  confirm?: 'always' | 'agent' | 'never';
}

export interface Permissions {
  default?: 'deny';
  grants?: Grant[];
  /** default 'confirm': an agent never writes without a person pressing apply */
  agentWrites?: 'confirm' | 'allow';
  attribution?: 'prefix' | 'none';
}

/** One `sources[]` entry of `.farsight/settings.json` with `type: 'work'` (§10). */
export interface SourceConfig {
  id: string;
  type: 'work';
  /** registry id: 'jira' | 'azure-devops' | 'fixture' | a third-party id */
  provider: string;
  /** Jira site URL */
  site?: string;
  /** Azure DevOps org URL */
  org?: string;
  /** fixture provider: the recorded directory (absolute, or relative to the workspace) */
  path?: string;
  scope: Scope;
  /** default 'read-only' */
  mode?: SourceMode;
  auth?: AuthConfig;
  /** poll cadence, e.g. '5m' */
  poll?: string;
  /** pinned canonical → provider field ids (*declared by you*) */
  fields?: Record<string, string>;
  permissions?: Permissions;
  enabled?: boolean;
  /** run a reconcile scan (Scope.reconcile) on every Nth sync of this source; default 10, 0 = never */
  reconcileEvery?: number;
  /** re-run discover() when the cached schema is older than this: ms, or '30m' · '12h' · '1d'; default '1d' */
  rediscoverAfter?: number | string;
}

/** A connected session. Providers may extend it with their own state. */
export interface Session {
  sourceId: string;
  provider: string;
  /** site / org / cloudId as resolved */
  endpoint?: string;
  /** the tracker user the credential acts as */
  user?: { id: string; name: string };
  /** §7.3 verdict 3: what the credential can do at all, checked at connect. Absent = unknown (read assumed, write denied). */
  credentialScope?: { read: boolean; write: boolean; detail?: string };
  /** API version actually in use after probing */
  apiVersion?: string;
  /**
   * The discover() result the engine holds for this source, set after connect when
   * it is still fresh — a provider may use it instead of discovering again. The
   * engine sets it to the new result whenever it does call discover().
   */
  schema?: Schema;
  [extra: string]: unknown;
}

/** What the engine knows when it connects (optional third argument of connect). */
export interface ConnectContext {
  /** the cached discover() result, when the engine has one and it is fresh */
  schema?: Schema;
  schemaAt?: string;
}

// ── discovery (§4.3) ───────────────────────────────────────────────────────

export interface SchemaState {
  name: string;
  category: StateCategory;
}

export interface SchemaType {
  name: string;
  category: WorkType;
  states?: SchemaState[];
  /** ADO transition map: state name → reachable state names */
  transitions?: Record<string, string[]>;
}

export interface SchemaField {
  /** provider field id (customfield_10016 · Microsoft.VSTS.Scheduling.StoryPoints) */
  id: string;
  name: string;
  /** canonical name when mapped (estimate · iteration · …) */
  canonical?: string;
  /** 'found' on the site, or 'declared' by the consumer's settings pin */
  origin?: 'found' | 'declared';
}

export interface SchemaLinkType {
  native: string;
  kind: LinkKind;
}

export interface Schema {
  projects: { key: string; name: string; id?: string }[];
  types: SchemaType[];
  /** all states with category (across types) */
  states: SchemaState[];
  fields: SchemaField[];
  linkTypes: SchemaLinkType[];
  bodyFormat?: BodyFormat;
}

/** One page of `pull()`. */
export interface PullPage {
  items: WorkItem[];
  /** the watermark after this page; the engine stores it only once isLast */
  cursor: Cursor | null;
  isLast: boolean;
  /** WorkItem ids the tracker says are gone */
  deleted?: string[];
}

export interface WorkProvider {
  id: string;
  capabilities: Capabilities;
  /** resolves site/org, probes version, checks the credential (fills `credentialScope`) */
  connect(cfg: SourceConfig, secret: Secret | undefined, ctx?: ConnectContext): Promise<Session>;
  discover(s: Session): Promise<Schema>;
  /** full when cursor is null; incremental after */
  pull(s: Session, cursor: Cursor | null, scope: Scope): AsyncIterable<PullPage>;
  /** full records (comments + history) for these WorkItem ids */
  hydrate(s: Session, ids: string[]): Promise<WorkItem[]>;
  /** the tracker's own answer — never the consumer's policy */
  can(s: Session, item: WorkItem, action: WorkAction): Promise<ProviderVerdict>;
  /** one write, provider-native concurrency */
  apply(s: Session, intent: Intent): Promise<ApplyResult>;
  /**
   * Optional dry run of one write (ADO validateOnly=true): what the tracker would say,
   * nothing saved. Present only when `capabilities.dryRun` is true. The gate calls it
   * before apply() and records the answer beside the three verdicts — it is not a fourth
   * verdict. `ok: false` stops the write.
   */
  preview?(s: Session, intent: Intent): Promise<ApplyResult>;
}

// Trusted policy (PR 06): the owner's settings, the repository's requests, the effective policy that results, the
// owner's adoption of a settings file, the human receipt that confirms one exact action, and the admission record
// with its three ANDed verdicts. The repository requests; only adopted settings grant.
import type {
  BoundedText,
  CatalogKey,
  Count,
  DecimalAmount,
  Digest,
  Id,
  ScopeId,
  ShortText,
  Timestamp,
} from './common.js';
import type { DecisionChannel } from './disposition.js';
import type { RuleCapability, RuleFamilyId, Severity } from './rules.js';
import type { ReviewModelsSettings } from './review-providers.js';

/** Every action the Sentinel gate decides. */
export type SentinelAction =
  | 'run.start'
  | 'capture.source'
  | 'disposition.propose'
  | 'disposition.approve'
  | 'rule.promote'
  | 'tool.acquire'
  | 'paid.admit'
  | 'disclosure.send'
  | 'settings.adopt'
  | 'evidence.import'
  | 'evidence.abandon'
  /** Stop starting new work in a run; work in flight may finish. A write: decided like any other action. */
  | 'run.pause'
  /** Stop a run's workers; the ledger then refuses its publications. */
  | 'run.cancel'
  | 'context.pin';

/** What an admitted action may do beyond reading captured artifacts. */
export type ActionEffect = 'local-artifacts' | 'source-disclosure' | 'paid-inference' | 'network' | 'tool-execution';

/** Who asks. A claimed name grants nothing; the channel the request arrived on is what is recorded. */
export type Principal = 'human' | 'agent';

/**
 * An ISO 4217 currency code.
 * @pattern ^[A-Z]{3}$
 */
export type CurrencyCode = string;

/** A spending bound. A paid action needs both a token and a cost bound. */
export interface Budget {
  maxTokens: Count | null;
  maxCost: DecimalAmount | null;
  currency: CurrencyCode | null;
}

/**
 * An OS-keychain reference. Settings hold references only, never secret values or environment names.
 * @pattern ^keychain:farsight/[a-z0-9][a-z0-9-]{0,62}$
 */
export type KeychainRef = string;

/**
 * A provider endpoint origin: scheme, host and optional port, no path, query or credentials.
 * @pattern ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$
 * @maxLength 300
 */
export type EndpointOrigin = string;

/** A grant over Sentinel actions, read by core's shared matcher (`decideGrants`). */
export interface SentinelGrant {
  /**
   * @minItems 1
   * @maxItems 11
   */
  actions: SentinelAction[];
  /** @maxItems 2 */
  principals?: Principal[];
  confirm?: 'always' | 'agent' | 'never';
  /** Narrows the grant: profiles and providers it covers, effects it permits. Absent means not narrowed. */
  scope?: {
    /** @maxItems 32 */
    profiles?: Id[];
    /** @maxItems 32 */
    providers?: Id[];
    /** @maxItems 5 */
    effects?: ActionEffect[];
  };
}

export interface ProviderSettings {
  id: Id;
  kind: 'ollama' | 'openai-compatible' | 'claude-cli' | 'copilot-cli';
  endpoint: EndpointOrigin;
  credential: KeychainRef | null;
  /** `local-only` keeps source on this machine; `hosted` sends permitted context off it. */
  disclosure: 'local-only' | 'hosted';
  /** Explicit owner adoption of the closed native profile; configuration alone is not runtime qualification. */
  nativeProfile?: { id: Id; executableDigest: Digest; helperDigest: Digest; profileDigest: Digest };
  /** Exact external Copilot code closure, not an authentication or inference attestation. */
  copilotProfile?: { id: Id; executableDigest: Digest; runtimeDigest: Digest; profileDigest: Digest };
  /** The most one admitted action may reserve. */
  budget: Budget;
  /**
   * The models the owner configured for this provider (PR 21). A model is usable only from adopted settings; a caller
   * or repository cannot supply one.
   * @maxItems 16
   */
  models?: ModelSettings[];
}

/**
 * A model name as the provider spells it.
 * @pattern ^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$
 */
export type ModelName = string;

/**
 * A calendar date, `YYYY-MM-DD`.
 * @pattern ^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$
 */
export type CalendarDate = string;

/**
 * @asType integer
 * @minimum 1
 * @maximum 4194304
 */
export type ModelBytes = number;
/**
 * @asType integer
 * @minimum 1
 * @maximum 600000
 */
export type ModelTimeoutMs = number;
/**
 * @asType integer
 * @minimum 1
 * @maximum 131072
 */
export type ModelOutputTokens = number;
/**
 * @asType integer
 * @minimum 1
 * @maximum 2000000
 */
export type ModelContextTokens = number;
/**
 * @asType integer
 * @minimum 1
 * @maximum 256
 */
export type ModelMessages = number;
/**
 * @asType integer
 * @minimum 0
 * @maximum 1024
 */
export type ModelTemplateTokens = number;

/** Hard limits on one model call. */
export interface ModelLimits {
  maxRequestBytes: ModelBytes;
  maxResponseBytes: ModelBytes;
  timeoutMs: ModelTimeoutMs;
  maxOutputTokens: ModelOutputTokens;
  /** Worst-case input plus output must fit, so a provider never cuts input silently. */
  contextTokens: ModelContextTokens;
  maxMessages: ModelMessages;
  /** Tokens a chat template may add per message beyond the bytes sent; part of the worst-case bound. */
  templateTokensPerMessage: ModelTemplateTokens;
}

/**
 * How a model's spend is priced. There is no unpriced form: an unpriced call cannot be bounded.
 * @discriminator kind
 */
export type ModelPricing =
  | {
      kind: 'rates';
      currency: CurrencyCode;
      inputPerMillion: DecimalAmount;
      outputPerMillion: DecimalAmount;
      /** Where the owner read the rate schedule. */
      source: ShortText;
      asOf: CalendarDate;
    }
  /** A local runtime: no provider fee. Compute is not claimed free; tokens are still reserved. */
  | { kind: 'no-fee'; basis: 'local-runtime' }
  /** Owner-bounded subscription tokens. Monetary consumption is unobserved, never zero. */
  | { kind: 'subscription-quota'; basis: 'owner-subscription' };

/** A hosted provider's terms as the owner recorded them: endpoint-specific facts, never a protocol promise. */
export interface ProviderTerms {
  retention: ShortText;
  training: 'not-used' | 'used' | 'unknown';
  source: ShortText;
  recordedAt: CalendarDate;
}

/** What a probe of one origin found for one model. The owner adopts it with the settings; it is never assumed. */
export interface ModelCapability {
  schema: 'sentinel-model-capability/draft-1';
  kind: 'ollama' | 'openai-compatible' | 'claude-cli' | 'copilot-cli';
  origin: EndpointOrigin;
  model: ModelName;
  listed: true;
  /** An immutable revision the provider listed (Ollama's weight digest), else null. */
  revision: Digest | null;
  probedAt: Timestamp;
}

/** One configured model of a provider. */
export interface ModelSettings {
  id: Id;
  model: ModelName;
  limits: ModelLimits;
  pricing: ModelPricing;
  /** Required when the provider's disclosure is `hosted`. */
  terms: ProviderTerms | null;
  /** null until the owner probes and adopts it: an untested model cannot be bound. */
  capability: ModelCapability | null;
}

export interface PolicyThresholds {
  /** Findings at or above this severity fail the policy. Lower is stricter. */
  failOnSeverity: Severity;
  /** Required checks that do not complete fail the policy with exit 2. */
  requireCompleteCoverage: boolean;
  /** @maxItems 10 */
  requiredCapabilities: RuleCapability[];
}

/**
 * sentinel-settings/draft-1 — `.farsight/sentinel/settings.json`. Its place in a checkout does not make it trusted:
 * only an owner adoption of these exact bytes for this workspace does.
 */
export interface SettingsEnvelope {
  schema: 'sentinel-settings/draft-1';
  /** @maxItems 1024 */
  mandatoryRules: RuleFamilyId[];
  thresholds: PolicyThresholds;
  /** @maxItems 64 */
  grants: SentinelGrant[];
  /** `confirm` (the default for untrusted settings): an agent's allowed action still waits for a person. */
  agentActions: 'confirm' | 'allow';
  /** @maxItems 16 */
  providers: ProviderSettings[];
  /** Optional owner-adopted agentic model choices. Absent keeps legacy settings bytes unchanged. */
  reviewModels?: ReviewModelsSettings;
  /** Hosted API review is paused when absent or false; explicit adoption is required to enable public dispatch. */
  hostedApiReviewEnabled?: boolean;
  /** Hosted disclosure requires complete secret scanning by default; when-selected still requires it whenever the secret rule is selected. */
  hostedReviewSecretScan?: 'required' | 'when-selected';
  /** Native Claude execution is deferred when absent or false; enabling does not establish runtime qualification. */
  nativeClaudeReviewEnabled?: boolean;
}

/** A repository's request to suppress a finding. Recorded and refused: approval is an owner disposition. */
export interface SuppressionRequest {
  familyId: RuleFamilyId;
  scopeId: ScopeId;
  rationale: BoundedText;
}

/**
 * sentinel-repoconfig/draft-1 — version-controlled scan intent. It requests; it cannot grant, weaken or approve.
 */
export interface RepoConfigEnvelope {
  schema: 'sentinel-repoconfig/draft-1';
  /** @maxItems 1024 */
  requestedRules: RuleFamilyId[];
  /**
   * Requests to remove rules. Never honoured for a mandatory rule; listed so the refusal is visible.
   * @maxItems 1024
   */
  disabledRules: RuleFamilyId[];
  thresholds: Partial<PolicyThresholds>;
  /** @maxItems 1024 */
  suppressions: SuppressionRequest[];
  /**
   * Providers the repository asks to use; only those the adopted settings define are usable.
   * @maxItems 16
   */
  providers: Id[];
}

/** How far the settings file is trusted. Anything but `adopted` falls back to the built-in defaults. */
export type SettingsTrust = 'adopted' | 'not-adopted' | 'changed' | 'missing' | 'invalid';

/** What the repository asked for that the effective policy did not grant, and why. */
export interface RefusedRequest {
  request: 'disable-rule' | 'weaken-threshold' | 'suppression' | 'provider';
  /** @maxLength 200 */
  subject: string;
  reasonCode: CatalogKey;
}

/**
 * sentinel-policy/draft-1 — the redacted effective policy. The only policy view served: no endpoint, keychain
 * reference or raw settings byte appears in it.
 */
export interface EffectivePolicyEnvelope {
  schema: 'sentinel-policy/draft-1';
  settingsTrust: SettingsTrust;
  settingsDigest: Digest | null;
  /** Absent means required; the explicit adopted choice never claims secret coverage. */
  hostedReviewSecretScan?: 'required' | 'when-selected';
  repoConfigDigest: Digest | null;
  /** @maxItems 2048 */
  rules: { familyId: RuleFamilyId; source: 'mandatory' | 'requested' | 'both' }[];
  thresholds: PolicyThresholds;
  agentActions: 'confirm' | 'allow';
  /** @maxItems 64 */
  grants: {
    actions: SentinelAction[];
    principals: Principal[];
    confirm: 'always' | 'agent' | 'never' | 'default';
    scoped: boolean;
  }[];
  /** @maxItems 16 */
  providers: {
    id: Id;
    kind: 'ollama' | 'openai-compatible' | 'claude-cli' | 'copilot-cli';
    disclosure: 'local-only' | 'hosted';
    credential: 'keychain' | 'none';
  }[];
  /** @maxItems 4096 */
  refused: RefusedRequest[];
}

/**
 * sentinel-adoption/draft-1 — the owner's adoption of one settings file for one workspace, kept in user state
 * outside the checkout. Any changed byte, another workspace or a re-created folder has no authority.
 */
export interface AdoptionEnvelope {
  schema: 'sentinel-adoption/draft-1';
  workspaceIdentity: Digest;
  /**
   * The canonical workspace path, recorded for the owner to read; the identity is what is compared.
   * @maxLength 4096
   */
  workspacePath: string;
  settingsDigest: Digest;
  receipt: Digest;
  adoptedAt: Timestamp;
}

/** The exact action a receipt or an admission is about. Its canonical digest is what they bind to. */
export interface ActionIntent {
  action: SentinelAction;
  /** Digest of the action's exact input (a candidate pack, a settings file, a plan revision, a context packet). */
  input: Digest;
  /** @maxItems 5 */
  effects: ActionEffect[];
  budget: Budget;
  scope: {
    profile: Id | null;
    provider: Id | null;
    /** @maxItems 256 */
    targets: ScopeId[];
  };
}

/**
 * sentinel-receipt/draft-1 — a human owner's confirmation of one exact intent: one use, short-lived, bound to the
 * state and policy it was given against. Only the owner's local CLI flow issues one; no product agent can.
 */
export interface ReceiptEnvelope {
  schema: 'sentinel-receipt/draft-1';
  id: Id;
  actor: { channel: 'owner-cli'; principal: ShortText };
  action: SentinelAction;
  intentDigest: Digest;
  stateDigest: Digest;
  policyRevision: Digest;
  issuedAt: Timestamp;
  expiresAt: Timestamp;
}

/** One verdict as recorded. `asked: false` when an earlier verdict already denied, so nothing was contacted. */
export interface AdmissionVerdict {
  allowed: boolean;
  asked: boolean;
  reasonCode: CatalogKey;
  detail: BoundedText;
}

/** The credential verdict says how authority was established, including when none was needed. */
export interface CredentialVerdict extends AdmissionVerdict {
  basis: 'local-only' | 'keychain-scope' | 'unknown' | 'not-asked';
}

/** Whether an action was admitted, denied, or waits for the owner. */
export type AdmissionOutcome = 'admitted' | 'denied' | 'awaiting-confirmation';

/**
 * sentinel-admission/draft-1 — the three ANDed verdicts for one intent: policy, capability, credential authority.
 */
export interface AdmissionEnvelope {
  schema: 'sentinel-admission/draft-1';
  action: SentinelAction;
  intentDigest: Digest;
  requestedBy: { principal: Principal; channel: DecisionChannel };
  policyRevision: Digest;
  verdicts: { policy: AdmissionVerdict; capability: AdmissionVerdict; credential: CredentialVerdict };
  outcome: AdmissionOutcome;
  receipt: Digest | null;
  decidedAt: Timestamp;
}

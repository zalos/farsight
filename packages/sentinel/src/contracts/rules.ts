// Rule packs and the rule lock (PR 06). A pack is data: rule definitions, the detector files a registered adapter
// reads, fixtures and its rights. Nothing in a pack is executed by the coordinator; applicability is declarative.
// A lock is an immutable, content-addressed record of exactly which pack revisions, tools and databases a plan
// may use. Promotion writes a new lock; a plan pins a lock digest, so a later promotion never changes it.
import type { CatalogKey, Count, Digest, Id, Ordinal, RelativePath, ShortText, Timestamp } from './common.js';
import type { CweId } from './observation.js';

/** Languages a rule can apply to in the first release. */
export type RuleLanguage = 'typescript' | 'javascript' | 'java';

/** What one check of the rule is about: one file, one surface (route/handler), a manifest, CI config, or the whole repository. */
export type RuleScopeKind = 'source-file' | 'surface' | 'dependency-manifest' | 'ci-config' | 'repository';

/**
 * A property a stage must establish before the rule can be checked. A profile that lacks one leaves the check
 * unsupported; nothing weaker runs under the rule's identity.
 */
export type RuleCapability =
  | 'source-bytes' | 'pattern-match' | 'source-span' | 'call-occurrence' | 'resolved-receiver-type'
  | 'framework-order' | 'interprocedural-flow' | 'runtime-observation' | 'dependency-manifest' | 'advisory-database';

/** What a result means: a candidate location to review, or a finding the rule's evidence establishes. */
export type RuleMeaning = 'candidate' | 'finding';

/** The severity a rule assigns. Ordered: info < low < medium < high < critical. */
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** Evidence a result of the rule must carry. */
export type RuleEvidence = 'source-span' | 'matched-pattern' | 'control-fact' | 'dependency-version' | 'advisory-id';

/** Frameworks with planned control-fact packs (PRs 14–17). */
export type FrameworkId = 'next' | 'express' | 'nest' | 'spring';

/** Where a pack's content came from. */
export type RuleOrigin = 'sentinel-original' | 'third-party';

/**
 * A stable rule family: `sentinel.<area>.<name>` for original rules, `<vendor>.<area>.<name>` otherwise.
 * @pattern ^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){2,7}$
 * @maxLength 128
 */
export type RuleFamilyId = string;

/** Bounded declarative applicability. There is no code here, and a pack cannot supply an evaluator. */
export interface RuleApplicability {
  /**
   * @minItems 1
   * @maxItems 3
   */
  languages: RuleLanguage[];
  scopeKind: RuleScopeKind;
  /**
   * When present, the rule applies only where one of these frameworks resolved; unresolved stays unknown.
   * @maxItems 4
   */
  frameworks?: FrameworkId[];
}

export interface RuleDefinition {
  familyId: RuleFamilyId;
  revision: Ordinal;
  titleKey: CatalogKey;
  applicability: RuleApplicability;
  /**
   * @minItems 1
   * @maxItems 16
   */
  requires: RuleCapability[];
  /** The registered adapter that reads `rulePath`. The file is data for that adapter, never a script. */
  implementation: { adapterId: Id; rulePath: RelativePath };
  meaning: RuleMeaning;
  severity: Severity;
  /**
   * @minItems 1
   * @maxItems 8
   */
  evidenceRequired: RuleEvidence[];
  /** @maxItems 16 */
  limitationKeys: CatalogKey[];
  /** Versioned mappings. A mapping is never evidence that the check ran. */
  mappings: {
    /** @maxItems 16 */
    cwe: CweId[];
  };
  fixtures: {
    /**
     * @minItems 1
     * @maxItems 64
     */
    positive: RelativePath[];
    /**
     * @minItems 1
     * @maxItems 64
     */
    negative: RelativePath[];
  };
}

/** Rights recorded for a pack, a tool or a database. Third-party content names where it came from. */
export interface Rights {
  /** An SPDX license expression as published by the origin. */
  spdx: ShortText;
  origin: RuleOrigin;
  /** Third-party only: the upstream name and revision it was taken from. */
  upstream?: { name: ShortText; revision: ShortText };
  /** A license file inside the pack, when the license requires one to travel with it. */
  licenseFile?: RelativePath;
}

/**
 * sentinel-rulepack/draft-1 — `sentinel-pack.json` at a pack's root.
 */
export interface RulePackManifest {
  schema: 'sentinel-rulepack/draft-1';
  packId: Id;
  version: ShortText;
  rights: Rights;
  /**
   * @minItems 1
   * @maxItems 1024
   */
  rules: RuleDefinition[];
}

/** One file of a pack, by its bytes. */
export interface PackFile {
  path: RelativePath;
  digest: Digest;
  size: Count;
}

/** A rule as locked: its family, revision and the digest over its definition and every file it names. */
export interface LockedRule {
  familyId: RuleFamilyId;
  revision: Ordinal;
  definitionDigest: Digest;
}

export interface LockedPack {
  packId: Id;
  version: ShortText;
  /** Digest of the sorted file inventory: any changed, added or removed file changes it. */
  packDigest: Digest;
  rights: Rights;
  /**
   * @minItems 1
   * @maxItems 4096
   */
  files: PackFile[];
  /**
   * @minItems 1
   * @maxItems 1024
   */
  rules: LockedRule[];
  promotion: { receipt: Digest; at: Timestamp };
}

/** An installed scanner, pinned by digest. A lock entry never authorizes downloading or running it. */
export interface LockedTool {
  adapterId: Id;
  version: ShortText;
  artifactDigest: Digest;
  platform: ShortText;
  rights: Rights;
  promotion: { receipt: Digest; at: Timestamp };
}

/** An advisory or other database snapshot, pinned by digest. */
export interface LockedDatabase {
  databaseId: Id;
  snapshotDigest: Digest;
  capturedAt: Timestamp;
  rights: Rights;
  promotion: { receipt: Digest; at: Timestamp };
}

/**
 * sentinel-rulelock/draft-1 — the exact packs, tools and databases a plan may use. Immutable: promotion writes a
 * new revision that names its predecessor's digest.
 */
export interface RuleLockEnvelope {
  schema: 'sentinel-rulelock/draft-1';
  revision: Ordinal;
  previous: Digest | null;
  /** @maxItems 256 */
  packs: LockedPack[];
  /** @maxItems 256 */
  tools: LockedTool[];
  /** @maxItems 256 */
  databases: LockedDatabase[];
  createdAt: Timestamp;
}

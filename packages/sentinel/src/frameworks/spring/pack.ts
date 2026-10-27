// The Spring Security servlet pack (PR 17): control facts for one captured source, for exactly Spring Boot 3.4.3 with
// Spring Security 6.4.3. Surfaces are the public parser's canonical route nodes; each route's mapping, and every chain,
// matcher, rule and method-security annotation, is read again from the captured Java syntax, so no graph tag or
// heuristic is evidence. The first chain whose matcher matches is the one Spring runs, and within it the first
// matching rule decides; anything this subset cannot resolve is unknown with its reason, and a route no chain
// matches is never reported as protected.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@farsight/graph';
import type { AnalysisArtifact } from '@farsight/code-parser';
import type {
  ArtifactId,
  ControlFact,
  ControlFactsEnvelope,
  ControlProperty,
  ControlVerdict,
  ScopedReason,
  SnapshotEnvelope,
  SourceEvidence,
} from '../../contracts/index.js';
import { validateEnvelope } from '../../validate.js';
import {
  readConfiguration,
  type Activity,
  type Anonymous,
  type At,
  type Chain,
  type MethodSecurityEnablement,
  type Rule,
  type RuleAction,
  type SpringConfiguration,
  type SpringReason,
} from './config.js';
import { matchTemplate, type MatchResult } from './patterns.js';
import { SPRING_SUPPORT } from './support.js';
import { pomScope } from './pom.js';
import {
  annotationsOf,
  modifierWords,
  named,
  stringValues,
  walk,
  parseJava,
  literalString,
  type JavaFile,
  type JavaNode,
} from './syntax.js';

/** The exact versions this pack models. Any other version leaves every fact unknown. */
export const SPRING_PACK = Object.freeze({
  id: 'sentinel.framework.spring-servlet',
  implementation: 'sentinel-spring-servlet/draft-1',
  boot: '3.4.3',
  security: '6.4.3',
  version: 'boot-3.4.3+security-6.4.3',
  stack: 'servlet',
});

/** Positions of the controls the pack reports for a route, in Spring's evaluation order. */
export const SPRING_ORDER = Object.freeze({ filters: 0, chain: 1, interceptors: 2, methodSecurity: 3 });

export interface SpringPackInput {
  readonly snapshot: Pick<SnapshotEnvelope, 'id' | 'entries'>;
  readonly sourceId: string;
  /** The PR 05 parser evidence for this source: its portable artifact and its index of captured spans. */
  readonly analysis: {
    readonly artifact: AnalysisArtifact;
    readonly index: {
      readonly nodes: readonly {
        readonly nodeId: string;
        readonly path: string;
        readonly content: ArtifactId;
        readonly line: number;
        readonly byteSpan?: { readonly startByte: number; readonly endByte: number };
      }[];
    };
  };
  /** Reads a captured file's bytes by content id (the store's `readArtifact`). */
  readonly readContent: (id: ArtifactId) => Promise<Uint8Array>;
  /** The selected environment. `activeProfiles: null` means none was selected, so profile-conditioned chains are unknown. */
  readonly environment: { readonly activeProfiles: readonly string[] | null };
  readonly limits?: { readonly maxJavaFiles?: number; readonly maxJavaBytes?: number };
}

const DEFAULT_LIMITS = { maxJavaFiles: 5_000, maxJavaBytes: 64 * 1024 * 1024 };
const SAFE_BOUNDARIES = new Set([
  'sentinel.capture.excludedGitInternals',
  'sentinel.capture.excludedStore',
  'sentinel.capture.excludedDependencyCache',
]);
const digestOf = (v: unknown) => `sha256:${createHash('sha256').update(canonicalJson(v)).digest('hex')}`;
const MAX_EVIDENCE = 64;

// ---- version scope, read from the captured build file ----

type Version =
  { ok: true; evidence: SourceEvidence[] } | { ok: false; reason: SpringReason; evidence: SourceEvidence[] };

function resolveVersion(
  input: SpringPackInput,
  pom: { raw: Buffer; content: ArtifactId } | undefined,
  gradle: boolean,
): Version {
  if (gradle || !pom) return { ok: false, reason: 'sentinel.spring.versionUnresolved', evidence: [] };
  const text = pom.raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(pom.raw))
    return { ok: false, reason: 'sentinel.spring.sourceNotUtf8', evidence: [] };
  // Structure, not text order: the POM is read as XML elements, so child order and comments cannot mislead it.
  const verdict = pomScope(text, SPRING_PACK.boot);
  const evidence = verdict.evidence.map((el): SourceEvidence => ({
    snapshotId: input.snapshot.id,
    sourceId: input.sourceId,
    relativePath: 'pom.xml',
    content: pom.content,
    span: { startByte: Buffer.byteLength(text.slice(0, el.start)), endByte: Buffer.byteLength(text.slice(0, el.end)) },
  }));
  return verdict.ok ? { ok: true, evidence } : { ok: false, reason: verdict.reason, evidence };
}

// ---- route mappings, from syntax ----

const MAPPING_VERBS: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};
interface Mapping {
  readonly methods: readonly string[] | null;
  readonly paths: readonly string[];
  readonly at: At[];
}

/** Joins a class base path and a method path without trimming a trailing slash (it is significant; see patterns.ts). */
const join = (base: string, path: string) => {
  const parts = [base, path].filter((p) => p !== '');
  return parts.length ? `/${parts.join('/')}`.replace(/\/+/g, '/') : '/';
};

function mappingOf(file: JavaFile, method: JavaNode): Mapping | undefined {
  const anns = annotationsOf(method);
  const cls = (() => {
    let p = method.parent;
    while (p && p.type !== 'class_declaration') p = p.parent;
    return p;
  })();
  const classAnns = cls ? annotationsOf(cls) : [];
  const valuesOf = (a: { positional: readonly JavaNode[]; pairs: ReadonlyMap<string, JavaNode> }) => {
    const v = a.positional[0] ?? a.pairs.get('value') ?? a.pairs.get('path');
    return v ? stringValues(v) : [''];
  };
  const mappingAnns = anns.filter((a) => MAPPING_VERBS[a.name] || a.name === 'RequestMapping');
  if (mappingAnns.length !== 1) return undefined;
  const ma = mappingAnns[0]!;
  const paths = valuesOf(ma);
  let methods: string[] | null;
  if (MAPPING_VERBS[ma.name]) methods = [MAPPING_VERBS[ma.name]!];
  else {
    const m = ma.pairs.get('method');
    if (!m) methods = null;
    else {
      const items = m.type === 'element_value_array_initializer' ? named(m) : [m];
      const verbs = items.map((i) => /^RequestMethod\.([A-Z]+)$/.exec(i.text.replace(/\s+/g, ''))?.[1]);
      if (verbs.some((v) => !v)) return undefined;
      methods = verbs as string[];
    }
  }
  const base = classAnns.find((a) => a.name === 'RequestMapping');
  if (base && base.pairs.has('method')) return undefined;
  const bases = base ? valuesOf(base) : [''];
  if (!paths || !bases) return undefined;
  const all = bases.flatMap((b) => (paths.length ? paths : ['']).map((p) => join(b, p)));
  const at: At[] = [{ file, node: ma.node }, ...(base ? [{ file, node: base.node }] : [])];
  return { methods, paths: all, at };
}

// ---- profiles ----

function active(activity: Activity, profiles: readonly string[] | null): boolean | 'unknown' {
  if (activity.kind === 'always') return true;
  if (activity.kind === 'unsupported') return 'unknown';
  if (profiles === null) return 'unknown';
  const on = profiles.length ? new Set(profiles) : new Set(['default']);
  return activity.conditions.every((c) => c.names.some((n) => (n.startsWith('!') ? !on.has(n.slice(1)) : on.has(n))));
}

// ---- evaluation ----

type Outcome =
  | { kind: 'resolved'; action: RuleAction | 'none'; chain: Chain; rule?: Rule; at: At[] }
  | { kind: 'unknown'; reason: SpringReason; at: At[] };

function combineMatches(results: MatchResult[]): MatchResult {
  if (results.includes('match')) return 'match';
  return results.every((r) => r === 'no-match') ? 'no-match' : 'unknown';
}

function chainMatches(chain: Chain, method: string | null, path: string): MatchResult {
  if (chain.matcher.kind === 'any') return 'match';
  if (chain.matcher.kind === 'unsupported') return 'unknown';
  void method;
  return combineMatches(chain.matcher.patterns.map((p) => matchTemplate(path, p)));
}

function ruleMatches(rule: Rule, method: string | null, path: string): MatchResult {
  const m = rule.matcher;
  if (m.kind === 'any') return 'match';
  if (m.kind === 'unsupported') return 'unknown';
  if (m.method !== null) {
    if (method === null) return 'unknown';
    if (method !== m.method) return 'no-match';
  }
  return combineMatches(m.patterns.map((p) => matchTemplate(path, p)));
}

/** Which chain Spring runs for one (method, path), and what its first matching rule decides. */
function evaluate(
  cfg: SpringConfiguration,
  profiles: readonly string[] | null,
  method: string | null,
  path: string,
): Outcome {
  const LOWEST = 2 ** 31 - 1;
  const chains = [...cfg.chains].sort((a, b) => (a.order ?? LOWEST) - (b.order ?? LOWEST));
  const explain: At[] = [];
  for (let i = 0; i < chains.length; i++) {
    const c = chains[i]!;
    if (c.unsupported) return { kind: 'unknown', reason: c.unsupported.reason, at: [c.unsupported.at] };
    const on = active(c.activity, profiles);
    const match = chainMatches(c, method, path);
    if (c.matcher.kind === 'paths') explain.push(c.matcher.at);
    else explain.push(c.at);
    if (on === false || match === 'no-match') continue;
    if (on === 'unknown') {
      const at =
        c.activity.kind === 'profiles'
          ? c.activity.conditions.map((x) => x.at)
          : c.activity.kind === 'unsupported'
            ? [c.activity.at]
            : [];
      return {
        kind: 'unknown',
        reason: c.activity.kind === 'unsupported' ? c.activity.reason : 'sentinel.spring.profileUnselected',
        at,
      };
    }
    if (match === 'unknown')
      return {
        kind: 'unknown',
        reason: 'sentinel.spring.chainMatcherUnsupported',
        at: [c.matcher.kind === 'paths' ? c.matcher.at : c.at],
      };
    // Two chains at the same precedence: which one Spring tries first is not determined by source here.
    const tie = chains.some(
      (o, j) =>
        j !== i &&
        (o.order ?? LOWEST) === (c.order ?? LOWEST) &&
        active(o.activity, profiles) !== false &&
        chainMatches(o, method, path) !== 'no-match',
    );
    if (tie) return { kind: 'unknown', reason: 'sentinel.spring.chainOrderAmbiguous', at: [c.at] };
    const chainAt = [
      c.at,
      ...(c.orderAt ? [c.orderAt] : []),
      ...(c.matcher.kind === 'paths' ? [c.matcher.at] : []),
      ...(c.activity.kind === 'profiles' ? c.activity.conditions.map((x) => x.at) : []),
    ];
    if (c.rules === null) return { kind: 'resolved', action: 'none', chain: c, at: chainAt };
    if (!Array.isArray(c.rules))
      return {
        kind: 'unknown',
        reason: 'sentinel.spring.rulesUnsupported',
        at: [(c.rules as { unsupported: At }).unsupported],
      };
    for (const r of c.rules as readonly Rule[]) {
      const rm = ruleMatches(r, method, path);
      if (rm === 'no-match') continue;
      if (rm === 'unknown')
        return { kind: 'unknown', reason: 'sentinel.spring.ruleMatcherUnsupported', at: [r.matcher.at] };
      if (r.action === 'unsupported')
        return { kind: 'unknown', reason: 'sentinel.spring.ruleActionUnsupported', at: [r.at] };
      return { kind: 'resolved', action: r.action, chain: c, rule: r, at: [...chainAt, r.matcher.at, r.at] };
    }
    return {
      kind: 'unknown',
      reason: 'sentinel.spring.noRuleMatches',
      at: [...chainAt, ...(c.rulesAt ? [c.rulesAt] : [])],
    };
  }
  // No chain's matcher reaches this request. Source alone cannot exclude a chain a dependency contributes, so this
  // is never "does not apply": it is unknown, explained by every chain matcher that was checked.
  return { kind: 'unknown', reason: 'sentinel.spring.noChainMatches', at: explain };
}

type Verdicts = {
  readonly verdicts: Record<'authentication' | 'authorization', ControlVerdict>;
  readonly reason?: SpringReason;
};

/**
 * What a decision means for each property. A role or authority check restricts who may proceed (authorization); it
 * requires an authenticated principal only when the anonymous principal Spring gives unauthenticated requests cannot
 * hold any authority it admits. By default that principal holds `ROLE_ANONYMOUS`; a disabled anonymous filter gives
 * none; a customised one gives authorities this pack does not follow.
 */
function verdictsFor(
  action: RuleAction | 'none',
  grant: { authorities?: readonly string[]; usesRolePrefix?: boolean },
  anonymous: Anonymous | 'unknown',
  cfg: SpringConfiguration,
): Verdicts {
  switch (action) {
    case 'permitAll':
    case 'none':
      return { verdicts: { authentication: 'does-not-apply', authorization: 'does-not-apply' } };
    // authenticated() excludes the anonymous principal whatever its authorities.
    case 'authenticated':
      return { verdicts: { authentication: 'applies', authorization: 'does-not-apply' } };
    case 'denyAll':
      return { verdicts: { authentication: 'applies', authorization: 'applies' } };
    case 'unsupported':
      return {
        verdicts: { authentication: 'unknown', authorization: 'unknown' },
        reason: 'sentinel.spring.ruleActionUnsupported',
      };
    case 'restricted': {
      if (grant.usesRolePrefix && cfg.rolePrefixCustomized.length) {
        return {
          verdicts: { authentication: 'unknown', authorization: 'unknown' },
          reason: 'sentinel.spring.rolePrefixCustomized',
        };
      }
      const admitsAnonymous = (grant.authorities ?? []).includes('ROLE_ANONYMOUS');
      // A chain the pack could not read may customise the anonymous principal too.
      const anyCustom = cfg.chains.some((c) => c.anonymous === 'custom');
      let authentication: ControlVerdict;
      let reason: SpringReason | undefined;
      if (anonymous === 'disabled') authentication = 'applies';
      else if (anonymous === 'custom') {
        authentication = 'unknown';
        reason = 'sentinel.spring.anonymousConfigured';
      } else if (admitsAnonymous) {
        if (anonymous === 'default') authentication = 'does-not-apply';
        else {
          authentication = 'unknown';
          reason = 'sentinel.spring.anonymousRole';
        }
      } else if (anonymous === 'unknown' && anyCustom) {
        authentication = 'unknown';
        reason = 'sentinel.spring.anonymousConfigured';
      } else authentication = 'applies';
      return { verdicts: { authentication, authorization: 'applies' }, ...(reason ? { reason } : {}) };
    }
  }
}

// ---- method security ----

const METHOD_SECURITY_ANNS = new Set(['PreAuthorize', 'Secured', 'RolesAllowed', 'PostAuthorize']);
type Grant = { authorities?: readonly string[]; usesRolePrefix?: boolean };
type Method =
  | { kind: 'none' }
  | { kind: 'resolved'; action: RuleAction; grant: Grant; at: At[] }
  | { kind: 'unknown'; reason: SpringReason; at: At[] };

function preAuthorizeAction(expr: string): { action: RuleAction; grant: Grant } {
  const e = expr.replace(/\s+/g, '');
  if (e === 'permitAll()' || e === 'permitAll') return { action: 'permitAll', grant: {} };
  if (e === 'denyAll()' || e === 'denyAll') return { action: 'denyAll', grant: {} };
  if (e === 'isAuthenticated()' || e === 'isFullyAuthenticated()') return { action: 'authenticated', grant: {} };
  const m = /^has(Any)?(Role|Authority)\(('[A-Za-z0-9_]+'(?:,'[A-Za-z0-9_]+')*)\)$/.exec(e);
  if (!m) return { action: 'unsupported', grant: {} };
  const values = m[3]!.split(',').map((v) => v.slice(1, -1));
  const role = m[2] === 'Role';
  if (role && values.some((v) => v.startsWith('ROLE_'))) return { action: 'unsupported', grant: {} };
  return {
    action: 'restricted',
    grant: { authorities: values.map((v) => (role ? `ROLE_${v}` : v)), usesRolePrefix: role },
  };
}

function methodSecurity(
  file: JavaFile,
  handler: JavaNode,
  cfg: SpringConfiguration,
  profiles: readonly string[] | null,
): Method {
  const cls = (() => {
    let p = handler.parent;
    while (p && p.type !== 'class_declaration') p = p.parent;
    return p;
  })();
  const anns = [...annotationsOf(handler), ...(cls ? annotationsOf(cls) : [])].filter((a) =>
    METHOD_SECURITY_ANNS.has(a.name),
  );
  if (!anns.length) return { kind: 'none' };
  const at: At[] = anns.map((a) => ({ file, node: a.node }));
  if (anns.length !== 1) return { kind: 'unknown', reason: 'sentinel.spring.methodSecurityExpressionUnsupported', at };
  const a = anns[0]!;
  const enablements = cfg.methodSecurity.filter((m) => active(m.activity, profiles) !== false);
  const sure = enablements.filter((m) => active(m.activity, profiles) === true && m.proxyMode);
  const flag = (m: MethodSecurityEnablement) =>
    a.name === 'Secured' ? m.secured : a.name === 'RolesAllowed' ? m.jsr250 : m.prePost;
  const enabling = sure.find((m) => flag(m) === true);
  if (!enabling)
    return {
      kind: 'unknown',
      reason: 'sentinel.spring.methodSecurityNotEnabled',
      at: [...at, ...enablements.map((m) => m.at)],
    };
  // Spring's method security works through a proxy: a private, static or final method, or a final class, is not advised.
  const words = modifierWords(handler);
  const classWords = cls ? modifierWords(cls) : new Set<string>();
  if (!words.has('public') || words.has('static') || words.has('final') || classWords.has('final')) {
    return {
      kind: 'unknown',
      reason: 'sentinel.spring.methodSecurityProxyPrerequisite',
      at: [...at, { file, node: handler }],
    };
  }
  if (a.name === 'PostAuthorize')
    return { kind: 'unknown', reason: 'sentinel.spring.methodSecurityExpressionUnsupported', at };
  let decided: { action: RuleAction; grant: Grant };
  if (a.name === 'PreAuthorize') {
    const v = literalString(a.positional[0] ?? a.pairs.get('value'));
    decided = v === undefined ? { action: 'unsupported', grant: {} } : preAuthorizeAction(v);
  } else {
    const values = stringValues(a.positional[0] ?? a.pairs.get('value'));
    // @Secured names authorities as written; @RolesAllowed names roles that gain the ROLE_ prefix.
    decided =
      !values || !values.length || (a.name === 'RolesAllowed' && values.some((v) => v.startsWith('ROLE_')))
        ? { action: 'unsupported', grant: {} }
        : {
            action: 'restricted',
            grant: {
              authorities: a.name === 'RolesAllowed' ? values.map((v) => `ROLE_${v}`) : values,
              usesRolePrefix: a.name === 'RolesAllowed',
            },
          };
  }
  if (decided.action === 'unsupported')
    return { kind: 'unknown', reason: 'sentinel.spring.methodSecurityExpressionUnsupported', at };
  return { kind: 'resolved', action: decided.action, grant: decided.grant, at: [...at, enabling.at] };
}

// ---- the pack ----

export class SpringPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpringPackError';
  }
}

/** Control facts for one source's routes, validated against `sentinel-controls/draft-1`. */
export async function analyzeSpring(input: SpringPackInput): Promise<ControlFactsEnvelope> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const mine = input.snapshot.entries.filter((e) => e.sourceId === input.sourceId);
  const frontiers: ScopedReason[] = [];
  const frontier = (path: string, reason: SpringReason) => {
    if (frontiers.length < 10_000) frontiers.push({ scopeId: `${input.sourceId}:${path}`, reasonCode: reason });
  };
  // Completeness: a Java file capture did not keep, or a folder it did not list, could hold another chain.
  let incomplete = false;
  for (const e of mine) {
    if (e.kind === 'directory-boundary' && !SAFE_BOUNDARIES.has(e.reasonCode)) {
      incomplete = true;
      frontier(e.relativePath, 'sentinel.spring.sourceIncomplete');
    }
    if (
      ((e.kind === 'file' && e.disposition !== 'included') || e.kind === 'symlink') &&
      e.relativePath.endsWith('.java')
    ) {
      incomplete = true;
      frontier(e.relativePath, 'sentinel.spring.sourceIncomplete');
    }
  }
  const included = mine.filter(
    (e): e is Extract<typeof e, { disposition: 'included' }> => e.kind === 'file' && e.disposition === 'included',
  );
  const read: { path: string; content: ArtifactId }[] = [];
  const bytesOf = async (e: { relativePath: string; content: ArtifactId }) => {
    read.push({ path: e.relativePath, content: e.content });
    return Buffer.from(await input.readContent(e.content));
  };
  const pomEntry = included.find((e) => e.relativePath === 'pom.xml');
  const pom = pomEntry ? { raw: await bytesOf(pomEntry), content: pomEntry.content } : undefined;
  const gradle = included.some((e) => /(^|\/)(build|settings)\.gradle(\.kts)?$/.test(e.relativePath));
  const version = resolveVersion(input, pom, gradle);
  for (const e of included) {
    if (!/(^|\/)application[^/]*\.(properties|ya?ml)$/.test(e.relativePath)) continue;
    const text = (await bytesOf(e)).toString('utf8');
    if (/servlet[.-]?path|servletPath/i.test(text)) {
      incomplete = true;
      frontier(e.relativePath, 'sentinel.spring.servletPathConfigured');
    }
  }

  // Parse every captured Java file, bounded.
  const javaEntries = included
    .filter((e) => e.relativePath.endsWith('.java'))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  const files = new Map<string, JavaFile>();
  let budget = limits.maxJavaBytes;
  try {
    for (const e of javaEntries) {
      if (files.size >= limits.maxJavaFiles || e.bytes > budget) {
        incomplete = true;
        frontier(e.relativePath, 'sentinel.spring.configScanLimit');
        continue;
      }
      budget -= e.bytes;
      const parsed = await parseJava(e.relativePath, e.content, await bytesOf(e));
      if (!parsed) {
        incomplete = true;
        frontier(e.relativePath, 'sentinel.spring.syntaxError');
        continue;
      }
      files.set(e.relativePath, parsed);
    }
    const cfg = readConfiguration(
      [...files.values()],
      included.map((e) => e.relativePath),
    );
    for (const f of cfg.frontiers) frontier(f.at.file.path, f.reason);
    for (const c of cfg.chains) if (c.unsupported) frontier(c.at.file.path, c.unsupported.reason);
    for (const [path, f] of files) {
      // A configuration file whose syntax has errors could hide a chain.
      if (f.root.hasError && /SecurityFilterChain|EnableMethodSecurity|Filter\b|WebSecurityCustomizer/.test(f.text)) {
        incomplete = true;
        frontier(path, 'sentinel.spring.syntaxError');
      }
    }
    const filterReasons = cfg.frontiers.filter(
      (f) => f.reason === 'sentinel.spring.filterBean' || f.reason === 'sentinel.spring.webSecurityCustomizer',
    );
    const interceptors = cfg.frontiers.filter((f) => f.reason === 'sentinel.spring.interceptor');
    const legacy = cfg.frontiers.filter((f) => f.reason === 'sentinel.spring.methodSecurityLegacy');

    const toEvidence = (at: At): SourceEvidence | undefined => {
      const span = at.file.span(at.node);
      return span
        ? {
            snapshotId: input.snapshot.id,
            sourceId: input.sourceId,
            relativePath: at.file.path,
            content: at.file.content as ArtifactId,
            span,
          }
        : undefined;
    };
    const facts: ControlFact[] = [];
    const add = (
      surfaceId: string,
      property: ControlProperty,
      order: number,
      verdict: ControlVerdict,
      evidence: SourceEvidence[],
      reasonCode?: SpringReason,
    ) => {
      const id = `spring.${createHash('sha256').update(`${surfaceId}\u0000${property}\u0000${order}`).digest('hex').slice(0, 40)}`;
      const ev = evidence.slice(0, MAX_EVIDENCE);
      facts.push(
        verdict === 'unknown'
          ? {
              id,
              property,
              surfaceId,
              order,
              verdict,
              evidence: ev,
              reasonCode: reasonCode ?? 'sentinel.spring.versionUnresolved',
            }
          : { id, property, surfaceId, order, verdict, evidence: ev },
      );
    };
    const both = (
      surfaceId: string,
      order: number,
      verdicts: Record<'authentication' | 'authorization', ControlVerdict>,
      evidence: SourceEvidence[],
      reason?: SpringReason,
    ) => {
      for (const property of ['authentication', 'authorization'] as const)
        add(
          surfaceId,
          property,
          order,
          verdicts[property],
          evidence,
          verdicts[property] === 'unknown' ? reason : undefined,
        );
    };
    const unknownBoth = { authentication: 'unknown', authorization: 'unknown' } as const;

    const indexed = new Map(input.analysis.index.nodes.map((n) => [n.nodeId, n]));
    const routes = input.analysis.artifact.graph.nodes.filter(
      (n) => n.kind === 'route' && n.lang === 'java' && n.loc?.repo === input.sourceId,
    );
    for (const route of routes.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const at = indexed.get(route.id);
      const routeEvidence: SourceEvidence[] = at?.byteSpan
        ? [
            {
              snapshotId: input.snapshot.id,
              sourceId: input.sourceId,
              relativePath: at.path,
              content: at.content,
              span: at.byteSpan,
              nodeId: route.id,
            },
          ]
        : [];
      if (!version.ok) {
        both(route.id, SPRING_ORDER.chain, unknownBoth, [...routeEvidence, ...version.evidence], version.reason);
        continue;
      }
      const file = at ? files.get(at.path) : undefined;
      let handler: JavaNode | undefined;
      if (file)
        walk(file.root, (n) => {
          if (!handler && n.type === 'method_declaration' && n.startPosition.row + 1 === route.loc!.line) handler = n;
        });
      if (!at?.byteSpan || !file || !handler) {
        both(route.id, SPRING_ORDER.chain, unknownBoth, routeEvidence, 'sentinel.spring.routeNotIndexed');
        continue;
      }
      if (!file.exact) {
        both(route.id, SPRING_ORDER.chain, unknownBoth, routeEvidence, 'sentinel.spring.sourceNotUtf8');
        continue;
      }
      const mapping = mappingOf(file, handler);
      const mappingEvidence = mapping ? mapping.at.map(toEvidence).filter((e): e is SourceEvidence => !!e) : [];
      const surfaceEvidence = [...routeEvidence, ...mappingEvidence];
      // Order 0: servlet filters and filters a chain adds run before authorization and can decide on their own.
      if (filterReasons.length)
        both(
          route.id,
          SPRING_ORDER.filters,
          unknownBoth,
          [...surfaceEvidence, ...filterReasons.map((f) => toEvidence(f.at)).filter((e): e is SourceEvidence => !!e)],
          filterReasons[0]!.reason,
        );
      // Order 1: the selected chain and its first matching rule.
      // The anonymous principal method security sees comes from the chain that handled the request, when that is known.
      let chainAnonymous: Anonymous | 'unknown' = 'unknown';
      if (!mapping)
        both(route.id, SPRING_ORDER.chain, unknownBoth, surfaceEvidence, 'sentinel.spring.routeMappingUnsupported');
      else if (incomplete)
        both(route.id, SPRING_ORDER.chain, unknownBoth, surfaceEvidence, 'sentinel.spring.sourceIncomplete');
      else {
        const methods: readonly (string | null)[] = mapping.methods ?? [null];
        const outcomes = methods.flatMap((m) =>
          mapping.paths.map((p) => evaluate(cfg, input.environment.activeProfiles, m, p)),
        );
        const first = outcomes[0]!;
        const same = outcomes.every(
          (o) =>
            o.kind === first.kind &&
            (o.kind === 'unknown'
              ? o.reason === (first as { reason: string }).reason
              : first.kind === 'resolved' &&
                o.action === first.action &&
                o.chain === first.chain &&
                o.rule === first.rule),
        );
        const outcomeEvidence = outcomes
          .flatMap((o) => o.at)
          .map(toEvidence)
          .filter((e): e is SourceEvidence => !!e);
        const evidence = dedupe([...surfaceEvidence, ...outcomeEvidence]);
        if (!same) both(route.id, SPRING_ORDER.chain, unknownBoth, evidence, 'sentinel.spring.routeMappingsDisagree');
        else if (first.kind === 'unknown') both(route.id, SPRING_ORDER.chain, unknownBoth, evidence, first.reason);
        else {
          const v = verdictsFor(first.action, first.rule ?? {}, first.chain.anonymous, cfg);
          const extra = [
            first.chain.anonymousAt,
            ...(v.reason === 'sentinel.spring.rolePrefixCustomized' ? cfg.rolePrefixCustomized : []),
          ]
            .filter((x): x is At => !!x)
            .map(toEvidence)
            .filter((e): e is SourceEvidence => !!e);
          // A resolved fact also cites the version pin it relies on: the POM's Boot parent and starters.
          both(
            route.id,
            SPRING_ORDER.chain,
            v.verdicts,
            dedupe([...evidence, ...extra, ...version.evidence]),
            v.reason,
          );
          chainAnonymous = first.chain.anonymous;
          if (!filterReasons.length && first.chain.customFilters.length) {
            both(
              route.id,
              SPRING_ORDER.filters,
              unknownBoth,
              [
                ...surfaceEvidence,
                ...first.chain.customFilters.map(toEvidence).filter((e): e is SourceEvidence => !!e),
              ],
              'sentinel.spring.customFilter',
            );
          }
        }
      }
      // Order 2: MVC interceptors run after the chain and before the handler.
      if (interceptors.length)
        both(
          route.id,
          SPRING_ORDER.interceptors,
          unknownBoth,
          [...surfaceEvidence, ...interceptors.map((f) => toEvidence(f.at)).filter((e): e is SourceEvidence => !!e)],
          'sentinel.spring.interceptor',
        );
      // Order 3: method security on the handler, effective only when enabled and the handler can be proxied.
      let ms = methodSecurity(file, handler, cfg, input.environment.activeProfiles);
      // Legacy @EnableGlobalMethodSecurity changes which annotations are honoured; this pack does not model it.
      if (ms.kind !== 'none' && legacy.length)
        ms = {
          kind: 'unknown',
          reason: 'sentinel.spring.methodSecurityLegacy',
          at: [...ms.at, ...legacy.map((l) => l.at)],
        };
      const msEvidence =
        ms.kind === 'none'
          ? []
          : dedupe([...surfaceEvidence, ...ms.at.map(toEvidence).filter((e): e is SourceEvidence => !!e)]);
      if (ms.kind === 'resolved') {
        const v = verdictsFor(ms.action, ms.grant, chainAnonymous, cfg);
        both(route.id, SPRING_ORDER.methodSecurity, v.verdicts, msEvidence, v.reason);
      } else if (ms.kind === 'unknown') both(route.id, SPRING_ORDER.methodSecurity, unknownBoth, msEvidence, ms.reason);
    }
    const envelope: ControlFactsEnvelope = {
      schema: 'sentinel-controls/draft-1',
      snapshotId: input.snapshot.id,
      framework: { id: 'spring', version: version.ok ? SPRING_PACK.version : null },
      packDigest: digestOf({ pack: SPRING_PACK, order: SPRING_ORDER, support: SPRING_SUPPORT }),
      environmentDigest: digestOf({
        framework: 'spring',
        stack: 'servlet',
        activeProfiles: input.environment.activeProfiles === null ? null : [...input.environment.activeProfiles].sort(),
      }),
      registrationDigest: digestOf(
        [...new Map(read.map((r) => [r.path, r])).values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
      ),
      capability: 'framework-order',
      facts,
      frontiers,
    };
    const valid = validateEnvelope('controls', envelope);
    if (!valid.ok)
      throw new SpringPackError(
        `the pack produced an invalid envelope: ${valid.errors[0]?.code} at ${valid.errors[0]?.path}`,
      );
    return valid.value;
  } finally {
    for (const f of files.values()) f.close();
  }
}

function dedupe(evidence: SourceEvidence[]): SourceEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((e) => {
    const k = `${e.relativePath}:${e.span.startByte}:${e.span.endByte}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

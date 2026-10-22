// Reads Spring Security servlet configuration from captured Java syntax: SecurityFilterChain beans (order, profile,
// chain matcher, authorization rules, added filters), method-security enablement, and the registrations this pack
// does not model but must not ignore (servlet filter beans, WebSecurityCustomizer, MVC interceptors, legacy method
// security). Anything outside the supported shapes is recorded as unsupported with the node that showed it.
import {
  annotationsOf, callArgs, callName, fluentChain, literalString, modifierWords, named, stringValues, walk,
  type Annotation, type JavaFile, type JavaNode,
} from './syntax.js';
import { componentStatus, hasAnnotation, packageOf, TypeIndex, type Tri } from './types.js';

/** A node in a parsed file: the evidence a fact can cite. */
export interface At { readonly file: JavaFile; readonly node: JavaNode }

/** `@Profile` values: a chain is active when any listed name is (a leading `!` negates). */
export interface ProfileCondition { readonly names: readonly string[]; readonly at: At }

export type Activity = { readonly kind: 'always' } | { readonly kind: 'profiles'; readonly conditions: readonly ProfileCondition[] }
  | { readonly kind: 'unsupported'; readonly reason: SpringReason; readonly at: At };

export type ChainMatcher = { readonly kind: 'any' } | { readonly kind: 'paths'; readonly patterns: readonly string[]; readonly at: At }
  | { readonly kind: 'unsupported'; readonly at: At };

export type RuleMatcher = { readonly kind: 'any'; readonly at: At }
  | { readonly kind: 'paths'; readonly method: string | null; readonly patterns: readonly string[]; readonly at: At }
  | { readonly kind: 'unsupported'; readonly at: At };

export type RuleAction = 'permitAll' | 'authenticated' | 'restricted' | 'denyAll' | 'unsupported';

export interface Rule {
  readonly matcher: RuleMatcher;
  readonly action: RuleAction;
  readonly at: At;
  /** For `restricted`: the authorities it admits (`hasRole('X')` admits `ROLE_X`), and whether a role check is involved. */
  readonly authorities?: readonly string[];
  readonly usesRolePrefix?: boolean;
}

/** How the chain configures the anonymous principal Spring gives unauthenticated requests (default: `ROLE_ANONYMOUS`). */
export type Anonymous = 'default' | 'disabled' | 'custom';

/** Whether Spring registers a class's beans, as far as the captured source shows. */
export type Registration = 'registered' | 'not-registered' | 'unknown';

export interface Chain {
  /** `<path>#<method name>`, stable within the snapshot. */
  readonly id: string;
  readonly at: At;
  /** The literal `@Order` value, or null for none (Spring's lowest precedence). */
  readonly order: number | null;
  readonly orderAt?: At;
  readonly activity: Activity;
  readonly matcher: ChainMatcher;
  /** null: the chain configures no authorization (no `authorizeHttpRequests`). */
  readonly rules: readonly Rule[] | null | { readonly unsupported: At };
  readonly rulesAt?: At;
  readonly customFilters: readonly At[];
  readonly anonymous: Anonymous;
  readonly anonymousAt?: At;
  /** Set when the bean's body is outside the supported shape: the chain's matching and rules are unknown. */
  readonly unsupported?: { readonly reason: SpringReason; readonly at: At };
}

export interface MethodSecurityEnablement {
  readonly at: At;
  readonly activity: Activity;
  /** null: the attribute is not a literal boolean. */
  readonly prePost: boolean | null;
  readonly secured: boolean | null;
  readonly jsr250: boolean | null;
  /** Proxy mode only: AspectJ weaving is outside the model. */
  readonly proxyMode: boolean;
}

export interface SpringConfiguration {
  readonly chains: readonly Chain[];
  /** Whether any GrantedAuthorityDefaults bean may change the `ROLE_` prefix role checks use. */
  readonly rolePrefixCustomized: readonly At[];
  readonly methodSecurity: readonly MethodSecurityEnablement[];
  /** Registrations that make the corresponding facts unknown, each with its reason. */
  readonly frontiers: readonly { readonly reason: SpringReason; readonly at: At }[];
}

/** Reason codes this pack can give (catalog: strings-sentinel-spring.ts). */
export const SPRING_REASON_CODES = Object.freeze([
  'sentinel.spring.versionUnresolved', 'sentinel.spring.versionUnsupported', 'sentinel.spring.reactiveUnsupported',
  'sentinel.spring.sourceIncomplete', 'sentinel.spring.sourceNotUtf8', 'sentinel.spring.configScanLimit',
  'sentinel.spring.syntaxError', 'sentinel.spring.chainRegistrationUnknown', 'sentinel.spring.chainBodyUnsupported',
  'sentinel.spring.chainMatcherUnsupported', 'sentinel.spring.chainOrderUnsupported', 'sentinel.spring.chainOrderAmbiguous',
  'sentinel.spring.profileUnselected', 'sentinel.spring.profileExpressionUnsupported', 'sentinel.spring.conditionalBean',
  'sentinel.spring.rulesUnsupported', 'sentinel.spring.ruleMatcherUnsupported', 'sentinel.spring.ruleActionUnsupported',
  'sentinel.spring.noRuleMatches', 'sentinel.spring.noChainMatches', 'sentinel.spring.customFilter',
  'sentinel.spring.filterBean', 'sentinel.spring.webSecurityCustomizer', 'sentinel.spring.interceptor',
  'sentinel.spring.servletPathConfigured', 'sentinel.spring.routeMappingUnsupported', 'sentinel.spring.routeNotIndexed',
  'sentinel.spring.routeMappingsDisagree', 'sentinel.spring.methodSecurityNotEnabled',
  'sentinel.spring.methodSecurityExpressionUnsupported', 'sentinel.spring.methodSecurityProxyPrerequisite',
  'sentinel.spring.methodSecurityLegacy', 'sentinel.spring.componentScanUnresolved', 'sentinel.spring.chainCandidateUnrecognized',
  'sentinel.spring.configurerArgumentUnsupported', 'sentinel.spring.anonymousConfigured', 'sentinel.spring.anonymousRole',
  'sentinel.spring.rolePrefixCustomized', 'sentinel.spring.chainInheritanceUnknown',
] as const);
export type SpringReason = typeof SPRING_REASON_CODES[number];

const STEREOTYPES = new Set(['Component', 'Service', 'Repository', 'Controller', 'RestController', 'Configuration']);
/** DSL calls on HttpSecurity that neither select requests nor authorize them. */
const NEUTRAL_CALLS = new Set([
  'csrf', 'cors', 'headers', 'httpBasic', 'formLogin', 'logout', 'sessionManagement', 'exceptionHandling', 'requestCache',
  'securityContext', 'rememberMe', 'oauth2Login', 'oauth2ResourceServer', 'oauth2Client', 'saml2Login', 'x509', 'jee',
  'passwordManagement', 'anonymous', 'servletApi', 'portMapper', 'requiresChannel',
]);
const FILTER_CALLS = new Set(['addFilter', 'addFilterBefore', 'addFilterAfter', 'addFilterAt']);

const classesOf = (file: JavaFile): JavaNode[] => {
  const out: JavaNode[] = [];
  walk(file.root, n => { if (n.type === 'class_declaration') out.push(n); });
  return out;
};
const methodsOf = (cls: JavaNode): JavaNode[] => named(cls.childForFieldName('body')).filter(n => n.type === 'method_declaration');
const has = (anns: Annotation[], name: string) => anns.find(a => a.name === name);
const returnType = (m: JavaNode) => m.childForFieldName('type')?.text ?? '';
/** A type's simple name: the last segment of a qualified name, without type arguments or array brackets. */
export const simpleType = (text: string) => text.replace(/<[\s\S]*>/g, '').replace(/\[\s*\]/g, '').trim().split('.').pop()!.trim();
const CHAIN_TYPES = new Set(['SecurityFilterChain', 'DefaultSecurityFilterChain']);
const CHAIN_FQNS = new Set(['org.springframework.security.web.SecurityFilterChain', 'org.springframework.security.web.DefaultSecurityFilterChain']);
const HTTP_SECURITY = 'org.springframework.security.config.annotation.web.builders.HttpSecurity';
const HTTP_METHOD = 'org.springframework.http.HttpMethod';
const CONFIGURERS = 'org.springframework.security.config.annotation.web.configurers';
/** Method references this pack knows to be harmless configurer callbacks, by the owning type's fully qualified name. */
const INERT_REFERENCES: Record<string, readonly string[]> = {
  [`${CONFIGURERS}.AbstractHttpConfigurer`]: ['disable'],
  [`${CONFIGURERS}.HeadersConfigurer.FrameOptionsConfig`]: ['sameOrigin', 'deny', 'disable'],
};
/** Configurer methods that return the HttpSecurity: a callback may end with disable(), never continue past it. */
const BUILDER_ESCAPES = new Set(['and', 'disable', 'getBuilder']);
const CONFIG_FQNS = ['org.springframework.context.annotation.Configuration', 'org.springframework.boot.SpringBootConfiguration',
  'org.springframework.boot.autoconfigure.SpringBootApplication'];

/** What name resolution a reading needs: the captured type index. */
interface Ctx { readonly index: TypeIndex }
const resolvesTo = (ctx: Ctx, file: JavaFile, written: string, fqn: string) => {
  const r = ctx.index.resolve(file, written);
  return r.kind === 'external' && r.fqn === fqn;
};

function activityOf(file: JavaFile, ...annLists: Annotation[][]): Activity {
  const conditions: ProfileCondition[] = [];
  for (const anns of annLists) {
    for (const a of anns) {
      if (a.name.startsWith('Conditional')) return { kind: 'unsupported', reason: 'sentinel.spring.conditionalBean', at: { file, node: a.node } };
      if (a.name !== 'Profile') continue;
      const names = stringValues(a.positional[0] ?? a.pairs.get('value'));
      if (!names || !names.length || names.some(n => !/^!?[A-Za-z0-9_.-]+$/.test(n))) {
        return { kind: 'unsupported', reason: 'sentinel.spring.profileExpressionUnsupported', at: { file, node: a.node } };
      }
      conditions.push({ names, at: { file, node: a.node } });
    }
  }
  return conditions.length ? { kind: 'profiles', conditions } : { kind: 'always' };
}

/** `@Order(n)` with a literal (possibly negative) integer. */
function orderOf(file: JavaFile, anns: Annotation[]): { order: number | null; at?: At; unsupported?: At } {
  const a = has(anns, 'Order');
  if (!a) return { order: null };
  const v = a.positional[0] ?? a.pairs.get('value');
  const text = v?.text.replace(/\s+/g, '') ?? '';
  if (!/^-?\d{1,10}$/.test(text)) return { order: null, unsupported: { file, node: a.node } };
  return { order: Number(text), at: { file, node: a.node } };
}

function stringArgs(args: JavaNode[]): string[] | undefined {
  const out: string[] = [];
  for (const a of args) { const v = literalString(a); if (v === undefined) return undefined; out.push(v); }
  return out;
}

function rulesOf(ctx: Ctx, file: JavaFile, lambda: JavaNode): Rule[] | undefined {
  if (lambda.type !== 'lambda_expression') return undefined;
  const params = named(lambda).filter(n => n !== lambda.childForFieldName('body'));
  const param = params[0];
  const paramName = param?.type === 'identifier' ? param.text : param?.type === 'inferred_parameters' ? named(param)[0]?.text : undefined;
  let body = lambda.childForFieldName('body');
  if (body?.type === 'block') {
    const stmts = named(body);
    if (stmts.length !== 1 || stmts[0]!.type !== 'expression_statement') return undefined;
    body = named(stmts[0]!)[0] ?? null;
  }
  if (!body || !paramName) return undefined;
  const { root, calls } = fluentChain(body);
  if (root?.type !== 'identifier' || root.text !== paramName || calls.length % 2 !== 0 || !calls.length) return undefined;
  const rules: Rule[] = [];
  for (let i = 0; i < calls.length; i += 2) {
    const m = calls[i]!;
    const act = calls[i + 1]!;
    let matcher: RuleMatcher;
    if (callName(m) === 'anyRequest' && callArgs(m).length === 0) matcher = { kind: 'any', at: { file, node: m } };
    else if (callName(m) === 'requestMatchers') {
      const args = callArgs(m);
      let method: string | null = null;
      let rest = args;
      const first = args[0];
      const firstText = first?.text.replace(/\s+/g, '') ?? '';
      if (first?.type === 'field_access' && /^[\w.]*HttpMethod\.[A-Z]+$/.test(firstText)) {
        // The constant must be Spring's HttpMethod, not a captured type of the same name.
        if (!resolvesTo(ctx, file, firstText.slice(0, firstText.lastIndexOf('.')), HTTP_METHOD)) method = '?';
        else method = firstText.split('.').pop()!;
        rest = args.slice(1);
      }
      const patterns = stringArgs(rest);
      matcher = patterns && patterns.length && method !== '?' ? { kind: 'paths', method, patterns, at: { file, node: m } } : { kind: 'unsupported', at: { file, node: m } };
    } else matcher = { kind: 'unsupported', at: { file, node: m } };
    const name = callName(act);
    const nargs = callArgs(act);
    let action: RuleAction = 'unsupported';
    let authorities: string[] | undefined;
    const role = name === 'hasRole' || name === 'hasAnyRole';
    if ((name === 'permitAll' || name === 'authenticated' || name === 'fullyAuthenticated' || name === 'denyAll') && nargs.length === 0) {
      action = name === 'fullyAuthenticated' ? 'authenticated' : name;
    } else if (['hasRole', 'hasAnyRole', 'hasAuthority', 'hasAnyAuthority'].includes(name) && nargs.length > 0) {
      const values = stringArgs(nargs);
      // Spring refuses hasRole("ROLE_X") at startup; the pack does not guess what that application does.
      if (values && values.every(v => v.length > 0 && !(role && v.startsWith('ROLE_')))) {
        action = 'restricted';
        authorities = values.map(v => (role ? `ROLE_${v}` : v));
      }
    }
    rules.push({ matcher, action, at: { file, node: act }, ...(authorities ? { authorities, usesRolePrefix: role } : {}) });
  }
  return rules;
}

/**
 * One chain bean. `file` holds the method (a superclass or interface for an inherited bean); `classAnns` are the
 * registered class's own annotations (its @Profile applies to the beans it registers).
 */
function chainOf(ctx: Ctx, file: JavaFile, cls: JavaNode, m: JavaNode, classAnns: Annotation[], registration: Registration): Chain {
  const anns = annotationsOf(m);
  const id = `${file.path}#${m.childForFieldName('name')?.text ?? '?'}`;
  const at = { file, node: m };
  const ord = orderOf(file, anns);
  const base = {
    id, at, order: ord.order, ...(ord.at ? { orderAt: ord.at } : {}), activity: activityOf(file, classAnns, anns),
  };
  // A chain whose position is unknown could come first, so it sorts ahead of every known one.
  const unsupported = (reason: SpringReason, node: JavaNode): Chain =>
    ({ ...base, ...(ord.unsupported ? { order: EARLIEST } : {}), matcher: { kind: 'unsupported', at: { file, node } }, rules: { unsupported: { file, node } }, customFilters: [], anonymous: 'custom', unsupported: { reason, at: { file, node } } });
  if (ord.unsupported) return unsupported('sentinel.spring.chainOrderUnsupported', ord.unsupported.node);
  if (registration === 'unknown') return unsupported('sentinel.spring.chainRegistrationUnknown', cls);
  const type = ctx.index.resolve(file, returnType(m));
  if (type.kind !== 'external' || !CHAIN_FQNS.has(type.fqn)) return unsupported('sentinel.spring.chainCandidateUnrecognized', m);
  const params = named(m.childForFieldName('parameters')).filter(p => p.type === 'formal_parameter');
  const httpParam = params.find(p => resolvesTo(ctx, file, p.childForFieldName('type')?.text ?? '', HTTP_SECURITY));
  const http = httpParam?.childForFieldName('name')?.text;
  const body = m.childForFieldName('body');
  if (!http || !body || body.hasError) return unsupported('sentinel.spring.chainBodyUnsupported', m);
  let matcher: ChainMatcher = { kind: 'any' };
  let matcherCalls = 0;
  let rules: Chain['rules'] = null;
  let rulesAt: At | undefined;
  const customFilters: At[] = [];
  let anonymous: Anonymous = 'default';
  let anonymousAt: At | undefined;
  const stmts = named(body);
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i]!;
    const last = i === stmts.length - 1;
    let expr: JavaNode | null | undefined;
    if (s.type === 'expression_statement') expr = named(s)[0];
    else if (s.type === 'return_statement' && last) expr = named(s)[0];
    else return unsupported('sentinel.spring.chainBodyUnsupported', s);
    if (!expr) return unsupported('sentinel.spring.chainBodyUnsupported', s);
    const { root, calls } = fluentChain(expr);
    if (root?.type !== 'identifier' || root.text !== http) return unsupported('sentinel.spring.chainBodyUnsupported', s);
    for (let c = 0; c < calls.length; c++) {
      const call = calls[c]!;
      const name = callName(call);
      if (s.type === 'return_statement' && c === calls.length - 1) {
        if (name !== 'build' || callArgs(call).length) return unsupported('sentinel.spring.chainBodyUnsupported', call);
        continue;
      }
      if (name === 'securityMatcher') {
        matcherCalls++;
        const patterns = stringArgs(callArgs(call));
        matcher = patterns && patterns.length && matcherCalls === 1 ? { kind: 'paths', patterns, at: { file, node: call } } : { kind: 'unsupported', at: { file, node: call } };
      } else if (name === 'authorizeHttpRequests') {
        const lambda = callArgs(call)[0];
        const parsed = lambda && callArgs(call).length === 1 ? rulesOf(ctx, file, lambda) : undefined;
        if (rules !== null) rules = { unsupported: { file, node: call } };
        else rules = parsed ?? { unsupported: { file, node: call } };
        rulesAt = { file, node: call };
      } else if (FILTER_CALLS.has(name)) customFilters.push({ file, node: call });
      else if (NEUTRAL_CALLS.has(name)) {
        // A configurer's arguments must be provably inert: a lambda that only calls its own parameter fluently, a
        // method reference, withDefaults() or literals. Anything that reaches the HttpSecurity again could remove or
        // replace configurers, so the chain is not modelled.
        if (!callArgs(call).every(a => inertArgument(ctx, file, a, http))) return unsupported('sentinel.spring.configurerArgumentUnsupported', call);
        if (name === 'anonymous') {
          anonymousAt = { file, node: call };
          anonymous = isDisable(ctx, file, callArgs(call)) ? 'disabled' : 'custom';
        }
      } else return unsupported('sentinel.spring.chainBodyUnsupported', call);
    }
    if (s.type === 'return_statement' && callName(calls[calls.length - 1]!) !== 'build') return unsupported('sentinel.spring.chainBodyUnsupported', s);
  }
  const lastStmt = stmts[stmts.length - 1];
  if (lastStmt?.type !== 'return_statement') return unsupported('sentinel.spring.chainBodyUnsupported', m);
  return { ...base, matcher, rules, ...(rulesAt ? { rulesAt } : {}), customFilters, anonymous, ...(anonymousAt ? { anonymousAt } : {}) };
}

/** `AbstractHttpConfigurer::disable` (Spring's own) or `c -> c.disable()`. */
function isDisable(ctx: Ctx, file: JavaFile, args: JavaNode[]): boolean {
  if (args.length !== 1) return false;
  const a = args[0]!;
  if (a.type === 'method_reference') return inertReference(ctx, file, a) && /::\s*disable$/.test(a.text);
  if (a.type !== 'lambda_expression') return false;
  const body = a.childForFieldName('body');
  const { calls } = body ? fluentChain(body) : { calls: [] };
  return calls.length === 1 && callName(calls[0]!) === 'disable' && callArgs(calls[0]!).length === 0;
}

/** A method reference to one of Spring's own configurer methods this pack knows, never an application method. */
function inertReference(ctx: Ctx, file: JavaFile, ref: JavaNode): boolean {
  const m = /^([\w.]+)::(\w+)$/.exec(ref.text.replace(/\s+/g, ''));
  if (!m) return false;
  const owner = ctx.index.resolve(file, m[1]!);
  return owner.kind === 'external' && (INERT_REFERENCES[owner.fqn] ?? []).includes(m[2]!);
}

/**
 * An argument that cannot reach the HttpSecurity or run application code: a literal, a constant of a Spring type, one
 * of Spring's own configurer methods by reference, Spring's withDefaults(), or a lambda that only calls its own
 * parameter's configurer methods, ends at most with disable() (which returns the builder), and whose arguments are
 * inert in turn. An application method reference, a field, or a call past the configurer is not inert.
 */
function inertArgument(ctx: Ctx, file: JavaFile, a: JavaNode, http: string): boolean {
  let reachesHttp = false;
  walk(a, n => { if (n.type === 'identifier' && n.text === http) reachesHttp = true; });
  if (reachesHttp) return false;
  switch (a.type) {
    case 'string_literal': case 'decimal_integer_literal': case 'true': case 'false': case 'null_literal':
      return true;
    case 'class_literal':
      return true;
    case 'field_access': {
      // A constant of a Spring type (SessionCreationPolicy.STATELESS); a captured type's field could hold anything.
      const text = a.text.replace(/\s+/g, '');
      const owner = ctx.index.resolve(file, text.slice(0, text.lastIndexOf('.')));
      return owner.kind === 'external' && owner.fqn.startsWith('org.springframework.');
    }
    case 'method_reference':
      return inertReference(ctx, file, a);
    case 'method_invocation': {
      const { root, calls } = fluentChain(a);
      if (calls.length !== 1 || callName(calls[0]!) !== 'withDefaults' || callArgs(calls[0]!).length) return false;
      return root === null
        ? ctx.index.isStaticImport(file, 'withDefaults', 'org.springframework.security.config.Customizer.withDefaults')
        : resolvesTo(ctx, file, root.text, 'org.springframework.security.config.Customizer');
    }
    case 'lambda_expression': {
      const params = named(a).filter(n => n !== a.childForFieldName('body'));
      const p = params[0];
      const pname = p?.type === 'identifier' ? p.text : p?.type === 'inferred_parameters' ? named(p)[0]?.text : undefined;
      let body = a.childForFieldName('body');
      if (body?.type === 'block') {
        const stmts = named(body);
        if (stmts.length === 0) return true;
        if (stmts.length !== 1 || stmts[0]!.type !== 'expression_statement') return false;
        body = named(stmts[0]!)[0] ?? null;
      }
      if (!body || !pname) return false;
      const { root, calls } = fluentChain(body);
      if (root?.type !== 'identifier' || root.text !== pname || calls.length === 0) return false;
      for (let i = 0; i < calls.length; i++) {
        const name = callName(calls[i]!);
        if (BUILDER_ESCAPES.has(name) && !(name === 'disable' && i === calls.length - 1)) return false;
      }
      return calls.every(c => callArgs(c).every(x => inertArgument(ctx, file, x, http)));
    }
    default:
      return false;
  }
}

/**
 * Which classes Spring Boot registers, from the captured source: the single @SpringBootApplication's package and every
 * package below it are scanned. Anything that could register classes some other way (explicit scan or import
 * annotations, scan attributes, auto-configuration registrations) leaves registration unknown for classes outside it.
 */
export function registrationResolver(ctx: Ctx, files: readonly JavaFile[], resourcePaths: readonly string[]):
  { of: (file: JavaFile, cls: JavaNode) => Registration; unresolved: At[] } {
  const apps: { pkg: string; at: At }[] = [];
  const unresolved: At[] = [];
  const UNRESOLVING = new Set(['ComponentScan', 'ComponentScans', 'Import', 'ImportResource', 'ImportAutoConfiguration', 'EnableAutoConfiguration', 'AutoConfiguration']);
  for (const file of files) {
    walk(file.root, cls => {
      if (cls.type !== 'class_declaration' && cls.type !== 'interface_declaration' && cls.type !== 'annotation_type_declaration') return;
      for (const a of annotationsOf(cls)) {
        if (a.name === 'SpringBootApplication') {
          if (a.pairs.size || a.positional.length) unresolved.push({ file, node: a.node });
          if (cls.type === 'class_declaration') apps.push({ pkg: packageOf(file), at: { file, node: a.node } });
        }
        if (UNRESOLVING.has(a.name)) unresolved.push({ file, node: a.node });
      }
    });
  }
  const autoConfig = resourcePaths.some(p => /(^|\/)META-INF\/(spring\.factories|spring\/[^/]+\.imports)$/.test(p));
  const known = apps.length === 1 && unresolved.length === 0 && !autoConfig;
  if (apps.length !== 1 && files.length) unresolved.push(...apps.map(a => a.at));
  const base = apps[0]?.pkg;
  return {
    unresolved,
    of(file, cls) {
      if (!known) return 'unknown';
      const pkg = packageOf(file);
      const scanned = base !== undefined && (pkg === base || base === '' || pkg.startsWith(`${base}.`));
      if (!scanned) return 'not-registered';
      // Composed annotations count: a captured annotation meta-annotated with a stereotype makes a component.
      const component = componentStatus(ctx.index, file, cls);
      if (component === 'unknown') return 'unknown';
      if (component === 'no') return 'not-registered';
      return isTopLevelOrStatic(cls) ? 'registered' : 'unknown';
    },
  };
}

function isTopLevelOrStatic(cls: JavaNode): boolean {
  let p = cls.parent;
  while (p && p.type !== 'class_declaration') p = p.parent;
  return !p || modifierWords(cls).has('static');
}

const isConfiguration = (ctx: Ctx, file: JavaFile, cls: JavaNode): Tri => {
  let unknown = false;
  for (const fqn of CONFIG_FQNS) {
    const t = hasAnnotation(ctx.index, file, cls, fqn);
    if (t === 'yes') return 'yes';
    if (t === 'unknown') unknown = true;
  }
  return unknown ? 'unknown' : 'no';
};

interface BeanSource { readonly file: JavaFile; readonly method: JavaNode }

/**
 * The @Bean methods a registered class contributes: its own, its captured superclasses' (Spring processes a
 * configuration class's superclass) and its captured interfaces' default methods, a subclass's method overriding an
 * inherited one of the same name. A superclass or interface outside the captured source that is not Java's or
 * Spring's could contribute beans this pack cannot see: that is reported, not ignored.
 */
function beanMethodsOf(ctx: Ctx, file: JavaFile, cls: JavaNode): { methods: BeanSource[]; unknown?: At; classes: { file: JavaFile; node: JavaNode }[] } {
  const methods = new Map<string, BeanSource>();
  const classes: { file: JavaFile; node: JavaNode }[] = [];
  let unknown: At | undefined;
  const seen = new Set<JavaNode>();
  const visit = (f: JavaFile, node: JavaNode, interfaceDefaultsOnly: boolean) => {
    if (seen.has(node)) return;
    seen.add(node);
    classes.push({ file: f, node });
    for (const m of named(node.childForFieldName('body')).filter(n => n.type === 'method_declaration')) {
      if (!has(annotationsOf(m), 'Bean')) continue;
      if (interfaceDefaultsOnly && !modifierWords(m).has('default')) continue;
      const name = m.childForFieldName('name')?.text ?? '?';
      if (!methods.has(name)) methods.set(name, { file: f, method: m });
    }
    const supers: string[] = [];
    const superclass = node.childForFieldName('superclass');
    if (superclass) supers.push(named(superclass)[0]?.text ?? superclass.text.replace(/^extends\s+/, ''));
    const ifaces = node.childForFieldName('interfaces') ?? named(node).find(n => n.type === 'extends_interfaces' || n.type === 'super_interfaces');
    for (const list of named(ifaces)) for (const t of named(list)) supers.push(t.text);
    for (const t of supers) {
      const r = ctx.index.resolve(f, t);
      if (r.kind === 'captured') visit(r.decl.file, r.decl.node, r.decl.kind === 'interface');
      else if (r.kind === 'external' && (r.fqn.startsWith('java.') || (r.fqn.startsWith('org.springframework.') && !r.fqn.startsWith('org.springframework.security.')))) continue;
      else unknown ??= { file: f, node };
    }
  };
  visit(file, cls, false);
  return { methods: [...methods.values()], ...(unknown ? { unknown } : {}), classes };
}

const boolAttr = (a: Annotation, key: string, dflt: boolean): boolean | null => {
  const v = a.pairs.get(key);
  if (!v) return dflt;
  return v.text === 'true' ? true : v.text === 'false' ? false : null;
};

/** Everything this pack reads from the configuration classes of a set of parsed files. */
export function readConfiguration(files: readonly JavaFile[], resourcePaths: readonly string[] = []): SpringConfiguration {
  const ctx: Ctx = { index: new TypeIndex(files) };
  const chains: Chain[] = [];
  const rolePrefixCustomized: At[] = [];
  const registration = registrationResolver(ctx, files, resourcePaths);
  const methodSecurity: MethodSecurityEnablement[] = [];
  const frontiers: { reason: SpringReason; at: At }[] = [];
  const EMS = 'org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity';
  const LEGACY = 'org.springframework.security.config.annotation.method.configuration.EnableGlobalMethodSecurity';
  for (const file of files) {
    for (const cls of classesOf(file)) {
      const classAnns = annotationsOf(cls);
      const registered = registration.of(file, cls);
      const header = `${cls.childForFieldName('superclass')?.text ?? ''} ${cls.childForFieldName('interfaces')?.text ?? ''}`;
      if (/\b(OncePerRequestFilter|GenericFilterBean|Filter)\b/.test(header) && (registered !== 'not-registered' || classAnns.some(a => a.name === 'WebFilter'))) {
        frontiers.push({ reason: 'sentinel.spring.filterBean', at: { file, node: cls } });
      }
      if (registered === 'not-registered') continue;
      const beans = beanMethodsOf(ctx, file, cls);
      // An inherited contribution the pack cannot see could add a chain: chain selection becomes unknown.
      if (beans.unknown) chains.push(unknownChain(beans.unknown, 'sentinel.spring.chainInheritanceUnknown'));
      // @EnableMethodSecurity on the class or a captured superclass (processed with it), only on a registered configuration.
      for (const c of beans.classes) {
        const direct = annotationsOf(c.node).find(a => resolvesTo(ctx, c.file, a.node.childForFieldName('name')?.text ?? a.name, EMS));
        const anyEms = hasAnnotation(ctx.index, c.file, c.node, EMS);
        const config = isConfiguration(ctx, file, cls);
        if (anyEms !== 'no' && (registered === 'unknown' || config !== 'yes')) {
          frontiers.push({ reason: 'sentinel.spring.componentScanUnresolved', at: { file: c.file, node: direct?.node ?? c.node } });
        } else if (anyEms === 'yes') {
          methodSecurity.push(direct
            ? { at: { file: c.file, node: direct.node }, activity: activityOf(file, classAnns), prePost: boolAttr(direct, 'prePostEnabled', true),
                secured: boolAttr(direct, 'securedEnabled', false), jsr250: boolAttr(direct, 'jsr250Enabled', false), proxyMode: !direct.pairs.has('mode') }
            // Enabled through a composed annotation: which kinds it enables is not read.
            : { at: { file: c.file, node: c.node }, activity: activityOf(file, classAnns), prePost: null, secured: null, jsr250: null, proxyMode: false });
        }
        // Legacy method security, or a configuration class whose annotations could hide it, makes method security unknown.
        const legacy = hasAnnotation(ctx.index, c.file, c.node, LEGACY);
        if (legacy === 'yes' || (legacy === 'unknown' && isConfiguration(ctx, file, cls) !== 'no')) {
          frontiers.push({ reason: 'sentinel.spring.methodSecurityLegacy', at: { file: c.file, node: c.node } });
        }
        if (/\bWebMvcConfigurer\b/.test(`${c.node.childForFieldName('superclass')?.text ?? ''} ${c.node.childForFieldName('interfaces')?.text ?? ''}`)) {
          for (const m of named(c.node.childForFieldName('body')).filter(n => n.type === 'method_declaration')) {
            if (m.childForFieldName('name')?.text === 'addInterceptors') frontiers.push({ reason: 'sentinel.spring.interceptor', at: { file: c.file, node: m } });
          }
        }
      }
      for (const { file: mf, method: m } of beans.methods) {
        const type = simpleType(returnType(m));
        // Every bean that could be a chain is a candidate: a known chain type is read, any other chain-like type is
        // an unknown candidate, never silently omitted.
        if (CHAIN_TYPES.has(type) || /FilterChain$/.test(type)) chains.push(chainOf(ctx, mf, cls, m, classAnns, registered));
        else if (type === 'WebSecurityCustomizer') frontiers.push({ reason: 'sentinel.spring.webSecurityCustomizer', at: { file: mf, node: m } });
        else if (type === 'GrantedAuthorityDefaults') rolePrefixCustomized.push({ file: mf, node: m });
        else if (/Filter$/.test(type) || type === 'FilterRegistrationBean' || type === 'DelegatingFilterProxyRegistrationBean') {
          frontiers.push({ reason: 'sentinel.spring.filterBean', at: { file: mf, node: m } });
        }
      }
    }
  }
  for (const at of registration.unresolved) frontiers.push({ reason: 'sentinel.spring.componentScanUnresolved', at });
  for (const at of rolePrefixCustomized) frontiers.push({ reason: 'sentinel.spring.rolePrefixCustomized', at });
  return { chains, rolePrefixCustomized, methodSecurity, frontiers };
}

/** Sorts ahead of any literal @Order: a chain whose position is unknown could be the first Spring tries. */
export const EARLIEST = Number.MIN_SAFE_INTEGER;

/** A chain the pack knows exists but cannot read: every route it could reach stays unknown, wherever it would sort. */
function unknownChain(at: At, reason: SpringReason): Chain {
  return { id: `${at.file.path}#?${at.node.startIndex}`, at, order: EARLIEST, activity: { kind: 'always' },
    matcher: { kind: 'unsupported', at }, rules: { unsupported: at }, customFilters: [], anonymous: 'custom', unsupported: { reason, at } };
}

export { modifierWords };

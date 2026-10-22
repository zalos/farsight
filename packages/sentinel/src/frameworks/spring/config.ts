// Reads Spring Security servlet configuration from captured Java syntax: SecurityFilterChain beans (order, profile,
// chain matcher, authorization rules, added filters), method-security enablement, and the registrations this pack
// does not model but must not ignore (servlet filter beans, WebSecurityCustomizer, MVC interceptors, legacy method
// security). Anything outside the supported shapes is recorded as unsupported with the node that showed it.
import {
  annotationsOf, callArgs, callName, fluentChain, literalString, modifierWords, named, stringValues, walk,
  type Annotation, type JavaFile, type JavaNode,
} from './syntax.js';

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
  'sentinel.spring.rolePrefixCustomized',
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

function rulesOf(file: JavaFile, lambda: JavaNode): Rule[] | undefined {
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
      if (first?.type === 'field_access' && /^HttpMethod\.[A-Z]+$/.test(first.text.replace(/\s+/g, ''))) {
        method = first.text.replace(/\s+/g, '').split('.')[1]!;
        rest = args.slice(1);
      }
      const patterns = stringArgs(rest);
      matcher = patterns && patterns.length ? { kind: 'paths', method, patterns, at: { file, node: m } } : { kind: 'unsupported', at: { file, node: m } };
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

function chainOf(file: JavaFile, cls: JavaNode, m: JavaNode, classAnns: Annotation[], registration: Registration): Chain {
  const anns = annotationsOf(m);
  const id = `${file.path}#${m.childForFieldName('name')?.text ?? '?'}`;
  const at = { file, node: m };
  const ord = orderOf(file, anns);
  const base = {
    id, at, order: ord.order, ...(ord.at ? { orderAt: ord.at } : {}), activity: activityOf(file, classAnns, anns),
  };
  const unsupported = (reason: SpringReason, node: JavaNode): Chain =>
    ({ ...base, matcher: { kind: 'unsupported', at: { file, node } }, rules: { unsupported: { file, node } }, customFilters: [], anonymous: 'custom', unsupported: { reason, at: { file, node } } });
  if (ord.unsupported) return unsupported('sentinel.spring.chainOrderUnsupported', ord.unsupported.node);
  if (registration === 'unknown') return unsupported('sentinel.spring.chainRegistrationUnknown', cls);
  if (!CHAIN_TYPES.has(simpleType(returnType(m)))) return unsupported('sentinel.spring.chainCandidateUnrecognized', m);
  const params = named(m.childForFieldName('parameters')).filter(p => p.type === 'formal_parameter');
  const httpParam = params.find(p => simpleType(p.childForFieldName('type')?.text ?? '') === 'HttpSecurity');
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
        const parsed = lambda && callArgs(call).length === 1 ? rulesOf(file, lambda) : undefined;
        if (rules !== null) rules = { unsupported: { file, node: call } };
        else rules = parsed ?? { unsupported: { file, node: call } };
        rulesAt = { file, node: call };
      } else if (FILTER_CALLS.has(name)) customFilters.push({ file, node: call });
      else if (NEUTRAL_CALLS.has(name)) {
        // A configurer's arguments must be provably inert: a lambda that only calls its own parameter fluently, a
        // method reference, withDefaults() or literals. Anything that reaches the HttpSecurity again could remove or
        // replace configurers, so the chain is not modelled.
        if (!callArgs(call).every(a => inertArgument(a, http))) return unsupported('sentinel.spring.configurerArgumentUnsupported', call);
        if (name === 'anonymous') {
          anonymousAt = { file, node: call };
          anonymous = isDisable(callArgs(call)) ? 'disabled' : 'custom';
        }
      } else return unsupported('sentinel.spring.chainBodyUnsupported', call);
    }
    if (s.type === 'return_statement' && callName(calls[calls.length - 1]!) !== 'build') return unsupported('sentinel.spring.chainBodyUnsupported', s);
  }
  const lastStmt = stmts[stmts.length - 1];
  if (lastStmt?.type !== 'return_statement') return unsupported('sentinel.spring.chainBodyUnsupported', m);
  return { ...base, matcher, rules, ...(rulesAt ? { rulesAt } : {}), customFilters, anonymous, ...(anonymousAt ? { anonymousAt } : {}) };
}

/** `AbstractHttpConfigurer::disable` or `c -> c.disable()`. */
function isDisable(args: JavaNode[]): boolean {
  if (args.length !== 1) return false;
  const a = args[0]!;
  if (a.type === 'method_reference') return /::\s*disable$/.test(a.text);
  if (a.type !== 'lambda_expression') return false;
  const body = a.childForFieldName('body');
  const { calls } = body ? fluentChain(body) : { calls: [] };
  return calls.length === 1 && callName(calls[0]!) === 'disable' && callArgs(calls[0]!).length === 0;
}

/** An argument that cannot reach the HttpSecurity or run arbitrary statements. */
function inertArgument(a: JavaNode, http: string): boolean {
  let reachesHttp = false;
  walk(a, n => { if (n.type === 'identifier' && n.text === http) reachesHttp = true; });
  if (reachesHttp) return false;
  switch (a.type) {
    case 'string_literal': case 'decimal_integer_literal': case 'true': case 'false': case 'null_literal':
    case 'method_reference': case 'class_literal': case 'field_access':
      return true;
    case 'method_invocation': {
      const { root, calls } = fluentChain(a);
      // withDefaults() and Customizer.withDefaults()
      return calls.length === 1 && callName(calls[0]!) === 'withDefaults' && callArgs(calls[0]!).length === 0
        && (root === null || root.text === 'Customizer');
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
      return calls.every(c => callArgs(c).every(x => inertArgument(x, http)));
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
export function registrationResolver(files: readonly JavaFile[], resourcePaths: readonly string[]):
  { of: (file: JavaFile, cls: JavaNode) => Registration; unresolved: At[] } {
  const apps: { pkg: string; at: At }[] = [];
  const unresolved: At[] = [];
  for (const file of files) {
    for (const cls of classesOf(file)) {
      for (const a of annotationsOf(cls)) {
        if (a.name === 'SpringBootApplication') {
          if (a.pairs.size || a.positional.length) unresolved.push({ file, node: a.node });
          apps.push({ pkg: packageOf(file), at: { file, node: a.node } });
        }
        if (['ComponentScan', 'ComponentScans', 'Import', 'ImportResource', 'ImportAutoConfiguration', 'EnableAutoConfiguration', 'AutoConfiguration'].includes(a.name)) {
          unresolved.push({ file, node: a.node });
        }
      }
    }
  }
  const autoConfig = resourcePaths.some(p => /(^|\/)META-INF\/(spring\.factories|spring\/[^/]+\.imports)$/.test(p));
  const known = apps.length === 1 && unresolved.length === 0 && !autoConfig;
  if (apps.length !== 1 && files.length) unresolved.push(...apps.map(a => a.at));
  const base = apps[0]?.pkg;
  return {
    unresolved,
    of(file, cls) {
      const anns = annotationsOf(cls);
      const component = anns.some(a => STEREOTYPES.has(a.name) || a.name === 'SpringBootApplication');
      const pkg = packageOf(file);
      const scanned = base !== undefined && (pkg === base || base === '' || pkg.startsWith(`${base}.`));
      if (known && component && scanned && isTopLevelOrStatic(cls)) return 'registered';
      if (known && !(component && scanned)) return 'not-registered';
      return 'unknown';
    },
  };
}

function packageOf(file: JavaFile): string {
  const decl = named(file.root).find(n => n.type === 'package_declaration');
  return decl ? decl.text.replace(/^package\s+/, '').replace(/;\s*$/, '').replace(/\s+/g, '') : '';
}

function isTopLevelOrStatic(cls: JavaNode): boolean {
  let p = cls.parent;
  while (p && p.type !== 'class_declaration') p = p.parent;
  return !p || modifierWords(cls).has('static');
}

const boolAttr = (a: Annotation, key: string, dflt: boolean): boolean | null => {
  const v = a.pairs.get(key);
  if (!v) return dflt;
  return v.text === 'true' ? true : v.text === 'false' ? false : null;
};

/** Everything this pack reads from the configuration classes of a set of parsed files. */
export function readConfiguration(files: readonly JavaFile[], resourcePaths: readonly string[] = []): SpringConfiguration {
  const chains: Chain[] = [];
  const rolePrefixCustomized: At[] = [];
  const registration = registrationResolver(files, resourcePaths);
  const methodSecurity: MethodSecurityEnablement[] = [];
  const frontiers: { reason: SpringReason; at: At }[] = [];
  for (const file of files) {
    for (const cls of classesOf(file)) {
      const classAnns = annotationsOf(cls);
      const registered = registration.of(file, cls);
      const ems = has(classAnns, 'EnableMethodSecurity');
      // Method security is enabled only by a registered configuration class; any other placement proves nothing.
      if (ems && registered === 'registered' && (has(classAnns, 'Configuration') || has(classAnns, 'SpringBootApplication'))) {
        methodSecurity.push({ at: { file, node: ems.node }, activity: activityOf(file, classAnns),
          prePost: boolAttr(ems, 'prePostEnabled', true), secured: boolAttr(ems, 'securedEnabled', false),
          jsr250: boolAttr(ems, 'jsr250Enabled', false), proxyMode: !ems.pairs.has('mode') });
      }
      if (ems && registered === 'unknown') frontiers.push({ reason: 'sentinel.spring.componentScanUnresolved', at: { file, node: ems.node } });
      const legacy = has(classAnns, 'EnableGlobalMethodSecurity');
      if (legacy && registered !== 'not-registered') frontiers.push({ reason: 'sentinel.spring.methodSecurityLegacy', at: { file, node: legacy.node } });
      const header = `${cls.childForFieldName('superclass')?.text ?? ''} ${cls.childForFieldName('interfaces')?.text ?? ''}`;
      if (/\b(OncePerRequestFilter|GenericFilterBean|Filter)\b/.test(header) && (registered !== 'not-registered' || classAnns.some(a => a.name === 'WebFilter'))) {
        frontiers.push({ reason: 'sentinel.spring.filterBean', at: { file, node: cls } });
      }
      const mvcConfigurer = /\bWebMvcConfigurer\b/.test(header);
      for (const m of methodsOf(cls)) {
        const anns = annotationsOf(m);
        const bean = has(anns, 'Bean');
        const type = simpleType(returnType(m));
        if (mvcConfigurer && registered !== 'not-registered' && m.childForFieldName('name')?.text === 'addInterceptors') {
          frontiers.push({ reason: 'sentinel.spring.interceptor', at: { file, node: m } });
        }
        if (!bean || registered === 'not-registered') continue;
        // Every bean that could be a chain is a candidate: a known chain type is read, any other chain-like type is
        // an unknown candidate, never silently omitted.
        if (CHAIN_TYPES.has(type) || /FilterChain$/.test(type)) chains.push(chainOf(file, cls, m, classAnns, registered));
        else if (type === 'WebSecurityCustomizer') frontiers.push({ reason: 'sentinel.spring.webSecurityCustomizer', at: { file, node: m } });
        else if (type === 'GrantedAuthorityDefaults') rolePrefixCustomized.push({ file, node: m });
        else if (/Filter$/.test(type) || type === 'FilterRegistrationBean' || type === 'DelegatingFilterProxyRegistrationBean') {
          frontiers.push({ reason: 'sentinel.spring.filterBean', at: { file, node: m } });
        }
      }
    }
  }
  for (const at of registration.unresolved) frontiers.push({ reason: 'sentinel.spring.componentScanUnresolved', at });
  for (const at of rolePrefixCustomized) frontiers.push({ reason: 'sentinel.spring.rolePrefixCustomized', at });
  return { chains, rolePrefixCustomized, methodSecurity, frontiers };
}

export { modifierWords };

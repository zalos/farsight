// PR 17: the Spring Security servlet pack over original fixtures: capture → public parser → pack. Synthetic sources
// only; nothing is built or run. E2's six review cases, bypass negatives, exact version scope and evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { parseSnapshot } from '../dist/snapshot/parser.js';
import { analyzeSpring, SPRING_PACK, SPRING_ORDER, SPRING_REASON_CODES, matchTemplate } from '../dist/frameworks/spring/index.js';
import { validateEnvelope } from '../dist/index.js';
import { commitRepo, needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';
import {
  ORDERED_CHAINS, MATCHER_MISMATCH, METHOD_SECURITY, CUSTOM_FILTER, PROFILE_CHAIN, POM, app, security, controller,
} from './spring-fixtures.ts';

const LIMITS = { maxFiles: 1000, maxFileBytes: 1 << 20, maxTotalBytes: 16 << 20, maxEntries: 10_000, maxDurationMs: 60_000 };

async function pack(t: any, files: Record<string, string>, activeProfiles: string[] | null = []) {
  const dir = scratch(t);
  const root = join(dir, 'repo');
  commitRepo(root, files);
  const fx = await openCaptureStore(t, dir);
  // Working-copy capture: committed-tree capture currently misreads some intact loose blobs (reported to the PR 04 owner).
  const { snapshot } = await captureSnapshot(fx.store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/app', root }] });
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const analysis = await parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work, selection: { gitignore: true, testFiles: 'include' }, limits: LIMITS });
  const envelope = await analyzeSpring({ snapshot, sourceId: 'app', analysis: analysis.sources[0]!, readContent: id => fx.store.readArtifact(id),
    environment: { activeProfiles } });
  assert.equal(validateEnvelope('controls', envelope).ok, true);
  await assertEvidence(fx, snapshot, envelope);
  return { envelope, snapshot, fx, analysis };
}

const route = (r: string) => `app::route::${r}`;
const fact = (env: any, r: string, property: string, order: number) =>
  env.facts.find((f: any) => f.surfaceId === route(r) && f.property === property && f.order === order);
const verdicts = (env: any, r: string, order: number = SPRING_ORDER.chain) =>
  ['authentication', 'authorization'].map(p => { const f = fact(env, r, p, order); return f ? (f.verdict === 'unknown' ? `unknown:${f.reasonCode}` : f.verdict) : 'none'; });
const PROTECTED = new Set(['applies']);

/** Every resolved fact cites captured bytes: the evidence's content is the snapshot's, and its span is in range. */
async function assertEvidence(fx: any, snapshot: any, env: any) {
  for (const f of env.facts) {
    if (f.verdict !== 'unknown') assert.ok(f.evidence.length > 0, `${f.surfaceId} ${f.property}: resolved facts cite evidence`);
    for (const e of f.evidence) {
      const entry = snapshot.entries.find((x: any) => x.relativePath === e.relativePath && x.sourceId === e.sourceId);
      assert.equal(entry?.content, e.content, `${e.relativePath} is the captured file`);
      const bytes = await fx.store.readArtifact(e.content);
      assert.ok(e.span.startByte >= 0 && e.span.endByte <= bytes.length && e.span.startByte < e.span.endByte, `${e.relativePath} span in range`);
    }
  }
}
async function cited(fx: any, f: any): Promise<string[]> {
  return Promise.all(f.evidence.map(async (e: any) => (await fx.store.readArtifact(e.content)).subarray(e.span.startByte, e.span.endByte).toString('utf8')));
}

test('E2 case 1 and the demo: two overlapping ordered chains and routes no chain matches', needsStore, async t => {
  const { envelope, fx, snapshot } = await pack(t, ORDERED_CHAINS);
  assert.equal(validateEnvelope('controls', envelope).ok, true);
  assert.deepEqual(envelope.framework, { id: 'spring', version: SPRING_PACK.version });
  // The earlier, narrower chain wins for its prefix: open.
  assert.deepEqual(verdicts(envelope, 'GET /api/secure/public/info'), ['does-not-apply', 'does-not-apply']);
  // The later chain catches the rest of /api/secure/**: authentication required.
  assert.deepEqual(verdicts(envelope, 'GET /api/secure/data'), ['applies', 'does-not-apply']);
  // Within the later chain, the POST-only role rule decides POST; GET falls to anyRequest().
  assert.deepEqual(verdicts(envelope, 'POST /api/secure/admin/users'), ['applies', 'applies']);
  assert.deepEqual(verdicts(envelope, 'GET /api/secure/admin/users'), ['applies', 'does-not-apply']);
  // E2 case 2, no catch-all chain: unmatched routes are unknown, never protected, with every matcher as explanation.
  for (const r of ['GET /api/other/thing', 'GET /healthz']) {
    assert.deepEqual(verdicts(envelope, r), ['unknown:sentinel.spring.noChainMatches', 'unknown:sentinel.spring.noChainMatches'], r);
    const text = (await cited(fx, fact(envelope, r, 'authentication', SPRING_ORDER.chain))).join('\n');
    assert.match(text, /securityMatcher\("\/api\/secure\/public\/\*\*"\)/);
    assert.match(text, /securityMatcher\("\/api\/secure\/\*\*"\)/);
  }
  // The selected chain's facts cite the route's mapping, the chain's order, its matcher and the deciding rule.
  const text = (await cited(fx, fact(envelope, 'GET /api/secure/data', 'authentication', SPRING_ORDER.chain))).join('\n');
  for (const piece of ['@GetMapping("/api/secure/data")', '@Order(2)', 'securityMatcher("/api/secure/**")', 'anyRequest()', 'authenticated()']) {
    assert.ok(text.includes(piece), piece);
  }
  await assertEvidence(fx, snapshot, envelope);
  assert.equal(envelope.frontiers.length, 0);
});

test('E2 case 3: a requestMatchers rule outside the chain matcher protects nothing', needsStore, async t => {
  const { envelope } = await pack(t, MATCHER_MISMATCH);
  assert.deepEqual(verdicts(envelope, 'GET /admin/panel'), ['unknown:sentinel.spring.noChainMatches', 'unknown:sentinel.spring.noChainMatches']);
  assert.deepEqual(verdicts(envelope, 'GET /api/admin'), ['does-not-apply', 'does-not-apply'], 'the ADMIN rule does not match /api/admin');
});

test('E2 case 4: method security only, with its enabling and proxy prerequisites', needsStore, async t => {
  const enabled = (await pack(t, METHOD_SECURITY('@EnableMethodSecurity'))).envelope;
  const ms = SPRING_ORDER.methodSecurity;
  assert.deepEqual(verdicts(enabled, 'GET /reports'), ['unknown:sentinel.spring.noChainMatches', 'unknown:sentinel.spring.noChainMatches']);
  assert.deepEqual(verdicts(enabled, 'GET /reports', ms), ['applies', 'applies']);
  assert.deepEqual(verdicts(enabled, 'GET /audit', ms), ['unknown:sentinel.spring.methodSecurityNotEnabled', 'unknown:sentinel.spring.methodSecurityNotEnabled'],
    '@Secured needs securedEnabled');
  assert.deepEqual(verdicts(enabled, 'GET /private-handler', ms),
    ['unknown:sentinel.spring.methodSecurityProxyPrerequisite', 'unknown:sentinel.spring.methodSecurityProxyPrerequisite']);
  assert.deepEqual(verdicts(enabled, 'GET /custom', ms),
    ['unknown:sentinel.spring.methodSecurityExpressionUnsupported', 'unknown:sentinel.spring.methodSecurityExpressionUnsupported']);
  const secured = (await pack(t, METHOD_SECURITY('@EnableMethodSecurity(securedEnabled = true)'))).envelope;
  assert.deepEqual(verdicts(secured, 'GET /audit', ms), ['applies', 'applies']);
  const none = (await pack(t, METHOD_SECURITY(null))).envelope;
  assert.deepEqual(verdicts(none, 'GET /reports', ms), ['unknown:sentinel.spring.methodSecurityNotEnabled', 'unknown:sentinel.spring.methodSecurityNotEnabled'],
    'an annotation without enabling configuration is not a control');
});

test('E2 case 5: custom filters keep their uncertainty ahead of the chain', needsStore, async t => {
  const inChain = (await pack(t, CUSTOM_FILTER(false))).envelope;
  assert.deepEqual(verdicts(inChain, 'GET /data'), ['applies', 'does-not-apply']);
  assert.deepEqual(verdicts(inChain, 'GET /data', SPRING_ORDER.filters), ['unknown:sentinel.spring.customFilter', 'unknown:sentinel.spring.customFilter']);
  const bean = (await pack(t, CUSTOM_FILTER(true))).envelope;
  assert.deepEqual(verdicts(bean, 'GET /data', SPRING_ORDER.filters), ['unknown:sentinel.spring.filterBean', 'unknown:sentinel.spring.filterBean']);
  assert.ok(bean.frontiers.some((f: any) => f.reasonCode === 'sentinel.spring.filterBean'));
});

test('E2 case 6: a profile-conditioned chain needs the selected profiles, stated explicitly', needsStore, async t => {
  const unselected = await pack(t, PROFILE_CHAIN, null);
  assert.deepEqual(verdicts(unselected.envelope, 'GET /orders'), ['unknown:sentinel.spring.profileUnselected', 'unknown:sentinel.spring.profileUnselected']);
  const prod = await pack(t, PROFILE_CHAIN, ['prod']);
  assert.deepEqual(verdicts(prod.envelope, 'GET /orders'), ['applies', 'does-not-apply'], 'the dev chain is off; the catch-all chain decides');
  const dev = await pack(t, PROFILE_CHAIN, ['dev']);
  assert.deepEqual(verdicts(dev.envelope, 'GET /orders'), ['does-not-apply', 'does-not-apply']);
  assert.notEqual(prod.envelope.environmentDigest, dev.envelope.environmentDigest, 'the environment is part of the facts\' key');
  assert.notEqual(prod.envelope.environmentDigest, unselected.envelope.environmentDigest);
});

test('bypass negatives: partial matches, ties, variables and unreadable shapes never become a protected verdict', needsStore, async t => {
  const env = (await pack(t, app({
    security: security(`
  @Bean
  @Order(1)
  public SecurityFilterChain items(HttpSecurity http) throws Exception {
    http.securityMatcher("/items/**")
        .authorizeHttpRequests(auth -> auth
            .requestMatchers("/items/1").hasRole("OWNER")
            .anyRequest().authenticated());
    return http.build();
  }

  @Bean
  @Order(5)
  public SecurityFilterChain first(HttpSecurity http) throws Exception {
    http.securityMatcher("/tie/**").authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    return http.build();
  }

  @Bean
  @Order(5)
  public SecurityFilterChain second(HttpSecurity http) throws Exception {
    http.securityMatcher("/tie/**").authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
    return http.build();
  }

  @Bean
  @Order(9)
  public SecurityFilterChain dynamic(HttpSecurity http) throws Exception {
    http.securityMatcher(PATHS).authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    return http.build();
  }
  static final String PATHS = "/dyn/**";`),
    routes: controller(`
  @GetMapping("/items/{id}")
  public Map<String, Object> item(@PathVariable String id) { return Map.of(); }

  @GetMapping("/tie/x")
  public Map<String, Object> tie() { return Map.of(); }

  @RequestMapping("/items/1/any")
  public Map<String, Object> anyMethod() { return Map.of(); }

  @GetMapping("/elsewhere")
  public Map<String, Object> elsewhere() { return Map.of(); }`),
  }))).envelope;
  // A rule that matches only some values of a path variable decides nothing.
  assert.deepEqual(verdicts(env, 'GET /items/:param'), ['unknown:sentinel.spring.ruleMatcherUnsupported', 'unknown:sentinel.spring.ruleMatcherUnsupported']);
  assert.deepEqual(verdicts(env, 'GET /tie/x'), ['unknown:sentinel.spring.chainOrderAmbiguous', 'unknown:sentinel.spring.chainOrderAmbiguous']);
  // A chain whose matcher is not literal blocks every later decision it could take part in.
  assert.deepEqual(verdicts(env, 'GET /elsewhere'), ['unknown:sentinel.spring.chainMatcherUnsupported', 'unknown:sentinel.spring.chainMatcherUnsupported']);
  for (const f of env.facts) if (f.surfaceId === route('GET /elsewhere')) assert.ok(!PROTECTED.has(f.verdict));
});

test('a route answering every HTTP method is decided only where all methods agree', needsStore, async t => {
  const env = (await pack(t, app({
    security: security(`
  @Bean
  public SecurityFilterChain c(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.requestMatchers(HttpMethod.POST, "/any").hasRole("W").anyRequest().permitAll());
    return http.build();
  }`),
    routes: controller(`
  @RequestMapping("/any")
  public Map<String, Object> any() { return Map.of(); }`),
  }))).envelope;
  // The parser names this route GET; the pack reads the mapping itself and sees every method.
  assert.deepEqual(verdicts(env, 'GET /any'), ['unknown:sentinel.spring.ruleMatcherUnsupported', 'unknown:sentinel.spring.ruleMatcherUnsupported']);
});

test('chain bodies outside the supported shape are unknown, and so is every route they could reach', needsStore, async t => {
  const env = (await pack(t, app({
    security: security(`
  @Bean
  public SecurityFilterChain c(HttpSecurity http) throws Exception {
    configure(http);
    return http.build();
  }
  private void configure(HttpSecurity http) throws Exception { http.authorizeHttpRequests(a -> a.anyRequest().permitAll()); }`),
    routes: controller(`
  @GetMapping("/x")
  public Map<String, Object> x() { return Map.of(); }`),
  }))).envelope;
  assert.deepEqual(verdicts(env, 'GET /x'), ['unknown:sentinel.spring.chainBodyUnsupported', 'unknown:sentinel.spring.chainBodyUnsupported']);
  assert.ok(env.frontiers.some((f: any) => f.reasonCode === 'sentinel.spring.chainBodyUnsupported'));
});

test('the version scope is exact: another Boot, an override or WebFlux leaves every fact unknown', needsStore, async t => {
  const cases: [string, string][] = [
    [POM({ boot: '3.4.2' }), 'sentinel.spring.versionUnsupported'],
    [POM({ properties: '\n    <spring-security.version>6.4.4</spring-security.version>' }), 'sentinel.spring.versionUnsupported'],
    [POM({ extraDeps: '\n    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-webflux</artifactId></dependency>' }), 'sentinel.spring.reactiveUnsupported'],
    [POM().replace('<version>3.4.3</version>', '<!-- <version>3.4.3</version> -->'), 'sentinel.spring.versionUnresolved'],
  ];
  for (const [pom, reason] of cases) {
    const { envelope } = await pack(t, { ...ORDERED_CHAINS, 'pom.xml': pom });
    assert.equal(envelope.framework.version, null, reason);
    assert.ok(envelope.facts.length > 0 && envelope.facts.every((f: any) => f.verdict === 'unknown' && f.reasonCode === reason), reason);
  }
});

test('the envelope is keyed by pack, environment and registration bytes', needsStore, async t => {
  const a = (await pack(t, ORDERED_CHAINS)).envelope;
  const b = (await pack(t, { ...ORDERED_CHAINS, 'src/main/java/app/SecurityConfig.java': ORDERED_CHAINS['src/main/java/app/SecurityConfig.java'].replace('@Order(2)', '@Order(3)') })).envelope;
  assert.equal(a.packDigest, b.packDigest);
  assert.equal(a.environmentDigest, b.environmentDigest);
  assert.notEqual(a.registrationDigest, b.registrationDigest, 'changed configuration bytes change the key');
  for (const d of [a.packDigest, a.environmentDigest, a.registrationDigest]) assert.match(d, /^sha256:[0-9a-f]{64}$/);
});

test('path templates match only when every request does', () => {
  assert.equal(matchTemplate('/api/secure/data', '/api/secure/**'), 'match');
  assert.equal(matchTemplate('/api/secure', '/api/secure/**'), 'match');
  assert.equal(matchTemplate('/api/other', '/api/secure/**'), 'no-match');
  assert.equal(matchTemplate('/items/{id}', '/items/*'), 'match');
  assert.equal(matchTemplate('/items/{id}', '/items/1'), 'unknown');
  assert.equal(matchTemplate('/a/b/c', '/a/*'), 'no-match');
  assert.equal(matchTemplate('/a/b', '/a/**/b'), 'unknown', 'a mid-pattern ** is outside the subset');
  assert.equal(matchTemplate('/a.json', '/*.json'), 'unknown');
});

test('every reason code is a catalog entry with both registers and a definition', async () => {
  const { STRINGS } = await import('@farsight/core/dist/strings.js');
  for (const key of SPRING_REASON_CODES) assert.ok(STRINGS[key]?.define && STRINGS[key]?.hud && STRINGS[key]?.professional, key);
  const catalog = Object.keys(STRINGS).filter(k => k.startsWith('sentinel.spring.')).sort();
  assert.deepEqual(catalog, [...SPRING_REASON_CODES].sort());
});

test('registrations the pack does not model make their positions unknown for every route', needsStore, async t => {
  const env = (await pack(t, app({
    security: security(`
  @Bean
  public SecurityFilterChain c(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    return http.build();
  }

  @Bean
  public org.springframework.security.config.annotation.web.configuration.WebSecurityCustomizer ignore() {
    return web -> web.ignoring().requestMatchers("/x");
  }`).replace('public SecurityFilterChain c', 'public SecurityFilterChain c').replace(
      'org.springframework.security.config.annotation.web.configuration.WebSecurityCustomizer ignore', 'WebSecurityCustomizer ignore'),
    routes: controller(`
  @GetMapping("/x")
  public Map<String, Object> x() { return Map.of(); }`),
    extra: { 'src/main/java/app/WebConfig.java': `package app;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfig implements WebMvcConfigurer {
  @Override
  public void addInterceptors(InterceptorRegistry registry) { registry.addInterceptor(new AuditInterceptor()); }
}
` },
  }))).envelope;
  assert.deepEqual(verdicts(env, 'GET /x', SPRING_ORDER.filters), ['unknown:sentinel.spring.webSecurityCustomizer', 'unknown:sentinel.spring.webSecurityCustomizer']);
  assert.deepEqual(verdicts(env, 'GET /x', SPRING_ORDER.interceptors), ['unknown:sentinel.spring.interceptor', 'unknown:sentinel.spring.interceptor']);
  assert.deepEqual(verdicts(env, 'GET /x'), ['applies', 'does-not-apply'], 'the chain fact itself stays what the chain says');
});

test('a configured servlet path leaves chain selection unknown', needsStore, async t => {
  const env = (await pack(t, { ...ORDERED_CHAINS, 'src/main/resources/application.properties': 'spring.mvc.servlet.path=/app\n' })).envelope;
  assert.deepEqual(verdicts(env, 'GET /api/secure/data'), ['unknown:sentinel.spring.sourceIncomplete', 'unknown:sentinel.spring.sourceIncomplete']);
  assert.ok(env.frontiers.some((f: any) => f.reasonCode === 'sentinel.spring.servletPathConfigured'));
});

// ---- review probes (SOL, 3468dd7): each is an original fixture reproducing the reported miss ----

const ROUTE_X = controller(`
  @GetMapping("/x")
  public Map<String, Object> x() { return Map.of(); }`);

test('probe 1: a qualified or unrecognized chain type is never omitted', needsStore, async t => {
  const qualified = (await pack(t, app({ security: security(`
  @Bean
  @Order(0)
  public org.springframework.security.web.SecurityFilterChain open(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
    return http.build();
  }

  @Bean
  @Order(1)
  public SecurityFilterChain secure(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    return http.build();
  }`), routes: ROUTE_X }))).envelope;
  assert.deepEqual(verdicts(qualified, 'GET /x'), ['does-not-apply', 'does-not-apply'], 'the earlier, qualified, open chain is the one Spring runs');
  const unrecognized = (await pack(t, app({ security: security(`
  @Bean
  @Order(0)
  public CustomFilterChain custom(HttpSecurity http) throws Exception { return new CustomFilterChain(); }

  @Bean
  @Order(1)
  public SecurityFilterChain secure(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    return http.build();
  }`), routes: ROUTE_X }))).envelope;
  assert.deepEqual(verdicts(unrecognized, 'GET /x'), ['unknown:sentinel.spring.chainCandidateUnrecognized', 'unknown:sentinel.spring.chainCandidateUnrecognized']);
});

test('probe 2: @EnableMethodSecurity on a class Spring does not register enables nothing', needsStore, async t => {
  const env = (await pack(t, app({ security: `package app;

import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;

@EnableMethodSecurity
public class SecurityConfig {}
`, routes: controller(`
  @PreAuthorize("hasRole('ADMIN')")
  @GetMapping("/reports")
  public Map<String, Object> reports() { return Map.of(); }`) }))).envelope;
  assert.deepEqual(verdicts(env, 'GET /reports', SPRING_ORDER.methodSecurity),
    ['unknown:sentinel.spring.methodSecurityNotEnabled', 'unknown:sentinel.spring.methodSecurityNotEnabled']);
});

test('probe 3: configuration outside Boot\'s component scan does not decide; any other scan or import leaves it unknown', needsStore, async t => {
  const outside = { 'src/main/java/other/Outside.java': `package other;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class Outside {
  @Bean
  @Order(0)
  public SecurityFilterChain everything(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    return http.build();
  }
}
` };
  const openApp = security(`
  @Bean
  @Order(5)
  public SecurityFilterChain open(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
    return http.build();
  }`);
  const notScanned = (await pack(t, app({ security: openApp, routes: ROUTE_X, extra: outside }))).envelope;
  assert.deepEqual(verdicts(notScanned, 'GET /x'), ['does-not-apply', 'does-not-apply'], 'the unscanned protecting chain is not registered');
  const imported = (await pack(t, app({ security: openApp.replace('@Configuration\npublic class SecurityConfig', '@Configuration\n@org.springframework.context.annotation.Import(other.Outside.class)\npublic class SecurityConfig'),
    routes: ROUTE_X, extra: outside }))).envelope;
  assert.deepEqual(verdicts(imported, 'GET /x'), ['unknown:sentinel.spring.chainRegistrationUnknown', 'unknown:sentinel.spring.chainRegistrationUnknown']);
  assert.ok(imported.frontiers.some((f: any) => f.reasonCode === 'sentinel.spring.componentScanUnresolved'));
});

test('probe 4: a configurer argument that reaches the HttpSecurity makes the chain unknown', needsStore, async t => {
  const env = (await pack(t, app({ security: security(`
  @Bean
  public SecurityFilterChain c(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .csrf(csrf -> http.removeConfigurer(org.springframework.security.config.annotation.web.configurers.AuthorizeHttpRequestsConfigurer.class));
    return http.build();
  }`), routes: ROUTE_X }))).envelope;
  assert.deepEqual(verdicts(env, 'GET /x'), ['unknown:sentinel.spring.configurerArgumentUnsupported', 'unknown:sentinel.spring.configurerArgumentUnsupported']);
  const inert = (await pack(t, app({ security: security(`
  @Bean
  public SecurityFilterChain c(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .csrf(csrf -> csrf.ignoringRequestMatchers("/hooks/**"))
        .headers(h -> h.frameOptions(f -> f.sameOrigin()))
        .httpBasic(org.springframework.security.config.Customizer.withDefaults());
    return http.build();
  }`), routes: ROUTE_X }))).envelope;
  assert.deepEqual(verdicts(inert, 'GET /x'), ['applies', 'does-not-apply'], 'Spring\'s own Customizer.withDefaults(), named exactly, is inert');
  const short = (await pack(t, app({ security: security(`
  @Bean
  public SecurityFilterChain c(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .csrf(csrf -> csrf.ignoringRequestMatchers("/hooks/**"))
        .headers(h -> h.frameOptions(f -> f.sameOrigin()));
    return http.build();
  }`), routes: ROUTE_X }))).envelope;
  assert.deepEqual(verdicts(short, 'GET /x'), ['applies', 'does-not-apply'], 'lambdas that only configure their own parameter are inert');
});

test('probe 5: a role check is not authentication when the anonymous principal can hold the role', needsStore, async t => {
  const chain = (rules: string, extra = '') => app({ security: security(`
  @Bean
  public SecurityFilterChain c(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.${rules})${extra};
    return http.build();
  }`), routes: ROUTE_X });
  const anonymousRole = (await pack(t, chain('anyRequest().hasRole("ANONYMOUS")'))).envelope;
  assert.deepEqual(verdicts(anonymousRole, 'GET /x'), ['does-not-apply', 'applies'], 'the default anonymous principal holds ROLE_ANONYMOUS');
  const anonymousAuthority = (await pack(t, chain('anyRequest().hasAnyAuthority("ROLE_ANONYMOUS", "ROLE_USER")'))).envelope;
  assert.deepEqual(verdicts(anonymousAuthority, 'GET /x'), ['does-not-apply', 'applies']);
  const disabled = (await pack(t, chain('anyRequest().hasRole("ANONYMOUS")', '\n        .anonymous(a -> a.disable())'))).envelope;
  assert.deepEqual(verdicts(disabled, 'GET /x'), ['applies', 'applies'], 'with no anonymous principal, the role needs an authenticated one');
  const custom = (await pack(t, chain('anyRequest().hasRole("ADMIN")', '\n        .anonymous(a -> a.authorities("ROLE_ADMIN"))'))).envelope;
  assert.deepEqual(verdicts(custom, 'GET /x'), ['unknown:sentinel.spring.anonymousConfigured', 'applies']);
  const user = (await pack(t, chain('anyRequest().hasRole("USER")'))).envelope;
  assert.deepEqual(verdicts(user, 'GET /x'), ['applies', 'applies']);
  const prefixed = (await pack(t, { ...chain('anyRequest().hasRole("USER")'), 'src/main/java/app/Roles.java': `package app;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.core.GrantedAuthorityDefaults;

@Configuration
public class Roles {
  @Bean
  public GrantedAuthorityDefaults grantedAuthorityDefaults() { return new GrantedAuthorityDefaults(""); }
}
` })).envelope;
  assert.deepEqual(verdicts(prefixed, 'GET /x'), ['unknown:sentinel.spring.rolePrefixCustomized', 'unknown:sentinel.spring.rolePrefixCustomized']);
});

test('probe 6: the POM is read as structure, so element order cannot hide a version', needsStore, async t => {
  const reordered = POM({ extraDeps: `
    <dependency>
      <version>6.3.0</version>
      <artifactId>spring-security-web</artifactId>
      <groupId>org.springframework.security</groupId>
    </dependency>` });
  const env = (await pack(t, { ...ORDERED_CHAINS, 'pom.xml': reordered })).envelope;
  assert.equal(env.framework.version, null);
  assert.ok(env.facts.every((f: any) => f.verdict === 'unknown' && f.reasonCode === 'sentinel.spring.versionUnsupported'));
  // Order independence also holds for a valid POM: the parent's children in another order still resolve.
  const parentReordered = POM().replace(
    '<groupId>org.springframework.boot</groupId>\n    <artifactId>spring-boot-starter-parent</artifactId>\n    <version>3.4.3</version>',
    '<version>3.4.3</version>\n    <artifactId>spring-boot-starter-parent</artifactId>\n    <groupId>org.springframework.boot</groupId>');
  assert.notEqual(parentReordered, POM());
  const ok = (await pack(t, { ...ORDERED_CHAINS, 'pom.xml': parentReordered })).envelope;
  assert.equal(ok.framework.version, SPRING_PACK.version);
  for (const [name, pom] of [
    ['a version property', POM({ properties: '\n    <spring-boot.version>3.4.4</spring-boot.version>' })],
    ['a managed dependency', POM().replace('<dependencies>', '<dependencyManagement><dependencies><dependency><groupId>x</groupId><artifactId>y</artifactId><version>1</version><type>pom</type><scope>import</scope></dependency></dependencies></dependencyManagement>\n  <dependencies>')],
    ['a profile', POM().replace('</project>', '<profiles><profile><id>p</id></profile></profiles>\n</project>')],
  ] as const) {
    const e = (await pack(t, { ...ORDERED_CHAINS, 'pom.xml': pom })).envelope;
    assert.equal(e.framework.version, null, name);
  }
});

test('probe 7: a trailing slash is never trimmed into equivalence', needsStore, async t => {
  const env = (await pack(t, app({ security: security(`
  @Bean
  @Order(1)
  public SecurityFilterChain slash(HttpSecurity http) throws Exception {
    http.securityMatcher("/x/").authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    return http.build();
  }

  @Bean
  @Order(2)
  public SecurityFilterChain open(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
    return http.build();
  }`), routes: controller(`
  @GetMapping("/x")
  public Map<String, Object> x() { return Map.of(); }

  @GetMapping("/y/")
  public Map<String, Object> y() { return Map.of(); }`) }))).envelope;
  // Spring Framework 6.2 does not match /x against /x/ by default; the pack never claims the slash chain protects /x.
  assert.deepEqual(verdicts(env, 'GET /x'), ['unknown:sentinel.spring.chainMatcherUnsupported', 'unknown:sentinel.spring.chainMatcherUnsupported']);
  assert.ok(!['applies'].includes(fact(env, 'GET /x', 'authentication', SPRING_ORDER.chain).verdict));
  assert.equal(matchTemplate('/x', '/x/'), 'unknown');
  assert.equal(matchTemplate('/x/', '/x/**'), 'unknown');
  assert.equal(matchTemplate('/x', '/x/**'), 'match');
});

test('probe 8: POM evidence cites exact bytes after multibyte comments, including the closing tag', needsStore, async t => {
  const comment = '<!-- configuration \u{1F600} for café été \u{1F680} -->\n  ';
  const withComment = (boot: string) => POM({ boot }).replace('<parent>', `${comment}<parent>`);
  const ok = await pack(t, { ...ORDERED_CHAINS, 'pom.xml': withComment('3.4.3') });
  const chainFact = fact(ok.envelope, 'GET /api/secure/data', 'authentication', SPRING_ORDER.chain);
  const pomTexts = (await cited(ok.fx, { evidence: chainFact.evidence.filter((e: any) => e.relativePath === 'pom.xml') }));
  const parent = pomTexts.find(text => text.startsWith('<parent>'));
  assert.ok(parent, 'the parent element is cited');
  assert.ok(parent!.endsWith('</parent>'), 'the closing tag is inside the span');
  assert.match(parent!, /<version>3\.4\.3<\/version>/);
  assert.ok(pomTexts.some(text => /^<dependency>[\s\S]*spring-boot-starter-security[\s\S]*<\/dependency>$/.test(text)));
  const unsupported = await pack(t, { ...ORDERED_CHAINS, 'pom.xml': withComment('3.4.2') });
  const f = unsupported.envelope.facts[0];
  assert.equal(f.reasonCode, 'sentinel.spring.versionUnsupported');
  const text = (await cited(unsupported.fx, { evidence: f.evidence.filter((e: any) => e.relativePath === 'pom.xml') })).join('\n');
  assert.ok(text.startsWith('<parent>') && text.endsWith('</parent>') && text.includes('<version>3.4.2</version>'), text);
});

// ---- review round 3 (SOL, ceb6655): builder escapes, composed annotations, inheritance, local parents ----

const IMPORTS = `import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
`;
const OPEN_BODY = `http.authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
    return http.build();`;
const SECURE_CHAIN = `
  @Bean
  @Order(2)
  public SecurityFilterChain secure(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    return http.build();
  }`;

test('round 3, probe 1a: a configurer callback that continues past disable() reaches the builder', needsStore, async t => {
  const env = (await pack(t, app({ security: security(`
  @Bean
  public SecurityFilterChain c(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .csrf(c -> c.disable().removeConfigurer(org.springframework.security.config.annotation.web.configurers.AuthorizeHttpRequestsConfigurer.class));
    return http.build();
  }`), routes: ROUTE_X }))).envelope;
  assert.deepEqual(verdicts(env, 'GET /x'), ['unknown:sentinel.spring.configurerArgumentUnsupported', 'unknown:sentinel.spring.configurerArgumentUnsupported']);
});

test('round 3, probe 1b: an application method reference is opaque, even one that only looks like a configurer', needsStore, async t => {
  const env = (await pack(t, app({ security: security(`
  @Bean
  public SecurityFilterChain c(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .csrf(SecurityConfig::relax);
    return http.build();
  }

  static void relax(org.springframework.security.config.annotation.web.configurers.CsrfConfigurer<HttpSecurity> c) {
    c.disable().removeConfigurer(org.springframework.security.config.annotation.web.configurers.AuthorizeHttpRequestsConfigurer.class);
  }`), routes: ROUTE_X }))).envelope;
  assert.deepEqual(verdicts(env, 'GET /x'), ['unknown:sentinel.spring.configurerArgumentUnsupported', 'unknown:sentinel.spring.configurerArgumentUnsupported']);
  // Spring's own AbstractHttpConfigurer::disable, imported exactly, is still inert.
  const spring = (await pack(t, app({ security: security(`
  @Bean
  public SecurityFilterChain c(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .csrf(AbstractHttpConfigurer::disable);
    return http.build();
  }`).replace('import org.springframework.security.web.SecurityFilterChain;',
    'import org.springframework.security.web.SecurityFilterChain;\nimport org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;'), routes: ROUTE_X }))).envelope;
  assert.deepEqual(verdicts(spring, 'GET /x'), ['applies', 'does-not-apply']);
});

test('round 3, probe 2: a composed annotation meta-annotated with @Configuration registers its chains', needsStore, async t => {
  const files = (annotationSource: Record<string, string>, annotationImport: string) => app({
    security: security(SECURE_CHAIN),
    routes: ROUTE_X,
    extra: {
      ...annotationSource,
      'src/main/java/app/OpenChains.java': `package app;

${IMPORTS}${annotationImport}
@OpenConfiguration
public class OpenChains {
  @Bean
  @Order(0)
  public SecurityFilterChain open(HttpSecurity http) throws Exception {
    ${OPEN_BODY}
  }
}
`,
    },
  });
  const captured = (await pack(t, files({ 'src/main/java/app/OpenConfiguration.java': `package app;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import org.springframework.context.annotation.Configuration;

@Retention(RetentionPolicy.RUNTIME)
@Configuration
public @interface OpenConfiguration {}
` }, ''))).envelope;
  assert.deepEqual(verdicts(captured, 'GET /x'), ['does-not-apply', 'does-not-apply'], 'the earlier open chain of the composed configuration decides');
  // The same annotation from a library the snapshot does not hold: its meaning is unknown, so the chain is too.
  const external = (await pack(t, files({}, 'import com.example.lib.OpenConfiguration;\n'))).envelope;
  assert.deepEqual(verdicts(external, 'GET /x'), ['unknown:sentinel.spring.chainRegistrationUnknown', 'unknown:sentinel.spring.chainRegistrationUnknown']);
});

test('round 3, probe 3: chains inherited from a superclass or an interface default method take part', needsStore, async t => {
  const superclass = (await pack(t, app({
    security: security(SECURE_CHAIN).replace('public class SecurityConfig {', 'public class SecurityConfig extends BaseSecurity {'),
    routes: ROUTE_X,
    extra: { 'src/main/java/app/BaseSecurity.java': `package app;

${IMPORTS}
public abstract class BaseSecurity {
  @Bean
  @Order(0)
  public SecurityFilterChain open(HttpSecurity http) throws Exception {
    ${OPEN_BODY}
  }
}
` },
  }))).envelope;
  assert.deepEqual(verdicts(superclass, 'GET /x'), ['does-not-apply', 'does-not-apply'], 'the inherited earlier open chain decides');
  const iface = (await pack(t, app({
    security: security(SECURE_CHAIN).replace('public class SecurityConfig {', 'public class SecurityConfig implements OpenDefaults {'),
    routes: ROUTE_X,
    extra: { 'src/main/java/app/OpenDefaults.java': `package app;

${IMPORTS}
public interface OpenDefaults {
  @Bean
  @Order(0)
  default SecurityFilterChain open(HttpSecurity http) throws Exception {
    ${OPEN_BODY}
  }
}
` },
  }))).envelope;
  assert.deepEqual(verdicts(iface, 'GET /x'), ['does-not-apply', 'does-not-apply'], 'the interface default bean decides');
  const external = (await pack(t, app({
    security: security(SECURE_CHAIN).replace('public class SecurityConfig {', 'public class SecurityConfig extends com.example.lib.Base {'),
    routes: ROUTE_X,
  }))).envelope;
  assert.deepEqual(verdicts(external, 'GET /x'), ['unknown:sentinel.spring.chainInheritanceUnknown', 'unknown:sentinel.spring.chainInheritanceUnknown']);
});

test('round 3, probe 4: a parent POM resolved from a relative path is not trusted to be Boot\'s', needsStore, async t => {
  const localParent = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-parent</artifactId>
  <version>3.4.3</version>
  <packaging>pom</packaging>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.security</groupId>
        <artifactId>spring-security-bom</artifactId>
        <version>6.3.0</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>
`;
  for (const [name, pom] of [
    ['a relative path to a captured parent', POM().replace('<relativePath/>', '<relativePath>parent/pom.xml</relativePath>')],
    ['the default relative path', POM().replace('<relativePath/>', '')],
  ] as const) {
    const { envelope } = await pack(t, { ...ORDERED_CHAINS, 'pom.xml': pom, 'parent/pom.xml': localParent });
    assert.equal(envelope.framework.version, null, name);
    assert.ok(envelope.facts.every((f: any) => f.verdict === 'unknown' && f.reasonCode === 'sentinel.spring.versionUnresolved'), name);
  }
});

// ---- review round 4 (SOL, a7486fa): Java shadowing, composed conditions, composed @Bean ----

const ABSTRACT_CONFIGURER = 'org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer';
const csrfByReference = (extraBody: string) => security(`
  @Bean
  public SecurityFilterChain c(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .csrf(AbstractHttpConfigurer::disable);
    return http.build();
  }
${extraBody}`).replace('import org.springframework.security.web.SecurityFilterChain;',
  `import org.springframework.security.web.SecurityFilterChain;\nimport ${ABSTRACT_CONFIGURER};`);

test('round 4, probe 1: a nested type shadows the imported Spring type it is named after', needsStore, async t => {
  const env = (await pack(t, app({ security: csrfByReference(`
  static class AbstractHttpConfigurer {
    static void disable(org.springframework.security.config.annotation.web.configurers.CsrfConfigurer<HttpSecurity> c) {
      c.disable().removeConfigurer(org.springframework.security.config.annotation.web.configurers.AuthorizeHttpRequestsConfigurer.class);
    }
  }`), routes: ROUTE_X }))).envelope;
  assert.deepEqual(verdicts(env, 'GET /x'), ['unknown:sentinel.spring.configurerArgumentUnsupported', 'unknown:sentinel.spring.configurerArgumentUnsupported']);
});

test('round 4, near neighbour: a member type inherited from a captured superclass shadows the import too', needsStore, async t => {
  const env = (await pack(t, app({
    security: csrfByReference('').replace('public class SecurityConfig {', 'public class SecurityConfig extends Relaxations {'),
    routes: ROUTE_X,
    extra: { 'src/main/java/app/Relaxations.java': `package app;

public abstract class Relaxations {
  public static class AbstractHttpConfigurer {
    public static void disable(Object c) {}
  }
}
` },
  }))).envelope;
  assert.deepEqual(verdicts(env, 'GET /x'), ['unknown:sentinel.spring.configurerArgumentUnsupported', 'unknown:sentinel.spring.configurerArgumentUnsupported']);
  // Without a colliding declaration the imported Spring reference stays inert.
  const plain = (await pack(t, app({ security: csrfByReference(''), routes: ROUTE_X }))).envelope;
  assert.deepEqual(verdicts(plain, 'GET /x'), ['applies', 'does-not-apply']);
});

const OPEN_FALLBACK = `
  @Bean
  @Order(2)
  public SecurityFilterChain open(HttpSecurity http) throws Exception {
    ${OPEN_BODY}
  }`;
const protectedChains = (annotation: string, method = '') => `package app;

${IMPORTS}
@${annotation}
public class ProtectedChains {
  @Bean
  @Order(0)${method}
  public SecurityFilterChain secure(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    return http.build();
  }
}
`;
const annotationType = (name: string, imports: string, metas: string) => `package app;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
${imports}
@Retention(RetentionPolicy.RUNTIME)
${metas}
public @interface ${name} {}
`;

test('round 4, probe 2: a profile carried by a composed configuration annotation leaves activity unknown', needsStore, async t => {
  const env = (await pack(t, app({
    security: security(OPEN_FALLBACK),
    routes: ROUTE_X,
    extra: {
      'src/main/java/app/ProdConfiguration.java': annotationType('ProdConfiguration',
        'import org.springframework.context.annotation.Configuration;\nimport org.springframework.context.annotation.Profile;\n', '@Configuration\n@Profile("prod")'),
      'src/main/java/app/ProtectedChains.java': protectedChains('ProdConfiguration'),
    },
  }), ['dev'])).envelope;
  assert.deepEqual(verdicts(env, 'GET /x'), ['unknown:sentinel.spring.conditionComposed', 'unknown:sentinel.spring.conditionComposed'],
    'the protected chain may be active; it is never read as active under every profile');
  // The same profile written directly on the class is read: under dev the open fallback decides.
  const direct = (await pack(t, app({
    security: security(OPEN_FALLBACK),
    routes: ROUTE_X,
    extra: { 'src/main/java/app/ProtectedChains.java': protectedChains('Configuration\n@org.springframework.context.annotation.Profile("prod")') },
  }), ['dev'])).envelope;
  assert.deepEqual(verdicts(direct, 'GET /x'), ['does-not-apply', 'does-not-apply']);
});

test('round 4, near neighbour: a composed condition or an unreadable annotation on the bean method leaves activity unknown', needsStore, async t => {
  const composed = (await pack(t, app({
    security: security(OPEN_FALLBACK),
    routes: ROUTE_X,
    extra: {
      'src/main/java/app/WhenEnabled.java': annotationType('WhenEnabled',
        'import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;\n', '@ConditionalOnProperty("app.secure")'),
      'src/main/java/app/ProtectedChains.java': protectedChains('Configuration', '\n  @WhenEnabled'),
    },
  }), ['dev'])).envelope;
  assert.deepEqual(verdicts(composed, 'GET /x'), ['unknown:sentinel.spring.conditionComposed', 'unknown:sentinel.spring.conditionComposed']);
  // A library annotation the snapshot does not hold could carry a condition or an order: the chain is not read.
  const library = (await pack(t, app({
    security: security(OPEN_FALLBACK),
    routes: ROUTE_X,
    extra: { 'src/main/java/app/ProtectedChains.java': protectedChains('Configuration', '\n  @com.example.lib.Tuned') },
  }), ['dev'])).envelope;
  assert.equal(verdicts(library, 'GET /x').every(v => v.startsWith('unknown:')), true);
});

const composedBeanChains = (annotation: string) => `package app;

${IMPORTS}
@Configuration
public class OpenChains {
  @${annotation}
  @Order(0)
  public SecurityFilterChain open(HttpSecurity http) throws Exception {
    ${OPEN_BODY}
  }
}
`;

test('round 4, probe 3: a chain declared through a composed @Bean annotation takes part', needsStore, async t => {
  const env = (await pack(t, app({
    security: security(SECURE_CHAIN),
    routes: ROUTE_X,
    extra: {
      'src/main/java/app/OpenBean.java': annotationType('OpenBean', 'import org.springframework.context.annotation.Bean;\n', '@Bean'),
      'src/main/java/app/OpenChains.java': composedBeanChains('OpenBean'),
    },
  }))).envelope;
  assert.deepEqual(verdicts(env, 'GET /x'), ['does-not-apply', 'does-not-apply'], 'the earlier open chain declared by @OpenBean decides');
});

test('round 4, near neighbour: a library bean annotation or a composed @Order leaves the chain unknown', needsStore, async t => {
  const library = (await pack(t, app({
    security: security(SECURE_CHAIN),
    routes: ROUTE_X,
    extra: { 'src/main/java/app/OpenChains.java': composedBeanChains('com.example.lib.OpenBean') },
  }))).envelope;
  assert.deepEqual(verdicts(library, 'GET /x'), ['unknown:sentinel.spring.beanDeclarationUnknown', 'unknown:sentinel.spring.beanDeclarationUnknown']);
  const ordered = (await pack(t, app({
    security: security(SECURE_CHAIN),
    routes: ROUTE_X,
    extra: {
      'src/main/java/app/First.java': annotationType('First', 'import org.springframework.core.annotation.Order;\n', '@Order(0)'),
      'src/main/java/app/OpenChains.java': composedBeanChains('Bean').replace('@Order(0)', '@First'),
    },
  }))).envelope;
  assert.deepEqual(verdicts(ordered, 'GET /x'), ['unknown:sentinel.spring.chainOrderUnsupported', 'unknown:sentinel.spring.chainOrderUnsupported']);
});

test('round 4, probe 4: an inherited chain bean overridden without @Bean is not read from the superclass', needsStore, async t => {
  const base = `package app;

${IMPORTS}
public abstract class BaseSecurity {
  @Bean
  public SecurityFilterChain c(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    return http.build();
  }
}
`;
  const override = (annotation: string) => security(`
  ${annotation}
  @Override
  public SecurityFilterChain c(HttpSecurity http) throws Exception {
    ${OPEN_BODY}
  }`).replace('public class SecurityConfig {', 'public class SecurityConfig extends BaseSecurity {');
  const env = (await pack(t, app({ security: override(''), routes: ROUTE_X, extra: { 'src/main/java/app/BaseSecurity.java': base } }))).envelope;
  assert.deepEqual(verdicts(env, 'GET /x'), ['unknown:sentinel.spring.chainOverridden', 'unknown:sentinel.spring.chainOverridden'],
    'Spring invokes the subclass method, so the superclass\'s protected body is never the answer');
  // The override declared as a @Bean itself is read, and its open body decides.
  const bean = (await pack(t, app({ security: override('@Bean'), routes: ROUTE_X, extra: { 'src/main/java/app/BaseSecurity.java': base } }))).envelope;
  assert.deepEqual(verdicts(bean, 'GET /x'), ['does-not-apply', 'does-not-apply']);
  // Without an override the inherited protected chain is read.
  const inherited = (await pack(t, app({
    security: security('').replace('public class SecurityConfig {', 'public class SecurityConfig extends BaseSecurity {'),
    routes: ROUTE_X, extra: { 'src/main/java/app/BaseSecurity.java': base },
  }))).envelope;
  assert.deepEqual(verdicts(inherited, 'GET /x'), ['applies', 'does-not-apply']);
});

test('round 5: a member type inherited through a wildcard-imported or nested superclass shadows the import', needsStore, async t => {
  const relaxations = (pkg: string, member: string) => `package ${pkg};

public abstract class Relaxations {
  public static class ${member} {
    public static void disable(org.springframework.security.config.annotation.web.configurers.CsrfConfigurer<org.springframework.security.config.annotation.web.builders.HttpSecurity> c) {
      c.disable().removeConfigurer(org.springframework.security.config.annotation.web.configurers.AuthorizeHttpRequestsConfigurer.class);
    }
  }
}
`;
  const viaWildcard = (member: string) => app({
    security: csrfByReference('').replace('public class SecurityConfig {', 'public class SecurityConfig extends Relaxations {')
      .replace(`import ${ABSTRACT_CONFIGURER};`, `import ${ABSTRACT_CONFIGURER};\nimport config.*;`),
    routes: ROUTE_X,
    extra: { 'src/main/java/config/Relaxations.java': relaxations('config', member) },
  });
  const wildcard = (await pack(t, viaWildcard('AbstractHttpConfigurer'))).envelope;
  assert.deepEqual(verdicts(wildcard, 'GET /x'), ['unknown:sentinel.spring.configurerArgumentUnsupported', 'unknown:sentinel.spring.configurerArgumentUnsupported']);
  // A superclass named relative to a captured holder type, `Holder.Relaxations`.
  const nested = (await pack(t, app({
    security: csrfByReference('').replace('public class SecurityConfig {', 'public class SecurityConfig extends Holder.Relaxations {'),
    routes: ROUTE_X,
    extra: { 'src/main/java/app/Holder.java': `package app;

public class Holder {
${relaxations('app', 'AbstractHttpConfigurer').replace('package app;\n\npublic abstract class', 'public abstract static class')}}
` },
  }))).envelope;
  assert.deepEqual(verdicts(nested, 'GET /x'), ['unknown:sentinel.spring.configurerArgumentUnsupported', 'unknown:sentinel.spring.configurerArgumentUnsupported']);
  // Near neighbour: the same wildcard superclass without a colliding member keeps Spring's reference inert.
  const plain = (await pack(t, viaWildcard('OtherHelper'))).envelope;
  assert.deepEqual(verdicts(plain, 'GET /x'), ['applies', 'does-not-apply']);
});


// Java erases each type-argument group, preserving the member-type path between groups. The helper below can
// remove the authorization configurer at runtime, but fixtures are only captured and parsed, never executed.
for (const [label, supertype] of [
  ['outer and member arguments', 'Holder<String>.Relaxations<Integer>'],
  ['nested argument groups', 'Holder<java.util.Map<String, java.util.List<Integer>>>.Relaxations<Integer>'],
  ['package-qualified member', 'app.Holder<String>.Relaxations<Integer>'],
  ['comments containing delimiters', 'Holder</* > < */ String>.Relaxations<Integer>'],
  ['line comments containing delimiters', 'Holder<// > <\nString>.Relaxations<Integer>'],
  ['type annotation containing delimiters', 'Holder<@Angle("> <") String>.Relaxations<Integer>'],
] as const) {
  test(`generic superclass shadow: ${label}`, needsStore, async t => {
    const env = (await pack(t, app({
      security: csrfByReference('').replace('public class SecurityConfig {',
        `public class SecurityConfig extends ${supertype} {\n  public SecurityConfig(${supertype.slice(0, supertype.lastIndexOf('.Relaxations'))} holder) { holder.super(); }`),
      routes: ROUTE_X,
      extra: { 'src/main/java/app/Holder.java': `package app;
@java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE_USE)
@interface Angle { String value(); }
public class Holder<T> {
  public class Relaxations<U> {
    public static class AbstractHttpConfigurer {
      public static void disable(org.springframework.security.config.annotation.web.configurers.CsrfConfigurer<org.springframework.security.config.annotation.web.builders.HttpSecurity> c) {
        c.disable().removeConfigurer(org.springframework.security.config.annotation.web.configurers.AuthorizeHttpRequestsConfigurer.class);
      }
    }
  }
}
` },
    }))).envelope;
    assert.deepEqual(verdicts(env, 'GET /x'), [
      'unknown:sentinel.spring.configurerArgumentUnsupported', 'unknown:sentinel.spring.configurerArgumentUnsupported',
    ]);
  });
}

test('generic superclass without a Spring-name shadow preserves the supported method reference', needsStore, async t => {
  const env = (await pack(t, app({
    security: csrfByReference('').replace('public class SecurityConfig {',
      'public class SecurityConfig extends Holder<String>.Relaxations<Integer> {\n  public SecurityConfig(Holder<String> holder) { holder.super(); }'),
    routes: ROUTE_X,
    extra: { 'src/main/java/app/Holder.java': `package app;
public class Holder<T> {
  public class Relaxations<U> { public static class OtherHelper {} }
}
` },
  }))).envelope;
  assert.deepEqual(verdicts(env, 'GET /x'), ['applies', 'does-not-apply']);
});

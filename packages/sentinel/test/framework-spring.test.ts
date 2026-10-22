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

// What the Spring pack models, stated as data. It is part of the pack digest, so a change to the supported subset
// invalidates every fact computed under the old one. Anything not listed here is reported as unknown with a reason.
export const SPRING_SUPPORT = Object.freeze({
  versions: Object.freeze({ springBoot: '3.4.3', springSecurity: '6.4.3', source: 'pom.xml spring-boot-starter-parent; security pinned by the Boot BOM' }),
  stack: 'servlet',
  notSupported: Object.freeze(['webflux', 'gradle builds', 'version overrides', 'XML configuration', 'WebSecurityConfigurerAdapter']),
  chains: Object.freeze({
    registration: '@Bean method returning SecurityFilterChain in a @Configuration class, taking HttpSecurity',
    body: 'fluent calls on the HttpSecurity parameter, then return <http>.build()',
    order: '@Order with a literal integer; none means lowest precedence; equal orders that could both match are ambiguous',
    activity: '@Profile with plain names or !name (class and method); @Conditional* is unknown',
    selection: 'the first chain, in order, whose securityMatcher matches; no securityMatcher matches every request',
    unmatched: 'no chain matches: unknown (a dependency may contribute a chain), never protected',
  }),
  matchers: Object.freeze({
    chain: 'securityMatcher(literal patterns) called once',
    rules: 'authorizeHttpRequests(lambda): requestMatchers([HttpMethod.X,] literal patterns) | anyRequest(), each followed by one decision',
    decisions: Object.freeze(['permitAll', 'authenticated', 'fullyAuthenticated', 'hasRole', 'hasAnyRole', 'hasAuthority', 'hasAnyAuthority', 'denyAll']),
    patterns: 'literal segments, *, {name} and a trailing /**; anything else is unknown',
  }),
  routes: '@GetMapping/@PostMapping/@PutMapping/@DeleteMapping/@PatchMapping or @RequestMapping with literal paths and RequestMethod values, under an optional class @RequestMapping',
  methodSecurity: Object.freeze({
    enablement: 'active @EnableMethodSecurity in proxy mode: prePostEnabled (default true), securedEnabled and jsr250Enabled (default false)',
    annotations: '@PreAuthorize(permitAll|denyAll|isAuthenticated|isFullyAuthenticated|has[Any]Role|has[Any]Authority literal), @Secured, @RolesAllowed',
    proxy: 'public, non-static, non-final handler in a non-final class',
  }),
  unknownWhenPresent: Object.freeze(['addFilter* in a chain', 'servlet filter beans', 'WebSecurityCustomizer', 'MVC interceptors', 'a configured servlet path', '@EnableGlobalMethodSecurity']),
});

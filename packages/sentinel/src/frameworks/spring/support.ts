// What the Spring pack models, stated as data. It is part of the pack digest, so a change to the supported subset
// invalidates every fact computed under the old one. Anything not listed here is reported as unknown with a reason.
export const SPRING_SUPPORT = Object.freeze({
  versions: Object.freeze({ springBoot: '3.4.3', springSecurity: '6.4.3', source: 'pom.xml read as XML structure: spring-boot-starter-parent 3.4.3 looked up from the repository (an empty relativePath); no profiles, modules, managed dependencies, Spring version properties or explicit Spring Security versions' }),
  stack: 'servlet',
  notSupported: Object.freeze(['webflux', 'gradle builds', 'version overrides', 'XML configuration', 'WebSecurityConfigurerAdapter']),
  chains: Object.freeze({
    registration: '@Bean method returning SecurityFilterChain or DefaultSecurityFilterChain (any qualified spelling), taking HttpSecurity, in a component class Spring Boot\'s default scan registers: the single @SpringBootApplication package and below; any other scan or import makes outside classes unknown',
    candidates: 'any other @Bean whose type ends in FilterChain is an unknown candidate, never omitted',
    names: 'types and annotations resolve through imports, the package and qualified names in captured source; a type declared in the file or inherited as a member type shadows an import, and a name it could shadow is unknown; composed annotations, superclasses and interface default @Bean methods are followed in captured source; anything else is unknown, and an unknown chain sorts first',
    body: 'fluent calls on the HttpSecurity parameter, then return <http>.build(); configurer arguments must be inert (a lambda calling only its own parameter that never continues past disable(), Spring\'s own AbstractHttpConfigurer::disable or FrameOptionsConfig references, Spring\'s withDefaults(), Spring constants, literals)',
    anonymous: 'default ROLE_ANONYMOUS principal, anonymous(disable) or customised (unknown)',
    beans: '@Bean directly or through a captured composed annotation; a method returning a chain type with an annotation from uncaptured code is an unknown chain',
    order: '@Order with a literal integer directly on the bean method; none means lowest precedence; @Order through a composed annotation, or an annotation from uncaptured code, is unknown; equal orders that could both match are ambiguous',
    activity: 'Spring\'s @Profile written directly with plain names or !name (class and method); @Conditional*, a condition carried by a composed annotation, or an annotation from uncaptured code is unknown',
    selection: 'the first chain, in order, whose securityMatcher matches; no securityMatcher matches every request',
    unmatched: 'no chain matches: unknown (a dependency may contribute a chain), never protected',
  }),
  matchers: Object.freeze({
    chain: 'securityMatcher(literal patterns) called once',
    rules: 'authorizeHttpRequests(lambda): requestMatchers([HttpMethod.X,] literal patterns) | anyRequest(), each followed by one decision',
    decisions: Object.freeze(['permitAll', 'authenticated', 'fullyAuthenticated', 'hasRole', 'hasAnyRole', 'hasAuthority', 'hasAnyAuthority', 'denyAll']),
    patterns: 'literal segments, *, {name} and a trailing /**; a trailing slash is significant and unknown; anything else is unknown',
  }),
  routes: '@GetMapping/@PostMapping/@PutMapping/@DeleteMapping/@PatchMapping or @RequestMapping with literal paths and RequestMethod values, under an optional class @RequestMapping',
  methodSecurity: Object.freeze({
    enablement: 'active @EnableMethodSecurity in proxy mode on a registered @Configuration or @SpringBootApplication class: prePostEnabled (default true), securedEnabled and jsr250Enabled (default false)',
    annotations: '@PreAuthorize(permitAll|denyAll|isAuthenticated|isFullyAuthenticated|has[Any]Role|has[Any]Authority literal), @Secured, @RolesAllowed',
    proxy: 'public, non-static, non-final handler in a non-final class',
  }),
  unknownWhenPresent: Object.freeze(['addFilter* in a chain', 'servlet filter beans', 'WebSecurityCustomizer', 'MVC interceptors', 'a configured servlet path', '@EnableGlobalMethodSecurity']),
});

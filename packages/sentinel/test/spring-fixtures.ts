// Original synthetic Spring Boot 3.4.3 / Spring Security 6.4.3 fixtures for the PR 17 pack (E2). None is a real
// application and none is ever built or run here: they are captured, parsed by the public parser and read as source.
// Each case is a whole small repository; a test writes it into a temporary Git repository and captures it.

export const POM = (over: { boot?: string; extraDeps?: string; properties?: string } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<!-- Synthetic Sentinel E2 fixture. Never built. -->
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>${over.boot ?? '3.4.3'}</version>
    <relativePath/>
  </parent>
  <groupId>org.farsight.sentinel.fixture</groupId>
  <artifactId>spring-e2</artifactId>
  <version>0.0.0</version>
  <properties>
    <java.version>21</java.version>${over.properties ?? ''}
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-security</artifactId>
    </dependency>${over.extraDeps ?? ''}
  </dependencies>
</project>
`;

const APP = `package app;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class App {
  public static void main(String[] args) { SpringApplication.run(App.class, args); }
}
`;

const SECURITY_IMPORTS = `package app;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
`;

export const security = (body: string, classAnnotations = '@Configuration') => `${SECURITY_IMPORTS}
${classAnnotations}
public class SecurityConfig {
${body}
}
`;

export const controller = (body: string, classAnnotations = '@RestController') => `package app;

import java.util.Map;
import org.springframework.security.access.annotation.Secured;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

${classAnnotations}
public class Routes {
${body}
}
`;

export const app = (files: { security?: string; routes: string; pom?: string; extra?: Record<string, string> }) => ({
  'pom.xml': files.pom ?? POM(),
  'src/main/java/app/App.java': APP,
  ...(files.security ? { 'src/main/java/app/SecurityConfig.java': files.security } : {}),
  'src/main/java/app/Routes.java': files.routes,
  ...(files.extra ?? {}),
});

// ---- E2 case 1 and the demo: two ordered, overlapping chains and routes no chain matches ----
export const ORDERED_CHAINS = app({
  security: security(`
  // Earlier and narrower: deliberately open.
  @Bean
  @Order(1)
  public SecurityFilterChain openChain(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/secure/public/**")
        .authorizeHttpRequests(auth -> auth.anyRequest().permitAll())
        .csrf(csrf -> csrf.disable());
    return http.build();
  }

  // Later and broader: requires authentication for what the open chain did not claim.
  @Bean
  @Order(2)
  public SecurityFilterChain secureChain(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/secure/**")
        .authorizeHttpRequests(auth -> auth
            .requestMatchers(HttpMethod.POST, "/api/secure/admin/**").hasRole("ADMIN")
            .anyRequest().authenticated())
        .httpBasic(basic -> {});
    return http.build();
  }`),
  routes: controller(`
  @GetMapping("/healthz")
  public Map<String, Object> health() { return Map.of("ok", true); }

  @GetMapping("/api/secure/public/info")
  public Map<String, Object> publicInfo() { return Map.of(); }

  @GetMapping("/api/secure/data")
  public Map<String, Object> secureData() { return Map.of(); }

  @PostMapping("/api/secure/admin/users")
  public Map<String, Object> createUser() { return Map.of(); }

  @GetMapping("/api/secure/admin/users")
  public Map<String, Object> listUsers() { return Map.of(); }

  @GetMapping("/api/other/thing")
  public Map<String, Object> otherThing() { return Map.of(); }`),
});

// ---- E2 case 3: securityMatcher vs requestMatchers mismatch ----
export const MATCHER_MISMATCH = app({
  security: security(`
  @Bean
  public SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/**")
        .authorizeHttpRequests(auth -> auth
            .requestMatchers("/admin/**").hasRole("ADMIN")
            .anyRequest().permitAll());
    return http.build();
  }`),
  routes: controller(`
  // Looks protected by the ADMIN rule, but the chain's matcher never reaches it.
  @GetMapping("/admin/panel")
  public Map<String, Object> adminPanel() { return Map.of(); }

  @GetMapping("/api/admin")
  public Map<String, Object> apiAdmin() { return Map.of(); }`),
});

// ---- E2 case 4: method security only ----
export const METHOD_SECURITY = (enable: string | null) => app({
  security: enable === null ? undefined : `${SECURITY_IMPORTS}
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;

@Configuration
${enable}
public class SecurityConfig {}
`,
  routes: controller(`
  @PreAuthorize("hasRole('ADMIN')")
  @GetMapping("/reports")
  public Map<String, Object> reports() { return Map.of(); }

  @Secured("ROLE_AUDIT")
  @GetMapping("/audit")
  public Map<String, Object> audit() { return Map.of(); }

  @PreAuthorize("isAuthenticated()")
  @GetMapping("/private-handler")
  Map<String, Object> notPublic() { return Map.of(); }

  @PreAuthorize("@guard.check(#id)")
  @GetMapping("/custom")
  public Map<String, Object> custom() { return Map.of(); }`),
});

// ---- E2 case 5: a custom filter in the chain, and a servlet filter bean ----
export const CUSTOM_FILTER = (filterBean: boolean) => app({
  security: security(`
  @Bean
  public SecurityFilterChain chain(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .addFilterBefore(new HeaderFilter(), org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter.class);
    return http.build();
  }`),
  routes: controller(`
  @GetMapping("/data")
  public Map<String, Object> data() { return Map.of(); }`),
  extra: {
    'src/main/java/app/HeaderFilter.java': `package app;

import jakarta.servlet.*;
import java.io.IOException;
${filterBean ? 'import org.springframework.stereotype.Component;\n\n@Component' : ''}
public class HeaderFilter implements Filter {
  public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain) throws IOException, ServletException {
    chain.doFilter(req, res);
  }
}
`,
  },
});

// ---- E2 case 6: a profile-conditioned chain ahead of a catch-all chain ----
export const PROFILE_CHAIN = app({
  security: security(`
  @Bean
  @Order(1)
  @Profile("dev")
  public SecurityFilterChain devChain(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
    return http.build();
  }

  // No securityMatcher: matches every request.
  @Bean
  @Order(2)
  public SecurityFilterChain defaultChain(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    return http.build();
  }`),
  routes: controller(`
  @GetMapping("/orders")
  public Map<String, Object> orders() { return Map.of(); }`),
});

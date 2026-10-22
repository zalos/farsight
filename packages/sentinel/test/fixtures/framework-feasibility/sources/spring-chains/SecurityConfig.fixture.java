// Synthetic Sentinel E2 fixture (spring-chains). Not a real application; never built or run outside a
// bounded probe container. Demonstrates ordered, overlapping SecurityFilterChain beans and the absence
// of an implicit fallback chain: no bean here declares a securityMatcher that reaches "/api/other/**",
// and the fixture does not invent one.
package org.farsight.sentinel.fixture;

import static org.springframework.security.config.Customizer.withDefaults;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class SecurityConfig {

  @Bean
  public PasswordEncoder passwordEncoder() {
    return PasswordEncoderFactories.createDelegatingPasswordEncoder();
  }

  @Bean
  public InMemoryUserDetailsManager userDetailsService(PasswordEncoder encoder) {
    UserDetails user = User.withUsername("fixture-user")
        .password(encoder.encode("NOT_A_SECRET_DO_NOT_USE"))
        .roles("USER")
        .build();
    return new InMemoryUserDetailsManager(user);
  }

  // Ordered chain 1: narrower, earlier, deliberately open. Its matcher overlaps a prefix of chain 2's.
  @Bean
  @Order(1)
  public SecurityFilterChain openChain(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/secure/public/**")
        .authorizeHttpRequests(auth -> auth.anyRequest().permitAll())
        .csrf(csrf -> csrf.disable());
    return http.build();
  }

  // Ordered chain 2: broader, later, requires authentication for everything it matches that chain 1
  // did not already claim.
  @Bean
  @Order(2)
  public SecurityFilterChain secureChain(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/secure/**")
        .authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .httpBasic(withDefaults())
        .csrf(csrf -> csrf.disable());
    return http.build();
  }

  // No bean declares securityMatcher("/api/other/**") or a catch-all "/**". Whatever Spring Security
  // actually does with an unmatched request is this fixture's third lesson; the probe measures it
  // rather than assuming a fallback that no chain here declares.
}

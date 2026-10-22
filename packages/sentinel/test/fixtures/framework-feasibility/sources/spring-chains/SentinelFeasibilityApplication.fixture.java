// Synthetic Sentinel E2 fixture (spring-chains). Not a real application; never built or run outside a
// bounded probe container.
package org.farsight.sentinel.fixture;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class SentinelFeasibilityApplication {
  public static void main(String[] args) {
    SpringApplication.run(SentinelFeasibilityApplication.class, args);
  }
}

// Synthetic Sentinel E2 fixture (spring-chains). Not a real application; never built or run outside a
// bounded probe container.
package org.farsight.sentinel.fixture;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HelloController {
  @GetMapping("/healthz")
  public Map<String, Object> health() { return Map.of("ok", true); }

  // Caught by the earlier, narrower, deliberately open chain (overlaps the broader authenticated chain).
  @GetMapping("/api/secure/public/info")
  public Map<String, Object> publicInfo() { return Map.of("reached", "secure-public-info"); }

  // Not caught by the open chain's narrower matcher; falls to the later authenticated chain.
  @GetMapping("/api/secure/data")
  public Map<String, Object> secureData() { return Map.of("reached", "secure-data"); }

  // Matches neither configured chain's securityMatcher: the missing-chain case.
  @GetMapping("/api/other/thing")
  public Map<String, Object> otherThing() { return Map.of("reached", "other-thing"); }
}

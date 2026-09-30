package com.acme.invoices;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;

/**
 * Boots the invoice API — the Java backend of the same invoice system the
 * {@code invoice-app} example serves from TypeScript.
 * <p>Method security is on because the send and cancel endpoints are guarded
 * with {@code @PreAuthorize}; scheduling is on for the nightly overdue sweep.</p>
 * @tag demo
 * @since 1.0
 */
@SpringBootApplication
@EnableScheduling
@EnableMethodSecurity
public class InvoiceApiApplication {

  public static void main(String[] args) {
    SpringApplication.run(InvoiceApiApplication.class, args);
  }
}

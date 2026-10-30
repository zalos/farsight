package com.acme.invoices.api;

import java.lang.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;

/** The invoice approval policy; its pairs name the resource and grant for readers. */
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
@PreAuthorize("hasAuthority('approve')")
public @interface SomeAnnotationPolicy {
  String resource();
  String action();
}

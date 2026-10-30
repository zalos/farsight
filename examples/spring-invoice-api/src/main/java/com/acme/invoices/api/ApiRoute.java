package com.acme.invoices.api;

import java.lang.annotation.*;
import org.springframework.core.annotation.AliasFor;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;

/** A composed POST mapping, with the explicit method also read by Farsight. */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@RequestMapping(method = RequestMethod.POST)
public @interface ApiRoute {
  @AliasFor(annotation = RequestMapping.class, attribute = "path")
  String[] value();
  String method() default "POST";
}

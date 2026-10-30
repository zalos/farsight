package com.acme.invoices.api;

import com.acme.invoices.domain.Invoice;
import org.springframework.http.ResponseEntity;

/** The interface generated from openapi.yaml; operationId is the method name. */
public interface InvoiceApiDelegate {
  ResponseEntity<Invoice> getInvoiceForApproval(Long id);
}

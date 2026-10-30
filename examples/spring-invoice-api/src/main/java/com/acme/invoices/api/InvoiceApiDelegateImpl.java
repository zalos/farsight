package com.acme.invoices.api;

import com.acme.invoices.domain.Invoice;
import com.acme.invoices.service.InvoiceService;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

@Service
public class InvoiceApiDelegateImpl implements InvoiceApiDelegate {
  private final InvoiceService invoices;

  public InvoiceApiDelegateImpl(InvoiceService invoices) {
    this.invoices = invoices;
  }

  @Override
  @SomeAnnotationPolicy(resource = "invoice", action = "approve")
  public ResponseEntity<Invoice> getInvoiceForApproval(Long id) {
    return ResponseEntity.ok(invoices.get(id));
  }
}

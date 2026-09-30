package com.acme.invoices.api;

import java.util.List;

import jakarta.validation.Valid;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import com.acme.invoices.api.dto.CreateInvoiceRequest;
import com.acme.invoices.domain.Invoice;
import com.acme.invoices.service.InvoiceService;

/**
 * HTTP surface for the invoice lifecycle. Everything here delegates to
 * {@link InvoiceService}; the controller only turns HTTP into calls.
 * @tag billing
 * @since 1.0
 */
@RestController
@RequestMapping("/api/invoices")
public class InvoiceController {

  private final InvoiceService invoices;

  public InvoiceController(InvoiceService invoices) {
    this.invoices = invoices;
  }

  /**
   * Lists invoices for the billing dashboard.
   * @business The list of invoices a billing user can act on today, optionally
   * narrowed to one status such as sent or overdue.
   * @group Invoice API
   */
  @GetMapping
  public List<Invoice> list(@RequestParam(required = false) Invoice.Status status) {
    return invoices.list(status);
  }

  /**
   * Fetches a single invoice by id.
   * @group Invoice API
   * @see InvoiceService#get(Long)
   */
  @GetMapping("/{id}")
  public Invoice get(@PathVariable Long id) {
    return invoices.get(id);
  }

  /**
   * Drafts a new invoice from the submitted customer, amount and due date.
   * @business Raises a new draft invoice for a customer. Nothing reaches the
   * customer until it is sent.
   * @group Invoice API
   */
  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  public Invoice create(@Valid @RequestBody CreateInvoiceRequest request) {
    return invoices.create(request);
  }

  /**
   * Replaces the editable fields of a draft and re-prices it.
   * @business Corrects a draft invoice before it goes out to the customer.
   * @group Invoice API
   */
  @PutMapping("/{id}")
  public Invoice update(@PathVariable Long id, @Valid @RequestBody CreateInvoiceRequest request) {
    return invoices.update(id, request);
  }

  /**
   * Sends the invoice to the customer and announces it on the message bus.
   * @business Sends the invoice to the customer and emails them the PDF. Only
   * billing administrators may do this.
   * @group Invoice API
   * @tag billing
   */
  @PostMapping("/{id}/send")
  @PreAuthorize("hasAuthority('billing:admin')")
  public Invoice send(@PathVariable Long id, Authentication caller) {
    return invoices.send(id, caller.getName());
  }

  /**
   * Cancels an invoice that should never have been raised.
   * @business Cancels an invoice raised by mistake, so it stops counting
   * towards what the customer owes.
   * @group Invoice API
   */
  @DeleteMapping("/{id}")
  @PreAuthorize("hasAuthority('billing:admin')")
  public ResponseEntity<Void> delete(@PathVariable Long id, Authentication caller) {
    invoices.delete(id, caller.getName());
    return ResponseEntity.noContent().build();
  }
}

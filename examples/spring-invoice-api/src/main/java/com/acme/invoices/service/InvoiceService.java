package com.acme.invoices.service;

import java.time.Instant;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import com.acme.invoices.api.dto.CreateInvoiceRequest;
import com.acme.invoices.domain.Invoice;
import com.acme.invoices.domain.InvoiceRepository;
import com.acme.invoices.events.InvoiceEventPublisher;

/**
 * Invoice lifecycle: drafting, editing, sending and cancelling.
 * <p>The rules that decide whether an invoice may change are all here — the
 * controller never inspects status itself.</p>
 * @tag billing
 * @since 1.0
 */
@Service
public class InvoiceService {

  private static final Logger log = LoggerFactory.getLogger(InvoiceService.class);

  private final InvoiceRepository invoices;
  private final TaxCalculator taxCalculator;
  private final InvoiceEventPublisher events;

  public InvoiceService(InvoiceRepository invoices, TaxCalculator taxCalculator, InvoiceEventPublisher events) {
    this.invoices = invoices;
    this.taxCalculator = taxCalculator;
    this.events = events;
  }

  /**
   * Lists invoices, optionally narrowed to one status.
   * @group Invoice operations
   */
  @Transactional(readOnly = true)
  public List<Invoice> list(Invoice.Status status) {
    // @business Show every invoice unless the caller asked for one status
    return status == null ? invoices.findAll() : invoices.findByStatus(status);
  }

  /**
   * Fetches one invoice, or fails with 404 when it does not exist.
   * @group Invoice operations
   * @see #list(Invoice.Status)
   */
  @Transactional(readOnly = true)
  public Invoice get(Long id) {
    return invoices.findById(id)
        .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "no such invoice"));
  }

  /**
   * Drafts an invoice and computes its tax from the customer's country.
   * @business Raises a draft invoice: we check the amount is real, work out
   * the tax for the customer's country, and save it as a draft.
   * @group Invoice operations
   * @since 1.0
   */
  @Transactional
  public Invoice create(CreateInvoiceRequest request) {
    // @business An invoice must be for a real amount before we will draft it
    if (request.amountCents() <= 0) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "invoice amount must be positive");
    }
    long taxCents = taxCalculator.taxFor(request.country(), request.amountCents());
    Invoice invoice = new Invoice(request.customer(), request.amountCents(), taxCents, request.dueDate());
    invoice.setMemo(request.memo());
    return invoices.save(invoice);
  }

  /**
   * Saves edits to a draft; refuses once the invoice has left draft.
   * @business Only draft invoices can be changed. Once an invoice has been
   * sent to the customer its amounts are locked, so we refuse the edit.
   * @group Invoice operations
   */
  @Transactional
  public Invoice update(Long id, CreateInvoiceRequest request) {
    Invoice invoice = get(id);
    // @business Reject edits once the invoice has left draft
    if (invoice.getStatus() != Invoice.Status.DRAFT) {
      throw new ResponseStatusException(HttpStatus.CONFLICT, "invoice is no longer editable");
    } else { // @business Still a draft: re-price it with the current tax rules
      invoice.setAmountCents(request.amountCents());
      invoice.setTaxCents(taxCalculator.taxFor(request.country(), request.amountCents()));
      invoice.setDueDate(request.dueDate());
      invoice.setMemo(request.memo());
    }
    return invoices.save(invoice);
  }

  /**
   * Sends an invoice: status check, send stamp, then <b>invoice.sent</b> on
   * the bus for the notifier to email the PDF.
   * @business When an invoice is sent we check it is in a state that may go
   * out, record the date it left, and tell the notification service to email
   * the customer.
   * @group Invoice operations
   * @tag billing
   * @see TaxCalculator#treatmentFor(String)
   * @since 1.0
   */
  @Transactional
  public Invoice send(Long id, String actorAccount) {
    Invoice invoice = get(id);
    requireBillingOwner(invoice, actorAccount);

    // @business Only a draft or an already-late invoice may be sent —
    // a paid or cancelled invoice must never reach the customer again.
    switch (invoice.getStatus()) {
      // @business Never sent before: this is the first time it goes out
      case DRAFT:
        break;
      case OVERDUE: // @business Already late: sending again is a payment reminder
        break;
      case PAID: // @business Nothing left to chase — the customer has already paid
      case VOID:
      default:
        throw new ResponseStatusException(HttpStatus.CONFLICT, "cannot send a " + invoice.getStatus() + " invoice");
    }

    invoice.setStatus(Invoice.Status.SENT);
    invoice.setSentAt(Instant.now());
    Invoice sent = invoices.save(invoice);

    try { // @business Announce the send so the notifier can email the customer
      events.publishInvoiceSent(sent);
    } catch (RuntimeException e) { // @business If the message bus is down the invoice still counts as sent; the nightly sweep re-announces it
      log.warn("invoice.sent not published for invoice {}", sent.getId(), e);
    }
    return sent;
  }

  /**
   * Cancels an invoice and removes the row.
   * @business Cancels an invoice raised by mistake so it stops counting
   * towards what the customer owes.
   * @group Invoice operations
   */
  @Transactional
  public void delete(Long id, String actorAccount) {
    Invoice invoice = get(id);
    requireBillingOwner(invoice, actorAccount);
    invoices.delete(invoice);
  }

  /**
   * Fails the request unless the caller acts for the invoice's billing account.
   * @guard billing-owner
   * @business Only the account an invoice was raised against may send or
   * cancel it, whatever role the caller holds.
   * @group Invoice operations
   */
  void requireBillingOwner(Invoice invoice, String actorAccount) {
    // @business Refuse the action when the caller belongs to another account
    if (!invoice.getCustomer().equalsIgnoreCase(actorAccount)) {
      throw new ResponseStatusException(HttpStatus.FORBIDDEN, "invoice belongs to another account");
    }
  }
}

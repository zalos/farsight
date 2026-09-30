package com.acme.invoices.jobs;

import java.time.LocalDate;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import com.acme.invoices.domain.Invoice;
import com.acme.invoices.domain.InvoiceRepository;

/**
 * Nightly sweep that flags sent invoices whose due date has passed.
 * @tag billing
 * @since 1.2
 */
@Component
public class OverdueInvoiceJob {

  private static final Logger log = LoggerFactory.getLogger(OverdueInvoiceJob.class);

  private final InvoiceRepository invoices;

  public OverdueInvoiceJob(InvoiceRepository invoices) {
    this.invoices = invoices;
  }

  /**
   * Finds every sent invoice past its due date and marks it overdue.
   * @entrypoint cron:overdue-check
   * @business Every night we mark unpaid invoices whose due date has passed as
   * overdue, so the collections team sees them the next morning.
   * @group Overdue sweep
   * @see com.acme.invoices.domain.InvoiceRepository#markOverdue(List, Invoice.Status)
   */
  @Scheduled(cron = "0 15 2 * * *")
  @Transactional
  public void markOverdueInvoices() {
    List<Invoice> late = invoices.findByStatusAndDueDateBefore(Invoice.Status.SENT, LocalDate.now());
    // @business Nothing to do when every sent invoice is still within its terms
    if (late.isEmpty()) {
      return;
    }
    int updated = invoices.markOverdue(late.stream().map(Invoice::getId).toList(), Invoice.Status.OVERDUE);
    log.info("marked {} invoice(s) overdue", updated);
  }
}

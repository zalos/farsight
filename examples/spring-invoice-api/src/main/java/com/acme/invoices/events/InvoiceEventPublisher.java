package com.acme.invoices.events;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

import com.acme.invoices.domain.Invoice;
import com.acme.invoices.domain.InvoiceRepository;

/**
 * Kafka adapter for the invoice module: announces invoice lifecycle events and
 * consumes settlements from the payments service.
 * @tag messaging
 * @since 1.0
 */
@Component
public class InvoiceEventPublisher {

  private static final Logger log = LoggerFactory.getLogger(InvoiceEventPublisher.class);

  private final KafkaTemplate<String, String> kafka;
  private final InvoiceRepository invoices;

  public InvoiceEventPublisher(KafkaTemplate<String, String> kafka, InvoiceRepository invoices) {
    this.kafka = kafka;
    this.invoices = invoices;
  }

  /**
   * Publishes <code>invoice.sent</code> so the notifier can email the PDF.
   * @business Tells the rest of the business that an invoice has gone out.
   */
  public void publishInvoiceSent(Invoice invoice) {
    String payload = "{\"invoiceId\":%d,\"customer\":\"%s\",\"totalCents\":%d}"
        .formatted(invoice.getId(), invoice.getCustomer(), invoice.totalCents());
    kafka.send("invoice.sent", invoice.getId().toString(), payload);
  }

  /**
   * Marks an invoice paid when the payments service settles it.
   * @business When the payment service confirms the money has arrived, the
   * invoice is marked paid so collections stop chasing it.
   * @tag messaging
   */
  @KafkaListener(topics = "payment.settled", groupId = "invoices")
  public void onPaymentSettled(String invoiceId) {
    invoices.findById(Long.valueOf(invoiceId)).ifPresent(invoice -> {
      invoice.setStatus(Invoice.Status.PAID);
      invoices.save(invoice);
      log.info("invoice {} settled", invoiceId);
    });
  }
}

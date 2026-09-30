package com.acme.invoices.domain;

import java.time.Instant;
import java.time.LocalDate;

import jakarta.persistence.*;

/**
 * One invoice raised against a billing account.
 * @business A bill sent to a customer: who owes it, how much, when it is due,
 * and where it has got to.
 * @tag billing
 * @since 1.0
 */
@Entity
@Table(name = "invoices")
public class Invoice {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  /** Billing account the invoice is raised against. */
  @Column(name = "customer", nullable = false, length = 120)
  private String customer;

  @Column(name = "amount_cents", nullable = false)
  private long amountCents;

  @Column(name = "tax_cents", nullable = false)
  private long taxCents;

  @Enumerated(EnumType.STRING)
  @Column(name = "status", nullable = false, length = 16)
  private Status status = Status.DRAFT;

  @Column(name = "due_date", nullable = false)
  private LocalDate dueDate;

  @Column(name = "sent_at")
  private Instant sentAt;

  @Column(name = "memo", length = 280)
  private String memo;

  protected Invoice() {
    // for JPA
  }

  public Invoice(String customer, long amountCents, long taxCents, LocalDate dueDate) {
    this.customer = customer;
    this.amountCents = amountCents;
    this.taxCents = taxCents;
    this.dueDate = dueDate;
  }

  /**
   * Total the customer owes, tax included.
   * @business What the customer actually has to pay.
   */
  public long totalCents() {
    return amountCents + taxCents;
  }

  public Long getId() { return id; }
  public String getCustomer() { return customer; }
  public long getAmountCents() { return amountCents; }
  public void setAmountCents(long amountCents) { this.amountCents = amountCents; }
  public long getTaxCents() { return taxCents; }
  public void setTaxCents(long taxCents) { this.taxCents = taxCents; }
  public Status getStatus() { return status; }
  public void setStatus(Status status) { this.status = status; }
  public LocalDate getDueDate() { return dueDate; }
  public void setDueDate(LocalDate dueDate) { this.dueDate = dueDate; }
  public Instant getSentAt() { return sentAt; }
  public void setSentAt(Instant sentAt) { this.sentAt = sentAt; }
  public String getMemo() { return memo; }
  public void setMemo(String memo) { this.memo = memo; }

  /**
   * Where an invoice has got to in its life.
   * @business Draft is not yet with the customer, sent is awaiting payment,
   * overdue is past its due date, paid is settled, void was withdrawn.
   */
  public enum Status {
    DRAFT, SENT, PAID, OVERDUE, VOID
  }
}

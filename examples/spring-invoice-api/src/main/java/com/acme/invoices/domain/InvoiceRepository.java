package com.acme.invoices.domain;

import java.time.LocalDate;
import java.util.List;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

/**
 * Persistence for {@link Invoice}. Derived queries cover the dashboard and the
 * nightly sweep; the two hand-written statements exist for the cases Spring
 * Data cannot express.
 * @tag billing
 * @since 1.0
 */
@Repository
public interface InvoiceRepository extends JpaRepository<Invoice, Long> {

  /** Every invoice in one status, for the dashboard filters. */
  List<Invoice> findByStatus(Invoice.Status status);

  /**
   * Invoices in a status whose due date has already passed.
   * @business The unpaid invoices that are now late.
   * @see com.acme.invoices.jobs.OverdueInvoiceJob
   */
  List<Invoice> findByStatusAndDueDateBefore(Invoice.Status status, LocalDate cutoff);

  /**
   * Everything a customer still owes, tax included.
   * @business How much money is outstanding for one customer right now.
   * @since 1.1
   */
  @Query("select coalesce(sum(i.amountCents + i.taxCents), 0) from Invoice i "
      + "where i.customer = :customer and i.status = :status")
  long outstandingCentsFor(@Param("customer") String customer, @Param("status") Invoice.Status status);

  /**
   * Bulk-marks the given invoices overdue in a single statement.
   * @business Flags a batch of late invoices in one go, so the nightly sweep
   * does not touch them one at a time.
   * @since 1.2
   */
  @Modifying(clearAutomatically = true)
  @Query("update Invoice i set i.status = :status where i.id in :ids")
  int markOverdue(@Param("ids") List<Long> ids, @Param("status") Invoice.Status status);
}

package com.acme.invoices.api.dto;

import java.time.LocalDate;

import jakarta.validation.constraints.Future;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

/**
 * Body of {@code POST /api/invoices} and {@code PUT /api/invoices/{id}}.
 * @business What a billing user must supply to raise an invoice: who it is
 * for, how much, when it is due, and where the customer is taxed.
 * @tag billing
 * @see com.acme.invoices.service.InvoiceService#create(CreateInvoiceRequest)
 * @since 1.0
 */
public record CreateInvoiceRequest(

    /** Billing account the invoice is raised against. */
    @NotBlank @Size(max = 120) String customer,

    /** Amount before tax, in cents — never zero or negative. */
    @Positive long amountCents,

    /** Date payment is due; must be in the future when the draft is raised. */
    @NotNull @Future LocalDate dueDate,

    /** ISO-3166 alpha-2 billing country, used to pick the tax treatment. */
    @NotBlank @Size(min = 2, max = 2) String country,

    /** Free-text note printed on the invoice PDF. */
    @Size(max = 280) String memo) {
}

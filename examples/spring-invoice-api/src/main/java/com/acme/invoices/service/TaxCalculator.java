package com.acme.invoices.service;

import java.util.Map;

import org.springframework.stereotype.Component;

/**
 * Region-based tax lookup keyed by the customer's billing country.
 * <p>Rates are held in memory here; the production service refreshes them
 * nightly from the tax provider.</p>
 * @business Tax is charged by the customer's country: VAT in the EU, 20% in
 * the UK, none for US customers (handled by TaxJar downstream).
 * @tag tax
 * @since 1.0
 */
@Component
public class TaxCalculator {

  private static final Map<String, Double> RATES = Map.of("US", 0.0, "DE", 0.19, "GB", 0.20, "FR", 0.20);

  /**
   * Tax owed on {@code netCents} for a customer in {@code country}.
   * <p>Rounds to the nearest cent, matching what the invoice PDF prints.</p>
   * @param country ISO-3166 alpha-2 billing country
   * @param netCents amount before tax, in cents
   * @return tax in cents, never negative
   * @see #treatmentFor(String)
   * @since 1.0
   */
  public long taxFor(String country, long netCents) {
    return Math.round(netCents * RATES.getOrDefault(iso(country), 0.0));
  }

  /**
   * Human-readable tax treatment for a country — printed on the invoice PDF
   * and written to the audit log.
   * @business How tax is handled for this customer, in plain English.
   * @param country ISO-3166 alpha-2 billing country
   * @return a phrase such as {@code VAT 19%}
   * @see #taxFor(String, long)
   * @since 1.2
   */
  public String treatmentFor(String country) {
    String iso = iso(country);
    // @business Pick the wording that matches the customer's tax region —
    // EU VAT, UK VAT, or none charged here.
    return switch (iso) {
      // @business EU member states: VAT at the local rate
      case "DE", "FR" -> "VAT " + percent(iso);
      case "GB" -> "UK VAT 20%"; // @business United Kingdom: standard-rate VAT
      default -> "no VAT (handled downstream)"; // @business US and the rest of the world: no VAT charged here
    };
  }

  /**
   * Raw decimal tax rate for a country.
   * @deprecated Prefer {@link #treatmentFor(String)} for display and
   *     {@link #taxFor(String, long)} for amounts; direct rate access is
   *     slated for removal in <b>2.0</b>.
   * @param country ISO-3166 alpha-2 billing country
   * @return the decimal rate, e.g. {@code 0.19}
   * @since 0.9
   */
  @Deprecated(since = "1.2", forRemoval = true)
  public double rateFor(String country) {
    return RATES.getOrDefault(iso(country), 0.0);
  }

  private String percent(String iso) {
    return Math.round(rateFor(iso) * 100) + "%";
  }

  private static String iso(String country) {
    return country == null ? "US" : country.toUpperCase();
  }
}

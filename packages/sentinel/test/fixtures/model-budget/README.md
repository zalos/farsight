# Legacy model budget fixture

`legacy-6c.db` contains only synthetic envelope, reservation and audit records. It was emitted by the genuine
`BudgetLedger` implementation at commit `6c19aa451cf42e962cc9c3fea2d98c661946c593`, before provider provenance was
stored. No credential, account, source path or client material appears in it.

The fixture retains one held, one dispatched and one uncertain reservation, including their original timestamps,
epochs and event chronology. Migration must preserve these values and charged totals. A missing provider is
unobserved provenance; current settings or a new caller must never supply its historical identity.

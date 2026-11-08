# Individual transaction entry calculation

Status: implemented for approved feedback 71ece96c, pending verification and release.

The individual ledger owns the final transaction amount. Its nullable calculation_method
records explicit entry intent without reinterpreting any historical row.

| Method | Entry | Payroll consumption |
| --- | --- | --- |
| NULL | Existing writer and historical raw input | Preserve the pre-existing catalogue-formula path |
| amount | Entered positive Amount, no quantity | Use saved final amount; bypass formula, catalogue rounding and further proration |
| formula | Positive Qty, Hours, Days or Units | Recompute on save with the linked saved formula; use saved final amount in payroll |

The ledger's existing company, employment, writable-run, period, cycle and permission
checks remain authoritative. The canonical bulk/create-edit transaction revalidates the
method, locks the catalogue and prices each employee's input in that transaction.
The read-only screen preview uses the same pricing owner. A browser-provided calculated
amount is never calculation evidence.

The real selected run/cycle bounds formula sources. Without an explicit cycle, resolve
only the unique configured regular cycle; ambiguous or unavailable context fails closed.
The work date remains on the ledger; the processing month bounds payroll source dates.
Formula evaluation, source permission and exact-money arithmetic remain owned by the
existing saved-formula runtime. Saving a formula requires its existing structural and
dependency validation; optional employee simulation is not an activation requirement.

Final amounts are not formula inputs on a later payroll run. Both payroll generation and
saved-formula simulation read this same method field. The formula identity and immutable
revision reference are retained in the existing reference-only ledger audit event; private
formula values and explanations are not copied into that event.

Old import, fixed-transaction and module writers omit the method and retain existing
behavior. No backfill updates old ledger rows or historical payslips. Existing ledger
rows acquire explicit intent only through an intentional entry edit. Covered by
individual-txn-formula-method.test.ts, actual workspace DOM interactions and the
existing saved-formula and payroll regression suites.

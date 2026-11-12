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

## Amendment 792053e5 — open runs re-price formula-priced rows (11 November 2026)

Approved feedback 792053e5: correcting a Pay Item formula marked the processed run, but reprocessing paid the
amount stored when the row was keyed or imported, so the correction never reached the payslip. The stored final
amount stays the ledger's figure, and it is now re-priced on an OPEN run.

- Each writer stores a pricing marker beside the amount (draft migration 9730): `saved_formula` with the formula
  revision for `calculation_method = 'formula'`, or `pay_item_rule` with the rule's sha256 for a legacy row
  (method NULL) whose Pay Item rule (per hour, per day, Calculated by Formula) produced exactly that amount from the
  row's own inputs. Typed Amounts, Amount-method rows and rows of unknown origin carry no marker and are never re-priced.
- Processing (the whole-run job, its chunks, or synchronous generation) and selective reprocess call
  `repriceIndividualLedgerTx` (packs/payroll/individual-calculation.ts) for the employments being generated, under
  the run's catalogue and company/month keys and before any reader sees the ledger. It reuses the entry pricing
  owners (`deriveIndividualTxnAmountTx`, `priceIndividualTxnInputTx`), writes only when the amount or reference
  changed, and appends a reference-only `payroll.individual-txn.repriced` event per changed row.
- A formula that cannot price a row raises `PayItemFormulaRepriceError`: a reprocess records a Configuration
  incomplete outcome (`PAY_ITEM_FORMULA_FAILED`, Pay Item, dates, reason), keeps the previous result and the
  recalculation mark, so the run cannot close; a whole-run job fails with the named message.
- Closed runs are never generated, so their rows, payslips and events stay exactly as they were.
- Existing rows acquire a marker only through the separate report-first script
  `scripts/mark-individual-txn-pricing-792053e5.ts` (open months, rule unchanged since the row was written, input
  present); the rest are listed for HR review. Covered by payroll-reprocess-formula-792053e5.test.ts and
  792053e5-reprocess-formula-presentation.test.ts.

## Amendment — one owner for `{#Input}`; a Pay Item linked to the Formula Builder (12 November 2026)

Production case NORMAL OT (ONOR): a row keyed as 9.00 hours and priced by the item's inline formula (method NULL,
marker `pay_item_rule`) was processed after the item was linked to a saved Formula Builder formula ending
`* {#Input}`. Payroll built `{#Input}` from the stored amount, so it paid amount × factor, while entry prices a
Formula Builder item from the keyed quantity; reprocess refused the row as "no longer calculates".

- `lib/pay-formula-input.ts` is the single owner of a row's own `{#Input}`, used by entry pricing, re-pricing,
  payroll generation and saved-formula simulation (the formula tester's employee snapshot). The input is the keyed
  Qty, Hours, Days or Units when the amount is a final figure a pricing owner worked out from it (method `formula`,
  or marker `pay_item_rule`); otherwise the saved amount (Amount method, recurring and batch Pay Items, and unmarked
  method-NULL rows, which stay historical raw input). A quantity-input row without a positive quantity in a
  quantity unit has no input and is refused, never priced from its amount.
- `{#PayItemInput}("CODE")` of another item keeps its documented saved monetary amount; it is not the same defect.
- An open run's process or reprocess re-prices a `pay_item_rule` row whose Pay Item now links a Formula Builder
  formula through `priceIndividualTxnInputTx` (method `formula`), and records entry's marker in the same statement:
  method `formula`, `saved_formula`, the formula revision. The reference-only `payroll.individual-txn.repriced`
  event says `reason: 'formula-builder-linked'` with the previous source. Formula failure, a non-positive result and
  a missing quantity still refuse (`PayItemFormulaRepriceError`); there is no fallback to the old amount.
- No saved row or payslip is changed by migration or script. `scripts/report-formula-keyed-input-impact.ts` is a
  read-only report (READ ONLY transactions, named HR administrator, employee code only) of the open-month rows the
  next process or reprocess will move. Covered by payroll-formula-keyed-input.test.ts and pay-formula-input.test.ts.

# ADR-0158 — Explicit manual EPF percentage elections

- Date: 2026-10-29
- Status: Approved product direction in board item 5e204d56; implementation remains subject to release verification.
- Related: ADR-0046 (top-up mapping), ADR-0087 (manual amounts), migration 0678 (journal position owned by integration).

## Decision

Manual (by percentage) is a distinct persisted manual_percentage mode. Both employee and employer rates are required, from 1% to 100%, inclusive, at the existing two-decimal percentage precision. The canonical election validator rejects missing, non-finite and out-of-range rates before any write; a database constraint also requires both stored fractions between 0.01 and 1.

Payroll uses those exact rates on the combined monthly EPF wage rather than applying a Third Schedule floor. The existing whole-ringgit round-up convention is retained using integer cents and basis points. Bonus relief is the difference between the combined-month result and the same calculation on normal wage alone. The explicit manual choice applies across age and citizenship branches, as manual amounts already do; it does not alter automatic selection or determine an employee's appropriate election.

The prior Manual (by percentage) label mapped to voluntary_excess. Existing voluntary_excess rows retain that mode, their rates and their statutory floor. Two-rate rows reopen under Top-up (existing percentage election); employee-only rows remain Semi-Auto. No data migration converts historical elections. Switching an existing two-rate top-up to manual percentage requires a displayed explanation and explicit confirmation on the Personnel form; imported updates remain explicit category changes in the existing import preview.

Auto, Semi-Auto, top-up, exemption and manual-amount calculations retain their previous rules. Every administrative, draft, import and reviewed-source path uses the same mode mapping and election validator. Existing permission, effective-date and audit owners remain in place.

## Verification boundary

Pure and DOM tests establish bounds, required-field messages, retained entries, legacy round-tripping, deterministic arithmetic and age/citizenship behavior. Persistence, migration and generated-payslip tests require the integration candidate with the allocated journal entry. A browser walkthrough and installed-source verification remain separate release evidence. This decision records an operator-controlled calculation capability, not external acceptance of any individual employee election.

## Addendum — board item b6dbadc5 (2026-10-30): no adoption confirmation; additive top-up

Approved by the reporter in board item b6dbadc5. Two clauses above are superseded; the rest of this decision stands.

1. **Confirmation clause reversed.** "Switching an existing two-rate top-up to manual percentage requires a displayed explanation and explicit confirmation on the Personnel form" no longer holds. Choosing Manual (by percentage), entering both rates and saving is the whole decision. The Personnel form's preview and tick box, the server's `epfManualPercentageAdoptionConfirmed` check and their two catalogue strings are removed. Manual percentage calculation is unchanged.

2. **Top-up becomes additive, as its own mode.** Top-up (existing percentage election) persists as a new `topup_percentage` mode (migration 0697). Its two rates, captioned "Top-up Employee Rate %" and "Top-up Employer Rate %", are per-side increments added to the statutory rate that applies to the employee in that month: Part A (employee 11%, employer 13% or 12% by the combined-month wage step), Part E (employee 0%, employer 4%) and the non-citizen/PR-60+ flat 2%. A blank side and 0% add nothing; the result is never below the statutory figure, and the existing whole-ringgit round-up and the combined-month bonus-relief method are unchanged. From age 75 there is no contribution and no top-up. Statutory plus top-up may not exceed 100% on either side: the shared election validator refuses an increment above 100% less the highest statutory rate for that side (employee 89%, employer 87%); the database constraint bounds each stored increment to 0..1, and the calculator clamps at 100% defensively. `voluntary_excess` is not reused: Semi-Auto keeps that mode's total-rate max(elected, statutory) meaning, and sharing the mode would make the two categories indistinguishable on a stored row.

3. **Historical elections are converted once, outside the migration.** The sentence "No data migration converts historical elections" is superseded for two-rate (and employer-only) `voluntary_excess` rows. `scripts/convert-epf-topup-percentage.ts` converts each such row to `topup_percentage` with increment = max(0, stored rate − the statutory rate of that side on the employee's latest processed regular payslip, or for the current salary when there is none), through the existing statutory writer so the before/after election is on the event log, and writes an old/new CSV for HR. Where the old election had no effect (Part E, age 75+), the increment is 0 so the result is unchanged. Employee-only rows (Semi-Auto) and null/null rows are left as they are. Equality is guaranteed at the wage the increment was derived from; an employee whose combined wage later crosses the RM5,000 employer step pays statutory + increment at the new step rather than the old total. The script is read-only unless `--apply`, idempotent, and requires the same release gate and populated rehearsal as any calculation change.

4. **Unconverted rows are protected until conversion.** A stored legacy row reopens under Top-up showing its total rates with a short explanation; re-posting exactly those figures (any Personnel, import or reviewed-action save) keeps the stored legacy election, while any other figure is saved as an additive top-up. Bank & Statutory import history recorded before this change cannot be reverted onto a Top-up election, because its recorded rates are totals.

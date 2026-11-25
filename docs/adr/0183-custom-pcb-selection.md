# ADR-0183 — HR-chosen custom PCB on the employer-scoped Income Tax Resident selection

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Date:** 2026-11-25
- **Status:** Accepted (board d8dc0a8c plan revision 1, approved by the reporter on 25 November 2026).
- **Amends:** ADR-0090 (adds two selection values and their number; nothing else in it changes).
- **Related:** ADR-0091 (person-owned tax circumstance), ADR-0085 (additional-run deltas), ADR-0084 (models propose, services adjudicate).

## Context

HR asked for an employee-level manual PCB control: either a fixed monthly RM amount, or a custom percentage applied the way the Non-Resident 30% is. The request placed "Custom (Manual Entry)" under Tax Category. Tax Category is the person's family circumstance (ADR-0091): it is shared across every employer of the person and feeds reliefs and statutory forms. Income Tax Resident (ADR-0090) is the employer-scoped decision of which PCB method runs. The approved plan therefore puts the two custom methods on Income Tax Resident and leaves Tax Category unchanged.

## Decision

1. `employment_tax_selection_my.scheme` gains `custom_fixed` and `custom_rate` (migration 7390). The selection row owns the HR-entered number: `custom_pcb_amount numeric(12,2)` for `custom_fixed`, `custom_pcb_rate numeric(5,2)` (0 < rate ≤ 100) for `custom_rate`. A check constraint makes a custom scheme without its number, or a number on any other scheme, unrepresentable. Existing rows keep both columns NULL.
2. The only writer is `saveTaxSelectionMYTx` (through the Active Income Tax card and the payroll tax set-up page), with the existing permission (`app.is_admin_for` both companies), locks, version and stale-context checks. A malformed number is refused (`custom_value_invalid`). A custom choice saved without a number keeps the number already saved for the same choice, otherwise it is refused (`custom_value_missing`). Any other choice clears both numbers. The `employee.tax-scheme.selected` event records both numbers before and after.
3. A person-only tax write, the Create New Employee draft and the Excel imports cannot choose a custom method: none of them can carry the number. An import that repeats an employee's saved custom choice changes nothing. Transfer to a new employer starts the new employer at Resident, as for incentives: an employer's custom decision never follows a person.
4. Payroll reads the number with the selection (single and group resolvers alike) and passes it to the MY statutory engine. `custom_fixed` makes the month's PCB the amount itself: no table, relief, TP1/TP3, rebate, zakat offset, rounding or RM10 floor. Because it is the same figure for the month whatever the additional remuneration, the kernel's additional-run delta charges it once a month. `custom_rate` is the Non-Resident working with the HR percentage in place of 30%. A custom scheme without its number refuses (`custom_value_missing`, a per-employee validation failure on reprocess); it never falls back to the standard formula. The payslip's `pcbMeta` records the method and the number used, so history, the PCB detail screen, its downloaded document and the multi-cycle worksheet explain the payslip from its own stamp, never from today's setting.
5. Statutory reports carry the saved PCB amount like any other. CP21 A4 (resident yes/no) reads the person's recorded residency when the employer selection is custom, because a custom method states an amount, not a residency.

## Consequences

Employees on the five existing choices compute exactly as before; the engine test pins byte-identical output with or without a custom number present. HR remains responsible for the amount or rate entered; the system records who set it and when. The existing negative-net-pay check stops a run for review when a fixed amount exceeds the month's pay; the amount is never adjusted.

Not in this decision: the custom number is not a Personnel report/export column and not an import column (the employer selection owns it; a follow-up may expose it). The Create New Employee draft does not offer the custom choices.

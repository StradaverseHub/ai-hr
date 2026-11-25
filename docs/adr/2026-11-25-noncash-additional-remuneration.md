# BIK and VOLA may be Additional remuneration for PCB (amends ADR-0090)

Status: accepted by the owner, 25 November 2026 (board item 8edeef41). Reverses the owner ruling of 24 November 2026
that BIK and VOLA stay Normal with no Additional route.

## Context

ADR-0090 records, in its decision section: "BIK and VOLA are noncash normal-remuneration tax inputs with exemptions
applied by their authoritative owner once." The kernel therefore refused a taxable BIK/VOLA pay item whose Remuneration
Type was not Normal (`normal_remuneration_required`), and the Pay Item form locked the field to Normal.

The repository's copy of the LHDN specification (`docs/forms/pcb-spec-2026-computerised-calculation.pdf`, section E,
items 11 and 12) describes BIK and VOLA "as part of his monthly remuneration" for which MTD is deducted "as per normal
remuneration", and says the amount "shall be treated as part of Y1". The specification does not describe an
additional-remuneration route for BIK/VOLA.

The reporter's BKBOP item (a one-off benefit buyout) is, in the company's view, a payment in addition to normal
remuneration for the month. On 25 November 2026 the owner accepted that a company may choose, per pay item, to treat a
taxable BIK/VOLA item as Additional remuneration. This is a company choice recorded on the item, not a claim that the
specification requires it.

## Decision

1. A taxable (Subject to PCB) BIK/VOLA pay item has Remuneration Type Normal or Additional. Normal is the default for
   new items and keeps today's behaviour exactly. Optional Deduction is not available for a benefit
   (`remuneration_type_not_supported`). EPF Bonus 2012 stays refused (`epf_bonus_not_allowed`). The retired
   `normal_remuneration_required` reason is no longer produced; its stored codes and messages stay decodable.
2. Additional flows through the existing section D.2 additional-remuneration path and nothing else: its taxable amount
   joins Yt, so the year's tax is worked out with and without it (P2 against P1) and the difference is the additional
   MTD. It contributes nothing to Kt (Kt = 0 for the benefit) and nothing to EPF, SOCSO, EIS, SKBBK or HRDF. No PCB
   table, rate, rounding rule (truncation, 5-sen rounding, RM10 floor) or calculation order changes.
3. Saved payroll owns its working. The PCB noncash snapshot (`statutory.pcbNonCash`) gains version 2, which records a
   `stream` (`normal` or `additional`) on every PCB entry. Version 2 is written only when at least one entry is
   Additional; a month with only Normal benefits is still written as version 1, byte for byte as before. A version 1
   snapshot is always read as all Normal (Y1) and is never re-derived from today's pay item setting. The snapshot
   totals (`owned`, `cumulative`, `before`, `current`) stay totals across both streams, so `bases.pcb` and the
   accumulated Σ(Y − K) fold are unchanged.
4. In a month with several runs, an Additional benefit sits only on the side of the delta of the run that owns it. A
   later run carries an earlier run's Additional benefit on both sides as Yt; it is never re-folded as normal
   remuneration. A recurring benefit carried from the saved regular run keeps the stream that run saved.
5. The same per-item stream is followed by regular and additional runs, restating regular runs, reprocessing, the Pay
   Item import, payroll history import, historical tax-basis replay and recalculation (the latest Pay Item
   classification applies, as for cash items, ADR-0167), and the multi-cycle worksheet. The tax-basis comparison adds the
   stream only for Additional entries, so every existing preview and saved revision still compares equal.
6. EA B3/B4 reporting reads the EA entries only and does not change. CP39 continues to report each employee's total MTD.
7. The PCB detail shows an Additional benefit under Additional remuneration and a Normal benefit under the current
   month's remuneration.

## Consequences

- A company that chooses Additional for a benefit takes responsibility for that treatment; the system records the
  choice on the pay item and on each saved payslip that used it.
- A change to the setting applies the next time an open month is processed or reprocessed. Closed payroll, payslips and
  statutory records are never changed.
- Verification: a worked PCB example for one fictional employee and month, computed with the benefit as Normal, as
  Additional, and by hand from the D.2 formula, with the arithmetic written out in the test.

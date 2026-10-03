# ADR-0091 — Person-owned MY tax circumstance and saved PCB applicability

- **Date:** 2026-10-03
- **Status:** Accepted after verified release 90ae09d1.
- **Raised by:** feedback `17a9b724-8e04-4e99-a099-de3c76f2a02a`, approved plan revision 1.
- **Related:** ADR-0006, ADR-0009, ADR-0020, ADR-0085 and ADR-0090. Extends ADR-0090; employment/employer tax selection remains its owner.

## Decision

The existing person statutory profile owns one nullable detailed circumstance: Single, spouse not working, spouse working, widow/divorced, or explicit None. Taxable circumstances map to the existing mathematical categories 1/2/3/3. None owns PCB non-applicability; it is not a new numeric category or tax rate. Its prior taxable integer stays dormant. Requested Category 1 wording carries the adjacent LHDN classification reminder; child-relief choices do not redefine marital classification.

The employment/employer record continues to own resident, non-resident, REP, Knowledge Worker and C-suite selection. A person applicability epoch advances only on an actual None↔taxable transition. Explicit employer selection acknowledges that epoch through the existing Income Tax Resident field in the same authorized save transaction. While None is active, stored employer selections remain inactive history. Returning taxable requires each affected employment's current authorized choice; it cannot silently revive a previous incentive. This is an applicability boundary, not a new eligibility declaration or approval workflow.

Person, employment and advisory locks follow one order; saves derive current context and refuse stale employer/version/epoch intent. Compatible omitted identity from legacy partial writers is preserved. A deliberately conflicting numeric taxable edit retires detailed identity; it does not guess a replacement. Migration 0509 introduces nullable identity and zero-default epochs without inferring detailed choices from existing rows.

Payroll resolves the person snapshot before PCB eligibility routing. Explicit None skips PCB formulas and returns zero normal/bonus PCB while existing EPF, SOCSO, EIS, zakat and other payroll owners continue. Saved incompatible manual PCB overrides are suppressed with truthful provenance, preserving stored audit; new contradictory PCB overrides are refused. Taxable formulas and scheme routing remain unchanged.

A saved payslip owns the circumstance, mapped calculation category and applicability used for that attempt. None has a null saved calculation category. Detail, download and multicycle replay consume this saved truth rather than today's person profile. Legacy category 1 never implies None; legacy category 3 never implies widow/divorced. Legacy output uses its recorded integer or reports identity unavailable. Present malformed or contradictory snapshots are unavailable rather than treated as absent legacy history. Reads and later profile edits do not recalculate earlier payroll.

## Consequences

The UI can distinguish choices with identical statutory math and retains the selected wording on save/reload. One person applicability decision reaches every consuming employment without overwriting another employer's scheme record. Epoch/version races, partial numeric writers, transfer initialization, manual adjustments and historical consumers require integration coverage alongside exact monetary controls and native page/download evidence.

The application records an authorized choice; it does not establish statutory eligibility or certify payroll. Historical repair needs separately authorized employee/run evidence. Production employee-specific review, historical backfill/recalculation, new statutory formulas, gross-up work and changes to the existing document-language policy are outside this decision.

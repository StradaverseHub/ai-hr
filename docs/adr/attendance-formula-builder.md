# Attendance Formula Builder ownership

Status: implementation in progress; not installed or accepted.

The approved board item dff30880 adds company-scoped Attendance formulas. The reporter answered that Zone A means Before Shift and Zone B means After Shift, and removed Callback Overtime. The machine IDs of the 130 retained variables remain unchanged. The five removed IDs are rejected by validation. Before/After Shift labels replace the old zone labels in business-facing text.

The Payroll expression language owns bounded parsing, exact decimal arithmetic, deterministic execution and ordered trace events. An explicit closed Attendance dialect shares that engine. It does not extend the Payroll variable registry. Formula and condition references form one bounded acyclic immutable version plan; a condition returns exactly 0 or 1. The formula editor cannot execute JavaScript, SQL or arbitrary functions.

Canonical Attendance owns clocks, shift anchoring, positioned breaks, approvals, actual work and dated calendar classification. Effective Personnel and Leave owners retain their facts. The variable catalog records units and period aggregation; missing evidence is unavailable, never a synthesized zero. Additive duration/count fields sum across ordered dates. Nonadditive fields require an invariant value; date fields select the period's final date. Mixed classifications require a daily formula instead of silently selecting one day.

Daily, weekly and monthly periods use the HR date utilities. Weekly cutoffs are inclusive Monday–Sunday. A monthly cutoff absent in a short month uses its final real date. The next period begins the following date, preserving complete nonoverlapping coverage.

Formula versions, test evidence and results must bind the exact canonical source and eligibility versions. Only an authorized administrator can activate a successfully tested version. AI proposes source from code-owned descriptors; it cannot activate, calculate authoritative pay or receive actual employee attendance values.

ADR-0134 remains binding: overtime cash and TOIL retain the existing parent source and unique settlement, with canonical replay and jurisdiction floors. Attendance Formula Builder does not authorize another money ledger or individual payroll transactions. Non-OT allowances and deductions must retain the existing attendance-to-payroll source reconciliation owner. Integration and rendered acceptance remain required before this item is complete.

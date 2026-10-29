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

# ADR-0090 — Employment-owned MY tax selection and saved statutory provenance

- **Date:** 2026-10-03
- **Status:** Accepted; production verified in r382–r383.
- **Supersedes:** ADR-0089 prospectively; its historical declaration facts remain retained.
- **Related:** ADR-0006, ADR-0009, ADR-0020 and ADR-0085.

## Decision

One employment/employer record owns the MY tax category: resident, non-resident, REP, Knowledge Worker or C-suite. HR explicitly confirms the selected category in the reviewed employer context. The application records that human decision; it does not grant legal eligibility or infer it from title, citizenship, salary or person-wide flags. Version and actor changes are audited. Payroll reads this owner rather than consulting competing profile flags or an active declaration lookup.

An unambiguous legacy context converts with recorded provenance and no invented human actor. An ambiguous context is confirmation-required and refuses processing until resolved. Hire and transfer use the same transaction-owned category contract; incentives do not follow a person into another employer. Category changes and payroll acquire stable employment locks, using NO KEY UPDATE where audit foreign-key checks require KEY SHARE compatibility.

Saved payroll owns the category, version and statutory working used for that run. Reads, profile changes and new selections do not rewrite historical results. Original declaration records and saved declaration-based working remain readable under their original method. Incomplete or contradictory provenance is unavailable rather than reconstructed from today's category.

Versioned Q/C/QC working preserves the exact supported child fractions and verified annual Q. BIK and VOLA are noncash normal-remuneration tax inputs with exemptions applied by their authoritative owner once. Saved EA contribution provenance controls their independent statutory boxes; missing historical inputs are unavailable. Neither an EA display nor an AI explanation creates money or eligibility.

## Consequences

The direct selector satisfies the approved revised workflow and removes two competing eligibility owners for new payroll. It deliberately retains prior history and refuses unresolved conversion rather than assigning a convenient fallback. Any future incentive workflow must integrate with this owner and preserve explicit human accountability. Historical repair requires separately authorized, specific evidence and cannot be inferred from synthetic cases.

Verification must cover context/version races, exact monetary and noncash cases, legacy conversion refusal, transfer behavior, historical consumer parity, actual six-locale screens/documents, named source reversals, the complete counted gate and production migration/source arrival.

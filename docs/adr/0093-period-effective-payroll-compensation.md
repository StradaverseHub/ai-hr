# ADR-0093 — Resolve payroll compensation by period and preserve its saved salary basis

- **Date:** 2026-10-03
- **Status:** Accepted after verified production arrival.
- **Related:** Feedback de955416-6a4c-486a-bc16-ed17f86ec846; ADR-0036 snapshot immutability; ADR-0078 employee pay structure; core/comp.ts, core/payroll.ts, core/pay-components.ts, core/payroll-readiness.ts and core/back-pay.ts.

## Context

A salary of RM10,000 effective 1 August 2026 followed by RM15,000 effective 1 November must supply RM10,000 to August–October payroll and RM15,000 from November. Reading only the open compensation revision instead selected the already-entered future salary. Salary selection also owns allowance, pay mode, rate and currency: taking these from different revisions would create a payroll input that HR never saved.

The owner's standing instructions authorize work on actionable open board items, publication and automatic deployment. This is the owner's authorization, not a claim that the reporter separately approved the plan. Release acceptance and production arrival must still be evidenced independently.

## Decision

Compensation remains the authoritative employment-owned record. The shared compensationEffectiveOn predicate selects the non-superseded whole revision effective at the ordinary payroll calendar month's final day: validFrom <= referenceDate and validTo > referenceDate, or an open validTo. Compensation ranges are exclusive at their end. Existing caller tenant, employment and company authorization remains in place. A future revision supplies no earlier salary; a genuine applicability gap remains missing and processing refuses it rather than falling forward.

Generation, explicit reprocessing and dated dependent salary readers consume this same selection contract. Existing formula evaluation, statutory mathematics, increment-proration policy, hire/termination and employer-segment proration, salary cutoff windows and manual inputs retain their owners. This decision does not substitute a termination date, segment end or cutoff end for the ordinary month-end salary reference. The undated currentCompensation and effectivePayStructure administrative readers retain their current Personnel revision contract.

Each newly generated payslip saves statutory.salaryBasis version 1: referenceDate, compensationId, effectiveFrom, basicSalary and payMode from the selected compensation row before existing proration. The stamp records an input; it is not a new salary owner or a replacement calculation. It is written by explicit processing, including explicit reprocessing, and never inferred onto untouched historical slips.

Back-pay uses a valid present salaryBasis as the historical monthly baseline while retaining the paid payslip amount as the monetary anchor. Absence retains the previous latest-visible historical reconstruction contract only when its visible baseline does not start after the paid period. A future-start legacy baseline requires review without an automatic amount; it does not establish the old proration denominator. Current validTo is not used to reject an old baseline because a later correction can close that row. No old slip is guessed to have used the new period-effective selection. Present malformed or unusable evidence requires review and supplies no automatic payable adjustment. Canonical dates, reference date, version, identifier, amount and mode are validated. Existing blended-history, nonmonthly and unpaid-leave refusals remain conservative; this decision does not extend their calculation scope.

Saving compensation does not recalculate processed payroll, alter issued payslips or rewrite result history. No schema migration or salary-basis backfill is introduced. Historical corrections require the existing explicit authorized workflow.

## Verification contract

Actual synthetic processing must distinguish the reported future revision from the applicable revision across August–November, multiple changes/reductions, whole-record structure/rate/allowance inputs, typed and legacy earnings, dependent transaction formulas, OT, explicit full/selected reprocessing and additional runs. Genuine gaps must refuse before saving money, and failed selected corrections retain the prior result.

New saved-basis arrears must remain correct with an already-visible future salary; absent nonfuture legacy evidence must preserve its previous behavior while a future-start legacy baseline must require review without a priced adjustment and malformed present evidence must produce review without an amount. Closed results remain unchanged. Exact monetary goldens remain exact; comparisons across distinct synthetic employees may normalize only independently validated ownership identifiers while retaining every other input and statutory field. Final gate, TypeScript/build and actual production arrival remain separate claims.

## Consequences

Entering a future salary no longer changes earlier payroll inputs. Whole-record selection prevents mixed salary/structure provenance. New slips explain which salary revision supplied their baseline; legacy history remains truthful about its earlier contract. Existing unsupported arrears cases stay under review. No live personnel/payroll audit, payroll certification, automatic historical correction, formula redesign, TOIL valuation change or global change to current-record administrative displays is authorized by this decision.

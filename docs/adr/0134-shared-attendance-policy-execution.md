# ADR-0134: Execute dated attendance policies under one overtime source

**Status:** Accepted implementation direction; implementation and acceptance remain incomplete
**Date:** 2026-10-21
**Deciders:** Codex for implementation within the reporter-approved Schedule Group and central Overtime plans

## Context

The approved items `7500c083-13f3-47a1-9199-634f73463fe6` and
`dc2fee3a-3155-43d6-9dad-6f5195c2b253` require one dated policy for clock pairing,
grace, overtime eligibility, approval method, rounding and five day-specific central formula references.
Enabled midnight splitting uses the actual calendar classification of each portion of one source.
This is not permission to change recorded attendance, pending approval routes or settled money.

FACT: the current calculation header holds one formula version and one real central assignment.
`resolveOvertimePatternTx` restores those identities from recorded calculations.
`core/payroll-overtime-pattern.ts` independently checks recorded inputs against fresh canonical inputs,
replays the exact formula, checks every persisted line, and verifies duration, currency, mappings,
country/policy floors, run scope and cutoffs. It currently accepts only the existing raw-input shape.
An active settlement is unique by `attendance_overtime_source.id` across cash and TOIL.

FACT: the prepared policy history and interval/clock helpers are not yet connected to that execution
path. Their focused checks do not establish that the new settings govern attendance or pay.
The policy UI and its activation must not be released as a complete replacement while that is true.

## Decision

Retain Attendance's existing parent source and settlement identity. Add an explicitly discriminated
policy-execution evidence contract, with immutable dated calculation parts beneath that parent.
The policy history owns group choices; central Overtime versions own formulas; canonical Attendance
owns actual evidence and final-effect authority; Payroll and the jurisdiction pack retain money and
floor checks. Parts are derived evidence, not independently payable attendance sources.

1. Expose the existing group-policy owner through `packs/attendance/service`, alongside the existing
   Attendance calculation owner. Its implementation may remain in its current core module under
   ADR-0080's existing pack boundary. Runtime readers must use this same owner, rather than copying
   the policy query into another calculator. A physical move is not required to establish ownership.
2. An uncovered historical date stays in the existing legacy path. A new explicitly scheduled policy
   records the execution contract, effective date, enabling actor and reason. Schema version and
   calculation-contract version are separate concepts. Do not add behavioural defaults to old groups.
3. The canonical reader establishes the subject, dated employer, resolved Schedule Group, timezone,
   raw punches, boundaries, breaks and calendar provenance. Forms cannot supply these as trusted
   facts. Keep raw and unmatched/duplicate/close evidence. Missing required proof is a refusal, not
   a zero or an invented clock boundary.
4. Derive eligible interval coverage through the existing schedule/break owners. Apply any configured
   late offset once, select the approved policy method using evidenced planned intervals, then apply
   minimum, rounding and maximum in the approved order. Do not apply legacy duration rounding again.
   Central money rounding stays with the formula owner. Duration-only legacy evidence remains on its
   existing path; it cannot manufacture positioned intervals for a new intersection or split rule.
5. With splitting enabled, partition the evidenced parent timeline into local calendar-date parts.
   Resolve each part's Normal/Off/Rest/PH/Replacement-PH provenance through existing owners. Retain
   the approved distinction between Off and Rest without changing Off's legacy money classification.
   Unknown replacement-holiday designation refuses a differentiated binding. Each part references
   the exact immutable policy and permitted central formula version used for its classification.
6. A policy binding is not a normal central-pattern assignment. Never put a policy revision UUID in
   `assignment_id`, create an invented employee assignment, or weaken the existing foreign keys to
   make that substitution pass. The new evidence discriminator must distinguish both binding kinds
   explicitly, with typed readers and database-enforced identity/reference checks.
7. Replay each part with the same central formula engine. Store its input, formula identity, ordered
   duration trace, exact results and stable parent-relative line identities. The parent records the
   common source/revision/digests and complete ordered part set. No part can be omitted merely because
   it failed; an incomplete comparison of input coverage cannot become transferable money.
8. Extend the existing canonical Payroll binding check to re-read policy inputs, validate the whole
   recorded partition and replay each part before accepting their exact aggregate. Preserve current
   grants, currency/mapping checks, country rest/holiday base-day legs, policy floors/caps, regular-run
   scope, cutoffs, closed-run protection and stale-input refusal. Do not route these amounts through
   ad-hoc individual transactions or introduce another money ledger.
9. Reserve or release cash/TOIL through the existing parent settlement owner. Daily and monthly
   presentation consume the same immutable contributions and cannot reserve another claim. Extend
   coverage checks in that owner where needed to reject a rival parent's overlapping interval claim;
   one unique parent settlement alone does not prove cross-source interval coverage is unique.
10. Existing submitted/pending workflows keep their frozen method and route. New deterministic Auto
    outcomes require a canonical receipt bound to the enabled policy, actual evidence and source
    revision, integrated with ADR-0121 final effects. They are not synthetic human approvals.
    An unclocked exception still needs the approved scoped HR attestation and immutable worked-period
    proof; an ordinary request, an Auto setting or a preview cannot supply that attestation.

The parent retains its canonical payroll attribution and cutoff identity. Calendar splitting does not
itself authorize moving a source into a different payroll run, employer or month. A conflict with the
existing cutoff/ownership proof must refuse explicitly until canonical evidence supports the operation.

## Options considered

| Option | Complexity | Integrity and replay | Decision |
| --- | --- | --- | --- |
| Override the selected formula ID in today's single-assignment input | Low apparent cost | Cannot represent several dated versions; breaks the assignment FK and replay contract | Reject |
| Generate hidden assignments or copy all chosen formulas into a synthetic composite pattern | Medium/high | Adds configuration projections that must remain synchronized and hides which real binding authorized each portion | Reject |
| Create a new source and settlement for each midnight child | Medium | Competes with the parent's cash/TOIL identity and can duplicate next-day claims | Reject |
| Immutable calculation parts below the existing source and settlement | Higher implementation cost | Makes each binding and partition explicit while preserving one financial owner | Select |

## Consequences and limits

This is a financial-owner change and requires the classifier's full verification path, fresh migration
checks, populated restricted-owner rehearsal and actual app journeys before release. It does not make
the existing policy prototype complete. New storage belongs to the centrally reserved, still-unapplied
0576 migration; applied production migrations remain unchanged. Home owns 0577, and other sessions'
later reservations must follow in ascending order.

UNKNOWN pending implementation investigation: complete planned-window placement for existing request
types; exact cross-source coverage representation for ordinary and Full Flexi evidence; provenance
available for designated replacement holidays; final-effect receipt extensions needed by each frozen
workflow. Existing canonical owners must settle those facts. Do not invent missing historical evidence
or weaken their guards to get a successful calculation.

## Required implementation and evidence

- [ ] Map each approved control to its stored owner, execution consumer, preview and immutable trace.
- [ ] Add the policy-execution discriminator, part/reference constraints, explicit app grants and RLS;
  preserve the original single-pattern contract and all recorded rows.
- [ ] Connect pairing/grace, eligibility, approval receipts and the ordered interval/duration pipeline.
- [ ] Connect per-date bindings, formula replay, parent aggregate and overlapping-coverage refusal.
- [ ] Verify Payroll/TOIL settlement, floor/base-day semantics, cutoffs, concurrency, retry and both
  presentation modes with the same underlying contributions.
- [ ] Demonstrate unchanged legacy results, frozen manual workflows, all new boundaries, financial
  denials and unknown-evidence refusals; finish six-locale/mobile/keyboard/light/dark app journeys.
- [ ] Finish migration rehearsals, strict TypeScript, the required authentic gate, official release and
  production arrival/health checks before marking either board item deployed.

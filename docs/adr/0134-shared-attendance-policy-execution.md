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
the existing policy prototype complete. New execution storage belongs to reserved, still-unapplied
0590; the original 0581 policy-history migration is frozen and remains unchanged. Home owns 0582. The original unshipped
0576/0577 feature allocations were moved so Feedback Automation can release independently: Security
owns the standalone shared current-principal proof in 0576, followed by its 0578–0580 reservations.
Attendance and Home consume that one helper definition; they do not recreate it.

## Execution storage staging and migration order

Feedback Automation centrally reserved 0590 at `1791900000070`. To preserve the user's deployment order
(Feedback Automation, Board 1, Board 2), Board 2 retired its unregistered/unapplied 0587–0589 reservations
and moved those three drafts to 0591–0593. No retired entry belongs in the journal. Board 1 must not ship
unfinished Board 2 SQL merely to cross its watermark. The eventual ascending union is the deployed
Security prefix, Board 1's 0581–0586 and 0590, then Board 2's later release. 0590 remains unregistered and
unapplied while this implementation is incomplete.

The first storage stage adds an explicit binding discriminator and immutable date/class/version parts
under the existing calculation and source. Existing calculations receive the unambiguous assignment
discriminator; the original 0551 identity check, evidence guard and settlement remain intact. Policy
headers are deliberately constrained to refused, non-transferable outcomes at this stage. A prepared
proposal cannot become cash or TOIL by asserting an approval field. This is an implementation boundary,
not completion of the approved execution/Payroll scope; it must be replaced by the complete canonical
receipt and independent financial replay contract before those outcomes can be enabled.

Each part retains parent-relative whole-minute intervals, calendar references and the exact central
version selected by that policy day classification. Part counts are declared by the header, checked
at commit for a contiguous complete set, and checked for overlapping parent intervals. A rounded count
without physical allocation remains in the proposal's class-level evidence; it is not given a fictional
part/date or added to a part's positioned allocation. Database constraints establish storage structure,
not the truth of calendar-reference strings or final-effect authority. Canonical readers and receipt
writers must still establish and freeze those facts; actual DB probes, migrations and app journeys are
unrun while the shared resource reservation remains with Feedback Automation.

UNKNOWN pending implementation investigation: complete planned-window placement for existing request
types; exact cross-source coverage representation for ordinary and Full Flexi evidence; provenance
available for designated replacement holidays; final-effect receipt extensions needed by each frozen
workflow. Existing canonical owners must settle those facts. Do not invent missing historical evidence
or weaken their guards to get a successful calculation.

## Persisted standard starting entries

The workspace initializes missing standard entries through an authenticated POST after mount, under
the shared Access/profile barrier, verified current principal, existing configuration lock and current
company authority. A rendering GET or link prefetch does
not write configuration. Each tenant/company/starter tuple has a stable namespaced UUID and code.
Repeated visits and concurrent tabs create the same four identities; subsequent edits and archival
are retained. A collision refuses atomically rather than adopting or rewriting an existing pattern.

The initial version stores an exact, explicitly tagged starting-draft document, **not** an executable
formula with guessed accumulation, attribution, currency, eligibility or divisor. The editor asks HR
for both duration choices before constructing the normal typed draft, then saves that definition
through the existing draft owner with the original identity and expected revision. Existing activation
validation rejects the starting document. No activation, assignment, policy binding, attendance, pay
or historical version is created by initialization. Each new draft and its actual actor are audited
in the same transaction. Database/lifecycle and actual-app verification remain required.

## Shared duration proposal sequencing

The central workspace now consumes the same policy-history owner for an explicitly selected, scoped
company and Schedule Group. It reviews clocking choices, saved approval/rounding controls and all five
day-specific version references without writing configuration. Formula labels come only from versions
bound to that employer, and a missing readable binding stays unavailable. Current, future and earlier
versions remain distinct; a missing group or failed read is not labelled legacy. This read surface does
not complete the new execution path or replace the existing editors. Its database, DOM and actual-app
verification remain outstanding while Feedback Automation owns the shared resources.

The dated policy mutation also joins the shared Access/profile barrier before checking current scope
and taking the overtime configuration lock. A queued edit must re-prove authority after a preceding
revocation. This uses the same canonical helper as starter initialization; it does not define another
authority lock or alter the frozen SQL. The prepared concurrent grant-revocation test remains unrun
until the shared resource handover.

`packs/attendance/policy-duration.ts` coordinates the existing interval, partition and duration owners.
It receives canonical worked coverage, already selected actual/plan eligibility, positioned unpaid breaks,
net measured lateness placement, the resolved calendar and the selected central versions' explicit
count-allocation directions. It never reconstructs positions from scalar approvals or clock labels.
The caller must first prove complete clock evidence or the separate HR-attested exception, approval
receipt, frozen method, source identities and current authority. The function itself grants none of these.

Breaks are unioned and removed once. Measured late placement excludes the same unpaid minutes before
its offset is consumed from earliest candidate eligibility. Actual and Intersect use actual candidate
coverage; Intersect then restricts that offset coverage to the approved planned windows. Pre-Approved
uses evidenced plan eligibility on a separately established worked day and consumes its one offset on
that candidate basis. A manual proposal needs an approved receipt and explicit frozen method; Auto
needs the policy-auto receipt branch and the method in the selected version. Missing evidence refuses.
These are arithmetic inputs, not new receipt authorities; the existing final-effect owner must prove them.

Partition the selected coverage through the existing calendar owner. Finalize minimum/maximum/rounding
once across each business-day classification total, with the applicable approved-plan ceiling. Allocate
counts inside proved coverage using the selected central version's explicit direction. Any rounded
count beyond physical coverage stays explicitly unplaced. It does not extend a clock span or acquire a
calendar date, rate, cash claim or TOIL claim by inference. Canonical count attribution and Payroll replay
must still account for it before transfer. The proposal is deliberately distinct from a ready financial
result. Runtime writers, receipts, storage, financial replay and actual-app verification remain incomplete.

## Clock precision adapter

New second-bearing policy evidence validates close events and pairing with exact integer seconds before
projecting onto Attendance's existing whole-minute boundary arithmetic. The seconds and minutes adapters
share one closed-pair/flag processor. The source owner still proves absolute subject/day placement; this
adapter cannot infer a date from a clock label. A 59-second gap across a minute boundary remains too
close under a one-minute rule. Distinct seconds in the same minute are not duplicate events. Complete
sub-minute pairs remain in the exact evidence while contributing no invented minute interval. The old
Full Flexi processor and existing minute adapter retain their established treatment.
The captured-clock entry point derives worked coverage from this evidence and intersects it with the
canonical schedule's eligibility windows before calling the shared duration coordinator. Flagged,
unmatched or missing clock placement cannot be replaced by a posted worked envelope. Enabling the
unclocked setting alone does not attest missing work. This remains proposal arithmetic; source writes,
new approval receipts, immutable evidence and Payroll acceptance are still separate unfinished work.

## Temporary execution routing fence

The actual raw-day refresh now detects a dated policy using the saved Attendance Schedule Group and
Personnel's proven employer for that date. A policy from another employer cannot opt this subject in.
Missing employer or schedule evidence cannot establish legacy absence when a visible dated policy may
own the day. Detection rechecks the actual principal rather than accepting a claimed role or form ID.
The canonical Attendance reader freezes the exact selected policy into its transaction-bound input
snapshot. The existing calculation factory now records that policy identity and snapshot beneath its
original single source, with an explicit refused/non-transferable header and no payable lines or parts.
The policy participates in preparation/re-read freshness and the reference digest. This bypasses old
assignment selection rather than pricing the new policy through unrelated legacy arithmetic. Independent
Payroll and TOIL input readers continue to refuse this staged policy until execution, immutable approval
receipts and financial replay are complete. Existing legacy snapshots and reference digests stay unchanged.

The existing durable refusal marker remains even when the policy identity is recorded: preserving a
refused immutable header is not proof of completed execution. Raw punches remain intact and unresolved
Payroll coverage continues to refuse the day. Already applied scalar plan reassertions must also refresh this marker; both clock-out
and terminal import otherwise skip the usual refresh after that branch. A scalar plan is not an exact
policy-work approval receipt. This is a safety staging boundary, not completed disabled-policy behaviour,
policy arithmetic, acceptance evidence or permission to release the four items. Actual policy writers,
zero and payable outcomes, immutable parts, approvals and independent financial replay remain required.
The prepared routing regressions remain unrun while Feedback Automation owns the shared resources.

## Retained physical capture source

A dated-policy input snapshot reads the existing capture receipt for every effective punch and binds
its tenant, employment, attendance day, direction and saved clock label. It retains the actual server
instant and absolute milliseconds on the already established HR-local source timeline, with a three-day
bound. It does not infer an overnight date from a label, creation order or `created_at`. Manual/imported
clocks without these receipts remain explicitly unavailable here until their own canonical positioned
proof branch is implemented. Their raw records remain unchanged.

These source-only facts participate in the same input digest, preparation/re-read freshness and immutable
calculation evidence. They contain no photo, location, private message or salary content. Milliseconds
are preserved for minimum-gap checking; the existing integer-seconds adapter cannot be fed a prematurely
rounded instant. A millisecond adapter now checks close/duplicate/pair evidence before minute projection. The canonical
snapshot retains this proposal review only for an explicitly recorded fixed-clock/elapsed-envelope owner;
Full Flexi, duration-only and unproved owner kinds are not passed through that generic pairing branch.
A 59.950-second gap across midnight remains close even where flooring both instants to seconds would
make it appear to be 60 seconds. Actual worked-result writes, Full Flexi owner integration, grace,
positioned breaks, approval, policy parts and financial replay still remain unfinished. Retaining capture provenance establishes no payable effect.

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

# ADR-0123: Versioned Overtime Patterns and source settlement

**Status:** Accepted direction; implementation and verification pending  
**Date:** 2026-10-16  
**Deciders:** Reporter-approved fcc2ea42 plan; integration architect for the implementation decisions below

## Context

FACT (source inspection): Schedule Group currently owns the working week, ordinary absence, lateness, exceptions and legacy OT bands. `attendance.otMinutes` is already shaped by eligibility, rounding, manual rows and approved decisions. Payroll prefills classified days into one aggregate and also consumes generated individual transactions. TOIL-first exclusion exists; that aggregate cannot prove which day was paid in the cash-first ordering.

The approved request requires selectable conditions and formulas, assignments, immutable history, mapped approved payments, duplicate protection and cash/TOIL exclusivity. A second schedule resolver, re-deducting final legacy minutes, or producing transactions that Payroll does not actually consume would violate that request.

## Decision

### One configuration selection and bounded calculation owner

New formula patterns are independent of Schedule Group. A dated assignment selects one immutable activated version at the OT stage. The existing schedule resolver continues to own ordinary work, absence and lateness. Individual assignment ranks above group assignment; within that rank, the higher required integer priority wins. Equal winning priority is a conflict. An unknown candidate refuses when it could change or tie the winner; a lower-ranked candidate cannot displace a proven individual winner. Only a proven no-match permits the existing resolved legacy rule as fallback.

The one client-safe typed engine owns AST validation, dimensional checking, exact rational arithmetic, conditions, assignment precedence and evaluation. Storage and UI consume it. No arbitrary code, dynamic SQL, binary-floating money calculation or ID/order tie breaker is accepted. Finite limits bound definitions, tree depth/nodes, candidates, sessions/segments, arithmetic size and operations. Explicit currency accompanies money literals and earning mappings; mixed currencies refuse.

New formula raw input is canonical recorded worked duration before legacy OT shaping, with actual/required/late measurements separately available. An explicit eligible-duration expression defines which of those minutes qualify. The engine does not invent an employer formula or rate. A required day/session eligibility basis prevents subtracting daily normal work once per session. Null eligible expression uses the supplied candidate duration, which the editor and trace must identify. Raw, eligible, approved and payable quantities stay separate. An independently evidenced approval bound limits payable duration. Pending, rejected or unknown approval cannot transfer; the existing approval owner determines whether approval is required.

The stage order is named base transformation/cap; eligible duration; independent approval bound; minute deductions and zero floor; explicit duration rounding and approval re-bound; rates/tiers; targeted money deductions and zero floor; configured payment cap; explicit money rounding. A deduction resource cannot be consumed again through another rule ID, session, or unit. Flat charges have an explicit day/session/tier/slice basis and stable identity. All positive payable slices need an unambiguous configured rate/mapping.

Qualifying counts do not by themselves locate overtime on a recorded interval. A required, explicit earliest/latest allocation policy attributes eligible, approved, deducted and rounded counts across recorded partitions and time bands. For example, 600 worked minutes less 480 required minutes can attribute 120 qualifying minutes to the beginning or end according to that chosen policy; the backend chooses neither. Trace distinguishes policy attribution from physically approved intervals. Clock eligibility compares original recorded work boundaries, with gaps excluded from duration, rather than pretending those boundaries are derived overtime endpoints.

The same internal duration stage serves cash calculation and a separate immutable duration outcome. Missing salary used only in pricing can refuse cash while retaining proven payable duration for the canonical TOIL owner. Salary required by eligibility or duration remains necessary. Duration metadata contains no salary or payment amount; complete evidence remains separately financially scoped. TOIL must still establish freshness, its own policy, consent and source exclusivity before banking credit.

Payroll policy and jurisdiction remain subsequent canonical owners. A configurable wage-base cap is not the statutory wage-eligibility gate. Rate, hour and amount policy caps, mapped-item statutory character and actual cycle routing must be evidenced in the final payment.

### Honest historical evidence

Facts are Known with recorded/effective-dated provenance, or Unknown with a finite reason. Mutable current Personnel axes cannot establish a past grade, division, branch, region, line, section, team, base or category. Capture prospective context at the actual current-day attendance boundary and retain it through corrections; never backfill history with today's profile. Dated company/assignment/compensation readers retain their existing authority.

Recorded net duration does not establish its clock placement. A flexible/scalar break or duration aggregate may provide an exact count but no exact interval. A day aggregate is not a physical session and refuses session-based eligibility, accumulation, flat charges or deductions. Such a count can support a day-duration formula; a time-band calculation requiring missing placement refuses. Precise recorded intervals are partitioned at midnight using supplied offset/date evidence. Day type comes from the recorded Attendance owner, never a current holiday lookup masquerading as history.

Legacy compatibility has a closed discriminator retaining the original tenant-owned rule, permission, tenant-wide availability and future-company behavior. It cannot fabricate a creation company or become a client-selected authority bypass. Compatibility versions capture the original OT definition at cutover and future deliberate edits. Existing historical traces stay as recorded; no current compatibility version is attached retrospectively. Final-legacy input forbids further duration shaping or deductions.

### Scope, lifecycle and persistence

New formula identity has immutable tenant/code/creation-company ownership. Each version declares a nonempty affected-company set. Changing it requires authority over creation and every affected company; being allowed to use a shared definition grants no editing authority over another company.

Draft saves use expected revision. Activation revalidates the typed tree, references, companies, grants and reader capabilities under a persistent tenant coordination epoch. Activated definition, labels, references and digest are immutable; editing forks a Draft. Effective stop/archive actions retain history. Assignments bind an exact version and half-open date interval, with audited closure rather than identity retargeting. Static-provable conflicts refuse; unresolved dynamic intersections remain explicit runtime checks.

Pack-owned storage uses tenant-bearing same-tenant references, scope-first bounded selectors, RLS/FORCE where required, explicit grants, immutable activated/calculation rows and complete DomainEvents. The migration is centrally reserved `0551_overtime_patterns`, idx551, when1791900000031. Journal union belongs to integration; applied hashes are immutable. This migration is outside the AI release and cannot ship ahead of actually deployed Auth0543 and Board0544–0550.

A bound canonical input reader supplies an opaque transaction/principal-bound handle. Recording freshly re-reads its digests, resolves the stored assignment/version and invokes the one evaluator. Client sample facts, calculated amounts, claimed permissions or serialized handles cannot create actual source revisions. Preview is always nontransferable and writes neither final Attendance nor Payroll.

### One day identity through Payroll and TOIL

A canonical source is tenant + employment + attendance date, with exact attendance ID and proven company. Version, revision and tier IDs describe that source; they never create another payout identity. Append-only calculation revisions retain complete inputs, approval digest, rule version, lines and evidence. Controlled replacement switches the current revision with compare-and-set and audit.

Cash and TOIL coordinate through the existing tenant/employment Attendance advisory lock before source or financial rows. Lock order must include canonical Payroll batch/run and TOIL owners. A settlement references those actual owners and contains no second money or leave ledger. Cash-first and TOIL-first both refuse a conflicting claim. Reversal releases a source only after the actual owner completes its permitted reversal; closed Payroll is never rewritten.

Actual Payroll consumption must validate approved current source, earning mapping, company/currency, period/cycle and jurisdiction/policy. Covered days are suppressed from legacy prefill and weekly-cycle reads for exactly those facts. Unassigned legacy days and independent manual amounts remain under existing owners. Retries reproduce one contribution; changed tier counts/mappings replace all current source lines before finalization. A disabled generated-transaction feature cannot turn an apparently successful transfer into record-only integration.

## Options considered

| Option | Consequence |
| --- | --- |
| Extend the entire Schedule Group into a formula and assignment owner | Couples ordinary work/lateness to payment selection and makes two selectors compete. Rejected. |
| Apply another formula to final `attendance.otMinutes` and append transactions | Repeats deductions, loses source attribution and may duplicate aggregate Payroll or TOIL. Rejected. |
| Typed formula versions with one OT-stage selection and day-owned settlement | Adds lifecycle and attribution work, while preserving existing schedule/legal/financial owners. Selected. |

## Consequences and required evidence

The editor can share validation with server processing, and historical explanations can retain the actual version and source. Missing historical facts remain explicit refusals. Source attribution and controlled correction are required integration work, not deferred consequences of a storage table.

UNKNOWN until execution: production-data compatibility, restricted-owner migration rehearsal, complete historical reader coverage, final shared lock-order proof, actual cap composition and six-locale app journeys. Required verification includes every approved example/axis/section; exact financial boundaries and rounding; overlap/deduction controls; stale references/approval/grants; tenant/company/module denial; mixed legacy/formula days; actual mapped consumption with flags; retries/replacement/reversal; both cash/TOIL orders; closed runs; browser persistence/preview/activation; full financial/security gate, strict types, production build and fresh/live-baseline migration rehearsal. No runtime, test or release success is claimed by this ADR.

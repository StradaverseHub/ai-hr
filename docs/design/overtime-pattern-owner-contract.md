# Overtime Pattern owner contract

Source implementation contract for approved fcc2ea42. Migration0551/idx551/when1791900000031 is centrally reserved and written; its journal entry remains parent-owned. No execution or release is claimed. This document fixes one direction for the storage owner and its pure engine and Attendance/Payroll/TOIL consumers. ADR0123 remains integration-owned.

## Ownership and selection

An Overtime Pattern is independent of Schedule Group. The existing employee-group → shift-rule → Standard resolution continues to own the working week, ordinary absence, late/early measurements and exceptions. Exactly one OT configuration is selected at the OT stage. A new assignment never moves the employee to another Schedule Group.

The graph is Pattern identity → immutable activated Version → dated Assignment → recorded employee/day facts → one resolved Version → immutable Calculation revision → source-attributed tier Lines → canonical Payroll or TOIL settlement. Attendance owns measured work and approved duration, the pure engine derives payable duration/money, and Payroll owns actual financial consumption. Formula configuration is not statutory policy and cannot bypass the country-pack or Payroll policy owners.

New formula Pattern identity has a stable tenant/code and immutable creation company. Its version has an explicit nonempty company set; one definition can serve several authorized companies. Editing/activation of a formula version requires administration of the creation company and every company the definition can affect. A company administrator may read an applicable shared definition without acquiring authority to change other companies' policy. This is an OT configuration boundary, not another System Labels availability rule.

Assignments bind an exact version ID, never “latest active.” A target is selected employment IDs OR an allowlisted Personnel condition tree. Date ranges are half-open [from,to); null end is open. Individual matches take precedence over group matches, then larger explicit integer priority wins. Equal best-ranked matches are a conflict even when a database ID/order could break the tie. Unknown facts that could change the winner refuse resolution. A proven false candidate is excluded; no match is distinct from unknown/conflict.

Static-provable equal-rank overlaps are refused when assigning/activating. Conditional intersections that cannot be proved disjoint are marked for runtime checking, not asserted safe by a sample. The runtime resolver uses Credit's one pure resolver, not a second storage implementation.

## Versions and effective lifecycle

Drafts have optimistic integer revision and a bounded typed definition. Saving requires expectedRevision. Activation validates the entire definition, referenced companies/employments/catalogue values, earning items and declared reader capabilities again under the canonical write lock; a stale validation digest is refused. An activated definition, name/description snapshot, company set, configuration IDs and digest are immutable. Further editing forks a new Draft with a new ordinal.

A version's administrative availability for new assignments is separate from its business definition and existing assignment history. Activation/deactivation/archive are dated lifecycle events. Deactivation stops new future applicability from an explicit date, never rewrites a recorded result. Resume creates a new version/explicit assignment; it does not mutate an old effective interval. A prospective assignment stop is a separately audited close action with expectedRevision. Retroactive source corrections require an explicit controlled recalculation and financial checks; ordinary configuration changes cannot silently select a new version for historical attendance.

New formula earning-item references use the existing archive lifecycle; activated formula definitions cannot be physically deleted. Later archival/inactivation prevents new configuration/assignment and is rechecked before a new calculation or transfer. Recorded results still explain the exact IDs, version and frozen labels used. A present reference label is never presented as its historical label.

## Legacy compatibility

Existing patterns and old attendance are not reinterpreted as formula inputs. Legacy compatibility is an explicit discriminator: it keeps the original tenant-owned attendance_rule identity, has no fabricated creation company/business code or formula company set, and inherits exactly the existing legacy owner permissions and tenant-wide/future-company scope. This exception can only be created through the compatibility migration/legacy owner hook, not chosen to bypass formula-company authorization. The migration records explicit compatibility versions of each existing attendance_rule OT section, including ordered band IDs, rounding, rates/phRate and applyToEarlyOt, with a binding to the original rule and the cutover boundary. The old rule remains the Schedule Group owner. Existing legacy historical calculations retain their recorded trace; a current compatibility snapshot cannot manufacture a historical version.

At OT resolution: an explicit new assignment winner selects its version once; an unknown/conflict refuses; proven no-match selects the compatibility version of the legacy rule already selected by Attendance. This fallback is not a second schedule resolver. Compatibility continues through the existing legacy calculation path. Future deliberate legacy OT edits must produce another compatibility snapshot/binding through the owner; they cannot mutate the activated snapshot. Schedule Group week/lateness edits do not create a formula assignment or change another owner.

0551 provides deferred invoker-rights triggers over canonical legacy OT fields/rows. Each trigger observes the final ordered ladder and deduplicates an unchanged definition under the configuration epoch. Week/lateness-only edits do not append snapshots. Immutable legacyRuleRef survives canonical unused-group deletion; the live nullable rule FK becomes NULL and deleted owners cannot be selected for new work. The exact compatibility baseline is still unverified. No old attendance row is backfilled with today's configuration.

`attendance.otMinutes` is a FINAL legacy figure containing eligibility/rounding/manual/approval effects. Credit's discriminated final-legacy input forbids another duration formula, deduction or duration rounding. Unrecorded raw/eligible layers stay Unknown. New raw-mode sessions require recorded canonical intervals and a separately evidenced approved bound.

## Storage schema

All new tables carry tenant_id; subject/company tables use same-tenant references/guards, explicit RLS and grants. Delete cascades cannot destroy activated definitions, calculation or settlement history.

| Table | Identity and responsibility |
| --- | --- |
| overtime_pattern_epoch | Persistent tenant revision serializes configuration writers and forces stale REPEATABLE READ writers to restart. |
| overtime_pattern | Stable ID, tenant, formula/legacy discriminator, normalized unique live formula code and immutable creation company; legacy identity references the original tenant-owned attendance_rule instead of inventing a company/code. Administrative archive state and revision. Version metadata supplies historical display. |
| overtime_pattern_version | Pattern + ordinal, draft revision, definition schema version/kind (formula or legacy compatibility), typed definition JSON, frozen metadata, digest and activation identity/time. Activated content is immutable. |
| overtime_pattern_version_company | Exact allowed formula company set; same-tenant company/version, nonempty on formula activation; immutable after activation. Legacy compatibility preserves original tenant-wide scope through its discriminator/binding. |
| overtime_pattern_version_state | Append-only effective lifecycle transitions; no in-place replacement of activated business facts. |
| overtime_pattern_legacy_binding | Original attendance_rule + effective boundary → exact compatibility version; retained original rule identity, no rule deletion cascade. |
| overtime_pattern_assignment | Exact version, individual/group target, typed target AST, priority, effective dates, recorded/superseded identity and revision. Close/replace is audited; no retargeting a persisted assignment. |
| overtime_pattern_assignment_employment | Selected employment membership for an individual target; same-tenant version-company scope; immutable after activation of that assignment. |
| attendance_overtime_source | One stable canonical day identity: tenant + employment + attendance date, canonical attendance ID and proven recorded company. Calculation revision IDs never become another payout identity. |
| attendance_overtime_personnel_context | Immutable first-current-day capture of Grade plus eight mutable Personnel axes; missing historical context remains Unknown. |
| attendance_overtime_calculation | Append-only source revision/version/assignment, input/approval/reference digests, cash outcome, independent durationOutcome/durationInputDigest and exact payable numerator/denominator, currency and approval metadata. Current revision is selected by audited CAS. |
| attendance_overtime_calculation_evidence | Salary-private canonical inputs plus {evaluation,duration,resolution}; actual subject/financial readership. Metadata reads do not reveal pay. |
| attendance_overtime_line | Calculation + stable config tier/session/segment identity; ordered minute layers, money/rate/base/cap evidence and configured earning-item reference. Multiple legitimate tier lines remain distinct inside one day source. |
| overtime_source_settlement | Coordination/attribution for the source's canonical cash or TOIL owner, with immutable owner references and audited release/reversal; does not duplicate Payroll amounts or TOIL balances. |

A closed typed reference manifest is extracted by the definition validator and checked against authoritative tables at save/activation. JSON cannot smuggle arbitrary table/column paths. Polymorphic reference guards only accept the closed known kinds and same tenant; no arbitrary dynamic SQL. Database backstops enforce identity immutability, date/state/size/count constraints, version/assignment/source foreign tenancy, nonempty active formula company sets and append-only activated/result history. The pure validator owns expression semantics; SQL does not implement a second formula engine.

Concurrent configuration/assignment writes lock one tenant OT configuration coordination row before selecting versions/assignments FOR UPDATE. The persistent revision changes in the same transaction, making stale repeatable-read writers restart. Source recalculation/settlement uses the canonical employment/day owner lock and an exact current-revision CAS; uses the existing tenant:employment advisory key. Calculation order is employee → Attendance → source; transfer/release order is employee → source → batch. Generation/close holds batch and reads source MVCC without employee/source locks. Raw Attendance triggers and the canonical pre-batch helper hold Attendance → source → relevant batches, never source after batch. Cash transfer holds source → batch and reads Attendance only by MVCC, so it never takes the opposite source → Attendance lock. No application-provided “already authorized,” “skip conflict,” or “force replace finalized” switch is exposed.

Migration0551/when1791900000031/idx551 is centrally confirmed. The SQL file is written but unapplied. Journal union remains parent-owned.

## Server API boundary

Implementation belongs in `packs/attendance/overtime-patterns.ts`; the parent later exposes named APIs through the Attendance facade. No outside-pack direct import or ratchet allowlist growth is needed. Names below are implemented source contracts; type/runtime verification remains pending.

```ts
listOvertimePatterns(ctx, {companyIds?, search?, status?, method?, assignmentSearch?, cursor?, limit?})
getOvertimePattern(ctx, patternId)
saveOvertimePatternDraft(ctx, {patternId?, versionId?, expectedRevision?, draft})
forkOvertimePatternDraft(ctx, {versionId, expectedPatternRevision})
validateOvertimePatternActivation(ctx, {versionId, expectedRevision})
activateOvertimePattern(ctx, {versionId, expectedRevision, validationDigest, effectiveFrom})
stopOvertimePatternVersion(ctx, {versionId, expectedRevision, effectiveFrom, reason})
archiveOvertimePattern(ctx, {patternId, expectedRevision, reason})
saveOvertimePatternAssignment(ctx, {assignmentId?, expectedRevision?, versionId, target, priority, from, to})
closeOvertimePatternAssignment(ctx, {assignmentId, expectedRevision, effectiveTo, reason})
resolveOvertimePatternTx(tx, ctx, {employmentId, date, recordedFacts, resolvedLegacyRuleId})
createOvertimeCalculationOwner(canonicalReader) // bound ONCE by trusted server integration
  .prepareTx(tx, ctx, {employmentId,date}) // opaque same-Tx/principal handle
  .recordTx(tx, ctx, {prepared,expectedCurrentRevision,reason?}) // fresh canonical re-read + resolve/evaluate
  .preview(ctx,{patternId,versionId,employmentId,date})
  .previewSample(ctx,{patternId,versionId,sample}) // forced sample provenance, never a persistence handle
readOvertimeCalculation(ctx, {employmentId, date, revisionId?})
readOvertimeCalculationTx(tx,ctx,{employmentId,date,revisionId?})
readOvertimeCashDefinitionTx(tx,ctx,{versionId,assignmentId,companyId,date})
readOvertimeDurationDefinitionTx(tx,ctx,{employmentId,date})
readOvertimeCashSettlementsTx(tx,ctx,{batchId})
readOvertimeDurationsTx(tx,ctx,{entries})
listCoveredOvertimeDaysTx(tx,ctx,{employmentIds,from,to})
readOvertimeSettlementForDayTx(tx,ctx,{employmentId,date})
assertOvertimeSettlementAvailableTx(tx,ctx,{employmentId,date,mode})
reserveOvertimeSettlementTx(tx,ctx,{employmentId,date,...canonicalOwnerReference})
releaseOvertimeSettlementTx(tx,ctx,{settlementId,expectedRevision,reason})
releaseOvertimeSettlementsForDraftTeardownTx(tx,ctx,{batchId,reason})
hasOvertimePatternForDayTx(tx,ctx,{employmentId,date})
captureOvertimePersonnelContextTx(tx,ctx,{employmentId,date,facts})
readOvertimePersonnelContextTx(tx,ctx,{employmentId,date})
```

Tx APIs are internal server consumers, not client actions accepting role/scope flags or sample facts. Before persistence, the canonical input owner must freshly read/verify input and approval digests inside the same transaction; storage rechecks actual attendance identity/date/subject/company, version/assignment and current revision. The result must be produced by Credit's evaluator from those canonical inputs. Client-entered sample previews cannot enter record/settlement APIs. The parent owns the actual input reader/invocation and public actions, avoiding a circular import between core/attendance and this pack owner.

Public configuration/preview and actual source/calculation writes require Attendance. Retained-obligation/invariant Tx reads use real tenant/subject or financial RLS without Attendance entitlement, so module removal cannot re-enable legacy duplication or strand an existing obligation. Cash reads/new claims require Payroll and actual company financial scope. New TOIL claims require the actual TOIL entitlement and exact canonical accrual authority; reversal of an existing claim survives module removal. Payroll transfer additionally checks the Payroll gate and canonical financial authority. Bounded selectors apply tenant/company permission before search/count/limit. Page size is at most100; selection IDs and bulk assignment are bounded (proposed500 per write), expression bounds come from the pure contract, and overflowing candidate resolution refuses rather than choosing from a truncated set. Hidden employee counts are not returned.

Every state-changing service emits a complete DomainEvent identifying the actor, subject when applicable, prior/new revision, effective range, definition/input digest, and reason. Financial/employee evidence follows company/subject permission, rather than the tenant-wide display policy for harmless rule names.

## Pure input/output contract with Credit

Credit owns `lib/overtime-pattern-model.ts`, `-schema.ts`, `-evaluate.ts`, including validation, analysis, assignment resolution and evaluation. Storage imports that exact contract; it does not redeclare AST semantics.

Canonical day source is tenant/employment/attendanceId/date, inputDigest/approvalDigest, patternVersionId/assignmentId, currency/minorScale and Known/Unknown fields with recorded provenance. Raw input has canonical absolute or day-offset sessions and day-type/time-band partitions. HH:mm alone cannot establish an overnight session. Final-legacy input is a separate discriminant. Preview never has a transferable source claim.

Output ready/ineligible/refused contains ordered day/session/segment/tier lines, raw/eligible/approved/payable layers, deduction rule/resource/source identities and day/session basis, branch/tier/rate/base/cap/money evidence and mapping references. Unknown/incomplete facts are not numeric zero. Exact rational/scaled arithmetic and configured rounding produce final minor-unit amounts. Persisted integer/rational components use bounded decimal strings, never JSON bigint or lossy binary numeric conversions. Source keys remain stable across revision/tier changes so recalculation cannot create a second payout identity.

Required assignment axes are Company, Department, Business Unit, Division, Grade, Position, Employment Type, Branch, Region, Line, Section, Team, Base, Category, selected employment, assigned Shift and Schedule Group. Eligibility also includes recorded day type, OT intervals, actual/required duration and attendance status. The source audit confirms assignment carries dated company/department/BU/position/employmentType. Several other axes are mutable current fields rather than dated assignment facts; their exact owner and available snapshot must be mapped by the integration input reader. A past value cannot be substituted from current profile. Prospective capture of those facts at the relevant attendance boundary is required where history does not exist. Activation must report unavailable required reader capabilities, not silently disable a requested axis or claim samples establish history.

## Payroll, TOIL and replacement contract

One day source can produce multiple tier lines and one current calculation revision. Cash settlement reserves that stable day source, then Payroll projects approved ready mapped lines through its existing earning-item/cycle/statutory/closed-run owner. Exact source ownership suppresses legacy prefill and weekly-cycle reads for only those covered days. Unassigned legacy days and independent manual amounts remain under the existing owners. Creating generated individual transactions behind a disabled consumption flag is not integration.

Payroll's existing gates, wage eligibility, policy multiplier/hour/amount caps and earning-item statutory character remain mandatory. A formula wage-base cap is a separate explicitly configured input transformation. Approval digest/state, source inputs, assignment/version and mapping are rechecked at actual consumption. Revoked/changed approval makes the source stale/refused; it cannot keep a prior amount silently payable.

Cash and TOIL use the same stable source coordination before either owner commits a claim, in both orders. Settlement references the existing canonical TOIL accrual or Payroll source/run, never a second leave balance or money ledger. A later TOIL request refuses a cash-claimed source; cash refuses pending/active TOIL according to the canonical TOIL lifecycle. Reversal releases the source only when the canonical financial/TOIL owner has completed its controlled reversal; a posted/finalized payroll claim cannot be casually released.

Recalculation before finalization appends a revision, atomically replaces all current mapped lines for that source through Payroll, and audits prior/new identities. Retries reproduce the same source contribution. Different tier count/mapping is replacement, not append. Finalized payroll requires the existing adjustment/reopening workflow and is never rewritten by this owner. Parent owns actual Payroll/TOIL mutation and legacy suppression integration; these outcomes are required, not deferred out of scope.

## Acceptance and present verification limits

Required evidence covers create/save/reopen/fork/activate/deactivate/archive; all assignment axes and explicit priority/conflict; compatibility baseline and unchanged Schedule Group duties; hourly/flat/selected capped base; late/break deduction overlap; nested conditions; time bands/overnight/tier boundaries; exact money and caps; missing/unknown facts; date/version/ref revocation/stale/concurrent writes; approved-only multi-line transfer, mixed legacy/new days, retries/replacement/reversal, cash-first/TOIL-first, consumption flags and closed Payroll. Role/company/tenant leakage and module-off refusal require direct service/RLS tests. Actual app journeys include previews without writes, six locales, keyboard/light/dark/narrow, pending/refusal states and runtime logs.

Written regressions cover incomplete Draft save/reopen and malformed structure refusal; immutable activation/fork; reference-stale activation; assignment ties; matching-version list filters; same-day stop ordering; immutable current Personnel capture; forged/stale handles; exact fractional duration; salary-only cash refusal retaining duration; retained reads on module removal; closed-run raw protection and released-FK history; cross-tenant references; final legacy snapshot dedup/deletion; concurrent READ COMMITTED writes and stale REPEATABLE READ restart. A separate rollback-only DDL regression reapplies0551 as a NOSUPERUSER/NOBYPASSRLS migration owner and inspects FORCE RLS/grants/private helper boundaries. All are UNRUN.

The raw source backstop covers Attendance, punches, day adjustments, corrections and workflow decisions. Derived overtime/overtimePattern trace metadata does not count as raw change. An active TOIL source requires canonical reversal/release before raw mutation; closed cash refuses, processed cash marks needs-recalc and appends invalidation evidence. Released batch/accrual deletion retains immutable ownerReference while clearing its FK.

Coverage includes current formula ready/ineligible/refused results plus an explicit authorized Attendance trace {status:'refused',reason:'sourceUnavailable'} marker when strict source identity cannot be created. Marker-only rows expose no invented company/calculation/digests. Detection can prove absence without invoking salary/currency readers; an unknown company with a potentially relevant visible formula is not proof of absence.

UNKNOWN until coordinated verification: SQL syntax/application on empty and live-shaped/restricted-role databases; runtime RLS privileges and concurrency behavior; canonical parent input/Payroll/TOIL integration and every ordinary self/approver path; actual cash/TOIL bidirectional fixture/journey; all UI/locales and current production data compatibility. Pure dependencies are pinned in Credit's separate branch; currency/actual readers and facade integration are parent-owned. These are not silently converted to implemented capabilities. No legal formula/rate policy is introduced by this design. No DB/test/typecheck/build/browser/dependency work runs during the AI release hold.

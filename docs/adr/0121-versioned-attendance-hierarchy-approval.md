# ADR-0121: Versioned Attendance hierarchy approvals

Date: 2026-10-15. Board: 797ba70b. Decision: approved implementation direction; verification remains required.

Attendance templates already own immutable versions, criteria, priority, ordered stages and on-submit
snapshots. Migration 0533 resolves every `direct_manager` stage to the applicant's direct manager and
rechecks that current relationship at decision time. The generic correction guard also admits only that
direct manager, an authorized delegate or scoped HR. Repeating a stage cannot implement successive superiors.

Personnel remains the sole owner of reporting relationships, employment identity and catalogued profile
values. Attendance owns workflow selection and a frozen approval chain. Employment, person and login are
separate identities throughout resolution and decision history.

Add explicit routing version 1 (legacy flat; database default) and version 2 (sequential hierarchy).
Existing templates and submitted requests retain version 1. New configuration explicitly saves version 2;
editing an old template does not convert it until HR selects conversion. New level names are generated from
order; historic custom names and decision labels are not rewritten. Each version-2 Direct Superior level
resolves the corresponding nth administrative superior at submission, with tenant/company fences, effective
relationship windows, active employment and login authority. Missing, inactive, self, repeated-person/login,
ambiguous or cyclic routes refuse unless that level explicitly offers a usable HR alternative. Neither the
absence of a superior nor the end of a hierarchy is approval.

Assignment uses the canonical organization criteria resolver and its existing effective-date semantics.
Position, employment type, all eight Personnel organization fields and employment-ID selections supplement
the existing axes. Values within one field are alternatives; configured fields are conjunctive. Employee
selection intersects the caller's search restriction; an empty intersection returns no targets, never an
unrestricted population. Catalogues and validation come from Personnel and organization label owners. Equal
priority structural overlaps continue to refuse activation; submission checks actual matching priority too.

A submitted request freezes chosen template/version, ordered levels and resolved employment/person/login
identities. Later profile, reporting or template changes do not silently change that chain. Live login/scope
and delegation are still checked before decisions. Authorized reassignment must be a separate reasoned,
audited transition; it cannot overwrite the original snapshot or past decisions.

Version-2 decision access is request-bound. It must not expand Personnel visibility or grant generic
hierarchy correction rights. The final fixed Attendance effect uses a transaction-local correction-ID hint
only after recording and advancing a valid final approval. The database treats that hint as untrusted:
capability proof derives tenant, subject, date and actual actor from the locked request/correction and its
final approved decision, verifies frozen assignment or authorized delegation, and requires that decision
was inserted in the same transaction. Arbitrary hints, other subjects/dates/users, legacy requests,
committed-decision replay and another correction cannot establish effect authority. The real user identity
stays installed; no current manager or HR identity is substituted. Exact-day mutation guards contain the
fixed attendance/punch/automatic-credit effects. Existing Personnel and schedule reads retain their live
fences; loss of those rights produces an actionable scoped-HR handoff instead of widened access.

Payroll cutoff coverage stays with its canonical owner. Its operational protection query returns subject
batch status/cutoff facts, never compensation; its marker changes only recalc-needed membership on a
processed run. The same-transaction request capability may authorize those existing subject/batch seams.
The fixed effect chooses batches using canonical coverage for the correction date. The SQL marker itself
is not claimed to validate that date. Tests must prove other-subject batch denial, closed-run protection,
no pay/history mutation and preserved real-actor audit. No independent cutoff calculation is introduced.

Required evidence includes the three-level D → A → Arjun → Daniel sequence for Irregularity and Self OT,
legacy configuration/snapshot behavior, all criteria and priority conflicts, invalid hierarchy identities,
explicit fallback, frozen history and authorized/unauthorized delegation/reassignment. The actual
configuration/submission/decision experience, six locales, keyboard/mobile, runtime logs and centrally
allocated migration rehearsal precede the parent's final release gate.

The fresh-write proof checks an exclusive permanent transaction-ID lock held by the current backend
for the visible row's xmin. This deliberately recognizes only the root transaction or an active
writing savepoint. PostgreSQL 16 removes a subtransaction's XID lock at RELEASE SAVEPOINT; a decision
whose writing savepoint has already been released is refused, even before the outer commit. The fixed
approval pipeline checks its decision before releasing the outer/item savepoint and checks derived
plan/attendance stamps before releasing its inner effect savepoint. It does not use a general-purpose
same-top-transaction predicate. See [PostgreSQL 16 subtransactions](https://www.postgresql.org/docs/16/subxacts.html)
and [CommitSubTransaction source](https://raw.githubusercontent.com/postgres/postgres/REL_16_STABLE/src/backend/access/transam/xact.c).

Final v2 approval is stamped inside the active effect savepoint after the fixed owner effect. The database
independently requires live original Personnel/calculation visibility and an actively written exact-day
Attendance row; clock corrections must have the effective requested punch set and pair, while OT-only
approval must match the owner's stored approved amount. Domain events remain audit data and cannot prove
an effect. A genuine future OT-only deferral deliberately creates no attendance row. No-op corrections
still pass through the canonical owner write and remain valid. No attendance or OT formula is duplicated.

Submitted v2 inputs remain immutable after approval, rejection or cancellation, including requested OT.
The final decision identity and frozen OT method cannot be edited or reopened after completion. Deferred
landing may change only applied_at and approved_ot_minutes: it requires a freshly written same-day owner
result, with a separate claim and an amount stamp equal to the fresh trace's approvedMinutes. Cancellation
retains its existing applicant/scoped-HR owner path and never rewrites the original decision history.

## Per-level participant model for routing version 3

The approved Attendance follow-up (797ba70b, revision 2) requires a new explicit routing version, not a
reinterpretation of legacy alternates. Each level has its own Sequential or Any One mode and either an
explicit superior depth 1–5 from the applicant or an ordered group of named employees. Named groups have
at most 20 participants per level, 100 per workflow, and workflows have 1–10 levels. Unknown fields,
invalid identities and excessive selections refuse rather than being sanitized or truncated. Employment,
person and login identity are separately frozen and checked for self/repeated assignments. Personnel
continues to own hierarchy, lifecycle, company scope and login eligibility.

A whole-level HR alternative must never silently satisfy a required named group. In v3 it is supported
only for an explicitly configured single-superior source. A selected group combined with that alternative
is refused explicitly. A reasoned reassignment of a named group operates on one outstanding participant
slot; it retains the original route, completed participant decisions and the previous/replacement identity.
It cannot replace the whole level or erase completed requirements. Existing v1/v2 alternatives remain
unchanged. This preserves the requirement that every sequential participant is necessary.

Participant decisions and level-completion decisions have distinct grains. The existing unique
(request, stage) decision remains a completion record; it must not be weakened to accommodate individual
participants. The future transaction owner must lock the request, check the exact current slot and live
actor authority, write immutable participant evidence, and write/advance the unique completion record
only when the mode is fulfilled or a participant rejects. Any One requires a first-writer decision under
that same lock. Frozen request assignment grants no general Personnel or correction rights.

V3 enters through a separate exact configuration boundary; the legacy validator retains v1/v2 semantics.
The v3 owner integrates participant persistence, request-bound RLS, slot-grain reassignment, ordinary
employee inbox access and final-effect guards together. The ordinary-employee inbox branch reads only
assigned Attendance work and does not query the unrelated manager queues or grant a Manager role.
The configured stage count still owns advancement; partial participant decisions do not advance it.

Final effects require an actively written final level-completion decision and an actively written final
participant decision by the same real actor. The exact subject/day/correction, canonical Attendance effect,
payroll cutoff and TOIL owners remain unchanged. Neither partial participant approval nor a previously
committed level decision establishes that capability. Released-savepoint evidence remains refused by the
existing active-write predicate. Legacy identity substitution/delegation seams explicitly exclude v3;
they cannot become a weaker path around the participant owner.

Changing an existing v1/v2 template to per-level configuration is deliberate: the editor states that it
starts a new route draft with one level, while keeping company, criteria and metadata. The saved template
and all submitted applications remain untouched until a new immutable version is saved. No source model,
unrun regression or migration draft establishes runtime or release verification.

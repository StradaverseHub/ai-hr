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

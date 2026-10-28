# ADR-0105 — Dated Schedule Group rotations

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

Date: 2026-10-12
Status: Implemented on a build branch; verification and release pending
Board item: e5fa2d79-618c-4bc7-a5d5-ef696ed845c1

## Context

A weekly pattern cannot describe alternating weeks or arbitrary repeating day cycles.
The existing Schedule Group editor also saved its allowed shifts separately from its
working days, so a newly selected, unsaved shift was unavailable to the pattern editor.
Daily roster assignments, the employee's dated shift arrangement, company holidays,
processed attendance, and payroll protection are already authoritative facts.

## Decision

`attendance_rotation` stores an immutable version of one named, non-Standard group's
allowed shift IDs, anchor date, effective date, unit, length, and complete day list.
A week has seven explicitly configured days and starts on Monday. A day cycle has an
arbitrary positive number of days. Both are bounded at 366 days (52 whole weeks).
Positive modulo over UTC calendar days gives consistent dates before the anchor and
across leap days, months and years. A version never applies before its effective date.

Full and Half require an allowed shift. Off and Rest require no shift and remain
distinct for classification, overtime and leave inclusion. At least one working day
is required. Shift hours, rounding, overrides, break rules and half-day windows reuse
the existing canonical shift schedule owner. Holidays keep existing precedence.
Explicit daily roster shifts/rest always override a cycle.

The employee's explicit Schedule Group wins. Otherwise the shift arrangement in
force on the date supplies the inherited group; the cached default shift remains the
fallback when no dated arrangement exists. The latest version effective on that date
supplies the cycle. Legacy groups keep the existing weekly/policy ladder until opt-in.
Attendance calculation and batched displays, payroll hourly clamping, roster ghosts,
leave deductions/working dates/notice, absence membership, escalation timing, and
leave-history preview warnings consume the dated cycle. Policy-only half weekdays
remain a classification marker with their existing full required minutes; this change
does not redefine policy-only schedule durations.

The allowed pool of a rotation is `version.allowedShiftIds`. `shift.ruleId` also
supplies inherited group membership to legacy employee assignments, so removing a
shift from a dated allowed pool MUST NOT clear that association. Older saved versions
retain their shift references. The editor explains this distinction. A shift linked
to another group is refused rather than silently moved. An ungrouped shift used by an
employee without an explicit group is also refused: linking it could immediately
change that employee's inherited calendar before the new effective date. HR must set
the employee's intended group first. Unused ungrouped templates may join the group.
Legacy writers cannot detach/reassign the pool behind an opted-in group.

One transaction locks the group and shift sources, checks the submitted revision,
validates the pool and every day, protects payroll, appends the version, and emits
`attendance-rule.rotation-saved` with the complete configuration. The revision covers
saved version identities and inherited shift-group links. Stale saves fail with a
reload instruction. Effective dates must be tomorrow or later and later than every
saved version; neither existing versions nor historical attendance are rewritten.

The new rotation save is commercially gated on Attendance at its service entry point.
Existing ungated rule/roster spine services are unchanged, and tx-taking rotation
readers remain available to core Leave and payroll consumers.

Tenant-wide HR authority is checked from current DB grants, not session role claims.
Company-scoped HR cannot safely change a tenant-wide group affecting employees hidden
by company RLS. The table uses tenant RLS, group-admin insert authority, immutable
version guards, same-tenant/active shift validation, shape/size checks, and retained
shift references. Company deletion also declares the retained rule FK and allowed-shift
UUID array as blocking dependencies, so company-owned legacy setup refuses before its
cascade can reach immutable rotation history. The company-referrer guard still compares
every actual FK exactly and separately verifies declared UUID arrays. Archived templates remain readable by existing versions; new
versions must use active templates. Hard deletion of referenced templates is refused.

Every affected employment's overlapping or later processed/closed attendance-payroll
window is locked using the existing restricted operational-facts seam. Closed runs
block the save; processed runs receive the existing recalculation marker. The recurring
cycle affects future windows, so protection cannot check only the effective date.
No attendance row or payslip is recalculated by saving configuration.

## Consequences and limits

The existing identity/attendance/overtime sections keep their own saves; allowed shifts
and the entire cycle now have one save. Group creation remains a first step, followed
by cycle configuration on the group's edit page. Standard remains the legacy fallback.
The read view previews the latest saved cycle and lists all effective dates; it does
not provide an interactive full preview of an older version. There is no cancellation
or replacement of a future saved version: append a later effective revision.

Shift templates remain mutable under the existing audited template editor. A version
retains shift identity and cycle/pool facts, not a snapshot of every template's hours.
Explicit attendance recalculation continues to use current template rules. Existing
processed attendance remains stored until an authorized recalculation is requested.
Affected-member protection conservatively includes live dated assignments referencing
the group, even if the employee has a later assignment elsewhere.

The cycle editor uses the same unsaved pool immediately, previews every configured
day, confirms unit replacement/shortening, retains input after server validation
errors, and uses the shared Attendance settings navigation guard for browser unload,
links, history navigation and independent form baselines. Successful persistence
returns the transaction’s fresh optimistic revision and saved-version token, rebasing
only the rotation form; failures keep its baseline and draft. Standard’s edit page
mounts one generic guard because it has other forms but no rotation editor. The obsolete "rotation not stored"
card is removed. All six locales contain translated controls and explanatory copy in the new namespace.
The stored product label Standard is retained in translated explanations. Domain/service
validation exception messages remain English; translating those error responses is still
unsupported in this build.

The migration is additive and performs no backfill. This build's migration allocation
is 0531; integration must union preceding allocated journal entries before validation.

## Verification

Authored tests cover recurrence/wrapping, malformed cycles, optimistic concurrency,
tenant and grant boundaries, archived references, inherited pool removal, dated
arrangement inheritance, explicit roster precedence, canonical half/night behavior,
holidays, consumer agreement, leave/absence, and processed/closed future payroll.
DOM tests cover unsaved pool choices, shrinking confirmation, and invalid day/pool
states. Existing legacy schedule and roster tests remain required.

All execution is deferred while the parent release's full gate owns both shared test
slots. No test, TypeScript, production build, DB migration/shadow test, or browser
verification is claimed by this ADR. Required before release: targeted suites, pack
and source guards, TypeScript, full repository gate, production build, shadow migration,
and a real browser pass for the integrated group editor.

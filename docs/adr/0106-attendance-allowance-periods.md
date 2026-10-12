# ADR-0106: Fixed attendance allowance periods and owned payroll sources

Date: 2026-10-12
Status: Implemented for approved board item f75e13c6; verification pending the shared release gate

## Context

The original allowance screen mixed listing and editing. Its monthly predicate and payroll upsert
could not express daily or weekly eligibility, and two policies on one pay code could overwrite each
other. A reversal could also remove an unrelated manual input. The approved redesign requires clear
employee selection, deterministic attendance conditions, a preview, and traceable earning/deduction
transfers while retaining existing monthly policies and past payroll.

## Decision

The catalog links to dedicated Create, View and Edit screens. Setup has four sections: information and
calculation, employees, attendance, and review. The administrator reviews amount, period ownership,
pay-code mapping and conditions before saving. The shared Attendance Settings navigation guard observes
this editor; a failed action never acknowledges an unsaved change as persisted.

`rules = NULL` explicitly means the existing monthly criteria and employee-scope evaluator. Migration
0532 preserves those values and existing payroll inputs. The new editor requires an explicit conversion
to change a legacy policy to the new expression. Updating or converting a policy creates an immutable
version; it does not rewrite a prior definition, period result revision or payslip.

The new client-safe rules vocabulary contains supported Personnel fields and separately typed
attendance metrics. Employee conditions and attendance conditions each have an explicit AND/OR mode.
Comparison thresholds carry minutes, hours or days, with inclusive BETWEEN bounds. Missing profile
values never pass NOT IN; unknown measurements fail their comparison. No executable expressions,
free-form formulas or generated monetary arithmetic are accepted.

Department, business unit, position and employment type are resolved from dated assignment records on
the period's final employment day owned by the policy company. Grade and category are undated in the
Personnel schema, so they use current values; the editor states this limitation. Employee and shift
references must be visible, administrable, active and available to the policy company. Calculations
are bounded to a calendar month plus the previous month's part of a Sunday-owned week, with a maximum
of 2,000 company employments. Excess candidates refuse rather than silently disappear.

Each result snapshots the employee selection date, evaluated facts and per-field source. Grade and
category explicitly identify the current Personnel profile without a historical version. The dated
selection date does not imply historical grade/category eligibility. Later profile edits affect new
calculations and leave stored immutable evidence revisions intact.

Monthly periods are calendar months; daily periods are dates. Weekly periods are Monday–Sunday and
belong only to the payment month containing Sunday. A fixed amount is paid once per qualifying period;
there is no proration. A period starting before the policy's effective date is excluded completely.
Unfinished periods do not qualify. A new policy with no attendance conditions can qualify on applicable
recorded days or scheduled absences; presence requires an attendance-days condition. This is explicit
on the editor. Unrecorded off, rest and holiday dates do not themselves earn an amount.

Recorded attendance owns measured worked, normal, overtime, lateness and early-out time. Missing past
scheduled working days count as absences unless covered by approved leave. Applicability uses the
Attendance pack's canonical dated schedule resolver, including rotations and actual selected shift
identity. Recorded holiday/rest day types remain frozen. Full/half and shift applicability are current
resolved schedule facts, not a reconstruction of historic traces: old traces contain no shift ID. The
result snapshots the resolved source days and measurements when the administrator recalculates.
Source-day evidence includes the raw recorded day type and separately named canonical kind/shift at
calculation. The canonical `absenceBreakdownByEmployment` owner resolves per-date approvals, partial
leave, holiday, roster and tenure exclusions; the allowance engine does not infer leave from request
spans. V2 opts into its scheduled semantics while legacy monthly policies keep their prior helper.
These canonical reads are currently performed per date within the bounded period window; a shared
bulk date-map contract would be needed to reduce their query cost without duplicating absence rules.

Money uses integer cents and exact decimal serialization. Unsupported, archived, non-payable or
formula-driven pay codes refuse; an Earning maps to an allowance code and a Deduction to a deduction
code. Payroll owns the projection through its facade. Attendance-only tenants can configure and preview;
posting requires the Payroll and typed-pay-components entitlements.

Current result identity is tenant + policy + policy version + employment + period. An immutable
revision retains each distinct calculated evidence digest. Current payroll source identity is tenant +
policy + employment + period, independent of policy version, so editing and retransferring replaces the
old version rather than double-paying it. Each policy's contributions remain separate; Payroll sums
all sources sharing a run/employee/code exactly. A manual or legacy unowned input causes an explicit
conflict, even if its amount happens to equal the new result.

Transfers take employment advisory locks in stable ID order before the run lock, matching attendance
correction writers. A policy/month advisory lock prevents ownership of the same period across two
runs. The preview digest covers policy, recipients, resolved periods and selected payroll scope; an
interactive transfer recalculates and refuses a changed digest. Calculation rows, immutable revisions,
source replacement, aggregate money inputs, recalculation marks and success receipts commit together.
Failures roll back these writes and then append a separately authorised, reference-only failure
receipt. Receipts retain both the nullable run FK and its original non-null UUID after draft teardown.

A processed run requires explicit reprocessing consent, updates source inputs, and marks affected
employees stale using the existing Payroll fields. It does not mutate their saved payslips. A closed
run refuses transfer and source/evidence changes. The aggregate input trigger prevents manual
amount/note overwrite while automatic sources own it. Deleting an editable payroll input releases its
current sources; draft teardown preserves immutable definitions, revisions and transfer receipts.

New history tables carry tenant/company/employee RLS and cross-reference identity triggers. Immutable
history has no app-role UPDATE/DELETE grants; current results have no DELETE grant. Company deletion
retains all five new tables as financial history in `core/company-refs.ts`; their policy FKs are also
registered in its exact dependent graph. A policy with saved definition history therefore blocks
company deletion, even if money has not yet been transferred.

## Verification and remaining limits

The implementation and tests are committed before test execution because the active release gate owns
both shared test slots. No typecheck, Vitest, build, DB migration, seed, dev server or browser process was
run during that freeze. Integration requires the schedule agent's canonical resolver seam and the
parent's shared unsaved-navigation component. Full typecheck, targeted DB/pure/guard tests, full gate,
shadow migration and six-locale browser rendering remain required before release.

The history screen shows the latest 100 attempts, 500 current results and 500 immutable revisions;
all policy versions remain available. Older evidence is retained in the database. The complete new
namespace is translated in all six locale catalogs; native-language copy review remains useful.

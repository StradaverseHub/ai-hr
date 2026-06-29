# ADR-0066 — Configurable Earned-Leave Entitlement per Company + Festive One-off Grants

Status: Accepted
Date: 2026-06-29
Feedback: "Configurable Earned Leave Entitlement Rules"

## Context

The accrual / upfront / qualifying-period entitlement engine already exists (ADR-0040/0041, waves 2D/2E):
`leave_policy.accrual` carries `earned_monthly` / `earned_quarterly` / lump methods, grade-based and company
country-pack floors, and the `minServiceMonths` request-time eligibility gate. But all those rules applied to
the **whole group at once** — there was no way for Subsidiary A to grant 12 days while Subsidiary B grants 14
on the same leave type. There was also no way to issue a one-off festive grant (CNY / Raya / Deepavali).

This is **not a new entitlement engine** — it extends the existing one.

## Decisions

### (a) Reuse, not rebuild
Extend the existing accrual/grade engine. Add a nullable `company_id` to `leave_policy` (migration 0134).
Existing rows have `company_id = NULL` = group default — back-compat preserved.

### (b) Resolution semantics — strict scope short-circuit (the headline decision)
The requirement "a subsidiary may grant FEWER days than the group default" is **incompatible** with the old
"most-generous-by-days wins" resolver. The resolver (`core/leave.ts resolveGradePolicy`) now does:

> If ANY active policy is scoped to the employee's company, resolve **entirely within** the company-scoped
> subset (grade-match beats null-grade, max-days within that subset) and RETURN — the group (null-company)
> tier is **never** consulted. Otherwise fall back to the group subset, resolved exactly as before.

Pseudocode:

```
resolve(rows, gradeId, companyId):
  if companyId != null:
    companyScope = rows where r.companyId == companyId
    if companyScope nonempty: return resolveWithinScope(companyScope)   # short-circuit, no group fallback
  groupScope = rows where r.companyId == null
  return resolveWithinScope(groupScope)

resolveWithinScope(scope):                 # grade tier within the winning scope
  graded = pick(max-days over scope where gradeId == employeeGradeId)
  return graded ?? pick(max-days over scope where gradeId == null)
```

A company tier, once non-empty, **fully shadows** the group tier — a more-generous group policy cannot leak
through. Max-days "generosity" (task #86 floor-vs-policy philosophy) is preserved only **within** a single
scope tier (and grade sub-tier). When `companyId` is undefined OR every row is null-company, behaviour is
**byte-identical** to the pre-0066 resolver — the back-compat guarantee the regression tests assert.

The EA statutory floor (`max(pack.entitlement(code, years), pol.days)`) is applied at each call site AFTER
the resolver and is unchanged: it is law and still clamps a company override up to the statutory minimum. So
a company override of 12 with an EA floor of 8 yields 12; an override of 12 vs a group default of 16 yields
the company's 12.

### (c) Grade tiering within scope
Effective precedence: `company+grade > company+null-grade > group+grade > group+null-grade`, implemented as
scope short-circuit first, then grade short-circuit within the winning scope (not a flat 4-way max). The
`group+grade` rung is the existing 2E behaviour for group-wide policies — kept (free, grade resolution
already exists). If a client only wants company-vs-group, it collapses to "grade resolves within whichever
scope wins", which is exactly what the chosen implementation already does. No extra rung.

### (d) RLS
`leave_policy` keeps **tenant-wide READ** (the accrual kernel resolves policies under possibly non-admin
sessions; a `FOR ALL USING(is_admin_for)` would silently zero-out reads). WRITE is tightened to be
company-aware using the proven nullable pattern from `0035_performance_rls`:
`WITH CHECK (... AND CASE WHEN company_id IS NULL THEN app.is_group_admin() ELSE app.is_admin_for(company_id) END)`.
A single-company admin can no longer write a tenant-wide or other-company policy. Folded into the column
migration — no separate RLS migration file. (`0128_payroll_policy_rls` is NOT a valid template — its
`company_id` is NOT NULL.)

### (e) Festive grants — Model 3, no new table
A festive grant = N `leave_ledger` `adjustment` rows (one per targeted employment, dated `effectiveOn`, with
a human `reason` e.g. "CNY 2026") + ONE summary `DomainEvent` (`leave.ad-hoc.granted`,
`aggregateType: 'leave-grant'`). Migration 0134 adds a nullable `leave_ledger.reason` text column for the
provenance + idempotency key. The service (`grantAdHocLeave`):

- **Authority:** a group-wide grant (`companyId = null`) requires a GROUP admin; a company grant requires
  admin authority over that company. A company-scoped admin attempting a group-wide grant is rejected
  outright — never silently scoped down.
- **Target set:** active employments as of `effectiveOn` (`hiredOn <= effectiveOn` and not terminated
  before it — mirrors `openLeaveYear`'s `terminatedOn >= start` convention), targeted by
  `employment.companyId` (no double-grant across multi-company employment under one company-scoped grant).
- **Idempotency:** skip any employment that already has an adjustment for the exact
  `(leaveTypeId, effectiveOn, reason)` — re-running the identical grant is a no-op.
- Returns `{ granted, targeted }` so a partial write under `can_see_employment` RLS surfaces as an explicit
  number (the UI confirm-count), never a silent partial.

Festive leave types are expected to live **OUTSIDE** `STANDING_LEAVE_CODES`
(`['ANNUAL','SICK','HOSPITALIZATION']`) so the accrual / `openLeaveYear` / expiry engines never touch them —
this is the deliberate reason festive days escape annual carry-cap/forfeit.

**Read-layer fix:** because `adjustment` is excluded from the `accrued`/`cycleAccrual` aggregates
(`read.ts`), the entitlement breakdown view adds an `otherAdjustments` line (positive in-cycle adjustments)
so the displayed breakdown reconciles with `balance`.

### (f) Expiry clawback — DEFERRED
`expiresOn` is accepted and stored only as an event-payload note; **no sweep this pass.** Clawback would
require attributing consumption (debits) to a specific grant (FIFO/LIFO) which the ledger cannot do without a
`source_grant_id` link, and `expireCarriedLeave` filters to `STANDING_LEAVE_CODES` so "mirror it" would
silently no-op against a non-standing festive type. Documented follow-up: add `source_grant_id` + a dedicated
festive sweep if ever wanted.

### (g) Qualifying-period accrual delay — DEFERRED
The request-time `minServiceMonths` gate (`assertEligible`) already blocks *taking* leave early. A separate
"delay when leave starts building up" timer is a documented follow-up only.

### (h) Uniqueness — DELIBERATELY NO constraint (current state retained)
The existing engine intentionally allows multiple active policies for the same
`(company, leave_type, grade, valid_from)` and resolves the **most-generous one within the scope tier**
(task #86 floor-vs-policy max; exercised by `grade-based-leave.test.ts`'s "two null-grade defaults → 16
wins"). Adding a partial unique index (the `holiday` coalesce-to-nil-uuid sentinel, scoped to include
`valid_from`) would break that established, tested behaviour. So this pass keeps the current no-constraint
state — only the `leave_policy_company_idx` lookup index is added. If de-duplication is ever wanted it must be
paired with a resolver change that no longer relies on multiple same-scope rows.

## Call sites changed (all five — the central correctness requirement)
Every place a balance is granted or shown now threads the employee's company into `resolveGradePolicy`:
1. `accrueEarnedLeave` — per-company monthly/quarterly accrual.
2. `openLeaveYear` — per-company year-open entitlement.
3. `expireCarriedLeave` — caps/forfeits carried leave using the employee's OWN company policy.
4. Hire-time grant (`core/org.ts`) — per-company UPFRONT entitlement for new joiners.
5. Balance read view (`core/read.ts leaveEntitlementBreakdown`) — `/me` + admin show the per-company number.

## Consequences
- Each subsidiary runs its own leave entitlement under one system; a company override always wins for that
  company (even lower), with no regression for group-wide rules.
- HR issues festive leave in a few clicks (company + leave type + days + date + reason), audited by one event
  with the per-employee ledger rows as the per-item record.
- Deferred: festive expiry clawback and a separate accrual-delay timer.

# ADR-0040 — Earned leave accrual (Leave 2.0 · 2D)

Status: Accepted · 2026-06-23 · Sub-ADR of [ADR-0038](0038-leave-2.0.md) §2D · phased

## Context

Leave is granted today as a **lump sum** at the start of the leave year: `openLeaveYear` writes one
accrual ledger entry per employee/type on 1 Jan for `max(EA-floor, policy.annualDays)`. The consultant
(#18) wants **earned accrual** too — the entitlement accruing through the year (monthly/quarterly),
pro-rated for mid-year joiners — and a configurable **leave cycle** (calendar vs join-date anniversary).

## Decision

The accrual *method* lives in the existing `leave_policy.accrual` JSONB (an extension point — no
migration): `{ annualDays, carryForwardMax, method?: 'lump_sum' | 'earned_monthly' | 'earned_quarterly' }`.
Default / absent = `lump_sum` (today's behavior, untouched).

- **lump_sum** — `openLeaveYear` grants the full year's entitlement on the cycle start, as now.
- **earned_monthly / earned_quarterly** — `openLeaveYear` SKIPS these (no lump grant); instead a new
  idempotent `accrueEarnedLeave(ctx, { asOf })` grants the **earned-to-date** amount: it tops the
  ledger up to `entitlement × (periods_elapsed / periods_in_cycle)`, where `entitlement = max(EA-floor,
  policy.annualDays)`. Re-running with the same `asOf` grants nothing (it only writes the shortfall);
  periods are counted from the later of the cycle start and the employee's join month, so joiners are
  pro-rated automatically. Triggered by an admin action now; a monthly cron in 2D-2.

### The floor invariant (ADR-0038 §5, NON-NEGOTIABLE)

The per-period grant is `entitlement / periods`, so over a full cycle a full-year employee earns exactly
`entitlement = max(EA-floor, policy.annualDays) ≥ floor`. Earned accrual therefore reaches the statutory
floor by year-end **by construction**. For a mid-year joiner the earned total is pro-rated — which
matches the EA's own pro-ration of a partial year, so the floor is still met for the period worked. A
test pins this: full-cycle earned total == `entitlement` and `entitlement ≥ floor`.

## Phasing

- **2D-1 (this slice):** the method config + `accrueEarnedLeave` + `openLeaveYear` skip-earned + the
  admin method selector + a "run accrual" admin action, on a **calendar** cycle (1 Jan – 31 Dec). Demo
  seeds one type as earned so partial balances are visible. Gated by the per-policy method, so every
  existing lump-sum company is unaffected.
- **2D-2 (accepted 2026-06-23, below):** the **join-date anniversary** cycle option, and a monthly cron
  that runs `accrueEarnedLeave` unattended (reusing the same idempotent service the admin action calls).

## Consequences

- Earned employees show a *growing* balance through the year instead of a full balance on day one —
  the behavior the consultant asked for. Lump-sum stays the default, so nothing regresses.
- The ledger remains the single source of truth; `accrueEarnedLeave` only ever appends the shortfall,
  so it is safe to run any number of times (cron, admin button, or after a policy change).

## 2D-2 — anniversary cycle + cron (accepted 2026-06-23)

A new per-company `company.leave_cycle` ('calendar' default = the 2D-1 behavior, or 'anniversary')
selects the earned-accrual cycle. Additive + defaulted, so every existing company keeps the calendar
year and nothing regresses.

- **calendar** — the cycle is 1 Jan – 31 Dec; mid-year joiners pro-rate from their join month (2D-1).
- **anniversary** — each employee's cycle is anchored to their **hire-month anniversary**. The current
  cycle starts at the most-recent hire-month anniversary on/before `asOf`, and earned-to-date is
  `entitlement × periods(cycleStart → asOf) / periods_in_cycle`. Because the cycle is anchored to the
  hire month, a joiner's first cycle starts at hire automatically — no separate pro-ration branch.

`accrueEarnedLeave` resolves each employee's cycle start from their company's `leave_cycle`, and the
"already accrued this cycle" guard is computed per-employee against that cycle start (the SQL fetches
only the trailing ~12 months of accrual rows, so it stays a bulk query, not per-employee round-trips).
It remains idempotent and the floor invariant still holds (a full cycle accrues exactly
`max(EA-floor, policy days)`).

**Cron.** `scripts/accrue-earned.ts` (the `leave:accrue` script) runs out-of-band like
`statutory-sync.ts`: it enumerates tenants with the owner role, then runs `accrueEarnedLeave` per tenant
with a SYSTEM context (no `userId`, so the event actor is `system`) at `asOf = today`. Monthly via the
deploy host's cron. Being idempotent, an extra run grants nothing.

### Deferred (2D-3): earned-type cycle-boundary forfeit

`openLeaveYear` skips earned types entirely, so the **carry-forward cap is not yet enforced on earned
types at the cycle boundary** — unused earned leave currently carries forward uncapped (true for the
calendar earned cycle 2D-1 shipped, and for anniversary here). This is a separable correctness refinement
(it needs the per-employee cycle start applied to a balance-as-of query to stay scalable for large
tenants) and does not affect within-cycle accrual or the demo (which runs inside a single 2026 cycle).
Tracked as a follow-up; lump-sum types are unaffected (`openLeaveYear` still caps/forfeits those on 1 Jan).

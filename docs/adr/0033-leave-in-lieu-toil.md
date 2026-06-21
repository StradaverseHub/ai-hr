# ADR-0033 — Leave-in-lieu (Time Off In Lieu / compensatory replacement leave)

- **Status:** Proposed (design only — no code; gated `TOIL_ENABLED`, off by default)
- **Date:** 2026-06-21
- **Builds on:** ADR-0011 (attendance time engine), ADR-0032 (Phase C shift rosters — `rosterVariance` `rest_worked` + day-typed `otMinutes`), ADR-0019/0025 (OT pay pack + typed pay components), ADR-0006 (domain-event substrate)
- **Pull-through:** motivates ADR-0034 (notification engine) as its first cross-module consumer

## 1. Context

Phase C made the time engine roster-aware: every worked day now carries a `dayType` (`workday` / `rest_day` / `holiday`) and `otMinutes`, and `rosterVariance` flags `rest_worked`. Today those minutes have exactly one downstream path — **`prefillOvertimeFromAttendance`**, which monetises them at the EA-1955 statutory premiums (workday 1.5×, rest-day ½/1-day + 2×, holiday +2 days' ORP + 3×) behind the First Schedule **RM4,000** eligibility gate (`localization/my/payroll.ts`, sourced in `STATUTORY-SOURCES.md`).

For a deskless, shift-based anchor (Chin Hin, ~4,500 staff working rest days and holidays), many employers prefer to **bank replacement time off** instead of paying the OT premium in cash. That is "time off in lieu" (TOIL) / compensatory leave. It is the natural second consumer of the same `otMinutes` the OT-pay path already reads.

The leave side is ready to receive it: `leaveLedger` is a signed day-denominated ledger (`balance = Σ days`), credits are plain inserts (see `core/org.ts` entitlement grant, `core/leave.ts` carry-forward), and takes debit negatively. A TOIL credit is structurally identical to a grant.

## 2. The statutory boundary (the load-bearing constraint)

**TOIL is contractual, not statutory, and it must never silently displace a statutory pay entitlement.** Sourced position:

- The EA-1955 premiums for work on a **rest day** (s.60(3)), **overtime** (s.60A, 1.5×), and **public holiday** (s.60D — 2 days' wages + 3× for OT) are statutory minimums for First-Schedule employees (wages **≤ RM4,000/month**). They cannot be contracted below.
- Substituting a **paid day off for the cash premium** is permissible **only by prior mutual agreement with the employee** ([aJobThing — compensatory leave](https://www.ajobthing.com/resources/blog/compensatory-leave-malaysia-what-employers-need-know), [aJobThing — substitute holidays vs replacement leave](https://www.ajobthing.com/resources/blog/substitute-holidays-vs-replacement-leave-malaysia)). It is not a default the employer may impose unilaterally.
- For employees **> RM4,000** (not First-Schedule), there is no statutory OT entitlement ([JustLogin — MY payroll](https://support.justlogin.com/hc/en-us/articles/51929884395673-Malaysia-Labor-and-Payroll-Common-Questions)), so rest-day/holiday/OT compensation — cash or TOIL — is **entirely contractual**.

Therefore the system's job is **not** to decide whether TOIL is lawful in a given case (that is the customer's employment-counsel call). Its job is to make the choice **explicit, agreement-gated, audited, mutually exclusive with pay, and fail-safe toward the statutory floor.** This mirrors the Phase C shift-differential discipline ("configurable/contractual, never override statute, fail-safe to the statutory path").

Concretely, three invariants the engine enforces:

1. **No double compensation.** The same worked `(employment, date, dayType)` OT is compensated as cash **xor** TOIL — never both. `prefillOvertimeFromAttendance` skips days claimed in the TOIL register; TOIL accrual refuses days already monetised in an open batch.
2. **Statutory floor is the default and is never extinguished.** For First-Schedule-eligible (≤ RM4,000) employees, cash is the default; electing TOIL raises a **compliance warning** and unused TOIL **converts to pay on expiry — it never lapses**, so the statutory value is never silently lost. For non-eligible (> RM4,000) employees, TOIL-vs-cash is a free choice and unused TOIL may lapse if policy says so.
3. **Prior agreement is explicit.** TOIL accrual is an **elected + approved** action (or a pre-accepted standing policy), recorded with an actor and a domain event — not an implicit conversion.

### Out of scope (v1, distinct concerns)
- **s.60D(1A) substitute public holiday** (moving *which calendar day* is the gazetted paid holiday) — a holiday-calendar concern, not a leave-ledger credit. Future, separate.
- **Auto-accrual without election**, **hourly-granularity TOIL** (v1 is day-denominated, fractional days allowed), and **§60C averaging** (already deferred in ADR-0032).

## 3. Decision

Add a **gated, contractual TOIL engine** that turns elected-and-approved rest-day/holiday/OT work into a `REPLACEMENT`-type leave credit, mutually exclusive with OT pay, with a statutory-safe expiry policy. Off by default (`TOIL_ENABLED`); when off the system is byte-identical to today.

### 3.1 Data model
- **`REPLACEMENT` leave type** (new MY-pack type: paid, `counting = working_days`) — TOIL is taken as a normal leave request against this type, so balance/booking reuse the whole leave stack unchanged.
- **`leaveEntryType` enum** gains `in_lieu_accrual` (the credit entry) so TOIL credits are distinguishable in the ledger from entitlement grants / carry-forward / takes (audit + reporting).
- **`toil_policy`** (one row per company, gated): `enabled`, `accrualBasis` (`hours_worked` 1:1 | `premium_equivalent` at the statutory multiplier), `expiryDays`, `onExpiry` (`convert_to_pay` | `lapse`), `allowFirstScheduleEligible` (default false ⇒ warn). RLS: company-admin write / tenant read (like `attendance_policy`).
- **`toil_accrual`** (the register, the source of truth for mutual-exclusion + expiry): `employmentId`, `workedDate`, `dayType`, `otMinutes`, `daysCredited`, `accrualBasis`, `expiresOn`, `status` (`active` | `taken` | `converted_to_pay` | `lapsed`), `policyId`, `ledgerEntryId`. RLS: `can_see / can_admin_employment` (like `roster_assignment`).

Each accrual writes **both** a `toil_accrual` row **and** a `leaveLedger { entry_type: 'in_lieu_accrual', leave_type: REPLACEMENT, days: +daysCredited, effective_on: workedDate }` credit, so the existing `leaveBalance` sum just works.

### 3.2 Accrual math
`daysCredited` from `otMinutes`:
- `hours_worked` (default, conservative): `otMinutes / scheduledMinutesPerDay` (e.g. 8h day ⇒ 480; a full rest-day shift ⇒ ~1.0 day), fractional to 2 dp.
- `premium_equivalent`: `hours_worked × statutory multiplier` for the `dayType` (rest-day/holiday richer) — banks the premium's worth of time. Configurable; not the default.

### 3.3 Workflow (reuses existing substrates)
- **Source:** Phase C `rosterVariance.rest_worked` + attendance `otMinutes` by `dayType`.
- **Elect:** employee or manager elects TOIL for an eligible worked day → **approval** (reuses `assertCanDecide` + the approvals inbox) = the explicit prior agreement. On approve: write `toil_accrual` + ledger credit + `toil.accrued` event.
- **Take:** a normal leave request against `REPLACEMENT` (debits the ledger; marks the consumed accrual `taken`).
- **Expire:** a scheduled sweep flips `active` accruals past `expiresOn` to `converted_to_pay` (emits a payroll input/typed component at ORP) or `lapsed`, per policy — **convert is forced for First-Schedule-eligible employees regardless of policy.** This sweep is where the **job scheduler + notification engine (ADR-0034)** are first needed (expiry-approaching + converted alerts); v1 ships a manual admin "run expiry" action, with the cron pull-through tracked as 33-7.
- **Mutual exclusion:** `prefillOvertimeFromAttendance` excludes `(employment, date)` present in `toil_accrual (status != lapsed)`; accrual refuses a day already monetised in an open batch.

### 3.4 Gating & substrate
- `TOIL_ENABLED` env flag (default off ⇒ no schema reads, no leave type seeded behaviour change, byte-identical). Mirrors `TYPED_PAY_COMPONENTS_ENABLED` / Phase C discipline.
- Every state change appends a `DomainEvent` (`toil.accrued`, `toil.expired`, `toil.converted`; takes ride on `leave.requested`/`leave.decided`).

## 4. Slice plan
- **33-1** — this ADR.
- **33-2** — schema: `toil_policy` + `toil_accrual` + `REPLACEMENT` leave type + `leaveEntryType += in_lieu_accrual`; migration + RLS (gated, backfill-safe). No behaviour when flag off.
- **33-3** — core `core/toil.ts`: `setToilPolicy`, `accrueToil` (election+approve, eligibility/compliance guard, ledger credit + register row + events), and the OT-pay mutual-exclusion guard in `core/payroll.ts`. Gated.
- **33-4** — expiry: `runToilExpiry` (convert-to-pay | lapse; forced convert for eligible) as a manual admin action; cron pull-through flagged for ADR-0034.
- **33-5** — UI: elect-TOIL from the roster-variance / attendance surface; `REPLACEMENT` balance on `/me`; `toil_policy` admin page; i18n ×6.
- **33-6** — tests: accrual math (1:1 + premium), mutual exclusion vs OT pay, eligible-employee forced convert-on-expiry, gated no-op; browser-verify.
- **33-7 → ADR-0034** — notification engine consumes TOIL events (accrued / expiring / converted) over in-app + email + WhatsApp.

## 5. Consequences
- **Positive:** closes the attendance→leave loop with the highest synergy on the board; a real deskless need; safe-by-construction against the statutory floor; reuses leave ledger + approvals + events wholesale; gives ADR-0034 a concrete driver.
- **Negative / risks:** TOIL's lawfulness for First-Schedule employees is genuinely contested — mitigated by warn + forced-convert-on-expiry + counsel deferral, never an assertion by the system. Mutual-exclusion with OT pay adds a cross-check both code paths must honour (covered by 33-6). `premium_equivalent` accrual interacts with ORP and is opt-in, not default.
- **Reversible:** flag-gated; off ⇒ byte-identical; the register is additive.

## 6. Open question for the customer (pre-33-3)
One decision the system cannot make: for First-Schedule-eligible (≤ RM4,000) staff, does the customer's policy + counsel permit TOIL **at all** (with forced convert-on-expiry), or should TOIL be **restricted to > RM4,000** employees only? The engine supports both via `allowFirstScheduleEligible`; the default ships **false** (TOIL offered only where no statutory OT entitlement exists) as the conservative posture.

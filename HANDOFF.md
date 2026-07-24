# Handoff — ai-hr

Updated after **every release/deploy**. Newest round first; older rounds compress to a line.

The high-value part of each entry is **Decisions** — calls that the tickets themselves did not
settle. Those cannot be reconstructed from the diff later; everything else can.

---

## r67 — 2026-07-24 — 3 approved feedback items

**Shipped:** `build/r67@038d2db` → merged to `main` as `76f3195`. All 3 `deployed`. Service restarted
13:26 +08 (`✓ Ready in 106ms`, journal clean).

**Gate:** `tsc --noEmit` clean · `next build` clean · **4515/4515 tests, 427 files**. No flaky failure —
the zakat substring assertion fixed in `91b2e4d` (this session) held.

| id | Item |
|---|---|
| `1c541ceb` | Search popup (Cmd-K → Approval Delegation) cut-off: one scroll region, wider dialog, edit form no longer stretches the table |
| `b1b81a08` | Grade config moved from Leave Config → System Settings → System Label → Organization Label |
| `643d38e7` | Leave request popup: A–Z localised type sort, Pending/Taken/Balance summary, expandable day-by-day panel |

### Decisions

**1. `643d38e7` fixed a defect the ticket didn't name.** `previewLeaveDeductionAction` returned `null`
whenever `employmentId` was empty, and a self-service employee always reaches it empty — so the "this
will deduct N day(s)" line had been **silently dead for regular employees**, only ever rendering for an
HR/manager applying on someone's behalf. The build added the `myEmployment(session)` fallback
`requestLeaveAction` already used. In scope because the summary the ticket *did* ask for is meaningless
without it.

**2. Off-day vs rest-day was deliberately NOT split.** The reporter's example distinguished Saturday
"Off day" from Sunday "Rest day", but the leave engine treats every non-working weekday identically when
deciding deductions. Both render as "Rest day". Faking the split would make the day-by-day panel
disagree with the deducted-days total directly above it. Flagged to the reporter in the plan; a proper
off/rest split is its own future item.

**3. `b1b81a08` is a UI move with NO data migration — by design.** Grade rows are not copied, renamed,
or recreated; only the management screen relocates, so every employee / entitlement / benefit-scheme /
claim-limit / approval-rule reference keeps resolving to the same row. Delete guards were *tightened*
(now also blocked when a grade is used by an approval rule, claim limit, or grade group). Two
company-scoped extras (spreadsheet export, multi-row paste) intentionally not carried over — today's
grade screen has neither, so nothing is lost.

### Integration

Clean. Only `messages/*.json` (6 locales) was touched by more than one patch, and they merged without
conflict — each patch appends its own keys. No hand-merging, unlike r66. This is the payoff of building
off a `main` that already contained the prior round rather than racing patches off a stale base.

### Notable quality point

The leave summary and the day-by-day row total are **not** computed independently — both reuse the same
`leaveBalance()` / `previewLeaveDeduction` source the headline deducted-days figure already uses (day
rows fold in behind an `includeDayRows` flag, keeping the no-flag return byte-identical). So the three
numbers in the popup are structurally incapable of disagreeing. ESS visibility config honoured (a figure
HR has hidden shows as a dash, not revealed).

### Outstanding

- Nothing to build for r67.
- The r66 anniversary accrual decision (r66 Decision 1) is now **on the reporter's plate as a board
  item**: `adcdf215` "Confirm how first-year leave is calculated for Anniversary to Calendar joiners"
  (status `open`, raised 2026-07-24 via the new `pnpm improve:raise`). It proposes switching to the
  up-front-grant method; **approve = switch, reject/ignore = keep the current build-up (accrual-to-date)
  behaviour that is live now.** Framed as a single concrete change so it respects the board's
  approve-carries-no-payload rule — it does not ask the reporter to pick between options. Until they
  act, the board is not fully clear: it has this one open item awaiting a plan.

---

## r66 — 2026-07-24 — 12 approved feedback items

**Shipped:** `build/r66@e76d082` → merged to `main` as `7666b2e`. All 12 items `deployed` on the board.

**Gate:** `tsc --noEmit` clean · `next build` clean · **4463/4463 tests, 425 files**.

| id | Item |
|---|---|
| `1a429431` | Organization — HRDF Contribution Rate; employer headcount restriction removed |
| `9b0d99f3` | Approval Workflow — split Template Creation from Assignment Template; collapsed assignment list |
| `1bd9a911` | Leave Type list — A–Z sort + fixed-height scroll panel |
| `3c093c7a` | Removed the Statutory Minimum (MY) row |
| `0c15db78` | Secondary Step 1 — criteria shown directly, no "Edit Rules" click |
| `0d1a0cfc` | Leave entitlement scheme selection now references Benefit Schemes, not Grades |
| `4e9a4d59` | Stay on the current page after saving a Leave Type |
| `f3a64d90` | Anniversary-to-Calendar (a2c) entitlement — enablement + day-accurate accrual |
| `18e15fc1` | a2c doc alignment (functional work shipped via `f3a64d90` — see Decisions) |
| `eee43966` | Earning Method decoupled from the Eligibility tab |
| `b81d3c52` | Rounding Method under Earning Method |
| `b8fcae73` | Leave Type config workflow restructured; Eligibility step removed |

### Decisions

**1. The two anniversary tickets were contradictory, not merely overlapping.** Both were approved;
both were built blind to each other off `main`; both created migration
`0310_leave_type_year_cycle_override_a2c.sql` with **byte-identical SQL** and different rationale
comments. They disagree on what a first-year joiner is entitled to:

- `18e15fc1` — grants the whole prorated first year up front: `20/365 × 360 (join → 31 Dec)` = **19.73**
- `f3a64d90` — accrues day-by-day to the calculation date: `20/365 × 199 (join → 23 Jul)` = **10.90**

**Shipped `f3a64d90`'s semantics.** It is the later corrective ticket, it carries the reporter's
explicit expected figures (10.90 for EMP-0003 Mei Ling), and its own ticket text says it should land
after `18e15fc1`. `18e15fc1`'s contribution was reduced to its documentation hunks (`db/schema.ts`,
`app/admin/actions.ts`), which were comment-only and still claimed a2c was disabled/rejected —
stale and misleading once the feature went live.

> **Open for the reporter:** this determines whether a new joiner sees their full prorated year
> immediately or watches it build daily. Currently: **builds daily**. One-function change to flip
> (`a2cFirstYearEntitledToDate` / `firstYearAnnualDaily` in `core/leave.ts`).

**2. `b81d3c52` referenced a retired i18n key.** Cut against `main`, it used `subStep.pendingEngineNote`,
which `eee43966` had renamed to `subStep.resignationPendingNote`. Shipped as-built it would have
rendered a missing-key error. Repointed during the merge.

**3. `eee43966`'s panel-structure tests targeted a card that `b8fcae73` deletes.** They located their
segment by `<CardTitle>{t('categoryEligibilityEntitlement')}</CardTitle>`; `b8fcae73` removes the
Eligibility step entirely and retires that key. Repointed at the Entitlement card the two forms
actually moved into — **verified all four assertions still bite** (no `name="method"` select, no
hidden method field, no `grant_on_hire_prorated` default, earned badge present) rather than passing
vacuously against an empty segment.

### Why one branch instead of 12 releases

Each item was built in its own isolated worktree off `main`, so every patch assumed it was the only
change. 9 of the 12 touch the same leave-config screens; `components/leave-type-panel.tsx` alone is
edited by 7. Releasing them one at a time would have had each deploy overwrite the last. They were
applied in dependency order on `build/r66`, conflicts resolved, then gated and shipped once.

### Outstanding

- [x] **`sudo systemctl restart aihr`** — done 2026-07-24 11:53 +08. Service `active`, `✓ Ready in
      105ms`, no errors in the journal; `GET /` returns 401, which is the demo's password gate
      working, not a fault. Note `deploy.sh` still declines sudo by design, but the `ubuntu` account
      has passwordless sudo for the unit, so the restart **can** be driven over SSH from here.
- [ ] Reporter's call on the anniversary accrual semantics (Decision 1).

### Notes

- `test/zakat-history.test.ts` is **flaky** and unrelated to this round. It asserts a domain-event
  payload does not contain the substring `100` to prove a cleartext amount never leaks, but the
  payload embeds a random company UUID — one containing `100` (e.g. `…ac1a-066711009fc2`) fails it.
  Failed once here, passed on rerun. Should assert on the amount field, not on `JSON.stringify` of
  the whole payload.
- Local Postgres: the brew `postgresql@14` LaunchDaemon is registered under **root**, which Postgres
  refuses to run as, so the cluster does not come up on boot. Use `pnpm db:start`
  (data dir `/opt/homebrew/var/aihr-pg14`, port 5433). Fixable by re-registering it as a user
  LaunchAgent.
- The improve-loop SSH default (`IMPROVE_SSH_HOST=10.20.30.20`) times out; the server is reachable at
  **`203.142.6.241`**. Export the override or the pull/release commands hang.

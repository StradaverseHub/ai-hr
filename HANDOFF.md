# Handoff — ai-hr

Updated after **every release/deploy**. Newest round first; older rounds compress to a line.

The high-value part of each entry is **Decisions** — calls that the tickets themselves did not
settle. Those cannot be reconstructed from the diff later; everything else can.

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

- [ ] **`sudo systemctl restart aihr` on the server** — `deploy.sh` declines sudo by design, so the
      new build is on the box but not yet loaded.
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

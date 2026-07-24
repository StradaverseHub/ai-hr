# Handoff — ai-hr

Updated after **every release/deploy**. Newest round first; older rounds compress to a line.

The high-value part of each entry is **Decisions** — calls that the tickets themselves did not
settle. Those cannot be reconstructed from the diff later; everything else can.

---

## r68 — 2026-07-24 — 8 approved feedback items (a 9th deliberately not built)

**Shipped:** `build/r68@d8f9869` → merged to `main` as `c008ac3`. All 8 `deployed`. `deploy.sh` applied
migrations and restarted the service itself, 23:19:58 +08 (`✓ Ready in 139ms`, journal clean, `GET /` 401
= the password gate).

**Gate:** clean-room `cleanroom-verify.sh` **PASS** — empty DB migrated `0000` → `0311`, then
**4609/4609 tests, 432 files** run as `ai_hr_app` under RLS · `tsc --noEmit` clean · `next build` clean.
The receipt it writes (`.gate-receipt.json`) is what lets `improve:release` skip a redundant second suite.

| id | Item |
|---|---|
| `adcdf215` | Anniversary→Calendar first year switched to the up-front grant (closes r66 Decision 1) |
| `0b7eeb4b` | Service-Based Leave Entitlements restructured by company × grade |
| `02594a47` | Grade renamed to Job Grade; Organization Label layout aligned |
| `6574c6b4` | Medical / hospitalisation balance + YTD entitlement calculation fix |
| `5c928c07` | Configured rounding rule now reaches the displayed balance |
| `7648a6c7` | Leave criteria config gained the additional org-assignment fields |
| `9464bd56` | Personnel: company change allowed before payroll / transactions exist |
| `361e3b15` | New companies get the standard payroll-cycle catalog + a stored default (migration `0311`) |

### Decisions

**1. `bc9be1e8` was approved by the reporter and still deliberately NOT built — its own plan forbade it.**
The item removes the Company Entitlements tab; the approved plan carries a hard precondition: do not remove
it until add, edit **and delete** of a per-company policy all work inside Service-Based Entitlements. Its
companion `0b7eeb4b` shipped this round, so the precondition was checked against the merged result rather
than assumed. It fails. `ServiceEntitlementTable` (`components/benefit-scheme-config.tsx`) renders one row
per grade for a chosen company — three service-band figures, one Save button — and `saveServiceEntitlement`
writes exactly those three numbers. There is no add, no delete, no carry-forward, no accrual method, no
effective dates and no entitled-employee count; all of those still live only in the `policies` block the
item wants deleted. Removing that block now would destroy the only UI that can create or delete a
per-company policy — precisely the failure the precondition exists to prevent.

> **Open for the reporter:** `bc9be1e8` cannot be built until Service-Based Entitlements becomes the full
> entitlement editor. It stays `approved`, so it will resurface every round as approved-but-unbuildable
> until that gap lands or the item is withdrawn. The missing half is a product call, not a build detail.

**2. `361e3b15` crossed the payroll pack boundary; the fix was the facade, not the allowlist.** Its build
wired `seedPayrollCycleCatalog` into `createCompany` by importing `core/payroll-cycle` directly. That is a
boundary module under ADR-0080 D9, `core/admin.ts` is not audited debt, and the `payroll` list in
`test/pack-drift-allowlist.json` is documented shrink-only — so widening it was never an option.
Repointed at `packs/payroll/service`, the sanctioned path (`packs/payroll/` is always-allowed by the
ratchet); verified first that none of the twenty boundary modules import `./admin`, so this adds no cycle.
Two alternatives rejected: hoisting the seed into `app/admin/actions.ts` (already allowlisted, but it
would leave the seed outside `createCompany`'s transaction, so a failed seed strands a cycle-less
company), and calling `db/provision.ts`'s `seedCompanyCatalogs` (also allowlisted, but it additionally
inserts an `attendancePolicy` row — a behaviour change no approved plan asked for).

**3. `adcdf215` silently invalidated an assertion inside `5c928c07`.** Both were built off `main`, blind to
each other. `5c928c07`'s a2c rounding test hard-coded the pre-switch accrue-to-date figure — 20/365 × 199
days worked = 10.90, rounding up to 11. `adcdf215` is the approved switch to the up-front grant, so that
same employee's first year is now the whole join → 31 Dec slice: 20/365 × 360 = 19.73, rounding up to 20.
The 20 the suite reported was correct new behaviour, not a regression; the expectation was stale.
Repointed, and kept biting on what the test exists to prove — without the `up` method the figure stands at
19.73, so it still fails if rounding stops reaching the balance.

### Integration

**All 8 patches applied with zero textual conflicts — and that proved nothing.** Both gate failures
(Decisions 2 and 3) were patches that merged perfectly cleanly and still disagreed: one crossed an
architectural boundary no diff hunk can see, the other depended on a *number whose meaning* another patch
had changed. r66's lesson was about hand-merging textual conflicts; r68's is the complement. A clean
three-way merge is not evidence of agreement, and on a multi-item round the full suite is the only thing
that finds semantic collisions. Do not let a conflict-free apply talk you into a shorter gate.

### Outstanding

- `bc9be1e8` stays `approved` and unbuilt (Decision 1) — the board is not clear.
- **8 further items were approved by the reporter while this round was building** and are queued for r69,
  all with plans attached: `57840a6e` (HRDF not calculated after payroll processing), `0315dac7`
  (incorrect leave balance), `f71dcafd` (notification icon UI), `7fe7e1ae` (action search bar),
  `421d7551` (rename My Absence → My Leave), `9e64ac20` (leave request popup — compact summary),
  `836118c4` (Approval → Approval Items with a combined pending count), `95aafb3c` (multi-company
  switcher). Two are `issue`-category and money/balance-facing, so they lead.
- Carried forward from r66, still live: local Postgres does not come up on boot (the brew
  `postgresql@14` LaunchDaemon is registered under **root**, which Postgres refuses to run as) — use
  `pnpm db:start`, data dir `/opt/homebrew/var/aihr-pg14`, port 5433. And the improve-loop SSH default
  (`IMPROVE_SSH_HOST=10.20.30.20`) times out; the server is at **`203.142.6.241`** — export the override
  or every pull/release hangs. `.improve/watch.log` shows the hourly watcher still failing on the stale
  default, so it has been reporting `approved=0` while the board filled up.

### Notes

- The r66 `test/zakat-history.test.ts` flake did not recur; the `91b2e4d` substring fix has now held
  across two full runs.
- `cleanroom-verify.sh` refuses to start while anything else holds a client connection to the local
  Postgres (the R46/R47 lesson: a contended gate reported phantom failures). Kill stray vitest runs and
  the dev server first, or it exits `FAIL (contention)` without testing anything.

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

`build/r66@e76d082` → `main` as `7666b2e`. All 12 `deployed`. Gate: 4463/4463 tests, 425 files. The round
that established the one-branch rule: 9 of the 12 touched the same leave-config screens and
`components/leave-type-panel.tsx` alone was edited by 7, so releasing them one at a time would have had
each deploy overwrite the last. Two anniversary tickets (`18e15fc1`, `f3a64d90`) turned out to
*contradict* each other — same migration SQL, different first-year entitlement — and shipping
`f3a64d90`'s accrue-to-date semantics left the question open; **r68's `adcdf215` closed it** by switching
to the up-front grant with the reporter's approval. Two further merge repairs: `b81d3c52` referenced an
i18n key `eee43966` had renamed, and `eee43966`'s panel tests targeted a card `b8fcae73` deletes (both
repointed, assertions verified to still bite). Its live operational notes are carried in r68's Outstanding.

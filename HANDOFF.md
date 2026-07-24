# Handoff — ai-hr

Updated after **every release/deploy**. Newest round first; older rounds compress to a line.

The high-value part of each entry is **Decisions** — calls that the tickets themselves did not
settle. Those cannot be reconstructed from the diff later; everything else can.

---

## r69 — 2026-07-25 — 8 approved feedback items

**Shipped:** `build/r69@f56ccb7` → merged to `main` as `93d9d18`. All 8 `deployed`. `deploy.sh` migrated
and restarted the service, 00:04:23 +08 (`✓ Ready in 125ms`, journal clean, `GET /` 401 = password gate).

**Gate:** clean-room **PASS** — empty DB migrated `0000` → latest, then **4672/4672 tests, 436 files** as
`ai_hr_app` under RLS · `tsc --noEmit` clean · `next build` clean. **Zero integration failures** — the
first multi-item round in a while where nothing collided (contrast r68, which had two).

| id | Kind | Item |
|---|---|---|
| `57840a6e` | issue | HRDF contribution not calculated after payroll processing |
| `0315dac7` | issue | Incorrect leave balance |
| `f71dcafd` | issue | Notification icon UI — colliding count bubbles |
| `7fe7e1ae` | issue | Action search bar input spilling past the popup edge |
| `421d7551` | enhancement | "My Absence" renamed to "My Leave" |
| `9e64ac20` | enhancement | Leave request popup — deduction box replaced with a compact summary |
| `836118c4` | enhancement | "Approval" → "Approval Items" with a combined pending count |
| `95aafb3c` | enhancement | Multi-company switcher — bulk select/deselect |

### Decisions

**1. `57840a6e`'s ticket diagnosed the wrong layer — the payroll engine was never broken.** The report
was "HRDF not generated after payroll processing"; the engine computes HRDF end to end and always did.
The real defect was one control upstream: Subject-to-HRDF was a **checkbox**, which structurally cannot
carry the tri-state the data model uses (`null` = follow the company's registration default, `true`/
`false` = explicit override). An untouched card rendered unchecked while the company was
`not_registered`, so saving that card for *any* unrelated reason silently wrote an explicit **No** —
permanently excluding that employee from the levy even after the company later set a 0.5%/1.0% rate. Now
a three-option select. The corrective for already-damaged rows uses the **DomainEvent log as the
discriminator**: a No written while the company was `not_registered` is provably accidental and resets to
null; a No written while registered is HR's real decision and is left alone; anything untraceable is
**reported for HR rather than auto-changed**. That last branch is the important one — it declines to
guess on exactly the rows where guessing would silently overwrite a human decision.

**2. `0315dac7` was rebuilt as a raw ledger partition, because the old arithmetic was algebraically
false.** The Leave Breakdown derived its carry figures rather than partitioning the ledger, which does
not close after a year-open cap forfeit, a `maxBalanceDays` clamp, or an overdrawn carry-in.
`leaveEntitlementBreakdown` now sorts every ledger row ≤ asOf into **six disjoint buckets**, so
`Σ buckets = balance` and `balance − pending = available` hold *by construction* rather than by
agreement. The old single "Adjustment" line is split into config adjustments (which tie line-by-line to
Leave Config → Entitlement → Adjustment) and a separately labelled **"System corrections"** row for the
automatic `sys:policy_recalc` / `sys:profile_recalc` entries the commingled figure used to hide.

> **⚠ Not confirmed against live data.** The reported symptom — an employee showing 13 days of adjustment
> with nothing on the Adjustment screen — was **never reproduced**. The local dev DB has no adjustment
> rows for her (ANNUAL accrual 6.00 only), and the read against the live server was blocked by the
> permission classifier. Both faults are proven from code and pinned by tests, and the symptom *matches*
> fault 1 (an unlabelled system correction surfacing inside the commingled Adjustment line) — but that is
> inference, not verification. **Worth confirming on the deployed data before telling the reporter it is
> fixed.**

**3. `836118c4` deviated from its approved plan, correctly.** The plan directed editing
`messages/i18n.csv` and running `pnpm i18n:import`. But `messages/*.csv` is **gitignored** (line 52) and
untracked — it is a regenerable working file, absent from a fresh worktree entirely. A CSV edit could not
have shipped in the patch, and the plan's CSV round-trip assertions would fail on any clean clone. Built
against the six tracked JSON catalogs instead (the precedent every other i18n test follows) and replaced
the CSV assertions with hard-coded expected strings per locale, which still catches a stale-CSV import
reverting the rename. **Future plans touching i18n should stop specifying the CSV round-trip.**

**4. `95aafb3c`'s "Deselect all" deliberately does not submit.** `getScopeIds` (`lib/scope.ts`) coerces an
empty `company_scope` cookie back to *all* allowed ids, so submitting an empty selection would silently
re-tick every box. Deselect is therefore a client-side clear only; Select all commits with `flushSync`
before `requestSubmit()` so the bulk change posts the full id set.

### Integration

Much cleaner than r68: **no source file was touched by more than one patch.** The only shared surface was
the six locale files, which merged without conflict because each patch appends its own keys (6488 → 6501,
parity ✓ across all six). All 8 applied with `git apply --3way` and zero conflicts, and the full suite
found nothing — so this round's clean textual merge *was* a clean semantic merge. That is a property of
this particular item mix, not a general rule; r68's counter-example still stands.

`421d7551`'s build flagged a coordination risk for the integrator — that `9e64ac20` might also edit the
renamed keys or add a second sidebar row. Checked: `9e64ac20` touches neither key, `packs/leave/index.ts`
still declares exactly one `labelKey: 'myAbsence'` row, and all six locales carry the in-language term.

### Outstanding

- `bc9be1e8` remains `approved` and unbuildable — see r68 Decision 1. It was deliberately excluded from
  this round's build rather than left to triage, because its precondition is now *half* met (`0b7eeb4b`
  shipped in r68) and an agent reading only the plan could wrongly conclude it is buildable.
- **The blocker behind it is now on the board as `2bba9e35`** (status `open`, raised 2026-07-25):
  "Make Service-Based Entitlements the single place to manage company entitlement policies" — add,
  delete, carry-forward / earning method / effective dates, and the covered-employee count, all against
  the same policy records the old tab writes (no copy, so the two cannot disagree while both exist).
  Framed as one concrete change so it respects the approve-carries-no-payload rule. **Build order is
  forced: `2bba9e35` must ship before `bc9be1e8` can be built at all.**
- Confirm `0315dac7` against live data (see the warning above) before reporting it fixed.
- ~~Leftover `ahr_build_*` databases~~ — **cleared 2026-07-25**: 170 dropped, 3.2 GB reclaimed,
  `ahr_build_golden` deliberately kept (verified still migrated, 130 tables) because the build workflow
  clones it as its fast-path template. Note the cleanup pattern is `ahr_build_*` only; the older
  `ahr_r66_integration` / `ahr_r67_integration` / `ahr_preview_*` databases were left alone.
- The hourly watcher still polls the stale `IMPROVE_SSH_HOST` default and reports `approved=0` — it
  reported nothing while 8 items queued up. Fix the plist before it hides a real backlog again.

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

`build/r67@038d2db` → `main` as `76f3195`. All 3 `deployed`. Gate: 4515/4515 tests, 427 files. Search
popup cut-off (`1c541ceb`), Grade config moved to System Labels (`b1b81a08`), leave request popup with
localised type sort + Pending/Taken/Balance summary and a day-by-day panel (`643d38e7`). Two calls worth
keeping: `643d38e7` fixed an unnamed defect — `previewLeaveDeductionAction` returned null whenever
`employmentId` was empty, which is always true for a self-service employee, so the "this will deduct N
day(s)" line had been **silently dead for regular employees**, rendering only for an HR/manager applying
on someone's behalf. And off-day vs rest-day was deliberately NOT split, because the leave engine treats
every non-working weekday identically when deciding deductions; faking the split would make the day-by-day
panel disagree with the deducted-days total directly above it. Its three popup figures are structurally
incapable of disagreeing — all reuse the same `leaveBalance()` / `previewLeaveDeduction` source behind an
`includeDayRows` flag. First round to build off a `main` that already contained the prior round, which is
why its 6-locale merge needed no hand-editing unlike r66.

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

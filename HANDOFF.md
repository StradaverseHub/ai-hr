# Handoff — ai-hr

Updated after **every release/deploy**. This file holds ONLY the standing contract, the live state,
and the entry for any round still in flight. Shipped round entries live in
**`docs/HANDOFF-HISTORY.md`** (newest first).

**Rules for updating this file — the old version grew to 5,900 lines of layered contradictions and
sessions drowned in it (three different "deployed head" claims coexisted; a fresh session could act on
any of them):**

- **CURRENT STATE is a snapshot, not a log.** When a fact changes, REPLACE the line — never prepend a
  new block above a stale one. If a number changes (deployed head, next migration, board counts), the
  old number leaves the file.
- **When a round ships:** update CURRENT STATE in place, move the round's entry to the TOP of
  `docs/HANDOFF-HISTORY.md`, delete the in-flight entry here, and **refresh the code graph**
  (`graphify update .` in this worktree — incremental, seconds, no LLM). The high-value part of each
  entry is **Decisions** — calls the tickets did not settle; those cannot be reconstructed from the
  diff.
- **Keep this file under ~700 lines.** If it is longer, something here belongs in history.

## CURRENT STATE — snapshot 2026-08-18 (r195 RECOVERED · **r196 SHIPPED** · NOTHING IN FLIGHT · 9 APPROVED)

**`main@cd06bcda` IS WHAT RUNS ON PRODUCTION** — verified by an `rsync -azi --delete --dry-run` from
**mainwt** reporting ONLY `next-env.d.ts`, not by `deploy.sh` succeeding, which is not proof. Service
active, `GET localhost:3000/` → 401.
**Board re-counted on the box after r196: `deployed = 684` · `approved = 9` · `planned = 2` ·
`cancelled = 14` · open = 0.**

⚠️⚠️ **RUN THE DRY RUN FROM `mainwt`, WITH `cd` IN THE SAME COMMAND.** The shell's cwd resets to the repo
ROOT (`local/root-scratch`, far behind main) between tool calls, and a dry run from there reports thousands
of bogus differences and invents a crisis. This cost a full diagnostic pass on 2026-08-17 — the fourth time
the wrong-tree trap has landed.

**⚠️ SOMETHING OUTSIDE THIS REPO RELEASED r195 TO PRODUCTION ON 2026-08-17 ~22:05 AND IT IS STILL
UNIDENTIFIED.** `deploy-r195.log` on the box records the build; `0253dc7c`, `a6da1387` and `46afcc48` were
marked deployed at 22:09 with `build_ref = 004b098a`, **a commit that exists in no worktree here and in no
other clone on this machine**; the three build-started→completed→deployed triples land 1–2 seconds apart, so
nothing was built at that moment — they were *marked*. The local peer session confirmed it was not them;
there are no scheduled jobs. The WORK is real and in this repo's idiom (its comments cite the item ids).
**It has been recovered into main as `6bd2d99d` (merge `3b7238d5`)** by taking production's copy of the 15
differing files — all six catalogues verified strict supersets first, so nothing on main was lost — gated
tsc 0 / i18n-check PASS / 36 tests green. **Had a release gone out from main first, `rsync --delete` would
have reverted all three items silently.** If that actor runs again, expect the same shape.

**Production is on 360 migrations** (watermark `1781862541000` = `0441`, confirmed by reading
`drizzle.__drizzle_migrations` — NOT `public`, which is why a bare `__drizzle_migrations` query errors).
r196 added `0441` `payroll_individual_txn.intended_cycle_id` + `payroll_batch.payroll_cycle_id`; both
columns verified present on the live schema. r195 carried no migration.
**Next free migration is `0442`** (`0431` allocated and deliberately unused; gaps are fine).

**⚠️ THE LOCAL CLUSTER WAS GONE, NOT WEDGED, ON 2026-08-17** — `/opt/homebrew/var/aihr-pg16` was a BROKEN
symlink to an unmounted RAM disk (`…-ram/data`), so 5433 refused connections. Uptime showed no reboot, so
something unmounted it. `./scripts/dev-db-rebuild.sh` restored it in under a minute (8GB RAM disk,
`fsync=off`, `ai_hr_app` NOBYPASSRLS confirmed). Check for the broken symlink before theorising.

⚠️ **AI-HR IS NOT PUBLICLY EXPOSED — DO NOT "VERIFY" IT THROUGH A BROWSER.** It listens on
**127.0.0.1:3000 only**, and **nothing in nginx proxies to :3000** (checked r191:
`grep -rlE 'proxy_pass.*:3000' /etc/nginx/` returns nothing). The health check is
`curl localhost:3000/` **ON THE BOX** → **401**, the password gate, plus `systemctl is-active aihr`.
`https://203.142.6.241/` returns **403** and `sfm.stradaprop.com` is a **DIFFERENT APPLICATION** —
it redirects to `/odoo` and lands on an Odoo login (Odoo listens on 8069 on the same host). Neither
tells you anything about ai-hr; r191 chased both before establishing this.

## ▶ START HERE — WHAT THE NEXT SESSION SHOULD PICK UP

**1. NOTHING IS IN FLIGHT. THE APPROVED QUEUE IS 9 DEEP AND THE CONSTRAINT IS STILL US.**
r185–r196 are all shipped; `main@cd06bcda` is deployed and every `build/*` branch through r196 is merged.
Prove it independently rather than trusting this line — `git for-each-ref refs/heads/build` plus a dry-run
rsync FROM mainwt. **The 9 approved, all unbuilt at their current revision:**
  - **`1b0943d5`** entity transfer stage two — the one that matters, see §2. Needs `0442`.
  - **`3c88d593`** entity transfer, REFUTED after r194 by the reporter hitting the underpayment themselves.
    It and `1b0943d5` are one problem; plan them as one round.
  - **`9a65f808`** (rev 3) · **`31e39d74`** is SHIPPED, do not rebuild · **`bdf7d248`** EPF across cycles ·
    **`45df860a`** PCB/MTD detail view · **`152fea7f`** payroll full-width layout.
  - ⚠️ **`621c929d` / `d21e667e` / `e0cd4583`** are NEW IDS FOR STATUTORY FORMS WE ALREADY SHIPPED
    (`8ca344bf` Borang 8A, `9c8dad7a` Borang A, `88076362` CP22). Establish duplicate-vs-rework BEFORE
    planning a build, and read the statutory-form section below first.

⚠️ **`build_ref` IS NOT EVIDENCE THAT THE CURRENT REVISION SHIPPED.** A post-deploy refute
(`feedback.deployment.refuted`) → re-plan → approve leaves the OLD `build_ref` on the row beside a NEW plan
revision, so `pull-approved` legitimately returns items that look shipped. Six of the nineteen on 2026-08-17
were exactly that. Read the item's `domain_event` stream and compare the APPROVED revision against the one
that was built. `feedback.plan.approved` carries `{revision}` — that is the field to compare.

**1b. r196 SHIPPED SEVEN ITEMS AS `cd06bcda`** — `5ff7daff` · `31e39d74` · `c11e81aa` (`0441`) ·
`6b134681`+`417d4937` · `3c2f55d7` · `ad52212d` (rounds 1–2 only). Full entry in `docs/HANDOFF-HISTORY.md`.
**THREE FOLLOW-UPS IT DELIBERATELY LEFT, each verified and each cheap to lose:**
  - **A bonus/off-cycle run can now strand money and its run page will not say so.** `c11e81aa` lets a
    non-regular run collect rows naming its own cycle; the outstanding indicator on
    `app/payroll/[batchId]/page.tsx` is still gated to `runType === 'regular'`. Missing warning, not wrong
    money — the gate's comment now states this explicitly rather than implying the old, false invariant.
  - **`core/attendance-allowance.ts:337` still emits `…status-changed`**, which `lib/audit-format.ts`
    `actionOf()` classifies as `other`, so the Audit Trail filter cannot find those flips. `ad52212d` fixed
    the same shape in `core/attendance-rule.ts` but correctly refused to rename an event whose rows are
    already on production — that needs its own decision about the existing history.
  - **A CUSTOM leave type with an `earned_*` method accrues NOTHING, FOREVER.** `openLeaveYear` skips it as
    `earned_method` and `accrueEarnedLeave` only ever selects codes in `STANDING_LEAVE_CODES`, so neither
    engine ever visits it. `31e39d74` stopped the screen offering a remedy that cannot fire; the type still
    never earns. Worth raising as its own board item — nothing else surfaces it.

The `com.aihr.improve-build` launchd agent IS loaded but is **notify-only** (`watch-approved.sh`) — nothing
auto-builds.

**2. THE ENTITY-TRANSFER HAZARD IS OVERTAKEN — THE RUN IT PROTECTED NO LONGER HAS PAYSLIPS.** The r194 entry
below still describes the DEFECT correctly (proration right, counterpart payslip in the other company's batch
never created, no single-batch operation can create it). What changed: **batch `3b62dc57` (ISEDECOR BINA
2026-08) was RESET to draft on 2026-08-14 14:12** — `status = draft`, `employee_count = 0`, `totals = null` —
and employee 100814 now holds exactly ONE payslip in total, for 2026-07 (v5, gross 1,596.77, 9 days). So
"do not re-run August for 100814" is moot; there is nothing left to preserve. The reporter refuted
`3c88d593` over this on 08-14 09:32 and its stage-two successor `1b0943d5` is approved and waiting.

**`1b0943d5` IS NOW PLANNED (rev 1, with mockup) AND IS READY TO BUILD ONCE APPROVED.** The plan
DELIBERATELY REORDERS the item as it was raised: attendance/leave/reporting were the headline and are now
LAST; cross-batch segment creation comes first, because that is what stops someone being underpaid. Two
blockers it names, both verified in code, and neither is a sums problem:
  - **Batch membership is by CURRENT company** — `eq(employment.companyId, batch.companyId)` at six sites in
    `core/payroll.ts` (1388, 2434, 3186, 5873, 6143, plus the scope path). Fiamma's run cannot see an
    employment whose company is now ISEDECOR. The fix is the MEMBERSHIP PREDICATE, reusing
    `core/employment-company.ts`, not a second resolver. ⚠️ Treat each of the six as its own decision and
    record why — some legitimately want today's employer (the leavers sweep keyed on `terminatedOn`). A
    blanket replace silently rescopes payroll for the whole tenant.
  - **A payslip cannot state its coverage** — the table has `days_worked` and NO period columns, so neither
    half can say "1–10 Aug". Needs one migration (next free is `0441`; do NOT pre-allocate — issue centrally
    and append to the journal, rules 14 and 22). This is the reporter's own requirement: their original
    layout asks for `Payroll Period: 01 Aug – 10 Aug 2026`.
  - **The completeness check is a DELIVERABLE, not an extra**: segments must tile the month with no gap or
    overlap and sum to the un-segmented figure, and the run must REFUSE rather than commit a partial set.
    Today's shortfall was caught only because the batch total happened to fall by exactly the missing
    amount. That is luck, not a control.

**3. THE CODE IS ON GITHUB NOW** — `github.com/zenlam/ai-hr`, PRIVATE, `main` only (the `build/*` branches
are not pushed). Push new branches explicitly if the owner needs to see them from a phone.

**4. PLANNED, AWAITING THE REPORTER (2) — both pushed 2026-08-17 with mockups drawn on production data.**
`9066bd6c` (Payroll Process: Back navigation + **Remove Employee Payroll**) and `4ea70bb7` (rename to
Personnel Management + service duration to the day). Nothing is open/unplanned. Two findings from planning
them that outlive the plans:
  - **RESET IS BEING USED AS A PER-EMPLOYEE CORRECTION TOOL, BECAUSE IT IS THE ONLY ONE.**
    `payroll_status_history` holds 10 `rollback` rows; four on 2026-08-14 between 14:11 and 14:29 cleared
    23 + 23 + 22 + 19 employee results with the reasons "test", "test", "test", "ok", and 12 `reprocess`
    rows follow on ISEDECOR 2026-01 in the next 50 minutes. `payroll_reprocess_job` = **87 completed jobs
    across 10 batches**. Selective reprocess is heavily used and is not what is broken; there is no removal.
  - ⚠️ **SIX EMPLOYMENTS CARRY MORE THAN ONE NON-SUPERSEDED `assignment` ROW.** On batch `368c67fc`,
    `T100502` has THREE and `IDB-240009` / `T100507` have two each, so a naive
    `left join assignment … and superseded_at is null` turns 19 payslips into 23 rows. Any new screen that
    joins for Department/BU must pick ONE row (latest effective) and pin the row count in a test. This is
    also worth raising as its own item — nothing surfaces it today.
  - Service dates, measured: **40 employments, 18 carry `join_date`, exactly ONE has `join_date <> hired_on`**
    (100814: group 2026-07-23, ISEDECOR 2026-08-11). `serviceYearsMonthsDaysAt` (core/leave.ts:5790) already
    does day-precise Y/M/D and is already live as "Year of Service" on the profile summary card.
**Worth telling the reporter unprompted:** `c11e81aa` shipped with two of its seven asks already satisfied
— its Excel import Pay Cycle was ALREADY delivered by r193, and its fixed-amount day-by-day gate is a
**no-op on this tenant** because no pay item is configured `fixed` (23 of 24 carry no rule at all). Both
are correct as built; they simply do nothing visible until a pay item gets a rule.

**5. TWO STANDING DECISIONS NOBODY HAS REVISITED**: `ALLOW_DEMO_SESSION=true` is live on the box a real
customer's payroll runs on, and `fixed_allowance` can no longer be CREATED from any screen after r189.

**6. A CREDENTIAL WAS EXPOSED IN A SESSION TRANSCRIPT ON 2026-08-14** — the production
`MIGRATION_DATABASE_URL` password, printed by a bad `sed` while building a scratch-restore URL. It is
UNCHANGED and still valid. Rotate it when convenient, and never reconstruct that URL by substring
replacement: `s|/ai_hr|…|` matches the ROLE NAME `ai_hr_owner` first.


⚠️ **`ALLOW_DEMO_SESSION=true` IS SET ON PRODUCTION.** The dev identity switcher is active on the box a real
customer's payroll runs on — 40 employees, issued payslips, statutory filings. Deliberate for a gated
consultant demo, per the startup warning, but it is a standing decision nobody has revisited. Not ours to
flip; raise it rather than leave it as a warning line nobody reads.

⚠️ **A GATE POISONED BY A CONCURRENT DEV SERVER LOOKS EXACTLY LIKE A BROKEN ROUND, AND IT HAPPENED AGAIN
ON 2026-08-12.** r186's first gate came back 4 of 6 chunks red. Three of those chunks had **zero**
`AssertionError`s and 9–10 tests each timing out at ~187s; the fourth had exactly one assertion failure
that was a real defect. The cause was planning agents running `pnpm dev` + `db:seed` while the gate ran —
rule 12, broken by the parent's own briefing, not by an agent. **The diagnostic that separated them in one
command was the per-chunk cause tally**, not reading test names:

    for f in /tmp/aihr-gate/chunk*.log; do
      printf "%s: AssertionError=%s timeouts=%s\n" "$(basename $f)" \
        "$(grep -c AssertionError $f)" "$(grep -c 'timed out' $f)"; done

⚠️ **A BACKGROUND `Bash` TASK'S EXIT CODE IS ITS LAST COMMAND'S.** `gate-chunked.sh > log; echo "GATE_EXIT=$?"; date`
reports **`date`'s** exit status to the task notification — so the harness said "completed (exit code 0)"
over a RED gate. Same class as the pipe trap in "Running and reading test gates". Read `GATE_EXIT` out of
the output file, never the notification.
### r177 · r179 · r180 · r184 — ALL SHIPPED. Full entries in `docs/HANDOFF-HISTORY.md`.

⚠️ **THE PANEL ROUND TRIP IS NOW COMPLETE, AND IT IS THE MOST EXPENSIVE LESSON ON THIS BOARD.**
r179 REMOVED the left-hand employee panel from Transaction View and Individual Payslip in favour of a top
search field. The approved plan EXPLICITLY warned that the reporter had previously asked for that panel to
EXIST on the neighbouring payroll screens, said both could not be true, and offered "reject this and say
so". They approved it, saw it live, contested both — and **r185 put the panel back on both screens.**

**The lesson is not that the warning failed — it is that a warning in prose does not substitute for seeing
it.** A mockup showed the new layout; nothing showed them what they were LOSING. Draw BOTH states whenever
a plan trades one thing away for another.

**AND IT MAY BE ABOUT TO HAPPEN A THIRD TIME.** Open item `1372d169` "Payroll Transaction View – Full-Width
Layout Enhancement" is asking for the width back. Full width and the left panel are the SAME trade-off they
have now reversed once in each direction. Whoever plans it must show both states and say plainly that this
is the choice — **do not silently re-remove the panel they just asked to have back.**

### ✅ THE ROSTER DELETE ASYMMETRY — CLOSED IN r191 BY `0436` (kept for the measurement, and the lesson)

`roster_assignment_rls` is a `FOR ALL` policy, so `WITH CHECK` (`can_admin_employment`) governs INSERT and
the new row of UPDATE, while **DELETE is governed by `USING` alone (`can_see_employment`)** — which a
supervisor, and the employee themselves, both pass. Only the application guard `assertRosterAdmin` stops
`clearRoster`.

**THIS IS NO LONGER INFERRED — r186's `42afb2d2` MEASURED ALL THREE VERBS** (this entry used to say the
DELETE half rested on policy text plus documented PostgreSQL semantics). Run as the real unprivileged role
(`rolsuper=f`, `rolbypassrls=f`) inside a **rolled-back** transaction, with a manager holding an active
administrative `reporting_line` to the subject:

| verb | supervisor → direct report | employee → self |
|---|---|---|
| INSERT, future-dated | **42501 refused** | 42501 refused |
| UPDATE, future-dated, constraint-valid | **42501 refused** | — |
| DELETE, future-dated **and** past-dated | **`DELETE 1` ALLOWED** | **`DELETE 1` ALLOWED** |

Negative control: the same employee against a row they cannot see returns **`DELETE 0`** — silently
filtered, no error — which is exactly what `USING` does and proves the ALLOWED result is not a harness
artefact. Re-measured through the real functions: `assignShift` throws, `setRestDay` throws,
**`clearRoster` does not throw at all**. So of the three brushes, **`clear` is the only one whose refusal
is produced by the guard rather than doubled by the database.**

✅ **CLOSED IN r191 BY MIGRATION `0436` — THE TABLE ABOVE IS THE "BEFORE" STATE, KEPT AS THE MEASUREMENT
THAT JUSTIFIED THE FIX.** `roster_assignment_delete_admin` is live on production, verified after deploy
by reading `pg_policy` rather than trusting `deploy.sh`:

    roster_assignment_delete_admin | d | f      ← polcmd=DELETE, polpermissive=f (RESTRICTIVE)
    roster_assignment_rls          | * | t      ← the original FOR ALL, untouched

**RESTRICTIVE was the whole point**: it is AND-ed with the permissive policy, so it adds a requirement to
DELETE and changes nothing else. Narrowing the `FOR ALL` policy's `USING` to `can_admin_employment`
instead would have stopped supervisors and employees SEEING the roster — a visible behaviour change
nobody asked for. Same shape as `compensation_delete_admin` (0277), `leave_year_config_delete_admin`
(0282) and `toil_accrual_delete_admin_only` (0314), all of which likewise shipped before any delete path
existed. There was never live exposure: `clearRoster` is the only DELETE against this table and every
caller already asserted admin. The fix is forward-looking — a future screen, import or bulk tool that
removes shifts now inherits protection for remove the way it already did for add and change.
### ⚠️ THE THREE STATUTORY-FORM ITEMS — READ THIS BEFORE BUILDING ANY OF THEM (planned 2026-08-13)

`88076362` CP22 · `9c8dad7a` EPF Borang A · `8ca344bf` SOCSO Borang 8A, all `planned` rev 1 with mockups.
Recommended order **CP22 → Borang 8A → Borang A**, three rounds not one. Four findings that change the work:

1. **THE EPF AND SOCSO ATTACHMENTS ARE NOT AGENCY ARTWORK.** Both are `Developer Express Inc. DXperience
   v23.2.5` outputs dated 2026-08-12 — **completed forms from another payroll system**, with the
   auto-filled values highlighted. The highlighting IS the field map and was used as one. But it means
   neither form can ever carry `fidelity: 'official'`: PERKESO and KWSP publish no blank page for these.
   Both plans propose ONE new shared fidelity value — the agency's own layout, drawn by us — so the union
   gains exactly one member for the pair, and `my.cp22` stays the only `official` entry (that assertion
   stands).
2. **CP22 [Pin.1/2021] CARRIES LHDN'S OWN "UNTUK RUJUKAN SAHAJA" WATERMARK**, vector-drawn across both
   pages, rendered by both `pdftoppm` and `mutool`. It is deliberate: since 2024-09-01 CP22 is filed
   through e-CP22 on MyTax and paper is not accepted. **Ship what LHDN publishes, stamp included** — do
   not erase a government stamp to make the output look cleaner.
3. **THE 2021 ARTWORK INVALIDATES ALL 33 MAPPED AREAS — it does not shift them.** It is TWO pages (A/B/C
   then D/E/F) against 2020's one; it has **no character cells anywhere**, so the `comb` type, `maxLen`,
   the 14-position tax-number gap and the two-part telephone split all become dead code; B12/B13 become
   3 free rows plus separate Poskod/Bandar/Negeri boxes, so reusing `addressLines()` would put the state
   in a free row and leave three printed boxes empty — **the r175a silent-loss class, relocated**. Box 1
   and Box 27 lose their targets; A4, B15, B17, C4 and all of section F are new. **~50 areas, up from 33.**
   There is also no "Kepada / To" block, so the ticket's "Submit To" cannot print.
4. **NO MIGRATION IS NEEDED FOR ANY OF THE THREE. `0436` IS NOT CONSUMED.** Every field the tickets ask
   for already exists under a different name: `epf_reference_no` → `company_statutory_my.epf_employer_no`;
   `socso_employer_code` → exact match; `mycoid_no` → `ssm_registration_no`, which
   `localization/my/socso-eis-file.ts` ALREADY reads as the ASSIST file's MyCoID; `epf_member_no` →
   `employee_statutory_my.epf_number` (9 of 33 populated); SOCSO's IC → `ic_number` (33 of 33).
   `company_statutory_authority` exists with a UI and has **ZERO rows on production** — it needs filling,
   not building.

**THE +1-MONTH TRAP THE REPORTER PRE-EMPTED.** Their two specimens are the SAME July 2026 payroll: EPF
stamped `Bulan Caruman 0826`, SOCSO stamped `CARUMAN GAJI BULAN 07 / 2026`. Borang A is cycle **+1**;
Borang 8A is the cycle month **directly**. Both plans pin it, including `2026-12 → 2027-01` and
`2026-12 → 2026-12`, plus a joint test that runs one cycle through both and **fails if they ever agree**.

⚠️ **DO NOT TREAT THE SPECIMENS AS ARITHMETIC FIXTURES.** The SOCSO specimen's RM202.35 does not reconcile
to the EPF specimen's RM6,200 wage on either a SOCSO-only or SOCSO+EIS reading under the current PERKESO
table. Take the figure from the run and show the run's own total beside the form total on the preview.

⚠️ **`payslip.statutory.bases` IS ONLY ON 60 OF 121 PAYSLIPS** (stamped from r187 onward), and
`loadBatchRows` drops it today because it only sums numeric keys. Pre-r187 rows must be FLAGGED, never
silently fall back to gross.

### r194 (2026-08-14) — THE APPROVED QUEUE EMPTIED: FIVE ITEMS, MIGRATION `0440`

`main@dec4bb73`. Four workstreams cut from main. Gate **682 declared / 682 counted / every chunk exit=0 /
9,133 tests / 0 AssertionErrors**; tsc 0; `next build` 0; `gate:shadow` PASS 358→359. Shipped:
`c11e81aa` (Individual Transaction) · `3c88d593` STAGE ONE (entity transfer, `0440`) · `5ff7daff`
(Replacement Leave approval surface) · `9c8dad7a` + `3aae0789` (EPF Borang A printed form + i-Akaun text
file, built together for shared groundwork).

**TWO DEFECTS THIS ROUND INTRODUCED, BOTH CAUGHT ONLY BY THE FULL GATE:**
1. `localization/my/borang-a.ts` stamped its printed date from `new Date().toISOString().slice(0,10)`.
   MYT is UTC+8, so between 00:00 and 08:00 that yields YESTERDAY — a statutory form carrying the wrong
   Tarikh DiCetak for a third of every day. `test/today-in-myt-drift.test.ts` exists for exactly this.
   Fixed with `todayInKualaLumpur()` (`lib/hr-date.ts`), which `localization/my/statutory-config.ts`
   already imports.
2. `app/leave/actions.ts` declared a SECOND `const t` for the `approvals` namespace while `t` was already
   bound to `replacementRequest`. `test/leave-i18n-key-resolution.test.ts` maps VARIABLE NAME → namespace,
   so the rebind made an existing, correct `t('submittedToast')` resolve as the missing
   `approvals.submittedToast`. **THE KEY WAS NEVER MISSING** — adding it would have silenced a working
   guard with an entry no call site reads. Renamed to `tApprovals`. Watch for this shape: one file binding
   two namespaces to the same identifier.

**TWO PLANS OF OURS WERE STALE AND THE BUILDER SAID SO — both worth reading as a caution on plan shelf-life:**
- `c11e81aa` item 8 (Excel import Pay Cycle) **was already built by r193's `0db616f3`**: `payroll_cycle` is
  in the import schema, the hardcoded `runType === 'regular'` is gone, five cases pin it. The plan's build
  note was written against pre-r193 main. Nothing in the import was changed.
- `c11e81aa` item 5 (grey out Day-by-Day for fixed-amount items) is a **no-op on this tenant**: of 24 active
  allowance/deduction pay items, 23 have NO rule and one has a formula; **none is configured `fixed`**. The
  gate was built correctly and engages the moment an item gets a rule, but it greys out nothing today. The
  builder deliberately did NOT widen it to null-rule items — null-rule is precisely the case the day grid
  exists for (`ABSENT`, `UNPAID LEAVE`), and widening would have reversed r191's feature.

✅ **BOTH HAND-RUN SCRIPTS HAVE NOW BEEN RUN** (2026-08-14, against a fresh backup
`/home/ubuntu/backups/aihr-pre-r194-scripts-20260814-015648.dump`):
  `scripts/backfill-assignment-company.ts --apply` → **1 split, 54 stamps**; 55 of 59 assignment rows now
  carry a company. The 4 without are all `superseded` and the resolver filters those
  (`isNull(assignment.supersededAt)`, core/employment-company.ts:83), so they are not a gap.
  `scripts/archive-duplicate-replacement-leave-type.ts --apply --tenant=…` → archived `REPLACEMENT`, kept
  `RL`. **It REFUSES `--apply` without `--tenant`** — it will not guess which customer to write to.

### ⚠️⚠️ ENTITY TRANSFER: STAGE ONE IS INCOMPLETE IN A WAY THAT UNDERPAYS. READ BEFORE RE-RUNNING ANY MONTH.

**Proven on production 2026-08-14, and it produced a real underpayment that had to be reversed.** Employee
100814 (employment `aa899123`) transferred Fiamma → ISEDECOR BINA effective 2026-08-11. Reprocessing their
August through `reprocessSelectedEmployees` gave:

    BEFORE  1 payslip · gross 6,600.00 · net 5,832.35 · 31 days · v2
    AFTER   1 payslip · gross 4,470.97 · net 3,946.82 · 21 days · v3      ← 6600 ÷ 31 × 21, the ISEDECOR part
    MISSING the Fiamma 1–10 Aug counterpart, 6600 ÷ 31 × 10 = 2,129.03

The proration is CORRECT. What does not happen is the second payslip, **and it structurally cannot**:
**every company has its OWN batch for a period** — 2026-08 has EIGHT batches, one per company (Fiamma
`30ba5f09` 1 employee; ISEDECOR `3b62dc57` 23) — and `reprocessSelectedEmployees` recomputes strictly
within the ONE batch it is given. A mid-month transfer therefore spans two batches by construction, and no
single-batch operation can complete it. The batch total fell by exactly 2,129.03, which is how it was
caught.

**RESTORED** to the pre-reprocess figures (payslip v4, batch totals back to gross 98,952.09 / net
86,792.14, verified equal to the sum of its 23 payslips). Both directions are in
`payroll_employee_result_history` with reasons. **The assignment company history was LEFT INTACT** — it is
correct: three periods, Fiamma to 2026-08-10, Fiamma 08-10→08-11, ISEDECOR from 08-11.

**DO NOT RE-RUN AUGUST FOR 100814** until cross-batch segment creation exists. That is the first thing
stage two (`1b0943d5`) must answer — ahead of attendance and leave, which is not how that item is currently
written.

**TWO RESTORE LESSONS, both cost time here:**
  1. `payroll_employee_result_history.before` carries only SIX keys — `grossPay`, `netPay`,
     `totalDeductions`, `employerCost`, `version`, `statutory`. It does NOT carry `basic_salary`,
     `allowance`, `overtime_pay`, `other_deductions`, `bonus` or `days_worked`, so it is NOT sufficient to
     rebuild a payslip on its own. The backup was needed for the rest.
  2. **You cannot restore a scratch database on the server**: `ai_hr_owner` is `rolcreatedb=f`,
     `rolsuper=f`, so `CREATE DATABASE` is refused. Read rows straight out of the dump instead —
     `pg_restore -t <table> -a -f - <dump>` emits the COPY block and its column header, and you can grep the
     row you want. No database required.

**`3c88d593` IS MARKED DEPLOYED FOR STAGE ONE ONLY**, with `build_ref` saying so. Stage two is `1b0943d5`,
now PLANNED with a mockup drawn on 100814's real figures — see START HERE §2 for the two blockers it names
and why the item's original ordering was reversed. The mockup deliberately states WHY two payslips are
impossible today rather than just drawing them: stage one's mockup promised two payslips the build could
not deliver, and repeating that would be the panel round-trip lesson all over again.

### r193 (2026-08-13) — TEN ITEMS, THREE MIGRATIONS, AND THE JANUARY BONUS REPAIR RUN BY HAND

`main@970a1f22`. Nine parallel workstreams cut from main. Gate **677 declared / 677 counted / every
chunk exit=0 / 8,974 tests / 0 AssertionErrors**; tsc 0; `next build` 0; `gate:shadow` PASS 355→358.
Shipped: `2333b7fb`+`0253dc7c` (statutory wage base — one root cause, two screens) · `a9d0a94a`
(entitlement generation) · `0db616f3` (January double import, `0437`) · `46afcc48` (shared leave group
display, `0438`) · `7c834696` (OT rounding, `0439`) · `e7eb5d83` (claim config width) · `6b018920`
(back pay / statutory adjustment) · `3c2f55d7` (organization) · `8ca344bf` (SOCSO Borang 8A).

**THE MIGRATION JOURNAL COST TWO ATTEMPTS AND BOTH FAILURES WERE THE INTEGRATOR'S** — now AGENTS rule 22.
Three branches each appended an entry, so `_journal.json` conflicted. First attempt: the resolver
asserted and aborted BEFORE writing, but `git add && git commit` was chained off the `git add`, so the
file went in WITH CONFLICT MARKERS as invalid JSON. Second attempt: sorting every entry by `when`
relocated idx 240 ahead of 225 — because 240 shares its `when` with 220 and sits below 230's — breaking
`test/migration-journal-ordering.test.ts`'s strictly-ascending-idx case. **The full gate caught it: one
AssertionError, everything else green.** The journal has TWO invariants that pull against each other on
that one grandfathered pair; APPENDING satisfies both because main already does. Final diff vs main is
purely additive, 21 insertions / 0 deletions. And resolve multi-branch journal conflicts as the UNION —
taking either side DROPS a migration, leaving a `.sql` with no journal entry that never runs.

**THE JANUARY REPAIR IS DONE — DO NOT RE-RUN IT.** `scripts/repair-january-bonus-double-import.ts
--apply`, run by hand after the deploy (rule 13), against a fresh backup
`/home/ubuntu/backups/aihr-pre-0db616f3-20260813-224333.dump` (108MB, pg_dump exit 0, 166 TABLE DATA
entries, taken with `--exclude-table-data` for the three FORCE-RLS tables — all confirmed 0 rows).
Result, verified independently of the script's own summary: **13 rows / RM62,524.51 now on the bonus run
`fc9e5309`, 0 left on the regular run, 0 surplus duplicates**; the 17 hand-keyed rows (RM7,997.75) on
`368c67fc` untouched; payslips 121 / batches 23 / ledger 171 unchanged; January payslip totals unchanged
(regular 19 @ net 96,045.78, bonus 19 @ 0.00). **No payslip was touched — re-issuing the January bonus
run remains a separate, deliberate act by the owner.** A0014's RM17,325.00 exists ONLY in the second
import and A0001's RM1,650.71 ONLY in the first, so "delete the later import" would have stranded a real
person's bonus; the keep-set is the distinct union, earliest of each pair.

⚠️ **`node --env-file=` DOES NOT RUN ON THE SERVER** — node v18.19.1, flag arrived in node 20, exits 9.
**23 scripts document that invocation** and none works as written on production. Source the env instead.
Now AGENTS rule 21.

### r192 (2026-08-13) — THE THREE COMMITS r191 LEFT BEHIND, AND A CORRECTION TO ITS OWN WRITE-UP

Not a board round: no item changed state. r191 was declared complete while **three commits sat unmerged on
two of its branches** — a resumed workflow kept committing at 13:37–13:44, half an hour after the
integration merged those branches at 13:04. Found only because a routine `git for-each-ref refs/heads/build`
sweep showed `build/r191-cp22` two ahead and `build/r191-midmonth` one ahead of main. **That is now
AGENTS.md rule 19.**

What shipped here:

- **`723904b1` — a REAL defect on the CP22 review screen.** The preview computed its listed box values from
  the CORRECTED record but its "this box will not hold its whole value" warning from the BARE one, so a
  correction that overflows was shown in full and announced nowhere — reachable through the very boxes the
  reporter asked to have made editable. Cause was two sources of truth: `page.tsx` had INLINED
  `applyCp22Review`'s body instead of calling it. Fixed to one call feeding both, pinned from both ends
  (trap 17's shape).
- **`7f2bc027`** — pins the December→January rollover in `nextFirstOfMonth`; a naive +1 on the month would
  suggest `2026-13-01` and every other month in the file passes over it in silence.
- **`b5269a56`** — already live by content: r191's hand-fix set the identical string in all six catalogues.

**AND IT CORRECTS r191'S OWN DIAGNOSIS.** r191 wrote up its stale-translation catch as a hunk-granularity
merge fault and made a standing order out of it. Re-checked here by reading `messages/en.json` at each of
the eight merge commits: **the value was main's at every one, including cp22's own merge — nothing reverted
anything.** The audit had compared the merged tree against a branch HEAD that had moved since. The catch was
real and the fix was right; the explanation was wrong, and a wrong standing order is worse than none.
Rule 19 is now the staleness rule; 19b keeps the base-aware audit with the correction attached.

### r190+r191 (2026-08-13) — ELEVEN ITEMS AS ONE RELEASE, `main@de887a85`, migration `0436`

Built by a 7-workstream Workflow plus r190 carried over. Gate **666 declared / 666 counted / every chunk
exit=0 / 8,706 tests / 0 AssertionErrors**; tsc 0; `next build` 0; `gate:shadow` PASS 355/355. Shipped:
`2f889bae` (rev 2 — Pay Items View/Edit link) · `009c8a37`+`e1e33ca0` (employee panel + Individual
Transaction) · `3ddae357`+`38b94df7` (balances As-at date, searchable picker) · `3214cb11`+`813fd22a`
(entitlement table ordering — ONE fix, both surfaces) · `47609f53` (dashboard link gating) · `154865f4`
(`0436`, roster DELETE) · `a3d485f6` (mid-month restatement refusal) · `88076362` (CP22 review screen).

**THE ROUND'S REAL LESSON IS THAT BOTH DEFECTS IT PRODUCED WERE INVISIBLE TO EVERY BRANCH THAT CAUSED
THEM.** Seven worktrees, each green on its own targeted tests; the integration found two faults that only
existed once the branches met:

1. **A STALE TRANSLATION THAT `i18n-check` CANNOT SEE — and the round's own explanation of it was WRONG,
   corrected in r192.** The shipped `payroll.cp22.monthHint` was main's old value, describing a "branch you
   type" field the same round had DELETED. `scripts/i18n-check.mjs` passed throughout: the key was present
   in every locale, parity held, no placeholder changed; only the TEXT was stale. **Only a base-aware audit
   (base vs merged vs every side) reads a value as stale rather than merely present** — that part stands,
   and it is why the defect was caught at all.

   **The CAUSE written up at the time — "the balances merge reverted it at hunk granularity" — did not
   happen.** Re-checked in r192 by reading `messages/en.json` at each of the eight merge commits: the value
   was main's at *every* one, including `build/r191-cp22`'s own merge. Nothing reverted anything. The real
   cause is rule 19: the integration merged at 13:04 while a resumed workflow was still running, and the
   cp22 branch rewrote that hint at 13:37 — so the audit compared the merged tree against a branch HEAD that
   had MOVED SINCE. The hand-fix applied then is byte-identical to what the branch later committed, so the
   shipped text was right; only the reasoning was wrong. **Three commits missed r191 entirely because of
   this, one of them a real defect fix — shipped in r192.**
2. **A NEW GUARDED PAGE WITH NO MATRIX COLUMN.** cp22 added `/payroll/cp22/[employmentId]/preview` and
   never registered it, so `test/function-access.test.ts`'s reverse-completeness case failed — a guarded
   route nobody can grant or revoke. Registered on the same `scopedAdmin` key as
   `/payroll/statutory-forms/[formId]`, the screen that links to it. Its four siblings under
   `/payroll/cp22` are route handlers, not pages, which is why exactly one route was missing. **18 test
   files read that registry, spread across chunks — a targeted re-run could not have been trusted, so the
   full gate was re-run.**

**Also settled in this round, both worth not re-deriving:** `9a65f808` does NOT block `31e39d74` (see
START HERE §4), and ai-hr is loopback-only with no nginx route (see CURRENT STATE). Two board items were
raised from what the work turned up: `0db616f3` (the January double-import, START HERE §3) and, earlier,
`47609f53`/`154865f4`/`a3d485f6` which shipped here.

### r187 · r188 · r189 — ALL SHIPPED. Full entries in `docs/HANDOFF-HISTORY.md`.

r189 claims grade-first limits (`0435`) + the pay-item formula builder · r188 the "Apply to Early
Overtime" untick defect (no migration) · r187 eight items (`0430`/`0432`/`0433`/`0434`), the round
whose merge order silently skipped two migrations — that lesson lives in AGENTS.md rule 14.

### r180 IS ARCHIVED (history) — but ONE thing it found is still live and unfixed

r180 found recurring pay items paying TWICE on issued payslips, and fixed the writer. r185's `2aed39d4`
then added the `employment_pay_component_no_overlap` EXCLUDE constraint and repaired the 9 bad rows, so
the *overlap* half is closed. **What is NOT closed:**

⚠️ **A MID-MONTH RESTATEMENT STILL PAYS BOTH LINES IN FULL.** End one line on 15/07 and start the next on
16/07: the two windows are adjacent and legal under the constraint, but BOTH overlap the month and the
kernel pays each returned row its FULL amount. The first regression test written returned **1554 = 777 +
777**. It is recorded as `it.fails` in `test/fixed-transaction.test.ts` — the same idiom this repo uses for
the known width no-op — **so the gate turns RED when someone fixes it.** Leave it failing and leave it
labelled.

**Fixing it is a DESIGN DECISION, not a patch:** prorate a partial window, take latest-row-wins per period,
or refuse a mid-period restatement. Each changes what CORRECTLY-dated rows pay today, so it belongs to the
reporter. `2aed39d4`'s approved plan names it in GOOD TO KNOW as a request of its own — it has not been
raised yet.

### r176, r175, r174, r173 and r172 are SHIPPED — full entries in `docs/HANDOFF-HISTORY.md`

One thing outlives those rounds and is deliberately NOT archived with them:

**NOT BUILT ON PURPOSE — Pay Items has no per-row Edit, and adding one naively DOUBLES PAY.**
`setEmploymentPayComponent` closes the open row at the new `effectiveFrom` and inserts a fresh one, while
the kernel selects every row overlapping the period — so re-stating an item inside its own running month
leaves BOTH rows in the window. The table already renders every column, so a View would be furniture.
**Safe editing needs a dating change, not a presentation change.**

### ⚠️ A SCRIPT THAT IS CORRECT AND MUST NOT BE RUN

- **`scripts/seed-overtime-multipliers.ts` IS DEPLOYED, CORRECT, AND MUST NOT BE RUN** (`2da9937a`, seed
  step withdrawn). A pay component was always the wrong mechanism: overtime is ALREADY wage-derived per
  employee (`localization/my/payroll.ts overtimePay`, multipliers and ceiling configurable per ADR-0019),
  and one flat rate for everyone cannot express that.

- ⚠️ **THE `OT1_5` DIAGNOSIS THAT USED TO SIT HERE IS NOW WRONG — THE REPORTER FIXED IT THEMSELVES
  (measured twice on production, r178).** This file used to state that `OT1_5` holds
  `{"kind":"per_hour","rate":1.5}` and is "the tenant's only `per_hour` item". **Production now has ZERO
  `per_hour` components.** On 2026-08-10 09:58:36 the reporter changed `OT1_5` to a **`formula`** rule —
  `(basic + fixed_allowances) / 26 / 8 * 1.5 * hours` — i.e. they took `b00f9e6e`'s "reject and we build
  it" option by building it. At 10:01:53 they keyed 10 hours, deriving **RM 396.63**, on processed payslip
  `ced390ae`. **DO NOT ARCHIVE `OT1_5`** — the approved revision-1 plan said to, and doing so now removes a
  working item and makes its three `payroll_individual_txn` rows uneditable
  (`core/payroll-individual-txn.ts:239` throws unconditionally).
  **`employment_pay_component` WAS THE WRONG TABLE TO CHECK**: revision 1's load-bearing sentence "nobody
  has ever been paid a cent from it" was already false when written — RM 2.00 was keyed 2026-08-04 and paid
  on processed payslip `c32b0088` on 08-07. **Verification trap:** both amounts are stored in the `bonus`
  column with `overtime_pay` 0.00, and read as overtime only through `statutory->'displayEarnings'`
  (`core/pay-display-category.ts:73-84`). Anyone checking `payslip.overtime_pay` will wrongly conclude the
  reporter's overtime never landed. Revision 2 is pushed and awaiting them.

### 6e9a126e RELEASE THREE — the one fact still live (full entry: history → r167)

**THE CUSTOMER STILL HAS ZERO ENTITLEMENT CONFIGURED.** Every figure reads blank until ~400 items are
retyped from the archive into Entitlement Templates + Employee Eligibility. The no-opinion guard is what
keeps balances still while that is true — if a recalc ever starts posting non-zero deltas against an
unconfigured type, that guard has broken and it is the first thing to check.

### The board

**Counts live in CURRENT STATE and are not repeated here. Always RE-COUNT** — the line said
`approved = 0` on 2026-08-08 and eight items were approved the next morning.

**COUNTS LIVE IN CURRENT STATE ONLY — re-count on the box before acting on any of them** (this line has
been wrong four times). As of 2026-08-17: `deployed = 674` · `approved = 19` · `planned = 2` ·
`cancelled = 14`.

**THE CONSTRAINT IS BUILDS.** It has flipped five times in a week. **Check which side is short before
choosing what to do next** — `improve:pull` for unplanned work, `improve:pull-approved` for unbuilt work.
⚠️ **`pull-approved` RETURNS ITEMS THAT ALREADY CARRY A `build_ref`, AND THAT IS NOT A BUG.** A post-deploy
refute (`feedback.deployment.refuted`) → re-plan → approve leaves the OLD `build_ref` on the row beside a
NEW plan revision. Six of the 19 approved on 2026-08-17 are exactly that shape, so **never decide "already
shipped" from `build_ref`** — read the item's `domain_event` stream and compare the approved revision with
the one that was built.

**c8052ae3 IS DONE — the leave reset RAN on 2026-08-12.** It was the longest-open item on the board.
147 `leave_ledger` rows and 22 `leave_entitlement_recalc_audit` rows archived under capture tag
**`c8052ae3-2026-08-12`** and then deleted; `leave_ledger` went 318 → 171, leave requests (41) and
payslips (121) untouched, no entitlement generation run. Medical and Hospitalization now read 0.00 for
everyone because no rows exist, not because something granted zero. The record is at
`/admin/leave/entitlements/ledger-archive`, reached from the Entitlements screen and deliberately not in
the sidebar.

⚠️ **TWO STEPS OF THAT PLAN WERE WRONG, AND ONLY RUNNING IT FOUND THEM. Fix them before reusing it.**
1. **Step 0's `pg_dump "$U" -Fc -f …` EXITS 1 on this database** and leaves an ~889 KB partial that looks
   like a backup and is not. `ai_provider_config`, `leave_adjustment_batch` and `platform_user` are FORCE
   RLS; `ai_hr_owner` has neither superuser nor BYPASSRLS and there is no passwordless sudo to `postgres`.
   The working form adds `--exclude-table-data=` for those three — and all three hold **0 rows**, so the
   dump is complete anyway. **Verify a dump with `pg_restore -l`, never with its exit code alone.**
2. **Step 4's check `leave_entitlement_recalc_audit 0` IS WRONG** and reports failure on a correct run.
   It must read **0 FOR THE TWO RESET TYPES**. After the real run the table holds 50 rows, every one of
   them ANNUAL — which the script correctly did not touch. A check that fails on success is how a good
   result gets rolled back.

**THE CONSTRAINT FLIPPED TWICE IN ONE DAY** — theirs, then ours (13 items planned in an afternoon), then
theirs again. **Check which side is short before choosing what to do next:** `improve:pull` for unplanned
work, `improve:pull-approved` for unbuilt work.

⚠️ **`2f889bae` IS NO LONGER APPROVED — it was RE-PLANNED at revision 2 on 2026-08-12 and now awaits the
reporter.** Do not build it from an older reading. Of its seven revision-1 steps, **five were already
delivered** (step 1 by r180's `34cc8137`; steps 2–5 by r185's `2aed39d4`), **step 7 asks for the OPPOSITE
of what is live** (it wants Remove refused for any COMPLETED run; r185 shipped Remove allowed while
`processed` and refused only once `closed`, on the reporter's newer instruction), and the only work left is
a View/Edit link on the Personnel Payroll tab, which is read-only today while the real buttons sit one
screen away at `app/payroll/transactions/fixed/[id]`.

**TWO ITEMS RAISED BY US ON 2026-08-12**, both from findings that belonged to no approved plan:
`47609f53` (supervisors are shown dashboard links to screens that refuse them — the `2ec1e3d2` plan
claimed it had checked for siblings and found none, which was wrong) and `154865f4` (the roster DELETE
asymmetry above). Both `open` with `reporter_label = 'CLAUDE AI'`.

⚠️ **A RAISED ITEM NEEDS A PLAN, NOT AN ANSWER — this file said the opposite and it cost a day.** An item
created by `improve:raise` lands `open` with `plan_revision = 0`, and **an item with no plan has no approve
or reject button**, so its recommendation sits in the description where the reporter can do nothing with it.
The old line here said `42afb2d2` "needs an ANSWER from the reporter, not a plan, and `improve:push-plan`
must never be pointed at it". That is backwards and is why it sat. Giving a raised question a PLAN is how
they answer it: approve means leave it, reject-with-reason means do the other thing.

**THE REPORTER COMMUNICATES IN PICTURES — 143 of 151 attachments are images.** Read an item's attachment
BEFORE forming any opinion; this session burned a plan revision writing from the prose alone and the
screenshot showed a different screen entirely.

### Plans must carry a MOCKUP — shipped r165

**The full procedure and its rules live in `scripts/mockup/README.md`** — read it before drawing one; it
is kept in step with `.claude/skills/feedback-plan`. The three that cost a round each, in brief: attach
AFTER pushing (`plan_revision` is stamped server-side, and `pushPlanWithMockups()` enforces the order);
a mockup is a PROMISE and a picture cannot hedge, so draw only what will be built and keep the uncertain
parts in words; and use the reporter's OWN measured data — r170 drew invented employees, and the
half-fix of real names with invented figures was worse, because it looks authoritative and is wrong.

**NOTHING IS `building` OR `approved`-and-unrecorded.** `improve:pull` hides `building`, so a partially
built item MUST be recorded here — nothing else surfaces it.

### THE DELETE GUARD (r160) — the count was the lesson (full entry: history → r160)

**A list of referrers maintained by hand is wrong the moment anyone adds a table.** `deleteLeaveType`
counted five, its `inUse` predicate counted three, and the database carried TWELVE foreign keys — both
the plans and this file said eleven. So there is no list: `core/leave-type-refs.ts` declares each
referrer with a disposition (`history` refuses, `config` cascades), both the button predicate and the
delete guard are GENERATED from it, and `test/leave-type-referrers.test.ts` fails if the declaration and
the live foreign keys disagree either way. Verified still in place 2026-08-09.

**`inUse` MEANS "this type has HISTORY"**, not "anything points at it" — a type carrying only policies
and approval rules is correctly deletable. `core/read.ts` documents the identical hazard for job grades.

### ⚠️ DECISIONS TAKEN THAT THE REPORTER SHOULD SEE

- **Notice Board ships MARKDOWN, not the requested WYSIWYG** — owner-approved 2026-08-05. Storing raw
  HTML would make every notice a stored-XSS vector aimed at every employee.
- **`3c473773` did NOT change the statutory calculation.** Its build note said `earningsOf` should
  switch on the new category — taken literally that moves EPF, SOCSO, EIS and PCB, contradicting the
  same plan's promise. Shipped as a decoupled DISPLAY overlay; stored payslip columns unchanged.
- **`18103ba4` refused Job Title / Employee Group / Employee Class** — no column, catalogue or import
  field exists. The screen NAMES them as unavailable rather than silently omitting them.
- **Claims stage 1 has no `reserved_amount` column**, deliberately: a stored counter is what gets
  decremented twice and silently frees limit that is still consumed.

### ⚠️ ONE OWNER DECISION OPEN ON ATTENDANCE — free to make NOW, expensive later

1. ✅ **THE OT ROUNDING RULE — DECIDED AND BUILT IN r186 (`7c834696`). ROUNDING IS DOWNWARD.**
   `core/attendance-rule.ts applyOtRuleRows` uses `Math.floor`, so a band's Round-To can never return
   more minutes than were worked nor exceed the band's own upper bound. **Built on `build/r186-attend`;
   see that round's entry for merge/deploy state.**

   History, kept because this entry was wrong twice. It first said "Production has exactly ONE rounding
   band — rule `A01` … it decides ZERO days"; that was overtaken on 2026-08-05 when `A02` (the SAME row,
   renamed) got a 60–119 band with round-to 60 and 8 shifts began selecting it. Rounding to the NEAREST
   60 then sent 90 minutes upward to 120 — past the band's own 119-minute ceiling — so a day inside the
   band paid MORE than was worked, and it created a cliff (1h29 paid one hour, 1h30 paid two, 2h00 paid
   two). Two real days, re-measured on production 2026-08-11:

       Eee Lee Yong             2026-08-05  out 19:30   ot_minutes 120   worked  90   → 60
       NURUL ALIAH BINTI ACHIN  2026-08-05  out 19:40   ot_minutes 120   worked 100   → 60

   Every other overtime day on production matches its raw minutes exactly, and every Standard-governed
   OT figure is an exact multiple of 60, so floor moves nothing else.

   **THE STORED FIGURES DO NOT MOVE ON DEPLOY.** Code decides new derivations only; the two rows above
   keep their 120 until someone runs the SCOPED recompute (Attendance → Recompute Attendance,
   `core/attendance-recompute.ts`) for **2026-08-05 and those two employments only**. Do NOT run a wide
   recompute: shift codes and times were reassigned on 2026-08-05 17:45–17:47 and 41 historical days
   already carry a stored OT that disagrees with today's shift times.

   `test/attendance-stage1-calc.test.ts` and `test/attendance-ot-rounding-money.test.ts` pin the new
   rule against `A02`'s REAL two-row geometry and name the exact minutes that move — update them, never
   loosen them.

   **A02's OTHER SETTINGS, verified, because they read as bugs and are not:** grace is 5 minutes on
   arrival and **0 on departure**, and `include_grace_in_lateness` is TRUE — so a 09:06 arrival counts
   6 minutes late, not 1, because once the grace is spent it stops counting in the employee's favour at
   all. `apply_deductions` is FALSE, so no lateness or early-out deduction has ever been taken from
   anyone's pay, on any day. **Lateness and early-out are RIGHT; only overtime was wrong.**
2. **"Overtime beyond the final band shall not be counted"** would cut `ot_minutes` DOWNWARD and
   retroactively. Not built — those minutes keep the final band's rate. Truncation needs its own opt-in.


### ⚠️ THE PAID-ITEM GUARD IS ONLY ~14% EFFECTIVE TODAY, AND THAT IS BY DESIGN

`f1123afd` refuses to remove a recurring pay item paid on a processed payslip, but it can only fire where
the payslip stored WHICH component produced a line — measured 2026-08-05, **7 of 50 payslips** carry
`statutory.componentLines`. Line stamping began 2026-08-01 (`862ed0ad`) and earlier runs cannot be
itemised retrospectively.

**There is no payslip line table.** Per-item detail lives in `payslip.statutory` jsonb keyed by catalog
CODE, not by `employment_pay_component.id`, so the guard also needs the batch's `pay_period` to fall
inside that row's own validity window to attribute a line to it rather than a sibling.

**With no stored evidence the removal is ALLOWED, deliberately** — refusing on absence of evidence would
block removing almost every pre-August recurring item with no way to prove otherwise. Pinned by a test, so
reversing it means changing a test and saying why. **It is protection going forward, not a repair of
history** — say that plainly rather than implying paid items are protected.

### Durable product facts and unbuilt follow-ups (measured 2026-08-04/05; the items themselves SHIPPED)

Per-item measurements are in `docs/HANDOFF-HISTORY.md` under their rounds. What outlives them:

- **`employment_type` lives on `assignment`, NOT `employment`** — a query against
  `employment.employment_type` errors.
- **`EMERGENCY_LEAVE_CODE = 'EMERGENCY'` is still hardcoded** while production's type is `EL` — the
  constant is documented as "the code the PACK SEEDS" and the resolver has changed, so **re-verify
  against the tree before reusing the old diagnosis**; its old line numbers have moved.
- **"Processed By" on the payroll dashboard is viable** — 43 processed events, 43 with a resolvable
  actor name. A two-join + one-`<td>` change; shipped without it only because an agent could not
  verify from its sandbox.

### Waiting on the owner, not on code

1. **Slice 6's deploy-failing flip** (unclassifiable company: warning → failed deploy) needs explicit
   confirmation before shipping — right end state, deliberate foot-gun.

**FIVE cron jobs now, not four (2026-08-09).** `accrue-earned` (monthly, 1st 02:00), `review-sweep`
(daily 03:00), `expire-carry` (yearly, 1 Apr 03:00), `provision-runner` (every minute), and
**`capture-usage` (daily 01:00)** — ahead of the leave sweeps so it meters the day before they mutate
it. **`expire-aged-leave` is NOT among them** (an older note here claimed five including it; its line
is commented out on the box). **Verify with `crontab -l` as `ubuntu`, NOT `systemctl list-timers`** —
no timers exist.

### Known live defects, deliberately left standing

- **THERE ARE SIX INLINED COPIES OF THE SHIFT SPAN-MINUS-BREAK CALCULATION, and the sixth cannot be
  deduplicated (r174).** The canonical one is `netScheduledMinutes`; `rosterVariance` was the fifth and
  was fixed this round after it disagreed with the engine on a rounded shift. The sixth is
  `components/shift-time-fields.tsx:63-71`, which recomputes span, the unpaid-only break sum and the
  rounding floor by hand. **It is CORRECT today** — already rounding-aware and paid-aware — but nothing
  tests that it tracks the engine, and it is `'use client'` while `core/attendance.ts` imports
  `db/client` and drizzle, so it CANNOT import the shared helper. If the scheduling rule changes again,
  this is the copy that silently drifts. The real fix is extracting `netScheduledMinutes`/`shiftSpan`
  into a dependency-free module both sides can import. Two further copies exist at
  `core/attendance.ts:279` and `app/admin/attendance-policy/page.tsx:251` — those are the
  `attendance_policy` domain, which has no rounding column and no shift, and must NOT take the shift
  rounding parameter.

- **`${inputCls} w-<n>` is a width NO-OP in ~133 files** — `inputCls` contains `w-full`, and the
  stylesheet's emission order wins, not the class attribute. Recorded as `it.fails` in
  `test/tailwind-width-order.browser.test.tsx`, so the gate turns RED when someone fixes it. Not on
  the board yet (awaiting the owner). Fix is `tailwind-merge` (already a dependency) or dropping
  `w-full` from `inputCls`; **both change rendered widths across 133 files — measure before
  planning.**
- **Sepang location carries `country = 'SG'`** on a Malaysian company — a data-entry slip, harmless
  since r110 (state validation narrows by the COMPANY's country). A human should fix the row; **a
  validator silently rewriting customer data would be worse than the error.**

### What I would pick up next (platform work from ADR-0077 — NOT on the board; nothing will surface it except this entry)

- **Finish slice 6**: sweep remaining reports for one-jurisdiction assumptions — grep `packFor(` in
  `core/` and check each against "whose jurisdiction is this row?". r115 fixed the overtime report.
- **Provision slice 7** — create `ai_hr_platform` from `deploy/bootstrap-db.sql`, set
  `PLATFORM_DATABASE_URL`. No code; turns `pnpm platform:usage` from exit-2 into a working report.
- **Slice 9's ONE gap: give `closureDecision` a caller.** Decision function, retention check and schema
  are built and tested; nothing invokes them. Reactivation already has its runner.
- **Slice 10's dashboard**, now that the meter records daily. Wants slice 7 provisioned first.
- **The old line here called 7 and 8 "the big untouched ones" — wrong for both.** This table has now
  gone stale on 7, 8, 9 and 10 in turn: **check the tree before believing any row of it.**

## Settled decisions — do not reopen

- **`fa3f4ccb` statutory minimum removal is SETTLED — do not re-refuse.** The reporter asked twice
  with reasoning; a reaffirmed instruction is the owner's decision. The configured figure wins and the
  EA 1955 floor renders as a non-blocking warning. **Scope: entitlement DAYS only** —
  `core/leave.ts:553`/`:557` (the right to APPLY) and the `updateLeaveType` statutory guard are NOT in
  scope. Keep `floorDays` in the return shape; recomputing the floor in the UI is how figures drift.
- **ANNUAL carry-forward expiry is 6 months** (`0333`, r85) — the reporter's policy change. "My
  carried leave disappeared early" is intended behaviour, not a bug.
- **`c33d9bbb` is PARKED BY THE OWNER** (2026-07-31) and is now `cancelled` on the board — re-counted
  2026-08-05, correcting an older line here that said it "stays `contested`". Either way, writing a
  rev 2 would re-open a settled decision.
- **`reporter_label` is DISPLAY ONLY** — `raiseFeedback` stamps `'CLAUDE AI'`. **Never "simplify" this
  into a synthetic person + employment**: `reporter_employment_id` drives RLS `can_see_employment()`
  and a fake employment row would join `openLeaveYear`, payroll and every employee list.
- **The entitlement page header stays empty** (`962077a8`, guarded by
  `test/entitlement-header-actions-removal.test.ts`).
- **Never edit an applied migration file** — drizzle records a content hash. (`0333`'s header
  mislabels itself as the guard; the guard is `0334`. Left uncorrected on purpose.)
- **Per-band carry-forward columns/JSONB/readers are retained, not dropped** (r85) — do not "tidy"
  them away.
- **`transferEmployee` has zero production callers and is kept deliberately** — it is the only writer
  of `assignment.transferred`, which `reverseLegTx` still replays. Not dead code.

## How this project is actually run

**Deploy is automatic after a green gate** (owner's override of ADR-0045; AGENTS.md carries the rule).

**THE GATE, IN FULL — and the middle line is the one that keeps being got wrong:**
`pnpm exec tsc --noEmit` · **`bash scripts/gate-chunked.sh`** · `pnpm exec next build` ·
`pnpm gate:shadow` whenever a migration is involved.
**NOT `pnpm vitest run`.** A bare full run exhausts the RAM disk and kills the cluster mid-suite — it
produced two false red gates on 2026-08-06 alone (293 and 9 failed files, zero assertion failures both
times). The shadow rehearsal is the one that catches a journal `when` collision, which is a SILENT SKIP.

**Deploy mechanics.** SSH port **8288**, `ubuntu@203.142.6.241`, app at `/opt/ai-hr`. rsync (excluding
node_modules/.next/.git/.env*/.turbo/coverage/.claude/graphify-out) then `./deploy/deploy.sh` on the box,
which migrates, seeds catalogs, runs backfills and restarts. **The server has NO git checkout** —
`git log` there tells you nothing. **Run deploy.sh under `nohup … &` and poll its LOG**: it outlives a
10-minute ssh, and `pgrep -f deploy/deploy.sh` matches the waiter's own command string (cost 10 minutes
on 2026-08-06). `GET /` returning **401** is CORRECT — the password gate, not a failure.

**Before planning ANYTHING, run BOTH of these checks. Neither one finds what the other does.**

**1. Is `main` itself ahead of production?** (r159: it was, by a whole release.) This is the check
that did not exist before r159 and the only one that would have caught r158 sitting merged and
undeployed. It costs seconds and needs no branch archaeology:

    cd .claude/worktrees/mainwt && rsync -azi --delete --dry-run \
      -e "ssh -p 8288 -o BatchMode=yes" \
      --exclude node_modules --exclude .next --exclude .git --exclude '.env*' \
      --exclude .turbo --exclude coverage --exclude .claude --exclude graphify-out \
      ./ ubuntu@203.142.6.241:/opt/ai-hr/

Zero lines = production matches `main`. Anything else is an undeployed release, no matter what
CURRENT STATE claims. **Do this before trusting any "what runs" line in this file, including the one
above** — that line has been wrong.

**2. Is there an unshipped BRANCH?** — r86 was 13 finished items sitting unmerged while `main` stood
at r85, and a finished round nobody shipped looks exactly like no round:

    for b in $(git for-each-ref --format='%(refname:short)' refs/heads/build); do \
      n=$(git rev-list --count main..$b); \
      [ "$n" != 0 ] && echo "$b: $n unmerged"; done

(Use `for-each-ref`, not `git branch --list | tr -d ' *'` — the old form here mangled the `+` marker
git prints for branches checked out in another worktree and produced a screenful of
`unknown revision +build/rNNN`.)

Then LOOK at what it prints — the count alone lies (`build/r71` reports 4 unmerged commits whose
content reached main by another route). Confirm with `git diff --stat main <branch>`: main deleting
thousands of lines means the branch is old, not pending. A real pending round has recent commits, an
integration commit, and a small diff of genuinely new files.

**Reply on Telegram when the owner writes from Telegram.** Terminal output never reaches their chat.

## The feedback board — how the loop works

**Commands** (all from a checkout, `IMPROVE_SSH_HOST=203.142.6.241 pnpm improve:<cmd>`):
`pull` (open + contested ONLY — it hides `building`) · `pull-approved` · `pull-blocked` · `push-plan` ·
`block` / `unblock` · `build-start` / `build-complete` · `release` · `mark-deployed` · `raise`.
The CLI default host `10.20.30.20` is LAN-only — always set `IMPROVE_SSH_HOST`.

Parsing tip: `pnpm` prints a banner before the JSON. Split on the first `\n[\n`, not the first `[`.

**Plans are PLAIN TEXT.** The board renders them RAW — no Markdown. There is a skill for this:
`.claude/skills/feedback-plan`. Read it before writing any plan. Business language above the dashed
line, all technical detail in the BUILD NOTES trailer below it.

**Approve carries NO payload.** A plan that asks the reporter to choose between options can never be
answered — one item sat unbuilt three rounds that way. State ONE course of action, recommend it, and
tell them to reject with a reason if they want otherwise.

**Statuses:** open → planned → approved → building → done → deployed, plus `contested` (pushed back,
re-plan from the reporter's latest words) and `blocked` (approved but waiting on an answer).
`startFeedbackBuild` accepts ONLY `approved`, which is what makes `blocked` a real guard.

**Plan history is immutable** (`feedback_plan_revision`, append-and-close-once, by policy and by
trigger). Read a plan's `KNOWN OPEN POINTS FROM REVIEW` block before building it — that is where
unresolved objections are recorded, with citations.

**Adversarial plan-critique loops do not converge.** r123 spent 34 agents / ~3.2M tokens over two
rounds on 10 contested plans; verifiers confirmed round-1 fixes landed, then found deeper, different
defects each pass. 0 of 10 survived and there is no stopping rule. Do not simply run another round.

## Running builds with subagents

Established pattern (r73–r137). The rules, each learned the hard way:

- **Create each agent's worktree yourself FROM `main` and pass the path.** `isolation: 'worktree'`
  cuts from the repo root's HEAD, which is `local/root-scratch` — **114+ commits behind main**. Two of
  r126's three agents built against an r91-era tree this way.
- **Hand each agent an explicit migration number** — left alone they all pick the same next one.
- **Every agent needs its own `TEST_DB_NAMESPACE`** — without it they drop each other's template
  mid-run and both result sets become noise. A fresh worktree has no `node_modules`.
- **Group by FILE OVERLAP, never by theme.** If two items touch the same screen, one agent.
- **Ownership is assigned by FUNCTION, not by file** (r139, six workstreams / seven items, zero
  collisions). Three payroll items all needed `core/payroll-view.ts`; each was given named functions
  and told to STOP AND REPORT rather than edit outside its lane.
- **Only ONE agent per round may own each exact-set registry** — `packs/payroll` nav + `EXPECTED_SET`,
  `ADMIN_GROUP_FLAT_HREFS`, the dashboard card catalogue. Two branches editing the same literal is a
  guaranteed conflict, and r159 hit the same class from the other side: two workstreams independently
  tripping one drift guard.
- **THAT RULE HAS A HOLE, AND r174 FELL IN IT: OWNERSHIP COVERS EDITS, NOT SIDE EFFECTS.**
  `lib/permissions.ts` was assigned to the audit workstream for a route REMOVAL. A different
  workstream ADDED a guarded `page.tsx` (`/admin/leave/entitlements/ledger-archive`) and never touched
  the registry, so `test/function-access.test.ts` reverse-completeness failed at the integration gate —
  the one place it could be caught, since no single agent could see it. **Either the integrator owns
  every registry edit, or every agent that adds a guarded page must declare it in its report.** Ask
  each agent for the list; do not infer it from the diff at merge time.
- **Anything cross-cutting runs SOLO and LAST**, against the settled tree.
- **Tell each agent the traps its items will hit** — the guards it must not weaken, the writers that
  recently broke. The best results come from briefs that name the specific hazard.
- **Agents must REPRODUCE before fixing — the single highest-yield rule in this file.** Repeatedly,
  reported faults were not the described bug. Check in this order: **already built → mislabelled →
  on the adjacent screen → the reporter's diagnosis inverted → wider than reported** — BEFORE
  checking *absent*. A held-back item with findings is a good result.
- **Enumerate every caller before changing any of them.** The enumeration is often worth more than
  the fix.
- **The integration gate catches what no agent can see.** Per-agent runs are necessary and never
  sufficient.
- **Before running a Workflow here:** async agents are killed after 3 minutes of silence and this
  repo's test startup exceeds that — `.claude/settings.local.json` sets
  `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS=600000`.

## The code graph — query it before spelunking

**`graphify-out/` in THIS worktree holds a knowledge graph of the whole codebase**, built from local
tree-sitter AST (no API key, no LLM). Untracked and rsync-excluded; regenerable in ~a minute.

**Use it FIRST when you need to understand code** — who calls what, with file:line, read from the tree
rather than from this file's prose (line numbers in prose go stale; the graph does not — it already
corrected one of this file's own citations). All commands run from this worktree:

    graphify explain "applyLeaveTypeRules"     # a node + every caller/import, with file:line
    graphify query "how does X reach Y?"       # BFS over the graph, --budget N tokens (default 2000)
    graphify path "requestLeave" "core/payroll.ts"   # shortest path between two nodes
    graphify affected "withTenant" --depth 2   # reverse traversal: what breaks if X changes
    graphify god-nodes --top 20                # the architectural hubs
    graphify-out/GRAPH_REPORT.md               # community map of the codebase (labels = hub node names)

**Every build updates it:** `graphify update .` after any merge to main (seconds, no LLM); add
`--force` after a refactor that deletes a lot of code.

**Known limitations:** the 313 `.sql` migration files are not parsed (`tree_sitter_sql` not
installed — the live schema is the drizzle TS, which IS in the graph); community labels are
hub-node names, not LLM prose (semantic naming needs `ANTHROPIC_API_KEY`); `graph.html` is not
generated (the 5,000-node viz limit) — the CLI queries are the interface. **Symbols exported
through destructuring under-report**: `explain "withTenant"` resolves to a `{ db, client,
withTenant }` node with no caller edges, while a plain exported function (`applyLeaveTypeRules`)
shows all 22. When `explain`/`affected` come back thin on a symbol you know is hot, fall back to
grep — an empty result is a parser gap, not proof of no callers.

## Environment — read before you lose an hour

### Worktrees and which tree you are on

- The repo ROOT (`~/Projects/ai-hr`) is a SCRATCH worktree on `local/root-scratch`, far behind main.
  **`main` lives at `.claude/worktrees/mainwt`.** The root's HANDOFF.md is a stub pointing here.
- **Check `pwd` and the branch in EVERY gate command, and read vitest's `RUN` line + file count.**
  A gate run in the wrong tree reports GREEN for the wrong code — this has bitten three times
  (r79, r83, r86), each via a single `cd` that left the shell at the root.
- ~30 stale `build/r*` worktrees sit under `.claude/worktrees/`, all merged, safe to prune.
  `git worktree remove` deletes the DIRECTORY, not the branch; the only thing removal can lose is
  uncommitted work — check `git -C <path> status --porcelain`, not `git log main..<branch>`.

### Local Postgres — the wedge is FIXED; do not re-diagnose it (full diagnosis: history → r160)

- Data dir **`/opt/homebrew/var/aihr-pg16`** (a SYMLINK to a RAM disk), binaries
  **`/opt/homebrew/opt/postgresql@16/bin`** (keg-only — PG14 shadows `psql` on PATH, use the explicit
  path or `pnpm db:start`). Port **5433**.
- **Misbehaving? Run `./scripts/dev-db-rebuild.sh`** (<1 min). It puts the data dir on an 8GB RAM disk
  (mounted at `<DATA>-ram` with `<DATA>` a symlink, because `initdb` refuses a mount point as PGDATA),
  sets the WAL sizes **conditionally on the volume type** (see the two bullets below), keeps `fsync=off`,
  and creates the `NOBYPASSRLS` role. Opt out with `AIHR_RAMDISK_GB=0`. **A RAM disk does not survive a
  reboot** — and if it dies mid-run it can leave a worker DB in `invalid` state, which reads as
  `cannot connect to invalid database`; drop those (`datconnlimit = -2`) or just rebuild.
- **NEVER blame the cluster first.** Every earlier version of this section did, and r160 lost hours to
  it. The real bug was `resetDb()`'s TRUNCATE having no `lock_timeout` while TWO pools sat on every
  worker DB; it is fixed in `test/harness.ts` (5s timeout + bounded retry inside ONE transaction).
- **THE DIAGNOSTIC RULE, which has now paid out four times: A RED GATE WITH NO ASSERTION FAILURES IS A
  HARNESS OR ENVIRONMENT PROBLEM.** `grep -c AssertionError` the log BEFORE reading a single failure.
  Three of the four were a background process — a live Workflow, a stale dev server — still holding the
  cluster while the gate ran. **Kill the dev server in the same command that finishes a render check.**
- **The suite generates ~10GB of WAL per full run, more than this machine retires in real time**, so
  **always use `CHUNKS=6 bash scripts/gate-chunked.sh`**, never a bare `pnpm vitest run`: it rebuilds
  the cluster between chunks, covers BOTH vitest projects, and asserts vitest COUNTED as many files as
  it was asked to run (a file whose worker fails to spawn is not counted and reads as green). The real
  cure is in the harness — `CREATE DATABASE … TEMPLATE` instead of a ~100-table TRUNCATE per file — and
  is worth doing deliberately, not at the end of a release.
- **`CHUNKS=6`, NOT the default 3 — measured 2026-08-10.** A 209-file chunk reached 5.1GB of WAL against
  the 8GB volume and was still climbing; at 105 files per chunk the volume sits near 12% and checkpoints
  retire cleanly. 627 files went green in 6 chunks.
- **NO WAL SETTING SUBSTITUTES FOR CHUNKING, so do not go tuning instead.** `pg_wal` settles at roughly
  *write rate x checkpoint duration*. `max_wal_size` decides when a checkpoint STARTS — it does NOT
  throttle writers — and `checkpoint_timeout` has a hard 30s floor (`15 s is outside the valid range …
  (30 .. 86400)`). At the ~130MB/s this suite generates, the arithmetic floor is ~4GB and it ran to 7GB.
  Three settings were tried on the RAM disk (min 3GB/max 1GB, min 1GB/max 2GB, min 192MB/max 512MB) and
  **all three filled it**. Bounding the RUN is the only lever.
- **`min_wal_size`/`max_wal_size` now differ BY VOLUME, and the reasons are opposite.** `dev-db-rebuild.sh`
  picks: ON DISK `min 3GB / max 4GB` (unlinks were the ~8s AV-scanned bottleneck, so a big pool makes
  Postgres RECYCLE by rename instead); IN RAM `min 192MB / max 512MB` (unlinks are free, so the pool buys
  nothing and every byte is charged against a volume that cannot grow). The old config had `min 3GB`
  under `max 1GB` — a floor above the ceiling, which Postgres accepts silently because pacing reads
  `max` and retention reads `min`.
- **THE FIRST COMMAND ON ANY RED GATE IS A CAUSE GREP, not reading test names.** On 2026-08-10 the
  failure list was read three times (2,766 failures / 344 files, zero assertion errors) before anyone
  grepped for the actual cause, which was `could not extend file … No space left on device` (SQLSTATE
  53100) — the volume had filled and killed the cluster mid-run. Run:
  `grep -oE "(PostgresError|AssertionError)[^\"]{0,80}" <log> | sort | uniq -c | sort -rn | head`
- **Apex One** real-time scanning of the data directory was excluded by the owner 2026-08-04; keep it.

### Running and reading test gates

- **One vitest at a time.** A second concurrent run wipes the first's worker databases. Parallel
  agents each get their own `TEST_DB_NAMESPACE`; otherwise do NOT invent one (leaked namespaces once
  reached 366 databases, which slows CRASH RECOVERY catastrophically, not checkpoints).
- **Redirect long commands to a FILE, never a pipe** (`> log 2>&1`). An undrained pipe hangs the
  command at 0% CPU forever, and an exit code read through a pipe is the LAST command's (`rsync … |
  tail -3; echo $?` reports tail's — this once turned a half-transferred deploy green).
- **"Is it stuck?" — read the LOG, never the process list.**
  `grep -E "Test Files|Tests |Duration" <log> | tail -4`. A `Duration` line means DONE regardless of
  the process table (vitest often does not exit after reporting; teardown takes minutes and emits
  nothing).
  **CORRECTED r137: "no Duration + GROWING log = still working" is wrong for a redirected run.**
  Vitest's reporter BUFFERS in non-TTY mode, so the log sits at its `[global-setup]` line and does
  not grow at all for the entire run — 15 minutes of silence is the NORMAL healthy state, not a
  symptom. **The liveness signal is the test-DB connection count**, which tracks real work:

      psql -p 5433 -U postgres -d postgres -At \
        -c "select count(*) from pg_stat_activity where datname like 'ai_hr_test%'"

  Healthy mid-run is ~16–22 with several `active`. Genuine hang = no `Duration` AND zero connections.
  A full suite now takes **~950 s** (558 files / 6612 tests), longer than the 761 s recorded earlier.
- **Never `pgrep -f` a string your own waiter contains** — `until [ "$(pgrep -f 'vitest.mjs run' …`
  matches itself and waits forever.
- **Read vitest's EXIT CODE and file count, never just the summary.** A file whose worker fails to
  spawn is not counted AT ALL — r91 printed `513 passed (513)` on a 514-file tree and exited 1. The
  `browser` project's `*.browser.test.tsx` file being outside `pnpm vitest run` is EXPECTED (one-file
  gap); anything else is not.
- **`TaskStop` does not stop server-side statements a test run started** — kill the client, then
  check `pg_stat_activity` and cancel what it left behind (one orphaned `CREATE DATABASE` once turned
  12 unrelated tests into 30 s timeouts).
- **Test layers:** `pnpm vitest run` = node + jsdom `dom` projects together (the gate).
  `pnpm test:browser` = real Chromium + real Tailwind (`getComputedStyle`), opt-in, deliberately
  OUTSIDE the gate until it has a track record. `globalSetup` is inherited by `extends: true`
  projects — declare it on the project that needs it, never at the root, and count the
  `[global-setup]` lines in the output.

### Migrations

- **The JOURNAL is the migration.** A `.sql` file without a `db/migrations/meta/_journal.json` entry
  silently never runs. `test/migration-journal-ordering.test.ts` catches it — but only if you run the
  suite, not just your new test file. The test-template fingerprint hashes the journal (r112), so
  adding the entry forces a real template rebuild.
- **Allocate numbers centrally — never let an agent pick one.** Parallel agents independently pick
  the same next number; hand them out up front (gaps are fine and deliberate).
- **A stale number is a SILENT SKIP.** drizzle reads the last applied `when` as a watermark and
  ignores journal entries below it. Before merging ANY held branch, compare its journal `when`
  against the deployed watermark and renumber above it (SQL file + journal `idx`/`when`/`tag` + any
  comment citing the number). Reused numbers merge as the same silent skip.
- **A migration that CREATEs a table must also GRANT on it.** Production's
  `ALTER DEFAULT PRIVILEGES` masks the omission; a dev cluster restored from a dump has no such
  default and the first render through `ai_hr_app` throws `permission denied`. No test sees it — the
  suite connects as the owner. Copy `0345`/`0354`/`0357`.

### Rendering and verification

- **A 200 is NOT a render check.** `MISSING_MESSAGE` shows ONLY in the dev-server log on a real
  render — tsc, the suite, `next build` and the route's 200 all stay green. Three shipped this way in
  five rounds (r123 server/client boundary, r127 twelve labels, r134 the Cycle field on every payroll
  run page). The recipe costs five minutes:

      pnpm db:seed && PORT=3111 pnpm dev
      curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3111/admin/leave/entitlements
      # …then READ the dev-server log for MISSING_MESSAGE

- **Server components passing closures to client components also pass every gate** (r123 broke
  production this way; the reporter found it). `test/server-client-boundary.test.ts` pins the class.
- **Browser verification runs against a LOCAL dev server with the `dev_user` identity switcher —
  never production** (WorkOS OAuth). `cloudflared` runs ON THE SERVER — a local `pgrep` means
  nothing; curl the tunnel URL WITHOUT `-f` (401 is the healthy password gate). The tunnel hostname
  changes if that process restarts.
- **Fetching page HTML to grep for a label is a false positive** — Next.js embeds the whole i18n
  catalog in the payload. Check the component source or a real render.

### The server

- ssh `-p 8288 ubuntu@203.142.6.241`; you may `sudo systemctl restart aihr` yourself.
- Default `node` is v18 and predates `--env-file` — prefix `PATH=/opt/node20/bin:$PATH` or chase a
  phantom "bad option" bug.
- **CORRECTED r137: the deploy rsync DOES carry `--delete`.** `scripts/improve/release.ts:71` has it,
  and r137's two deleted files were verified gone from the box afterwards. The older warning here
  ("no `--delete`", from r128) is **wrong for the release path** — but `--delete` only protects you if
  you actually pass it, so keep it in any hand-rolled rsync, and note excluded paths
  (`node_modules`, `.next`, `.env*`) are protected from deletion, which is why `.env.production`
  survives. Still worth listing what a release removes:
  `git diff --diff-filter=D --name-only <last-released-ref>..HEAD`.
- **Proof a deploy arrived** is `rsync -azi --delete --dry-run` reporting ZERO changes afterwards —
  `deploy.sh` succeeding is not it (a broken pipe once left 93 stale files behind a green deploy).
  Plain `--dry-run` prints nothing without `-i`. Use `--partial --timeout=120` and
  `ssh -o ServerAliveInterval=15`.
- **`next build` on the box runs BEFORE `db:migrate`** — an OOM aborts with production untouched and
  the old `.next` still serving; verify (`systemctl is-active aihr`, `GET /` 401, migration count)
  rather than assume. `NODE_OPTIONS` heap is 4096 MB against 3.9 GB RAM + 3.9 GB swap; past that it
  is a bigger-box problem. **Never `typescript.ignoreBuildErrors`** — the build's type pass catches
  RSC boundary errors `tsc` alone does not.

## Traps — the durable ones (each cost at least a round; several recurred AFTER being written down)

- **MERGED IS NOT DEPLOYED, AND THIS FILE HAS ASSERTED OTHERWISE (r159).** r158 was merged to `main`,
  including migration `0403`, and never shipped; CURRENT STATE said "no pending deploy, nothing in
  flight" and the board still showed all three items `approved`. Every signal agreed and every signal
  was wrong. The failure mode is structural, not careless: the unshipped-round check reads `build/*`
  branches, and merged work has none; the board reads status, and nobody had called `build-start`.
  **A dry-run rsync against the box is the only cheap ground truth for "what is actually running".**
  Corollary — after a merge, the deploy is not optional bookkeeping you can leave for the next round:
  the next agent will read `main` as shipped.

- **THE IMPORT RATCHET DOES NOT STRIP COMMENTS, so a comment that quotes an import is read as a real
  edge (r159).** `lib/completed-years.ts` imports NOTHING, and the leave pack-drift guard failed it
  anyway: its header explained which specifier `core/leave.ts` re-exports, spelled as a literal
  `from '…'`, and `test/helpers/import-ratchet.ts` matched it. **Before believing a drift violation,
  open the flagged file and look for a quoted specifier inside a comment.** The fix is to reword the
  comment — never to add an allowlist entry (that list is audited debt and only shrinks) and never to
  "fix" the scan: a regex comment-stripper mangles `//` inside string literals and would start MISSING
  imports. Comment blindness can only ADD edges, which fails loud; the alternative fails silent. That
  trade is now written into the helper's header.

- **A GUARD THAT READS ONE FILE'S SOURCE BREAKS WHEN A FIELD IS EXTRACTED INTO A COMPONENT — and the
  tempting fix deletes the protection (r159).** `35b7af0a` group 4 moved EPF Number/Citizenship into a
  shared component; three static-source guards stopped finding `name="epfNumber"` on the page. Two of
  them are wipe guards on a FULL-ROW overwrite form, where a field missing from the POST silently
  clears the column — exactly what must not be dropped. Following the string alone is also wrong: the
  component contains the name whether or not the page still renders it, and `mode="controlled"` emits
  `value`/`onChange` with **no `name` at all**. So a guard that follows an extraction needs three
  things, not one: the field exists in the component, the page renders that component, and it renders
  it in the mode that actually posts. Note also that a form-mode prop object (`name: 'epfNumber'`)
  mounts an input exactly as a JSX attribute (`name="epfNumber"`) does — accept both spellings or
  every future extraction fails for a cosmetic reason.

- **A NAIVE JSON DEEP-MERGE RESURRECTS DELETED KEYS — and the six message catalogs are where it bites.**
  When two parallel branches both edit `messages/*.json`, git conflicts on the whole file and the
  obvious fix is a recursive merge of the two objects. That is WRONG whenever either branch DELETED a
  key: a branch cut before the deletion still carries it, so "present in theirs, absent in ours" looks
  like an addition and the retired key comes back. Measured this session — r138 retired four wizard
  label groups, r141 predated that, and the merge silently restored all four in all six catalogs.
  **PRESENCE IS A VALUE. Consult the merge BASE for absence too:**
  - in base · gone from one side · unchanged in the other ⇒ **DELETE**
  - not in base · present on one side ⇒ ADD
  - deleted one side · modified the other ⇒ deletion wins, and REPORT it
  Get the base explicitly (`git merge-base HEAD^1 HEAD^2`) — the `:1` stage is gone once you commit.
  Assert afterwards that BOTH sides' additions and each side's deletions survived; the guard that
  caught this (`test/wizard-personnel-shared-fields.test.ts`) only exists because r140 wrote it.

- **AN EXACT-SET NAV GUARD MUST BE UPDATED, NOT LOOSENED, WHEN A ROW IS LEGITIMATELY ADDED.**
  `ADMIN_GROUP_FLAT_HREFS` (sidebar), `EXPECTED_SET` (payroll flyout) and the pack-drift allowlist all
  fail when a new row appears — that is their job: they catch a sibling accidentally CLIPPED by an
  edit. Declare the new row in the list. Only ONE agent per round may own each of these, or two
  branches both edit the same literal.

- **`redirect()` SIGNALS BY THROWING, so a success toast next to one gets swallowed.** A toast inside
  the same `try` is caught by the service-error handler and every SUCCESSFUL action redirects to
  `?error=NEXT_REDIRECT` — live for a whole release in the leave adjustment writer. Put the toast
  AFTER the redirect, never beside it.
- **A `labelKey` IS NOT THE LABEL.** Resolve the key against `messages/en.json` before describing
  what a screen says — a plan written off key names proposed three renames that were all already
  live. A key's NAME is not evidence of who reads it either: grep consumers before deleting keys by
  prefix (r137 deleted three shared `festive*` labels a surviving component used).
- **A date derived from an instant must go through the tenant timezone.** `toISOString().slice(0,10)`
  is YESTERDAY between 00:00 and 08:00 MYT. Use `todayInKualaLumpur()` for "what date is this
  instant"; date-only ARITHMETIC stays UTC. **This applies to FIXTURES too** — r92 fixed 45 app sites
  and skipped `test/`, and six test files then failed only at night (the product was right, the test
  was wrong). `test/today-in-myt-drift.test.ts` scans both. Every daytime green proves nothing about
  a timezone fix — re-verify inside 00:00–08:00 MYT. **Debugging an off-by-one date: check the clock
  before the code.**
- **THIS DOCUMENT'S SHIPPED LISTS ARE NOT EVIDENCE — in either direction.** An item recorded here as
  shipped had never merged (r76); slice 2 had no round entry and looked skipped but was live at 50
  call sites. Verify with `git log -S <symbol> main` before trusting any claim here.
- **i18n guard holes** (`test/i18n-coverage.test.ts` check C): it skips files using more than one
  namespace, and only matches LITERAL keys — `t(helperReturningKey(x))` is invisible.
  **THE SAME BLINDNESS MAKES "UNUSED KEY" A FALSE POSITIVE, and r159 nearly deleted three on it.**
  `fields.rateAmount`, `fields.dateOfBirth` and `fields.bankAccount` survive no literal grep, because
  the wizard's Review step renders `t(`fields.${f}`)` from whatever `missingByStep` returns
  (`app/admin/personnel/new/wizard.tsx:849`). Deleting them is a MISSING_MESSAGE on screens HR really
  reaches: a daily-paid hire with no rate, a malformed date, half a bank instruction. All three are
  pinned non-empty in all six catalogs by `test/wizard-personnel-shared-fields.test.ts`, and both
  component headers say so. **Before deleting any key, grep for the COMPUTED form (`` t(`prefix. ``)
  as well as the literal — absence from a literal grep is not evidence.** Prefer one
  namespace per file; for computed keys, test every value the helper can return.

- **A KEY THAT EXISTS BUT CANNOT FORMAT IS INVISIBLE TO CHECK C — third hole, found r140.** Check C
  asks whether the key resolves, and *existing* and *formatting* are different things. A message
  containing `{row}`/`{expected}` is ICU interpolation, so a plain `t('…')` with no arguments THROWS
  `FORMATTING_ERROR` at render and paints the literal key path on screen. **The route still returned
  200, tsc passed, and check C passed.** Only the dev-server log on a real render showed it. Use
  `t.raw()` when the braces are meant literally (e.g. a template a client island substitutes into),
  and remember that placeholder-looking text is a formatting contract, not decoration.
- **A REFUSAL TEST CAN BE PINNING SOMETHING OTHER THAN YOUR FIX — so REVERT THE FIX AND RE-RUN before
  you believe it (r172).** `3e3d3fb2`'s plan called the TP1 `?employmentId=` handling a security gap;
  three attempted exposures were all refused by RLS, including the manager branch the plan predicted
  would leak. The mutation check is what caught it: **with the guard reverted, the whole test file still
  passed**, because it was pinning RLS rather than the new guard. A green refusal test proves the
  behaviour is refused — NOT that your code is what refuses it.
- **THE PACK IMPORT RATCHET'S ALLOWLIST IS NOT A REGISTRATION POINT — READ ITS FAILURE TEXT (r175).**
  A new `core/` file imported `core/attendance` and `core/payroll` directly and turned BOTH drift
  ratchets red. The tempting fix is `test/pack-drift-allowlist.json`; the guards refuse it in their own
  message — "The allowlist only ever shrinks; do not add entries." That list is audited kernel-contract
  DEBT, not a place to file new work, and adding to it silently widens the ADR-0080 boundary the guard
  exists to hold. **Import from `packs/<pack>/service` instead.** Two things make that safe and both are
  worth checking rather than assuming: the facades re-export with `export *`, so every symbol resolves
  unchanged; and several `core/` files already import a facade (`absence-days`, `admin`, `entitlements`,
  `movement-apply`, `operator`), so it introduces no cycle. Check for the documented comment false
  positive first — the ratchet does not strip comments.

- **A MERGE CONFLICT WHERE NEITHER "OURS" NOR "THEIRS" IS CORRECT (r175).** `core/attendance.ts`
  collided between the shift item (which had just made `scheduleFor` DATE-AWARE via a new `defShiftOn(d)`
  helper) and the absence item (which had moved the same declaration earlier, still using the old
  `defShift` variable — which no longer existed). Taking ours dropped the absence item's roster-wins
  gate; taking theirs silently reverted date-aware shift resolution that was ALREADY DEPLOYED, and would
  not even have compiled. The resolution was semantic: one declaration on the date-aware helper, with the
  other branch's new gate rewired onto it. **When two branches touch one function in the same release,
  read what each was FOR before resolving — a clean-looking pick can revert live behaviour.**

- **A PLAN THAT PROMISED WHAT THE DATABASE REFUSES GETS RAISED, NOT PATCHED, AND NOT PUSHED AS A PLAN
  REVISION (r175).** `23390097` promised supervisors could roster future dates; RLS refuses it. Note the
  mechanism trap: `improve:push-plan` sets `status = 'planned'`, so pushing a revision onto a DEPLOYED
  item un-deploys it on the board and loses the record that the work shipped. Use `improve:raise`
  instead — the CLI documents it for exactly this ("a decision the pipeline surfaced that the reporter
  must own"), it lands as `open`, and `raiseFeedback` stamps `reporter_label = 'CLAUDE AI'`.

- **A GREEN SUITE, A 200, AND ONE OF TWO PDF RENDERERS ALL CALLED A PAGE CORRECT WHILE IT WAS WRONG
  (r175a).** The CP22 renderer silently DROPPED any line past the third in a multi-row block: a
  four-line Malaysian address filed to LHDN without its state, and box (b) short an allowance,
  understating declared remuneration. No warning, no ellipsis — the box looks full. 81 tests were green
  because every fixture used three address lines, while **the form is ruled for four**. Two lessons:
  **(1) test the row count the artefact actually prints, not the one that happens to fit**; and
  **(2) WHEN TWO RENDERERS DISAGREE, THAT DISAGREEMENT IS THE INSTRUMENT.** Poppler regenerates a field's
  appearance when `NeedAppearances` is set and drew the line whole; MuPDF and macOS Preview draw the
  embedded stream and showed the damage. Rasterise in BOTH (`mutool` and `pdftoppm` are available) — a
  fix that satisfies one is not a fix. The clip is the rect inset by 1pt, so a block sized "top of row 1
  to bottom of row R" also slices the Rth row's descenders; extend the rect DOWNWARD, which moves no
  text because `baseline_n = rectTop − 1 − n × pitch`.

- **STOPPING AN AGENT CAN LOSE UNCOMMITTED WORK THAT IS BETTER THAN ITS LAST COMMIT (r175a).** A fix
  agent was stopped to free the cluster for the gate; it had already committed a working fix, and had
  THREE further modified files uncommitted — the 900dpi measurement showing the last row's descenders
  were still being clipped. Merging the branch as-committed would have shipped the weaker fix silently,
  because the committed state passed its own tests. **Before merging a branch whose agent you stopped,
  run `git status` in its worktree and read the diff.** If it is coherent (tsc + its own tests), commit
  it — do not discard it as scratch.

- **`rejects.toThrow()` passes on the WRONG throw** — a fixture failing NOT NULL before reaching the
  constraint under test reads as a pass. Assert the constraint NAME or match the real Postgres error
  via `.cause` (Drizzle wraps as "Failed query: …").
- **Editing code by index arithmetic needs assertions IN the edit script** — r137's span-cutting went
  wrong three times (comment-embedded braces, `//`-commented declarations) and only in-script asserts
  caught it before writing. Removing a `Promise.all` element without its destructuring slot silently
  shifts every later variable.

## Entitlement facts — read before touching leave (re-verified on production 2026-07-31)

**r85 MOVED THE RULES. Anything (including old history entries) saying `leave_policy` owns earning
method or carry-forward is WRONG.**

- **Rules live on `leave_type`** (columns `0325`, engines repointed `0334`). `applyLeaveTypeRules`
  (`core/leave-compute.ts:489`) overlays them onto the resolved policy — a **whole-set** overlay
  gated on `hasAnyLeaveTypeRule`. 10 leave types carry type-level rules.
- **`leave_policy` still supplies DAYS** and is the rules fallback for types carrying none. 67 policy
  rows, 57 `earned_monthly`. **Zeroing `leave_policy` wholesale would stop accrual for every type
  that falls through** — removing the band SURFACE is safe; emptying the TABLE is not the same act.
- **DAYS precedence:** `entitledDays = max(floorDays, schemeDays ?? policyDays)`; `schemeBandDays`
  returning **null — not zero** — triggers the fallback.
- **`leave_policy` has no `updated_at`** — date a change via `leave-policy.updated` events, never
  `created_at`.
- **Coverage gap that bites at reset time:** 12 of 41 benefit schemes have zero entitlement rows;
  ISEDECOR BINA + Demo Group Holdings have no schemes at all. After a reset those employees drop to
  the statutory floor.

## Carried debt — none of it blocking, all of it real

1. **Browser verification of shipped UI remains the top gap.** Nearly everything since r70 is
   source-reasoned only. The r93 runners (jsdom in the gate, Chromium opt-in) cover `'use client'`
   islands — they do NOT retire manual verification, because async SERVER components cannot be
   rendered by testing-library and most pages here are server components. The one time a screen was
   browser-measured (`4dbe04c6`) it overturned the source-reading diagnosis.
2. **A rendered-markup test can still be blind** when a client component receives server-passed
   nodes — the fixture must be the POST-TRANSPORT shape (`test/organization-list-rsc-lazy.test.ts` is
   the worked example; the Companies screen rendered 1 of 8 rows for 24 days behind a green suite).
3. **Pagination pages in memory on ten tables** — `paginateRows()` fetches everything then slices.
   Contract holds; the promised speed does not. Pushing limit/offset into ~10 read functions is the
   follow-up.
4. **ADR-0077 slices** (plan at `~/.claude/plans/resilient-greeting-ripple.md`, 43 KB, written 26 Jul —
   re-verify against the tree before building any of it):
   | slice | state |
   |---|---|
   | 0–4 | **DONE** (invitation privesc fix · schema · `isModuleEnabled` (`a38ed02f`, 50 sites) · gate classification · nav/page gating) |
   | 5 | **DONE r97–r100** except the admin setup notification (no natural key on `notification`) |
   | 6 | **DONE r176 (2026-08-10), except the deploy-failing flip.** The jurisdiction sweep and the mixed-currency refusal both shipped: `core/report-registry.ts` narrows the currency-mix check to rows that actually CONTRIBUTE a money value (a row with no figure can no longer trigger a refusal), and `core/reporting.ts` gained `eaEmployerCountry()` so `employeeEaStatements` resolves each form's pack from its OWN employer's country via a `Map<companyId, country>` rather than the tenant default — in a multi-country group, foreign-entity forms were being built against the wrong pack. Pinned by `test/report-summary-mixed-currency.test.ts` and `test/ea-per-employer-pack.test.ts`. **Still open: the deploy-failing flip** (unclassifiable company: warning → failed deploy) — needs explicit confirmation, see the blocker list |
   | 7 | **WRITTEN, NEVER PROVISIONED.** `core/platform-usage.ts` (148 lines), `test/platform-plane.test.ts` (203), migration `0351` and the `ai_hr_platform` role definition in `deploy/bootstrap-db.sql` all exist. **But `PLATFORM_DATABASE_URL` is ABSENT from production's `.env.production` (re-verified 2026-08-09)**, so `platformPlaneConfigured()` is false and `pnpm platform:usage` exits 2 on the box. Create the role from `bootstrap-db.sql` and set the URL — cheapest remaining slice |
   | 8 | **DONE (r121 `901352c5`) — this row used to say "decide whether that gate should be removable at all", and that decision HAS been taken: not once history exists.** `chainArmingDecision` is wired into `db/client.ts:13` and REFUSES to disarm a tenant with chained history; `test/audit-hash-chain.test.ts:134` used to assert the hole and now asserts the refusal. Preflight `scripts/check-audit-chain-gate.ts`; `app/admin/privacy/page.tsx:53` records why there is no banner. **The hazard it closed, worth keeping:** events appended while the gate is off carry `chain_seq IS NULL`, so they are ABSENT from the chain rather than breaking it — re-arming links onto the last chained event, every `prev_hash` matches, and `verifyTenantChain()` returns valid over a log with an unprotected hole |
   | 9 | **CLOSURE AND REACTIVATION ARE BOTH BUILT — the old "Remaining: CLOSURE · REACTIVATION" here was stale.** `core/tenant-lifecycle.ts` carries `closureDecision` (dual control + its own retention check), `suspendedDaysWithin`, `shiftExpiryForSuspension` and `replayPlan`, all pinned by `test/tenant-lifecycle.test.ts`; schema in `0350`. `scripts/reactivate-tenant.ts` (145 lines) closes the window, records the event and PRINTS the replay plan — report-only until `--apply`, deliberately not firing sweeps at a customer's live payroll. **THAT GAP IS CLOSED — r176 (2026-08-10).** `scripts/close-tenant.ts` is `closureDecision`'s first caller. It carries a `--today` guard: without one, an arbitrary date silently defeats the retention hold the decision exists to enforce, so the script refuses a `--today` that is not the real MYT day unless explicitly overridden. Pinned by `test/tenant-closure-runner.test.ts`. Report-only until `--apply`, matching `reactivate-tenant.ts` |
   | 10 | **SCHEDULED 2026-08-09 — the bleed is STOPPED.** `capture-usage` runs daily at 01:00 (crontab, ahead of the leave sweeps); first scheduled-era run wrote 9 rows / 0 failures across 9 companies in 1 tenant. Env contract is **`MIGRATION_DATABASE_URL`, NOT the platform pool** — slice 7 is not a prerequisite, which is why this could ship ahead of it. **2026-08-03 → 2026-08-08 are permanently unbillable** — before this, `usage_snapshot` held 8 rows all dated 2026-08-02. The read model (`platformUsageSummary`, `pnpm platform:usage`) is done; the DASHBOARD is still unbuilt, deliberately — `/platform` needs its own auth boundary (`platform_user` ≠ `app_user`, ADR-0077 D5) and cannot reuse the tenant session |
   Slice 9's enforcement is inert in production today; `apply-dunning` is report-only and unscheduled.
   **An older line here said "both tenants `active`" — 2026-08-09's `capture-usage` run reported
   `1 tenant(s) in scope, 0 skipped` via the shared `loadSweepScope`, i.e. ONE tenant, not two out of
   two. Count before relying on either number.**
5. **Test-DB teardown is FIXED — kept so nobody "fixes" it again.** `test/global-setup.ts:298`,
   best-effort and never fatal. A run drops its own template and workers on exit.
6. **Dead/misplaced payroll config** (r78): `payment_basis` is written and read by nothing; probation
   months / review reminder days / default currency live on the payroll screen but belong elsewhere.
   No open item carries these any more — raise afresh if they matter.
7. **`tenant_module` has exactly ONE writer** — `scripts/module-change-runner.ts` draining
   `module_change_request` under the OWNER role. Never hand SQL. Reactivation NEVER re-seeds
   (ON CONFLICT DO NOTHING), so a customer's edited settings survive a disable/enable cycle (D4,
   pinned by test).

---

## NOTHING IS IN FLIGHT — `main@dec4bb73` is r185 through r194 and IS deployed

Verified by dry-run rsync (2026-08-14, reporting only the box-regenerated gitignored `next-env.d.ts`).
Every `build/*` branch through r194 is merged. Re-verify rather than trusting this line.

Every remaining unmerged `build/*` branch is STALE, not pending — `r71`, `r83`, `r154` (squashed,
ancestrally unrelated), `r163-g-release3` and `r163g-picker`, whose content reached main by another route:
their migration `0405` is on main as `0410_entitlement_reset_drop_old_layers.sql`, and `main` DELETES
~45,000 lines relative to both, which is the tell.

**"Nothing in flight" is a claim about BRANCHES — it is NEVER a claim that `main` has been deployed.**
Prove that separately with the dry-run rsync above; r159 exists because those two were conflated.

**`2f889bae` SHIPPED IN r191 AT REVISION 2, NOT AS ORIGINALLY WRITTEN.** Five of its seven original steps
had already shipped under `2aed39d4` (r185) and step 7 contradicted live behaviour, so it was re-planned
and the reporter approved rev 2. What shipped is one thing: a View/Edit LINK from the Personnel Payroll
tab rows to the item's own page. Kept here because "approved" and "buildable as written" are not the same
claim, and this item is the standing example.

Every OTHER unmerged `build/*` branch is STALE, not pending — `r71`, `r83`, `r154` (squashed, ancestrally
unrelated), `r163-g-release3` and `r163g-picker`, whose content reached main by another route: their
migration `0405` is on main as `0410_entitlement_reset_drop_old_layers.sql`, and `main` DELETES ~45,000
lines relative to both, which is the tell.

**"Nothing in flight" is a claim about BRANCHES — it is NEVER a claim that `main` has been deployed.
Prove that separately with the dry-run rsync above; r159 exists because those two were conflated.** And
the converse now applies too: **`main` being deployed is not a claim that the round's work is shipped**,
because r186 sits beside it on a branch.

On ship, a round's entry moves to the top of `docs/HANDOFF-HISTORY.md`.

**Shipped round entries (r66–r185): `docs/HANDOFF-HISTORY.md`.**

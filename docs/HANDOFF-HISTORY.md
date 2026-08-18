## r197–r199 (2026-08-18) — TEN ITEMS SHIPPED ACROSS THREE RELEASES, AND THREE HELD ON PURPOSE

`fc3df3a8` (r197 part one: `9a65f808`, `152fea7f`) then `dff907c3` (r198+r199: `9066bd6c`, `4ea70bb7`,
`e0cd4583`, `6b134681`, `417d4937`, `6df24751`, `bd14b7e2`, `4509d2b8`, migration `0443`). Final gate
**703 declared / 703 counted / every chunk exit=0 / 0 AssertionErrors / 0 timeouts at CHUNKS=5**; tsc 0;
`next build` 0; `gate:shadow` PASS 360→361; 48 renders across 8 routes × 6 locales, 0 `MISSING_MESSAGE`.

**THE PATTERN OF THESE THREE ROUNDS, AND THE REASON TO KEEP THE VERIFY PASS: 17 of 18 workstreams built
GREEN AND FAILED VERIFICATION.** Every one passed tsc, its own tests and `next build`. What the second
pass found was pay- and tax-affecting: three cycles seeded onto one `run_type` so a "Mid-Month"
transaction was collected by an "Advance Salary" run; a PCB formula that overshot its own printed answer by
17,800 on any bonus month; a completeness control that tiled the calendar without asking WHICH employer
owned each segment. Only `4509d2b8` shipped verified-clean first time.

**AND THE FULL GATE STILL EARNED ITS PLACE, catching three things no verify agent could see** — all
cross-branch: a `core/` service using the page-safe entitlements form (silently answering "off" on an
infrastructure failure); a source-shape guard broken by the integrator's own merge, which pinned the
`<HistoryTable>` ELEMENT while its comment claimed it pinned the prop; and a new CP39 preview born
carrying the superseded width cap, caught by the guard r197 had just rebuilt after it was found unable to
fail.

**THE CONTESTED PAIR — WHY OUR OWN FIX MISSED, MEASURED ON PRODUCTION.** r196 shipped `6b134681` +
`417d4937`; the reporter tested and rejected both. The cause: **REGULAR runs had 24 of 62 payslips carrying
a `componentLines` stamp; BONUS runs had 0 of 19.** The additional-run path never wrote one, so nothing on
a bonus payslip said "ANGPOW" and every screen fell back to the box label, which reads BONUS. The r196 work
reads `componentLines`, so it was STRUCTURALLY INERT there and the reporter's three workarounds could not
have worked. The re-plan opens "You are right, and we are sorry" and says so.

⚠️ **THE CONSUMED-MARKER BACKFILL DECLINED THE ROW THAT PROMPTED IT, AND THAT IS THE ANSWER, NOT A BUG.**
`scripts/backfill-consumed-batch-417d4937.ts` wrote 13 rows. The SpaceX Director Fee row was excluded
because it was edited 2026-08-12 11:21 while its payslip was calculated 2026-08-11 09:57 — it fails the
staleness rule, i.e. it genuinely was NOT paid by that run. So "Recorded Items shows A0020 DIRECTOR FEE" is
a faithful historical stamp whose transaction moved on afterwards — a different problem from a label bug,
and the one the new source-transaction panel addresses by listing ledger rows BESIDE Recorded Items.

⚠️ **`/payroll/[batchId]/remove` SHIPPED WITHOUT A DEV-SERVER RENDER.** The seed produces no processed
batch and a throwaway seeder failed on an RLS-fenced `pay_period` insert. Covered instead by
`test/payroll-remove-i18n.test.ts` (every key of that multi-namespace screen resolved in six locales,
which is exactly what i18n-coverage Check C skips) plus `next build` for the RSC boundary. Weaker than a
render. **Render it first thing next session.**

⚠️ **THE SEEDER ALMOST REPEATED THE MORNING'S MISTAKE.** It left `mk-batch-tmp.ts` importing `core/payroll`
in the tree — the pack-drift ratchet scans the FILESYSTEM, so that is a red gate. Deleted and the guard
re-run before merging. **Any throwaway script in the tree is a loaded gun.**

**MIGRATION NUMBERING LEFT A LANDMINE.** `0442` sits on the held `build/r197-entity`. `0443` shipped, so
the watermark is past it: if entity ever merges carrying `0442` it is SILENTLY SKIPPED. That number is
dead; reissue when the item is reworked.

**PLANNING FOUND MORE THAN BUILDING DID.** Of the last ten items planned, **every one reported something
already built** — two were exact duplicates of shipped work (`621c929d`, `d21e667e`, closed against the
rounds that shipped them), and `16f2aac1` reports five of the reporter's nine Borang 8A corrections already
printing today. Investigate before proposing; this board rewards it every time.

## r196 (2026-08-18) — SEVEN ITEMS, SIX WORKSTREAMS, MIGRATION `0441`, AND A VERIFY PASS THAT EARNED ITS COST

`main@cd06bcda`. Six worktrees cut from `main`, built by `scripts/improve/build-r196.workflow.js`
(6 build + 6 verify agents), then `fix-r196.workflow.js` (5 fix + 2 re-verify). Gate **690 declared / 690
counted / every chunk exit=0 / 9,297 tests / 0 AssertionErrors / 0 timeouts**; tsc 0; `next build` 0;
`gate:shadow` PASS 359→360; render check 8 routes x 6 locales, all 200, 0 `MISSING_MESSAGE`. Shipped:
`5ff7daff` (Replacement Leave — role-aware ESS placement default) · `31e39d74` (entitlement status on My
Leave) · `c11e81aa` (Individual Transaction pay-cycle intent, `0441`) · `6b134681`+`417d4937` (pay item
identity + the four payslip surfaces reconciled) · `3c2f55d7` (Organization card redesign) · `ad52212d`
(Attendance Settings rounds 1-2).

**EVERY ONE OF THE SIX BUILDS CAME BACK GREEN — tsc, its own tests and `next build` — AND FIVE OF THE SIX
STILL NEEDED FIXING.** That is this entry's point. The verify pass found what a targeted test run
structurally cannot see, and the worst of it was pay-affecting:

1. **`DEFAULT_PAYROLL_CYCLES` SEEDS THREE CYCLES ONTO ONE `run_type`** — 'Off-cycle', 'Advance Salary' and
   'Mid-Month' are all `off_cycle` (core/payroll-cycle.ts:115-125). The first `c11e81aa` build matched a
   transaction's intent to a run BY RUN TYPE, so a row saved as Mid-Month was collected and paid by an
   Advance Salary run. Only `regular` is protected from that, by two independent invariants at once (one
   active regular cycle per company, one regular batch per period). **Run type is not an identity.** The fix
   gives the BATCH a `payroll_cycle_id` and matches ID to ID through one shared resolver that both the run
   and the card read. The same collision existed a second time on the ATTACHED write path, and
   attach-on-generate never revisits an attached row, so it would have paid there too.
2. **A `<select>` WITH NO BLANK OPTION STAMPED A CYCLE THE OPERATOR NEVER CHOSE**, and editing only the
   AMOUNT of a legacy row re-pointed it. Rule 17 in a new costume: the field is always submitted. Fixed with
   an explicit empty option plus a `cycleTouched` flag, so an untouched field sends nothing at all.
3. **THE COMMENT IS THE GUARD, AND THERE WERE FIVE COPIES OF IT.** `listUnattachedTxnSummary` documented
   "attach-on-generate is REGULAR-RUN-ONLY" as a load-bearing invariant and keyed its join on it;
   `unattachedHoldersOutsideSelection` returned `[]` on the same reasoning, silencing the Payroll Process
   pre-flight for exactly the rows a regular run now abandons. Fixing those two left THREE more statements
   of the dead rule, one of them in a file the change had itself edited.
4. **A FIX INTRODUCED A DOUBLE-COUNT AND ITS OWN AUTHOR CAUGHT IT** — the new join could match two batches
   in a month holding two runs of one cycle, doubling money in every consumer that sums groups.
5. **THE `payitem` BRANCH GATED THREE OF FOUR LISTS.** `overtimeLines`/`bonusLines` went through
   `payItemLinesReconcile`; `allowanceLines` did not, on the reasoning that it agrees by construction —
   precisely the claim OT/Bonus carried until `display_category` re-routed money between the box and the
   bucket. The ungated list was the one nobody re-checked.

**WHAT THE AGENTS GOT RIGHT, AND SHOULD BE COPIED:** `ad52212d` REFUSED to rename
`attendance-allowance-policy.status-changed` because its rows are already on production and that is a
separate decision about existing history; a build agent REFUSED to widen `test/pack-drift-allowlist.json`
because the guard's own message says the list only shrinks; `5ff7daff` verified its plan's "NO rebuild"
verdict against the tree before trusting it. **The loop was stopped after ONE fix round** — r123's lesson is
that adversarial critique does not converge — and the last two findings were fixed by hand.

⚠️ **A GUARD PINNED THE EXACT LINE THE FIX CHANGED** (`test/payroll-history-landing.test.ts` asserted the
literal `allowanceLines: [...byBucket.wage, ...byBucket.reimburse]`). Updated to pin BOTH halves — which
buckets feed the figure, and that they pass the reconcile gate — never deleted. Rule 18, third occurrence.

⚠️ **`scripts/reprocess-one-employment.ts` MADE THE GATE RED AND `git rm --cached` DID NOT FIX IT.** The
pack-drift ratchet scans the FILESYSTEM (`runImportRatchet`'s scan list includes `scripts`), not the index,
so an untracked file on disk still trips it — which also means this tree's payroll guard had been red since
whichever earlier session dropped the file there. It reached `main` via a `git add -A` in the r195 recovery
commit; removing it from the working TREE is what actually fixed it. **`git add -A` in a repo with a
tree-scanning guard is a loaded gun.**

## r195 (2026-08-17) — NOT OURS. RELEASED TO PRODUCTION BY SOMETHING OUTSIDE THIS REPO, THEN RECOVERED.

Recorded because it is the only entry here that no session in this repo produced, and because the recovery
is a procedure that will be needed again if it recurs.

`deploy-r195.log` on the box records a build at ~22:05; `0253dc7c`, `a6da1387` and `46afcc48` were marked
deployed at 22:09 with `build_ref = 004b098a`, **a commit that exists in no worktree here and in no other
clone on this machine**. The three build-started → build-completed → deployed triples land 1-2 seconds
apart, so nothing was built at that moment — they were *marked*. The local peer session confirmed it was not
them; `CronList` was empty; the launchd agent is notify-only. The WORK is real, and in this repo's idiom:
its comments cite the item ids they implement.

**RECOVERED INTO MAIN AS `6bd2d99d`** by taking production's copy of the 15 differing files, established by
a `--delete` dry-run rsync FROM mainwt: 2,668 entries of which 2,355 differ only by mtime, leaving 18
content differences — the 15, plus `HANDOFF.md` and two build artifacts, which were NOT copied back. All six
catalogues were verified strict supersets first (`prod-drops=0` for every locale), so nothing on main was
lost. Gated tsc 0 / `i18n-check` PASS / 36 tests green.

**WHY IT HAD TO HAPPEN BEFORE ANYTHING ELSE SHIPPED:** the deploy rsync carries `--delete`, so the next
release from main would have overwritten all three items with main's older copies and silently reverted
fixes the reporter had just received.

⚠️ **RUN THAT DRY RUN FROM `mainwt`, WITH `cd` IN THE SAME COMMAND.** The shell's cwd resets to the repo
ROOT (`local/root-scratch`, far behind main) between tool calls, and the same command from there reports
thousands of bogus differences and invents a crisis. It cost a full diagnostic pass here — the fourth time
the wrong-tree trap has landed.

## r186 (2026-08-12) — EIGHT APPROVED ITEMS, SHIPPED. Migrations `0428` + `0429`.

`e7eb5d83` · `74d00fd2` · `7c834696` · `af7a8eb4` · `b8aa3466` · `42afb2d2` · `2ec1e3d2`, plus the
pack-facade fix. 64 files, +5418/−1450. Gate **644 declared / 644 counted / every chunk exit=0 / 8,321
tests / 1 expected fail / 0 AssertionErrors / 0 timeouts**; tsc 0; `next build` 0; `gate:shadow` PASS
349/349; render check 0 MISSING_MESSAGE across 27 routes × 6 locales. Verified on production: 349
migrations, all six new columns and both CHECK constraints present, **shift rows 11 and payslips 84
UNCHANGED**, `GET /` 401, zero-change arrival dry-run.

⚠️ **`7c834696` REDUCED TWO NAMED EMPLOYEES' RECORDED OVERTIME BY 60 MINUTES EACH.** Production was
paying 120 minutes where 90 and 100 were worked, because rounding to the NEAREST 60 pushes a day past
its own band ceiling. The fix is `Math.round` → `Math.floor` — **not** "nearest then clamp", which returns
90 and contradicts the plan. Measured across all 63 clock-out days since 2026-08-04: exactly two figures
move, both down. The 14 `Standard`-rule rows are all exact multiples of 60 and are untouched.

⚠️ **ITS SCOPED RECOMPUTE IS DELIBERATELY NOT RUN.** The two stored rows keep their 120 until someone
recomputes **2026-08-05, employments 100814 and 100815 ONLY**. A wide recompute would rewrite 41
historical days against shift times that were reassigned mid-day on the 5th.

#### AN AGENT REFUSED TO BUILD, AND IT WAS RIGHT — a plan's stated order beat my file map
`b8aa3466`'s BUILD NOTES say verbatim "Build af7a8eb4 FIRST … building this item first would write the new
form inside `app/admin/attendance/page.tsx` and then move it wholesale, and would falsify af7a8eb4's
already-approved mockup". I had scheduled `af7a8eb4` LAST because it looked cross-cutting. The agent
stopped rather than build 4 of 9 sub-items that would have been rewritten. **Group by file overlap, but
read each plan for a declared dependency FIRST — the plan may state an order the file map does not.**

#### A MOCKUP IS A PROMISE, AND `af7a8eb4` DISCHARGED ITS OWN
The approved sketch says "the same content at full width … no new field, no new column, no renamed
heading, nothing removed", against a diff that **deletes 721 lines net**. Proof it was relocation: diff
the UNION of the old files against the UNION of the new ones — **19 POSTed form fields, identical set;
zero i18n keys removed.** Copy that technique for any "move, don't change" claim.

#### THE `off_day` ENUM THAT WAS NOT WIDENED, AND WHY THAT IS CORRECT
`b8aa3466`'s plan said add `off_day` to `DayType`. That widens a SHARED Postgres enum (`plan_ot` uses it
too), three TS types, the payroll OT policy allowlist and `core/payroll.ts`. **An Off day pays 1.5× hourly
under s.60A(3)(a) — exactly the workday leg** — so it ships as a workday with a zero-minute normal day.
Same money, no enum change, `core/payroll.ts` untouched. Asserted in ringgit AND by `day_type`, with a
Rest-day test proving Off did not swallow Rest.

#### THE HALF-DAY BUG THE MONEY TEST CAUGHT
Halving `scheduledMinutes` produced **zero** overtime: on a resolved shift the engine measures workday OT
as minutes past the shift's TIME-OUT, not as an overshoot of scheduled duration. A half day now ends
halfway through the span too. **Row shape would not have caught this; a generated payslip did.**

#### THE PACK RATCHET FIRED ONCE, AND THE ALLOWLIST WAS NOT THE FIX
`core/absence-days.ts` imported `core/attendance` directly so absence derivation and the engine resolve a
working day identically — right intent, wrong edge. Fixed by importing `packs/attendance/service`, which
that file **already** does for approved-leave dates. The guard refuses allowlist additions in its own
message: it only ever shrinks.


## r185 (2026-08-12) — SEVEN APPROVED ITEMS, SHIPPED. Migrations `0426` + `0427`.

`98e69987` · `f35f758a` · `2aed39d4` · `587ee719` · `4157a498` · `510f4bd1` · `009c8a37`.
74 files, +9046/−2075. Gate **638 files / 6 chunks / every chunk exit=0 / 8,216 tests / 1 expected fail /
0 AssertionErrors**; tsc 0; `next build` 0; `gate:shadow` PASS 347/347; render check 0 MISSING_MESSAGE
across 16 routes × 6 locales. All seven marked `deployed`.

**THE BOARD SAID `approved = 1` AND IT WAS ACTUALLY 8** — and by the time the round finished it was 16.
This file's own instruction ("Counts live in CURRENT STATE … **Always RE-COUNT**") is the only reason the
round was not planned around one item. It has now been wrong in this direction three times.

#### ⚠️ THE DEPLOY ORDER WAS NOT THE USUAL ONE, AND THE FAILURE IT AVOIDED LOOKS LIKE NOTHING YOU EXPECT

**`scripts/repair-fixed-transaction-overlaps.ts --apply` had to run BEFORE `0426`.** `deploy.sh` is what
runs `db:migrate`, and the repair script only reaches the box via the release rsync — so the release was
split: **rsync → repair → `deploy.sh` → zero-change dry-run**, not one `improve:release` call. Keep that
shape for any migration whose precondition is a data repair.

Production carried ONE inverted row (`valid_to` before `valid_from`). An inverted row does **not** raise an
exclusion conflict — `daterange()` raises `range lower bound must be less than or equal to range upper
bound` while merely BUILDING the index entry, so the `ALTER TABLE` aborts on an error mentioning neither
overlaps nor the constraint. **`gate:shadow` cannot catch this**: it dumps the live schema STRUCTURE ONLY,
no rows, so it passed 347/347 while production would have failed. A shadow PASS proves a migration is
well-formed, not that it will apply.

Applied outcome: 9 rows superseded (1 inverted + 8 overlapping), 52 → 43 live, payslips untouched at 84,
and **0 remaining overlapping pairs measured with the constraint's own predicate**. X000001 keeps the
150.00 written last, which does NOT match the 100.00 its July payslip paid — stated in the approved plan,
intended, not a defect.

#### THE `daterange` EXCLUDE IS NOW PROVEN, AND THE BOUNDS ARE LOAD-BEARING
Executed on **PostgreSQL 16.14, which is what production runs**, across eight probes:

    daterange('2026-01-01','2026-07-01','[]') && daterange('2026-07-01','9999-12-31','[]')  ->  true
    daterange('2026-01-01','2026-07-01','[)') && daterange('2026-07-01','9999-12-31','[)')  ->  false

`employment_pay_component.valid_to` is **INCLUSIVE**; `compensation.valid_to` is **EXCLUSIVE**. The two
precedents for this constraint shape (`0004`, `0117`) are both HALF-OPEN — **copy their shape, never their
bounds.** `COALESCE(valid_to, DATE '9999-12-31')` because `'[]'` cannot be applied to an infinite bound.
The same asymmetry bit twice: `overlapsClosedPeriod` was written for `compensation` and its `to` is
EXCLUSIVE, so it is called with `addDaysIso(validTo, 1)` or a row whose last paid month IS the closed month
walks past the guard.

#### THREE APPROVED PLANS WERE WRONG ABOUT THE TREE, AND THE BUILDS WERE RIGHT TO REFUSE THEM
A plan is a specification, not scripture. Each was reported, not silently followed or silently dropped.
1. **`2aed39d4` step 5 misread `test/fixed-transaction.test.ts:323`** — its two windows do not touch, so
   "gap is intended" still holds. The overlapping sibling was what changed.
2. **`2aed39d4` step 7 named `processedPeriodsTx`**, which returns processed-OR-closed and would have
   re-implemented the very rule the step exists to reverse. `closedPeriodsTx` is correct.
3. **`f35f758a` item 4 called a comment stale** that the SAME ROUND made true again.

#### ⚠️ A LINT RULE FIRING IDENTICALLY IN EVERY LOCALE IS EVIDENCE ABOUT THE LINT RULE
`scripts/i18n-check.mjs` flagged `payroll.historyImport.missingColumns`, diagnosed TWICE (by an agent and
by the parent relaying it) as a translated placeholder name that would throw `FORMATTING_ERROR`.
**Both diagnoses were wrong.** `{count, plural, one {column} other {columns}}` — `column` is a plural
BRANCH BODY, ordinary text, not an argument. The tell both missed: it fired in **all five** non-English
locales. Five translators do not make the same mistake; a checker does. Its regex cannot tell a branch body
from an argument name. Verified properly by FORMATTING all 786 messages in the namespace through
`intl-messageformat` with the arguments the call sites pass (0 failures) and parsing all 51,564 (0
unparseable). **Follow-up, not on the board: teach the checker to skip plural/select branch bodies.**

#### THE SIX CATALOGUES SURVIVED FIVE BRANCHES BECAUSE THE MERGE WAS AUDITED, NOT ASSUMED
Five branches edited all six files and **28 keys were deliberately DELETED**. This is the r138/r141 trap:
a naive recursive merge reads "present in theirs, absent in ours" as an addition and resurrects every
retired key. **PRESENCE IS A VALUE — consult the merge BASE for absence too.** Git's line-based merge did
handle it, but that was verified with a base-aware audit (RESURRECTED / LOST / CLOBBERED) against the base
and all five sides: **8549 → 8668 keys, zero problems**, union +127/−28 reconciling exactly, all 28
deletions confirmed absent BY NAME. Note agents' self-counts ran high — **a REWORDED key is not an
addition.** Tool kept at `scratchpad/check-catalog-merge.mjs`; worth promoting into the repo.

#### `i18n/request.ts` IGNORED next-intl's REQUESTED LOCALE — A WHOLE FEATURE WOULD HAVE SHIPPED SILENT
`getRequestConfig` took no arguments and read the cookie unconditionally, so `getTranslations({locale})`
resolved to the COOKIE's catalogue: HTTP 200, a valid PDF, wrong language, every gate green. Now honours
`requested`, falling back to the cookie. **Blast radius measured before accepting: exactly 1 of 269
`getTranslations` call sites passes an explicit locale.** Proven by decompressing both PDFs' content
streams — the override beats the cookie in BOTH directions and the row count holds at 52 across the swap.

#### VERIFY ON THE ARTEFACT, NOT ON THE LAYOUT MATHS
r175a's CP22 lesson applied to the new two-column payslip: rasterised in **both** `mutool` and `pdftoppm`
across five fixtures, row count read off the artefact (all 70 items present in both, `missing=0`), geometry
read back with `pdftotext -bbox`. **The plan's own pt budget was pessimistic** — it predicted a spill that
does not happen; its figures came from a re-implementation, as it warned.

#### TWO DEFECTS FOUND BY RENDERING THAT NO TEST HELD
`?txnStatus=processed` returned rows the same grid labelled *Pending reprocessing*; and a wholly-failed
month produced no row at all in the import preview. Related and worth keeping: **`cleanBatchStatus` FAILS
OPEN** — an unrecognised filter value returns `undefined`, which DROPS the filter and silently shows
everything.

#### DELIBERATE ASYMMETRIES A REVIEWER WILL QUESTION — ALL INTENDED
- **`2aed39d4`'s key excludes `run_type`** though the ticket asked for it: the kernel never reads it and
  pays every returned row in full, so including it would have LEGALISED 2 of the 10 live clashes.
- **`4157a498` never lets `Override?` overwrite an occupied month**, and reports `updated = 0` always.
  `loadBatchRows` selects every batch for a (company, period) with no `run_type` and no `status` filter and
  SUMs, so a second load would submit someone paid 5,000 as 10,000. There is no undo — `0011` blocks UPDATE
  and DELETE on a closed batch at trigger level.
- **`4157a498` folds on (Employee No, Payroll Period)**, not the five-part key — `payslip_batch_employment_uq`
  allows exactly one payslip per employment per batch.

#### c8052ae3 — STILL NOT RUN. THE PLAN'S BACKUP COMMAND DOES NOT WORK ON THIS DATABASE.
Step 0's `pg_dump "$U" -Fc -f …` **exits 1** and leaves an ~889 KB partial that looks like a backup and is
not: `ai_provider_config`, `leave_adjustment_batch` and `platform_user` are FORCE RLS, `ai_hr_owner` has
neither superuser nor BYPASSRLS, and there is no passwordless sudo to `postgres`. Taken instead 2026-08-11,
both verified with `pg_restore -l`: a broad dump with those three tables' DATA excluded (85.5 MB, 1954 TOC
entries) plus a targeted dump of `leave_ledger`, `leave_entitlement_recalc_audit` and
`leave_ledger_reset_archive`. **All three excluded tables hold 0 rows, so the broad dump is complete.**
**Correct step 0 before the next operator runs it.** The rehearsal on the box is from 08-10 and its plan
wants rehearsal and apply in ONE sitting — re-run it fresh.


## r180 (2026-08-10) — TWO DEFECT FIXES, BOTH DEPLOYED. One of them was paying people twice.

**1. RECURRING PAY ITEMS HAVE BEEN PAYING TWICE, AND IT REACHED ISSUED PAYSLIPS.** Found while planning
board item `2f889bae`, then verified independently on production.

`setEmploymentPayComponent` closed the prior row ON the new start date, and its comment claimed "so there
is no double-count". **`validTo` is INCLUSIVE for pay components** — the kernel selects
`validFrom <= periodEnd AND (validTo IS NULL OR validTo >= periodStart)` and pays each returned row its
FULL amount — so both rows sat in the month containing the change.

MEASURED ON PRODUCTION, not inferred: **four employments carry overlapping live rows**, two of them real
customer records (Eee Lee Yong / Fiamma, TEST0002 / ISEDECOR). **Aisyah Rahman's 2026-04, 2026-05 and
2026-07 payslips each read allowance 140.00 where a single row gives 120.00** — RM20 per month on three
issued slips. One row is structurally impossible (`valid_from 2026-01-31`, `valid_to 2026-01-06`); Postgres'
own `daterange` refuses to construct it, which is how it surfaced.

**THE ROOT CAUSE IS A SEMANTIC MISMATCH BETWEEN TWO TABLES THAT SHARE A WRITER SHAPE.** `core/comp.ts` does
the IDENTICAL close-at-`effectiveFrom`, and compensation is safe — because its kernel reads a single open
row and its `compensation_no_overlap` EXCLUDE constraint uses a HALF-OPEN daterange, i.e. `valid_to` is
EXCLUSIVE there. Same writer, opposite boundary semantics, opposite safety. **Do not "align" one to the
other without moving the reader that goes with it** — this is recorded at the call site.

**WHAT SHIPPED:** the prior row is closed the DAY BEFORE the new start; a restatement from the row's own
start date SUPERSEDES it rather than inverting the window; a backwards restatement is refused. Chosen over
flipping the kernel's `gte` to `gt`, which would silently change what every EXISTING end-dated row pays in
its final month.

⚠️ **THE FIX IS NECESSARY BUT NOT SUFFICIENT, AND THE SUITE SAYS SO.** A MID-MONTH restatement STILL pays
twice: the two windows are adjacent (`…-05-09` and `05-10-…`) but both overlap the month, and the kernel
pays full amount for any overlap. The first regression test written returned **1554 = 777 + 777**. It is
recorded as `it.fails` in `test/fixed-transaction.test.ts` — the same idiom this repo uses for the known
width no-op — so the gate goes RED when someone fixes it. **Fixing it is a DESIGN DECISION**: prorate a
partial window, take latest-row-wins per period, or refuse a mid-period restatement. Each changes what
correctly-dated rows pay today, so it belongs to the reporter, not to a patch.

**THREE EXISTING ASSERTIONS PINNED THE BUG** while calling it "no double-count"; they are corrected. The new
boundary test asserts the MONEY through a real payslip — the pre-existing "no double-count" test only ever
checked row shape and never generated a payslip, which is exactly how this shipped.

**NOT DONE, DELIBERATELY:** the data repair of the four employments and the overlap EXCLUDE constraint. Both
change customer records and sit in `2f889bae`'s pushed plan awaiting approval. The constraint CANNOT be
applied before the repair. **The uniqueness key is an open question** — the pending constraint is keyed on
employment + component, while board item `2aed39d4` asks for employee + pay item + PAYROLL CYCLE.

**THE REPORTER HAS INDEPENDENTLY REPORTED THE SAME DEFECT as `2aed39d4`** ("the system can create duplicated
Start Date / End Date / Payroll Cycle records ... incorrect payroll calculations"). They arrived from the UI,
we arrived from the data. Do not plan the work twice.

**CORRECTED MEASUREMENT:** the paid-item removal guard depends on payslips storing WHICH component produced
a line. This file used to cite 7 of 50 payslips (~14%). Re-measured 2026-08-10: **19 of 83 carry
`componentLines`**, and of the 24 live non-BASIC items a processed payslip covers, only 12 carry line
evidence — so the guard still refuses about half of what it should.

**2. THE PERSONNEL RECALC-REASON LABELS.** `people.detail.recalcReason.*` is a COMPUTED key, invisible to
i18n coverage check C. The page had a fallback that COULD NEVER FIRE: it compared the translated value
against the RELATIVE key while next-intl returns the FULLY-QUALIFIED path on a miss. Measured live:
**50 of 72 audit rows rendered a raw key path at the user**. Fixed with `t.has` (the house idiom —
`app/admin/scheduled-actions/page.tsx` does the same), so an unlabelled reason degrades to the raw word;
five missing labels added in all six catalogues. **It PREDATED r179** — the block is byte-identical at
`d51c8f4d`. `test/recalc-reason-labels.test.ts` pins both halves, strips comments before source assertions
(its own explanation quotes the broken expression), and deliberately does NOT claim to enumerate every
emitted reason: six catalogued reasons appear nowhere in source, so any static list is provably incomplete.


## r184 (2026-08-11) — THE PAYROLL REPROCESS PAIR, BUILT AND DEPLOYED

`fbcf706d` (add a period-eligible employee to a processed run without resetting it) and `7076f8af` (Reset
lands back in the run flow; the adjustments panel and CSV import move off the run screen). Built in ONE
worktree, sequentially, because they overlap `app/payroll/[batchId]/page.tsx`, `app/payroll/actions.ts`,
`core/payroll.ts` and all six catalogues — the file-overlap rule, not the theme rule.
Gate **637 files / 6 chunks / every chunk exit=0 / 8,121 tests**; tsc 0; `next build` clean; render-checked
on a seeded dev server with zero MISSING_MESSAGE; deployed and proved by a zero-change dry-run.
**NO MIGRATION — `0426` is still free.**

**THE VERIFY-BEFORE-BUILDING GATE IS WHY THIS WORKED, AND IT SHOULD BE COPIED.** The plan's load-bearing
claim — that the subset path inserts a correct payslip for an employment with no payslip — was derived by
READING the engine and had never been executed: **0 of 123 production result-history rows had a null
`version_before`.** The build was gated on proving it first, with an explicit instruction to STOP and
re-plan if it failed. It held (gross 4000.00 at version 1, batch totals moved by the addition alone, the
already-paid payslip byte-identical), and measuring it turned three PREDICTED gaps into MEASURED ones:
`employee_count` stayed 1, the audit row rendered a phantom 0.00→4000 rise, and the no-salary case failed
closed with a misleading message. A premise that has never executed in production is a hypothesis; test it
before you build a screen on it.

**TWO MONEY GUARDS WERE ADDED BEYOND THE PLAN, AND THAT WAS RIGHT.** Item 5's scope bypass makes two
previously UNREACHABLE double-payment paths reachable: a claim allowance already written into
`payroll_input` by the draft-only prefill would be paid from the added payslip AND left payable on the next
run. Both now fail closed with a truthful message. **The claim mark-paid on a subset is deliberately
STRICTER than the full path** — the full generation infers "got a payslip therefore was disbursed" because
prefill and generation are one workflow; an add is not that workflow, so the requeue arm is not present on
a subset at all. A reviewer will notice the asymmetry; it is deliberate.

**`applyLoansForBatch` gained an OPTIONAL 5th parameter.** Omitted ⇒ byte-identical for the sole existing
caller. An empty array means "nobody" and returns early rather than widening to "all" — the difference
between those two readings is a double loan advance.

**THE PANEL WAS MOVED, NOT DELETED, and the board point was honoured BY PATH.** It is the only route by
which approved overtime, claims, loan instalments, shift differential, zakat, TP1 relief and attendance
allowances reach a payslip. Deleting it would leave approved amounts with no path to anyone's pay, silently.
`test/tp1-relief-reaches-payroll.test.ts` went red on all six bridges the moment the panel left the run
screen — it exists because `prefillTp1Action` once shipped bound to no form — and it was MOVED AND
STRENGTHENED, not relaxed. Seven prefill actions gained a `returnTo` because they hard-redirected to the
very screen this item removes from the path.


## r178 (2026-08-10) — plans-only round, superseded

Every plan it pushed has since been approved, built or re-planned. Kept for its DECISIONS.

### r178 (2026-08-10) — FIVE PLANS PUSHED, ZERO CODE. Nothing to deploy, nothing to gate.

**Deliberately a plans-only round** (owner's decision): r177 stays held, and `release.ts:71` rsyncs the
WHOLE worktree with `--delete` then runs `db:migrate`, so ANY deploy from `main` ships the anomaly layer
and applies `0425`. There is no per-file deploy. **The tempting workaround is the dangerous one:**
branching new work from `75addd1b` and shipping that is the ONE option that can silently break r177 — that
branch's journal has 344 entries, so a `0426` above `0425`'s `when` moves the watermark past `0425` and its
three tables are then NEVER created on any later deploy. Deploying from `main` cannot skip `0425`; branching
from production's ref can.

**Pushed, each with a mockup, all awaiting the reporter:** `b00f9e6e` rev 2 · `c8052ae3` rev 2 ·
`388e53c2` · `98e69987` · `f35f758a`. No branch, no merge, no migration allocated, graph unchanged.

**Decisions this round, so they are not re-litigated:**
- **`b00f9e6e`'s approved plan was NOT built and must not be** — its premise died (see the `OT1_5` entry
  above). Only the defensive seeder guard survives, and it is hygiene, not a deliverable: nothing invokes
  the script, and a `formula` reference is already refused at `core/pay-components.ts:1040`.
- **`c8052ae3` needs no build** — the code all shipped; it needs the operator run (see above).
- **`388e53c2` IS A NAVIGATION MOVE, NOT A REDESIGN.** The reporter's screenshot shows the three screens
  ALREADY full-width with a top filter row; they drew an arrow from the left nav rail to Team Leave Tracker.
  Taken literally the ask deletes `/leave/tracker`'s calendar, which is deliberately ungated for EVERY
  employee and is the target of the manager dashboard card and a Personnel deep link. Planned as: calendar
  stays for non-admins, three HR sections appear there for admins only, routes unchanged.
- **`98e69987` / `f35f758a` carry a REPORTER CONTRADICTION, now raised to them.** They previously asked for
  the left employee panel to EXIST on these screens (`f3ae3245`, `ec845c7d`, both `deployed` — quotes
  verified on production) and now ask for no permanent side panel. Planned as: change only the screen each
  item names, leave the neighbours alone.
- **`f35f758a`'s real defect is NOT what was reported.** Amounts are already right-aligned, currency already
  consistent, YTD already printed, the logo stack already complete (1 of 14 companies has uploaded one), and
  the document is TWO columns, never three. What is actually broken is that `fit()`
  (`lib/payslip-pdf.ts:384-390`) is a hard clip — long text is TRUNCATED WITH "…", not wrapped.

**The trap that cost this round the most, worth keeping:** `employment_pay_component` was the wrong table
to check for "has anyone been paid from this item" — one-off `payroll_individual_txn` rows are invisible to
it, and a plan was approved on the strength of that omission.

## 42afb2d2 — the roster supervisor question (narrative; the durable finding stays in HANDOFF)

### `42afb2d2` IS NOW ANSWERABLE — and the reason it sat for a day is worth keeping

**An item raised with `improve:raise` lands as `open` with `plan_revision = 0`, and an item with NO PLAN
has no approve or reject button.** `42afb2d2` carried its recommendation and its alternative inside its
DESCRIPTION fields, where the reporter could do nothing with them. An earlier note here said it "needs an
ANSWER, not a plan" — that is backwards, and it is why it sat. **Giving a raised question a PLAN is how the
reporter answers it**: approve = leave it as it stands, reject-with-reason = do the other thing. r178
pushed that plan; it is now `planned`. Apply the same reading to `2ec1e3d2`.

⚠️ **VERIFIED THIS ROUND, AND THE ITEM'S OWN TEXT OVERSTATED IT: the roster refusal is real for
INSERT/UPDATE and NOT enforced by the database for DELETE.** `roster_assignment_rls` is a `FOR ALL` policy,
so `WITH CHECK` (`can_admin_employment`) governs INSERT and the new row of UPDATE, while DELETE is governed
by `USING` alone (`can_see_employment`) — which a supervisor, and the employee themselves, both pass. Only
the application guard `assertRosterAdmin` stops `clearRoster`. The INSERT/UPDATE half WAS measured on
production (a rolled-back transaction raised `42501` on a tomorrow-dated row for a real direct report); the
DELETE half rests on the policy text plus documented PostgreSQL semantics, because the classifier blocked
firing even a rolled-back DELETE. **No live exposure — the app guard covers it — but "the database decides
who may change the roster" is only true for two of the three verbs, and any widening must split the policy
or the two answers stay different.**

⚠️ **WE OWE THE REPORTER AN ANSWER WE HAVE ALREADY ASKED FOR: `42afb2d2`.** `23390097`'s approved plan
promised "from 10/08 onwards a supervisor can change them too". That was never achievable — writing
`roster_assignment` requires an hr_admin/super_admin grant, and a manager session is refused by RLS
with 42501 (measured). What SHIPPED is the honest version: supervisors get the whole month read-only
with filters and download, no controls that would fail. The decision — leave it view-only, or widen
the permission so a supervisor may roster their own reports — is the reporter's, and it is raised.
**Do not "fix" this in code before they answer.**

**`scripts/reset-medical-hospitalization-ledger.ts` IS DEPLOYED AND HAS STILL NEVER RUN.** Report-only
without `--apply`; `deploy.sh` does not invoke it (verified). Re-measured 2026-08-10 and UNCHANGED from the
2026-08-09 census — 147 ledger rows, 22 recalc-audit rows, `leave_ledger_reset_archive` at 0 rows, and all
safety conditions (debits, request-sourced rows, approved requests, encashment snapshots, toil refs) at
ZERO. **This is the last unfinished part of `c8052ae3`:** the reporter was promised Medical and
Hospitalization read 0.00, and until this runs they do not — which is exactly why they CONTESTED it. The
archive→verify→delete sequence has never executed end to end.

⚠️ **`c8052ae3` IS APPROVED AND HALF-EXECUTED — THE BACKUP AND THE REHEARSAL ARE DONE, `--apply` IS NOT.**
On 2026-08-10 the reporter approved revision 2, and the operator run was taken as far as it can go without
destroying data:
- **Backups on the box, VERIFIED** — `/home/ubuntu/c8052ae3-affected-tables-2026-08-10-1238.dump` (all
  three affected tables WITH data, confirmed by `pg_restore -l`) and
  `c8052ae3-full-except-forcerls-2026-08-10-1238.dump`. **A plain full `pg_dump` FAILS with exit 1** on
  `ai_provider_config`: three tables carry FORCE RLS (`ai_provider_config`, `platform_user`,
  `leave_adjustment_batch`) and even the owner cannot read them, so pg_dump refuses — it still leaves a
  truncated file that LOOKS like a backup. Exclude their DATA (`--exclude-table-data`) or dump by table.
- **Rehearsal exit=0 and EXACT** — HOSPITALIZATION 77 rows/25 employees/300.00 days; SICK 70/23/6.00;
  147 ledger; 22 recalc-audit; all four must-be-zero guards at 0; "Nothing was written".
- **`--apply` WAS BLOCKED BY THE PERMISSION CLASSIFIER and was NOT worked around.** It needs a human or an
  allow rule. Command: `cd /opt/ai-hr && PATH=/opt/node20/bin:$PATH node --env-file=.env.production
  --import tsx scripts/reset-medical-hospitalization-ledger.ts --apply`.
- **Afterwards: verify in SQL, then RENDER the archive screen** — its populated branch has never rendered
  outside tests and cannot until the rows move.
- **A counting trap worth keeping:** `leave_entitlement_recalc_audit` holds 72 rows for the tenant but only
  **22 in scope** (16 HOSPITALIZATION + 6 SICK); the other 50 belong to a third leave type. And do not
  filter shell output with a case-insensitive `LC_` pattern — it matches `reca`**`lc_`**`audit` and silently
  deletes every line naming that table, which made a present table look absent for several minutes.

**The calculation half of `c8052ae3` IS done and IS live** — `c4139b4d` is an ancestor of `main` and
production's `core/leave.ts` is byte-identical (md5 `3c64d99…` both sides); the current-year bound is
`leaveCycleEnd()` at `core/leave.ts:6328`. Revision 2 of the plan is pushed and awaiting the reporter; on
approval the whole remaining job is an OPERATOR RUN ON THE BOX (`pg_dump` → rehearsal → `--apply` → SQL
verify → **render the archive screen**, whose populated branch has never rendered outside tests) and
**needs NO deploy**.

⚠️ **A KNOWN, ACCEPTED DEFECT IN THAT RUN (owner's decision, r178).** Migration `0416`'s capture function
annotates future-dated rows with **strictly `>`** `2027-01-01`, so the **30 rows dated exactly 2027-01-01 —
precisely the grants the reporter complained about — capture with a NULL note**, while the 2028 rows nobody
reported get labelled. `test/leave-ledger-reset-archive.test.ts` seeds `2028-01-01` and sits on the passing
side of the boundary, so no test catches it. **It cannot be corrected after the run** (the note is computed
during the capture INSERT and the source rows are deleted in the same transaction). It is ACCEPTED because
`effective_on_text` is archived on every row, so the record is complete and only the convenience label is
missing. **Fix the predicate to `>=` in a later migration** — it is not allocated yet.

⚠️ **`HANDOFF.md` IS ITSELF RSYNCED TO THE BOX**, so editing it makes the dry-run report one changed
file — indistinguishable from an undeployed release. The dry-run also permanently reports
`next-env.d.ts`: gitignored and Next-generated, local `pnpm dev` writes the `.next/dev/types/` variant
while the box's build writes `.next/types/`. The box's version is correct. Those two lines are noise;
anything else is a real delta.

---

## r177 + r179 + r180 — SHIPPED 2026-08-10 (deployed together, main@34cc8137)

r177 was held for a week and released on the owner's command alongside r179. `0425` applied 344 -> 345
after a shadow rehearsal PASS. r179 carried four approved board items plus a shared employee search field
and the sidebar highlight fix. r180 followed with two defect fixes (see the HANDOFF entry for r180).

The two sections below are the in-flight entries as they stood while the work was held, kept verbatim
because their DECISIONS are the part that cannot be reconstructed from the diff.

### ⚠️ r177 — ADR-0076 IS BUILT, GATED AND **DELIBERATELY NOT DEPLOYED**

**`main@7eff1b87` carries the whole payroll anomaly layer — the ADR-0074 control-tower keystone — and it
is HELD at the owner's explicit instruction: "build to completion and testing, then build the guide, and
stop there to wait for my command to deploy."** Do not deploy it without that command. Everything else
(non-control-tower work) deploys automatically as usual.

**It is ready.** Gate: **630 files across 6 chunks, every chunk exit=0**; tsc 0; `next build` clean;
**shadow rehearsal PASS, 344 → 345** against a live-shaped schema. Render-checked on a dev server in all
six locales, empty AND populated, with zero MISSING_MESSAGE / IntlError / RSC errors.

**MIGRATION `0425` IS THE ONLY SCHEMA CHANGE** — three tables (`payroll_anomaly_verdict` / `_finding` /
`_config`), RLS + GRANTs on all three. Production is still on 344, so the deploy will apply exactly one.

**What it does:** `evaluateBatchAnomalies` reads a processed batch's payslips and writes a verdict per
employee (auto_clear / review / block) from 11 PURE detectors — 8 needing no history, 3 prior-period ones
that self-disable on cycle one and are recorded as SKIPPED WITH A REASON. `closeBatch` refuses while
unresolved `block` verdicts stand. A run-level circuit breaker catches the global mis-key that every
per-employee detector is blind to. Queue at `/payroll/<batch>/anomalies`; nightly sweep
`scripts/anomaly-sweep.ts` (`anomaly.sweep`, 02:30, crontab documented in DEPLOY.md).

**THE THREE THINGS TO KNOW BEFORE TOUCHING IT:**
1. **It is read-only with respect to money.** It never mutates a payslip, a batch total or a statutory
   figure, and no LLM is involved in any classification. Pinned by a test asserting the payslip rows are
   byte-identical before and after an evaluation.
2. **Both guards are ADDITIVE.** A batch with no verdict rows closes exactly as it does today — pinned by
   its own test. The circuit breaker needed an explicit `anomalyEvaluated()` gate to earn that, because
   unlike the per-employee guard it is RECOMPUTED and would otherwise fire on batches predating the layer.
3. **The thresholds are UNTUNED PLACEHOLDERS** (30% / 15%), labelled as such in code and in the guide.
   ADR-0076 §6 is blunt that only real history or a shadow run gives defensible numbers. **Never quote an
   auto-clear rate from the synthetic harness** — it proves the detectors work, nothing about thresholds.

**Deliverable for the owner:** an operator guide PDF ("Payroll exception checking — how to use it"),
written for the person who runs payroll, covering the daily rhythm, the four metrics (and why coverage is
read first), all 11 checks, the three resolution buttons, threshold tuning, and an explicit section on
what the layer does NOT do.

**The board, RE-COUNTED ON THE BOX after r179: `deployed = 633` · `cancelled = 14` · `approved = 5` ·
`planned = 1` · `open = 1` · `contested = 0`.** The reporter approved FIVE of r178's six plans within
hours. **Four of the five are BUILT — see r179 below; the fifth (`c8052ae3`) needs no build, it needs an
operator run.** `planned = 1` is `42afb2d2` (the roster question, finally answerable — see below).
`open = 1` is **`2ec1e3d2`**, which WE raised: the Roster screen shows every viewer a "Manage shift
schedules" link to an administrators-only screen, and the `42afb2d2` plan promised in writing that we would
raise it separately. Re-count rather than trusting this line.

### ⚠️ r179 (2026-08-10) — FOUR APPROVED ITEMS BUILT AND GATED, **DELIBERATELY NOT MERGED TO `main`**

**`build/r179-integration@c63d5064`** carries all four items the reporter approved after r178's plans:
`b00f9e6e` (overtime seeder guard) · `388e53c2` (leave nav move) · `98e69987` (Transaction Detail) ·
`f35f758a` (Individual Payslip screen + document), plus a shared employee search field and the sidebar
highlight fix. **NO MIGRATION — `0426` is still free.**

**IT IS LEFT ON ITS BRANCH ON PURPOSE.** `main` today is exactly `production + r177`, a single clean delta
the dry-run rsync can confirm at a glance. Merging r179 would make that two releases while deploy is
blocked, and buys nothing. **A branch is also MORE discoverable than a silent main merge** — the
unshipped-round check (`git for-each-ref refs/heads/build`) finds it, which is precisely the check r159
proved does NOT find merged-but-undeployed work. Merge it when r177 is released, not before.

**Gate: 633 files across 6 chunks, every chunk exit=0, 8,046 tests** (106+106+106+105+105+105 — counted
files equal files asked, peak disk 30–48%); `tsc` 0; `next build` clean, all r179 routes present and `ƒ`.

**RENDER-CHECKED FOR REAL** (four identities, ten renders, dev-server log read): zero MISSING_MESSAGE,
IntlError or FORMATTING_ERROR. **The access-critical branch is verified by RENDER, not by test alone:** on
`/leave/tracker` an hr_admin gets the Employee Details listing (`name="edQ"` present, calendar absent) and
a manager and a plain employee both still get the calendar (`edQ` absent, calendar present). On `/leave`,
an unlinked admin gets no balance card while an employee and a manager do.
**METHOD NOTE, because the obvious check is a lie here:** grepping rendered HTML for a LABEL proves
nothing — Next embeds the whole i18n catalogue in every payload (a ~563KB floor on these pages), so
"Employee Details" appears on a plain employee's page whether or not it rendered. Discriminate on FORM
CONTROL NAMES and payload deltas, which cannot appear from the catalogue.

**What the agents found that the plans did not:**
- **`b00f9e6e` was mutation-tested, and the obvious test does not pin what matters.** An archived
  *per_hour* reference reaches the archived throw from either side of the ordering, so the natural test
  stays green if the throw is moved. Only an archived reference that ALSO lacks an hourly rate
  distinguishes the two placements; that case exists now. Also confirmed by mutation that the pre-fix
  behaviour is a SILENT SUCCESS (it creates OT2_0/OT3_0 scaled off a switched-off rate), not a mislabelled
  error.
- **`f35f758a`: fixing the truncation with greedy word-wrapping ALONE would have shipped the same bug
  silently.** A single token wider than its column emits as one over-wide line that overprints the amount.
  Character-level breaking was added, and the result was rasterised in BOTH `mutool` and `pdftoppm` across
  three fixtures (43 deliberately over-long pay item names, long employee/department/company names) —
  the r175a two-renderer rule, applied.
- **The round brief's own guard premise was wrong on `98e69987`**, and the agent caught it:
  `test/employee-scope-panel-guard.test.ts` had NO transaction-view case to rewrite. Five were ADDED and
  then PROVED to bite by restoring the pre-change page from a `cp` backup (3 of 5 fail against it).
- **`388e53c2`'s sidebar highlight — the reporter's ORIGINAL complaint — could not be fixed from inside the
  leave lane and was correctly held back with a written spec rather than reached for.** It is now landed
  solo: `exactHref` / `ownedSubpaths` on `NavChildDescriptor`, read by an EXPORTED `isNavRowActive` so the
  truth table drives the real predicate rather than a copy that would pass on day one and drift.
  Mutation-verified. The held-back agent deliberately did NOT pin the wrong behaviour — which is why the
  table could be written as the CORRECT one.

**Two environment traps this round, both cheap and both cost time:**
1. **A FRESH WORKTREE HAS `node_modules` BUT NO `.env.local`** (it is gitignored), and `global-setup` loads
   it from cwd. The failure is actively misleading: vitest prints `No test files found, exiting with code 1`
   with the real cause (`TEST_MIGRATION_DATABASE_URL must be set`) buried below. Copy `mainwt/.env.local`
   into every new worktree at creation.
2. **A RAM-DISK CLUSTER DOES NOT SURVIVE A REBOOT** — the symlink dangles and `psql` reports the server is
   not running. That is not a wedge; run `./scripts/dev-db-rebuild.sh`. Also: a between-chunk rebuild makes
   the cluster briefly unreachable, so a liveness probe during `gate-chunked.sh` can read as "server down"
   when the gate is perfectly healthy. Read the per-chunk log, not the socket.

---

# Handoff round history — ai-hr

Archive of SHIPPED round entries, newest first. The living handoff is `../HANDOFF.md` — it holds the
current state and the entry for any round still in flight; when a round ships, its entry moves to the
top of this file.

## r176 — ADR-0077 slices 6 and 9 (shipped 2026-08-10, main@75addd1b, 344 migrations, NO migration)

**Slice 6 — the jurisdiction sweep and the mixed-currency refusal.**
- `core/report-registry.ts`: the currency-mix check now considers only rows that CONTRIBUTE a money
  value. It previously read the currency of every row in the set, so a row carrying no figure at all
  could push a summary into "mixed currency" and refuse to total. Narrowed to
  `moneyCols = setIds.filter(type === 'currency')`, then `contributing = rows.filter(hasValue)`.
- `core/reporting.ts`: new `eaEmployerCountry()`. `employeeEaStatements` built every EA form against the
  TENANT's country; in a multi-country group the forms for a foreign entity were produced against the
  wrong statutory pack. Each form now resolves its pack from its own employer via a
  `Map<companyId, country>`.
- Pinned by `test/report-summary-mixed-currency.test.ts` and `test/ea-per-employer-pack.test.ts`.
- **NOT shipped, still needs the owner:** the deploy-failing flip (unclassifiable company: warning →
  failed deploy). It changes whether a deploy is allowed to proceed, so it wants an explicit decision.

**Slice 9 — `closureDecision` finally has a caller.** `scripts/close-tenant.ts`. The decision function,
its dual control and its retention check had existed since 0350 with ZERO callers — logic and schema
with no operator entry point. **Decision: the script validates `--today`.** `closureDecision` takes the
current date as a parameter, so an operator passing an arbitrary `--today` could step straight past the
retention hold that the decision exists to enforce — the guard exists because the parameter is the hole.
Report-only until `--apply`, matching `reactivate-tenant.ts`. Pinned by
`test/tenant-closure-runner.test.ts`.

**Carried in the same release:**
- `test/partial-leave-cancellation.test.ts` — a TIME BOMB, untouched since r79, that went off mid-session.
  Three tests hardcoded a 10–12 Aug 2026 leave window; on 2026-08-10 the cancellation gate
  (`d <= today`) correctly refused the very dates they cancel. **Decision: pin the clock, do not move the
  window.** Deriving the fixtures from `todayInKualaLumpur()` was tried first and took it from 3 failures
  to 16 — the file carries ~100 assertions against those literal dates. Passing `today: '2026-08-01'` at
  the three unpinned call sites moves one variable instead of a hundred, and matches what every other
  clock-sensitive test in the file already did.
- `scripts/dev-db-rebuild.sh` — WAL sizing, dev-only. **Four gates died before the cause was found**;
  the durable lessons are in HANDOFF.md → Environment, not repeated here. Short version: `min_wal_size`
  was set ABOVE `max_wal_size` (Postgres accepts it silently — pacing reads max, retention reads min),
  the RAM disk and the SSD need OPPOSITE tuning, and no setting substitutes for `CHUNKS=6`.

**Gate:** 627 files green across 6 chunks, every chunk exit=0; tsc 0; `next build` clean. **Deploy
verified** 02:42:19 — service `active`, `.next` rebuilt, `GET /` 401, ready in 154ms, clean journal.

## r175 — nine more items across three waves (shipped 2026-08-09, main@fd53ca64, 344 migrations)

After r174's eight, the board refilled twice in one day: `d3a9383c` CP22 · `e6a144d4` movement export ·
`0fcb2557` payroll export · `18504ca6` shift effective date (`0421`) · `23390097` roster grid ·
`e2632276` absence deduction (`0422`) · `1c1b321a` recompute · `db46d9a2` CP22 month batch ·
`1e9145d4` Plan OT (`0424`). Fourteen items deployed in the day.

**THE GROUPING WAS FORCED BY ONE FILE.** `core/attendance.ts` is touched by four of the six late items,
so they ran in FUNCTION-OWNED LANES rather than in parallel by theme, with `components/attendance-tabs.tsx`
assigned outright to `1c1b321a` and Plan OT told its row belongs in the My Attendance nav instead. Every
verifier checked lane discipline explicitly; every lane held.

**THE REGISTRY PROCESS FROM r174 WORKED.** Two builders added a `requireAdmin` page, neither touched
`lib/permissions.ts`, and both declared it in integrator notes — the integrator registered
`/roster/import` and `/attendance/recompute` on the existing admin screen, plus `attendance-recompute`
and `roster-assignment` in `AGGREGATE_MODULE`. Note the entry cannot land BEFORE the page: the test
fails both ways, which is exactly why declaring beats editing.

**Decisions.**

- **`e2632276` is not a pay code, and saying so was the item.** The deduction the reporter asked for
  already ran, before EPF/SOCSO/EIS/PCB; a pay code would have deducted a SECOND time and after the
  statutory contributions. The plan named the existing lines instead. Its verifier then caught the
  feature ESCAPING ITS OWN OFF-SWITCH: `attendanceMonthSummary` changed for all nine companies un-gated
  in six ways and fed attendance-allowance qualification — money, on a feature the reporter was told
  ships switched off. Fixed, and 0 policies carry the flag on production.
- **A payslip that did not add up.** The named absence lines assumed they were always a subset of
  `otherDeductions` "by construction". Under a `carry_forward` negative-net policy they are not, and an
  "Absent 12,600.00" line printed inside a 6,000.00 deductions block. The split now refuses to carve out
  more than its column holds and falls back to the single lumped row.
- **Day type belongs in the recompute pay-run interlock.** A rest day re-decided as a public holiday
  moved `ot20`→`ot30` on an already-processed run with worked and OT minutes both unchanged — so the
  minutes-only predicate raised nothing. That is the exact silent difference the interlock exists to
  prevent, and recomputing after a holiday is recorded is the normal path, not an edge case.
- **`1c1b321a` needed `18504ca6` first**, and the order was enforced: without the date-aware
  `scheduleFor`, a recompute of an older day resolves the employee's CURRENT shift — right for a
  corrected shift, wrong for a moved employee.
- **A false sentence shown to every employee.** Plan OT's form rendered "You already have an approved
  overtime plan for this date… withdraw the first" unconditionally, with no query behind it. The mockup
  drew it as a conditional refusal; the real one already came through the error banner with the date.
- **`23390097`'s supervisor promise was undeliverable and is now the reporter's decision**, raised as
  `42afb2d2` rather than patched or silently dropped.
- **`db46d9a2` shipped with a correction the reporter accepted.** Manual CP22 filing has not been
  accepted since 1 September 2024 (e-CP22 on MyTax only), so the batch is a keying aid and an internal
  record, not a filing — and the plan we had already shipped said otherwise. They approved it on the
  corrected terms. The batch was verified by opening it: 132 fields = 4 pages x 33, distinct joiners per
  page, unflattened, LHDN artwork hash unchanged, "Download For Submission" absent from the tree.

## r175a — d3a9383c, the CP22 fillable form (shipped 2026-08-09, main@2449b0f6, 341 migrations, none of its own)

The first item of a new cycle: seven open items were planned and pushed with mockups, the reporter
approved CP22 within minutes, and it was built, gated and deployed the same day. No migration — the
operator's typed answers live in their downloaded file, not our database.

**WHAT SHIPS.** Each new-hire row on the LHDN compliance worklist gains a Download CP22 button; the
shelf row says "Open worklist" (via its own action key, so no other row's wording moved) and offers a
blank fillable copy. What downloads is LHDN's official Pin. 1/2020 page, unaltered — sha256
`5b516429e896…`, byte-identical to the reporter's own upload and verified again on the box after
deploy — with 33 AcroForm boxes overlaid: 26 pre-filled, 7 empty, all 33 editable, never flattened.

**THE COORDINATE MAP IS DATA, NOT A GUESS.** Derived by reducing the template's 947 thin filled `re`
operators to 80 horizontal and 150 vertical lines and reading the enclosing DRAWN CELL for each entry
area — so the comb rows land ON the printed character cells rather than near them. The derivation
script was a throwaway; `lib/cp22-fields.ts` is the reviewed artefact, and its test pins every rect
inside the MediaBox with zero overlap, which turns the visual QA into an assertion.

**THE COUNT IS 33 AND THE DIFFERENCE IS ONE FIELD.** Counting by eye gives 32; the employee telephone
is TWO combed fields flanking a printed dash, because one field spanning the pair would cover the dash.

**Decisions.**

- **Never invent a value on a statutory form.** The 7 unfillable boxes render empty and editable. The
  plan specifically warned that `employeeDependent.companyName` is the SPOUSE's employer and must not
  feed "previous employer in Malaysia"; the verifier confirmed those columns appear in the diff only in
  comments and in a fixture asserting they are NOT used.
- **A fourth allowance is FOLDED into the last ruled row** (`Phone - RM 50.00; Meal - RM 75.00`) rather
  than dropped. The reporter's mockup showed one allowance per row, so this is a presentational
  compromise they have not seen — it loses nothing, and it was called out in the round note.
- **A non-Latin legal name degrades to `?`.** Helvetica is WinAnsi and `updateFieldAppearances` throws
  outside it, so the guard narrows rather than fails the render — same posture as `lib/ea-pdf.ts` and
  ADR-0036. The box stays editable. Unlike an EA this form is filed externally, so embedding a Unicode
  font is the follow-up worth doing.
- **The bundled PDF is a new kind of asset** (public/ held five svgs). It is reachable at
  `/forms/cp22-pin-1-2020.pdf`, and middleware's matcher was checked: the SHARE_PASSWORD gate covers it.

**THE DEFECT THAT NEARLY SHIPPED, and how it was caught — full trap in HANDOFF.md.** Multi-row blocks
silently dropped any line past the third, and sliced the descenders off the third. Both were found by
RENDERING, in two engines that disagree, after 81 green tests said otherwise. The fix fits the value to
the block's row count and extends each rect downward for descender headroom.

## r174 round 2 — 1fff489c locations, solo against the settled tree (shipped 2026-08-09, main@4342a51c, 341 migrations)

`1fff489c` Locations / clocking geofencing / branch-based assignment, both phases, migrations `0419`
and `0420`. Held back from round 1 on purpose: it touches `core/attendance.ts`, `app/admin/actions.ts`
and the personnel page, all three of which round 1 changed, so it ran SOLO and LAST.

**THE SAME DEFECT SHIPPED TWICE IN ONE ROUND, IN DIFFERENT FILES.** The "Add a clocking point" link
pre-selects a location via `?addPoint=`, but the create form's `<select>` is UNCONTROLLED
(`defaultValue`, no `value`) and the link is a next/link SOFT navigation to the same route — so React
reuses the form at the same tree position and never re-applies `defaultValue`. It worked only after a
hard reload. This is exactly `ee6b7c69`'s entitlement-bands-editor defect (`4a1abc4a`) in another
guise. The verifier proved it against react-dom's own update path and found that EVERY other
searchParams-driven form in the repo already carries a `key` (`/admin/attendance`,
`pay-components/new`, `payroll-cycle`, `claims`) — this was the only one missing the convention.
**A soft-navigated form whose fields are uncontrolled needs `key={param ?? 'new'}`. Treat that as the
house rule, not as a fix for two specific screens.**

**Decisions.**

- **A raw drizzle error was reaching the admin's error banner** — `Failed query: update "location" set
  "code" = $1 ... params: TWO,Two,MY,,BUKIT JALIL,...`, i.e. SQL and parameter values shown to a user.
  Pre-existing behaviour for a duplicate Code, but the new Branch dropdown made it far likelier. Closed
  with a constraint-name-specific 23505 catch following `shiftUniqueError`. **The recovery read that
  resolves the conflicting location's code runs in a SECOND transaction and is now wrapped** — if it
  threw, the raw error replaced the typed one and re-opened the very defect the catch exists to close.
- **`resolveGeofence` was genuinely rewritten, not column-moved.** "Pass if ANY assigned active site
  has distance <= its own effective radius", nearest computed only for the error payload. The old rule
  compared one employee radius against the nearest site, so a 400 m site with a 500 m radius failed
  whenever a 300 m site with a 100 m radius was nearer. Effective radius = employment override ?? the
  site's own; a site with neither fails closed. `employment_geofence_radius_required` is dropped so the
  override may be blank while geofencing is on.
- **A test that did not test what its name claimed.** "a duplicate CODE is the OTHER constraint, told
  apart by name" set no branch, so the `n.branch &&` guard short-circuited before the constraint name
  was consulted — it would have passed with the regex deleted. Replaced with the case where both arms
  are live. **Watched-fail verified.** A second test written during the same fix claimed to race the
  recovery-read window and did not; it was deleted and the gap recorded rather than faked, because that
  path is not producible from the public surface (archiving the holder frees the branch, so no 23505).
- **NOT BUILT, as the plan told the reporter:** phase 3's map pin picker (no tile provider on the box),
  the Wi-Fi SSID/BSSID whitelist (no browser exposes SSID to page JavaScript, so the control would
  enforce nothing) and device-type restriction (`clock_method` is only web and import).

**A LATENT FLAKE COST ONE GATE AND IS NOW FIXED.** `test/tp1-self-relief.test.ts` asserted the PDPA
guarantee by substring-searching a blob of EVERY tenant event for the amount `7654`. Payloads carry
random UUIDs, UUIDs are hex, hex contains every decimal digit — `companyId` came back as
`907524b4-...-b4c0f7765446`. The file was untouched since 2026-07-06 and passed 3/3 on re-run. Now
compares leaf VALUES, with a substring scan kept only for non-UUID-shaped leaves. Watched-fail
verified: leaking `categories` into the payload fails exactly that test.

## r174 round 1 — seven items, eight agents, one gate failure nobody could have caught (shipped 2026-08-09, main@8168e648, 339 migrations)

`c8052ae3` leave recalc window + balance archive (migration `0416`) · `ee6b7c69` entitlement tables
embedded · `f1b994e3` leave audit merged into the central Audit Trail · `95d17761` corrected movement
rows hidden · `3e3d3fb2` TP1 Relief redesign · `20e759a0` Replacement Leave company filter ·
`cf21e554` Shift Settings stage 1+2 (migrations `0417`, `0418`). The eighth approved item,
`1fff489c`, was deliberately held for a solo round.

Seven parallel worktrees grouped BY FILE OVERLAP, each with its own `TEST_DB_NAMESPACE` and centrally
allocated migration numbers. Every build was followed by an adversarial verifier reading the diff
against the approved plan; six returned ship, one returned fix-first.

**THE GATE CAUGHT WHAT NO AGENT COULD SEE, and the cause is a hole in this file's own grouping rule.**
`test/function-access.test.ts` reverse-completeness failed: `c8052ae3` added the guarded page
`/admin/leave/entitlements/ledger-archive` with no column in the access matrix. The standing rule is
"only ONE agent per round may own each exact-set registry", and `lib/permissions.ts` was assigned to
`f1b994e3` — for a route REMOVAL. **The rule does not cover a DIFFERENT workstream ADDING a guarded
route.** Fix carried forward into HANDOFF: either the integrator owns all registry edits, or any agent
adding a guarded `page.tsx` must declare it in its integrator notes.

**THREE MEASURED BLOCKERS ON THE SHIFT ITEM**, none caught by the builder's green tests:

1. **A paid break was still deducted on partial days.** `normalizeShiftInput` stored `break_minutes`
   as the unpaid sum, but `spannedBreakMinutes` summed overlap across ALL windows and only then capped
   at that total — so a paid window's overlap counted as unpaid, up to the unpaid total. The
   verifier reproduced it: 165 minutes worked instead of 180. The builder's own "mixed paid + unpaid"
   test passed only because the full-day case let the cap mask it. **The re-verifier then built a
   discriminator** — the byte-identical shift with the tea break marked unpaid still measures 165 — so
   the new test cannot pass for the wrong reason.
2. **Normal-hours rounding reached four call sites and missed the fifth.** `rosterVariance` held
   another inlined copy and its select never fetched the column, so the Roster screen would flag a day
   "short" that the Attendance engine considered complete.
3. **Seven new fields were inert but only four said so.** The plan promised the screen would say so on
   the box; Earliest clock-in and Latest clock-out — the two the reporter's expected behaviour names
   explicitly — sat beside controls that do move figures.

**Decisions.**

- **The append-only posture of `leave_ledger` is set aside for ONE correction, deliberately.** The
  justification and its four conditions are written into
  `scripts/reset-medical-hospitalization-ledger.ts` and migration `0416`'s headers. Deletion is safe
  only because both leave types carry zero debits and zero approved requests, and it is made
  recoverable by an archive written first. The script is deployed and has NEVER RUN.
- **`c8052ae3`'s reported premise was wrong and the plan corrected it.** The negative balances were
  not leftover entitlement; they came from a recalc window with a start and no end, counting
  2027-01-01 and 2028-01-01 grants as already-granted this cycle. The builder enumerated every site
  that sums "already granted": two were defective and fixed, two already correct and now pinned, two
  more unbounded in a DIFFERENT shape (`openLeaveYear`'s carry-in sum and `core/read.ts`
  `leaveBalances`) and deliberately NOT changed — they answer a different question and changing them
  would move every balance figure on every screen.
- **`reprojectEntitlementForPolicy` DOES NOT EXIST** — the plan asked for it to be checked; release
  three deleted it with `leave_policy`. Only stale comments reference it.
- **`3e3d3fb2`'s "security gap" stayed refused** — revision 1's claim was tested and RLS refused all
  three attempted exposures. Only the UI redesign was built.
- **A hard delete of movement records stayed refused** (`95d17761`, the fourth raise of one request).
  Employment History is a projection over the append-only ledger. Hiding is a view concern; the detail
  view still resolves a hidden row by id so audit-trail links never break.

## r173 — five items, and the build queue cleared (shipped 2026-08-08, main@3d792d02, 336 migrations)

`0386b95d` Documents tab · `18719ded` Payroll tab · `080de5cf` Transaction History grid ·
`6babf4f6` Statutory Forms · `06f0cb8f` Create Employee with a reserved ID, carrying migration `0415`
(the employee-draft ID reservation). `b8aa3466` closed out with an honest revision. **`approved` and
`contested` both reached ZERO — the first empty build queue.**

Three worktrees, **merged with zero conflicts** — grouping by FILE OVERLAP again: the two personnel tabs
edit one file so ONE agent built both, and the two report items share `lib/report-export.ts` so they ran
SEQUENTIALLY in one tree.

**THREE VERIFIER FINDINGS THAT CHANGED THE CODE**, none caught by the builders' own green tests:

1. **A screen that contradicted its own export button.** The new per-form statutory page used
   `requireAdmin()` and trusted `?companyId=`, while its export route fenced with `scopeIds`. The claim
   was "it renders another company's full return" — **measured first, and that was wrong**: `payroll_batch`
   RLS needs `can_admin_payroll_for(company_id)`, so the read returns ZERO rows. Nothing leaked. But
   `listCompanies` IS tenant-wide, so the picker OFFERED those companies and rendering one produced an
   EMPTY statutory return under its name — readable as "nothing to file" — while the export 404'd on the
   same selection. Both now go through `scopeIds`.
2. **A reservation that was never usable.** The auto running-number path skipped the uniqueness check the
   manual path does. A running number and a hand-keyed code share ONE namespace (ISEDECOR: 22 employments,
   14 in a hand-keyed `A0001..A0014` run), so a counter behind the codes in use issues a taken number, HR
   is told it is reserved, and it only fails at Activate. Now checks and skips, bounded at 50.
3. **An export that could 500.** `grid-export` interpolated an operator-controlled employee code into a
   quoted `Content-Disposition`; a non-Latin-1 character makes the `Response` constructor throw. Now
   RFC 5987, matching the sibling route written the same day.

**Decisions.**

- **A FACT WAS WRONG IN TWO APPROVED PLANS, and both are corrected on the board.** r170's plans told the
  reporter "no tab on the employee profile has search, sorting or page numbers, including Qualification",
  and used it to justify declining them. True of `page.tsx` — and **`components/salary-history-table.tsx`
  IS the Basic Salary section of the Payroll tab and has had all four, CSV export included, all along.**
  So that tab now has one section with them and two without: a version of the very inconsistency the item
  was raised about. **Measure the SECTION, not the page file.**
- **Pay Items ships with NO per-row Edit, deliberately.** The dating reason is a standing warning against
  a plausible future change, so it stays in `../HANDOFF.md` rather than being archived here.

## r172 — the TP1 "security gap" DID NOT REPRODUCE (shipped 2026-08-07, main@240c0613, 335 migrations, none of its own)

`3e3d3fb2`'s plan called the TP1 `?employmentId=` handling a security gap. **Three attempted exposures
were all refused by RLS**, including the manager branch the plan predicted would leak.

**Decisions.**

- **The mutation check is what caught it: with the guard reverted, the whole test file still passed** —
  it was pinning RLS rather than the fix. **Revert your own fix and re-run before you believe a refusal
  test.** Promoted to `../HANDOFF.md` → Traps, because it generalises well past this round.
- The guard shipped anyway, as defence in depth. **`3e3d3fb2` stays PLANNED**: only the guard landed, not
  the redesign the plan described, so the item is not done.

## r171 — six of eight approved items (shipped 2026-08-07, main@704c64bc, 335 migrations)

`4a1abc4a` decimals+editor · `f12d77e5` grade-groups move · `6a1f2bd6` Zakat · `6d72816e` Loans ·
`e440991b` reprocess · `5c198931` payslip PDF. **Two are deliberately NOT marked deployed — see below.**

Built by a 13-agent workflow across FIVE worktrees grouped BY FILE OVERLAP: the four payroll items all
touch `core/payroll-view.ts`, so they were built SEQUENTIALLY in one worktree instead of in parallel.
**Five branches merged with zero conflicts** — the grouping removed the collision rather than leaving it
to be resolved.

**FOUR BLOCKERS THAT PASSED THEIR OWN BUILDER'S TESTS.** Every one was found by an adversarial verifier
reading the diff, not by a gate:

1. **A backfill script wrote to EVERY TENANT.** `scripts/backfill-backup-shift.ts` enumerated the whole
   `tenant` table with no filter. Production has two tenants. `--tenant=<uuid>` is now mandatory.
   `scripts/seed-overtime-multipliers.ts` has the SAME all-tenants default — always pass `--tenant`.
2. **A pattern-less backup shift makes every day a rest day.** Making the shift mandatory promoted it to
   the fallback for every uncovered date, and `core/attendance.ts` resolves that branch as
   `ds.pattern?.includes(...)` — no pattern matches nothing, falls to `rest_day`, and pays rest-day
   overtime on ordinary work. Measured first: 0 of 11 production shifts lack a pattern.
3. **A silent underpayment.** `qty_rate` was in `DERIVED_AMOUNT_RULE_KINDS`, which locks the Amount box —
   but `payRuleInputUnit` returns null for it, so the figure came from the CATALOG. A Commission item at
   `{qty:1, rate:50}` would take a keyed 600 and pay 50. **Deriving is only safe when the operator has a
   box that feeds the derivation.**
4. A new guarded route missing from `lib/permissions.ts` — already failing red.

**THE GATE WAS RED FIRST, and both failures were real:** a payroll pack-boundary violation (fixed at the
facade; `pack-drift-allowlist.json` untouched — it only ever shrinks) and four more pattern-less shift
fixtures (completed, not weakened — none asserted that behaviour).

**MIGRATION 0414 WAS PROVED AGAINST A SCRATCH DATABASE, NOT REASONED ABOUT.** Its first version set every
row's From to the row above's To unconditionally — right for the three production tables, wrong for a
legal single-row `[{from:0.50,to:1.00}]`, whose gap it silently closed. The *second* version still broke
the single-row case; only the scratch DB showed it. Final rule: absorb a gap smaller than 0.01 (a
fencepost 2dp cannot express), keep anything wider. **Verified live after deploy: all three types now
`0.00/0.40/0.70` at 2dp.** Behaviour delta, deliberate: fractions of exactly 0.400 and 0.700 previously
matched no band and now round.



## r169 — four items (shipped 2026-08-07, main@a65ec99f, 334 migrations)

Originally — and verification, not the gate, is what made them correct

`7c834696` Attendance Calculation Engine · `2ef69d1e` Back Pay (Arrears) · `b7b22514` Entity Transfer ·
`4a1abc4a` Entitlement Decimal Precision. All four marked deployed; **`building` and `approved` are now
BOTH ZERO.**

**EVERY ONE OF THESE PASSED tsc, its own targeted suite, and `next build` BEFORE it was caught.** This is
the round's whole lesson — a green build says the code runs, not that it is right:

1. **Entity Transfer silently corrupted two STATUTORY forms.** Until this item an employment belonged to
   one company for life, so "this employment's year" and "this employer's year" were the same set of rows
   and every annual read conflated them safely. The moment a transfer could move `employment.company_id`:
   the **EA form** summed every payslip in the year and printed the CURRENT company as employer (A→B in
   July ⇒ ONE form, on B's letterhead, under B's LHDN employer number, holding six months of A's pay);
   and **Form E Part A** counted `employment.company_id` while the CP8D rows beneath it join through
   `payroll_batch` — so a transferred person vanished from the old company's headcount **including for
   years that closed before the transfer**. The plan had promised "two EA forms needs no code". It was
   false. Fixed: `eaStatement` takes a `companyId`, `eaCompaniesInYear`/`employeeEaStatements` enumerate
   the employers a year spans, the EA screen switches between them, and Part A's population now comes
   from the payslips (company-true by construction) with new hires reading `join_date` — the date someone
   joined THIS employer — instead of the group-wide `hired_on`.
2. **A widened guard reached a movement the item never touched.** Adding `joinDate` to
   `REVERSIBLE_INFO_DATE_FIELDS` was necessary for Entity Transfer and silently made the EXISTING
   `joinDateChange` roll-back-able for the first time. Now keyed by kind.
3. **The attendance panel printed a break that was never deducted.** It showed the CONFIGURED break, so a
   4-hour day with a 1-hour break said "Break deducted: 1h 00m" directly above its own "span 4h, worked
   4h". The figure is now derived as `span − worked`, so it cannot disagree with the numbers beside it.
4. **An i18n claim that was true in five languages and false in the sixth.** Flattening two ICU plurals
   was justified as "two visible fraction digits always select CLDR's `other`". Tamil's rule is
   `i = 0 or n = 1`, so `1.00` selects `one` and Tamil uses a different word for one day. The obvious
   correction — put a plain `{d, plural, …}` back — was ALSO wrong: ICU selects on the number formatted
   with ZERO fraction digits, so English then read "1.00 day remaining". **The category has to be
   computed at the precision the figure is DISPLAYED in**, which ICU cannot express: `dayPluralCategory`.

**THE TEST THAT GREPS A CATALOG CANNOT SEE ANY OF THIS.** The false Tamil claim shipped with a passing
test that pattern-matched the message string; rendering it through `createTranslator` failed instantly.
Assert on rendered output, not on source text.



## r167 — 6e9a126e RELEASE THREE (shipped 2026-08-06, main@ea4f3d54, 332 migrations)

`leave_policy`, `benefit_scheme`, `scheme_leave_entitlement` and `employment.benefit_scheme_id` were
dropped from production. 292 entitlement tables + 67 policy rows cleared; 361 rows archived under
`0410-release-three`. KEPT and verified: 16 grade groups, 54 memberships, 205 of 261 approval rules still
scoped by them; 318 ledger rows and 40 leave requests untouched. Both `6e9a126e` and its decision gate
`4861bcbb` marked deployed.

FOUR DEFECTS NEITHER `tsc` NOR A TARGETED RUN COULD SEE — the durable lessons:
1. `0405` would have been SILENTLY SKIPPED. Numbered when 0405 was free; r165/r166/r168 then shipped
   0406-0408, so its `when` fell below the deployed watermark. Drizzle would have shipped the code and
   never run the drop. Re-check a held branch's journal `when` against production immediately before
   merging, not when the number is allocated.
2. Dropping a table silently DROPS ITS RLS. `leave_policy` carried a company-scoped WITH CHECK (0134);
   its replacement had only `app.is_admin()`. Release three was itself a privilege widening across nine
   companies. When a table is dropped, diff its policies against the replacement's.
3. A guard whose source file is deleted does not fail loudly — it silently widens. A schema slice
   `leaveType` → `leavePolicy` returned -1 and swallowed the rest of the file.
4. A source-grep guard compiles fine and only fails when RUN. 23 such files were invisible to the whole
   tsc-driven workflow and appeared only in the full gate.


Nothing in this file is current state. Board counts, migration numbers, environment claims and "next
steps" in these entries were true when written and are routinely superseded — trust HANDOFF.md and the
tree, not this file. Its own standing rule applies here doubly: shipped lists are not evidence; verify
with `git log -S <symbol> main`.

## r167 — 6e9a126e RELEASE THREE: the old entitlement layer is cleared  ·  2026-08-06

Shipped `main@ea4f3d54`, migrations 0409 + 0410. Gate 578/578, shadow 330 → 332.

**Decisions**

- **THE RENUMBER IS THE ONE TO REMEMBER.** As `0405` this migration's `when` had fallen below
  production's watermark once 0406-0408 shipped during the build. Drizzle does not error on that — it
  skips. The release would have deployed and done nothing. **A held branch's journal `when` must be
  re-checked against production immediately before merge.**
- **DROPPING A TABLE DROPS ITS RLS WITH IT.** 0134 gave `leave_policy` a company-scoped WITH CHECK on
  purpose; the replacement shipped with `app.is_admin()` alone, so release three was a privilege
  widening across nine companies. Nothing failed to compile and no test covered it. 0409 restores it
  against `criteria` JSONB. **Diff a dropped table's policies against its replacement's.**
- **GRADE GROUPS WERE KEPT AGAINST THE REPORTER ASKING TWICE, and the numbers are why.** 205 of 261
  approval rules scope by them, and a NULL grade group is a WILDCARD — clearing them turns 205 targeted
  rules into 205 matching every employee, silently. Measured, put back to them, approved at rev 3.
- **THE PLAN'S ARITHMETIC WAS WRONG THE WHOLE TIME.** Every revision said "359 items"; 41+292+67 = 400.
  The 359 was 292+67 with the schemes dropped out of the sum. Only the promised pre-clearing re-count
  caught it. **A plan that quotes a total should compute it, not restate it.**
- **REPOINT GUARDS, DO NOT DELETE THEM.** `deleteGradeGroup`'s guard moved from benefit_scheme to
  leave_approval_policy; the `entitledDays` chain guard was updated for the fourth time; a schema slice
  whose end-marker was deleted had silently widened to the whole file.
- **A SOURCE-GREP GUARD IS INVISIBLE TO tsc.** 23 files read source as text; the whole tsc-driven
  workflow missed them and only the full gate found them.
- **My own miss:** I tried to make a count self-deriving so it could not go stale, and derived the wrong
  number. Recorded in the test — the file already had two prior instances of the same class of error.

## r168 — nine approved items, six workstreams, adversarially verified  ·  2026-08-06

Shipped `main@f33f33b3`, migration 0408. Gate 596/596 · tsc 0 · next build 0 · shadow 329→330 ·
render-checked (16 routes 200, `/payroll/guide` correctly 404, zero MISSING_MESSAGE).

Items: da4af51f · 6a1f2bd6 · 6d72816e · efe1d230 · e440991b · 2da9937a · e7eb5d83 · defd4644 · c002b3c3.

**Decisions**

- **GROUP BY FILE OVERLAP, NOT THEME — six branches, ZERO merge conflicts.** Three collisions decided
  the shape and each went to exactly one owner: `packs/payroll/index.ts` (one item removes a nav row,
  another adds one), `app/payroll/[batchId]/page.tsx` (two items rewrite it), and
  `collapsible-employee-panel.tsx` (four items want it).
- **AN INDEPENDENT VERIFIER PER WORKSTREAM PAID FOR ITSELF FOUR TIMES.** Every builder reported green;
  the verifiers found a RED BUILD (routes missing from the access-matrix registry), a **guard that had
  silently stopped guarding** (`includes('requireAdmin')` passing off three COMMENTS after the page moved
  to `scopedAdmin` — deleting the gate outright would still have gone green), a **money defect** (the
  `fixed_allowances` aggregate totalling one-off batch rows and non-payable BIK: RM500 → RM2,500 on a
  RM2,000 one-off, and preview/run disagreeing because previewPayRule never sees batch rows), and a
  payslip that printed with the panel's toggle above the letterhead.
- **A BUILDER SHIPPED SIX CATALOGS STATING BEHAVIOUR IT HAD NOT BUILT** — "they are listed on the payroll
  run for you to check". Reworded to what exists. **Strings are a promise; never ship the sentence ahead
  of the feature.**
- **ONLY THE FULL GATE SAW THE PACK RATCHET TRIP.** Splitting the organization page into three routes
  moved an allowlisted import into two new files. The tempting fix is to allowlist them; the test says
  "the allowlist only ever shrinks". Route through the facade instead — 22 entries → 21.
- **EMAIL PAYSLIP IS NOT A UI TASK AND SHOULD NOT BE PLANNED AS ONE.** This product has **no outbound
  mail transport at all** — the only email path is WorkOS `sendInvitation`, which cannot attach. It needs
  a transport, a credential, a bounce/delivery-audit story and a PDPA decision about mailing net pay.
- **Several plans asserted Fixed Transaction "has no collapse" — false**, it has had one since `f3ae3245`.
  The duplication was the list BODY, not the shell. A plan's reproduction can be wrong; builders should
  say so, and this one did.
- **`ssh` inside a `while read` loop eats stdin** and silently processes only the first item. Use `ssh -n`.

**Known shortfalls, shipped deliberately:** sorting on the Zakat and Loans tables; zero-divisor employees
are not surfaced ON the run (needs notices out of the resolver — computing it in the pre-process advisory
would be a second implementation of the arithmetic); `c002b3c3`'s search matcher is still route-private
rather than shared, so it is lookalike three rather than the one implementation its plan asked for.

## r165 — a board plan can carry a MOCKUP  ·  2026-08-06

Shipped `main@70c814db`, migration 0406. Untracked operator tooling (owner's call — no board item).
Gate 590/590 files. Shadow rehearsal PASS, 328 → 329 against the live schema.

**Decisions**

- **The problem was measured, not assumed: 143 of 151 attachments on production are IMAGES.** Every stage
  `feedback_attachment` allowed — submitted / contested / refuted — is the REPORTER answering us. There
  was no stage for the answer, so a plan could only ever be prose the board renders raw. `e7eb5d83` came
  back from `deployed` as "the whole thing is crap" and that is what prompted this.
- **ONLY THE STAGE LIST CHANGED, and the second obvious edit would have been a regression.** 0321 wrote
  the pairing constraint as an EQUIVALENCE — `(stage='submitted') = (plan_revision IS NULL)` — rather
  than an enumeration, so it already means "everything that is not submitted must name a revision" and
  generalised to a stage written two hundred migrations later. Re-stating it as an IN-list would have
  narrowed it and needed editing again next time. **Write pairing constraints as equivalences.**
- **The mockup is pinned SERVER-SIDE, and the ordering is the contract.** `plan_revision` is read from
  the item inside the INSERT, so attaching BEFORE pushing the plan silently files every image against the
  outgoing revision, the page's filter hides them, and the reporter sees a plan with no design and no
  error. `pushPlanWithMockups()` exists so no caller has to remember that.
- **It renders beside the PLAN, not in the reporter's screenshot block.** That block is "what they sent
  us"; mixing our answer into it loses who is speaking. Inline as an `<img>`, because a `↗ filename` link
  is exactly the friction the prose already had.
- **A mockup is a PROMISE and a picture cannot hedge** — the standing caution, printed under every mockup
  in six languages and written into `scripts/mockup/README.md`. The `da4af51f` plan's "we will show every
  line we have and totals where we do not" has no honest visual; it stays in words.
- **THE GATE WAS RED FOR THE THIRD TIME TODAY WITH ZERO ASSERTION FAILURES, AND FOR THE THIRD TIME IT WAS
  A BACKGROUND PROCESS I STARTED AND FORGOT.** The group-8 render check's dev server was still on port
  3199 holding a pool against the same cluster; chunk 1 ran 1080s against 241s/424s and 9 files timed out
  in `resetDb()`. Killed it, re-ran the 9: 9/9, 200 tests, 46.8s. **Kill the dev server in the same
  command that finishes the render check** — the earlier two were a live Workflow and a stale dev server,
  same shape each time.
- **`fullPage` screenshots pad to the viewport, and `scrollHeight` cannot fix it** because `<html>`
  stretches to fill the viewport — the first fix produced a 900px image of 800px of content and looked
  like it worked. Measure the lowest child edge of `body` instead. 1800px → 1054px on the first real
  mockup.

## r164 — 35b7af0a group 8 (Identity), the last genuine wizard/Personnel drift  ·  2026-08-06

Shipped `main@f0a85dfb`. One item, no migration. Gate 589/589 files, 7,222 tests.

**Decisions**

- **The wizard collected no nationality at all, and that was the whole defect.** Personnel gates NRIC vs
  passport on nationality (357faecf) through a live client island. Every hire the wizard created landed
  with `nationality` NULL — the exact state in which Personnel HIDES the Identity No card — and it is
  also why group 7's IC-derived SOCSO default had nothing to fire on. One shared group
  (`components/identity-fields.tsx`) fixes both.
- **`Combobox`'s `name` prop became OPTIONAL rather than the group faking a controlled mode.** Omit it and
  NO hidden input renders, so the wizard's copy posts nothing and a source guard grepping for `name="…"`
  can never conclude that it submits. That keeps the r159 wipe-guard lesson intact instead of loosening
  the guard to accommodate a new caller.
- **THE RED GATE WAS THE HARNESS, AND THE DIAGNOSTIC RULE PAID FOR ITSELF AGAIN.** A plain `npx vitest run`
  reported 293 of 589 files failed. `AssertionError` count across the whole 9,641-line log: **ZERO**. The
  RAM disk was at 94% and the cluster was dead. `scripts/gate-chunked.sh` — which exists for exactly this
  and whose header documents the same failure at 285 files — returned 589/589 green on the same commit.
  **Do not read a red gate before grepping it for `AssertionError`.**
- **`pgrep -f` matched the waiter's own command string, again.** The deploy poller ran
  `pgrep -c -f deploy/deploy.sh` from an ssh command that itself contained `deploy/deploy.sh`, so it read
  `RUNNING=2` forever while the deploy had already printed "✅ Deployed + restarted" on the first poll.
  This is AGENTS.md mistake #3 and it cost ten minutes.
- **An agent and a gate shared the cluster, again (mistake #12) — this time because a background Workflow
  from an earlier turn was still live when the gate started.** Its agent noticed 11 backends across
  `ai_hr_test_w1..w10`, stopped its own DB work and said so. Chunk 1 still came back 197/197.
  **A background job you launched and forgot is indistinguishable from a rule violation.**
- **The remaining 21 wizard labels are deliberately NOT shared.** They already render the same control on
  both screens; extracting them prevents no defect while touching company-scoped org-cascade selects and
  `employeeCode`'s deliberately wizard-only Auto/Manual rule.

## r163 — 2026-08-06 — a00c4f64, the Leave Calendar leaves the Dashboard

**Shipped:** `a00c4f64`. Merge `32311122`, migration `0404`. Gate 589/589 across three chunks with NO
re-runs, and an upgrade rehearsal PASS on a populated database.

### Decisions

**The plan named ONE pointer at the old location; there were FOUR.** Found by following the calendar
rather than the ticket: the Personnel profile's View Calendar deep link, the HR-admin cancel dialog's
`back="/"` return surface, and `PlannedAbsencesPanel`'s three hardcoded `/` URL writes. That last one
would have been felt first — paging to another week on `/leave/tracker` would have bounced the viewer
to the Dashboard mid-task. `usePathname()` leaves dashboard behaviour byte-identical.

**Deleting the seeded card rows, not deactivating them.** Deactivating leaves a re-activate button in
the HR Card Library for a MANDATORY card with nothing to render. Deleting is also what makes saved
personal layouts self-heal: `normalizeDashboardLayout` filters `selected` AND `order` through the live
catalogue, so the key drops on read and, no longer mandatory, is never force-re-added — which is why
no `app_user.dashboard_layout` migration is owed.

**Three i18n strings had become FALSE**, not merely stale: `templateRow2Desc` and `templateDerivedNote`
render UNCONDITIONALLY on Settings → Dashboard → Templates, so every HR admin was being told the Leave
Calendar is pinned full width for every employee.

**The nav row is ungated on purpose** — Manage gates per row, every employee saw this calendar on their
dashboard, and a managerUp row would have been a silent permissions removal for plain staff (the
`a324a4b3` regression class). Verified by rendering AS a plain employee, not by reading the flag.

### The gate, for contrast with r162

589/589 green first time, ~480s per chunk, no re-runs — because the cluster had itself. r162's three
red chunks the same night were the same suite on the same machine with agents alive alongside it.
**That is the cost of breaking rule 12, measured.**

## r162 — 2026-08-06 — five approved items built by parallel agents, and a gate that read RED while being green

**Shipped:** `35524d1f` · `0bb0e303` · `3ced1040` · `bd89ccd8` · `7c834696` points 1/2/4.
Merge `0369f954`. No migration. Also shipped separately the same night: r160 (four items) and r161
(`35b7af0a` group 7).

### Decisions — the part the diff cannot reconstruct

**FIVE AGENTS, GROUPED BY FILE OVERLAP, AND FOUR OF THEM CORRECTED THEIR OWN BRIEF.** That is the
argument for briefing agents with the specific hazard rather than the ticket text:
- `35524d1f` had a THIRD writer (the zakat election) carrying the same `?? ''` coercion, and the
  breakage is reachable TODAY through `setPassportProfileMY`, not merely pending this item.
- `7c834696`: removing the grace inputs alone would have SILENTLY WIPED the columns, because
  `updateShift` wrote them unconditionally where `otRule`/`ruleId` already use an undefined-preserves
  pattern for exactly that reason. The agent proved it by mutating the fix back until the test failed.
- `0bb0e303`: all three actions redirected to `/me`, so every submission from the new page would have
  bounced to a screen with no form. It also found a UTC "yesterday" that names the day BEFORE yesterday
  between 00:00 and 08:00 MYT — `test/today-in-myt-drift.test.ts` only matches the argless form.
- `3ced1040`: THE PARENT'S BRIEF WAS WRONG about reversal. `infoLegIsFlatOnly` puts lifecycle dates out
  of correction's reach, so Confirmation would have shipped as the only comparison movement that could
  be neither rolled back nor edited. It also caught that `CONFIGURABLE_BEHAVIOUR_KINDS` would have let
  tenants mint their own confirmation type, and that leg ORDER decided the displayed effective date.

**`bd89ccd8` shipped as NOT-a-delete.** The reporter asked for Delete on movement events; it already
exists as Roll Back + Edit and a hard delete was settled against by `9064cffb`. What shipped is the
mandatory reason (10 of 11 production rollbacks had recorded none) and Cancel wording for pending rows.

### HOW TO READ A RED GATE HERE — this cost hours and is the durable lesson

The chunked gate came back RED three times: 38 files, 54 tests. **ZERO were assertion failures.** Every
one was a `resetDb` hook timeout or TRUNCATE error. All 38 files then passed when re-run alone on a fresh
cluster (445 + 153 tests). Every one of the 588 files has passed: 550 in a chunk, 38 solo.

Two distinct causes, and only the first was already known:
1. **Rule 12 was violated by the parent** — the integration gate was started while agents were still
   alive on the same cluster. That explains chunk 1.
2. **Chunks 2 and 3 had no agents running and still failed**, so throughput is the real ceiling: six
   concurrent TRUNCATEs were caught mid-flight, all `active`, all `blocked_by_n = 0`, ~0.5s each. Not
   blocked — just slow. Memory was fine (45% free, no swap) and the RAM disk was at 38%.

The r160 `lock_timeout` fix is still doing its job: these fail in seconds now instead of hanging fifteen
minutes. It does not make the operation cheaper. **The real fix is `CREATE DATABASE … TEMPLATE` per
worker instead of a ~100-table TRUNCATE per file**, and it deserves its own change with its own gate.

**A GATE SUMMARY LINE IS NOT A VERDICT.** `GATE RED` here meant "the harness could not keep up", and the
arithmetic proved it: 550 + 38 = 588. Do the arithmetic — the first retry list was built before chunk 3
finished and silently omitted its 9 files, which only showed up as 579 ≠ 588.

## r160 — 2026-08-06 — four items, and the test-infrastructure bug that had been faking failures

**Shipped:** `1ae7f3ab` + `4fdb69b2` (one change) · `1cf5b37c` · `fef49b9a` · `35b7af0a` group 6.
Merge `7cae348b`. No migration, no deletions. Gate: 586/586 files, 7140 tests, 3 chunks, all exit 0.

### Decisions — the part the diff cannot reconstruct

**The leave-type referrer list is TWELVE, and no human list will stay correct.** Both approved plans and
HANDOFF said eleven; `leave_generation_run_item` had arrived with `6e9a126e` release two. So the fix is
not better arithmetic in two places — `core/leave-type-refs.ts` is the single declaration, both the
`inUse` predicate and `deleteLeaveType` are generated from it, and the test compares it against
`information_schema` in BOTH directions. A thirteenth table fails the suite until someone declares what
deleting should do about it. Dispositions: `history` refuses, `config` cascades in one transaction, the
self-reference is NULLED on the other type. `inUse` consequently changed meaning to "has history".

**`setToilPolicy`'s entitlement gate was REMOVED, reversing ADR-0077 slice 3 review r2.** That gate is
what made Leave Config → Replacement Leave render every control dead with no Save, which the reporter
read as an unfinished placeholder — `toil` is absent from `tenant_module` on production. Safe because
configuring cannot bank a day: every accrual path keeps its own check, and the old test's inertness half
is kept verbatim, now asserting that an unentitled tenant with an ENABLED policy still cannot accrue.
The commercial half of the original argument survives and is now the customer's: these fields freeze
onto each accrual, so a policy set today takes effect the day the add-on is bought.

**Three existing tests were INVERTED rather than deleted**, each with the reason written into it: the
entitlement-template delete guard (config now cascades; the ledger is protected by the stronger rule
that history refuses outright), the toil-expiry "form is disabled" assertion, and the replacement-leave
read-only assertion. A fourth guard broke because group 6 extracted a field into a component — repaired
with the three facts r159 prescribed (field exists in the component, the card renders it, and in the
mode that posts), not by dropping the check.

### THE INFRASTRUCTURE FINDING — this is the one worth remembering

`resetDb()`'s ~100-table TRUNCATE ran with **no `lock_timeout`** while a SECOND connection pool (the
app's own, used by every `withTenant` call) still held locks from the previous test. Unbounded wait,
frequent deadlock: a millisecond reset became a 15-minute hang reported as `Hook timed out in 30000ms`
in an unrelated file.

One chunk of 194 files produced 17 failures across 9 files with **ZERO assertion failures**; another 194
files of the same commit passed 194/194 in 136s. After the fix that chunk went **1170s → 149s and
green**. *A red gate containing no assertion failures is a harness problem.*

This retires a long-standing misdiagnosis: HANDOFF attributed "32 false failures across unrelated files"
to WAL pressure. The WAL work is real and was also done — every checkpoint had reported `0 recycled`
because `min_wal_size` was 128MB, so segments were UNLINKED rather than renamed, at ~8s each; the
cluster now runs on a RAM disk with `min_wal_size = 3GB`. But it was treating a symptom.

`scripts/gate-chunked.sh` runs the suite in chunks (the suite still generates ~10GB of WAL per run, more
than this machine retires in real time). It also covers **both** vitest projects — the first version
silently skipped the five `.dom.test.tsx` files — and asserts vitest counted as many files as it was
asked to run.

**Two wrong turns, recorded so nobody repeats them:** a 5GB then an 8GB RAM disk both FILLED before
`min_wal_size` was understood, and the first `tsc`/`next build` of the release was accidentally run in
`mainwt` on `main` rather than the build branch — caught only by the `pwd` check the standing orders
require.

## r159 — 2026-08-05 — nine items, five workstreams, and a release that had been sitting on `main`

**Shipped:** `49e7e0a2` · `f3ae3245` · `f1123afd` (all three merged in r158 and never deployed, with
migration `0403`) · `df00b85f` · `706d34e8` · `18103ba4` · `1b87e8a0` · `35b7af0a` groups 3-5 ·
`6e9a126e` release 2 of 3. Merge `aafd96cd`; gated tree `4540face`.

### Decisions — the part the diff cannot reconstruct

**`6e9a126e` releases ONE and TWO are live and INERT — how that was proved.** (Moved out of HANDOFF's
CURRENT STATE on 2026-08-05 to hold the line under ~700; the live constraints on release three stay
there, this is the evidence behind them.) Verified on production after r159: `entitlement_template`
= 0 rows, `leave_generation_run` = 0 rows, so every figure still resolves through the unchanged old
path. Proved STRUCTURALLY rather than by comparing numbers: `templateOverPolicy(base, null)` returns
the SAME OBJECT, so each engine's expression *reduces* to the one that was there before
(`test/entitlement-template-repoint.test.ts`, `toBe` plus a negative control). Every engine now
composes through ONE hook, `composeEntitlement` (core/leave-compute.ts); the editors are live at
`/admin/leave/entitlements/templates`. Nothing was dropped or cleared — that is release three, and it
is the OWNER'S decision, not a build task. Before planning release three, re-read the carry-forward
defect it already fixed: `carryForwardReport` reads the carry CAP, not entitlement days, and
`applyLeaveTypeRules(null, rules)` returns NULL — the day `leave_policy` goes, every closed year would
print "everything forfeited". Dropping tables is where that class of bug lands. `build/r154` is
squashed and ancestrally unrelated to what shipped; ignore it.

**Production was a release behind `main` and nothing on the board or in the branch list said so.**
r158 had merged and never shipped. CURRENT STATE asserted the opposite, all three items still read
`approved`, and the documented unshipped-round check only scans `build/*` branches — which merged work
does not appear in. A dry-run rsync against the box found it in seconds. That check is now step 1 of
orientation in HANDOFF.md, and "merged is not deployed" is a standing trap.

**The four gate failures were guard drift, and every guard was updated rather than retired.** The
first full suite run on the merged tree failed 4 tests in 3 files; no product logic was wrong. Two of
the three guards protect against silent DATA LOSS, so the distinction mattered:

- `leave-pack-drift` flagged `lib/completed-years.ts`, **a file that imports nothing**. The ratchet
  scans by regex and does not strip comments, and the file's header quoted the specifier
  `core/leave.ts` re-exports. Reworded the comment. **Deliberately did NOT add an allowlist entry** —
  that list is audited debt that only shrinks, and there was no debt to record — and deliberately did
  not "fix" the scanner: a regex comment-stripper mangles `//` inside string literals and would start
  missing real imports. Comment blindness only ever ADDS edges (fails loud); a sloppy stripper HIDES
  them (fails silent). The trade is now documented in the helper.
- `statutory-my-layout` + `epf-info-card` broke because `35b7af0a` group 4 extracted EPF Number and
  Citizenship into a shared component. Dropping the two assertions was the tempting fix and the wrong
  one — they are what catches a field vanishing from a full-row overwrite and wiping the column.
  Following the string alone would ALSO have been a weakening: the component holds the name whether or
  not the page renders it, and controlled mode emits `value`/`onChange` with no `name`. The guard now
  pins all three facts — field in the component, page renders it, rendered in `form` mode inside the
  `setStatutoryAction` form — and learned that `name: 'epfNumber'` mounts an input exactly as
  `name="epfNumber"` does. Both rewrites were mutation-tested and failed with the predicted assertions.

**`6e9a126e` release two shipped INERT, and that was verified on production rather than argued.**
`entitlement_template` and `leave_generation_run` both hold 0 rows after deploy, so every figure still
resolves through the unchanged old path. Releases three (archive-then-clear, drop the three old tables)
stays the owner's decision; `6e9a126e` and `35b7af0a` were left `building` on purpose.

**`35b7af0a`'s Date-of-Birth blocker dissolved rather than being worked around.** The handoff recorded
Age as blocked on `completedYearsAt` living in server-only `core/leave.ts`. Group 3 moved the calendar
math to a client-safe `lib/completed-years.ts` and re-exported it, so the wizard and the profile render
one control against one function identity instead of a second copy in the browser.

### The gate

tsc clean · `pnpm vitest run` **584 files / 7104 tests, 0 failures** · `next build` clean ·
`upgrade-rehearsal build/r153-int` **PASS over a populated database** (r153-int's tree is byte-identical
to what production ran, so the baseline was the real upgrade) · render check on 9 changed routes:
**0 MISSING_MESSAGE, 0 FORMATTING_ERROR**. Post-deploy: service active, `/` 401, `/login` 200,
`0403`'s three columns + partial index present, 3 deleted files gone from the box, and a **zero-change
`rsync --dry-run`** as proof of arrival.

Local note: `ai_hr_dev` had no schema (the cluster rebuild recreated it empty), so the render check
needed `pnpm db:migrate` before `db:seed`. Nothing to do with the release.

## r142 — 2026-08-05 — 93249794 Generate Entitlement: aim the engine, never re-derive it

**Shipped `main@eb47382b`.** Gate: tsc clean · **580 files / 7010 tests** · next build clean ·
**upgrade rehearsal PASS**. Migrations 0399/0400 → production on **326**.

### Decisions

**THE GUARD THAT EARNED ITS KEEP, and it is the lesson of this round.** The first implementation passed
an EMPTY `employmentIds` list to the engine and then zeroed the returned counters. `openLeaveYear`
reads empty as **NO RESTRICTION** — so criteria matching NOBODY would have **granted the entire
tenant** while the screen reported "0 granted". Silent, wrong, and in the ledger rather than on screen.
It was caught for exactly one reason: **the test asserts on the LEDGER, not on the return value.** A
test that trusted the return value would have passed and confirmed the lie.

**ONE COMPOSITION, MADE CHECKABLE.** `previewLeaveGeneration` and `runLeaveGeneration` are one
`openLeaveYear` call site with one `dryRun` flag, and the module provably cannot reach `entitledDays`,
`bandFor`, `applyRounding` or `buildSchemeEntitlementResolver` — a module that cannot reach them
cannot grow a second answer. Step 2 reuses `core/org-criteria.ts` rather than forking a third criteria
engine, proven by asserting the module names none of the criteria axes (a forked matcher must name the
axes it filters on) and holds exactly one `.from(employment)`, the display lookup.

**THE PLAN WOULD HAVE SHIPPED A PERMANENTLY BROKEN SCREEN.** It said to source the Entitlement Year
dropdown from `leave_year_config` — but 0385 emptied that table and deleted every writer, so the
dropdown would have rendered empty forever with no way to fill it. Used the computed year options.

**THE EXTRACTION FROM A SHIPPED SCREEN WAS PROVEN PURE, NOT ASSERTED.** Pulling the criteria picker
into `core/org-criteria-form.ts` touched the live Leave Adjustments page, so the diff was
machine-checked against the previous commit: 18 criteria names identical and in the same order, four
sections with identical keys and order, resolver-behaviour tests untouched and green.

### Two boundary failures the integration gate caught, and one it did not

`core/leave-generation.ts` is a leave SERVICE, so it belongs in the pack BOUNDARIES list and behind
`packs/leave/service`, not in the debt allowlist — that list is audited debt and may only shrink,
which the guard says in its own failure message. And `leave-pack-blocked-surfacing` pinned exact return
literals, so `openLeaveYear` growing a `rows` field broke a guard whose subject (packBlocked reaching
the caller) was never in question. **Third time this session a guard asserted an implementation where
it meant an invariant.**

### ⚠️ A GATE RUN THAT LOOKED LIKE A 32-FAILURE REGRESSION AND WAS NOT

A re-gate returned **32 failures across 13 unrelated files** — holidays, claims, audit chain, payroll
cycle. None touched by the change. The tells, all present: `Hook timed out` inside `resetDb()`,
**30 deadlock/TRUNCATE hits**, **WAL at 5.0 GB**, individual files taking 150-320s instead of seconds,
and `global-setup` healthy at 1.1s when the run STARTED — so the cluster degraded during the run.
Rebuild took WAL to 16 MB; the same tree then passed **580/580 files, 7010/7010 tests, zero deadlocks**
in 1221s versus 1845s. **Do not conclude "flaky test"; read the `Caused by` line and the WAL size.**

**The cause was sequencing, again: an agent was resumed and ran tests against the same cluster as the
gate.** Agents and gates must not share the database. That is now twice in one session.

---

## r141 — 2026-08-05 — 6e9a126e release ONE: the new entitlement layer, built alongside the old

**Shipped `main@668ec3dc`.** Gate: tsc clean · **578 files / 6978 tests** · next build clean ·
**upgrade rehearsal PASS**. Migrations 0396/0397/0398 → production on **324**.
**Item stays `building`** — this is one release of three; it is not satisfied until the old layer is
retired.

### Decisions

**NOTHING WAS DROPPED, CLEARED OR RE-POINTED.** Verified on production after deploy: archive holds
**294 scheme + 67 policy rows**, the old layer is untouched at **41/292/67**, and the two new config
tables are **empty**. The 294 is the tell — 292 entitlement rows PLUS the 2 schemes that have none,
preserved by a LEFT JOIN. The agent watched an INNER JOIN make those two vanish silently.

**THE CENSUS CHANGED THE ITEM'S RISK PROFILE, and getting it right took two corrections.** First read:
`employment.benefit_scheme_id` is NULL on all 26, therefore the scheme layer is orphaned and dropping
it is free. **WRONG** — that column is only the per-employee OVERRIDE. `resolveEffectiveSchemeId`
matches on **(companyId, employmentType-from-the-current-assignment-row, gradeGroupId)**. Measured
properly: **9 of 26 employments resolve through a scheme**, 17 fall through to `leave_policy`. The
archive is load-bearing, not ceremonial. (Also: HANDOFF's "12 of 41 schemes unfilled" was stale — 2.)

**THE PLAN'S ANCHORS WERE WRONG BY UP TO +550 LINES** — an order of magnitude worse than the 5-35
seen elsewhere this session, and its rev-3 explicitly claimed they had been re-verified.
`STANDING_LEAVE_CODES` cited at 5116, actually 5666. Full drift table in the agent's report.
**Re-locate by symbol, always.**

**THE ELIGIBILITY LAYER REUSES `core/org-criteria.ts` — no third criteria engine.** The plan proposed
`ruleMatches` from the approval policy; that is handed its attributes AS OF NOW, so dating the rule
rows alone would still answer a closed year with today's department. `resolveOrgCriteriaTargets` reads
the `assignment` version in force on `asOf`. All nine dimensions the reporter listed were already in
its vocabulary. **`93249794` can adopt this directly** — `templateDaysForYears()` returns the same
`(years) => number | null` contract as `buildSchemeEntitlementResolver`, so release two swaps which
resolver fills the slot rather than changing the composition.

**THE EDITOR SCREENS WERE DELIBERATELY NOT BUILT**, against the plan's "stage 1 = screens only". No
engine reads these tables until release two, and an editor that writes configuration nothing reads is
worse than none: HR types a table, sees no change, and concludes the product is broken. The ARCHIVE
reader shipped, because the plan promises it before anything can clear.

**THE NO-OPINION GUARD SHIPPED NOW, NOT WITH THE CLEARING.** Without it the reset posts NEGATIVE
balance corrections. It changes live behaviour, so it went through the full 578-file gate rather than
its own batch — the agent's 29-file run was necessary and not sufficient.

**A LATENT CRASH, FIXED:** `leave_shared_group_reset_archive.capturedAt` was declared with a helper
that hardcodes column `created_at`; the real column is `captured_at`, so any drizzle read of that
table would throw. Invisible only because nothing reads it. The agent made the identical mistake on
its own new table — where a reader DOES exist — and caught it there.

**The capture is a SQL FUNCTION, not a migration-embedded INSERT**, so release three's pre-reset
re-capture cannot become a second copy of the rendering, and so it can be tested against real rows
instead of running forever against an empty database. 0398 ABORTS if captured policy rows ≠
`leave_policy` rows.

### What the archive cannot reconstruct — stated in code, pinned by test

`gender`, `nationality`, `religion`, `race` (on `person`) and job `grade` (on `employment`) are **not
effective-dated anywhere in this schema**, so a past-date eligibility answer is exact for the dated
axes and current-value for those five. The benefit-scheme layer carries **no dates at all**; the
archive records that rather than inventing a window.

---

## r140 — 2026-08-05 — the attendance engine starts calculating, and it ships inert by measurement

**Shipped `main@00de9851`.** `7c834696` stage 1. Gate: tsc clean · **575 files / 6939 tests** ·
next build clean · **upgrade rehearsal PASS**. Migrations 0394/0395 → production on **321**.

### Decisions

**THE RELEASE GATE WAS DEMONSTRATED, NOT ASSERTED.** The plan's own acceptance test is "a rule with no
bands and deductions off leaves every derived figure byte-identical". `test/attendance-stage1-calc.test.ts`
keeps a VERBATIM COPY of the pre-change `otByRate` and checks the new code against it across a 28-row
matrix (4 day types × 7 shapes, including OT>worked and nulls). Copy the technique: pin the old
implementation, not a description of it.

**MEASURED ON PRODUCTION BEFORE SHIPPING, and the counts are why this was safe:** 151 rows backfilled
across six weeks · **band categorisation decides ZERO days** (the one banded rule is not the default and
no shift selects it) · **zero** rules fail the new bounds validation · **zero** rules carry deduction
values. **Verified after deploy on real data: the six OT rate buckets sum to exactly `ot_minutes`
(5940 = 5940), zero mismatched rows.** `ot_minutes` stays canonical — payroll, reporting and
`toil_accrual` all read it, so the rate buckets are ADDITIVE.

**THE PLAN CONTRADICTED ITSELF ON ROUNDING, AND THE AGENT CHANGED NOTHING.** Two mutually exclusive
worked examples (round-up vs nearest). Rounding decides `ot_minutes`, which is money, so today's
behaviour was pinned instead — and then re-pinned against the REAL production band after the counts
came back, because the first version of that test used a generic band and proved the mechanism while
telling the owner nothing about their own data. **A conflict test written against invented geometry is
half a test.**

**"REFUSE" WAS KEPT, BUT THE SURPRISE WAS REMOVED.** The new ladder validation refuses to save rule
`A01`, whose bands break contiguity — deliberate, because a hole in the ladder used to be cosmetic and
now decides which rate column overtime lands in. Grandfathering would have made `normalizeInput`
stateful forever ("was it already broken, and did this edit make it worse") to spare one admin one
ten-second repair. Instead the band editor flags the offending row on OPEN, in the save error's own
wording: blocked-at-save became visible-on-open.

**AN ADJACENT LIVE BUG, FIXED:** the variable-rate `<select>` compared options as strings while the
form loaded `toFixed(2)`, so a band saved at 1.5× reopened showing 1.0× — and re-saving wrote the
wrong rate back.

### A THIRD HOLE IN THE i18n GUARD — a key that EXISTS but cannot FORMAT

A warning message containing `{row}`/`{expected}` is ICU interpolation, so a plain `t()` with no
arguments threw `FORMATTING_ERROR` at render and painted the literal key path on screen. **The route
returned 200, tsc passed, and `i18n-coverage` check C passed** — check C asks whether the key
RESOLVES, and existing is not the same as formatting. Use `t.raw()` when the braces are literal.
Found only in the dev-server log on a real render. That is now three documented blind spots in one
guard, every one of them found by rendering rather than by testing.

---

## r139 — 2026-08-05 — seven items, six parallel workstreams, and four live bugs nobody had reported

**Shipped `main@a2b6ddab`.** `6e122302` Notice Board · `e7eb5d83` claims stage 1 · `7f6ca478` payroll
dashboard · `44129979` individual transactions · `3c473773` OT classification · `169e3c24` individual
payslip · `18103ba4` leave adjustments. Gate: tsc clean · **574 files / 6892 tests** · next build clean
· **upgrade rehearsal PASS**. Migrations 0390-0393 → production on **319**.

### Decisions

**PARALLELISM SCALED TO SIX WORKSTREAMS.** The recipe is in CURRENT STATE. The load-bearing part is
that ownership was assigned by FUNCTION, not by file: three payroll items all needed
`core/payroll-view.ts` and each was given named functions plus an instruction to stop and report
rather than edit outside its lane. Zero collisions there. The only recurring conflict across six
branches was `_journal.json`, which is structural — both sides append to one array.

**MY OWN MERGE WAS THE WORST BUG OF THE ROUND.** A recursive object merge treats "absent on our side"
as an addition by theirs. The Notice Board branch predated r138's retirement of four duplicate wizard
label groups, so the merge silently RESURRECTED all four in all six catalogs. `wizard-personnel-shared-fields`
caught it. Presence is a value: the base must decide whether absence means deleted or never-existed.
The corrected merge lives at the reusable script referenced in Traps.

**THE INTEGRATION GATE CAUGHT WHAT NO AGENT COULD SEE**, again: `/payroll/individual-payslip` was
guarded on disk with no permissions column. The route came from one branch; the completeness check
reads a shared registry only the merged tree exercises.

**A GUARD WAS PROTECTING A LINE THAT COULD NEVER FIRE** (r138, repeated here because it generalises):
before trusting a test named "X is untouched", check that X was ever doing anything.

**FOUR LIVE DEFECTS FOUND BY BUILDING, NOT BY TICKETS** — the `?error=NEXT_REDIRECT` on every
successful adjustment, the unserialized claims limit, the nested function prop returning 500 on every
`/payroll` request, and a wizard that could not record four marital statuses. Three of the four were
invisible to the entire test suite and surfaced only by rendering.

**AGENTS REFUSED WORK CORRECTLY, THREE TIMES.** `3c473773` declined to switch `earningsOf` on the new
category (it would have moved EPF/SOCSO/EIS/PCB, contradicting its own plan's promise) and built a
display overlay instead. `18103ba4` refused three criteria axes that have no column anywhere and NAMED
them on screen as unavailable. Claims stage 1 declined the `reserved_amount` column the plan asked
for, because a stored counter is what gets double-decremented.

### Environment

**Five agents plus a full suite JAMS the cluster** — 15+ `DROP DATABASE` behind one checkpoint,
everyone blocked including the agents. Sequence it: agents build with targeted tests, THEN the parent
gates alone. Rebuilding mid-round destroys other agents' worker DBs, so the agents were right to wait
it out rather than rebuild; the stalls cleared on their own each time, which continues to support
"slow, not permanently wedged".

**A foreground vitest that hits the harness timeout gets SIGKILLed mid-teardown and stalls the cluster
for every namespace.** Run vitest backgrounded, redirected to a file, from the start.

**The scratchpad directory is SHARED between parallel agents** — one agent's `dev.log` was overwritten
by another's dev server, and the shared `ai_hr_dev` was re-created underneath a third mid-verification.
Prefix scratch filenames per round.

---

## r138 — 2026-08-05 — five items, four parallel workstreams, and a guard that was protecting nothing

**Shipped `main@8a426d83`.** `7cd914b1` · `65f466e2` · `7b5f18c3` · `1b87e8a0` · `8590615a`, plus
groups 1-2 of `35b7af0a` (which stays `building` — its plan mandates group-by-group delivery).
Gate: tsc clean · **564 files / 6700 tests** · next build clean · **upgrade rehearsal PASS**.
Migrations 0386/0387/0388 → production on **315**.

### Decisions

**PARALLELISM: four workstreams at once, and it worked.** Three agents plus me, each in a worktree I
cut from `main` (never `isolation: 'worktree'`, which cuts from the root scratch branch), each with
its own `TEST_DB_NAMESPACE`, each handed a migration number UP FRONT, and each told NOT to run the
full suite. I ran ONE integration gate. The only conflict was the journal — see below.

**THE JOURNAL IS THE ONE GUARANTEED PARALLEL CONFLICT.** Both branches append to the end of the same
array. Resolve as a UNION and then assert what actually matters: `idx` unique and ordered, and every
NEW `when` above the highest existing one. NOTE a pre-existing violation on main (0230 → 0240 goes
backwards) — a strict-monotonic assertion over the whole file will fail on history that is already
deployed and harmless.

**A GUARD CAN PIN AN IMPLEMENTATION THAT DOES NOTHING.** `statutory-floor-advisory` asserted the
literal source `(STATUTORY_APPLY_CODES...).includes(before.code)` under the heading "protections that
were NOT removed". That comparison was FALSE for exactly the types the Employment Act names, because
production codes them MTL/PTL — so a test named "untouched" was guarding a line that had never once
fired. Rewritten to assert the protection EXISTS, is reached role-aware, and keeps its seeded-code
fallback. Likewise `leave-generate-page` asserted 0385's `when` beat every other entry, i.e. "0385 is
the newest migration in the repo" — true only until the next migration. Both were asserting an
implementation where they meant an invariant.

**65f466e2 WAS MUCH BIGGER THAN THE TICKET.** The reporter reported a refused conversion. The cause
was a hardcoded `'EMERGENCY'` code lookup against a tenant whose code is `EL` — and the same
assumption sat at ~12 sites, ALL silently dead: Emergency Leave was itself gated by the
minimum-advance-notice rule it exists to bypass, the statutory lock left Maternity/Paternity/Emergency
editable, and the balance-source guards never fired. `leave_type.role` (0387) now carries
tenant-independent identity. **The backfill never guesses** — two exact passes (seeded code, then
exact pack name), and it REPORTS: production logged `7 classified, 18 left NULL`, matching the
pre-build measurement exactly. A `LIKE` would have captured "Unpaid Medical Leave" as sick.
**The class guard (`test/leave-type-role.test.ts`) found SEVEN more dead comparisons I had missed.**

**AND THE FIRST FIX WOULD NOT HAVE FIXED PRODUCTION.** Target resolution was "chosen target, else code
lookup" — and the code lookup is the broken thing, so it would have needed HR to configure a target
first. Now: chosen target → role → seeded code, so it works on deploy with no configuration change.

**A WIZARD THAT COULD NOT RECORD REAL PEOPLE (found by an agent, in nobody's ticket).** The Create
Employee wizard offered 2 genders and 2 marital statuses; the profile screen offered 3 and 6. So
`divorced`, `widowed`, `separated` and `undisclosed` were unrecordable AT HIRE. Both now read one
shared list.

**THE "STANDARD SYSTEM SETTINGS UI" ALREADY EXISTED.** Both `7b5f18c3` and `1b87e8a0` said it had to
be invented; `/admin/pay-components` has shipped that exact shape for rounds. Lifted into
`components/settings-list.tsx` rather than becoming a sixth private copy, with a test making "the
standard is one thing" a failing condition.

**A "Created" COLUMN WOULD HAVE BEEN A LIE.** Movement event types are an overlay: a built-in has no
DB row until first edited, so `created_at` is the date of the RENAME. Built-ins now read "Built-in";
only the organisation's own types show a date.

**7cd914b1's MIGRATION IS A MEASURED NO-OP** — zero production rows had both a carry percentage and a
cap. Shipped anyway as the invariant, and said so plainly rather than quietly.

### Environment

**The teardown checkpoint stall hit TWICE**, once with two teardowns blocked behind one checkpoint.
Signature confirmed each time before acting (`CONNECT_TIMEOUT`, checkpointer 17% CPU, `DROP DATABASE`
on `CheckpointStart`). Rebuild took under a minute; tests went from a 10-minute timeout to 6 seconds.
**A fresh worktree has no `.env.local`** (it is gitignored) — copy it, or every test dies with
"TEST_MIGRATION_DATABASE_URL must be set".

---

## r137 — 2026-08-04 — SHIPPED. b1f984fe + 38f1fd40: the available-balance label renders, and Adjustments leaves the leave-type panel

**Shipped as `main@1e737a36`. Gate: tsc clean · 558 files / 6612 tests passed · next build clean.
No migration — production stayed on 312.** Built a session earlier and carried over unshipped; the
outstanding clean gate was run and was green first time, so the earlier 1 failure was genuinely fixed.

**The rsync DID carry the two deletions** (`components/festive-grant-card.tsx`,
`test/festive-grant-step.test.ts`) because `--delete` is in the command — see the correction in
Environment. Verified absent on the box afterwards.

### THE TRAP 38f1fd40 CARRIED, AND WHY THE TICKET COULD NOT BE TAKEN LITERALLY

The Adjustments sub-step held TWO tools and the ticket named one. Besides the festive grant it hosted
**Run Earned Accrual** — and after 962077a8 cleared the page header, that sub-step was its ONLY reachable
mount. Deleting it as asked would have removed the only way to generate earned leave days **with no type
error, no failing test and a green render**, because a slot that is never rendered looks exactly like a
slot with nothing to show. It now lives in Service Based Entitlements beside Preview Scenario; the header
is deliberately still empty (962077a8 is a shipped reporter decision, guarded by
test/entitlement-header-actions-removal.test.ts).

**Verified by RENDER, not by source**: `Run earned accrual` and its hint text are in the page payload, so
the slot is genuinely composed. "Present in the file" would not have proved it.

**The invisible half:** `entitlementSubStep` persists in `localStorage` under `leaveTypeCards:<id>`. A
browser sitting on `'adjustments'` would fail key validation and snap back to sub-step 1. `RETIRED_ADJUSTMENTS_SUB_STEP`
remaps it to `'service'`, copying bc9be1e8's existing pattern. **No test and no render can see a user
stranded by its absence** — it is per-browser state.

### A REAL BUG, CAUGHT BY THE REPO'S OWN GUARD — AND THE LESSON GENERALISES

Deleting every `admin.leave` key starting with `festive` also deleted three GENERIC multi-select labels
(`festiveSelectAll` / `festiveClearAll` / `festiveSelectedCount`) that the **surviving**
`components/earned-accrual-card.tsx` shares. `test/i18n-coverage.test.ts` Check C caught it. Restored as
`multiSelect*`.

**A key's NAME is not evidence of who reads it.** The plan had already warned about this shape for
`festiveCompanies` / `canGroupWide` / `companyNameById` (all kept, all consumed elsewhere) — and the same
trap still landed one level down, in the message catalog. Grep for consumers before deleting by prefix.

### AND AN OVERREACH, REVERTED

Widening the new i18n guard by `benefit-scheme-config.tsx` + `leave-rule-preview.tsx` produced **540 false
positives** — they bind their namespace in a shape the simple resolver reads wrongly. Narrowed back to the
validated set, with the reason written into the file. A guard that cries wolf 540 times is worse than one
with a known, documented edge. **The general case is already covered by i18n-coverage Check C** — which is
precisely the test that caught the bug above.

### b1f984fe WAS NOT A RENAME

`leave.breakdown.field.available` — the Request Leave popup's second column header — existed in **NONE** of
the six catalogs. The label the reporter asked us to rename was never rendering. Fourth MISSING_MESSAGE of
this class. `test/leave-i18n-key-resolution.test.ts` now guards it, and was **NEGATIVE-TESTED**: with the
key removed it fails naming the exact file and key. A guard nobody has watched fail is worth nothing.

### ⚠ THREE SPAN-CUTTING MISTAKES, ALL CAUGHT BY ASSERTIONS IN THE SCRIPT

Removing functions by index arithmetic went wrong three times: `rindex('/**')` walked past a `//`-commented
declaration; brace-matching stopped on a `{` inside a comment; a "next top-level declaration" scan ended
inside the FOLLOWING declaration's comment block. Each time an `assert` in the edit script caught it before
writing, and the file was reverted rather than patched. **Put the assertion in the script.** Removing one
element of a `Promise.all` tuple without removing its slot in the destructuring also silently shifted every
later variable — tsc caught that one.

---

## r136 — 2026-08-04 — the org-wide Requests table leaves My Leave, and a false claim in our own tests

**Shipped:** `afd0a87c`. **`main@88a74787`. 312 migrations — r136 ADDS NONE.**
557 files / **6627 tests green**.

**558 LINES OUT OF ONE PAGE**, 1573 → 1015. The visible section was a 208-line Card; the rest was its
support: the header search form, filter panel and CSV/XLSX links (all fed it and nothing else), nine
helper builders, `hasFilters` / `filterParams` / `withSort` / `activeFilterCount`, THREE validation
whitelists (`LEAVE_STATUSES` / `LEAVE_DURATIONS` / `PENDING_STAGES` — they existed to narrow a tampered
filter value before it reached SQL), an 18-key query contract and four imports. `app/leave/export/route.ts`
is DELETED rather than left unreachable: r74 Decision 5 had already established this page was its only
link in the entire source.

**`emp` SURVIVED THE CULL** — it names the employee under inquiry (`inquiryEmploymentId`) and never
belonged to the table. Everything else in that param block went.

### A FALSE CLAIM IN OUR OWN TEST SUITE, CORRECTED

`test/leave-records-cancel.test.ts` asserted the Requests table was **"the ONLY place"** an HR admin could
edit, withdraw or partly give back their own leave. **Withdraw and give-back were never exclusive to it:**
`components/planned-absences.tsx` gates `cancelEligible` (:147) and `selfCancelEligible` (:172) on
`personId === viewerPersonId` with NO admin exclusion — only `adminCancelEligible` (:162) self-bans — and
`planned-absences-grid.tsx` renders both dialogs off those flags for every viewer. Only **editing** a
pending application is genuinely homeless for an admin. Both survivors are now asserted AT their real
homes so the claim cannot rot again.

`<EditLeaveDialog>` also SURVIVES in source and still serves an ordinary employee: it renders from
`selfHistory`, which is `admin ? [] : …`. What an admin loses is REACHING it — the source keeps it.

### THE PLAN'S TOUR INSTRUCTION COULD NOT BE FOLLOWED

`lib/module-tours.json` had a leave step targeting `data-tour="leave-requests"` with **no roles filter**.
After the removal an admin renders no such anchor, and `onboarding-tour.tsx` retries 25 × 140ms before
falling back — a ~3.5s dead pause. `roles` is an ALLOW-list and cannot express "everyone except an admin",
so the step is dropped with its i18n keys in all six locales.

**The plan said to re-run `scripts/merge-guide-tours.mjs` rather than hand-edit. THAT IS NOT EXECUTABLE:**
the script is explicitly a ONE-OFF taking a workflow-output JSON as `argv[1]`, and that input is not in
the repo. `lib/module-tours.json` IS the source of truth. Hand-edited deliberately — do the same next time
rather than hunting for a generator input that does not exist.

### NINE ASSERTIONS INVERTED, NOT DELETED — and three self-inflicted traps in doing it

Every rewritten test keeps the property it defended and re-points it at what survives. Three mistakes made
while doing it, all the same shape and all worth avoiding:

1. **A substring assertion matched its own prose.** `expect(src).not.toContain('listLeaveRequestsPage')`
   failed because the page NAMES that function in a comment explaining where the vocabularies went. Assert
   on the CALL (`listLeaveRequestsPage(session`) and the IMPORT, never the bare name. Third time this
   session — r134's `tList(` and r135's `LEAVE_CONFIG_ROW` were the same trap.
2. **A patch left the original's tail behind**, so one test asserted `not.toContain('<Pager')` AND
   `toContain('<Pager')` four lines apart. Always re-read the whole `it` block after a partial replace.
3. **Slice markers died with the code they anchored on.** Two tests sliced the page from the removed
   card's own comment; the slice went empty and every assertion inside it silently passed or failed for
   the wrong reason. Re-anchor on something that survives, and assert the slice is non-empty.

### Gate

557 files / 6627 tests green · tsc clean · `next build` clean · `/leave`, `/leave?emp=`,
`/leave/employee-records`, `/leave/employee-balances`, `/approvals` all 200 with a dev log carrying no
`MISSING_MESSAGE` · the removed section's STRUCTURAL markers confirmed absent from rendered markup (the
i18n payload ships every catalog key, so string-presence in the HTML proves nothing — check markup).

**⚠ THE `--delete` TRAP FIRED AGAIN.** `app/leave/export/route.ts` was still on the server after the
rsync (4014 bytes, dated 1 Aug). Removed by hand before `deploy.sh`. That is TWO releases running.

---

## r135 — 2026-08-04 — Leave config becomes an expandable menu, and one item closed two

**Shipped:** `645e67c4` — and it closed `491c499f`'s contest as well, because the reporter's contest
reason was verbatim the same request. **`main@40f5ee00`.** 557 files / 6632 tests green.

Leave config went from a flat sidebar row opening an EIGHT-tab strip to a collapsible node carrying those
eight destinations. Copied 1459e116's payroll conversion line for line. Every href carried over character
for character; `components/leave-tabs.tsx` deleted; six sibling components repointed at
`components/claims-tabs.tsx`, which is now the reference copy for the house tab-strip idiom.

**EIGHT, not the six the plan described** — `491c499f` and `4b0e76ae` each added a tab while this item
waited. A plan's inventory is stale the moment anything else ships; re-derive it.

### THE RENDER CHECK CAUGHT WHAT NO TEST COULD

**`nav.leaveApproval` ALREADY EXISTED and is live** — `lib/permissions.ts:290` uses it to label the
separate `leaveApproval` SCREEN ("Approval chain", left over from the standalone route 0d147b78
absorbed). Moving the tab labels into `nav` collided with it, the pre-existing value silently won, and the
menu rendered "Approval chain" where the reporter expects "Approval Workflow". Had the insert order gone
the other way it would have silently RENAMED that other screen. The menu now takes its own
`nav.leaveApprovalWorkflow`, and a guard asserts the two stay distinct.

**Also: an error grep that silently matched nothing.** The first render pass reported "clean" while ten
routes were returning 500 — the grep was anchored `^Error` and Next prints `⨯ Error:`. **Grep the dev log
case-insensitively, unanchored.** That grep is the check three production bugs have been caught by; a
false negative in it is worse than not running it.

---

## r134 — 2026-08-04 — a1d82340 closed at last, and the antivirus that was never Postgres's fault

**Shipped:** `a1d82340` step 5 (the consolidated money view) + a live `MISSING_MESSAGE` on every payroll
run detail page. **`main@e823082c`. 312 migrations — r134 ADDS NONE.**
`a1d82340` had been `building` since 2026-07-29.

### THE ENUMERATION THE PLAN NEVER WROTE DOWN — TWELVE DOORS, NOT EIGHT

The approved plan says "consolidate the eight places money can be added" and never listed them. Counted
from the code, it is **twelve doors writing five tables**, and it is now written down in
`core/payroll-view.ts` above `pendingBatchMoney`. Add to that register when a thirteenth opens.

**The defect that mattered was not the count.** The draft run screen read `payroll_input` and nothing
else (`batchInputRows`), so **four of the five tables were invisible until AFTER the payslip was
generated**: `payroll_batch_component` (file import / attendance-allowance transfer / shift differential),
`payroll_individual_txn` (attached AND period-keyed), `employment_pay_component` (fixed transactions). An
operator pressed Generate unable to see most of what they were about to pay — which is precisely the
reporter's own request §2 step 3, "Payroll Preview — Pending Transactions: 15".

### Decisions — a1d82340 step 5

**READ-ONLY, AND THAT IS THE WHOLE POINT.** r91 established that three of the four screens an earlier
revision proposed retiring were SOLE WRITERS: "never used" and "no writer reachable" look identical in a
row count, and closing a door is not reversible through configuration. So consolidation here means ONE
PLACE TO SEE ALL TWELVE, not eleven deletions. `pendingBatchMoney` computes no money; it reports money
other code already committed. Nothing about what reaches a payslip changed, which is why a step billed as
"the only step that can alter a payslip" altered none.

**PERIOD-KEYED INDIVIDUAL ROWS COUNT FOR A REGULAR RUN AND NOT FOR AN ADDITIONAL ONE.** A row keyed
before the month's run existed carries `batch_id = NULL`; `generatePayslips` stamps it onto the month's
REGULAR run (attach-on-generate, 0175). Omitting them would under-report the very figure being checked;
counting them on a bonus run would claim it pays money the regular run will pay. Marked `unattached` so
the screen says which it is.

**THE KERNEL'S FEATURE GATES ARE MIRRORED, NOT IGNORED — the difference between a useful card and a lying
one.** Three doors only pay when `TYPED_PAY_COMPONENTS_ENABLED` / `INDIVIDUAL_TXN_PAY_ENABLED` are on
(and the second depends on the first). Rows behind an off flag are counted as `inertRows` and kept OUT of
every total: counting them overstates what the run will pay, hiding them loses the fact that somebody
keyed transactions into a dead end. Only `earning`/`deduction` individual rows ride that flag —
`overtime`/`unpaid` fold regardless — and that asymmetry is mirrored exactly rather than approximated.

**BASIC IS EXCLUDED ON PURPOSE,** both as compensation and as a `BASIC` fixed component. It is not money
added through a door; it is the record the run is built from, already shown per employee. Including it
buries twelve doors under the one figure never in question. `leave`-kind individual rows are excluded too
— they are RECORD-ONLY in v1 and the kernel folds no money from them.

### THE THIRD MISSING_MESSAGE IN FIVE ROUNDS, AND THE GATE SAW NONE OF THEM

`app/payroll/[batchId]/page.tsx:453` read `t('runType.<cycle>')` bound to `payroll.batch` — a namespace
that has **never** held `runType`. The labels live under `payroll.list`, `payroll.process` and
`payrollCycleConfig`. **Every payroll run detail page in production rendered `MISSING_MESSAGE` in its
Cycle field.** It is a valid `t()` call over a valid string, so: tsc green, 6618 tests green, `next build`
green, route **200**. Found by rendering the page and grepping the dev log — the r130 method, third time
it has paid.

Fixed by reading the labels where they live (r130's rule: do not mint a fourth copy).
`test/payroll-run-type-label-namespace.test.ts` generalises it: walk every payroll source, resolve which
translator binding each `runType` call uses, map it back to a namespace, assert all six catalogs. **Its
first draft failed against CORRECT code** — `tList(` ends in the two characters a bare `t(` needs, so the
scan needs a `(?<![\w$])` boundary and must strip comments. A guard that reports right code as wrong is
worse than no guard.

### THE OPERATIONAL FINDING THAT OUTLIVES THIS ROUND: IT WAS APEX ONE ALL ALONG

See the CURRENT STATE block. Every local-Postgres wedge symptom this file has accumulated since r83 is
what an endpoint scanner does to a database directory. Excluding the path took cluster start from **10+
minutes to under a second** and the full suite from **2848 s with 98 failures to 761 s with 6625/6625
green**. The 98 were 50 × 30-second timeouts plus TRUNCATE deadlocks and two cascade assertions —
**none of them real**. Two rebuild cycles were spent on a misdiagnosis before the owner named the cause.

**The lesson for the next session is not "rebuild faster". It is: a green-looking diagnosis that requires
the database to be mysteriously broken is usually the environment.** Also worth knowing: postgres
processes that survive `kill -9` are in uninterruptible kernel I/O, which is itself the scanner's
signature, not a Postgres bug.

### Gate

556 files / **6625 tests green** · tsc clean · `next build` clean · seven payroll routes rendered 200
with a dev log carrying no `MISSING_MESSAGE` and no `FORMATTING_ERROR` · rsync verified by a zero-change
`--dry-run` re-sync (r86's proof) · deploy clean, service active, `GET /` 401, `/login` 200.

## r130 — 2026-08-04 — 4b0e76ae and 296fc027, plus a bug r127 shipped that only a render could find

**Shipped:** `4b0e76ae` (Leave Year Configuration removed + Generate Entitlement page) ·
`296fc027` (Replacement Leave configuration + employee request workflow).
Plus a fix for a defect **r127 introduced**.
**`main@8cc11664`. 312 migrations. New: `0380`, `0381`, `0385`.**

### r127 SHIPPED THE ADJUSTMENTS SCREEN WITH TWELVE BROKEN LABELS

`app/admin/leave/adjustments/page.tsx` read `admin.leave.employmentType.*` and
`admin.leave.orgCriteria.*`. **Neither namespace exists.** So all four employment-type chips and all eight
org-criteria chips on the screen `491c499f` was raised to create resolved to nothing.

**Every gate step passed** — tsc, 6591 tests, `next build`, the upgrade rehearsal — and the page returned
**200**. It is visible in exactly one place: the dev-server log on a real render, as
`MISSING_MESSAGE: Could not resolve …`. This is the third time in four rounds that rendering caught what
the whole gate could not (r123's server/client boundary, r127's missing GRANT, now this).

**Both label sets already shipped, translated in all six locales.** The fix reads them where they live
rather than minting a seventh copy: the eight org axes under `admin.profileOptions.category` — which is
what `ORG_ASSIGNMENT_CRITERIA`'s own header says `labelKey` indexes — and the employment types under
`people.wizard.employmentType`. Verified by re-render: no new `MISSING_MESSAGE`, chips read Full-time,
Part-time, Division, Branch, Region, Section.

**A bare status code is not a render check.** Grep the dev log too. `296fc027`'s build hit the same class
independently — a next-intl `FORMATTING_ERROR` from an ICU variable that was never supplied, on a page
that returned 200 throughout.

### Decisions — 4b0e76ae

**THE REMOVAL WAS NEVER THE RISK. THE ORPHANED BUTTON WAS.** Pressing *Start* in the deleted section was
the only way a leave year got opened for anybody, so `/admin/leave/generate` ships in the SAME release and
`openLeaveYearAction` moves onto it. It had **zero** direct callers before this — it was reached only
through the deleted section's draft→open transition — and now has exactly one, pinned by a filesystem scan
that strips comments (three surviving prose mentions would otherwise read as call sites).

**AND IT WAS NOT SAFE TO RE-HOME AS-IS.** `openLeaveYearAction` was gated on `getSession()`, not
`requireAdmin()`; `openLeaveYear` asserts nothing about admin anywhere in its body; and the ledger's RLS
gates on `can_see_employment`, not on admin. **An ordinary member posting that server action could have
written accrual grants for every employment they can see.** Now `requireAdmin()`, with a test written to
fail on reversion rather than merely assert the new line.

**The future-year gate keeps its behaviour and loses its read.** Deleting it outright — the obvious move
once the table it reads is emptied — would let an employee book next-year dates against this year's
balance. The approval debit stamps at the request's start date while `openLeaveYear`'s "before" is an
UNBOUNDED ledger read, so that booking would quietly REDUCE carry-forward and INCREASE forfeit. It is now
a flat rule with no read at all: a future year plus not-admin throws; admin keeps the override stamp.

**The year list is a computed range, `currentYear − 3 .. + 6`.** It must reach BACK three years: today's
Run Earned Accrual selector builds `currentYear .. +6`, so a forward-only range would silently remove the
ability to run earned accrual for a past year. Accepted difference, disclosed: the selector now opens on
the current year rather than the newest configured year.

**The reset must run as the table OWNER.** `leave_year_config` carries a RESTRICTIVE delete policy that
ANDs with `app.is_admin()`, and `ai_hr_app` is NOBYPASSRLS — so the same `DELETE` through the app role
**removes nothing and raises nothing**. Migrations connect as owner and the table is ENABLE (not FORCE)
RLS, so the migration path is clean. Do NOT add FORCE to this table. The empty table and migrations
0190/0191/0282 stay in place, unreferenced — `test/harness.ts` and `test/leave-pack.test.ts` both pin it.

**DISCLOSURE, MEASURED NOT ASSUMED: 2027 was OPEN on production** (2028 draft, 3 rows total). The plan
stated the consequence conditionally — "if any year later than this one is currently Open". It was. So
this reset really does remove the ability to apply into 2027 until the new module opens a year again.

**A dependant the plan missed:** `test/entitlement-standalone-sections-removal.test.ts` asserts the
entitlements page matches `listLeaveYearConfigs(s)`. The plan said "no change expected" for that file.
Guaranteed break; re-pointed. Also, `lib/permissions.ts` held SEVEN routes and the tab strip SEVEN tabs,
not the six the plan counted — `/admin/leave/adjustments` landed in between.

### Decisions — 296fc027

**Replacement leave already worked.** The engine grants it, tracks expiry and stops the same worked day
being both paid and banked — it just lived on the Time Off In Lieu screen, one company at a time,
reachable only by a manager from the roster and only for a day that already carried approved overtime.
Configuration moves to `/admin/leave/replacement`; **the ledger and the two settlement sweeps deliberately
STAY** on `/admin/toil`, whose wind-down comments explain why they are not entitlement-gated.

**`accrueToilTx` was SPLIT at the fork, not duplicated.** It hard-requires an attendance row with overtime
and restricts to rest days and holidays; this phase validates none of that. Everything from the policy
check down — double-bank guard, First Schedule gate, frozen expiry, ledger credit, register row — moved
into a shared `bankToilCreditTx` that both paths call, so **the gates sit BELOW the fork where neither path
can miss them.**

**A SELF-DECLARED CREDIT HAS NO DAY TYPE, AND WE DO NOT INVENT ONE.** The exact s.60(3)/s.60D(3) cash for a
First Schedule employee is a *function of* the worked day type — rest day and public holiday pay at
different multiples. Fabricating one would produce a confident, wrong figure on a legal obligation. So
`day_type` stays NULL, the expiry sweep falls back to contractual ORP, and the event carries a note telling
the admin to verify the worked day before paying. It can only arise where the employer already used the
First Schedule override.

**Requests are NOT `leave_request` rows.** That table means TIME TAKEN everywhere — balance checks,
calendar, payroll unpaid days — and reusing it would have corrupted all three. New header + line tables,
decided through `assertCanDecide` (line-manager-or-admin with a self-grant ban), not the multi-level
template chain.

**Named individuals WIDEN eligibility, they do not narrow it.** Eligible if named individually OR matching
all set org criteria. AND-ing would make "and also Aisha" silently exclude her. Guarded against the
vacuous-truth trap where an individuals-only config collapses into "everyone".

**Two expiry columns, not one.** `expiry_days` keeps its exact meaning and `expiry_months` is separate — a
column named `expiry_days` holding "3 months" is how `addDays` produces a 3-day expiry. Month arithmetic
clamps to end-of-month; JS `setUTCMonth` rolls *forward* into March and would silently lengthen the period.

**Already done, so not rebuilt:** the plan's item 3 (expiry counted from the approval date) had ALREADY
shipped as `00307068` in migration 0354. Only the unit was missing. And `56910869` did NOT add a button to
the My Leave row as this plan assumed — it added a consent block inside the Request Leave modal — so there
was no conflict to resolve.

**Production had ZERO toil_accrual and ZERO toil_policy rows**, so the promise that banked credits keep
their expiry dates is trivially true and the screen move carries no data risk.

### Gate

`tsc` clean · **554 files / 6618 tests** · `next build` clean · upgrade rehearsal from `build/r127` **PASS**.

**Honest note on the last two fixes.** The gate run that produced those numbers had **2 files / 6 tests
failing**, both in `4b0e76ae`'s own new suites, which its agent never ran because the cluster was wedged.
Both were TEST-side (a `vi.mock` missing `isAdmin`; a `.toMatch()` against a key the item itself deleted)
and **no production code changed to fix them**. They were re-run in isolation — 2 files / 24 tests green —
rather than re-running the whole suite before the deadline, and r130 was deployed on that basis.

**The full suite was then run against the deployed tree to close that gap: 554 files / 6618 tests, all
passing, zero failures** (08:06–08:24, on a freshly rebuilt cluster). So the release is verified, not
inferred. Recorded because "I reasoned the delta was safe" and "I ran it" are different claims, and only
the second one is evidence.
Render-verified on a real dev server, all 200 and dev log checked, not just status codes:
`/`, `/admin/leave`, `/admin/leave/generate`, `/admin/leave/replacement`, `/admin/leave/entitlements`,
`/admin/leave/adjustments`, `/admin/toil`, `/me`, `/leave`.

## r129 — 2026-08-04 — bc36c768: three earning methods, and the gate that makes a reset safe

**Shipped:** `bc36c768` — Simplify Earning Method Configuration.
**`main@289a1b84`. 309 migrations. New: `0375`, `0376`.**

None / Monthly Accrual / Daily Accrual. **By Year** and **None** were the same stored value, **Earn Upon
Resignation** was greyed out and had never calculated anything, and an unlisted quarterly option nobody
used sat behind them. Monthly gains a day-of-month (1–31, clamped to the last day in a shorter month, so
day 31 credits on 28 Feb and never skips). Daily accrual is new: annual entitlement in daily slices over
the ACTUAL cycle length, 365 or 366.

### Decisions

**THE GATE, NOT THE WRITER, IS WHAT MAKES THE RESET SAFE.** A blank earning method is read by the engine
as "hand the whole entitlement over up front". So simply clearing the columns — the obvious reading of
the request — would have credited a new joiner a full year on the spot, and posted an UPWARD correction
for anyone previously earning monthly the next time ordinary HR work (a grade change, a confirmation, a
hire-date fix, a movement, a scheme assignment) triggered a recalc. Nothing can claw either back.
`leave_type.accrual_unconfigured` makes an unconfigured type grant *nothing* instead.

**`projectExpectedEntitlement` returns `null`, NOT `0`.** Returning 0 would make the reproject paths post
a NEGATIVE compensating adjustment clawing back every already-credited day — the exact inversion of the
risk being removed. Pinned at all three callers.

**`openLeaveYear` is a ZEROED GRANT, not a `continue`.** The `continue` looks equivalent and is not: it
would skip the carry-forward cap forfeit AND the grant row that is always written even at 0 days, which
is simultaneously openLeaveYear's own idempotency marker and the expiry sweep's "year was opened" marker.
Without it `expireCarriedLeave` short-circuits and carried leave never expires that year either. So the
grant is forced to 0 *before* `applyMaxBalance`, leaving both writes intact.

**AND THE PLAN'S DISCLOSURE ABOUT THAT WAS OVER-CAUTIOUS — measured at 0.00 days.** The plan warned the
reporter that a zeroed grant leaves `carry` higher and the forfeit correspondingly smaller.
`applyMaxBalance` computes `clampedCarry = min(carry, cap)` **before** giving the grant the remaining
room, so carry has never depended on the grant and zeroing it cannot move the forfeit. A test now measures
a configured and an unconfigured year side by side and asserts the forfeits are identical.

**The marker is in `leaveTypeRuleColumns` but deliberately NOT in `hasAnyLeaveTypeRule`** — it must ride
every select so the gates can read it, but if it flipped a previously-unruled type onto the type-level
rule set, `applyLeaveTypeRules` would overlay NULL carryMax / roundingMethod / maxBalanceDays over the
policy's real values and silently wipe configuration nobody asked to reset. Same reasoning as
`carryForwardIncludeEarned`. Pinned twice.

**ONE shared `earnedToDateFor`, called from both engines.** `accrueEarnedLeave` and
`projectExpectedEntitlement` were two independent copies of the same arithmetic. Adding daily accrual or
the accrual-day gate to only one would make the kernel project the monthly figure while the engine credits
the daily one — the file's own comment names the result: "a permanent oscillating delta" posted on every
profile edit.

**The joiner guard differs by method, on purpose.** Daily accrual anchors on the HIRE DATE; a
"cycleStart to asOf" window would let a calendar-cycle mid-year joiner accrue from 1 January — months of
leave never worked, which the `toGrant > 0` guard means the engine can never take back. Monthly keeps its
existing month-start rule.

**KNOWN LIMIT, pinned rather than papered over:** the catch-up reproject does NOT reach an employee hired
*during* the unconfigured window. `reprojectEntitlementForEmployment` carries a materialized-only guard —
no accrual row this cycle means nothing to correct — and such a joiner has no row by construction.
Affected precisely: a joiner during the window on a type later set to **None** (an earned type
self-corrects on the next accrual run). The guard was NOT loosened: it is what stops a reproject
fabricating grants, and it is shared by both recalc kernels.

**Not fixed, and not claimed to be:** the a2c first-year divergence. `projectExpectedEntitlement` tests
`a2cFirstYear` before the earned branch and `accrueEarnedLeave` has no a2c handling at all, so the two
already disagree for `earned_monthly`; `earned_daily` inherits that unchanged. Excluded by explicit
assertion in the cross-check rather than silently omitted. Worth its own item.

### Verified on production after deploy

25 leave types marked NOT CONFIGURED, `accrual_method` cleared at BOTH levels (10 → 0 on the type, 67 → 0
in `leave_policy.accrual`), and **25 `leave-type.rules.updated` events each carrying a `before` payload** —
the only recoverable record of what was cleared, exactly as promised to the reporter. **Ledger total
unchanged at 1273.02 days, zero adjustment rows.** The gate did what it exists to do.

### Gate

`tsc` clean · **555 files / 6591 tests** · `next build` clean · upgrade rehearsal from `build/r127`
**PASS**, leave balances unchanged at 128.00.

## r128 — 2026-08-04 — five items, three parallel agents, and the wedge that stopped all three

**Shipped:** `8fec719e` (custom rounding table) · `56910869` (Override Leave Application engine) ·
`65f466e2` and `fef49b9a` (its first two rules) · `c459bff9` (Expiry step removed).
**`main@5b113ea5`. 307 migrations. New: `0358`, `0365`, `0370`.**

Five board items in one release because three of them are one mechanism and two share a form.

### The thing that cost the most: the local Postgres wedged for ninety minutes

The checkpointer completed **zero** checkpoints in 1h26m of uptime and every `DROP DATABASE` queued
behind it — three of them, aged 1h02m, 31m and 10m. `test/global-setup.ts` drops before it creates, so
**every vitest run on the machine failed at setup**, in all three worktrees at once, with connection
timeouts that look exactly like real failures. One agent nearly started debugging its own code against
it.

The diagnosis that works, and it is not CPU (both idle low). **Note `pg_stat_checkpointer` is
PostgreSQL 17+; this cluster is 16, so use `pg_stat_bgwriter`** — the 17 name fails silently under
`2>/dev/null` and looks like a stalled counter:

    select checkpoints_timed, checkpoints_req, buffers_checkpoint from pg_stat_bgwriter
    select count(*) from pg_stat_activity where wait_event in ('CheckpointStart','CheckpointDone')

Byte-identical counters over ~40s **plus** backends parked on those wait events is the wedge.

**I tried recovery twice and it was the wrong call both times. WIPE FIRST — the standing note is right.**

- Restart #1, at **61 databases**: crash recovery finished in ~4 minutes and everything came back. This
  is the outcome that tempts you into trying it again.
- Restart #2, an hour later at **~70 databases**: `syncing data directory (pre-fsync)` ran past **10
  minutes**, then the second `(fsync)` pass ran past **13 more**, walking file-by-file and eventually
  blocking inside a single `fsync()` that never returned. Trend Micro
  (`/Library/Application Support/TrendMicro/…`, confirmed running) scanning the data directory is the
  plausible reason. **Every `-m immediate` restart re-triggers that pre-fsync from scratch**, so once it
  starts you cannot shorten it by restarting again.

Total cost of choosing recovery over the wipe: **~50 minutes.** The wipe took under two:

    pg_ctl -D $DATA -m immediate stop; pkill -9 -f aihr-pg16
    mv $DATA $DATA.wedged-$(date +%Y%m%d)      # stash, do not delete — 3.2 GB, still there if wanted
    initdb -D $DATA -U postgres --encoding=UTF8
    # then: max_wal_size=4GB + checkpoint_timeout=30min into postgresql.conf, start,
    #       CREATE ROLE ai_hr_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    #       CREATE DATABASE ai_hr_dev; CREATE DATABASE ai_hr_test;
    #       GRANT CONNECT/USAGE + ALTER DEFAULT PRIVILEGES FOR ROLE postgres … TO ai_hr_app;
    #       pnpm drizzle-kit migrate

**`ALTER DEFAULT PRIVILEGES` is not optional.** Migration 0001 grants to `ai_hr_app` only the tables that
existed at Slice 0; every later table relies on the default-privileges rule to be reachable at all. Miss
it and you reproduce r127's `permission denied` bug across the whole schema.

Result: **72 databases → 5**, migrations applied in seconds, checkpoints now complete in milliseconds.
The recurring wedge was never really the checkpointer — it was fsync cost scaling with leaked databases.

### PARALLEL AGENTS NEED `TEST_DB_NAMESPACE`, AND NOTHING TELLS YOU THAT

`test/db-names.ts` exists precisely for this and its header spells out the failure: the template and
worker database names are **server-wide, not per-checkout**, so two `pnpm vitest` runs anywhere on the
machine — different worktrees included — destroy each other's databases mid-run. Set it on every
invocation, one value per agent:

    TEST_DB_NAMESPACE=r128 pnpm vitest run …

A namespaced run is treated as ephemeral and tears its databases down, so it does not leak either. I
launched three agents without it and had to correct all three mid-flight.

### ALSO: A WORKTREE HAS NO `node_modules`, AND AN AGENT WILL NOT TELL YOU

One agent reported "29/29 green" from a worktree whose `node_modules` contained a single `.vite`
directory — `vitest` was not installed there and could not have run. Its code turned out to be fine
(195 tests green once I installed and re-ran), but **the report was not evidence.** Pre-install
`node_modules` and copy `.env.local` into every agent worktree before launching, and re-run anything
load-bearing yourself.

### Decisions — 8fec719e (rounding)

**The reset is not inert, and the reporter re-approved knowing it.** Rounding is folded into the
entitlement-change comparison, so turning it off reprojects already-granted balances for the current
cycle. Annual Leave and Compassionate Leave stop rounding up and all 23 employees move DOWN to the exact
unrounded figure. Closed prior years are protected by the effective-date guards.

**The unruled fall-through was checked on production, not assumed.** Nulling `rounding_method` on a type
whose ONLY rule was rounding would flip it unruled and silently restore its whole legacy JSONB rule set —
a balance change disguised as a rounding change. Both affected types carry other rule columns (Annual:
`earned_monthly`, carry max 10, 6-month expiry; Compassionate: `grant_on_hire_prorated`, carry max 0), so
neither can. `0358` still writes the literal `'none'` rather than NULL where nulling *would* leave a type
unruled, and `setLeaveTypeRules` applies the same guard on every future save — because the trap re-arms
the moment a type later loses its other rules.

**A stored `nearest_half` still evaluates; it just cannot be written any more.** Removing an option from
a dropdown while the engine still recognises the value is how a silent downgrade happens.

### Decisions — 56910869 (the override engine)

**Three items, one mechanism.** Building "advance notice becomes Emergency" and "insufficient balance
splits" as branches first, then dismantling them into a rule engine, would have billed the same behaviour
twice with a gap in between where only we could change the rules. The engine shipped first and both rules
shipped **OFF**.

**Consent is a service concern, not a dialog.** The service refuses a converting rule without an explicit
token, so a client that skips the confirmation cannot submit a silently-converted application.

**`override_rules` is deliberately NOT in `hasAnyLeaveTypeRule` or `leaveTypeRuleColumns`.** Those are the
*entitlement* overlay. An override rule is an *application* rule, the same family as `min_advance_days` and
`allow_negative_balance`, none of which are in either symbol. Adding it would mean a type whose only
setting is an override rule suddenly reads entitlement from its own ten NULL columns — stripping its
accrual method, carry cap and rounding. Pinned by two tests.

**After a conversion, the NEW type's rules govern the rest of the application.** So Annual's split rule
does not follow an application converted to Emergency; the split must be configured on Emergency.

### Decisions — c459bff9 (expiry removal)

**`AGED_FORFEIT_REASON` is KEPT, exported and read-only, though nothing writes it.** Deleting the constant
would have rewritten history employees have already seen: `classifyLedgerAdjustment` would fall through to
`config` so every past automatic forfeit rendered as a *manual HR adjustment*, `agedForfeited` would drop
out of the forfeited fold so the reconciliation identity stopped balancing, and `a2cSupersededReasonCond`
would stop superseding those rows, changing first-year entitlement figures.

**Measured, not estimated:** production had exactly ONE leave type configured (RL / Replacement Leave, 2
months) and **zero rows ever forfeited** by this sweep. The plan's offer to also erase past forfeits was
therefore moot — there was nothing to erase — and HANDOFF.md's attribution of 1,322.67 days to
`expireAgedLeave` was wrong. That population is `carry_forward_cap` (14 / −550.67), `profile_recalc`
(13 / −738.00), `a2c_recalc` (8 / −25.67) and `policy_recalc` (19 / −26.33).

**The crontab was live and the handoff said it wasn't.** See the corrected block at the top of this file.
The `30 3 * * *` line was removed from the host before this deployed.


### Two things production did NOT do that the plans said it would

**No balance moved on deploy day.** 8fec719e's plan told the reporter "the current year's balances for
all 23 employees are re-worked to the exact figure that day." They were not. Migration `0358` clears the
configuration; the reprojection lives in `updateLeavePolicy`, not in SQL. Measured immediately after the
deploy: **zero adjustment rows in the last hour, total ledger unchanged at 1273.02 days.** The re-work
happens when an ordinary engine next runs — a profile edit, the monthly accrual, or year open. The
direction and size are still as disclosed; only the timing was wrong. **Tell the reporter this**, because
they were told to warn employees about a same-day change.

**Both rounding types cleared to NULL, not `'none'`.** `0358` writes the literal `'none'` only where
nulling would leave a type with no rule columns at all. Neither affected type qualified — confirmed on
production before the build — so both went to NULL and the guard never fired. All 25 leave types now read
NULL, `rounding_threshold` is 0 rows, and the 58 legacy `leave_policy` values are gone.

### The deploy failed the first time, and rsync is why

`deploy.sh` failed type-check on the first attempt: `scripts/expire-aged-leave.ts` was still on the
server importing an `expireAgedLeave` that no longer exists. **The deploy rsync has no `--delete`**, so a
release that DELETES a source file leaves an orphan behind that still gets compiled. Four files were
deleted this round; removing them by hand and redeploying fixed it. Production never went down — the
build fails before the restart.

**For any future release that deletes a file**, list them first and remove them on the host before
deploying:

    git diff --diff-filter=D --name-only <last-released-ref>..HEAD

### Gate

`tsc` clean · **554 files / 6563 tests** · `next build` clean · upgrade rehearsal from `build/r127` —
the exact tree production was running — ****PASS** (leave balances unchanged at 128.00, every row survived)**.

## r127 — 2026-08-04 — Leave Adjustments gets a place of its own, and the GRANT that 0353 forgot

**Shipped:** `491c499f` — Leave Adjustments as a Leave Settings submenu.
**`main@776ab66b`. 304 migrations. New: `0357`.**

### What the item actually was

An adjustment is a **transaction**, not configuration. It was living inside a leave type's Entitlement
step, so an operational task sat in a settings screen, and a grant spanning six leave types had to be
repeated six times. The item asks for one screen that takes many types at once.

`0353` (r122) had already created `leave_adjustment_batch` and `leave_ledger.adjustment_batch_id` and
shipped them **inert** — nothing read or wrote either. r127 is the write side plus the screen.

New: `core/leave-adjustment.ts` — `resolveAdjustmentTargets`, `applyLeaveAdjustmentBatch`,
`reverseLeaveAdjustmentBatch`, `listLeaveAdjustmentBatches`, `countAdjustmentTargets`.
Plus `app/admin/leave/adjustments/{page,actions}.tsx` and `components/leave/adjustment-form.tsx`.

### Decisions

**The schema existed but was invisible to Drizzle.** `0353` created the table in SQL; nobody added the
declaration to `db/schema.ts`. So the table was real, empty, and unqueryable through the ORM. Declared
now, along with `leaveLedger.adjustmentBatchId`. **A migration is not finished until the schema file
agrees with it** — the two can disagree indefinitely without any test noticing, because nothing
references what nothing declares.

**The GRANT bug — see the block at the top of this file.** `0353` created a table and granted nothing.
Production was fine by accident (`ALTER DEFAULT PRIVILEGES`); a locally-restored cluster was not. It
surfaced only when the page was actually rendered through the app role, which is the *second* time in
four rounds that rendering caught what the whole gate could not (r124 was the first). **Five minutes of
`curl` against `pnpm dev` is not optional.** Verified 200 this round: `/admin/leave/adjustments`,
`/admin/leave/entitlements`, `/admin/leave`, `/admin/leave/replacement`, zero errors.

**Department and employment type are NOT on `employment`.** They live on the effective-dated
`assignment` table, so a criteria set is only meaningful *as of a date*. The resolver takes the
adjustment's `effectiveOn` and matches the assignment row valid on that date:

    assignment.validFrom <= effectiveOn AND (assignment.validTo IS NULL OR validTo >= effectiveOn)

Resolving against "current" assignment instead would silently include people who transferred after the
effective date and exclude people who transferred into the group before it. Backdated adjustments are
the normal case here, not the exotic one.

**An empty criteria set means everyone, and the resolver does not second-guess that.** There is no way
for it to distinguish "deliberately unfiltered" from "form nobody finished". So the *form* says so out
loud with a warning banner while no criterion is set, and the resolver stays literal. Guessing at the
boundary would make the explicit case impossible to express.

**Targeted and written are reported separately.** They differ whenever an ADR-0069 frozen encashment
snapshot causes a row to be skipped. A bulk write that reports one number hides exactly the discrepancy
that makes it untrustworthy, so the toast and the history list both carry both counts.

**Reversal writes compensating rows; it does not delete.** ADR-0006 is append-only. The batch is marked
reversed and a second attempt is refused.

**Every prop crossing into `AdjustmentForm` is serialisable, deliberately.** Copy arrives as a plain
`labels` object rather than a `t` function — this is the exact shape that took the Entitlements tab down
in r123. `test/server-client-boundary.test.ts` now fails the build if anyone reaches for the shorter
route.

**Pack ratchet:** `core/leave-adjustment` was added to both `BOUNDARIES` and `ALWAYS_ALLOWED` in
`test/leave-pack-drift.test.ts`, with a facade re-export from `packs/leave/service.ts` — fixed at the
boundary, not by widening an allowlist.

### Gate

`tsc` clean · **553 files / 6507 tests** · `next build` clean · upgrade rehearsal **PASS** against a
populated customer database. Live: service active, `GET /` 401, 304 migrations,
`leave_adjustment_batch` grants `SELECT,INSERT,UPDATE,DELETE` to `ai_hr_app`, zero errors since restart.

## r126 — 2026-08-04 — four items built partly in parallel, and the worktree that branched 114 commits back

**Shipped:** `main@156de9e3`. **Migrations `0354` / `0355` / `0356`.** Production on **303**.
**Gate:** `tsc` · **552 files / 6490 tests** · `next build` · **upgrade rehearsal PASS**.
Rendered locally before merge — 9 affected routes 200, zero errors. Verified live: `active`, `GET /` 401,
all four new columns present, zero errors since restart.

`9861b8a4` · `bd271009` · `d64d0df4` · `00307068` (partial), all `deployed`.

### ⚠️ `isolation: 'worktree'` BRANCHES FROM THE REPO'S CURRENT HEAD — WHICH HERE IS NOT `main`

The first parallel build put two of three agents on worktrees cut from `local/root-scratch` at `93c155d9`
— **the r91 handoff commit, 114 commits behind.** Only the third landed on current `main`. Caught before
merging, by checking the bases; a naive merge would have reverted large parts of the tree. The overlap was
7 files for one group and **13 for the other**, including `db/schema.ts`, `core/payroll.ts`,
`statutory-config-form.tsx` and all six locale catalogs.

**This is the `pwd` trap in a new costume.** This repo has many worktrees on different branches, and any
tool that resolves "the repo" to a single HEAD picks the root one. **Create the worktree yourself from
`main` and pass the path**, or check `git rev-parse HEAD` inside the agent's tree before trusting a line
of its output. Re-running both groups from correct bases cost ~35 minutes.

**PARALLEL AGENTS ALSO ALL PICK THE SAME NEXT MIGRATION NUMBER.** All three independently chose `0354`.
Assign them explicitly in the brief (`0354` / `0355` / `0356`) or integration is a renumbering exercise.

### THE GATE FOUND FIVE FAILURES, FROM THREE DIFFERENT CAUSES, AND EVERY ONE WAS A REAL SIGNAL

1. **My own `9861b8a4` write guard** — two fixtures turned Allow Negative Balance on with no floor, which
   the guard now forbids deliberately. Fixtures changed; the guard stands.
2. **`country-pack-drift`** — the statutory build imported `localization/my` directly from
   `app/admin/personnel/[employmentId]/actions.ts`, generic admin code. The ADR-0080 D1/D7 ratchet caught
   it, and its own message says *both lists only ever shrink; do not add debt* — so an allowlist entry was
   the easy WRONG answer. Repointed to `core/dependents`' `CHILD_RELIEF_CATEGORIES`: the identical five
   keys in the pack-neutral home where the Family register already stores them.
3. **`toil-floor-guard` ×2** — `00307068` re-anchors TOIL expiry from the worked date to the approval
   date, so an `AFTER_EXPIRY` constant derived from `REST_DAY` stopped meaning "after expiry". The test now
   READS the accrual's own `expires_on`. Anchor-agnostic, and it states the rule instead of an arithmetic
   that only held under the old anchor.

**(3) WAS THE CORRECT ALARM ON A LIVE DATA CHANGE.** `0354`'s backfill pushes every active accrual's expiry
LATER (`GREATEST`, so never earlier). The approved plan authorises it in as many words — *"expiry dates on
already-banked credits can move later or stay the same, never earlier. Nobody loses a day of leave"* — and
demanded a production count first.

### THREE PRODUCTION PRECONDITIONS READ RATHER THAN ASSUMED

Every one of these was a plan requirement that the building agent could not satisfy (no production access):

| precondition | plan's expectation | ACTUAL |
|---|---|---|
| employees whose OKU claim was silently cleared (`d64d0df4` step 1) | unknown, "hand the reporter the list" | **0** — the regression was real but never bit anyone |
| `employee_id_config` rows flipped by `0355` | unknown | **1** — the single active rule, `allow_manual_override=false` |
| `toil_accrual` rows extended by `0354` | "expected zero — verify, do not assume" | **0** — the table is empty |

`0355`'s flip is worth understanding: `allow_manual_override` was **dead config read by nothing**, so
manual entry worked regardless. Flipping it to `true` preserves today's BEHAVIOUR rather than the flag's
stored value. Leaving it would have silently forbidden manual entry for the only company with a rule.

### WHAT THE AGENTS CAUGHT THAT THEIR OWN APPROVED PLANS GOT WRONG

- **`00307068`** — the plan said `requested_on` could come from the most recent APPROVED attendance
  correction. It cannot: `maybeAutoAccrueOnApprovalTx` runs BEFORE the status flips
  (`core/attendance.ts:1992`), so inside that transaction the row is still `pending` and the lookup
  silently falls back to the worked date. The agent implemented the plan's way, caught it in review, and
  threaded the date from the caller. Verified independently.
- **`bd271009`** — the reporter's "manual Employee ID entry is not supported" is **INVERTED**; it has
  always worked (`core/org.ts:208-220`). The real gap was `allow_manual_override` being written, rendered,
  and read by nothing.
- **`d64d0df4`** — declined the plan's instruction to materialise unverified statutory figures into a saved
  override via `initState`, on the grounds that it defeats the sign-off it exists for. Correct call.

### ⚠️ A BACKGROUNDED COMMAND THAT PIPES ITS OUTPUT WILL HANG FOREVER

Two targeted `vitest` runs sat at **0.0% CPU for 58 and 46 minutes**, holding **zero** database
connections. Not the Postgres wedge — a blocked write to a stdout pipe nobody was draining, because the
tool call timed out and backgrounded them. An hour lost waiting on notifications that could never arrive.

**REDIRECT EVERY LONG COMMAND TO A FILE** (`> file 2>&1`), never rely on the pipe. This is the same lesson
as r124's "never pipe a gate through `tail`", which had been applied to the full gate but not to targeted
runs.

**How to tell a hang from slow work**, since the CPU number alone lies — a healthy run also idles low while
waiting on Postgres:

    ps -A -o pid,%cpu,command | grep vitest.mjs     # cpu alone is NOT the signal
    pgrep -P <pid> | wc -l                          # healthy: 10 workers.   hung: 0
    psql … -c "select count(*) from pg_stat_activity where datname like 'ai_hr_test%'"
                                                    # healthy: ~21.          hung: 0

### SMALLER THINGS

- The cluster was wiped twice more this round. `DROP DATABASE ... WITH (FORCE)` on leftover namespaced
  templates wedges the same way the rehearsal cleanup does — **wipe, do not try to drop them**.
- `00307068`'s HR configuration leg and all of `296fc027` are NOT built: both need
  `components/leave-type-panel.tsx`, fenced off this round because other work held it. They belong with
  the leave-engine cluster.
- The statutory build ships **seven unverified relief figures** (PwC, not LHDN) surfaced on
  `/payroll/configuration/pcb` as *Awaiting sign-off*, and recorded in `docs/architecture/STATUTORY-SOURCES.md`.
  **Name them in the release note** — they drive money withheld and remitted.

---

## r125 — 2026-08-03 — a live tax-relief bug, and the menu the reporter actually asked for

**Shipped:** `main@420b61d8`. **No migration** (production stays on 300).
**Gate:** `tsc` · **548 files / 6400 tests** · `next build`.
**Rendered locally before merge** — all 12 affected routes 200, zero errors, nav order confirmed.
`2e3ec77d` and `a324a4b3` both `deployed`.

### `2e3ec77d` — SAVING THE STATUTORY EDITOR WAS DELETING A TAX RELIEF, SILENTLY

`components/statutory-config-form.tsx` rebuilt `pcb.reliefs` as a FRESH object from the four fields the
form renders, with no spread of what it started from. The ruleset carries a **fifth** the payroll kernel
reads — `disabledIndividual` (`localization/my/statutory-tables.ts`), the further deduction a registered
disabled employee receives — and that screen has never shown it. So **every save through the editor
dropped it**, and because `localization/my/payroll.ts:373` reads it with a fallback to the pack default,
nothing errored: a tenant's corrected amount quietly reverted and the monthly tax of every flagged employee
moved the following month.

**Found by a PLANNING agent working on an unrelated item (`d64d0df4`), not by any test or by us.** Verified
against the tree before raising.

**The same file already carried a written warning about this exact hazard for the `ot` slice** — "Carry the
whole existing ot slice through unchanged … so a raw-editor save never drops overtime data" — and the
warning did not stop the reliefs being written the unsafe way three lines below it. **A comment did not
hold.** `test/statutory-relief-roundtrip.test.ts` now does, and it was run against the BUGGY code first,
where it fails. A test that cannot fail is worthless.

### `a324a4b3` rev3 — ALREADY BUILT; ONLY ITS PLACEMENT WAS WRONG

The reporter's contest reason WAS the spec: *"just relocate the Attendance button below My Attendance to
admin section between Leave Config and Claim Config."* The expandable menu the original ticket asked for
shipped in rev2. Only where it sat was wrong.

**⚠️ THE NODE COULD NOT SIMPLY MOVE, AND THIS IS THE REUSABLE PART.** The Administration sidebar group
carries `adminOnly` at **GROUP** level and the sidebar filters **group-first**, so a row inside it renders
for nobody but administrators *regardless of its own flag*. Moving the merged node intact would have
silently stripped `/attendance` from every plain employee and `/roster` + `/attendance/import` from every
non-admin manager — a permissions change nobody asked for, hidden inside a menu tidy-up.

Split three ways: **Records back to My Attendance** (self-service, no gate), **Roster + Import to flat
Manage rows** (`managerUp`, per-row gated there), **only the six `adminOnly` config screens travel**.

**`MODULE_OF_HREF` IS BUILT FROM THE NAV NODES' CHILDREN.** The two departing rows needed an explicit
`navLinks` line or they would have dropped out of the map and stopped being gated by the attendance module
entitlement — an un-gating hidden inside a menu move, the same class of mistake as the one above.

### NINE TESTS FAILED AND ALL NINE WERE RIGHT TO — including one that predicted this exact change

They pinned rev2's shape across `attendance-menu-relocation`, `attendance-pack` and
`sidebar-attendance-group`. One said, verbatim:

> *"If a future change moves this node into Admin, THIS is the test that must fail."*

It fired on precisely that move. **Rather than invert it a third time** (0bb0e303 → rev2 → rev3), it is
restated at the level it always meant:

> **A node in a wholesale-gated group may contain ONLY rows that gate at least that strictly.**

That is stronger than either previous form, survives the next regrouping, and is what would catch someone
dropping Records or a manager row back in later.

### THE BOARD: THE REPORTER APPROVED 17 ITEMS, INCLUDING ALL TEN THAT WERE RE-PLANNED

The narrow third pass (correct · disclose · do not rewrite) was worth doing — everything it produced was
accepted. **`8fec719e` was re-approved WITH its corrected data-impact disclosure**, so the reporter has
accepted that the rounding reset moves Annual and Compassionate balances DOWN for all 23 employees.

**Four NEW reporter items arrived during the session** and are unplanned: `7c834696` (attendance
calculation engine), `8590615a` (contract employment info), `2ef69d1e` (back pay / arrears), `169e3c24`
(individual payslip submenu).

**Still contested and NOT yet re-planned:** `7cd914b1` (drop the days cap in percentage mode — the
reporter's words settle the exact fork an earlier plan was refuted for asking about), `afd0a87c`,
`38f1fd40`, `645e67c4` (*"is not under leave configuration tab, what I meant is to place under leave
config module"* — the Replacement Leave placeholder shipped as a TAB and they want a sidebar entry).

---

## r124 — 2026-08-03 — the hotfix for a page r123 broke, and why nothing caught it

**Shipped:** `main@56f2c5e3`. **Migration `0353`.** Production on **300** migrations.
**Gate:** `tsc` · **547 files / 6392 tests** · `next build` · **upgrade rehearsal PASS**.
Verified live AND rendered locally — see below, because rendering is the whole point of this entry.

### ⚠️ r123 BROKE THE ENTITLEMENTS TAB IN PRODUCTION AND THE REPORTER FOUND IT BEFORE WE DID

`10e96227` put `ChipMultiSelect` — a `'use client'` component — directly into
`app/admin/leave/entitlements/page.tsx`, a SERVER component, and passed it `removeLabelFor` and
`countLabelFor`: closures over the server's translator. React cannot serialise a function across that
boundary, so it threw at RENDER and the tab returned "This page couldn't load" from the moment r123
deployed until this fix. Raised as `b55fdf33`.

**The idiom looked safe because every OTHER `ChipMultiSelect` caller lives inside
`components/leave-type-panel.tsx`, which is itself a client component** — where function props are
perfectly legal. The usage was copied without checking which side of the boundary it landed on.

### THE PART TO INTERNALISE: EVERY GATE STEP PASSED

| step | result | why it was blind |
|---|---|---|
| `tsc --noEmit` | clean | a function prop is well-typed |
| `next build` | clean | this is a RUNTIME serialisation error |
| 6389 tests | clean | they are static source scans + DB-backed behaviour tests. **Nothing renders.** |
| upgrade rehearsal | clean | it tests migrations |

A defect invisible to types, invisible to the build, and invisible to every test that does not render.
**The handoff has said since r91 that browser verification is "not optional" and that everything since r70
is unverified. r123 shipped a UI change and did not run it.**

**`test/server-client-boundary.test.ts` is the cheapest thing that CAN see it.** For every server file
under `app/` it finds JSX whose tag is a known client component and flags any prop whose value is an arrow
or function expression. **It was verified against the SHIPPED code before being trusted** — run over
`main`'s version of the page it reports `removeLabelFor` and `countLabelFor` at line 402. A test that
cannot fail is worthless, and that check took two minutes.

**The fix is `components/leave/half-day-company-picker.tsx`**, a client wrapper that calls
`useTranslations` itself so only serialisable data crosses. The form contract (`name="companyIds"`,
`defaultSelected`) is unchanged, so the action is untouched.

### RENDER VERIFICATION IS NOW DONE, AND IT TOOK FIVE MINUTES

`pnpm db:seed` then `PORT=3111 pnpm dev`, then curl each surface. Every leave route returns **200** with
**zero** errors in the dev log, and the half-day card renders its new labels:

    /admin/leave              200   487985b
    /admin/leave/entitlements 200   555858b   ("Half-day deduction", "Companies this applies to")
    /admin/leave/replacement  200   462246b   ("under development", "already works today")
    /admin/leave/approval     200   494143b
    /admin/leave/payroll      200   493182b
    /admin/leave/audit        200   515366b

**This is the recipe. It needs no browser extension and no production access.** There is no excuse for
shipping a UI change without it.

### `0353` — the schema half of 491c499f, shipped inert

`leave_adjustment_batch` + a nullable `leave_ledger.adjustment_batch_id`. Referenced by nothing yet.
It exists because **the ledger had no way to group a bulk adjustment**: the festive grant writes one
summary event whose `aggregate_id` is the TENANT, so afterwards the rows one action wrote cannot be found.
`core/leave-import.ts:298` has the same shape. 491c499f's approved plan requires reversal *as a unit*, and
an event alone cannot locate the rows.

Six CHECKs make the failure modes unrepresentable: a reason cannot be blank or `sys:`-prefixed (either
would misclassify the row in `classifyLedgerAdjustment`, which reads a NULL reason as `'config'`), days
cannot be zero, only an `adjustment` row may carry a batch, and a reversal cannot record a time without an
actor. **`leave_adjustment_batch` was added to the harness TRUNCATE list** — omitting it lets a batch
outlive its ledger rows across test files (the ADR-0071 leak the list's own comment records).

### THE BOARD IS FULLY PLANNED FOR THE FIRST TIME — 16 items planned this session

Ten contested plans were re-planned and pushed, each carrying a **`KNOWN OPEN POINTS FROM REVIEW`** block
in its build notes listing the objections that were NOT resolved, with citations. Six more were planned
from scratch. **Three of those six turned out to be ALREADY BUILT** — `a324a4b3`'s expandable Attendance
menu exists and merely sits in the wrong sidebar group; `bd271009` and `00307068` likewise.

**`a324a4b3` carries a trap worth reading before building it:** the admin sidebar group gates at GROUP
level, so moving the Attendance node into it wholesale would strip `/attendance` from every plain
employee's rail and `/roster` + `/attendance/import` from every non-admin manager. Its plan splits the node
three ways for exactly that reason.

### `8fec719e` WAS RE-PLANNED RATHER THAN BUILT, AND THE REPORTER RE-APPROVED IT

It was APPROVED, and its approved plan told the reporter *"leave already granted or taken is not
recalculated"*. **That is false.** `core/leave.ts:7221-7233` folds `roundingMethod` into the
entitlement-change comparison and the comment at `:7213` says outright that flipping the dropdown
re-figures every already-granted balance. `test/leave-entitlement-rounding.test.ts:346-440` already pinned
it. Closed prior years ARE protected; the current open cycle is not.

**The count the approved plan asked for and nobody took**, run before re-planning: 25 leave types, 23
already unrounded, **2 on Round Up (Annual Leave, Compassionate Leave)**, **all 23 employees hold a balance
on them**, and the reset moves those balances DOWN. Also corrected: the carry-forward percentage is
deliberately never rounded (`core/leave.ts:6096-6100`), so the plan's claim that the table decides what 3.5
becomes was wrong. And the approved plan's "second rounding_method column" warning pointed at
`pay_component` — payroll pay codes, a different domain. **The real second surface is the legacy
`leave_policy.accrual.roundingMethod` JSONB, 58 rows still `'up'` on production.**

### THE RE-PLANNING WORKFLOWS: 34 AGENTS, TWO ROUNDS, ZERO SURVIVORS — AND WHY A THIRD WAS NOT RUN

Round 1 refuted 7 of 10. Round 2 revised those 7 and re-verified all 10: **0 survived.** That is not a
mis-calibrated judge — the round-2 verifiers confirmed round-1 fixes had LANDED (`38f1fd40` restored its
dropped minus sign, `c459bff9` deleted a dependency on an item that had already shipped) and then found
DIFFERENT, deeper defects: 90 concerns, only 13 self-labelled minor. **Each pass reads deeper. It did not
converge and there is no stopping rule.**

What finally worked was a THIRD workflow with a NARROW, CONVERGENT brief — *correct what is verifiably
wrong, disclose what you cannot resolve, do not rewrite* — and it produced the plans that shipped. **It
also caught the reviewers being wrong**: `4b0e76ae`'s notes record that a claimed `yearLabel` collision
does not exist (three different namespaces) and that a claimed "16 files" grep returns 13.

**Lesson: an adversarial verifier told to "default to refuted" can never clear anything. Gate on SEVERITY,
not on a boolean, and give the final pass a brief it can finish.**

### SMALLER THINGS

- **The cluster was wiped FIVE times this session.** Fresh: full chain in 2.5-3.1s, template 1.1s. Wedged:
  `du -sh` on the data dir hangs past 120s. **The rehearsal's cleanup `DROP DATABASE ... WITH (FORCE)`
  wedges on `CheckpointStart` every time** — the verdict is printed BEFORE it, so a hung cleanup after
  `UPGRADE_REHEARSAL=PASS` is not a failed rehearsal.
- **NEVER run a second vitest while a gate is in flight.** Doing so wiped a running gate's 10 worker DBs
  and cost an 18-minute run. The `TEST_DB_NAMESPACE` rule applies to the main session, not just subagents.
- **Never pipe a gate through `tail`.** A run that fails becomes unreadable — the first attempt lost the
  list of 14 affected files that way.
- The `pwd` trap bit twice more, once writing to the wrong worktree. Put `cd <path> &&` in EVERY command.

---

## r123 — 2026-08-03 — five approved items, and two of them were not what the tickets said

**Shipped:** `main@db05087a`. **Migration `0352`.** Production on **299** migrations.
**Gate:** `tsc` · **546 files / 6389 tests** · `next build` · **upgrade rehearsal PASS**.
Verified live: `active`, `GET /` 401, `/login` 200, both new columns + all four CHECKs present, all 25
leave types NULL in both (inert until configured). rsync dry-run clean except `next-env.d.ts` — untracked,
regenerated by the server's own build, see the note below.

`645e67c4` · `10e96227` · `e4238594` · `bc512dc3` · `ad9cb5c5`, all `deployed` with `build_ref`.

### TWO ITEMS WERE MIS-SPECIFIED BY THEIR OWN APPROVED PLANS, AND BOTH MATTER

**`10e96227` WAS NOT PRESENTATION-ONLY.** Its plan said so, and the stored shape really is unchanged (one
boolean per company). But turning N forms into ONE authoritative Save gave the write a reach the per-row
form never had. `listCompanies(s)` is tenant-wide while the company UPDATE policy is admin-for-company, so
a company-scoped `hr_admin` can SEE companies it cannot write. Under the old UI that made one row's Save a
silent no-op; under a set-write it is worse in BOTH directions — an unadministrable company omitted from
the post looks like a deliberate "turn this off" that never lands, leaving screen and database disagreeing.
`setLeaveHalfDayFullDeductionCompanies` now resolves its own `app.is_admin_for` candidate set in SQL, and
the picker offers exactly that set. Two tests pin it and **both failed before the fix**.

**NO MASTER ENABLE SWITCH, deliberately against the plan's wording** ("one enable switch and a
multi-select"). The schema stores exactly a set of companies, so an OFF switch would have to mean "all
false" — after which a reload cannot distinguish it from an empty selection and any remembered selection
evaporates. The empty selection already says "applies nowhere". Select all / Clear all give the same reach
without inventing a state the database cannot hold.

**`bc512dc3`'s PREMISE IS FALSE, AND THE PLAN INHERITED IT.** "Yes lets an employee go below zero with no
floor at all" is true only at SUBMISSION. `allow_negative_balance` relaxes the submit-time gate; the
approval path refuses whenever `balance - need < 0` (`core/leave.ts:3386`) **without ever consulting the
flag**. So a balance cannot go negative through the ordinary request-and-approve flow at all — the negative
balances that exist got there via adjustments or expiry. `test/leave-application-limit.test.ts`'s own
fixture comment had documented this since c6ffa725; nobody had connected it to the switch.

The floor is therefore enforced at submit and edit, where the switch binds, and **deliberately NOT at
approval**, where it would be dead code behind a strictly stronger rule and would read as enforcement while
enforcing nothing. **The approval gate was NOT relaxed to make the feature "work"** — that would let
balances go negative on every type that already has the switch on, which nobody asked for. Raised as
`9861b8a4` with one recommendation and the blast radius stated.

### `0352` REFUSES THE HALF-CONFIGURED PAIRS IN THE DATABASE, NOT ONLY IN THE FORM

Four CHECKs: an unrecognised period · a period with no ceiling · a zero-or-negative floor · a floor with no
permission to go negative. **Zero is refused on purpose** — "may go negative, but not by any amount" is what
the switch being off already says, and one policy with two representations is something the engines can
disagree about. The floor stores a POSITIVE magnitude (2.5 ⇒ may not pass −2.5) because a business user
types a magnitude, and a column that sometimes holds −2.5 and sometimes 2.5 is how a sign error becomes a
silent doubling.

`max_days_per_leave_year` keeps its name while its period becomes configurable. Ugly, deliberate: renaming
an applied column costs a second migration, a rewrite of every reader, and a window where the two names
disagree. **`applicationLimitWindow` is PURE** so the period arithmetic is testable without a fixture — and
the anniversary leave year turned out to be MONTH-anchored (`earnedCycleStart` returns the 1st of the hire
month, not the hire day). Asserted as the real value, not the intuitive one: that window is shared with the
accrual paths and "fixing" it would move all of them.

### A SECOND LIVE BUG, FOUND BY A PLANNING AGENT AND UNRELATED TO ANY TICKET

`components/statutory-config-form.tsx:186-192` rebuilds `pcb.reliefs` as a FRESH object from four form
fields with **no spread of `base.pcb.reliefs`**, so every save through the advanced statutory editor drops
`reliefs.disabledIndividual` (7000, `statutory-tables.ts:98`). `payroll.ts:373` reads it with a fallback to
the built-in default, **so the loss is SILENT** — a tenant's customised figure quietly reverts. The same
file at `:180-184` documents exactly this hazard for the `ot` slice, so the pattern was known and missed
here. Verified against the tree before raising. Raised as `2e3ec77d`, asking whether any company has
already lost a figure.

### ⚠️ THE `pwd` TRAP BIT AGAIN, TWICE, AND ONE WAS A WRITE TO ANOTHER WORKTREE

The shell cwd reset to the repo ROOT mid-session. A `rm -rf .next` and a python rewrite of
`test/leave-type-setup-stay.test.ts` both landed on `local/root-scratch` instead of `build/r123`. Caught by
`git status` in the root, reverted, reapplied in the right worktree. **r122 recorded this as having bitten
four times in one night; it is now six.** The only reliable defence is what r122 already prescribed: put
`cd <path> &&` in EVERY command, not just gate runs — cwd does not persist reliably between tool calls.

### ⚠️ NEVER RUN A SECOND VITEST WHILE A GATE IS IN FLIGHT

Mid-gate I ran a targeted 2-file verification. It wiped the running gate's 10 worker DBs and invalidated an
18-minute run. This is exactly what the `TEST_DB_NAMESPACE` rule in "Running builds with subagents" warns
about, and it applies to the MAIN session too, not just parallel agents. One vitest at a time, or namespace it.

**The invalidated run still earned its keep**: it surfaced the round's only two real regressions, both mine
and both the same shape — **a COMMENT naming an identifier that a static guard forbids appearing ANYWHERE in
the file**. `leave-approval-page-restructure` forbids the retired base-chain action's name; my comment cited
it as precedent. `leave-type-config-categories` requires each sub-form marker inside its category card;
extracting `NegativeBalanceForm` moved the marker above every CardTitle. Both guards are RIGHT to be that
blunt — a caller-less server action is still an addressable endpoint. Fixed in `6fd6bf44`, and the actions
file now says why the identifier is deliberately unspoken.

### THE GATE TOOK THREE RUNS. TWO WERE LOST TO THE ENVIRONMENT

| run | result | cause |
|---|---|---|
| 1 | 24 failed | ALL `Hook timed out` in `resetDb()`. Zero assertion failures. Piped through `tail -30`, so the 14 affected files were unreadable — **never pipe a gate through `tail`** |
| 2 | invalidated | my own concurrent vitest wiped its worker DBs |
| 3 | **546/546 green** | fresh cluster, single instance, full output to a file |

**The cluster was wiped THREE times this session** and the difference is stark: full migration chain from
zero in **2.5-3.1s**, template in 1.1s. Wedged, even `du -sh` on the data dir hung past 120s. **The rehearsal
also wedged** — `DROP DATABASE ... WITH (FORCE)` on `CheckpointStart`, the r83/r97 signature. PG16's
WAL_LOG strategy fixed CREATE, **not DROP**. After the wipe the rehearsal passed first time.

### BOARD: THE REPORTER WENT THROUGH EVERYTHING WHILE WE WERE NOT LOOKING

The r122 note "no buildable work left, 18 planned" is **stale**. Counted 2026-08-03: **9 approved**
(5 shipped here), **10 contested**, 0 open, 0 blocked. Most contest reasons are the reporter REAFFIRMING —
`6e9a126e` ("Yes, this is exactly the architecture I want"), `c459bff9`, `38f1fd40` and `4b0e76ae` all
authorise resets they had previously been warned about.

**FOUR APPROVED ITEMS ARE STILL UNBUILT and each is gated:** `8fec719e` (rounding table) waits on
`7cd914b1`, which is now CONTESTED · `56910869` (Override framework, absorbs `65f466e2` + `fef49b9a`) ·
`491c499f` (Adjustments submenu, must ship BEFORE `38f1fd40`'s removal) · `93249794` (Generate Entitlement,
whose own build notes say wait for `6e9a126e`'s eligibility layer or you build a second criteria engine).

### ⚠️ THE 10 CONTESTED ITEMS WERE RE-PLANNED TWICE BY AGENTS AND **NOTHING WAS PUSHED**

Two workflow rounds, 34 agents, ~3.2M tokens. Round 1: 10 drafts, adversarial verify refuted **7**.
Round 2: revised those 7, verified all 10 — **0 survived**.

**That 0/10 is NOT a mis-calibrated judge, and this is the part worth knowing.** The round-2 verifiers
explicitly audited round 1 and confirmed the fixes had LANDED rather than being reworded around
(`38f1fd40` restored the dropped minus sign, `c459bff9` deleted its false `7cd914b1` dependency,
`6e9a126e` added the missing `core/analytics.ts` reader). They then found DIFFERENT, deeper defects — 90
concerns, only 13 self-labelled minor. Real ones: `fef49b9a` silently corrupts balances on whole-request
cancellation (a path no draft enumerated); `65f466e2` still asks the reporter to choose, which the board's
approve action can never answer; `d64d0df4` surfaced the live `statutory-config-form` bug above.

**Each pass reads deeper and finds different things. Two rounds did not converge and there is no stopping
rule, so the loop was stopped rather than run a third time.** Pushing plans a non-technical reader approves
on trust, while holding a list of code-cited destructive defects against each, is not defensible.

**Drafts and critiques are preserved** at the session scratchpad (`round1.json` + both workflow outputs).
The next attempt should treat these as four separate problems, not one batch: the four blocking items
(`fef49b9a`, `bc36c768`, `38f1fd40`, `65f466e2`) each need a focused pass WITH the findings as input;
the six "serious" ones need their remaining objections resolved individually; and `6e9a126e` — the
architecture redesign — wants a design conversation with the owner before any plan reaches the reporter.

### SMALLER THINGS

- **`next-env.d.ts` drifts after every deploy** and always will: it is UNTRACKED, rsync copies it anyway,
  and the server's `next build` rewrites `.next/dev/types` → `.next/types`. Benign. Worth adding to the
  rsync excludes so "zero drift" stays a clean signal.
- The `improve` CLI's `raise` needed the reporter employment id from a `pull` payload; the two operator
  items above carry `CLAUDE AI` automatically via `OPERATOR_REPORTER_LABEL` (0348).
- `app/admin/leave/replacement` is registered as a ROUTE on the existing `leaveConfig` screenKey, not a new
  one — same guard, same surface (the `/admin/personnel` precedent). An empty page still gets `requireAdmin()`.

---

## r122 — 2026-08-03 — slice 10: the usage read model, leading with staleness

**Shipped:** `main@8226a582`. **No migration.** **Gate:** `tsc` · **543 files / 6354 tests** ·
`next build`. Verified live: `active`, `GET /` 401, `/login` 200, rsync dry-run zero drift.

Reads on the PLATFORM pool (r120's role), not the owner connection — a read-only dashboard must not
hold the power to rewrite the schema. `pnpm platform:usage` once `PLATFORM_DATABASE_URL` is set.

**STALENESS IS THE HEADLINE.** No `aihr` timers exist, so the meter has never run on a schedule. A
confident total over data that stopped updating weeks ago converts a VISIBLE absence into an invisible
one. Each tenant is summarised at ITS OWN latest capture and carries `daysSinceCapture`; adding a
tenant metered yesterday to one metered five weeks ago is r118's mixed-currency mistake in another
costume. `countMissingDays` is exported and tested without a database — usage cannot be backfilled.

### ⚠️ THE `/platform` WEB PAGE IS DELIBERATELY NOT BUILT

`platform_user` is not `app_user` (D5), so a `/platform` route group **cannot reuse the tenant
session**: it needs a platform identity, a deny-by-default guard, and every view appended to
`DomainEvent`. A route group that is deny-by-default in INTENTION but not in FACT is a cross-tenant
leak — the single failure slice 7 exists to prevent. The read model ships first; the page is built on
top of it deliberately. **This is the next slice-10 step.**

### A MISTAKE WORTH RECORDING: `git commit --amend` LANDED ON THE WRONG BRANCH

The shell cwd had reset to `mainwt`, so an amend intended for `build/r122` rewrote **main's HANDOFF
commit message** into r122's. Caught immediately, both restored, no content lost. **This is the same
`pwd` trap that cost a full suite run earlier in the session** — it has now bitten four times in one
night, twice on plain `cd`, once on a background compound command, once on an amend. **Check
`git branch --show-current` in the same command as any commit/amend/merge, not just gate runs.**

---

## r118-r121 — 2026-08-03 — slices 6, 7, 8 and 9 (four rounds, all deployed)

**Shipped:** `main@f27de7e3` (r118) · `9d28f2a5` (r119, `0350`) · `e3f4bf1d` (r120, `0351`) ·
`1b9bf4c4` (r121). Production on **298** migrations. Each verified live: `active`, `GET /` 401,
rsync dry-run zero drift.

### r118 — SLICE 6: A TOTAL OVER MIXED CURRENCIES IS NOT A NUMBER

Two live faults, found by sweeping what r115 fixed for the OT report:
- **`listUnattachedGroups` spans EVERY company in scope** and its grand total added the amounts blind,
  printing one unlabelled figure. Now per-currency subtotals. `lib/money.ts` is a REFUSAL, not a
  formatter: it exposes no `grandTotal` and **a test asserts that absence**, because the moment it can
  return one number the fault is back. An unknown currency is its own bucket — treating absent as
  "same as the others" is exactly how a foreign row joins a ringgit total.
- **`complianceWorklist` emitted MALAYSIAN CP22/CP22A for every company**, telling a non-Malaysian
  company it had a statutory filing obligation with a due date. Now gated on the company's pack (r111).

**NOT swept, deliberately:** the EPF/SOCSO/EIS/PCB/SKBBK config screens. Those render the figures OF a
Malaysian ruleset — the ringgit is part of what the table IS. Relabelling them would make them wrong.

### r119 — SLICE 9: CLOSURE, AND A REACTIVATION THAT REPAYS FROZEN TIME

Closure is dual-controlled **in the database** (`tenant_closure_dual_control_check`), so single-person
closure is unrepresentable rather than merely refused, plus a retention check.

**Reactivation implements r108's asymmetry rather than papering over it.** Accrual self-heals; both
expiry sweeps compare a STORED DATE to today, so a plain re-run forfeits everything whose date fell
inside the window — days the employee could not use because their employer was late paying.
`shiftExpiryForSuspension` moves those deadlines by exactly the frozen days: not waived, MOVED. An
expiry that lapsed BEFORE the suspension is untouched — reinstatement is not a second chance.

`tenant_suspension_window` opens in the SAME transaction as the suspension, ON CONFLICT DO NOTHING
against a one-open-window-per-tenant index (two would double-count and hand back twice the leave).
`replayPlan` collapses repeats — forty skipped nights is ONE replay, not forty forfeits.
`scripts/reactivate-tenant.ts` is report-only, REFUSES to reinstate a closed tenant, and does NOT run
the sweeps — it prints the plan.

### r120 — SLICE 7: THE PLATFORM PLANE GETS THE ROLE ITS DESIGN RESTS ON

**The table side of D5 has been right since 0313** (platform_user, RLS, revoked from ai_hr_app). What
was missing was the IDENTITY: **`ai_hr_platform` appeared in ZERO files** — a table nobody could read
and no role to read it with. bootstrap-db.sql creates it (BYPASSRLS, NOSUPERUSER); 0351 grants an
ENUMERATED list, never `ALL TABLES`; `db/platform.ts` is the only pool that connects as it.

**NO FALLBACK, and that is the design.** Unset ⇒ throws. Falling back to `DATABASE_URL` gives a
silently POWERLESS plane; to the owner URL, a silently OVER-PRIVILEGED one. It also refuses a URL
IDENTICAL to either — that copy-paste satisfies "is it set?" while removing the boundary.
`tenant` is READ-ONLY from the pool: suspension is dunning's alone, closure is dual-controlled.
0351 also FORCEs RLS on platform_user — 0313 only ENABLEd it, which the table owner still bypasses.

**`deploy/systemd/` NOW EXISTS: 5 services + 5 timers + a README. NOTHING IS INSTALLED.** A test
asserts `deploy.sh` never enables a timer — scheduling must not be a side effect of shipping.
`apply-dunning` ships WITHOUT `--apply`, so enabling it reports and suspends nobody.

### r121 — SLICE 8: THE AUDIT CHAIN STOPS BEING DISARMABLE

⚠️ **THE CHAIN HAS NEVER BEEN ARMED IN PRODUCTION.** Counted before shipping: **5707 events, ZERO
chained**, no tenant with a chain, `AUDIT_HASH_CHAIN_ENABLED` unset. Every warning, the deploy
preflight and the verifier's `unchained` count all guard a chain that was never switched on. **Arming
it is an owner decision and effectively one-way.**

`audit.hash_chain_enabled` on the tenant snapshot is the decision now; env survives only as the
fallback for an unresolvable setting. **Disarming a tenant WITH chained history is REFUSED** — it would
append events outside the chain, which `verifyTenantChain()` cannot see (it filters
`chain_seq IS NOT NULL`), so re-arming closes contiguously over the hole and the DPO page renders
"intact". No backfill can heal it. An unresolvable setting also fails ARMED (a sweep carries no
snapshot — r108).

**THE OLD TEST CAUGHT IT, WHICH IS HOW IT SHOULD GO.** `test/audit-hash-chain.test.ts` pinned the hole
itself and now observes `[1..7]` instead of `[1,2,3,4]`. Rewritten to assert the refusal, NOT deleted —
and the verifier's blindness stays pinned by the test below it, which makes an unchained row directly.

**No DB lookup added to `withTenant`** — it opens every transaction in the product. The cache is a
process Set seeded by ARMING, sound because `domain_event` is append-only.

---

## r117 — 2026-08-03 — 7cd914b1: carry forward on every leave type, and a percentage of the balance

**Shipped:** `main@c8b5da89`. **Migration `0349`** (production now on **296**).
**Gate:** `tsc` · **538 files / 6274 tests** · `next build` · **UPGRADE_REHEARSAL=PASS**.
Verified live: `active`, `GET /` 401, `/login` 200, rsync dry-run **zero** changed files, and on
production **0 leave types carry a percentage** — i.e. nothing changed for anyone, which is the point.

### THE ANNUAL-ONLY ASSUMPTION WAS IN FIVE PLACES, not the one the plan predicted

The build notes named `openLeaveYear` and the panel's hidden `carryForwardMax=0`. Both were real; three
more were not in the plan and each would have shipped a live defect:

| where | was | what it would have done |
|---|---|---|
| `openLeaveYear` | `t.code === 'ANNUAL' && carryEnabled(pol)` | no non-annual type could carry |
| `accrueEarnedLeave` 2D-3 | `type.code === 'ANNUAL' ? pol.carryMax : 0` | earned + lump-sum types would disagree |
| `expireCarriedLeave` | `carryMax <= 0` short-circuit | **percentage carry would never expire** |
| `resolveCarryBreakdown` | `carryMax > 0` gate on the expiry DATE | percentage carry immortal on screen too |
| `core/read.ts` breakdown | `type.code === 'ANNUAL' ? carryMax : 0` | **the report would contradict the ledger** |

**All five now call ONE `carryAllowanceFrom`** (`core/leave-compute.ts`), and `carry_forward_percent`
joined **`leaveTypeRuleColumns`** so the twelfth rule cannot be hand-copied wrong at the eight query
sites. This is the one-composition invariant `core/leave.ts` warns about at `:6651`, `:6016` and `:6586`
— engines that re-derive the same rule are how the grant path and the projection kernel come to post an
oscillating delta.

### PERCENT AND MAX ARE A CLAMP, NOT A MODE

Percentage resolves first, `carryForwardMax` is a CEILING on it, `min()` of the two. There is
deliberately **no mode column**: two independent settings that can disagree is the shape `9816a5ad`
consolidated away, and `min()` cannot produce a figure neither setting authorised. Three layers guard
the range (DB CHECK on 0..100, the service validator, and the resolver's clamp) because the failure is
silent and lands in the ledger.

**NOTHING CARRIES DIFFERENTLY UNTIL A SETTING CHANGES**, and that is the load-bearing test in
`test/carry-forward-percent.test.ts` — not the percentage arithmetic. Every non-annual type has
`carryForwardEnabled` NULL and `carryForwardMax` 0, so `carryEnabled()` is false and the allowance is 0,
byte-identical to the old branch.

### A JUDGEMENT CALL: THE SICK/HOSPITALIZATION CARVE-OUT IS NOW CONFIGURATION, NOT CODE

`openLeaveYear` hardcoded those two to zero carry citing EA s.60F. That exception is gone — it is now
expressed as their configuration, following **`fa3f4ccb` rev 5**, where the configured figure wins and
the statutory position is a warning rather than a silent override. Behaviour today is IDENTICAL (both
are unconfigured). It becomes the owner's decision only if they deliberately switch it on.

### TWO PINNED ASSERTIONS WERE SUPERSEDED, and the conflict was checked rather than flipped

`carryCapLabel` gains "(days)" — the reporter asked for it once a percentage field sits beside it.
**`37a1141e` had deliberately pinned that wording**, so the conflict matters: that rule was about
keeping the forward-looking SETTING worded differently from the "Brought Forward" RESULT. A unit is not
a rename and the phrase survives, so the distinction holds. The other is the whole-set overlay now
emitting `carryPercent`.

---

## r116 — 2026-08-03 — a planning pass that drained the board, and `reporter_label`

**Shipped:** `main@dfb6050d`. **Migration `0348`** (production now on **295**).
**Gate:** `tsc` · **537 files / 6254 tests** · `next build` · **UPGRADE_REHEARSAL=PASS**.
Verified live: `active`, `GET /` 401, `/login` 200, `rsync -azi --dry-run` **zero** changed files,
and on production `migrations_applied=295`, `reporter_label` set on **15 of 578** items, all `CLAUDE AI`.

### THE PLANNING PASS — 8 items, and the board went to 0 open / 0 contested

Four contested items each carried a plain answer from the reporter, so all four were cheap rev-2s:
- **`afd0a87c` — ALREADY WORKS, nothing to build.** The reporter withdrew the removal; their real concern
  (HR admin cancels leave from Employee Leave Record, found by employee name) is live at
  `app/leave/employee-records/page.tsx:412` + `core/leave.ts:4373`. Approved REPLACEMENT is deliberately
  refused there — `consumeReplacementLeaveTx` has no inverse.
- **`e4238594`** — the "leave a link behind" bullet dropped, as asked. r107's correction carried forward:
  it strands NO approval rule.
- **`8fec719e`** — narrowed to exactly two options + a full reset to no-rounding.
- **`c33d9bbb`** — the reporter's deferral recorded so it leaves `contested`.

### ⚠️ `4b0e76ae` IS A TRAP: REMOVING LEAVE YEAR CONFIG REMOVES THE ONLY WAY TO OPEN A LEAVE YEAR

`setLeaveYearStatus` → `openLeaveYear` (`core/leave.ts:5249`, `:5729`) is what grants every employee the
year's entitlement AND runs carry forward (the cap forfeit, `sys:carry_forward_cap`). **The standalone
`openLeaveYearAction` (`app/admin/actions.ts:1058`) HAS NO CALLER** — grepped across `app/` and
`components/`, and no script calls it either. The Start button at
`app/admin/leave/entitlements/page.tsx:557` is the sole trigger. This is the r106/r100 caller-less-action
shape INVERTED: there a wanted action had no screen, here the screen is the sole caller of a wanted engine.
**Re-home the button before deleting the section.**

Two further corrections in that plan: `leave_year_config` is keyed **(tenant, year)**, not per leave type
(`db/schema.ts:5121`), so "remove it from all Leave Types" describes something that does not exist; and the
future-year application gate (`core/leave.ts:2104`) reads an ABSENT row as **not open**, so deleting the
table while leaving the gate would REFUSE all future-year applications rather than allow them. No FK points
at `leave_year_config.id` (the ledger keys by integer year), so the reset cascades to nothing — this is
NOT the `38f1fd40` shape.

### `6e9a126e` — THE ENTITLEMENT REDESIGN'S PREMISE IS WRONG, AND THE CENSUS SAYS WHY

The three layers the reporter drew ALREADY EXIST. Service bands are **not** hardcoded to `<2 / 2–5 / 5+`:
`ServiceBand` (`core/leave-compute.ts:131`, validator `core/admin.ts:909`) already takes arbitrary
contiguous ranges with per-band `days`, `carryForwardDays`, `maxBalanceDays` and expiry — their proposed
table column for column. It reads as hardcoded because **all 292 tables use exactly 3 bands**.

**Production census (read-only):** `benefit_scheme 41` · `grade_group 16` · `job_grade 55` ·
`scheme_leave_entitlement 292` · `leave_policy 67` (65 company-scoped, 64 grade-scoped) ·
`employment 23`, of which **0** carry a manual `benefit_scheme_id` · `leave_type 25` · `company 8`.
**359 pieces of entitlement configuration for 23 employees.**

The real defect is CARDINALITY: `scheme_leave_entitlement` is uniquely keyed
`(tenant, benefit_scheme_id, leave_type_id)` (`db/schema.ts:1517`), so a band table cannot be shared —
41 schemes × 25 types is the 292. Stage 1 is a named REUSABLE template. Zero manual overrides makes the
switch-over far safer than it looks.

### A MISTAKE WORTH RECORDING: A FABRICATED UUID WROTE A DANGLING EVENT TO PRODUCTION

The first `push-plan` of the pass was aimed at a **typed** id (`afd0a87c-8f77-…`) rather than one read from
the pull. `pushPlan`'s UPDATEs matched nothing, but its `domain_event` INSERT is UNCONDITIONAL, so
`ed0ae010-ca7d-49fb-9773-f42ebfa8a908` is a `feedback.plan.drafted` event whose `aggregate_id` matches no
`feedback_request`. **Left in place deliberately** — `domain_event` is hash-chained and deleting a row is
worse than one orphan with no reader. **Never type a feedback id; resolve it from the pulled JSON.**

### TWO GATE TRAPS BIT AGAIN IN THIS ROUND

**The `pwd` trap cost a 10-minute suite run** — the shell had reset to `mainwt`, so `main` was gated
instead of `build/r116`. Caught by reading vitest's own `RUN` line, which is the only reliable check.
**The Postgres wedge recurred on a FRESH cluster**: `DROP DATABASE … WITH (FORCE)` stuck at
`CheckpointDone` with `pg_stat_bgwriter` frozen. Wiping a second time cleared it, because an EMPTY cluster
has no template to drop — `template migrated in 1.3s, 10 worker DBs ready in 4.3s`. **Wipe, do not wait.**

---

## r115 — 2026-08-02 — slice 6: the OT report resolves per company, and labels its currency

**Shipped:** `main@65384457`. **No migration.** **Gate:** `tsc` · **536 files / 6250 tests** · `next build`.

**THE PLAN'S LINE REFERENCE WAS STALE — verify before building.** It said to fix
`core/reporting.ts:351-358`; that is `recentReports` today and per-company pack resolution was ALREADY
correct there. The real seam was the overtime report, found by reading rather than by trusting the plan.

**WHAT IT DID, in its own words:** *"All companies in scope share the tenant-wide ruleset; resolve via the
pack of the first company that has one"* — literally
`emps.find((e) => packFor(e.country))?.country`. With MY the only pack that is byte-identical. **With
two, a report spanning a Malaysian and a Singaporean company applies ONE jurisdiction's overtime
multipliers and wage ceiling to BOTH**, computing foreign employees under Malaysian rules and presenting
the result as theirs. The same harm D-14 exists to prevent, arriving through a report instead of a
mis-keyed country field.

Resolved once **per DISTINCT COUNTRY** — not per employee, so a 500-row report still issues one
`loadRuleset` per jurisdiction rather than 500.

**THE EXPORT HEADER WAS A HARDCODED LIE: `'OT amount (RM)'`**, over a bare number, for every company
regardless of where its employees work. Two currencies could be summed in a spreadsheet with nothing on
screen to say otherwise. The amount now carries its company's own currency in its own column, so a
mixed-currency export is **visibly** mixed (D-9).

**A packless company still reports** — with the documented fallbacks and a stated zero rather than an
omission. r111's non-statutory tier makes that a legitimate state, not an error, and omitting those
employees is how a report quietly under-reports a workforce.

**The tests register a second country pack with different multipliers**, the only way to tell the fix
from the bug before a real second pack ships — **including an order-independence case**, because the old
bug was literally "the first company that has a pack" and a report sorted differently would have
imposed the foreign ruleset on the Malaysian company instead.

---

## r114 — 2026-08-02 — `usage:capture` gets a package.json script

**Shipped:** `main@dd6f4f7c`. **No migration.** **Gate:** `tsc` · **535 files / 6243 tests** · `next build`.

An omission from r113 caught while running the meter on the server: `leave:accrue`,
`leave:expire-carry` and `review:sweep` all have a `package.json` entry and the new meter did not.

**RUNNING A SWEEP OVER PLAIN SSH NEEDS `/opt/node20/bin` ON PATH.** The box's default `node` is
**v18.19.1 at /usr/bin/node**, which predates `--env-file` — so
`ssh … 'node --env-file=.env.production …'` fails with **"node: bad option: --env-file"**, which reads
like a broken script rather than a PATH problem. `deploy.sh` prepends `/opt/node20/bin` itself, which is
why migrations and backfills work there. From an interactive ssh, prefix it:

    cd /opt/ai-hr && PATH=/opt/node20/bin:$PATH node --env-file=.env.production --import tsx scripts/<x>.ts

---

## r113 — 2026-08-02 — slice 10: the usage meter starts recording

**Shipped:** `main@29c5c1db`. **Migration `0347` — production now on 294.** **Gate:** `tsc` ·
**535 files / 6243 tests** · `next build` · **`UPGRADE_REHEARSAL=PASS`**.
**Proven against production:** 8 snapshot rows, and the 22 active employments it reported were
**cross-checked by direct SQL** (23 rows total, 22 active today) rather than taken on trust.

**`usage_snapshot` had existed since slice 1 with NOTHING writing to it.** Usage is not
reconstructable — headcount changes, draft payslips go with their batches, modules come and go — so a
later decision to bill on past usage would have had nothing to re-derive from.

**IT OVER-CAPTURES ON PURPOSE.** The pricing unit is still open (plan §7.1), so the row carries
per-company grain, country, headcount, users, payslips and the active module set. Every plausible unit
stays derivable; picking one first and capturing only that would foreclose the others.

**`payslipsGenerated` IS A DAILY DELTA, NOT A RUNNING TOTAL** — the one field whose name misleads. A
month is the SUM of its days, which **degrades gracefully across a missed day**; a running total would
make a month the difference between two snapshots, and missed days are expected here (a cron that did
not fire, a tenant skipped for standing). There is a test for exactly that.

**Counted in MYT.** `payslip.created_at` is a timestamptz and the sweep runs in the small hours, so a
UTC comparison would file the first eight hours of every day under the day before — the r92 trap.

**Migration 0347** adds the `(tenant, company, day)` unique index that makes the upsert mean anything —
the **r102 lesson that `ON CONFLICT` needs a target**. `DO UPDATE`, not `DO NOTHING`: an operator
re-running after fixing data must see the fix land.

**TWO BUGS CAUGHT BY RATCHETS RATHER THAN BY ME, and both are the system working:**
1. I filtered module grants on `status='active'`, silently dropping **TRIAL** — exactly the tenants a
   conversion decision is about. `core/entitlements.ts:422` treats `('active','trial')` as enabled; the
   meter now matches. **One rule, two readers.** Surfaced by a CHECK constraint rejecting my fixture.
2. The **leave-pack import ratchet** refused a new `core/leave` importer. `todayInKualaLumpur` now comes
   from `lib/hr-date` (the r105 precedent). **The allowlist was NOT widened** — it only ever shrinks.

`test/job-run.test.ts` also pinned the registry at exactly four sweeps and failed when I added a fifth.
That is the assertion doing its job: a new sweep cannot land without its i18n strings and run-log wiring.

**NOT SCHEDULED — and here the usual caution cuts the other way.** For r105 and r108 an unscheduled
sweep was harmless. **This one bleeds:** every unscheduled day is permanently unbillable. Suggested
`Daily — 01:00`, ahead of the 02:00/03:00 leave sweeps so it meters the day before they mutate it.

---

## r112 — 2026-08-02 — the test-template fingerprint covers the migration journal

**Shipped:** `main@a3fbe992`. **No migration.** **Gate:** `tsc` · **534 files / 6224 tests** · `next build`.

**TWO STEPS, and only the second was unguarded.**

**Step 1** — `0346.sql` added with no `_journal.json` entry. drizzle applies what the JOURNAL lists and
never walks the directory, so it did not run. **`test/migration-journal-ordering.test.ts` already catches
this** (r79, "a journal entry for every .sql file on disk"). It did not fire because I ran only the new
test FILE at that point, not the suite. **The guard worked; I did not consult it.** My first report to the
owner said this guard was missing — that was wrong, and corrected here.

**Step 2 — THE EXPENSIVE ONE, and genuinely unguarded.** After adding the journal entry the fingerprint
did NOT change, because `templateFingerprint()` hashed `db/migrations/*.sql` and `packs/catalog.ts` and
**not the journal**. `templateIsReusable` therefore answered TRUE and every worker kept the stale
template. **So the OBVIOUS FIX APPEARED NOT TO WORK:** journal correct, `.sql` correct, and the suite
still reporting `column "statutory_tier" does not exist` from `seedBase` — which reads as a schema bug in
the code under test rather than a stale cache, and survives reruns identically.

`global-setup.ts` claimed the fingerprint hashed **"everything that determines the template's SHAPE"** and
that **"if the inputs are byte-identical the template cannot be stale"**. That guarantee was FALSE while
the journal sat outside the hash — the journal is precisely what decides which migrations run. It is true
now.

**The guard asserts DATA, not a regex over `global-setup.ts`:** the inputs are exported as
`FINGERPRINT_EXTRA_FILES`, and the property is proven behaviourally — a substituted journal must move the
digest with every `.sql` byte-identical, which is **exactly the comparison that was EQUAL before this
change**. A refactor that preserves the behaviour keeps passing; one that drops the journal fails.

---

## r111 — 2026-08-02 — slice 6 / ADR-0080 D-14: the two-tier statutory company

**Shipped:** `main@a4a6e856`. **Migration `0346` — production now on 293.** **Gate:** `tsc` ·
**533 files / 6219 tests** · `next build` · **`UPGRADE_REHEARSAL=PASS`**.
**Verified in production: all 8 companies are `statutory`** — the backfill is byte-identical.

**WHAT WAS RETIRED AND WHY IT HAD TO BE.** `createCompany` called `requirePackFor(country)` and refused
any packless country. Correct as an interim measure — `isoCode` is a SHAPE check, so 'TH' and 'ZZ' both
pass, and a packless company failed SILENT on leave (engines `continue` past the employee, the holiday
resolver yields an empty calendar, nobody is told). r103 turned that silence into a reported
`packBlocked` blocker, landing it **"deliberately BEFORE slice 6's non-statutory tier makes it
reachable"**. But refusal is the wrong PERMANENT answer: a customer with a Thai plant either cannot
onboard it, or **MISFILES Thai staff under the Malaysian company to get past the refusal — silently
applying MY statutory rules to foreign employees.** The workaround is worse than the problem.

**THE RULE, in one line: a pack is not optional where it exists, and not required where it does not.**
A packed country is `statutory` and **declaring it non-statutory is REFUSED** — you do not decline EPF by
ticking a box. A packless country is `non_statutory` **only when DECLARED**; undeclared is still refused,
with the same outcome as before and a stated way through.

**THE DECLARATION IS REQUIRED RATHER THAN INFERRED, and that is the whole safety property.** Inferring
"no pack ⇒ non-statutory" would make a TYPO into a tier: a mis-keyed country would produce a company with
no statutory computation and no payroll, looking from outside exactly like a deliberate choice.

**A BUG I WROTE AND THE TEST CAUGHT.** The country-change path first read
`p.nonStatutory ?? current.statutoryTier === NON_STATUTORY`, which threw when moving TH → MY — it
inherited the declaration and then hit the "cannot declare non-statutory in a packed country" refusal,
**contradicting the comment I had just written saying such a move PROMOTES.** An EXPLICIT declaration and
an INHERITED tier are not the same thing; collapsing them into one flag is what broke it. Inheritance now
applies only where it can still hold.

**Payroll refuses BY TIER, before the pack lookup.** "No localization pack for country TH" reads as a bug
to be fixed; "this is a non-statutory company" reads as the deliberate arrangement it is.

---

## r110 — 2026-08-02 — slice 6: state vocabulary narrows to the jurisdiction that owns the row

**Shipped:** `main@c0095f58`. **No migration.** **Gate:** `tsc` · **532 files / 6196 tests** · `next build`.

**THE DEFECT IS ALREADY IN PRODUCTION — this is not future-proofing.** Two validators judged a state
against `countryPacks().flatMap((p) => p.states)`, the union across every REGISTERED pack, and both
carried a comment ending "per-company narrowing is a later slice". Production holds a location named
**Sepang with `country = 'SG'` on a MY company, state 'Selangor'.** The union accepted it because
Selangor is a state of SOME registered pack. **Sepang is in Selangor, Malaysia** — a data-entry slip,
and exactly the shape a per-jurisdiction check exists to catch. It slipped through because nothing asked
WHICH country.

**NARROWED BY THE COMPANY'S COUNTRY, NOT THE LOCATION'S, and that choice is load-bearing.**
`location.country` is documented in `core/location.ts` as "display only (the engine keeps using
company.country)". **Narrowing by the LOCATION's country would have started REJECTING the live Sepang
row on its next edit** — 'Selangor' is not an SG state and there is no SG pack to ask. Company-country
narrowing keeps that row valid and editable while still refusing a genuinely foreign state. **Here the
correct behaviour and the non-breaking one coincided; I checked production before choosing rather than
after.** (Fixing the row's 'SG' is a data question for its owner, not something a validator should do.)

**NOT SCOPED BY ENTITLEMENT, on purpose.** r102's `country-*` grants are the tempting source. A context
with NO snapshot (`entitlementsExempt`, an out-of-band script) would resolve to NO countries and reject
every state — **turning a resolver gap into a write outage.** The company's country is a column: always
present, never dependent on a snapshot having resolved. Totality is by construction, not luck —
`createCompany` and the country-changing branch of company edit both call `requirePackFor`, so no
company can exist whose country has no pack.

**Holiday groups are TENANT-level**, so there is no single company to narrow by; they now narrow to the
countries the tenant's companies actually operate in. A tenant with no companies resolves to an empty
set and rejects every state — the right refusal, since a state-keyed calendar in a tenant operating
nowhere cannot match anybody.

**THE TESTS REGISTER A REAL SECOND COUNTRY PACK.** With one pack registered the union and the narrowing
are **byte-identical**, so a MY-only test cannot tell the fix from the bug. **The r106 leak trap in a new
coat:** `registerPack` mutates a module-level Map. Safe here and PROVEN rather than assumed —
`test/pack-registry.test.ts:28` asserts `listPacks('country')` EXACTLY equals `['country-my']`, and it
passes when run in the same invocation.

---

## r109 — 2026-08-02 — slice 9: the statutory override gets its first caller

**Shipped:** `main@b83bdb92`. **No migration.** **Gate:** `tsc` · **531 files / 6178 tests** · `next build`.

**`statutoryOverride` HAD ZERO PRODUCTION CALLERS.** r104 declared and enforced it; nothing ever set it.
Same defect shape as r105 (enforcement with no trigger) and r106 (an action with no caller) — a
mechanism is not a behaviour until something reaches it.

**THE COST WAS NOT A MISSING AUDIT ROW.** `recordFileReport` is awaited BETWEEN generating a submission
file and returning it (`app/payroll/reports/cp39-file/route.ts` — verified by control flow, not
inferred: file at line 22, record at 23, response at 35, catch at 42). Its read-only error fell into the
route's GENERIC catch and became a **500 "Could not generate the CP39 file"**. So a suspended customer
did not lose an artefact — **THEY COULD NOT FILE THEIR PCB AT ALL.** r104 made this strictly WORSE than
before it shipped, and only for the one obligation carrying a legal deadline.

**`ReportDef.submission` IS THE DISCRIMINATOR, AND IT ALREADY EXISTED** — no new marker, no allowlist to
keep in step. It is present on the four forms actually filed (`my.cp39`/LHDN, `my.epf`/KWSP,
`my.socso-eis`/PERKESO, `my.cp8d`/LHDN) and ABSENT on `my.contributions`, which the registry itself
calls "an internal reconciliation view, not a form anybody files". **A filing obligation writes through;
an internal convenience does not** — which is r104's own rule ("anything that is not a statutory
obligation should simply fail while the tenant is suspended"), finally applied. A report added to a pack
is covered automatically, decided by the same field that drives the agency and due date on screen.

**The two Layer-B file routes DECLARE their agency** rather than having it inferred. `reportType` is a
free string (`my.cp39-file`), so deriving the agency would mean stripping a suffix and looking the
remainder up — a substring game on the one path where being wrong means a customer cannot file. Naming
it at the call site is what makes the override attributable, which is why the field is typed as a reason.

**ADR-0077 DECISION 5's OTHER HALF IS NOW ASSERTED** — "read-only plus export, never a hard lock-out on
a payroll system". The three export routes (`reports`, `analytics`, `leave`) are asserted to contain NO
insert, update, delete or event append at all — a stronger and more durable claim than one request
passing — and a suspended tenant is shown reading its OWN records through RLS, not merely `select 1`.

**TRAP RE-ENCOUNTERED:** the first draft matched `rejects.toThrow(/read-only transaction/)`, which caught
drizzle's `"Failed query: …"` wrapper and would have passed for ANY query failure. Fixed by walking
`.cause`, the same helper and the same reason as `test/tenant-suspension-readonly.test.ts`.

---

## r108 — 2026-08-02 — slice 9: the scheduled sweeps consult tenant standing

**Shipped:** `main@c3045746`. **No migration.** **Gate:** `tsc` · **530 files / 6166 tests** · `next build`.

**AFTER r104 THE FOUR SWEEPS DISAGREED ABOUT SUSPENSION, and the split follows the snapshot.**
`accrue-earned`, `expire-carry` and `expire-aged-leave` pass `entitlementsExempt: 'sweeps'`, so their
context carries NO snapshot — and r104 keys the read-only guard on `ctx.entitlements?.tenantStatus`,
deliberately treating an absent snapshot as "not known to be bad". **The guard never engaged: all three
kept granting leave and forfeiting days inside a suspended tenant.** `review-sweep` resolves a REAL
snapshot (it has to — it calls the billable notifications gate), so there the guard DID engage, **as a
read-only crash counted as a per-tenant failure and a non-zero exit — a nightly page for a customer
suspended on purpose.** Enforcement existed for one sweep in four, in the one form nobody wants.

**The exempt marker is not the bug.** It is for MODULE gating; widening it to carry standing would put
the decision in two places. Scope is now decided BEFORE a transaction opens, by
`core/sweep-scope.ts`, using the **SAME `TENANT_STATUS_GOOD_STANDING` set `withTenant` uses** — one
predicate, two consumers. **A sweep must never attempt a write the write boundary would refuse**; if the
two rules drifted, the drift would surface as exactly that read-only crash.

**AN UNRECOGNISED STATUS IS OUT OF SCOPE — the OPPOSITE direction from r105, on purpose.** In dunning an
unknown `subscription.status` must NOT suspend (acting on an uninterpretable value costs a customer
their payroll). Here an unknown `tenant.status` must NOT be swept, because `withTenant` refuses those
writes anyway. **Both rules say the same thing: agree with the write boundary, never infer standing from
a value you cannot interpret.** The status is reported BY NAME.

**SKIPPING IS NOT FAILING.** Skips are excluded from `tenantsProcessed` (so an all-suspended night reads
0/0 and stays `success`, not `failed`) and recorded as `skipped` in the run-log jsonb — no migration.
That record is also the **only durable evidence a sweep did not run for a tenant**, which is what
reactivation's "replay skipped sweeps with the suspended window excluded" needs as input.

**THE ASYMMETRY THIS DOES NOT PAPER OVER, and there is a test pinning it.** Accrual SELF-HEALS —
`accrueEarned` computes from service dates up to `asOf`, so the first run after reinstatement grants the
missed months. **EXPIRY DOES NOT:** both expiry sweeps compare `today` to a stored date, so a plain
re-run after reinstatement forfeits everything whose date fell INSIDE the suspended window — days the
employee never had a chance to use. **Replay belongs to reactivation, not to the sweeps**, and
`test/sweep-scope.test.ts` fails if a sweep grows its own catch-up loop over `scope.skipped`.

**A SECOND, OLDER BUG FOUND ON THE WAY.** Migration 0151 inserts tenant `00000000-…-0000` so PRE-AUTH
audit events (login-failed, reset-request) have an FK target. It is not a customer. **All four sweeps
have enumerated it since they were written**, inflating `tenants_processed` by one — so every count on
the Scheduled Actions screen has reported one more customer than exists.
`scripts/reconcile-entitlement-parity.ts` had already learned this and skipped it by hand; the constant
now lives in `core/sweep-scope.ts` and both import it.

**STILL NOT SCHEDULED.** `systemctl list-timers` on the host shows **no `aihr` timers at all** — none of
the four sweeps run in production, which is why none of this ever fired. Like r105, this is correctness
in place before the thing starts running. **Installing the timers is an owner decision.**

---

## r107 (planning only) — 2026-08-02 — 14 leave items planned, and four of them were traps

**No code.** All 14 open items planned and pushed; board went 13 open → 0 open, 14 planned.

**FOUR ITEMS WOULD HAVE BEEN BUILT WRONG IN ISOLATION. Two would have damaged live data.**

**1. `c459bff9` — "remove the Expiry step, it duplicates Carry Forward Policy". THE PREMISE IS FALSE.**
`db/schema.ts` on `leaveType.expiryValue` says it outright: age expiry runs from the ledger row's
`effective_on` and is **"deliberately NOT applied to ANNUAL … layering a second age-expiry there would
double-forfeit; the sweep filters ANNUAL out."** Carry-forward expiry (`carryForwardExpiryMonths`, r85)
runs from **year-end on ANNUAL**. **They cover OPPOSITE leave-type populations** — which is exactly why
they look duplicated on screen. Removing the step deletes the only expiry every non-Annual type has, and
the symptom is balances quietly growing. **Sequencing does not fix this** (my first reading was that
7cd914b1 unblocks it — wrong; the two clocks measure different days).

**2. `38f1fd40` — "reset existing adjustment data" WOULD HAND BACK 1,766 DAYS.** Counted on production:
`entry_type='adjustment'` → **63 rows, −1766.67 days**, of which **51 rows / −1322.67 days carry the
`sys:` prefix** (expireAgedLeave, A2C reprojection). `adjustment` is a SHARED ledger entry type, not a
module-owned table, and balance is a plain ledger sum. The plan removes the SCREEN and leaves the ledger.

**3. `56910869` SUBSUMES `65f466e2` AND `fef49b9a`** — its own example table lists them as rows
("advance notice not met → Emergency", "insufficient balance → split to UPL"). Planned as one engine plus
its first two rules. Both behaviours PARTLY EXIST: the emergency cascade already resolves SICK → ANNUAL →
UNPAID on consent (`core/leave.ts` ~2749), and HR-side advance-notice override already stamps the event
(`:1900`). What is missing is the reporter deciding when they fire.

**4. `491c499f` ARRIVED MID-PASS and is the other half of `38f1fd40`** — one move described twice
(remove from leave type / create as submenu). `38f1fd40` was revised to rev 2: **build the new home
FIRST**. Removing the only adjustment path before its replacement exists is the 241817ef failure.

**A CORRECTION I OWED:** I told the owner `e4238594` would strand approval rules. **It will not.** The
Approval tab still renders its `WorkflowMatrix` over all non-company-default rules, and after r100's
conversion **all 261 active policies are type-scoped, ZERO any-type**. I had conflated it with what
`241817ef` protected. Its build notes now warn the next reader off the same confusion.

---

## r106 — 2026-08-02 — a1d82340 rev 3: the TP1 self-relief bridge becomes reachable

**Shipped:** `main@3293d96f`. **No migration.** **Gate:** `tsc` · **528 files / 6122 tests** · `next build`.

**THE FAULT WAS A MISSING CALLER.** `tp1_relief` is what an employee submits; `payroll_input.tp1_deduction`
is what `generatePayslips` reads; `prefillTp1Action` is the only bridge — and **no screen rendered it**.
Five of the six prefill actions on the batch screen had a button; this one did not. Relief could be
submitted, seen by HR, and never reach a payslip. **The fix is the button**; the bridge always worked.

r91 called it "bound to no form" — right in substance, imprecise in detail. **The guard asserts
reachability for ALL SIX prefill actions**, not just the broken one; a service test would have passed
throughout. **This is the INVERSE of r100's `saveLeaveApprovalPolicyAction`:** both were caller-less
server actions; there the capability was retired so the action went with its screen, here it is wanted so
the action got one.

**A CATALOG LEAK OF MY OWN, caught by the drift guard.** r98/r99's unique fixture codes accumulated in
`module` — 39 rows in w1, 13 in others — because **"10 worker DBs wiped" clears TENANT-scoped tables, not
installation-wide catalogs.** Cleanup order matters twice: `resetDb()` first (the last test's
`tenant_module` rows FK to `module.code`), then `setting_definition` before `module` (it FKs there too).
**An FK violation inside `afterAll` surfaces as the whole FILE failing with NO failed test.**

---

## r105 — 2026-08-02 — slice 9: the dunning policy, the only thing that suspends a tenant

**Shipped:** `main@1558556c`. **No migration.** **Gate:** `tsc` · **529 files / 6138 tests** · `next build`.

r104 built the enforcement and **nothing could reach the state** — no code path set `tenant.status` to
`suspended`. This is the trigger. Pure decision (`core/dunning.ts`) + separate sweep
(`scripts/apply-dunning.ts`), so every boundary is asserted directly with an INJECTED `today`.

**THREE REFUSALS, each load-bearing.** **Never CLOSE** — closure starts a retention clock ending in
destruction and is dual-controlled; a lapsed invoice must not begin deleting payroll history. **Never
AUTO-REINSTATE** — reactivation records the suspended window and replays skipped sweeps with that window
excluded from expiry clocks; a silent flip back would skip all of it. **Never suspend on MISSING DATA** —
no `period_end` means no anchor, and an unrecognised billing status is not evidence of non-payment.

**REPORT-ONLY BY DEFAULT and NOT SCHEDULED, deliberately.** A sweep that suspends unattended on its first
run, from a policy whose output nobody has read, is the wrong default. **Wiring it into a schedule is an
owner decision.** Every suspension appends `tenant.suspended` with the reason, billing status, period end
and grace days.

---

## r104 — 2026-08-02 — slice 9: a suspended tenant is read-only, mechanically

**Shipped:** `main@05539aa1`. **No migration.** **Gate:** `tsc` · **527 files / 6107 tests** · `next build`.
Behavioural no-op on production — both tenants are `active`, **checked before deploying**.

**1. THIS CLOSES A GAP THE CODE DOCUMENTED AGAINST ITSELF.** `core/entitlements.ts`: "Until slice 9
lands, a closed tenant retains write access to core." `isModuleEnabled` returned false for a
non-good-standing tenant so BILLABLE modules refused — but CORE modules (leave, ESS, employees, org)
answer true from the pack catalog **without consulting the snapshot**. A suspended customer could still
file leave and edit employees.

**2. MECHANISM, NOT DISCIPLINE.** One line in `withTenant` binds every call site, including ones written
next year. Per-action enforcement would mean auditing several hundred sites and re-auditing forever.

**3. READS UNTOUCHED, OVERRIDE NARROW.** `statutoryOverride` is a REASON STRING, not a boolean, so an
override is attributable in review. It exists because EPF/SOCSO/PCB deadlines do not pause for a
disputed invoice. **MISSING DATA IS NOT SUSPENSION** — a context with no snapshot is unaffected;
inferring suspension from an unresolved snapshot would turn a resolver outage into a write outage.

**4. VERIFIED BEFORE WRITING.** `SET TRANSACTION READ ONLY` after the four `set_config` SELECTs is both
accepted AND enforcing (reads succeed, writes raise "cannot execute … in a read-only transaction"). And
`core/entitlement-types.ts` imports NOTHING, so `db/client` importing from it creates no cycle.

**5. TWO TEST BUGS OF MINE, both instructive.** A `create temp table` collided across tests — a temp
table lives for the CONNECTION, not the transaction, and the pool reuses connections. And the refusal
assertion matched drizzle's `"Failed query: …"` wrapper rather than the Postgres cause, so it would have
passed for ANY query failure; it now walks the `.cause` chain. **That second one is the trap this file's
own Traps section names.**

---

## r103 — 2026-08-02 — slice 6 step 2: leave stops skipping packless employees silently

**Shipped:** `main@70bc7c11`. **No migration.** **Gate:** `tsc` · **526 files / 6097 tests** · `next build`.

**1. FOUR `if (!pack) continue` SITES NOW REPORT.** `createCompany`'s own comment names the cost: "LEAVE
fails SILENT — the engines `continue` past a packless employee and the holiday resolver yields an empty
calendar, so the employee accrues nothing and nobody is told." The SKIP IS CORRECT AND STAYS — statutory
entitlement cannot be computed without a jurisdiction — but `openLeaveYear`, `accrueEarnedLeave`,
`reprojectA2cEntitlement` and `reprojectEntitlementForPolicy` now return a `packBlocked` list.

**A SWEEP DOES NOT THROW.** That is the difference from `requirePackFor`: throwing is right for a single
operation and wrong for a batch — one packless employee must not abort nightly accrual for everyone.

**2. THE ORDERING IS THE SUBSTANCE.** The branch is unreachable today (every company is MY). Slice 6's
non-statutory tier is what makes packless companies legitimate. **Shipping the tier first would have
manufactured zero-accrual employees nobody could see.**

**3. TWO NEAR-MISSES, both caught before landing.** A substring replace of
`  return { affected, totalDelta };` ALSO matches the 4-space return in
`reprojectEntitlementForEmployment`, which has no such loop — the assertion counted 3 where 2 were
expected and stopped BEFORE writing. And `tsc` then caught every declared return type and early-return
path the widening passed through; neither was visible from the diff.

**4. THE GATE CAUGHT 25 EXACT-EQUALITY ASSERTIONS** across three suites pinning
`toEqual({ affected, totalDelta })`. Fixed by ADDING the field, **not** by loosening to `toMatchObject` —
`toEqual` is what would catch a stray field, and swapping it to make my own change pass would retire a
guard to avoid updating it.

---

## r102 — 2026-08-02 — slice 6 step 1: country becomes a module, shipped inert

**Shipped:** `main@d0fe7469`. **No migration.** **Gate:** `tsc` · **525 files / 6092 tests** · `next build`.
**Verified on production:** `Country modules: 1 granted, 0 already present` — ONE tenant-wide row for 8
Malaysian companies, and zero unpacked companies.

**1. THE PLAN'S BACKFILL CANNOT BE A MIGRATION.** `tenant_module.module_code` has an FK to
`module(code)` and `deploy.sh` migrates BEFORE seeding catalogs, so the migration fails on the FK. And
"insert where a pack is REGISTERED" is a question only TypeScript can answer — SQL would hard-code a
country list and rot the moment a second pack ships. It is a deploy backfill script.

**2. THE FAIL-CLOSED FLIP IS DELIBERATELY SPLIT OUT.** The plan pairs it with the backfill in one
deploy. The backfill is harmless alone; the flip **fails a production deploy** when a company is neither
packed nor flagged. Making that change against data already in production beats shipping both and
diagnosing which half broke. **Confirm before shipping the flip.**

**3. THE CATALOG ENTRY USES THE `system_explorer` IDIOM** (`packs/catalog.ts:254`): `null` in
`LEGACY_MODULE_ENV_GATES` forces the code into `LEGACY_ENABLED_MODULE_CODES`, which the drift test pins
against 0313's literal SQL — a migration that has already run. An unset env name keeps it out; the
backfill grants the row instead. `packBacked: false` (the drift correspondence is with
`listPacks('module')`; a country pack registers under `kind: 'country'`). **`billable: false` on
purpose** — marking it billable would make the change runner refuse to grant it without a
`subscription_line`, stranding a capability nobody has decided how to sell.

**4. TENANT-WIDE, NOT PER COMPANY.** The entitlement is "this customer may operate Malaysia", not "this
company is Malaysian" — the company already carries its country. Idempotent via explicit NOT EXISTS
(`tenant_module` has no unique constraint, so ON CONFLICT DO NOTHING would be a silent no-op).

---

## r100 — 2026-08-02 — slice 5 step 4: two-phase deactivation, and D-6 pinned rather than rebuilt

**Shipped:** `main@3e136060`. **No migration.** **Gate:** `tsc` · **523 files / 6083 tests** · `next build`.

**1. DEACTIVATION ENUMERATES WHAT IT WOULD STRAND, AND REFUSES UNTIL THE OPERATOR DECIDES.** Blockers are
scoped per module (`core/module-deactivation.ts`): TOIL → active accruals; performance → open cycles +
un-enacted pay recommendations; payroll → draft batches. **Deliberately NOT a veto** — a customer who
stopped paying is entitled to stop paying, and blocking forever would hold them hostage. The disposition
lands on the audit event beside its execution. **A BLANK disposition is not an answer** (an unfilled form
field sends an empty string).

**2. D-6 WAS ALREADY TRUE — THIS ROUND ONLY PINNED IT.** `isModuleEnabled` resolves `disabled` as OFF
(`status IN ('active','trial')`), so gated WRITES already refuse. A previous round also got the harder
half right and left the reasoning in `core/toil.ts` above `setToilPolicy`: reads stay UNGATED, and
`runToilExpiry` / `closeReplacementLeaveYear` stay ungated because they settle debts already incurred
(D4). **Correct but fragile** — nothing stopped a later change gating a read and turning "disabled" into
"gone". Three tests now hold it: history readable · obligations still run · **disabling removes nothing**.

**SLICE 5 IS COMPLETE except the admin setup notification**, which is deliberately unbuilt: `notification`
has NO natural key, so it cannot be idempotent without a SELECT-then-INSERT race. It needs a dedup key on
the table first — a design decision, not a line of code.

---

## r99 — 2026-08-02 — slice 5 step 3, and a bug that made TOIL unactivatable

**Shipped:** `main@bf2353ce`. **No migration.**
**Gate:** `tsc` clean · **522 files / 6071 tests** · `next build` clean.

**1. A CORE DEPENDENCY HAS NO ROW TO FIND, and r98's runner refused every module that had one.** The
`depends_on` check looked only at `tenant_module`, but 0313's trigger FORBIDS rows for core codes and
`isModuleEnabled` answers true for them from the pack catalog. The real `toil` depends on core `leave`,
so **TOIL could never be activated**: "missing prerequisite module(s): leave". A dependency is now
satisfied if it is core OR granted.

**THE TEST ONLY FOUND IT BECAUSE THE FIXTURE STOPPED LYING.** The first draft defined its own `toil` with
`billable:false` and no dependencies — and PASSED, testing a module that does not exist. Switching to the
SHIPPED catalog row (and recording the sale as a `subscription_line`) surfaced both this and D-15.
**When a fixture redefines something the product already ships, it is testing itself.**

**2. TOIL's activator seeds a DISABLED-but-present `toil_policy`** — a purchased module arrives visible,
not as an empty shell. `toil_policy_company_uq` makes reactivation leave a configured policy alone.
**The plan's admin notification is deliberately NOT built:** `notification` has no natural key, so it
cannot be idempotent without a SELECT-then-INSERT race. It needs a dedup key on the table first.

**3. THE PER-COMPANY INSTALL HOOK — company #2 is born configured.** Without it a module bought last
month simply has no row for a company created later; the screen is empty, nothing accrues, and nobody
connects it to the purchase. `modulesInstalled` is recorded on `company.created`.

**4. ACTIVATION IS TWO KINDS, and conflating them is a bug.** TENANT-LEVEL runs once (`tenant_setting` is
keyed by (tenant, key) — per-company would repeat one insert and report phantom "skips"). PER-COMPANY
runs per company AND again for every company created later.

---

## r98 — 2026-08-02 — ADR-0077 slice 5 step 2: tenant_module gets its only writer

**Shipped:** `main@1186817d`. **Migration `0345`** (production 291 → **292**).
**Gate:** `tsc` clean · **521 files / 6065 tests** · `next build` clean · **`UPGRADE_REHEARSAL=PASS`**
(and it completed with no hang — the first uneventful rehearsal of the session, post-PG16).

### Decisions

**1. THE PLAN'S `ModulePack.onActivate` IS UNBUILDABLE AS WRITTEN, and the reason generalises.**
`components/sidebar.tsx` is `'use client'` and imports the pack registry; `packs/registry.ts` states that
`serviceFacade` is kept OFF the pack object "because it would drag `db/client` into the client bundle".
An activation hook takes a transaction, so it has exactly that effect. **The plan predates ADR-0080's
pack registry.** Hooks live in a SERVER-ONLY registry (`core/module-activation.ts`) keyed by module code;
`ModulePack` stays a description, not a program. **Check any remaining slice instruction that wants to
put behaviour on a pack object against this.**

**2. REACTIVATION IS NOT FIRST INSTALL (D4) — the assertion that matters most.** A customer who disables
a module for a month and re-enables it has edited its settings meanwhile. Re-seeding would silently
revert their work and read as the product losing it. Every activator writes ON CONFLICT DO NOTHING on a
natural key and REPORTS the skip, so the event says "seeded 0, skipped 3" rather than claiming a clean
install. Pinned end to end: install → customer sets 99 → disable → re-enable → **99 survives**.

**3. A DORMANT BUG FIXED IN PASSING.** `setting_definition.default_on_install` carries the comment "written
as a real row when the owning module is installed, so a purchase arrives usable" — and **nothing was
writing it**. A module whose settings existed only as catalog defaults arrived inert. The generic
activator now writes them.

**4. REFUSE, DO NOT WARN.** The runner rejects an unknown module, a CORE module (0313's trigger would too;
failing here names the reason), unmet `depends_on`, and a BILLABLE activation with no `subscription_line`
(D-15) — an entitlement is the technical half of a commercial fact.

**Slice 5 still open:** TOIL's own activator · two-phase deactivation with blocking pre-checks (the
`disposition` column exists for it) · disabled-module semantics (writes refused, reads/exports preserved,
D-6) · the per-company install hook in `createCompany`.

---

## r97 — 2026-08-02 — ADR-0077 slice 5 begins, and the Postgres wedge finally has a cause

**Shipped:** `main@56ec3e2c`. **Migration `0344`** (production 290 → **291**).
**Gate:** `tsc` clean · **520 files / 6052 tests** · `next build` clean · **`UPGRADE_REHEARSAL=PASS`**.
Verified live: service active, `GET /` 401, **291 migrations**, and all **25 `leave_type` rows backfilled
to `MY`**.

### Decisions

**1. SLICE 5 STEP 1 — THE COUNTRY DIMENSION ON `leave_type`.** `leave_type` carries GENERIC codes
(`ANNUAL`, `SICK`) seeded by the country pack. 0031's `(tenant_id, lower(code)) WHERE archived_at IS NULL`
is unique enough with one pack and **wrong with two** — a legitimate SG `ANNUAL` refused because an MY row
holds the code. It ships now, before a second pack exists, so the index changes once. **Inert on arrival.**

**THE COLUMN DEFAULT IS SAFE BECAUSE OF THE INDEX, and that is asserted, not argued.** A second-country
seeder that omits `country` lands on `MY`, collides with the row already there, and **fails on the first
attempt** — see `test/leave-type-country-dimension.test.ts`. Keeping the default avoided making `country`
required at ~30 existing insert sites for a value every one of them means.

**Two seams left open ON PURPOSE**, both named in code: `core/toil.ts` `ensureReplacementLeaveType` and
`core/admin.ts` create TENANT-scoped types, and a tenant has no single country once slice 6 lands. The
right answer is the company's country, which neither function receives. **Choosing one now would invent a
rule slice 6 has to live with.**

**2. RE-VERIFYING THE 3-WEEK-OLD PLAN PAID OFF AGAIN.** Three of slice 5's premises were already stale:
`attendance_policy`'s `unique(company_id)` is **already built**; `holiday` is **already country-scoped**
(`holiday_uq`), so only `leave_type` needed the dimension; and `ensureReplacementLeaveType` is at
`core/toil.ts:127`, not the `:90-97` cited. **Always diff the plan against the tree first.**

**3. PRODUCTION WAS ON PostgreSQL 16.14 AND LOCAL WAS ON 14 — nobody had noticed.** The upgrade rehearsal
exists to prove a migration applies to production, and it was running on a different major version.
Local is now 16.14. All 344 migrations apply from zero, the seed runs, and the **full suite is green on
16** (a major version jump can move RLS and index behaviour — it did not).

**4. THE WEDGE'S ROOT CAUSE IS TREND MICRO, NOT POSTGRES.** See CURRENT STATE for the evidence and the
fix. **r90's diagnosis was right about the symptom (`UNs`) and wrong about the layer.** PG16 removes the
11 CREATE-DATABASE checkpoints per suite run but not the DROP one, which is what still hangs — so the
version upgrade is a mitigation, not the cure.

The pre-emptive `CHECKPOINT` r90 added to `scripts/upgrade-rehearsal.sh` is now **skipped on 15+**: there
is no create-checkpoint left to pre-empt, and on 16 that statement **became the wedge**, hanging 10m16s on
`IPC/CheckpointDone`. Kept for `<15`.

---

## r96 — 2026-08-02 — the statutory forms were already built; what was missing was their home

**Shipped:** `main@f8c6c3c6`. **No migration.**
**Gate:** `tsc` clean · **519 files / 6046 tests** · `next build` clean. **`956cec85` marked deployed.**

### THE ROUND'S VALUE IS AGAIN WHAT IT DID NOT BUILD

The plan assumed the forms had to be written. **They already existed and were live**, verified in code
AND against production before anything was typed:

- `localization/my/reports.ts` registers `my.epf` (KWSP), `my.socso-eis` (PERKESO), `my.cp39` (PCB/LHDN),
  `my.cp8d` (Form E) and a monthly overview. `app/payroll/reports/page.tsx` renders them via
  `listReports()`, and **all 8 production companies are `country=MY` with payroll active**.
- The **EA form** exists in full: admin screen, employee PDF route, and an ADR-0059 amendment layer.
- Each form already carries name, IC, agency number, gross, the employee/employer split and totals, and
  **already flags employees missing an agency number** — the exact discipline the plan's build notes asked
  for. `recordReport()` already persists an artefact + domain event, which is the "trail" the plan wanted.

**The gap was the reporter's literal words: "a new submenu called Statutory Form ... a centralized
location".** The forms sat mixed in with general reports. Same shape as `61bf109d` (not missing,
undiscoverable) and `deec1691` (not missing, switched off). **Three items now.**

### Decisions

**1. THE NEW PAGE GENERATES NOTHING, AND THE TEST ENFORCES THAT.** It asks the pack which reports are
submissions, states where each is filed and by when, and links to the existing preview.
`test/statutory-forms-page.test.ts` asserts the page contains no `generate(` / `reportPreview(` /
`recordReport(` / `payslip` — a second generator for the same statutory figures is the duplication
`241817ef` spent two rounds undoing.

**2. THE DEADLINE WAS THE ONLY GENUINELY MISSING FACT.** `complianceWorklist` covers CP22/CP22A only —
new-hire and cessation notices — **not** the monthly filing dates. `ReportDef` now carries `submission`,
populated **from the reporter's own block_trail answer**: EPF via i-Akaun, SOCSO+EIS together via PERKESO
ASSIST, PCB via LHDN e-PCB/e-CP39, all by the 15th of the following month.

**The annual Form E deadline is left NULL and the screen says "not configured".** Nobody stated it, and an
invented statutory date is worse than an absent one because somebody files against it — the same rule the
plan set for form layouts. **Do not "complete" it from memory.**

**3. THE ACCESS-MATRIX GUARD CAUGHT A REAL GAP.** `test/function-access.test.ts` requires every guarded
`page.tsx` to have a column in `lib/permissions.ts`. The new page was `requireAdmin()`-guarded but absent
from the registry — it would have shipped invisible to the access-control surface, with `tsc` and
`next build` both green. **When adding a guarded route, register it.**

**4. THE INTEGRATION GATE HAS NOW FOUND SOMETHING IN SEVEN CONSECUTIVE ROUNDS.**

---

## r95 — 2026-08-02 — the itemisation the reporter asked for, and a bug I planted two rounds ago

**Shipped:** `main@2ef73c0d`. **No migration.**
**Gate:** `tsc` clean · **517 files / 6028 tests** · `next build` clean — on the third attempt.
**`862ed0ad` marked deployed.**

### Decisions

**1. THE ITEMISATION IS A WRITE-PATH STAMP, AND IT ONLY EVER WORKS FORWARDS.** `earningsOf` now builds
`componentLines`: one line per pay item carrying EVERY bucket it contributed to. Bucket-per-line rather
than one bucket per item, because an item legitimately splits — a PCB-exempt portion paid untaxed plus a
taxable remainder land in different figures, and flattening that misstates where the money went.
Enrolment is LAZY, so a record-only BIK never appears: it belongs to `recordLines`, under a heading
saying it does not affect pay, and listing it twice would contradict that heading.

Stamped on regular runs only (an additional run re-folds the same recurring components), and the key is
ABSENT when there is nothing to record — so every historical and flag-off payslip stays byte-identical.

**THE INVARIANT IS THE POINT:** per bucket, the listed items sum to the figure they sit under. Pinned in
the pure derivation AND end-to-end against a really generated payslip. It holds because the read side
copies stored amounts and computes nothing — re-deriving from today's assignments is what rev 1 forbade,
since an employee whose allowances changed would get a breakdown disagreeing with the total above it.

**2. I NARROWED A BYTE-IDENTITY GUARD, AND PROVED THE NARROWING.** `test/typed-components-compat.test.ts`
asserts the typed kernel is byte-identical to the legacy one, statutory blob included. `componentLines`
breaks that. The narrowing is legitimate — it is PROVENANCE, not arithmetic, and the legacy path
structurally cannot produce it (no typed components to name) — but the important part is HOW:
`PROVENANCE_ONLY` names exactly ONE key, and `noUnexpectedNewKeys` fails if the typed path grows any
other, so a future stamp cannot ride in behind the exemption. **Then it was verified to still fail** by
stamping a dummy second key (`expected [ 'sneakyNewKey' ] to deeply equal []`) and reverting.
**A guard that has been narrowed and not re-tested is a guard whose strength nobody knows.**

**3. THE GATE CAUGHT A BUG I INTRODUCED IN r92** — six test fixtures building dates in UTC while the
kernel judges in MYT. See the new trap. It is the same shape as r85's original instance and it surfaced
the same way: a run that crossed midnight. Fixed, the drift guard extended to `test/`, and re-verified at
**00:07 MYT — inside the window that breaks it.**

**4. THE INTEGRATION GATE HAS NOW FOUND SOMETHING IN SIX CONSECUTIVE ROUNDS** that targeted runs did not.
Both of this round's findings came from the FULL suite after per-file runs were green.

---

## r94 — 2026-08-01 — the half-shipped item is finished, and three gates lost to 7.8 GB of WAL

**Shipped:** `main@c009578f`. **No migration.**
**Gate:** `tsc` clean · **517 files / 6021 tests** · `next build` clean — on the THIRD attempt, see below.
**`241817ef` marked deployed.** The board now has nothing in `building`.

### Decisions

**1. THE CONVERSION RAN BEFORE THE REMOVAL, AND THE VERIFICATION EARNED ITS KEEP.**
`scripts/convert-approval-rules.ts` (r90) was dry-run against production, then applied: **51 assignments
converted, 3 skipped, 0 failures**, every routing probe resolved before and after in one transaction.

**The raw count understated the job by 12×.** Production showed **4** stranded policies
(`template_id IS NULL OR leave_type_id IS NULL`) but an any-type rule expands to one assignment PER LEAVE
TYPE, so the real footprint was **51** across two companies. A plan written off the row count would have
been wrong about the size of its own change.

**Checking the result mattered more than checking the exit code.** After applying, **2 rows still matched
the stranded criterion**. They were `active = false` — the archived source rules. Zero ACTIVE stranded
rules is the precondition that made the removal safe; had those two been live, deploying would have
silently re-routed their requests onto the built-in fallback, which is the exact failure the two-step
structure exists to prevent.

**2. THE SCREEN WAS NOT ENOUGH TO REMOVE — THE WRITER HAD TO GO WITH IT.** Deleting the card while leaving
`saveLeaveApprovalPolicyAction` exported leaves a **caller-less server action, which is still an
addressable endpoint** — the base chain would have stayed rewritable with no screen showing it, i.e. the
silent-configuration problem the item exists to end. This repo has shipped caller-less live endpoints
before (r80). `core/setLeaveApprovalPolicy` is KEPT: it is the domain operation and the policy suite
drives it directly.

**`LeaveApprovalEditor` LOOKS ORPHANED AND IS NOT** — `app/admin/leave-approval/rule-builder.tsx` still
renders it. Checked before deleting, per r91's lesson about "unused" screens that turn out to be sole
writers.

**3. A TEST THAT GUARDED THE OLD ARRANGEMENT WAS INVERTED, NOT DELETED.**
`test/leave-approval-page-restructure.test.ts` asserted the company section EXISTS; it was right until the
wildcard rules had somewhere else to live. Its two structural tests now assert the absence, so the removal
is guarded exactly as the arrangement was. The escalation test lost its upper bound (which WAS the company
section) and now asserts the editor appears exactly ONCE instead.

**4. CONSEQUENCE THE APPROVED PLAN DID NOT MENTION, now in the `build_ref`.** The two converted companies
hold explicit per-type assignments, so **a leave type added LATER will not inherit that chain** — it needs
its own assignment or falls to the built-in `direct_manager → hr_admin` fallback. Nothing existing changed.
The script says this itself in its output; rev 3 did not, and the reporter was told rather than left to
discover it.

**5. THREE FULL GATES WERE LOST TO CLUSTER DEGRADATION, NOT TO THE CHANGE.** Two runs failed with 22 then
27 timeouts in one unrelated TOIL file that passed in isolation. The cause was `deadlock detected` on
`resetDb()`'s ~100-table TRUNCATE, with **7.8 GB of `pg_wal`** behind it. See the new trap — the diagnosis
is in the `Caused by` line and in `global-setup` timing, and "passes in isolation" was NOT accepted as
evidence.

---

## r93 — 2026-08-01 — the repo learns to render, and the first browser test finds a live bug

**Shipped:** `main@4cceb294`. **No migration.**
**Gate:** `tsc` clean · **517 files / 6021 tests** · `next build` clean · browser project 3 passed + 1
expected-fail. Deploy installed 65 packages (~28 MB) and **no browser binaries**.

Carried debt item 1 has been the top recommendation since r70. Two runners now exist — see CURRENT STATE
for the layer table and which one can see what.

### THE BROWSER LAYER EARNED ITS KEEP IMMEDIATELY

First run, measured in Chromium:

    w-28 alone            -> 112px   (harness check: Tailwind really compiled)
    `${inputCls} w-28`    -> 800px   (should be 112px — w-full wins)
    inputCls alone        -> 800px

**Every `${inputCls} w-<n>` in this codebase is silently a no-op on width, across ~133 files.** The
6013-test suite cannot see it because nothing in it applies CSS. See CURRENT STATE for the standing
warning; it is NOT fixed and NOT yet on the board.

### Decisions

**1. THE BROWSER PROJECT IS OUT OF THE DEFAULT GATE, ON PURPOSE.** `pnpm vitest run` is what the release
rests on. A browser test is slower and more failure-prone than a unit test, and on day one it has no
track record. It gets its own config and its own command. Promote it when it has earned it, and record
that here when it happens.

**2. `globalSetup` IS A PROJECT OPTION, NOT A ROOT ONE — and getting this wrong runs it TWICE.** It lives
in the same options bag as `setupFiles`, so with `extends: true` every project inherits and re-runs it.
Observed directly: `--project dom` printed `10 worker DBs wiped` **twice**, for a project that touches no
database. **Two concurrent global setups wiping the same worker databases is how this repo has corrupted
runs before.** Scoped to the node project, dom runs it zero times and a full run exactly once — and the
dom project went from **21.8s to 790ms**. See Traps.

**3. NEXT'S CLIENT MODULES READ `process.env` AT MODULE SCOPE, so a browser test cannot even IMPORT
`components/ui`.** `next/link` → `resolve-href` → `is-local-url` → `has-base-path` does it on import, and
`process` does not exist in a browser: `ReferenceError: process is not defined`, before a single
assertion. Shimmed in `test/browser-setup.ts` **rather than via Vite `define`** — `define` does a textual
substitution of `process.env` across every module, silently rewriting application code, where a setup
file only supplies the global a browser is missing.

**4. THE PROVIDER API HAD MOVED, and reading beat recalling.** In Vitest 4 the browser providers are
SPLIT into per-provider packages: `@vitest/browser-playwright`, and its provider is a **function**
(`provider: playwright()`), not the string `'playwright'` older versions took. Installing `@vitest/browser`
and setting a string — the shape from memory — would have failed. Same discipline `AGENTS.md` demands for
Next, and it paid off twice in one round.

**5. `playwright` HAS NO INSTALL SCRIPT, so the server got no browsers.** This was checked BEFORE merging,
because `deploy.sh` runs `pnpm install --frozen-lockfile --prod=false` and the lockfile had moved —
downloading ~560 MB of Chromium onto a 3.9 GB box, right before the `next build` step that has OOM'd
before, would have been a self-inflicted outage. Browsers come only from the explicit
`pnpm exec playwright install chromium`, which is a LOCAL step. Local cache went 539 MB → 1.1 GB.

**6. THE DOM PROJECT DID JOIN THE GATE**, because it is deterministic and effectively free (790ms). Its
first file pins the fc776376 fix that source assertions could only describe indirectly: that a reader
actually SEES a rows-per-page control on a 5-row list.

---

## r92 — 2026-08-01 — the last two cross-cutting items, and a bug hiding in a shape the plan did not name

**Shipped:** `main@2a47a66f`. **No migration** (production stays on 290).
**Gate:** `tsc` clean · **516 files / 6013 tests** · `next build` clean · rsync dry-run zero changed files.
**Both items marked deployed:** `bb4f2265` (`013d0a23`) · `fc776376` (`d490d3ad`).

### Decisions

**1. `bb4f2265` — THE PLAN'S CANDIDATE LIST WAS A STARTING POINT AND THE WORST THREE WERE NOT ON IT.**
The mechanical part went as planned: 45 argless `new Date().toISOString().slice(0, 10)` sites across 38
files now use `todayInKualaLumpur()`. **Argless is the entire criterion** — `new Date()` with nothing in
the parens IS the current instant, so all 45 ask "what date is it now"; the 51 remaining occurrences all
take an argument and are date arithmetic that is correct in UTC. None were touched.

The real find came from looking for the SAME bug in a DIFFERENT SHAPE — a `now` variable converted to a
date, rather than `new Date()` inline. `app/attendance/clock/actions.ts` and `app/me/actions.ts` both had

    const d = new Date();
    return { date: d.toISOString().slice(0, 10), time: d.toTimeString().slice(0, 5) };

**date read in UTC, time read off the HOST clock.** A punch at 00:30 MYT was stamped with YESTERDAY's date
beside TODAY's time — the record disagreed with itself, and an overnight-shift punch landed on the wrong
day entirely. `app/attendance/clock/page.tsx` derived the same UTC `today` and passed it to
`attendancePunchesForRange(today, today)`, so before 08:00 the clock screen showed the wrong day's punches.
This is the population the plan flagged as most affected, and none of it was in the candidate list.

`lib/hr-date.ts` gains `timeInKualaLumpur()` so both halves of a stamp come off one clock.
**`toTimeString()` was correct only because the box happens to be set to MYT** (verified: `timedatectl`
says `Asia/Kuala_Lumpur`, and node resolves the same) — an implicit dependency on host configuration,
now explicit.

**The guard was verified to FAIL.** `test/today-in-myt-drift.test.ts` matches only the argless form, so no
arithmetic site can trip it (r86 lost four integration runs to over-broad source guards). It was tested by
reintroducing the bug in `core/claims.ts` and confirming it fails AND names the file. Its behaviour
assertions INJECT an instant inside the window (`2026-07-31T16:30Z` = `2026-08-01T00:30` MYT); without
that they would pass all afternoon and prove nothing, which is exactly how the original hid.

**2. `fc776376` — ONE REPORT, TWO DIFFERENT CAUSES, and the reporter was right about both.**
- **The control was INVISIBLE, not absent.** `showPager()` returned
  `hasPrev || hasNext || truncated || total > 25`, so any list of 25 rows or fewer rendered nothing. On
  this tenant that is nearly every list (23 active employees, 36 leave requests, 47 payslips), so "there
  is still no pagination" was an accurate description of what they could see. It now always returns true.
  The deliberately-unpaged surfaces are unaffected because they construct no `PageState` at all — the
  decision about whether a surface is a LIST is made by whether it renders a pager, not inside `showPager`.
- **Six grids genuinely had none, and the reason is structural:** `<Pager>` is an async SERVER component
  (it awaits `getTranslations`), so a `'use client'` grid cannot render it. That is why feedback — **517
  rows, the largest list in the product** — was skipped. `components/client-pager.tsx` is the variant that
  unblocks it: same `?page=&size=` contract, but `useTranslations` + `useRouter`, and `replace()` rather
  than `push()` so Back leaves the list instead of walking back through pages of it.

**SORTING ORDERS THE WHOLE SET, PAGING SLICES THE RESULT.** Done the other way, a column header reorders
25 rows and leaves the other 492 where they were — which looks like sorting and is not. The test asserts
the ordering by SOURCE POSITION (`.sort(` before `paginateRows(`) so it cannot silently invert.

**SELECTION CANNOT OUTRUN THE PAGE.** On feedback and roster the submitted ids are intersected with the
visible page, so "approve all" can never quietly mean "approve all 517". **Intersecting is structural**
— the form can only carry rows that are on screen — where clearing state on page change would have been a
timing argument, and eslint's `react-hooks/set-state-in-effect` correctly rejected the effect version.

**3. THE LOCAL POSTGRES WAS REBUILT AGAIN, and the numbers justify the standing rule.** It was found down
with the data dir in `in production` state — crashed, with **10 GB of WAL and 16 databases** to replay.
Wiped and rebuilt per the Traps recipe rather than waiting out recovery. The test template then migrated
in **0.7s**. `ai_hr_app` re-verified `NOSUPERUSER`/`NOBYPASSRLS`.

---

## r91 — 2026-08-01 — SHIPPED. The findings are still the deliverable

> **STATUS: DEPLOYED** as `main@b7134c6` on 2026-08-01, in a later session than the one that built it.
> **Gate:** `tsc` clean · **514 files / 5995 tests, all passing** · `next build` clean · **no migration**,
> so no rehearsal. Verified live: service active, `GET /` 401, `/login` 200, tunnel 401, production still
> on **290** migrations, and the post-deploy `rsync -azi --dry-run` reported **zero** changed files.
>
> **The gate took TWO runs and that is not a formality.** The first printed `513 passed (513)` with zero
> failures and **exited 1**; the tree has 514 test files and `test/leave-approval-escalation.test.ts` had
> never started (worker spawn timeout). Re-run alone it passes, 14 tests. See the new trap above — a
> skipped file shrinks the denominator instead of failing.

**Built (three genuinely-missing slices):** `a1d82340` **step 3 only** · `ec845c7d` **bullet 2 only** ·
`862ed0ad` (History default tab + bounded read + an honest heading).
Commits: `a166f114`, `6febe0b1`, `a4bbeec1`, merged as `b7134c68`.

**ONLY `ec845c7d` WAS MARKED DEPLOYED.** Its genuinely-missing bullet is built, so the request is met.
**`a1d82340` and `862ed0ad` were deliberately left `building` although their code is live**, because
neither request is satisfied: `a1d82340` has only step 3 of five (step 4 needs the reporter's decision,
step 5 is unbuilt), and `862ed0ad` cannot itemise recurring components at all. Closing either would tell
the reporter it is done — the r77 mistake, and the same call r90 made for `241817ef`.

### THE ROUND'S VALUE IS WHAT IT REFUSED TO BUILD

**1. HALF OF `a1d82340` WAS ALREADY SHIPPED, BY ITEMS RAISED OUT OF ITS OWN PLAN.** Step 1 ("make the
runs finish") is `ef31d251`, shipped r87. Step 2 ("stop pay being stranded") is `d0d2c9d1`, shipped r87.
The agent reused `d0d2c9d1`'s read rather than writing a second definition of "unpaid" — which is the
right instinct and worth copying.

**2. STEP 4 — "RETIRE THE UNUSED SCREENS" — IS A ONE-WAY DOOR, AND THREE OF ITS FOUR TARGETS ARE NOT
DEAD.** This is the most important finding in the round and it must reach the reporter before anyone
acts on that step:
- **The run-screen input grid** (`app/payroll/[batchId]/ot-input-row.tsx`) is the ONLY manual entry point
  for the four EA s.60/60A/60D overtime buckets, bonus, TP1 deduction and zakat on a draft batch — and
  **the only form that writes `payroll_input.tp1_deduction`, which is the field `generatePayslips`
  actually reads.** The plan's own "faults found but not raised" section records that the TP1 relief
  screen writes `tp1_relief` and its only bridge (`prefillTp1FromSelfRelief`) is bound to no form. So
  deleting this grid removes **the last path by which TP1 can reach a payslip at all**.
- **`/admin/payroll-permissions`** is the only writer of `payroll_permission_grant`. Deleting it makes
  `payroll.rollback`, `payroll.reprocess.selective` and their siblings **permanently unreachable** — a
  capability narrowing dressed as a tidy-up.
- **The file import** (`component-import.tsx` → `payroll_batch_component`) is one of the eight places
  money can be added. Retiring it belongs INSIDE step 5's consolidation; removing it first decides where
  that money goes by default rather than by design.
- The fourth ("pay items never assigned to anybody") is DATA, not code, and `61bf109d` owns that screen.

**3. `862ed0ad`'s ITEMISATION PREMISE IS FALSE.** The plan says "the component detail already exists on
the payslip — the summary is an aggregation over it — so this is a disclosure change". That holds for
ONE-OFF items (`f1564110` Phase 3 stamps per-transaction provenance into `statutory.recordLines`). It
does **NOT** hold for RECURRING pay components: `core/payroll.ts` `earningsOf` sums them into
`wageAllow`/`ot`/`bonusAmt`/`reimburse`/`deduct` and **stores no per-item detail**. So for the reporter's
own example (Allowance MYR 200.00) **there is nothing stored to disclose**. Both ways to supply it are
forbidden by the plan itself: stamping it at generate time is a payslip change (and would show nothing
for the 18 historical runs), and re-deriving it from `employment_pay_component` is a recomputation that
can disagree with the figure printed beside it. The screen now says so plainly instead. **If the reporter
wants it, it is a write-path follow-up that can only ever work forwards.**

**4. `ec845c7d` WAS ALREADY BUILT IN R45** — bullets 1, 3 and 4, and bullet 2 on the Fixed screen, all
shipped as `ee21508c` / `65377ed0` / `b7fc8583`. Only bullet 2 on the Individual side was genuinely
absent. Nothing was rebuilt.

**5. A DEFECT THE AGENT FIXED ON ONE SCREEN AND DELIBERATELY DID NOT FIX ON THE OTHER.**
`me.payslip.recordLinesHeading` reads "Recorded items (no cash impact)" over a list that can now contain
PAID one-off items. Same mislabel it corrected in History — but that screen is the EMPLOYEE's own payslip,
and quietly editing what an employee reads about their pay is not a side effect to take on an item scoped
elsewhere. **Left, named, and worth raising as its own item.**

### Browser verification — ACTIVATED, and it works. Here is the recipe

**Point it at a LOCAL dev server, never production.** Production sits behind WorkOS OAuth that cannot be
completed from here; `lib/session.ts` gates on `NODE_ENV`, and in dev the identity switcher resolves the
principal from the `dev_user` cookie / `DEV_USER_ID` with no WorkOS at all.

    cd .claude/worktrees/mainwt
    pnpm db:migrate
    node --env-file=.env.local --import tsx db/seed.ts     # seeds DEV_USER_ID (HR Admin, hr_admin)
    pnpm dev                                                # :3000, no SHARE_PASSWORD gate locally
    # then drive it with the claude-in-chrome tools

**CONFIRMED WORKING, both previously unverified:**
- **`a324a4b3`** — ONE Attendance menu, matching the reporter's screenshot exactly: Records, Holidays,
  Shift settings, Attendance policy, Attendance allowance, Clocking location, Time off in lieu, Roster,
  Import — with "My attendance" correctly still separate.
- **`6d671f44`** — the Create New Employee wizard renders: five steps, Save draft, and "nothing is
  created until the final step".

**DEFECT FOUND, and this is what browser verification is for:** on Pay Items, **"Seed Malaysia defaults"
silently does nothing.** Clicked it, waited, catalog still `(0)`, `pay_component` still 0 rows, no error
and no toast.

> ### ⚠️ CORRECTION (r101, 2026-08-02): THE SUSPECTED CAUSE BELOW IS **DISPROVEN**. Do not act on it.
>
> The module-load hypothesis is wrong, and r91 was right to hedge it. `core/pay-components.ts` imports
> `countryPacks` **from `localization/registry`** — the same module whose top-level body calls
> `registerPack`. ESM fully evaluates an imported module before the importer's body runs, so registration
> ALWAYS precedes the union. **Verified empirically in the adversarial order** (importing
> `core/pay-components` first): the union resolves **3** remuneration types and **13** component
> defaults, never 0. Pinned by `test/pack-module-scope-unions.test.ts`.
>
> **And the defect does NOT reproduce on production:** `pay_component` holds **17 rows** and a
> `pay-component.catalog.seeded` domain event exists. `seedPayComponentCatalog` has no entitlement gate
> and is already exercised by two passing suites.
>
> **So if it is real, it is in the ACTION/UI layer or was specific to r91's local dev session** — the
> browser check ran against a LOCAL server, whose `pay_component` is legitimately empty because
> `db/seed.ts` does not seed it (the button does). **Reproduce it before diagnosing it again.**

Superseded suspected cause, kept only so nobody re-derives it:

    core/pay-components.ts:41
    const DEFAULT_PAY_COMPONENTS = countryPacks().flatMap((p) => p.payComponents.defaults)

That is evaluated **at module load**. `countryPacks()` reads a registry populated by side-effect imports,
so if registration has not happened in that module graph yet the array is empty **for the life of the
process** — the seed loop iterates zero times, inserts nothing, and reports success.
`BACKFILL_COMPONENT_CODES` on the next line has the identical shape. **Not fixed here:** it is outside
this round's approved scope, it needs reproducing on production rather than inferring, and it sits on the
screen `a1d82340`/`61bf109d` are actively rewriting.

---

## r90 — 2026-08-01 — two shipped, one deliberately half-shipped, and two plans of mine corrected by the agents

**Shipped:** `main@3f2a8c6`. Migration `0343` (production 289 → **290**).
**Gate:** `tsc` clean · **511 files / 5963 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, 290 migrations, both `leave_type` consecutive-cap columns present, the unit
column is **TEXT not an enum** (the 0338 lesson), and **0 leave types carry a cap** — so no employee's
behaviour changed.

**Shipped:** `97a9b0ab` (payslip provenance + re-run disclosure) · `c6ffa725` (Maximum Consecutive Leave).
**Step 1 of 2:** `241817ef` — conversion script and rewrites shipped; the section removal is HELD and the
item is deliberately left `building`.

### Decisions

**1. THE AGENT CORRECTED MY PLAN'S PREMISE, AND THE REPORTER HAD TO BE TOLD.** Rev 2 of `97a9b0ab` — which
I wrote — said two things could have moved a tax figure: the earlier months, and the tax rules themselves.
The agent diffed the only commit that moved `MY_STATUTORY_VERSION` (`7857ddc8`, 2026.4 → 2026.5) and found
it **changed no rate, no band and no relief**. It only ADDED optional PCB exemption tables, inert unless a
pay item or employee is explicitly flagged. **So the 14-on-2026.4 / 33-on-2026.5 split correlates with
revision because the code was redeployed between the two batches of runs, not because the rules moved
anyone's tax.** The build reflects this: the version cause renders with an explicit caveat, and only the
earlier-months cause is stated as a real mechanism. The `build_ref` says so plainly.

**2. THE ITEM NEEDED NO MIGRATION AT ALL, and rev 1 would have added one for data already recorded.**
`statutory.version` has been stamped on every payslip since 2026.0 (both return paths of
`localization/my/payroll.ts`), `payslip.version` already increments, and — the real find —
**`payroll_employee_result_history` has stored the complete before/after pair on every selective reprocess
since `9bc442bc` and is READ BY NOTHING** outside its own delete cascade. The version history the plan
asked to build already existed in full. The pack-stamp "small half" was also **already built** in
`bbac11f7`. Every deliverable turned out to be read-side.

**3. `241817ef` WAS HELD AT STEP 1 OF 2, and the agent found MY DISCRIMINATOR WAS WRONG.** My rev 3 plan
said "213 of 217 rules already reference a template", implying only 4 needed converting. Wrong criterion:
`app/admin/leave/entitlements/page.tsx` embeds the same WorkflowMatrix per leave type, so any rule with
`leave_type_id` SET stays editable there after the Approval tab loses its copy. **What the removal strands
is `leave_type_id IS NULL`** — any-type rules, which that page deliberately renders read-only as shared
config. The real criterion is `(template_id IS NULL OR leave_type_id IS NULL)`.

The agent also could not reach production — **it tried port 22; this project uses 8288** — and instead of
guessing, delivered a script that enumerates and proves against real data at run time, refusing with both
chains printed where expanding a rule would flip a specificity tie. **The escalation relocation I asked
for was already built in r79.** The item stays `building` because nothing user-visible changed: marking it
deployed would tell the reporter it is done while their screen is unchanged, which is the r77 mistake.

**4. THE INTEGRATION GATE CAUGHT ONE FAILURE IN 5,963 TESTS THAT THREE ADVERSARIAL REVIEWERS REPORTED
CLEAN.** `core/leave-approval-consolidation.ts` violated the ADR-0080 D9 leave ratchet. Fixed at the
boundary, not the allowlist:
- Added to **BOTH** lists in `test/leave-pack-drift.test.ts` — as a BOUNDARY it becomes guarded like its
  siblings; in ALWAYS_ALLOWED it may import them back. Adding it only to the second would have silenced
  the failure while leaving the new module **unguarded**, which is the drift D9 exists to stop.
- `scripts/convert-approval-rules.ts` now consumes `packs/leave/service`, and the facade re-exports the
  module. **There are already four `scripts/` entries in the debt allowlist — that is pre-existing debt,
  not a precedent to extend.** The file is documented to only ever SHRINK.

**Zero findings from three adversarial reviewers is not evidence of a clean tree.** Four rounds running,
the integration gate has found what per-agent runs and reviewers did not.

### The Postgres wedge — MY EARLIER DIAGNOSIS WAS WRONG, and the correction matters

r89 recorded that `fsync=off` and friends would mitigate the `CREATE DATABASE` wedge. **They do not.** It
wedged again on 2026-08-01 with `fsync=off`, `full_page_writes=off`, `synchronous_commit=off` and
`wal_level=minimal` all confirmed active, counters frozen, `CREATE DATABASE` stuck 10m36s.

**What is actually happening:** the checkpointer sits in **`ps` state `UNs` — uninterruptible kernel
wait**. No Postgres-level setting can shorten that, which is exactly why the tuning had no effect. The
dirty-buffer/fsync hypothesis was wrong.

**Three corrections to the recovery recipe, each learned the hard way:**
1. **`pkill -9` CANNOT kill a process in uninterruptible wait.** Kill the **postmaster** (the parent)
   instead — the stuck child becomes a harmless zombie holding only the old directory. Find it with
   `lsof -nP -iTCP:5433 -sTCP:LISTEN`.
2. **Renaming the data directory does NOT stop a running server.** It keeps serving by inode. r90 ended
   up with a live server whose `data_directory` no longer existed at that path and an `initdb` that
   refused because the earlier failed attempt had already created the directory.
3. **`mv` the data dir aside — instant** — rather than `rm -rf`, which cost ~10 minutes with the disk busy.

**The rehearsal needed its OWN checkpoint.** r89 added one to `test/global-setup.ts`, but that only covers
the SUITE's creates; `scripts/upgrade-rehearsal.sh` builds its scratch database through its own path.
**That is precisely why the suite passed and the rehearsal wedged.** Now added there too — with a comment
saying honestly that it is not a guaranteed fix.

**The durable fix is PostgreSQL 15+**, whose `CREATE DATABASE` defaults to `STRATEGY = WAL_LOG` and forces
no checkpoint at all. Blocked here: Homebrew installs fail on this Mac's Xcode.

---

## r89 — 2026-08-01 — the held item, finished: shared groups move to leave type level

**Shipped:** `main@039853d`. Migration `0342` (production 288 → **289**).
**Gate:** `tsc` clean · **508 files / 5921 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, service active, 289 migrations, `leave_shared_group` present,
`scheme_leave_combined_limit` GONE, **1 archive row kept**, 0 groups after the reset (as asked), and the
`leave_shared_group_max_days_check` CHECK restored.

**Shipped:** `1ef1cf95` — the item r88 correctly refused to ship.

### Decisions

**1. THE TWO REASONS r88 HELD IT WERE BOTH REAL, and finishing them is the round.**
- **The promised safeguard did not exist.** The plan promises the reporter a dump of their configuration
  BEFORE the reset, and `0342` DROPS the tables. It now exists at
  `docs/1ef1cf95-existing-shared-groups.md`, and producing it found **two things worth more than the
  dump itself**: their "Special Leave" group covered **only GRADE H (Permanent)**, not everyone — a
  direct consequence of groups living under a benefit scheme, and exactly what this change removes — and
  **the 3-day per-application cap they described was never actually set** (the column was NULL). Both are
  in the `build_ref`.
- **`0339` HAD BEEN STRANDED BELOW THE WATERMARK.** r88 shipped `0340`/`0341` while this was held, so
  `0339` (`when=…439000`) sat under production's `…441000`. Merging it would have produced no error, no
  conflict and no tables. Renumbered to `0342` (`…442000`) — file, journal entry, and **every source
  comment citing the old number**. Verified against the live watermark before deploying.

**2. THE REHEARSAL CAUGHT A REGRESSION REVIEW DID NOT.** The new `leave_shared_group` shipped WITHOUT the
`max_days_per_application` CHECK that `0327` put on the table it replaces — the guarantee that an
importer or hand-written UPDATE cannot store a cap refusing every application. Both CHECKs carried
forward. **Renaming a table is not a reason to lose its defence in depth.**

**3. AND A SECOND ONE, WHICH IS A LIVE BEHAVIOUR CHANGE FROM r88's `fa3f4ccb`.** The rehearsal's baseline
seed began failing with `InsufficientLeaveBalanceOnSubmitError`. Cause: the seed never configured SICK,
because entitlement was `max(statutoryFloor, configured)` and the EA s.60F floor supplied the days by
itself. **Now that the floor no longer overrides, a leave type with NO policy and no scheme row grants
ZERO** where it previously granted the legal minimum.

**PRODUCTION WAS CHECKED, NOT ASSUMED, AND IS UNAFFECTED:** ANNUAL bands are **20–24** days and SICK
**14–22**, all at or above the statutory minimums (8/12/16 and 14/18/22), so **no live employee lost a
day**. A tenant relying on the floor to cover an unconfigured type WOULD have. The seed now configures
SICK explicitly, and the reporter is told the general rule.

**4. TWELVE INTEGRATION FAILURES ACROSS SEVEN FILES, one of them a real defect.** The 675-line deletion
left the whole `@dnd-kit` import block dead in `benefit-scheme-config.tsx` — both DndContexts there are
now gone (grades by `b1b81a08`, pools by this item), and a dead drag import is how the next reader
concludes the screen still drags. The rest were guards pinning the removed mechanism, inverted rather
than deleted. One "failure" was a benign layout change a literal assertion mistook for breakage: Add
Leave Type gained a sibling, so `mt-auto` moved from the button to a wrapper.

**5. I MADE THE OVER-BROAD-GUARD MISTAKE THREE TIMES IN ONE SESSION**, twice while fixing an over-broad
guard. Once it matched a COMMENT recording the change; once it forbade `scopeLeaveTypeId` outright and
caught the scoped-display FILTER, a different and surviving feature. **The fix for an over-broad guard is
itself usually written as a source grep, which is why this keeps happening.** Strip comments, and scope
to the construct — never to a token that something still-working also uses.

**6. AN AWARENESS LOSS, RECORDED RATHER THAN DROPPED.** The "Shared with X, Y — edits here affect every
leave type in this pool" badge is gone with the scheme-level pool. That hazard did not disappear; it got
**wider**, because a group is no longer scoped to one scheme. Re-earning it means surfacing group
membership on the entitlement rows from the new tables — beyond the approved plan. Follow-up debt, and
the reporter is told.

### The local Postgres wedge — ROOT CAUSE FOUND, and mitigated

`CREATE DATABASE` wedged in `CheckpointStart` **three times** on 2026-08-01, each time immediately after
a full suite. **The cause is PostgreSQL 14**: its `CREATE DATABASE` uses the FILE_COPY strategy, which
forces **two immediate checkpoints and waits on each**. The harness creates 11 databases per run =
**22 forced checkpoints**. On a clean cluster each create takes **0.08s** (measured); on one dirtied by a
5,900-test run, one stalls and never returns. The server log shows nothing — it is a hang, not an error.

**The real fix is PG15+**, where `STRATEGY = WAL_LOG` is the default and there are no forced checkpoints.
Blocked here: Homebrew installs fail on this Mac's Xcode.

**Mitigations applied:**
1. `postgresql.conf` on the LOCAL cluster only: `fsync=off`, `full_page_writes=off`,
   `synchronous_commit=off`, `wal_level=minimal`, `max_wal_senders=0`. Each trades crash-safety for
   checkpoint cost, correct HERE and nowhere else — this cluster holds only a test template, ten worker
   DBs and a scratch dev DB, all rebuilt in seconds. **Never on the server.**
2. `test/global-setup.ts` issues an explicit `CHECKPOINT` before the rebuild path, so the 22 forced
   checkpoints find nothing to flush. A no-op when clean.

**Recovery recipe, corrected by experience:**
- **`mv` the data dir aside — instant.** `rm -rf` cost ~10 minutes with the disk busy.
- **`pg_ctl -m immediate` CAN ITSELF HANG** when the postmaster is unresponsive rather than merely stuck
  on a checkpoint. It then needs `pkill -9 -f 'postgres.*aihr-pg14'`. The previous note that
  `-m immediate` is the answer is true *usually*, not always.
- **`-m immediate` buys a full WAL replay**, which after a heavy suite was 1.8 GB / 27 minutes. Wiping
  beats replaying when the data is disposable — locally it always is.

### Also this round

**`deec1691` closed with NO BUILD.** The Dependency Explorer shipped in r79 but `system_explorer` had no
`tenant_module` row, so it resolved OFF and had no screen for any role. One activation row. `toil` is off
the same way and was left alone — the plan offered it and the reporter has not asked.

**`c6ffa725` re-planned as rev 2, and the reporter was right.** r86 shipped the per-YEAR cap and the
`build_ref` claimed the item done; the "Maximum Consecutive Leave" half — Unlimited/Limited plus a
Calendar/Working Days unit — was never built. The re-plan also surfaces a design tension rather than
hiding it: a per-application cap ALREADY exists on the shared group, and a guard forbids "a rival
per-type column". Recommended one composition (**stricter of the two wins**, named in the refusal), with
the guard to be **widened deliberately, never quietly deleted**.

**A FRESH WORKTREE CANNOT RUN THE DB SUITE.** `.env.local` is gitignored, so `git worktree add` does not
carry it, and the first full-suite run in a new worktree dies in setup with
`TEST_MIGRATION_DATABASE_URL must be set` and **no test summary at all** — which looks nothing like a
normal failure. Copy `.env.local` into every new worktree.

---

## r88 — 2026-08-01 — 9 items across four parallel agents, and four failures only the integration saw

**Shipped:** `main@6b82c8e`. Migrations `0340`, `0341` (production 286 → 288).
**Gate:** `tsc` clean · **508 files / 5922 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, service active, **288 migrations**, `movement_event_type` and
`employee_import_run` both present, `employee_statutory_my.disabled_individual` present and
**0 employees flagged** — so no existing PCB figure moved, which is the claim that mattered.

**Shipped:** `fa3f4ccb` (statutory floor stops overriding) · `30325fc1` + `10fcf6df` + `476f23ed`
(movement cluster) · `a324a4b3` (one Attendance menu) · `61bf109d` (Pay Items discoverability) ·
`cf43c909` + `d64d0df4` (personnel admin) · `e523e85d` (**already delivered — closed, not built**).
**HELD:** `1ef1cf95` — incomplete when its agent was cut off, and its promised safeguard was never built.

### Decisions

**1. FOUR INTEGRATION FAILURES, AND TWO WERE REAL DEFECTS.** Every agent was green on its own branch;
these appeared only where branches met. This is the fourth consecutive round where the integration gate
earned its cost (r74, r75, r86, r88).

REAL:
- **`/admin/settings/movement` was absent from `lib/permissions.ts`.** r88b's Movement Settings page
  shipped with its own `requireAdmin()`, so it was never reachable without admin — but it was missing
  from the registry that drives the users/roles matrix, so it appeared to nobody as a grantable screen.
  `test/function-access.test.ts`'s reverse-completeness check caught it. **Same omission class as r74
  and r75.** Added with the guard matching the page's own; `nav.movementSettings` already existed in all
  six catalogs.
- **An ADR-0080 D9 architecture violation.** r88c put `pay-rule-words.ts` in `lib/` importing payroll
  pack types. I checked whether the ratchet was merely over-strict about type-only imports — **it is
  not**: `test/helpers/import-ratchet.ts` states the intent explicitly, *"type coupling is still
  coupling"*. So the fix was to MOVE the file into `app/admin/pay-components/` (already
  `ALWAYS_ALLOWED`, and where a presentation helper for that screen belongs) rather than add an
  allowlist entry to a list documented to **only ever shrink**.

SUPERSEDED GUARDS — inverted, not deleted:
- `entitledDays 'exactly three inputs'` pinned `Math.max(floorDays, schemeDays ?? policyDays)`, which is
  exactly the override `fa3f4ccb` was approved to remove. Re-pinned to the new composition, preserving
  its real subject (no FOURTH day-source) and adding that `floorDays` must still reach the caller as the
  warning signal.
- `employee-import-file` pinned `commitImportAction`'s two-arg form; `cf43c909` added `fileName` so the
  import-history row can name the upload. Widened to the call shape; the single-call-site assertions
  still enforce "no second, file-specific server action".

**2. I MADE THE OVER-BROAD-GUARD MISTAKE WHILE FIXING AN OVER-BROAD GUARD.** My first rewrite of the
`entitledDays` assertion matched raw source and fired against the COMMENT two lines above the function
that RECORDS the change ("was `Math.max(...)`; the resolved value is now ..."). That is r86's four-guard
failure, repeated by the person writing it down. **Comments are stripped before matching now**, following
`test/module-catalog-drift.test.ts`'s existing helper. The lesson generalises: a guard that greps source
will eventually match prose describing the invariant.

**3. `e523e85d` WAS CLOSED WITHOUT CODE, and verified before saying so.** It is a duplicate of
`941c9dac`, raised nine hours later the same day and shipped in r83. Confirmed in the tree rather than
taken from the plan: migration `0329_movement_scheduled_apply_once` exists and
`employment.movement.scheduled` is live in `core/movement.ts` tagged to `941c9dac`. The `build_ref` asks
the reporter to try it and reject if any part differs — because that would be a real fault in r83.

**4. `1ef1cf95` WAS HELD, AND ITS MIGRATION NUMBER IS NOW A TRAP.** The agent was cut off mid-item
(connection dropped). Two independent reasons not to rescue it into this round:
- **The promised safeguard was never built.** Its plan promises the reporter a dump of their existing
  shared-group configuration BEFORE the reset, and that task was still pending. `0339` DROPS
  `scheme_leave_combined_limit`. Shipping a destructive migration whose safety net does not exist is
  exactly backwards.
- It left three test files importing functions it had already deleted, so the tree did not typecheck.

Conveniently ALL of its work is uncommitted, so holding it was clean — `build/r88a` carries only
`fa3f4ccb`. **The work survives in `.claude/worktrees/r88a` as uncommitted changes.**

> ⚠️ **`0339` IS SPENT BUT UNSHIPPED.** When `1ef1cf95` is finished it must be **RENUMBERED ABOVE
> `0341`**, not simply un-held: drizzle-kit reads the last applied `when` as a watermark and silently
> ignores anything below it. `0339` would merge with no error, no conflict, and the tables would simply
> never be created. This is the r84 stale-number trap, pre-loaded.

**5. THE `-m immediate` ESCAPE HATCH FAILED THIS TIME.** The rehearsal's `CREATE DATABASE` wedged in
`CheckpointStart` right after the 5922-test suite (counters byte-identical over 10s, stuck 10m28s,
checkpointer spinning at 16% CPU — the r83 diagnostic, confirmed before acting). But **`pg_ctl -m
immediate stop` itself hung**, because the postmaster was unresponsive rather than merely stuck on a
checkpoint. It took `pkill -9 -f 'postgres.*aihr-pg14'`. The handoff previously said `-m immediate` is
the answer; it is the answer *usually*, and `pkill -9` is the fallback when the postmaster will not
answer at all.

**6. A FRESH WORKTREE CANNOT RUN THE DB SUITE.** The r88 integration worktree's first full-suite run
died in setup with `TEST_MIGRATION_DATABASE_URL must be set` and **no test summary at all** — which
looks nothing like a normal failure. `.env.local` is gitignored, so `git worktree add` does not carry
it. **Copy `.env.local` into every new worktree before running tests.**

---

## r87 — 2026-07-31 — two payroll faults shipped, and the third was stopped by its own evidence

**Shipped:** `main@6e967cf`. **No migration** (production stays at 286) — so the upgrade rehearsal was
NOT required. Stated rather than skipped silently.
**Gate:** `tsc` clean · **501 files / 5829 tests** · `next build` clean.
Verified live: `GET /` 401, service active, 286 migrations, and both new files present on the box.

**Shipped:** `ef31d251` (payslips can finally be published) · `d0d2c9d1` (money that never reached a
payslip is now visible).
**HELD before building:** `97a9b0ab` — re-planned as rev 2. **This is the round's most valuable
output.**

### Decisions

**1. `97a9b0ab` WAS HELD BECAUSE CHECKING PRODUCTION FIRST SHOWED THE APPROVED PLAN WAS WRONG.**
The plan said the resolved statutory pack "is simply never stamped on the output" and that historic
months "cannot be filled in retrospectively". Both are false, and the difference changes the build:
- **`statutory_pack` has ZERO rows.** This tenant computes from the BUILT-IN ruleset, not a signed
  pack. `core/payroll.ts:1943` records `packVersion`/`signedKeyId` only when `resolved.source === 'pack'`,
  so the planned stamp would have written **nothing** for every existing company.
- **The provenance ALREADY EXISTS per-slip** as `statutory.version`. The plan asked for a migration to
  add what is already recorded, and told the reporter their history was unexplainable when it is not.
- **THE RULESET MOVED MID-YEAR AND CORRELATES PERFECTLY WITH REVISION:** 14 slips on `2026.4`
  (**0 revised**), 33 on `2026.5` (**all 15 revisions**). The plan attributed the reporter's two tax
  figures solely to cumulative PCB replay. That is now insufficient — the rules themselves changed
  between computations, and shipping the plan would have told the reporter something reassuring and
  incomplete **about their own tax figures**.

Rev 2 carries this evidence and flags what must be settled first: **diff the built-in ruleset between
`2026.4` and `2026.5`** to see whether the bump was behavioural. If it was not, the disclosure must not
imply it moved anyone's tax. **Migration `0339` is NOT required for the read-side half and was not
allocated** — the value is already in the JSONB.

**Still true and not to be re-opened:** the PCB accumulator is CORRECT. It replays `priorSlips`, so
revising month N legitimately moves month N+1 with that month's gross unchanged. A scout corrected the
plan's line numbers to `core/payroll.ts:2451-2519`. **Do not "fix" it.**

**2. THE WORKFLOW HARNESS KILLED THE BUILD AGENT SIX TIMES, AND THE CAUSE IS A TIMEOUT, NOT THE WORK.**
The run cost **2.4 hours / 948k subagent tokens / 387 tool calls** and failed with
`agent stalled on all 6 attempts (no progress for 180000ms each)`.

**Async agents are killed after 3 minutes with no visible output, and this repo's test startup exceeds
that**: a targeted vitest run builds a template plus ten worker databases, and every `CREATE DATABASE`
forces a Postgres checkpoint. The agent was being killed MID-TEST-RUN, repeatedly, and each restart
re-oriented from scratch. Two of the six also died on a genuine `server_error`, which no timeout change
fixes.

**The knob is `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`** (the only agent-stall env var;
`CLAUDE_CODE_STALL_TIMEOUT_MS_FOR_TESTING` is a test-only variant). **r87 set it to `600000` in
`.claude/settings.local.json`.** Without that, do not run a build agent on this repo under a workflow —
it will not converge. Note the trade-off: a genuinely hung agent now burns 10 minutes before being
killed.

**What the workflow DID earn its keep on:** the three parallel read-only MAP agents all succeeded, and
one corrected the plan's drifted line numbers. **Parallelise investigation and review; keep the BUILD
single-threaded** when items share files — which these three did (all land on the run detail screen and
`core/payroll.ts`), and which is why they were one agent rather than three.

**3. The killed agent left a real breakage that only `tsc` caught** — a duplicate `isRegular`
declaration in `app/payroll/[batchId]/page.tsx` (declared once for the loan summary, again for the
d0d2c9d1 indicator). Harmless-looking, and it would have failed the gate. **Anything a killed agent
leaves behind is half-finished by definition: re-run the gate over its work rather than assuming the
commits are complete.** The i18n catalogs were the near-miss — `en`/`ms` were done and the other four
empty at one point; had it died there, the i18n coverage check would have caught it, but only because
that guard exists.

**4. Both shipped items deliberately STOP SHORT of the destructive half, and the reporter is told so.**
`ef31d251` does not auto-close the 18 historic runs — the close path fires the payslip-ready
notification, so a backfill would notify every employee for every month at once. `d0d2c9d1` does not
pay the outstanding RM23,170 and adds no automatic reset-and-regenerate, which would silently unwind
loan ledger entries. Both `build_ref`s say this in plain words and invite the reporter to commission
the rest.

**5. The deploy verification introduced in r86 paid off immediately** — `rsync` real exit code captured
without a pipe, then a `--dry-run -i` re-check proving **zero** outstanding files before running
`deploy.sh`. No repeat of r86's half-synced tree.

---

## r86 — 2026-07-31 — 13 items that were built a session early and never shipped

**Shipped:** `main@c95e2b5`. Migrations `0335`, `0337`, `0338` (production **283 → 286** applied).
**Gate:** `tsc` clean · **499 files / 5812 tests** · `next build` clean · **upgrade rehearsal PASS**
(8 employments, 63 events, 488.00 leave days all intact across the upgrade).
Verified live: `GET /` 401, service active, 286 migrations, watermark `1781862438000` = `0338`, all
five new columns present, and `app/admin/personnel/new/page.tsx` on the box.

**Shipped:** 0890a555 (Scheme Category) · 4d6eae7b (Leave Year Type step) · 9f5164d8 (rounding
thresholds) · c6ffa725 (application limits) · 4dbe04c6 (Minimum Service overflow) · 1f6fd6d8 +
ed17a4f9 + 994a5287 + 026e16b9 (the leave-summary cluster) · 6d671f44 (Create New Employee wizard) ·
d8471481 (.xlsx employee import) · fe3eb141 (**step 1 of 2**) · ae9350f2 (Termination movement).

### THE ROUND WAS ALREADY BUILT AND HAD NEVER BEEN GATED, MERGED OR DEPLOYED

Four agent branches and a clean integration commit sat on `build/r86` while `main` stood at r85. The
work was complete; nothing had verified it. **Run `git log --oneline main..build/rNN` for every recent
`build/*` branch before planning new work** — a finished round nobody shipped looks exactly like no
round at all. The session that built it also left the local Postgres wedged mid-`CREATE DATABASE`,
which is probably why it stopped where it did.

### Decisions

**1. FOUR INTEGRATION FAILURES, ALL THE SAME SHAPE: a source-text guard matching more than it meant.**
Every agent was green on its own files; these appeared only where branches met, which is what the
integration gate is for. None was a defect in shipped behaviour.
- `employee-draft-wizard` asserted its migration's number exceeded EVERY other entry — true alone,
  false the moment a sibling's higher-numbered migration merged beside it. The real invariant is
  monotonicity against what runs BEFORE it. Now compares against lower idx only.
- `shared-leave-group` (r82's guard) forbids a rival per-application cap column on `leave_type`.
  r86a added `max_days_per_leave_year` — a per-YEAR total, a different rule — and CITED the existing
  column by name in a comment as the naming precedent. The guard greps raw source, so **a citation of
  the invariant read as a violation of it.** Comments are now stripped before matching.
- `leave-inquiry-layout` scanned the WHOLE FILE for a class whose subject is table HEADINGS. Scoped
  to `<thead>`.
- `leave-apply-popup` pinned a hand-written key list; r86b's summary rebuild legitimately renamed a
  key, so the list failed while the thing it protects was healthy. Now DERIVED from
  entitlement-panel-config's own labelKeys.

**The rule: a guard that greps source text will eventually match a comment, a sibling's file, or a
renamed-but-correct key. Scope it to the construct it is about, or derive it from the thing it is
protecting.**

**2. THE GROUPING ERROR THIS FILE ALREADY WARNED ABOUT, MADE AGAIN.** `026e16b9` (compact the Employee
Leave Records layout) and `fe3eb141` (add a `#reference` column, Status pill, approval lines and Cancel
Leave to the same rows) went to DIFFERENT agents because they read as different themes. They land on
the same file. That is an INTEGRATOR error, not an agent one — **group by FILE OVERLAP, not by theme**,
which this document has said since r74. Resolved by keeping C's structure and re-applying B's layout
over it; B had widened the reason column precisely because the compacted columns give that width back,
so taking one without the other would have re-created the overflow `026e16b9` exists to fix.

**3. A FUTURE-DATED TERMINATION ENDED EMPLOYMENT TODAY — a live defect, not a gap.**
`terminateEmploymentTx` closed the open assignment version and open reporting lines at the termination
date, so every reader resolving "current" as the OPEN row lost the employee's department, position and
manager **the instant a future exit was keyed**. Now follows `941c9dac`: record
`employment.movement.scheduled` and nothing else; the sweep applies it on the morning of its effective
date, apply-once via `0329`'s index. Pending terminations can be cancelled and corrected. Termination
was never greenfield — `termination` has been a MOVEMENT_KIND since `78853b97`.

**4. The Leave Balance Summary ADDS UP BY CONSTRUCTION.** Every addend is a bucket of the `0315dac7`
ledger partition, and those buckets tile every ledger row <= asOf, so
`brought forward + entitled + adjustments − forfeited − taken = balance` is an identity rather than an
agreement. **The recorded deviation is kept and now pinned:** the reporter's formula
`YTD Entitled = Eligible x (elapsed / year)` is a projection — right for the 57 earned-monthly policy
rows, wrong for the 10 that grant the year up front, where a part-year share would stop the column
reaching Available Balance. YTD Entitled renders the granted-to-date LEDGER figure, and a test asserts
that moving Eligible alone moves nothing else on the column.

**5. A BROWSER REPRODUCTION SETTLED A CSS BUG THAT SOURCE READING WOULD HAVE MIS-DIAGNOSED.**
`4dbe04c6`: `inputCls` ends in `w-full`, and a template-string `${inputCls} w-28` does not beat it,
because the cascade is decided by **the order Tailwind emits the utilities, not by the class
attribute**. `shrink-0` then turned the losing width into an overflow. Measured live at 26px / 336px in
a 336px cell (scrollWidth 368); fixed by composing through `cn()` (tailwind-merge) and re-measured at
218px / 112px, scrollWidth == clientWidth. A guard now fails any control pairing a template-string
width with `shrink-0`.

**6. `fe3eb141` SHIPPED HALF, DELIBERATELY.** The Cancel Leave action, `#reference` and Status column
landed; **the removal of the Requests subsection is HELD** — it is the org-wide register and the only
home of three subject-only controls. The reporter is told this plainly in the `build_ref` and asked
where those controls should move. Also fixed unasked: Applied and Final Approval Date rendered with
`toISOString()`, so they read as YESTERDAY between 00:00 and 08:00 MYT — the same class as r85's
`core/movement.ts` fault, on the very column this item anchors to.

**7. `0890a555`'s "smart default" is a SUGGESTION and nothing writes it.** `suggestSchemeCategory()`
is offered only on the ADD form and only until HR types. An existing scheme is never re-categorised
behind the tenant's back, and entitlement resolution never reads the category.

### Deploy: THE RSYNC LIED, AND THE ONLY REASON IT WAS CAUGHT IS THAT IT WAS RE-CHECKED

The first rsync died mid-transfer (`Broken pipe`, `unexpected end of file`) and the wrapper reported
**`RSYNC_EXIT=0`** — because the exit code came from the `tail` at the end of the pipeline, not from
rsync. `deploy.sh` then ran happily: it built, applied all three migrations and restarted, so **every
signal said success while 93 source files on the box were still the previous release.** Production sat
with its schema ahead of its code.

A `rsync -azi --delete --dry-run` re-check afterwards is what found it — it must report **zero**
changed files. Re-synced (with `--partial --timeout=120` and `ServerAliveInterval`), verified zero,
redeployed, and only then verified live.

**Two rules from this.** Never read an exit code through a pipe — `cmd | tail` reports `tail`'s
status; assign `rc=$?` immediately after the bare command. And **`deploy.sh` succeeding is not evidence
the tree arrived**; the dry-run diff is. This is the deploy-side twin of the r83 gate trap: a green
signal computed against the wrong tree.

---

## r85 — 2026-07-31 — the keystone lands, and the machine that was slowing everything down

**Shipped:** `main@e05099b`. Migrations **0333** and **0334**.
**Gate:** `tsc` clean · **490 files / 5627 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, **283 migrations**, `leave_type` ANNUAL reading
`carry_forward_expiry_months = 6`, and **zero** policy rows disagreeing — so `0334`'s assertion applied
without refusing, which is the proof the data genuinely agrees rather than the guard being lenient.

**Shipped:** `9816a5ad` step 2 — the entitlement keystone, three rounds in the making.

### Decisions

**1. THE APPROVED PLAN WOULD HAVE FROZEN FIVE SETTINGS FOREVER, AND NOBODY NOTICED FOR THREE ROUNDS.**
The sequence was: step 1 adds rule columns to `leave_type` (r81), step 2 makes the engines read them,
step 3 (`fa3f4ccb`) deletes the old per-policy editors. **Nothing in it ever built a writer.**
`updateLeaveType` (`core/admin.ts`) sets name/code/eligibility/probation and none of the rule columns;
`build/r83a` touched zero files under `app/` or `components/`.

Ship all three as approved and Earning Method, Carry Forward + expiry, Rounding and Maximum Balance are
un-editable for all time, fixed at whatever `0325` backfilled. Worse, the screen that *looks* like it
edits them survives and writes `leave_policy` rows nothing reads — **a control that saves successfully
and does nothing**, which is worse than an absent one.

**The owner found this by asking a question, not by reading the plan:** "can't we just make this
configurable for future customers?" The honest answer turned out to be no, and it never would have been.
`setLeaveTypeRules` + `setLeaveTypeRulesAction` close it, and the two General sub-steps now post the type
action. The per-policy scope picker is gone — one leave type, one set of rules, which IS the consolidation.

**2. THE REPORTER REVERSED THE VALUE, AND THE GUARD IS WHY WE ASKED.** `0334` (as `0328`) was run against
production BEFORE deploying and **fired**: ANNUAL `carryForwardExpiryMonths`, one policy row disagreeing.
The audit trail showed it was a live edit — 8 at 10:06, 6 at 11:10 the same morning. Rather than
overwrite it, we asked; the reporter answered "**6 months, as this is the new policy**", reversing the
operator's earlier call of 8. `0333` harmonises all 57 rows to 6. **Carried Annual Leave now forfeits two
months earlier than before** — a real behaviour change, disclosed in the approved plan and recorded in
the migration so nobody later reads it as a tidy-up.

**3. A DATE BUG THAT ONLY EXISTS FOR EIGHT HOURS A DAY, FOUND BY RUNNING THE SUITE AT 01:46.**
`core/movement.ts`'s `dateOf` was `d.toISOString().slice(0, 10)`. `toISOString()` is UTC; Malaysia is
UTC+8. So between **00:00 and 08:00 local, every movement's `entryDate` was stamped with YESTERDAY** —
on `941c9dac`, the item whose entire subject is telling entry date and effective date apart, live since
r83 that morning.

**It survived three green gates because the suite had only ever run during the Malaysian working day**,
when the UTC and local dates agree. Fixed by routing the instant through `todayInKualaLumpur`, which
already accepts a `Date`.

**The wider class is real and deliberately NOT swept:** 92 sites use `toISOString().slice(0, 10)`. Most
are legitimate date-only arithmetic (`${iso}T00:00:00Z` + days), where UTC is the convention that makes
it exact. But roughly five derive TODAY from a real instant — `core/read.ts:696` and `:1917`,
`core/reporting.ts:224`, `core/roster.ts:921`, `core/performance.ts:368` — and carry the same fault.
Raised as **`bb4f2265`** rather than changed blind mid-round.

**4. THE MACHINE WAS THE BOTTLENECK, AND THE OWNER DIAGNOSED IT BETTER THAN I DID.**
Three separate causes, all closed:
- **Test namespaces.** `TEST_DB_NAMESPACE` exists so parallel AGENTS do not clobber each other's
  template. Running SOLO the operator invented one per round anyway (`r83int`, `r83bc`, `r84`, `r85`) —
  **~44 of the 72 databases, for no benefit.** Use the default when not running agents.
- **No teardown.** `test/global-setup.ts` now returns one, dropping the namespace it created. **Only
  ephemeral namespaces** — the default keeps its databases so `templateFingerprint()` reuse survives,
  which is what makes a repeat `pnpm vitest run` start in seconds. Verified: 11 created, 11 dropped.
- **A rehearsal database per round.** Passing `ai_hr_rehearsal_r84`, `_r85` minted a fresh one each time.
  Back to one stable name.

**The owner's design point, and it is better than what the script did:** the rehearsal now CARRIES THE
DATABASE FORWARD instead of rebuilding it. Production is never rebuilt — it is one long-lived database
that has accumulated every migration in order, including the awkward history a fresh baseline never has.
Carrying forward is both faster and a **more faithful simulation**. `--rebuild` keeps the clean-room path.

**The numbers, because they are the argument:** with 72 databases the rehearsal took 25–52 minutes and
often never finished, `DROP DATABASE` timed out at 90s, and crash recovery took **53 minutes** (all of it
the pre-redo walk over every database directory; WAL replay itself was 0.00s). After a wipe to 5
databases: **whole migration chain from zero in 2.3s, rehearsal PASS in 6s, Postgres starts in 4s.**
The old data directory is preserved at `/opt/homebrew/var/aihr-pg14.broken-20260731`.

**5. THREE SOURCE GUARDS PINNED THE OLD DESIGN AND WERE INVERTED, NOT DELETED.**
`leave-type-general-substeps` asserted both sub-steps post `updatePolicyAction` with the policy row as
the single source of truth — the exact contract this item reverses. It now asserts they post the TYPE
action and **not** the policy action, that the scope picker is gone, and that each form marks which HALF
of the rule row it rendered. Updating them also caught a live defect in the new action:
`roundingMethodField(formData) ?? null` would have CLEARED stored rounding whenever the marker was
absent, defeating the very tri-state the helper exists to provide.

**Operator errors this round, all caught before shipping:** the harmonisation migration was first
numbered AFTER its own guard (the guard would have refused the release that fixes it); JSX comments were
written in an attribute position; and `0328` needed renumbering to `0334` because `build/r83a` predated
r84 — **the first held branch checked against r84's watermark trap, and it was indeed stale.**

**Carried:** `fa3f4ccb` is contested — the reporter asked to remove the STATUTORY MINIMUM. Refused in
plan rev 4: it is the EA 1955 legal floor, not a setting, and removing it grants less leave than the law
requires. The plan offers what they likely want instead (show when the floor overrides the configured
figure) and states that removal needs an explicit written instruction. `1ef1cf95` is also contested —
they want Shared Leave Groups redesigned up to leave-type level, which is a data-model change.

---

## r84 — 2026-07-30 — the status state machine lands, and a migration that would have been skipped

**Shipped:** `main@b1260b5`. Migrations **0331** and **0332**.
**Gate:** `tsc` clean · **488 files / 5588 tests** · `next build` clean · **upgrade rehearsal PASS**
(all row counts held across a column drop and an eligibility rewrite; leave balances unchanged at 488.00).
Verified live: `GET /` 401, service active, **281 migrations**, `assignment.status` column GONE, and the
2026 Annual cycle reading `["active","active_serving_notice","probation","resigned"]`.

**Shipped:** `9cbf5e0d` (Employee Status state machine, built in r81 and held since) · `00659c34`
(probation stays in the review cycle).
**Re-planned, not built:** `1ef1cf95` — browser-verified instead. `9816a5ad` rev 8 · `fa3f4ccb` rev 3.

### Decisions

**1. A MIGRATION THAT WOULD HAVE BEEN SILENTLY SKIPPED ON PRODUCTION — the r76 trap from a new
direction.** `build/r81b` was cut before r82 and r83 and carried migration `0326`, `when=…426000`.
Production had already applied through `0330` (`when=…430000`). **drizzle-kit reads the last applied
`when` as a watermark and ignores anything below it**, so `0326` would not have errored, not conflicted —
it would simply never have run, and the employee-status tables would have surfaced later as a missing
relation. Renumbered to `0331`.

r76's version of this was a REUSED number on an abandoned branch. This is the same failure from a
**stale** number, and that is the more dangerous variant: **any branch cut before other migrations merge
is a candidate, which is every held branch in the repo.** `build/r83a` (`0328`) is in exactly this state
right now — check its `when` against the deployed watermark before merging it, not after.

The 5 source comments citing "migration 0326" were updated too; a number in a comment that no file
carries is a dead end for the next reader.

**2. `0331` COULD NOT MAP ANYTHING TO `probation`, AND THAT IS WHY 12 PEOPLE WOULD HAVE VANISHED FROM
THEIR OWN REVIEW.** `0331` remaps stored review-cycle eligibility faithfully — `on_leave→active`,
`offboarding→active_serving_notice`, `terminated→resigned`. But `probation` was never a storable value,
**because before `0331` nobody ever displayed as being on probation** — the deriver read only the
confirmation dates and everyone showed Active from day one. That display fault IS `9cbf5e0d`'s subject.

So the instant probation becomes real, a cycle written to mean "everyone" quietly stops meaning everyone.
Production's 2026 Annual cycle named all four pre-`0331` values; 12 of 22 employments have a future
probation end date. **The fix is not part of the item that causes it, and no gate could have seen it** —
both changes are individually correct and the collision exists only in the customer's configuration.

`0332` adds `probation` to any cycle naming `active`, **deliberately not keyed to the one production
UUID**: `active` means currently working, somebody on probation is currently working, and no cycle can
have excluded the value deliberately because it did not exist to exclude. Keying it to one id would leave
the trap armed for the next cycle created from an old template. Additive and idempotent; production
reported `[0332] added probation to 1 review cycle(s)`.

**3. THE FIRST BROWSER VERIFICATION SINCE r70, AND IT SAVED A REBUILD.** `1ef1cf95` came back contested
with "there is nothing build as according to my request, the shared leave group is not even visible now" —
a post-deploy refutation of r82, shipped hours earlier. Looked at the live screen rather than arguing from
source:
- The **Create shared leave group button renders**. r82 is deployed and correct.
- The group **exists**: Chin Hin Construction Engineering / GRADE H (Permanent) carries
  `Shared limit "Special Leave": 10 days/year`.
- The Leave Entitlements table is **scheme-scoped**, and its selector defaults to `CONTRACT - SPECIAL
  (40 AL)` — a scheme with zero entitlement rows — so the screen opens on "No entitlements configured for
  this scheme" with no hint that the group lives elsewhere.

**Default selection, not a missing feature.** Building "according to my request" would have produced a
second copy of a working feature. Five minutes in a browser settled what eight rounds of source-reasoning
could not. **Reinstate this as routine.**

**4. HOW THE CUSTOMER ACTUALLY REACHES THE APP — undocumented until now, and fragile.** ai-hr is NOT
publicly served: Next listens on `127.0.0.1:3000` only and no nginx vhost points at it
(`sfm.stradaprop.com` is Odoo on 8069). The reporter reaches it through a **cloudflared QUICK TUNNEL**,
`https://remove-source-wood-currently.trycloudflare.com`, running since 18 June.
**A quick tunnel's hostname is random and CHANGES on restart.** If that process dies the reporter loses
access and returns on a different URL. Worth converting to a named tunnel before it bites.

**5. TWO OF MY OWN MISTAKES, both of a shape this file already warns about.**
- **A gate that ran on the wrong tree and reported GREEN.** One `cd` to the repo root left the shell
  there, and a full suite plus `next build` ran against `fix/companies-list`. The tell was in the output:
  vitest prints its root on the `RUN` line, and the counts were 479/5359 where the tree under test was
  488/5576. **Every gate command now starts with `pwd`.**
- **A test fixture that failed on NOT NULL before reaching the behaviour under test** — omitted
  `period_start`, `period_end` and `rating_scale`. The fixture now carries a comment saying why those
  columns are present, so the next editor does not strip them.

**Carried:** `9816a5ad` step 2 remains built and unmerged on `build/r83a` with migration `0328` — see the
watermark warning in Decision 1. Everything in r84 except `1ef1cf95` is still browser-unverified.

---

## r83 — 2026-07-30 — two of three shipped, and the keystone held by its own guard

**Shipped:** `main@69d8968`. Migrations **0329** and **0330**. `0328` is deliberately UNUSED — see below.
**Gate:** `tsc` clean · **487 files / 5549 tests** · `next build` clean · **upgrade rehearsal PASS** (leave balances unchanged at 488.00).

**Shipped:** `941c9dac` (movements take effect on their effective date) · `61bf109d` (pay item input
types + formula).
**HELD, built and unmerged on `build/r83a`:** `9816a5ad` step 2 — the entitlement keystone. Re-planned
as revision 7 and returned to the reporter.

### Decisions

**1. THE ROUND WAS INHERITED, NOT STARTED. Three branches were already built and never integrated.**
`build/r83a`, `build/r83b` and `build/r83c` were committed between 02:59 and 03:42 on 2026-07-30 with no
merge, no gate and no HANDOFF entry — a session ended mid-round. Nothing in the repo said so. The signal
was `git branch --sort=-committerdate` showing three `build/r83*` branches ahead of `main`.

**And the repo root was on the wrong branch, exactly as the previous handoff warned.** The root worktree
is parked on `fix/companies-list`, four rounds behind. **The HANDOFF.md read from the repo root was the
STALE one** — it described the board as "11 approved, 4 contested" and the head as `e82c519`, both of
which were four rounds out of date. `main` is checked out at `.claude/worktrees/mainwt`. Read the handoff
from there, or read nothing.

**2. `0328` FIRED ON PRODUCTION, AND HOLDING THE KEYSTONE IS THIS ROUND'S REAL OUTPUT.**
`9816a5ad` step 2 repoints the leave engines onto `leave_type`. Its migration `0328` is an assertion with
no DDL, which refuses the release if any policy row of a consolidated type would resolve a different rule
than the type carries. Run against production before deploying, it **fired**:

    leave type ANNUAL, rule carryForwardExpiryMonths, 1 policy row disagreeing

56 of 57 ANNUAL policy rows read 8 months; one reads 6. The audit trail settles that it is a LIVE EDIT,
not stale data — `leave-policy.updated` at **2026-07-30 10:06 carries 8**, and at **11:10 the same day
carries 6**. Consolidating would have silently reverted an edit made three hours earlier, and `deploy.sh`
would have aborted on `0328` with `0329`/`0330` unapplied.

`leave_policy` has **no `updated_at` column**, so `created_at` (2026-07-26) says nothing about when a
value changed. That is precisely why r81's `0325` distinctness assertion passed on 2026-07-29 and `0328`
fires now, and it is the general lesson: **on this table, creation time is not change time — use the
`leave-policy.updated` events.**

Blast radius is nil (0 employments on that company+grade), which is why the agreed resolution is to
harmonise that row to **8** and let `0328` pass on its own terms. **The assertion was not weakened.**

**A second reason to hold, which no guard could see:** the reporter was editing leave configuration
*while the round was being integrated* — `leave-type.updated` 12:07, `scheme-leave-entitlement.set` 11:53.
Repointing where those settings are read from, mid-edit, is its own hazard.

**3. TWO INTEGRATION DEFECTS, AND BOTH WERE RED ON THEIR OWN BRANCH.** This is a NEW failure mode: r74
and r75 shipped defects that were genuinely invisible to any single agent, but these two were not.
- `core/movement-apply.ts`, a file `build/r83b` created, imports `core/leave` directly and breaches
  ADR-0080 D9's import ratchet (`test/leave-pack-drift.test.ts`, allowlist "only ever shrinks"). This is
  a purely STATIC test over that branch's own file — it could never have passed there. Routed through
  `packs/leave/service`.
- `test/movement-effective-date.test.ts` asserted `sweepDueMovements(...).applied === 1`. The sweep is the
  nightly TENANT-WIDE job, and an earlier test in the same file leaves a pending future movement behind,
  so the honest answer is 2. Re-asserted against that employment's `employment.movement.applied` ledger —
  strictly stronger for the property under test and immune to file order. The run-twice test carried the
  same coupling and is now a lower bound, its exactly-once proof being the per-employment query it
  already had.

**So the rule gains a clause: per-agent runs are necessary and never sufficient — but confirm the agent
actually RAN one.** A branch that was never gated is cheaper to catch than a cross-item defect, and
neither is caught by reading the diff.

**4. THE ROUND WAS SPLIT RATHER THAN HELD WHOLE.** r83b and r83c touch movement and pay components and
have no dependency on r83a. Shipping them keeps two approved items moving while the keystone waits on one
answer. `0328` stays unallocated as a NUMBER GAP, which is already precedented — `0326` has been held for
`build/r81b` since r81. A gap is safe; a REUSED number merges as a silent skip (r76).

**5. LOCAL POSTGRES: A WEDGED CHECKPOINTER, AND THE TEST-DB LEAK BILLED IN A NEW PLACE.**
Mid-round the box stopped being able to `CREATE DATABASE` or `DROP DATABASE` — both hung at
`CheckpointStart` for 10+ minutes. The diagnosis that mattered: `checkpoints_req`, `buffers_checkpoint`
and `checkpoint_sync_time` were **byte-identical across 40 minutes**, and an explicit `CHECKPOINT` timed
out at 120s. Not slow — **wedged**. Disk was fine (382 GiB free), no fsync or panic in the log.

`pg_ctl -m fast` could not stop it (fast shutdown waits on the very checkpoint that is stuck), so it took
`-m immediate`. Recovery then ran **42 minutes** — and the log is the punchline:

    redo done at 50/E14139D0 system usage: CPU: user: 0.00 s, system: 0.00 s, elapsed: 0.00 s

**WAL replay was instantaneous.** All 42 minutes were the pre-redo pass in which Postgres walks every
database directory on disk, and there were **67**, each a full HR schema. Confirmed live by `lsof` on the
startup process, which held `base/` and one database directory open throughout.

**So the leaked test databases do not slow checkpoints — they slow CRASH RECOVERY, entirely.** That is a
different bill from the one this file has recorded since the 1308s incident, and it is paid at the worst
possible moment. After the restart a `CHECKPOINT` completes in **0.078s**. The sweep then ran clean:
**28 dropped, 0 failed, 67 → 39 databases.**

**6. THE ROOT-WORKTREE TRAP BIT AGAIN, MID-GATE, AND THE GATE READ GREEN ANYWAY.** One `cd` to the repo
root to read `scripts/improve/cli.ts` left the shell there, and the next full suite and `next build` ran
against **`fix/companies-list`** instead of the integration branch. Both reported clean. The tell was in
the output all along — vitest prints its root on the `RUN` line, and the counts were **479 files / 5359
tests** where the r83 tree is **488 / 5576**.

**A gate is only evidence if you can prove which tree it ran on.** Read the `RUN` path, or start every
gate command with an explicit `cd` to the worktree. The previous handoff put this trap in its second
line and it still cost a full suite run.

**7. `TaskStop` DOES NOT STOP THE DATABASE WORK A TEST RUN STARTED.** Killing a background vitest left its
server-side `CREATE DATABASE` running, wedged at `CheckpointStart`. The next full-suite run came back with
**12 failures — every one a 30-second timeout, including a test whose body is only a file read** — and
took 947s against 438s for the same tree. All twelve were artefacts of that one orphaned statement. Kill
the client, then check `pg_stat_activity` and cancel what it left behind.

**Carried:** still nothing browser-verified since r70. `61bf109d`'s pay-rule editor and `941c9dac`'s
movement screens are both source-reasoned only.

---

## r82 — 2026-07-30 — the shared leave group gets a door, and a cap that never existed

**Shipped:** `main@c8bb831`. Migration **0327**.
**Gate:** `tsc` clean · **485 files / 5504 tests** · `next build` clean · **upgrade rehearsal PASS**
(leave balances unchanged at 488.00). Verified live: `GET /` 401, 277 migrations, the cap column present,
and the one existing group carrying **no** cap — nullable behaving as designed.

**Shipped:** `1ef1cf95`.

### Decisions

**1. THE FEATURE WAS NOT UNDISCOVERABLE — IT WAS UNREACHABLE, and that distinction was the whole item.**
r78 investigated this and concluded the shared pool already existed (migration `0220`, enforced at submit
`core/leave.ts:1919` and approval `:2996`) and only the creation *affordance* was missing, because groups
are made by DRAGGING one row onto another. The build found the sharper truth: **inside a leave type's
Entitlement step the table renders exactly ONE row**, so drag-to-group cannot be performed there at all —
you cannot drag a row onto itself. The reporter was not failing to find a button; there was no possible
gesture. Hence a `pick` mode with a member checklist sourced scheme-wide (`allEnts`) rather than from the
scoped view, opening the SAME `CreateGroupDialog` and posting the SAME `groupSchemeLeaveTypes` action.

**2. The per-application cap is NULLABLE with no default, deliberately.** Every existing group in every
database means "no cap"; a defaulted value would start refusing real applications on deploy day.
Production confirms: 1 group, 0 with a cap set. `CombinedLeaveApplicationTooLongError` is a **separate**
error from `CombinedLeaveLimitExceededError` and is checked FIRST, because "this application is too long"
is a property of the application alone and holds even with the whole pool untouched. Refusal only — never
truncation. Both asserted by class AND payload, and each asserted `not.toBeInstanceOf` the other; a bare
`rejects.toThrow()` would have passed on either.

**3. The units are pinned by a test, not by a comment.** "3 consecutive days" was read as CALENDAR days,
and a Friday→Monday span (4 calendar, 2 working) is asserted to be refused by a cap of 3. If the reporter
meant working days that test fails loudly rather than drifting. The whole of the change lives in
`applicationSpanDays(startDate, endDate)`; the stored column has no unit baked in, so switching needs no
migration. The reporter has been told, in the `build_ref`, which reading shipped.

**4. A trap left for the next editor, disclosed rather than hidden.** `updateSchemeCombinedLimit` is an
**absolute set, not a patch**. A future form posting that action without the cap field will silently clear
the cap. Mitigated with a hidden input on the total-limit form, a visible one on the rename form, doc
comments at both call sites, and a CRUD test asserting the clearing behaviour — but the shape remains.

**Not done:** the reporter's Special Leave Group is not pre-created as data. That is tenant configuration,
not code.

---

## r81 — 2026-07-29/30 — the entitlement keystone begins, and payroll has never paid anyone

**Shipped:** `main@6b225b5`. Migration **0325**.
**Gate:** `tsc` clean · **484 files / 5487 tests** · `next build` clean · **upgrade rehearsal PASS**
(step 4 confirmed, leave balances unchanged at 488.00). Verified live: `GET /` 401, 276 migrations, all
ten new `leave_type` columns present, 10 types backfilled, ANNUAL reading
`earned_monthly / 10.00 / up`.

**Shipped:** `9816a5ad` **STEP 1 OF 3 ONLY** — additive and inert.
**Investigated:** `a1d82340` — the payroll process map, pushed to the board.
**HELD pending a reporter answer:** `9cbf5e0d` — see Decision 3.
**`9816a5ad` remains `building`, deliberately.** Step 1 changes nothing a user can see; marking it
deployed would tell the reporter their consolidation had shipped while the calculation still reads
`leave_policy` entirely.

### Decisions

**1. THE PAYROLL MODULE HAS NEVER DELIVERED A PAYSLIP TO ANYBODY.** The `a1d82340` map traced from 18
executed runs backwards and found three live faults, raised as separate items rather than folded into a
redesign:
- **`ef31d251` — zero runs have ever been closed.** A payslip becomes visible to an employee only when
  its run is closed (`closeBatch`, `core/payroll.ts:3673-3700`, sole writer of `closed_at`/`released_at`;
  ESS gate at `core/read.ts:3818`). All 47 payslips exist, calculate correctly, and are invisible to
  every employee. The "payslip ready" notification fires on close, so it has never fired. **A step
  skipped 100% of the time is a design problem, not a training gap** — it is one unconfirmed button with
  nothing indicating pay stays hidden until pressed.
- **`d0d2c9d1` — RM23,150 of pay entered and never paid.** Attach-on-generate is guarded
  `if (!subset && runType === 'regular')` (`:1974-2007`) and `createBatch:591-596` then refuses a second
  batch for the period — so **a run narrowed to some employees permanently strands the rest and locks the
  month.** Anything keyed after processing is never collected. 14 of 18 runs paid fewer people than the
  company employs. `payroll_individual_txn` holds RM22,500 of BONUS rows that reach no payslip.
- **`97a9b0ab` — same employee, same month, same gross, two different tax figures.** PCB 1779.35→889.67
  and 112.30→374.20 across re-runs with gross unchanged. 15 of 47 payslips revised, 4 of them three
  times. `pay_period.statutory_version` is NULL on all 18 rows, so **which tax rules produced a past
  payslip cannot currently be proven.**

**The engine itself is sound** — 47 payslips, 18 runs, no duplicates, headcount matching payslip count
every time. What is over-complicated is everything around it: **eight** ways to add money to a payslip,
**three** contradictory definitions of the step order, and a five-stage lifecycle whose last two stages
have never been used.

**2. STEP 1 OF THE ENTITLEMENT MOVE, AND HOW "NOTHING READS IT" WAS PROVEN.** Agreement proves nothing —
a correct backfill agrees with the policy by construction. So the proof filled the new columns with
**contradicting** values (lump instead of earned, round DOWN, carry cap 0, max balance 1 day) and showed
the figures do not move. If any engine had started reading the type, entry types, day counts and balance
would all have diverged at once. Figures are pinned absolutely, not merely self-consistent.

The backfill **asserts** that each leave type has at most one distinct value per rule and RAISES
otherwise — never `LIMIT 1`, which would pick an arbitrary winner and silently change someone's leave.
Values are sanitised **the way the engine reads them** (`jsonb_typeof` gates every cast, leap-correct
month/day validation), because the value carried must be the one the engine acts on, and a type whose
rows differ only in an invalid date does not actually disagree about behaviour.

**Verified against production before deploy, closing both flags the agent could not reach:** zero
conflicts across all ten rule keys (the assertion will not fire), and **zero policies use per-band
`carryForwardDays`**, so the silent-fallback risk it flagged does not apply to this tenant. **Step 2 must
still decide explicitly what happens to per-band carry overrides** — they lose their home when bands
become days-only.

**3. A CROSS-ITEM INTERACTION NO GATE COULD SEE — and the reason `9cbf5e0d` is held.** `9cbf5e0d` fixes a
real fault: **probation never worked.** The deriver read only `finalConfirmationDate ?? confirmationDate`
and **nothing writes either at hire**, so every employee serving probation has displayed **Active from
day one** while the stored column said `probation`. That mismatch IS the reporter's complaint.

But fixing it collides with the same round's status retirement. Production `review_cycle "2026 Annual"`
has `eligibility_rules = {"statuses":["active","on_leave","offboarding","terminated"]}` — all four old
values, i.e. everybody. The remap yields `["active","active_serving_notice","resigned"]`, and
**`probation` is absent because it never used to appear.** 12 of 22 active employments have a probation
end date in the future, so up to twelve people would silently drop out of the annual review.

Both changes are individually correct; the collision only exists in the customer's configuration.
**Raised as `00659c34` and planned with one recommended course** (add `probation` to that cycle), because
it decides who gets a performance review. Held rather than guessed.

**4. A THIRD caller-less-but-live writer.** `setEmploymentAssignment` took an exported `status?`
parameter with no UI caller — same class as `transferAction` (r78) and `decideLeaveAction` (r80).
Deleted, with a test proving supplying one is a no-op. **Three in three rounds: an exported `'use server'`
function is reachable whether or not any UI references it.** `9cbf5e0d` also dropped the status column
and enum outright rather than narrowing them — with manual editing gone the column would be written once
at hire, never correctable, and wrong the moment anyone passed probation: the same drift under a shorter
enum.

**Carried:** still nothing browser-verified since r70.

---

## r80 — 2026-07-29 — 2 items shipped, 1 held, and a second caller-less live endpoint

**Shipped:** `main@a76ec71`. **No migration.**
**Gate:** `tsc` clean · **483 files / 5457 tests** · `next build` clean · rehearsal not required (no
migration; stated rather than skipped). Verified live: `GET /` 401, `decideLeaveAction` gone from the
deployed tree, `applicantBalance` no longer referenced on the approvals page, the button reads "Submit".

**Shipped:** 33bf1a2d · d6429eb4. **Held and re-planned:** 031fa21b.

### Decisions

**1. `031fa21b` ASKED US TO DELETE THE ONLY HOME OF THREE CAPABILITIES — and the reporter's instinct was
still right, just aimed one screen over.** They asked to remove the Requests subsection from Employee
Details because "approvals are already handled under Approval Items". Enumerated before deleting:
- **It cannot approve anything.** Inline approve/reject was removed from that page by earlier consultant
  feedback. There are no decide controls in its markup at all.
- What it IS: the org-wide register over all four statuses (`listLeaveRequestsPage`), the 15-column
  filter set from `0773bda9` + `8ec63139`, a filtered export, and `AdminCancelLeaveDialog`.
- `/approvals` loads **pending only, 200-row cap, no filters, no export**. `/leave/employee-records`
  is single-employee with 4 of the 15 filters. **`app/leave/page.tsx` is the ONLY file in the repo that
  links `/leave/export`** — deleting the section orphans the route, which is exactly what r74 Decision 5
  predicted and it is still true.

**But the duplicate was real, one layer down.** `decideLeaveAction` in `app/leave/actions.ts` — a vestige
of the removed inline buttons, **no caller anywhere in the repo**, yet still a live callable endpoint
because every export of a `'use server'` module gets an action id. That WAS a second way to decide a leave
request, and it is now gone; leave is decided only through `app/approvals/actions.ts`.

**This is the SECOND caller-less-but-live server action found this way** (r78 removed `transferAction`).
Treat "no UI calls it" as insufficient — an exported server action is reachable regardless.

**2. The balance line was never in the shared cell, which changed the whole shape of the fix.** It was
passed as `children` from `app/approvals/page.tsx` alone, so "remove it from approvals" and "remove it
everywhere" were the same edit — no prop, no fork. The agent then **deleted `children` from
`LeaveDaysCell`'s signature**, so `tsc` rather than a reviewer is what prevents a second divergence in
that column. A type signature is a stronger guard than a test here.

It also removed the orphaned `approvals.applicantBalance` from **all six** catalogs: i18n check A walks
en → other locales only, so five stragglers would never have been flagged. The balance itself stays in
the shared projection (`core/read.ts:786`) — dropping a field from a SHARED selection changes what both
the flat and paginated leave reads return, and the approver still reaches it in one click.

**3. Process failure of my own: I invited a pattern-match deletion on a shared server.** My brief told
the agent to drop `ai_hr_test_tpl_r80a` and `ai_hr_test_w_r80a*`. It resolved that wildcard by querying
`LIKE '%r80a%'` and dropping whatever came back — flagged by tooling as discovery-by-pattern rather than
by tracked name. Outcome verified harmless (`ai_hr_dev` 262 migrations intact, base template 143 tables,
`ai_hr_test`, workers 1-10 and `ahr_build_golden` all present; 30 databases remain). **Give exact names
or let the harness do it — never a wildcard against a shared instance.** The proper fix remains the
teardown-on-exit task in Carried debt.

**Carried:** still nothing browser-verified since r70. Specifically unseen here: the cancellation Type
column now renders as a colour chip with a trailing " Leave" trimmed — the intended standardisation, but
the first time that table has looked that way.

---

## r79 — 2026-07-29 — 5 items, the blocked-item answer path, and an integration near-miss

**Shipped:** `main@7efe8f3`. Migrations **0323** and **0324**.
**Gate:** `tsc` clean · **482 files / 5432 tests** · `next build` clean · **upgrade rehearsal PASS**
(step 4 confirmed: "migrations applied over populated data"). Verified live: `GET /` 401, service active,
275 migrations, `feedback_block` present with 2 open episodes, `payment_basis` gone,
`company.probation_months` present, `system_explorer` in the module catalog.

**Shipped:** 4fb8b75a steps 1-4 · 707b3851 · b84821cf · 241817ef · deec1691 · plus the blocked-item
answer path (raised directly by the owner, not a board item).

### Decisions

**1. THE ROUND WAS BUILT ON THE WRONG BASE, AND ONLY THE REHEARSAL'S PRECONDITION CAUGHT IT.** The `main`
BRANCH was stuck at r77: the companies hotfix and all of r78 had landed on `fix/companies-list`, because
the diagnostic agent spawned to investigate the companies screenshot created that branch **at the repo
root**, and every subsequent commit followed it unnoticed. Deploys were unaffected — rsync copies the
working tree, not a branch — but **the r79 worktrees were created off `main`, so all five agents built on
r77.** Merging that would have reverted r78 and the companies hotfix, sending the Companies screen back
to rendering 1 of 8 rows.

`tsc`, 5388 tests, `next build` and the journal checks were all GREEN on that tree. What refused was
`scripts/upgrade-rehearsal.sh`: it requires a worktree checked out at the baseline ref, found none on
`main`, and exited 2. **A precondition that looks bureaucratic is the only thing that noticed.** Fixed by
creating a `main` worktree, fast-forwarding it, and merging `main` INTO the r79 integration so the round
builds on top rather than replacing it; the full suite was then re-run and the earlier green discarded.

Two operational notes: `git branch -f` is blocked by the permission classifier, so the fast-forward was
done as a `--ff-only` merge inside a worktree. And **the repo root is still on `fix/companies-list`** —
whoever picks this up should check `git branch --show-current` at the root before creating worktrees.

**2. A MERGE DROPPED A MIGRATION FROM THE JOURNAL, AND THE EXISTING GUARD POINTED THE WRONG WAY.** `0323`
and `0324` came from different branches and both appended to `_journal.json`; git conflicted, and the
first resolution kept only one side. **`0323` vanished from the journal while
`0323_feedback_block_answer.sql` stayed on disk.** That deploys clean and the table is simply never
created, because drizzle-kit iterates the JOURNAL, never the directory.

`test/migration-journal-ordering.test.ts` asserted "a .sql exists for every entry" — which fails loudly —
but never "an entry exists for every .sql", which fails silently. That guard now exists, verified
red-before-green (`be04fbb`). **This is the same silent-skip family as the ascending-`when` rule, reached
from the other direction.**

**3. Three separate checks this session passed without crossing the boundary where the thing breaks.**
The companies screen (props asserted, never sent through the RSC transport) · the `0323` backfill
(applied to an existing DB, never to a fresh chain — `WHERE status = 'blocked'` cannot parse a newly-added
enum value in the transaction that added it, so it broke every fresh install) · the journal merge (read
the journal, never the directory). **Ask what boundary the real thing crosses that the check does not.**

**4. The blocked-item answer path — the loop had been asking questions it could not receive answers to.**
Gates were `canReview` (planned), `canRefute` (deployed), `canRestore` (cancelled); nothing handled
`blocked`. A free-text question was a dead end. `0323` adds `feedback_block`, an append-only trail — one
row per block episode, question and answer kept together, closed once. `resolved_at` is deliberately
separate from `answer` so an operator unblock with no note ends the episode honestly rather than
fabricating one. Crucially the answer reaches `pullApproved` as `block_trail`, because that reads
feedback_request COLUMNS and never `domain_event` — an answer stored only as an event would be invisible
to whoever builds the item. Guarded by an INSERT policy, a one-way UPDATE policy, a BEFORE UPDATE trigger
(RLS is row-level and cannot stop a rewrite riding along with the close — the `0318` lesson) and a partial
unique index. `fa3f4ccb` was also re-blocked WITH `blockedById` so it links to the item that unblocks it;
that path always existed and had simply not been used.

**5. Fixing one reported fault keeps finding faults nobody reported.** `241817ef`'s agent measured the
impact by replicating live config in a scratch DB and running the REAL resolver: Medical leave is
unchanged everywhere, five companies move to manager→HR on Annual, and **one company's Medical approval
WIDENS** from a manager-only step to an ordinary single approval. It also refused to finish the
demolition — **two companies route live traffic through wildcard rules whose ONLY editor is the section
being deleted** — so the section stands, retitled, pending a reporter decision. `b84821cf` chose
warn-with-mandatory-acknowledgement over refusal (the levy is correctly zero; refusing withholds pay for
a data-quality issue) and found in passing that `currencyMismatch` was never merged into the advisory —
the same "warning exists but cannot reach the moment it matters" fault, in the function it was rewriting.

**6. `707b3851` was the SIXTH "already built" finding this session** — validation at save and the company
warning shipped in r77. The real gap was cross-company visibility.

**Environment, resolved:** the test Postgres reached **296 databases / 7.3 GB**; a single checkpoint ran
46 minutes and blocked five agents, and the rehearsal could not create its scratch DB. Swept with the
owner's authorisation: **296 → 31 databases, 7.3 GB → 1.6 GB**, rehearsal then ran normally. Cause: each
agent namespace is 1 template + 10 workers, the harness drops only its OWN namespace and only at START,
so every finished agent orphans 11 databases permanently. ~20 namespaces were created in this session
alone. **The fix is a teardown on run exit — see Carried debt.**

**Carried:** still nothing browser-verified since r70. The r79 UI surfaces (the answer box, the relocated
escalation editor, the new Personnel Settings page, the explorer) are all source-verified only.

---

## r78 — 2026-07-29 — 4 items + the payroll settings map, and duplicates nobody reported

**Shipped:** `main@e82c519`. No migration.
**Gate:** `tsc` clean · **478 files / 5355 tests** · `next build` clean · rehearsal not required (no
migration). Verified live: `GET /` 401, service active, `lib/import-file.ts` present, `transferAction`
gone from the deployed tree.

**Shipped:** a324a4b3 (attendance nav keys) · 11355c08 (dashboard Companies tile) · 63393e52 (import
file picker) · 4d391ab7 (untagged movement writers).
**Investigated:** 4fb8b75a — the payroll settings map, pushed to the board as revision 2.

### Decisions

**1. FIXING ONE REPORTED DUPLICATE FOUND TWO NOBODY HAD REPORTED.** `4d391ab7` complained that one
Promotion produced two Employment History rows. The brief required enumerating EVERY writer emitting a
projected event type before changing any — and that enumeration is the round's most valuable output:
- **Every hire with a manager projected TWO rows** — "Hired" plus "Reporting Line Change" — because
  `hireEmployee` writes its `reporting-line.set` inline and untagged. That is the reported bug's exact
  class, on every employee ever hired, and nobody had raised it.
- **Performance merit increases were labelled "Salary Adjustment"** because `enactCompAction` →
  `setCompensation` was untagged. Now tagged `increment` and correctly labelled.
- **`transferAction` was an unreferenced but LIVE RPC endpoint.** No UI called it, but an exported
  `use server` function is callable regardless. Deleted.
- Also rerouted: `setLocationAction` (Work Location) — with a test pinning r73 Decision 3's case, that
  the business unit survives.

**Two reroutes were REFUSED with reasons.** The Basic Salary card is the only writer that can create a
first salary record or change pay mode / payment term / `rate_amount`, and the comparison writer carries
none of those — rerouting would have deleted two capabilities to fix a row that was never duplicated.
Direct Superior stays out per r77 (`endReportingLine` emits a non-movement event; routing it would remove
the only way to CLEAR a superior).

**2. MY OWN PLAN'S PREMISE WAS FALSE, and the mistake is one this file warns agents about.** The
`a324a4b3` plan asserted the shift-library row "reads Attendance Policy" because its descriptor says
`labelKey: 'attendancePolicy'`. The catalog has resolved that key to **"Shift settings"** in all six
locales since R17 (`c9f7211`, 8 Jul). All three proposed renames were already live. **A labelKey is not
the label — resolve it against `messages/en.json` before describing what a screen says.** The round
still gained: the keys were renamed so key ≡ its own string (a real landmine for the next editor), with
a test pinning key ≡ camelCase(English label). No guard could have caught this — i18n check C walks only
`app/` and `components/`, never `packs/`.

**STILL OPEN and returned to the reporter:** `/admin/attendance-policy`'s own header reads "Lateness,
Early Out & Overtime Settings" while its nav row reads "Attendance policy" — the name their approved
plan pinned. Their original complaint (that setting is not findable) therefore still stands. Not guessed
at; the `build_ref` asks which of the two should change.

**3. THE PAYROLL MAP: seven pages are FIVE screens, and the master is empty.** `4fb8b75a` asked to
consolidate seven overlapping Payroll Settings pages. Traced from a payroll RUN backwards:
- **Payroll Schedule, Payroll Period Template and Payment Submission Control are three menu cards
  pointing at the SAME URL** (`/admin/payroll-config`), each named after a different section of one
  form. `lib/permissions.ts:335-382` registers five payroll screens, not seven. Not duplication — one
  room, three doors.
- **`company_payroll_config` has ZERO rows for all 8 companies**, while 18 payrolls have run and 47
  payslips issued. Everything falls back to the calendar month, which is the documented default — so
  nothing is wrong, but **nobody has ever exercised that screen**, and any consolidation assuming people
  rely on it would be assuming wrongly.
- **The cut-off master is Payroll Policies**, not any of the three pages the reporter named
  (`core/payroll.ts:237-271`, `core/payroll-policy.ts:475-528`). Only 2 of 23 employments have one.
- **One genuine two-writer duplicate:** the company statutory block is editable from Organization AND
  from the middle of the payroll screen. Same record, no coordination, last save wins.
- **`payment_basis` is dead configuration** — written, validated, stored, read by nothing.
- Three settings on the payroll screen are live but belong elsewhere: probation months (hiring), review
  reminder days (appraisals), default currency (compensation).

**Raised as their own items rather than folded into a redesign:** `b84821cf` — two employees flagged
subject to HRDF at unregistered companies; the payslip stamps `hrdfSubject: true` then computes zero, and
**ISEDECOR BINA has run eight payrolls in that state** with no run-level check. `707b3851` — Chin Hin
Property Group and SpaceX both name "Monthly" as their default cycle while having NO cycle defined, so
both are silently blocked from payroll and never have run one.

**Told the reporter two things they did not ask to hear:** their proposed "Payment Settings" page cannot
be a rename, because Payment Submission Control holds no payment content at all (bank formats live in
Organization); and statutory rates must NOT be folded into tenant-editable settings — they are
legislated, shipped as signed national data, and making them look like preferences would be a regression.

**4. The i18n guard has a SECOND hole, found while building.** Check C matches LITERAL `t('key')` only,
so a key routed through a helper — `t(importFileMessageKey(err))` — is invisible to it. Recorded in
Traps alongside the multi-namespace hole. That trap entry has now been corrected twice in two rounds.

**5. Excel's UTF-8 BOM would have broken the import on the most common file anyone would upload.**
`63393e52` added a file picker; `Blob.text()` UTF-8-decodes and drops the BOM, but the agent verified
that in Node rather than assuming, and pinned it — without the strip, `full_name` reads as a missing
required column on any CSV saved from Excel. The READ step lives in `lib/import-file.ts`, deliberately
separate from PARSE, so `d8471481` can swap in a workbook decoder without touching the write path.

**Carried:** still nothing browser-verified since r70. `63393e52`'s file-pick event wiring and r77's
approvals client island are both source-reasoned only — this repo has no DOM or interaction runner.

---

## Companies list hotfix — 2026-07-29 — the row was lost in TRANSPORT, not in the query (`main@54d25b5`)

**Shipped:** `main@54d25b5`. No migration.
**Gate:** `tsc` clean · **476 files / 5319 tests** · `next build` clean. Verified live: `GET /` 401, service
active, and both changed files md5-identical on the box.

**This entry exists because r77 got `ae3bd088` WRONG and told the reporter their screen was fine.**
It was not. A screenshot settled it: the card header read **"Companies (8)" — correct** — while exactly
ONE row rendered. Both r77's conclusion ("does not reproduce") and its follow-up theory (the dashboard
tile) were wrong.

**The mechanism, and it is a Next-version behaviour worth knowing.** React Flight serialises the RSC
payload row by row, tracking bytes written; past `MAX_ROW_SIZE = 3200` it calls `deferTask`, emits
`"$L<id>"` in place, and the CLIENT rehydrates that as `createLazyChunkWrapper` — a
`Symbol.for('react.lazy')` object. React renders lazies transparently, **but `isValidElement()` returns
FALSE for one.** `components/organization-list.tsx` inspected every row with
`isValidElement(it.node) ? cloneElement(...) : null`, so every deferred row became `null`. One
`CompanyPanel` carries the company array, the state catalog and twelve `$F` action refs — enough to blow
3200 bytes on the FIRST row, dropping all seven remaining companies.

**Why the count stayed right, which is what made it so misleading:** only ELEMENTS are deferred.
`companies.length`, the tree counts and the statutory-gap names are numbers and strings and serialise
intact. The array was never wrong. Every layer people inspected — the query, RLS, the scope helper, the
props — was innocent, because the loss happened after all of them.

**Not a regression.** The guard dates to `f69119c`, 2026-07-05 — 24 days before r77. r77's `adminOnly`
predicate and `visibleTree` are both identities for a group-wide admin, so rolling r77 back would not
have fixed this and WOULD have un-fixed the company-scoped disclosure it closed.

**Fix:** `OrganizationList` owns the `<li>` and renders `it.node` without inspecting it; `CompanyPanel`
returns a `<div>`; `OrgListItem.node` widened to `ReactNode` (the `ReactElement` type was the type-level
form of the same wrong assumption). No query, RLS or scope change.

### The lesson, which is about testing, not about React

**Every test on this screen was structurally incapable of seeing it.** `organization-companies-reachable`
and `organization-companies-unscoped` call `OrganizationList` directly, so `node` is always a plain
element — it never goes through the transport that breaks it. r77 explicitly upgraded its test from
"checks props" to "asserts rendered markup" and **that was still not enough**, because the markup was
rendered from props that had never crossed the RSC boundary. `test/organization-list-rsc-lazy.test.ts`
now feeds the actual post-transport lazy shape; all four assertions were verified RED against the old
component (company 2 of 8 absent from the HTML — the screenshot) and green after.

**And the process failure: an item was marked deployed with a confident close-out saying the screen was
correct.** The reporter had to send a screenshot to overturn it. `ae3bd088`'s `build_ref` now carries a
plain-English correction and an apology. `11355c08` (raised on the mistaken dashboard-tile theory) was
re-planned to say so — its `count(*)`-when-empty disclosure is still a real fault and worth fixing on its
own merits, but it is NOT this bug.

**Anything that introspects a server-passed element is suspect.** Grepping
`cloneElement|isValidElement|Children.` across `app/ components/ lib/` finds this file and nothing else
today. The cliff is data-dependent — more companies, or fuller address fields, defer more rows — so this
class fails silently and only past a size threshold.

---

## r77 — 2026-07-29 — 5 approved items shipped, 1 held, and three reports that were not the bug

> **CORRECTION (same day):** Decision 1's claim that `ae3bd088` "does not reproduce" is WRONG, and
> Decision 2's dashboard-tile theory is wrong. See the hotfix entry above. The `ae3bd088` work described
> below — the company-scoped reachability fix — is real and stands; it simply was not the reported bug.

**Shipped:** `main@aba3064` (branch `build/r77`). **No migration.**
**Gate:** `tsc` clean · **475 files / 5315 tests** · `next build` clean · rehearsal NOT run and not
required (no migration; stated rather than skipped silently). Verified live: `GET /` 401, service active,
migration count still 273, "Review dates" present in the deployed catalog.

**Shipped:** 33bf1a2d + d6429eb4 (approvals leave table on shared cells; "Decide each date" → "Review
dates") · 8ebabbf2 (Employment tab view-only for org assignment) · 89ea527b (Group Join Date vs Join
Date) · ae3bd088 (companies list and count restricted to what the admin can reach).
**Held:** 1ef1cf95 — already built; re-planned as revision 2.

### Decisions

**1. THREE OF SIX ITEMS WERE NOT THE BUG THE REPORT DESCRIBED. That is now the round's dominant
pattern, not an anecdote.**
- `ae3bd088` ("only one company shows") — **does not reproduce.** Production: all 8 companies in one
  tenant, 0 archived, the only `hr_admin` grant is group-wide, so the read returns all 8. The fix the
  reporter called insufficient (`c328f06`) shipped **2026-07-10 in r29** and is an ancestor of the
  deployed head. The defect that DOES reproduce is the inverse: a *company-scoped* admin was shown every
  company with editable archive/delete/re-parent controls the database then refuses — disclosure plus
  dead affordances. Fixed via a new `adminOnly` predicate on `listCompanies` (`app.is_admin_for`, a
  predicate ADDED not removed), with the count derived from the same resolved list so the two cannot
  drift, and subsidiaries re-rooted when a parent falls out of reach. **Latent for this tenant** — no
  company-scoped admin exists today.
- `1ef1cf95` (shared leave groups) — already shipped in migration `0220`, already inside the per-leave-
  type Entitlement step, enforced at submit AND approval. Only the *affordance* is missing: you create a
  group by DRAGGING one row onto another, so nothing on screen reveals the feature.
- `48224d12` in r76 — the picker it named is on a different sub-step.

**The lesson is now specific enough to act on: when a report says a thing is missing, check whether it
is mislabelled, undiscoverable, or on the adjacent screen BEFORE checking whether it is absent.** Three
of these would have shipped a wrong change if built to the ticket.

**2. The most likely cause of `ae3bd088` is a screen nobody had looked at.** `dashboardStats`
(`core/read.ts:3115`) computes `companiesCount = scopeIds ? scopeIds.length : count(*)`, and the home
dashboard's Companies tile links straight to `/admin/organization`. With one company ticked in the
switcher the tile reads **1** — the reported symptom exactly. The `count(*)` fallback is the worse half:
it is reached only when `scopeIds` is EMPTY, so a user who can reach no company is told the whole
tenant's total — the same disclosure `ab77dc1f` closed on the page header. Left unchanged deliberately
(the dashboard is intentionally switcher-scoped, and changing it is a wider blast radius than this item)
and **raised as `11355c08`** asking the reporter which of the two the tile should mean.

**3. `89ea527b` could have moved everyone's leave entitlement, and the proof that it did not is the
deliverable.** `employment.hired_on` is the Group Join Date and the **only** date entitlement reads —
`serviceYearsAt` → `resolveGradePolicy` service bands, `servedFor` minimum-service eligibility,
maternity eligibility, first-year proration, `core/performance.ts` service months. `join_date` has
**zero** entitlement consumers. So defining the relationship changed no calculation, and seeding
`join_date = hired_on` at hire touches a column nothing prices leave from. Existing NULLs left alone —
`joinDate ?? hiredOn` displays identically, so **no backfill was written**. Pinned by a test proving a
Join Date Change leaves an employee in the 18-day band (the wrong mapping drops them to 14 on an
internal transfer) while a Group Join Date Correction *does* move it, plus a drift guard that
`core/leave.ts` never references `joinDate`.

**4. Making the Employment tab view-only found the source of an OPEN bug report.** `8ebabbf2` retired
`setOrganisationAssignmentAction`, whose three services now run only through `applyComparisonMovementTx`
— same guards, same transaction, plus one `groupId` with first-leg-primary. But the agent then found
that **Job Grade is still directly editable from the Personnel LEAVE tab** (`gradeCard` →
`setEmploymentGradeAction`), emitting `employment.grade.changed` — a projected movement event — **with no
tag**. `core/movement.ts:353` falls back to `kind: mv?.type ?? 'gradeChange'`, so it renders its own row.
**That is the duplicate Employment History row `4d391ab7` reports.** `4d391ab7` was re-planned to
revision 2 naming the screen, replacing a plan that had to ask the reporter which screen they used.

**5. A refusal that prevented trading one bug for a worse one.** Direct Superior was deliberately NOT
routed through Movement: `core/movement.ts:1002` refuses a null manager (`dManager != null`), and the
clear path `endReportingLine` emits `reporting-line.ended`, which is not a movement event type and would
leave no history row. Routing it without solving the clear path removes **the only way to clear a
superior**. Reporting lines also feed approvals. Held and recorded rather than half-shipped.

**6. THIS DOCUMENT WAS WRONG ABOUT THE i18n GUARD, and every agent brief this session repeated it.**
The trap entry said a source-static `t('…')` check "is not written yet". It exists —
`test/i18n-coverage.test.ts` check C. The real hole is narrow: **check C skips any file using more than
one namespace** (`:84`, "can't attribute keys statically"), which is exactly how r76 shipped
`t('historyRevision')`. Corrected in the Traps section. Second documentation defect found in two rounds,
after r76 found the r74 shipped-list error — both cost real work.

**Carried:** still nothing browser-verified since r70. This round restyled the approvals table, made the
Employment tab read-only and changed the Organization list. **New and sharpest:** `r77a` introduced a
client island (`app/approvals/leave-decide-controls.tsx`) where the reject-reason box is revealed by
state, and **this repo has no DOM or interaction tests at all** — "click Reject → box appears → submit"
is reasoned from source, never observed. The reject form is conditionally MOUNTED rather than
CSS-hidden, because a `display:none` `required` field makes the browser silently refuse to submit; that
is the sharp edge, and it is the first place to look if `/approvals` misbehaves. Five non-English strings
in this round are agent translations, not native-speaker.

---

## r76 — 2026-07-29 — 4 approved items, and an investigation that stopped a deletion

**Shipped:** `main@35cde09` (branch `build/r76`). Migration `0322`.
**Gate:** `tsc` clean · **470 files / 5258 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, service active, 273 migrations applied, `person_emergency_contact` present
with both carried-over rows, and all five retired `person.emergency_contact_*` columns gone.

**Shipped:** 082fa566 (leave apply popup shows Pending approval + Available only) · 23ad620e (emergency
contact becomes a register; `0322` retires the single field) · 22de47c4 (Assign Template picker shows the
scheme name only) · 48224d12 (scheme names read once, deterministic order — **one bullet deliberately not
built**).
**Investigated, not built:** 9816a5ad — the answer went to the board as plan revision 3.

**Zero integration defects.** Three branches merged with no textual conflict AND no semantic one — the
first round since r69 where that held. Contrast r74 and r75, which each shipped a defect that only the
full suite caught. Not a new rule: it is a property of this item mix (one popup, one profile tab, two
config screens), and r68's counter-example still stands.

### Decisions

**1. AN ITEM CAME BACK REFUTED FOR BEING "BUILT IN THE WRONG PLACE" WHEN IT HAD NEVER BEEN BUILT AT ALL —
and this document is what said otherwise.** Line 335 of this file records `23ad620e (multiple emergency
contacts)` among r74's shipped items. It was not shipped. `git log -S person_emergency_contact main`
returns nothing; the work sat on an abandoned branch (`b1a4951`, worktree `wf_4aeeefdd-b40-4`) that never
merged. Line 136 of this same file simultaneously listed the item as still *planned* — the document
contradicted itself and nobody read both lines together. So the reporter was shown, and refuted, a
feature that did not exist. **A shipped-record that is never checked against the tree is worse than no
record**, because it is trusted. The correction is applied at line 335; the general fix is that a round's
shipped list should be generated from the merge, not typed.

The stranded branch also carried `db/migrations/0319_person_emergency_contact.sql` — and `main` had
already shipped `0319_attendance_rule_tenant_wide.sql`. Two different migrations, one number. Merged
naively that is not a conflict but a **silent skip**: drizzle-kit reads the last applied `when` once and
ignores anything below the watermark, so the table would simply never have been created in production and
the failure would have surfaced later as a missing relation. Renumbered to `0322` / `when
1781862422000`, and journal ordering was re-checked at integration (one pre-existing violation at idx
230→240, unchanged).

**2. THE INVESTIGATION'S ANSWER WAS "REMOVE NEITHER", AND IT PREVENTED ZEROING 16 EMPLOYEES' LEAVE.**
9816a5ad asked which of two entitlement configurations drives the balance an employee sees, and which is
safe to delete. Traced through code and then checked against production: **both are live.** For Annual
Leave, 6 of 22 active employees take their days from a Benefit Scheme and **16 fall through to the older
`leave_policy` timeline** (Medical: 5 / 17). Precedence is one shared composition,
`entitledDays = max(floorDays, schemeDays ?? policyDays)` (`core/leave-compute.ts:502`), with
`schemeBandDays` returning `null` — not zero — as the fallback trigger.

The sharper finding is the one the reporter could not have seen: **`scheme_leave_entitlement` stores days
and nothing else.** Earning method, carry-forward and its expiry, rounding, and `maxBalanceDays` live
ONLY on `leave_policy`, and are read for every employee including scheme-driven ones —
`accrueEarnedLeave` even asserts `pol!.days` non-null, so an earned-method type cannot accrue at all
without a policy row. Deleting the "redundant" configuration would not have tidied anything; it would
have zeroed 16 employees' Annual Leave and switched off monthly earning and carry-forward for all 22.
Confirmed against two real ledger entries where the two configurations disagree and the winner is
therefore provable (2.79 days = scheme's 12 prorated; 0.05 = policy's 10 prorated where the scheme had no
row). Also cleared up the premise: the two tables the reporter was comparing are **the same records
rendered twice**, not two configurations.

**3. THE FIFTH NON-REPRODUCING REPORT IN TWO SESSIONS.** 48224d12 asked to remove a second scheme picker
from Service Based Entitlements. That screen has exactly one `<select>` — Company — and picking a company
already lists every scheme. The picker described is on the adjacent *Benefit Schemes* sub-step. The agent
built nothing for that bullet and said so, which is the correct outcome; the item shipped its other three
bullets and the `build_ref` carries a plain-English note telling the reporter exactly which control we
did not touch and why. The recurring shape is now unmistakable: **a report names a screen, and the fault
is on the one beside it.**

**4. A DISPLAY STRING HAD A SECOND CONSUMER, AND CHANGING IT IN PLACE WOULD HAVE ALTERED A SURFACE THE
PLAN PROMISED WAS UNTOUCHED.** The composed scheme label at `app/admin/leave/approval/page.tsx:290` also
feeds `schemeText()`, the badge on the *saved assignments* table. The build added `name` alongside
`label` rather than editing `label`, so "only the picker changes" is literally true. Neither the file-map
scout nor I caught this; the build agent did, by reading every consumer before editing. The naming rule
itself now lives in `lib/benefit-scheme-label.ts`, deliberately **import-free** so it can never become an
ADR-0080 drift entry.

**5. THE REMOVED WARNING WAS THE ONLY PLACE THE PRODUCT ADMITTED THE TWO CONFIGURATIONS DISAGREE.**
48224d12 asked to delete the amber `serviceGradeDisagreement` note; 9816a5ad, running the same round,
proved the disagreement it reports is real and affects most of the workforce. Built as approved — the
reporter asked plainly and it is display-only and reversible — but **partially on purpose**: the surface
is withdrawn while `gradeLevelServiceDays` / `sampleYearsForColumn` and their prop wiring are kept and
still unit-tested, so restoring the note is a ten-line edit rather than an archaeology exercise. A test
pins the shape of that compromise so neither half drifts. The reporter was told plainly, in the plan
pushed to the board, that the note is gone and can be put back on request.

**6. Two judgment calls recorded because both went against the obvious reading.** The warning badge on the
Assign Template picker was KEPT despite "remove the supporting detail lines" — it is the stated cause of
the Assign button's `disabled` state, so removing it yields a dead button with no explanation. And the
shared `SchemeEntitlementMatrixRow` was changed for BOTH surfaces though only one was reported, because
that file already carries an explicit invariant that the two surfaces must name a scheme identically;
fixing one would have created exactly the drift the invariant exists to prevent.

**Carried:** every UI change in r71–r76 plus slice 4 remains **browser-unverified**. This round moved a
leave popup, rebuilt the personnel Profile tab's emergency-contact section, and changed two config
screens. The 082fa566 build also notes its two surviving columns are `text-right` in a `w-full` table and
will now spread across the dialog rather than sitting compactly — plausible, unseen.

---

## Feedback attachments on push-back — 2026-07-29 — a screenshot when asking for changes (0321)

**Shipped:** `main@1fce3cf`. Migration `0321`.
**Gate:** `tsc` clean · **468 files / 5215 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, both columns present, 105 existing attachments defaulted to `submitted`.

Reported directly, not via the board: the feedback form lets you attach an image when you first raise an
item, but there is no attachment option when you ask for changes. Confirmed — the raise form carried a
file input, the contest and refute forms only a textarea.

### Decisions

**1. The stage column is why this was not a one-line fix.** feedback_attachment had no notion of WHEN an
image arrived, so an untagged upload on a contest would sit indistinguishably beside the original bug
screenshot. On an item that has been round three times that is a pile of pictures with no story — the
exact failure 0318 fixed for the plan TEXT, about to be reintroduced for the images. So an attachment now
records the plan revision it answers plus what the reporter was doing (submitted / contested / refuted),
with a CHECK pairing them: a contested row cannot exist without naming a revision and silently fall out
of the timeline. `stage` is deliberately NOT derivable from the revision — a contest and a post-deploy
refute can both answer revision 2 and are different complaints.

**2. The revision is read at attach time, never taken from the form.** A stale page would otherwise file
an image against the wrong round. Pinned by a test that re-plans afterwards and asserts the earlier image
still answers v1.

**3. A failed upload does not roll back the push-back.** Losing a recorded objection because a file was
too large is the worse outcome, so failures surface on the toast and the words survive.

**Two of my own mistakes, recorded because both are recurring shapes:**
- The constraint test PASSED FOR THE WRONG REASON — it used a Base field that does not exist, so
  employment_id was null and both inserts failed on NOT NULL; the CHECK under test was never reached. It
  now asserts the constraint BY NAME. A test that only checks "it threw" passes on the wrong throw.
- tsc CANNOT SEE A MISSING TRANSLATION KEY. t('historyRevision') does not exist; the real key is
  historyPlanV. Found by checking every key in the file against messages/en.json. With six locales and no
  guard for this, it will happen again.

**Environment note.** The Mac rebooted at 08:16 and the local Postgres did not come back — its data dir
defaults to port 5432 while the project uses 5433, so it needs `-o "-p 5433"` at start, and it took 397s
of crash recovery after the unclean stop. Worth a launchd unit rather than a manual start.

---

## Slice 4 — 2026-07-29 — nav + page gating from entitlements (ADR-0077)

**Shipped:** `main@14cbdcf`. No migration.
**Gate:** `tsc` clean · **467 files / 5209 tests** · `next build` clean. Verified live: `GET /` 401.

The rail stops advertising modules the customer has not bought, and a module entry page redirects with
an explanation instead of an error screen.

### Decisions

**1. BOTH LAYERS FAIL OPEN — the opposite of every service gate, and the decision worth reviewing.**
getSession degrades to a session with NO snapshot on a migration-lag deploy, a revoked grant or a
connection blip. Services must refuse in that state: a service that guesses moves money. If nav did the
same, that same blip would empty the sidebar for every user of a paying tenant WHILE THEIR PAGES STILL
WORKED, and the product would look uninstalled. So `visibleModuleCodes` returns `null` ("no opinion,
show everything") as a value genuinely distinct from `[]` ("hide everything"), and a test pins that the
two differ. Showing a link to something you cannot use is a worse menu; hiding everything is a worse
outage — and the service layer is the control either way.

**2. Hiding is NOT the control, and that is asserted rather than assumed.** A hidden module's service
call still throws `ModuleNotEnabledError` (D3). If that test ever stops throwing, slice 4 has quietly
become enforcement and an unpurchased module is reachable by typing its address. A deep link skips the
redirect entirely and meets the service refusal — correct, and precisely why this layer is allowed to
be incomplete. Completeness here would imply the redirect is what protects the module.

**3. Core modules are never hidden**, even when a snapshot explicitly disables them. A rail without My
Absence is a broken product, not a downgraded one. `leave` contributes nav and is core; the four
sellable ones (attendance, claims, payroll, performance) are the only hiding candidates.

**4. The plan was written against a contract that no longer exists.** It assumed `nav?:
NavNodeDescriptor` — one untagged node per pack. r74 replaced that with `navNodes`, an array of
group-tagged nodes, and split Attendance three ways. Slice 4 gates against the new shape. The
row-to-module map is derived from the pack descriptors the sidebar already resolves rather than a
hand-written list, so it cannot drift the next time a pack adds a row.

**Process note.** The first test fixture invented a per-module status map where `EntitlementSnapshot`
actually carries `enabledModules: string[]`. The fail-open catch turned that malformed context into
"show everything" — correct in production, and indistinguishable from a passing design in a test. Every
case now asserts a NON-null result first, so a fixture that stops matching the real shape fails loudly
instead of quietly exercising the degraded path.

**Carried:** slice 4 hides menu rows and has never been browser-verified, along with r71-r75.

---

## r75 — 2026-07-29 — 10 approved items (approval config, leave surfaces, HRDF, movement, pagination)

**Shipped:** `main@778821c` (branch `build/r75`). Migration `0320`.
**Gate:** `tsc` clean · **466 files / 5202 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, both `app.approval_history` and the new `app.approval_history_count`
present on production.

**Shipped:** 9816a5ad + 22de47c4 (Job Grade gives way to Benefit Scheme, entitlements and approval
assignment) · 082fa566 (Available nets off committed leave) · 29710798 (one success message) ·
1f6fd6d8 (leave view config matches the revised summary) · efece4ce (say "not registered for HRDF"
instead of showing nothing) · e3c733df (Criteria column restored on Job Grade) · 66a63bd6 (Employment
History Edit + Delete as visible reversals) · deec1691 (record relationship explorer, operator plane) ·
fc776376 (one pagination framework).
**Held, returned to the reporter as re-plans:** 4b90e548 · c4339f4c.

### Decisions

**1. An agent refused a removal and corrected my brief while doing it.** `4b90e548` asked to delete the
Approval Workflows and Company Defaults subsections. Three things live only there: the ONLY switch that
turns multi-step approval OFF (the Assign Template button posts a hardcoded `value="1"` — it can only
turn it on), the ONLY editor for the escalation settings the overnight sweep reads live, and the
wildcard any-type approval rules, which render read-only elsewhere. Removing the section would not stop
escalation — it would FREEZE it, permanently and unchangeably.

I had told the agent that removing the company-default fallback would leave requests unroutable. That
was wrong, and it checked: resolution falls through to a built-in `['direct_manager','hr_admin']` chain.
The real failure mode is SILENT RE-ROUTING — employees covered by a company default would quietly change
approver with nothing surfacing it. Worse than unroutable, because unroutable fails loudly. The item now
asks the reporter one question: where do those two settings live once their section is gone.

**2. The fourth non-reproducing report, and the first with a mechanism found.** `c4339f4c` claimed Leave
History shows only Annual Leave. There is no leave-type predicate anywhere in that path, proven with a
test seeding six types that all return. But the agent then found the likely real cause: EMERGENCY LEAVE
NEVER APPEARS UNDER ITS OWN NAME — `requestEmergencyLeave` decomposes an EL request into ANNUAL + UNPAID
child rows when EL has no configured balance source. The reporter is probably looking for an EL
application that genuinely is not there as "Emergency Leave". Asked for one specific example rather than
guessing; the six-type test is kept as a regression guard.

**3. HRDF was never a calculation fault.** The levy computes correctly (2026-08 Chin Hin Construction
Engineering = RM56). SIX of eight companies have no HRDF registration at all, including ISEDECOR BINA —
the largest active payroll. And the real bug: an employee there has "Subject to HRDF" ticked while the
company is unregistered, so the tick is SILENTLY DISCARDED (`hrdfSubject` returns the explicit flag,
then the levy yields 0 for `not_registered` — the function's own header says so). Someone set something
and nothing happened, with no message anywhere. Fixed by saying so on screen, not by changing the levy.

**4. Pagination held back TEN surfaces and named every one.** The dangerous class: six client-side
sortable grids sort and filter IN THE BROWSER over the full fetched set, so server-paging their rows
would silently demote column sorting to sorting-within-the-current-page — a behaviour regression
disguised as a display change. Three more were excluded for the reason import previews are: `/approvals`
(paging a bulk-decision surface makes "approve all" mean "approve all on this page"),
`/admin/claims/reimbursements` (a footer total covering rows you cannot see), `/leave/employee-balances`
(a single-record breakdown). And it caught a same-round conflict: the `/leave` Employee Details listing
pages at exactly TEN because 650b6eb8 asked for ten — the shared default of 25 would have reverted an
approved item.

**5. Two promises to the reporter that the build did not fully keep, recorded rather than buried.** The
pagination plan said three releases; it shipped as one commit (nothing staged back — the phrasing was
about risk containment). And it promised every list screen would load faster "because the page fetches
25 rows instead of all of them" — true for the seven screens that page in SQL, NOT yet true for the ten
that use `paginateRows()` and still fetch everything before slicing. The reader-visible contract is
identical and the 2,000-row ceiling still protects the browser; the SQL push-down is the follow-up.

**Carried, still not done:** r71–r75 UI changes have never been browser-verified. This round alone added
pagination to ~17 screens, moved Job Grade to Benefit Scheme on two config screens, and added Edit and
Delete to Employment History.

**Operational finding, not a product one.** The r75 gate showed the test template taking 1308s to
migrate, against 1-7s in every prior round, which looked like migration 0320 being catastrophically
slow. It was not. DROP DATABASE and CREATE DATABASE were hanging: the local cluster had accumulated
379 databases, 366 of them test databases, because TEST_DB_NAMESPACE has no teardown and every
parallel agent round permanently adds a template plus ten workers. 280 leaked workers and 27 leaked
templates across r73-r75. After dropping them the same rehearsal ran in SEVEN SECONDS.

Worth recording for two reasons. Production was never at risk - it holds a handful of databases and
0320 is a CREATE OR REPLACE FUNCTION - so reporting a 22-minute production migration window would
have been wrong. And the isolation strategy that made six concurrent agents possible leaks: without a
teardown it gets slower every round until someone meets it during an incident. The harness should drop
a namespace's databases when its run ends.

---

## r74 — 2026-07-29 — 10 approved items (payroll nav, attendance rules, leave inquiry, entitlements)

**Shipped:** `main@0230bbf` (branch `build/r74`). Migration `0319`.
**Gate:** `tsc` clean · **459 files / 5115 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, all 9 attendance rules converted tenant-wide on production.

**Shipped:** 1459e116 (Payroll tabs → sidebar fly-out) · 6da67ab7 (attendance rules tenant-wide) ·
8ec63139 · 20c699f8 · 953be4b0 · 650b6eb8 (the four-part HR-admin leave inquiry surface) · 37a1141e
(Carried Forward → Brought Forward) · ~~23ad620e (multiple emergency contacts)~~ **— WRONG, see r76
Decision 1: this never merged and was built for real in r76** · 9cbf5e0d (employee
status follows the derived default) · a03eff24 (entitlement setup as a grade-group matrix). Plus
0bb0e303 and the 895c80f9 nav contract, built ahead of the round.

### Decisions

**1. A third nav node exists to stop a silent access regression.** 0bb0e303 splits Attendance by
audience. The obvious two-way split — staff rows and admin rows — puts Roster and Import under Admin,
but both are `managerUp` and the Administration sidebar group is gated `adminOnly` AS A WHOLE, so every
manager who reaches them today would have lost them with no error and no ticket. They get a third node
in the per-row-gated Manage group. Pinned as its own named test, because it is the one way that change
could quietly take access away.

**2. `0319` drops the company axis, and that — not a new shift link — is what the item actually needed.**
The reporter asked to "bind attendance policy directly to shift setting". A shift ALREADY picks its rule
via `shift.rule_id`; the blocker was that a shift is tenant-wide while the rule library was per-company,
so one shared shift could only ever point at one company's rules while employees of every other company
were rostered onto it. Conversion is non-destructive: the Standard of the company with the most
employments wins tenant-wide, every other company's Standard survives renamed `Standard — <Company>`,
and name collisions are suffixed rather than merged. `attendance_policy` was deliberately NOT touched —
it is the fallback for days with no assigned shift, the branch b7b886e2 left on legacy duration math.

**3. Three defects reached integration that no agent's own tests could have caught.** Each is an argument
for the full-suite gate over per-agent targeted runs:
- Two `scopedAdmin` screens shipped with **no permission-matrix column**, so Security & Permissions could
  neither grant nor revoke them. Caught by the reverse-completeness guard in `function-access.test.ts`.
- `FilterPanel` was mounted INSIDE another `<form>` on both new inquiry pages. Nested forms are invalid
  HTML that browsers do not report — the parser discards the inner tags, the panel's fields are absorbed
  into the outer form, and its Apply button submits that one. It worked only because both targeted the
  same action, and wave 2 then added a `hidden` prop for the two-listing page, which is exactly the case
  where merged forms submit the wrong field set. Guarded by `filter-panel-not-nested.test.ts`.
- Two defects in my own 0bb0e303 work, both from verifying with a hand-picked file list: a tsc error from
  an edit I re-ran vitest but not tsc after, and a source-static guard that could not even COLLECT because
  it read a const the split renamed — a file I never ran.

**4. An item was held back for being part of a set, and the refusal was right.** 650b6eb8's plan says it
is part 2 of 4 and must ship with its three siblings; the grouping split them across two agents. Building
the shell alone meant a three-tab navigation with two tabs 404ing, or that agent silently building its
siblings and colliding with the other. It wrote nothing and said why. Its siblings shipped in wave 1, so
it built cleanly in wave 2 — the sequencing, not the item, was the problem.

**5. OPEN, for the reporter not us:** `/leave` now opens on Employee Details but KEEPS the org-wide
leave-request table below it. The item reads as though the landing page becomes the inquiry surface, but
removing that table would undo 8ec63139 from this same round — same reporter, who asked for multi-select
filters on every one of its columns — and orphan `/leave/export`. Reversible if they disagree.

**Carried, still not done:** r71–r74 UI changes have never been browser-verified. This round moved
Payroll's entire navigation to a fly-out, split the Attendance menu three ways, renamed leave labels
across screens and added four inquiry surfaces. Tests and `next build` prove wiring, not layout.

---

## Plan history — 2026-07-28 — the request→plan→push-back→re-plan trail is kept (0318)

**Shipped:** `main@e3ef2bf`. Migration `0318`, new table `feedback_plan_revision`, backfill wired into
`deploy.sh` permanently.
**Gate:** `tsc` clean · **453 files / 5008 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, **478 plan versions recorded**, 40 reported unrecoverable.

Not a feedback item — asked for directly. The board could show the CURRENT plan and nothing else.

### Decisions

**1. The history was being destroyed as it happened, not merely unshown.** `feedback_request` holds ONE
`plan` and ONE `contest_reason`; every re-plan overwrote the plan and cleared the push-back that caused
it, and the events carried `{revision, model}` / `{revision, decidedBy}` — never the text. Measured before
building: 29 items had gone more than one round, **~40 plan versions already gone**, one item six rounds
deep. Those are NOT reconstructed. The page compares history rows against `plan_revision` and states how
many are missing; a placeholder row would turn a known unknown into a plausible lie.

**2. SELECT-only was incoherent, and the correction is the real design.** The first cut granted the app
read-only "because the services write as owner" — they do not: in-app approve/contest run as `ai_hr_app`
through `withTenant`, so a read-only grant would have recorded nothing the reporter did. The guarantee is
**append-and-close-once**: INSERT a live revision, UPDATE it once to close it, never DELETE. `USING
(outcome IS NULL)` makes closure one-way — a recorded objection matches no UPDATE policy again — and a
BEFORE UPDATE trigger freezes the plan text, because RLS is row-level and cannot stop a rewrite riding
along with the close. Caught by a test, not by review.

**3. Approval is a STAMP, not an ending.** Closing the revision on approval left a shipped-then-refuted
plan with nowhere to record the refutation — the version was already spent, so the reporter's post-deploy
words vanished. That is the exact class of loss this table exists to prevent, reintroduced one layer down.
`approved_at` and `outcome` are now separate facts on one row: they approved it, we shipped it, they sent
it back.

**4. "0 refute reasons recovered" was checked, not accepted.** The deploy printed 0 where 27 was expected.
26 genuinely cannot be recovered — a refute triggers a re-plan that increments `plan_revision`, so the
version each refute answered no longer exists as a row (confirmed against the event payloads: every refute
revision sits below its item's current one). The 27th WAS recoverable and had been mislabelled
`contested`, because `refuteDeployment` parks its text in `contest_reason`. Keeping "you built the wrong
thing" apart from "you shipped it and it missed" is why the table has separate outcomes, so the backfill
now relabels it. Production reads `refuted|1`.

**5. The first upgrade rehearsal FAIL was real and nearly dismissed.** Every data check printed `ok`, so it
read as noise — but step 4 (apply the new migrations) had failed on a missing `drizzle-kit` in the fresh
worktree, meaning those checks validated the BASELINE alone and `0318` had never been rehearsed. Deps
installed; the re-run is a genuine PASS over populated data. A rehearsal whose failure mode looks like
success is worth remembering.

**Also corrected mid-build:** two tamper assertions had been loosened to `/append-only|Failed query/` to
reach green — which would pass on any query failure at all, i.e. a permissions test that does not test
permissions. Replaced with a helper that walks Drizzle's `.cause` chain for the real Postgres error.

---

## r73 — 2026-07-28 — 3 approved items + the `blocked` status + a silent data-loss fix

**Shipped:** `main@d13b226` (branch `build/r73`). Migration `0317`.
**Gate:** `tsc` clean · **452 files / 4995 tests** · `next build` clean · **upgrade rehearsal PASS**.
Verified live: `GET /` 401, `feedback_status` carries `blocked`, both columns present on production.

**Shipped:** 622e12eb (Payroll Register report) · b7b886e2 (attendance derived against the shift's
time-in/out window) · 08913328 (Movement Current/After comparison, delta-only writes).
**Closed without code, per approved decisions:** 4c6f69bd · 7a348d34 · 3282eccc · d7455ed2.

### Decisions

**1. `blocked` exists because the board could not tell parked work from queued work.** `approved` means
"the reporter agreed to the plan", which the loop reads as "ready to build" — but an item is sometimes
approved and then found to depend on a question only the reporter can settle. Five sat in `approved`
looking identical to work merely waiting its turn, and each round re-derived the difference from memory.
The guard is `startFeedbackBuild`, which accepts only `approved`: parking an item removes it from every
build round, so a block cannot be worked around by an agent that never saw the question. Labelled
**"Waiting on an answer"**, not "Blocked" — the consultant is not an engineer, and naming the question
tells them there is something to do.

**2. All three DECISION items came back approved, and two of them closed items rather than building
anything.** `3282eccc` → keep first-year leave granted up front; 4c6f69bd closed, Mei Ling's 19.73 is the
agreed model. `d7455ed2` → SKBBK does follow the employee profile; 7a348d34 closed, only the stale May run
carries the old figure. `895c80f9` → build the two-node nav rule. Each closure carries a plain-English ref
saying no code changed and why, so "Deployed" does not send the reporter hunting for a fix that was never
needed.

**3. `transferEmployee` silently wiped every employee's Business Unit — pre-existing, still live.** The
CLOSE+INSERT carried department, position, cost centre, location, employment type and status forward but
not `business_unit_id`, so each new assignment version was written NULL. No error, no event, no changed
label. The writer predates the column (migration `0219`). Both live callers are on the Employment tab and
neither has any business touching a business unit: `setLocationAction` names only a location,
`transferAction` only a department — so an admin changing where someone sits silently unassigned them from
their business unit. This is why 08913328 moved Movement off the writer, but the writer stayed live on the
location flow, which is the part that kept costing data. The build agent filed it rather than fixing it;
overruled, because the loss is silent and the screen is in daily use. Proven red before green.

**4. A build agent's side effect was reverted.** The register build registered its dataset first, silently
changing which dataset the Payroll "New report" button seeds. The item asked for a register to EXIST, not
for an existing button to start doing something else.

**5. Held back for the reporter to decide, not guessed:** Edit/Delete of Employment History events (it is a
projection over the append-only event ledger — "delete" means a compensating event or tampering with the
audit trail); a "Pay Group" field that exists nowhere in the schema (nearest neighbour is Payroll Policy,
and mapping one onto the other would quietly redefine an admin's mental model); and Hire as a creatable
Movement type (it would create a second way to originate an employment).

---

## r72 — 2026-07-28 — 13 approved items (leave config, approvals, org labels, HRDF)

**Shipped:** `main@d345d68` (branch `build/r72`). 61 files, +4401/−1094, migration `0316`.
**Gate:** `tsc` clean · **448 files / 4961 tests** · `next build` clean · **upgrade rehearsal PASS**.

**Shipped:** cdf9ca48 + a7fab30b (Balance Deduction Source + Allow Unpaid Leave) · bc9be1e8 + 0d9cf710
(retire the Company Entitlements tab) · c9986927 (organisation lists → Organization Labels) · 1e4eb8af
(Leave Year Configuration into Leave Type > Custom Settings) · 726ac8c2 (Manager Leave Summary) ·
165baee5 + f6d3be0b (Condition · Criteria editable in place) · bb3938b9 (Assign Template criteria panels) ·
3d2bc793 (shortcuts row) · d4735493 (single-vs-multi-step an explicit choice) · efece4ce (HRDF levy in
Transaction View History).

### Decisions

**1. Parallel agents produced three collisions none of them could see.** Every agent's own tests passed;
the combined tree failed. (a) `cdf9ca48` changed the apply-popup to resolve the SOURCE balance type while
two tests pinned the old argument list — the INVARIANT (popup Pending == submit-guard reserve) was verified
to still hold before rewriting them against shared helpers, rather than editing them until they passed.
(b) `165baee5`/`f6d3be0b` changed the rule-card idiom while `cdf9ca48`/`a7fab30b` added cards using the old
one; only the two new cards moved. The lesson carried into r73: group agents by file overlap, and treat any
cross-cutting item as solo work.

**2. The HRDF fault did not reproduce as reported.** It is computed and stored correctly; it reads 0.00
because only one company has a rate configured. Surfacing it in Transaction View History is what shipped.

---

## r71 — 2026-07-28 — 12 approved items (leave entitlements, counts, labels)

**Shipped:** `main@5c1d6bf` (branch `build/r71-clean@fe2bb0c`). 28 files, +565 lines, migration `0315`.
**Gate:** `tsc` clean · **443 files / 4869 tests** · `next build` clean · **upgrade rehearsal PASS** —
the first release gated against a POPULATED database rather than an empty one. Deployed and verified
live: `GET /` 401, `job_grade.description` present on production, no errors since restart.

**Shipped:** 783bf55a · baea8e5b · c2a48426 · 77a4049f · 45c781e2 · 7f9fbf50 · 082fa566 · ab77dc1f ·
9b25b094 · a46fe0c0 · 567333b7 · e3c733df.

### Decisions

**1. Two reported bugs were one, and the allowlist was asking the wrong question.** `openLeaveYear`
selected what to grant with `code IN STANDING_LEAVE_CODES` — ANNUAL, SICK, HOSPITALIZATION and nothing
else — so a Service-Based Entitlement on Caregiver or Study Leave saved successfully and never reached
an employee (783bf55a), and leave taken against the resulting non-existent grant drove the ledger below
zero (baea8e5b). The allowlist itself was correct: ADR-0066 keeps FESTIVE types out of the accrual and
forfeit engines deliberately. What was wrong was the discriminator. It now asks **"did an administrator
configure entitlement days for this type"** rather than "is this code one of three strings". Festive
types have neither a policy nor a scheme entitlement, so they are still excluded.

**2. Three items were HELD because the report did not survive contact with the data.** Each would have
changed money or reversed a decision on a reading that turned out to be wrong:
- `4c6f69bd` → raised **3282eccc**. Wants 11.34 days where the system deliberately grants 19.73 up
  front (decision `adcdf215`). A different MODEL, not a rounding bug.
- `7a348d34` → raised **d7455ed2**. The reported SKBBK fault **does not reproduce** — T100009's July and
  June payslips are both 0.00; only the stale May run carries 44.65. The real gap found instead: an
  employee with NO statutory record is treated as covered while one with an all-unticked record is
  exempt, so saving an empty form differs from never opening it. Affects 5 of 20 active employees.
- `1459e116`. The Payroll nav row is contributed by the payroll PACK, not the sidebar, so a fly-out
  changes the pack's nav contract — and the component renders one child level where the request draws
  three.

**3. Two items needed a reading of the request other than the literal one, both recorded on the board so
the reporter can overrule.** `e3c733df` asked to rename Grade Name → Description and add a new Label;
done literally, every existing grade name moves under "Description" and Label — the field people read —
is blank on every row. The item's stated GOAL was to match the other System Label categories, whose
pattern is `label` = name shown, `description` = optional detail. Also declined the Criteria column:
`job_grade` is tenant-global, and the existing code records that hosting it in the company-scoped grid
"still rendered a meaningless Criteria column". `082fa566` got a NEW `available` key rather than
redefining `balance`, so anything that genuinely means a balance keeps its word.

**4. `useSearchParams` is gated by `next build`, not `tsc`.** It typechecks fine and fails at BUILD time
outside a Suspense boundary. Both new client components using it (`submit-toast`, the dialog's
open-on-arrival) were verified with a real build rather than assumed safe.

### Outstanding

- 22 approved items remain, including the pairs that must ship as single changes
  (`cdf9ca48`+`a7fab30b` touches pay; `bc9be1e8`+`0d9cf710` both remove the same tab).
- The r71 UI changes have NOT been browser-verified.

---

## Slice 3 — 2026-07-28 — deployment env gates become per-tenant entitlements

**Shipped:** `main@a664e5e` (merge `499e79e`, branch `build/slice3@8d1f18d`). 101 files, +6305 lines.
**Gate:** `tsc` clean · **442 files / 4865 tests** · `next build` clean. Deployed via the documented
two-phase sequence (`--migrate-only`, reconciliation checked, then finish); verified live — `GET /`
returns the 401 password gate and all three `toil_accrual` policies are present on production.

**Built:** eight `process.env.*_ENABLED` flags moved onto `isModuleEnabled` / `settingEnabled`;
migration `0314`; `scripts/reconcile-entitlement-parity.ts`; `scripts/check-audit-chain-gate.ts`;
`deploy.sh --migrate-only`; ~58 test files converted from env writes to entitlement rows.

### Decisions

**1. The cash-XOR-TOIL invariant was still switchable — by WHO RUNS PAYROLL — and that is the whole
reason this slice needed three review rounds.** Making the exclusion unconditional was not enough.
`EXCLUDE_TOIL_BANKED_DAYS` is a correlated subquery, so it runs under the CALLER's RLS. `0099` widened
attendance / payslip / compensation to the payroll capability but never `toil_accrual`, because nothing
in the payroll path read it then — this slice is what made that gap live. For a `payroll_partner` the
attendance row was visible and the accrual was not, so `not exists` read trivially TRUE and every banked
rest day would have been prefilled as overtime CASH while the leave credit stayed on the ledger: the
employee paid twice for one day. `0314` widens the read. **A guarantee that holds for one role and not
another is not a guarantee**, and no amount of unconditional application code fixes a visibility gap
underneath it.

**2. Widening a `FOR ALL` policy's `USING` clause cannot express "read only".** `0314`'s first attempt
did exactly that and asserted in its own header that it was safe "because WITH CHECK is unchanged".
That is false: **PostgreSQL authorises DELETE from `USING` alone** — a DELETE produces no new row, so
WITH CHECK is never consulted. Since `0076` grants `ai_hr_app` full DML, the USING clause was the only
thing standing between a payroll session and destroying an employee's banked-leave ledger. The shipped
form is a separate `FOR SELECT` policy (permissive policies are OR'd per command) plus a RESTRICTIVE
DELETE policy that also closes a pre-existing hole where an employee could delete their own accrual.

**3. The entitlement-parity reconciliation was removed from `deploy.sh` as an automated gate, on
purpose.** It could never reach a clean state: `provision.ts` deliberately writes ZERO `tenant_setting`
rows for a new tenant, while `enable-demo-flags.sh` sets three switches true on the box — so the
preflight counted every post-`0313` tenant as three rows short, permanently and by design. The first
customer provisioned after this deploy would have blocked every deploy after it, and both escapes were
worse than the check (`--apply` writes platform-scoped rows `ai_hr_app` cannot close again;
`ENTITLEMENT_PARITY_ACKNOWLEDGED` disables it forever). **A check whose only correct resolution is human
sign-off cannot be an automated `set -e` gate.** It is a one-shot for the maintenance window, and
`--migrate-only` exists to give it the stop point DEPLOY.md always described. This deploy verified it
was unnecessary rather than skipping it: the only tenants are the demo group (pre-`0313`, backfilled,
7 module rows) and the reserved system tenant.

**4. Eight separate guards in this slice could not see what they claimed to check.** The pattern, not
any single instance, is the finding: `adminCtx` exempting itself from the entitlements it was meant to
prove; the drift ratchet counting docblock prose as code; a test asserting a row count where only a
settled AMOUNT distinguishes converted from lapsed; and — the subtlest — the ratchet missing
`defaultProvisionModuleCodesIn(process.env)` because it matches literal gate NAMES in the scanned file
and the lookup happened one call away against a parameter. **A guard that checks a proxy for the
property is not checking the property.**

**5. Ruled PASS by hand, and the reason is recorded rather than hidden.** Round 1 passed, round 2
FAILED, and round 3's judge died on a network error without ruling. Rather than treat an unruled round
as a pass, the verdict was made explicitly: the gate above, `0314` **mutation-proven** load-bearing
(stubbed to `USING (false)` the payroll-partner tests redden; restored they pass), correct journaling,
and three of round 2's open findings confirmed fixed in code. Two LOW findings were not individually
re-verified — stated so the next reader knows the edge of what was checked.

### Outstanding

- `scripts/upgrade-rehearsal.sh` is committed on `build/r71` but **has never completed a run**. Every
  gate here tests the INSTALL (schema-only template, clean-room migrates an EMPTY database); nothing
  tests the UPGRADE against populated data. This deploy was exactly its use case.
- `build/r71` carries a DUPLICATE test-DB namespacing implementation; `main`'s (`a664e5e`) wins, since
  it also fixes `cleanroom-verify.sh`, which runs its own vitest and clobbered the shared template.
- Test isolation: `resetDb()` truncates ~90 tables **per test** at ~175ms — measured at ≈22% of total
  suite compute, and the source of the TRUNCATE deadlocks that produce phantom failures.

---

## Slice 2 — 2026-07-26 — the enforcement primitive (`a38ed02f`) — ENTRY ADDED LATE, on 2026-08-01

**This entry did not exist until r93.** Slices 0, 1, 3 and 4 had entries and slice 2 did not, so for five
weeks this file's own headings implied the slice was skipped. It was not. Written from the commit and the
tree rather than from memory of the round, so it is thinner than its siblings — that is the cost of
recording a slice late, and the reason to record one at the time.

**Shipped:** `a38ed02f`, 2026-07-26 — "session-scoped entitlement resolver (`isModuleEnabled`/`getSetting`),
`ModuleNotEnabledError`, fail-closed semantics".

**Why it matters more than its size suggests:** this is the primitive slices 3 and 4 gate against, and
**50 call sites across `core/` now depend on it** (`core/toil.ts`, `core/attendance-allowance.ts`,
`core/notifications.ts`, `core/entitlements.ts` and more). Resolution is per-TRANSACTION — `withTenant`
issues one SELECT of the tenant's active module rows, settings and `tenant.status` alongside its
`set_config`s and attaches the snapshot to the transaction handle, so `isModuleEnabled` reads it
synchronously and there is no cross-request cache to poison.

**The semantics to preserve:** fail-CLOSED. An unresolvable module is off, not on. `core/entitlements.ts`
carries the reasoning inline and is worth reading before touching any gate.

**What this slice deliberately did NOT do, and still has not been done:** `tenant.status` rides in the
snapshot but nothing enforces suspension — that is slice 9, unbuilt, and `core/entitlements.ts:653`
records it plainly: "Until slice 9 lands, a closed tenant retains write access to core."

---

## Slice 1 — 2026-07-26 — entitlement + settings substrate (no behaviour change)

**Shipped:** `build/slice1@1be70fa`. 26 files, +1528 lines. Nothing READS these tables yet — slice 2
adds the resolver, slice 3 flips the env gates onto it. **Gate:** clean-room PASS ·
**441 files / 4785 tests** · `tsc` clean · `next build` clean · 3 adversarial rounds (13 agents,
1054 tool uses), all passed.

**Built:** migration `0313` (module + setting_definition catalogs, tenant_module, tenant_setting,
subscription, subscription_line, usage_snapshot, platform_user, tenant_provision_request_module,
tenant extended); `packs/catalog.ts` (14 modules — 6 core, 8 billable; 5 settings, 4 platform-scoped);
`scripts/seed-catalogs.ts` wired into all four bootstraps; `packs/register-all.ts`; harness defaults +
`setModule`/`setSetting`; provisioning and operator intake carrying country + modules end to end.

### Decisions

**1. The catalog is NOT the pack registry, and conflating them was the plan's original error.** A
`ModulePack` is a CODE identity; a catalog row is a COMMERCIAL one. They diverge both ways: `toil`,
`multi_cycle_payroll` and `typed_pay_components` are billable with **no pack** (they are behaviours
inside a parent pack's service), while `leave` **has** a pack but is core and must never be sellable.
So the catalog is its own table with `parentModule` + `packBacked`, seeded from a code manifest, and
`test/module-catalog-drift.test.ts` pins the correspondence in BOTH directions — a new pack without a
catalog row can never be sold; a row pointing at a non-existent pack fails the suite.

**2. The privilege matrix is the slice's real deliverable, and the gate structurally cannot check it.**
`bootstrap-db.sql:50-54` auto-grants full CRUD on every new table to `ai_hr_app`, and
`cleanroom-verify.sh:47-52` **reproduces that grant** — so the clean-room masks a missing GRANT and can
never catch a missing REVOKE. Delete a REVOKE from 0313 and every other test still passes while any
hr_admin can grant themselves Payroll. `test/module-entitlement-rls.test.ts` reads `information_schema`
directly. The round-3 judge **mutation-tested** this: deleted a REVOKE, exactly one test went red, and
nothing else in 4785 did.

**3. `tenant_setting`'s scope join is what makes "every flag in the database" safe.** Writes require own
tenant AND `app.is_admin()` AND an EXISTS proving `setting_definition.scope = 'tenant'` — in BOTH the
USING and WITH CHECK arms, closing INSERT, UPDATE (walking a row onto another key), DELETE and
ON CONFLICT. So a customer can SEE that their audit chain is on and cannot switch it off. Enforced in
Postgres, not in a server action, so it binds any path that reaches the table.

**4. Core modules are code, not rows — enforced by a TRIGGER, not a policy.** Policies do not bind the
owner and are bypassed entirely by a `BYPASSRLS` role, so the slice-7 platform plane would sail through
one. A tenant with zero entitlement rows still has Leave and ESS by construction.

**5. Local and production run different Postgres majors** — 14.17 vs 16.14. `UNIQUE NULLS NOT DISTINCT`
is PG15+, so the nullable `company_id` grain uses a COALESCE expression index. Anything written for 16
would pass on the server and fail the gate.

**6. Corrections made during the build, recorded so they are not repeated:**
- The plan's "GRANT SELECT on customer-visible columns only" conflates a ROW property with a COLUMN
  grant. `customer_visible` drives rendering; the resolver needs `default_value` for hidden rows too.
- I invented `CountryPack.currency`, which does not exist. Currency-from-pack is slice 6's job;
  provisioning keeps `'MYR'` with the reasoning recorded rather than shipping untested slice-6 work.
- `packs/*/index.ts` inside a block comment contains `*/` and **closes the comment early**. Rewrote as
  `packs/<name>/index.ts`.
- My divergence inventory was wrong by ~9x: **46** test files mutate a tracked gate, not 4. It is no
  longer prose — `SLICE3_ENV_GATE_WORKLIST` recomputes the file→gates map from the tree and compares
  both ways.
- Two tests were green only because this box leaves `INDIVIDUAL_TXN_PAY_ENABLED` unset. Fixed, and
  re-verified under the **live deployment's full flag set**.

### Outstanding

- **Slice 3 must inspect all 46 files individually.** The worklist detects THAT a file mutates a gate,
  not WHETHER the mutation lands before or after `seedBase` — hook-registration order is not
  statically decidable.
- **The 0313 setting backfill is one-shot and env-blind.** Parity-correct for the documented
  `cp .env.example .env.local` flow and for the one live deployment; on any OTHER populated database
  whose env lacks those flags it GRANTS payroll reset/unlock rather than preserving them. Remediation
  DELETE is inline at `0313:463` but must be run by hand, and nothing detects the divergence.
- The "admin can READ their own entitlements" test remains formula-equivalent to `seedBase`'s own
  computation; its independence rests on the two drift ratchets. Stated honestly in the test.

---

## Slice 0 — 2026-07-26 — SECURITY: invitation privilege-escalation closed

First slice of the ADR-0077 platform program (plan: `~/.claude/plans/resilient-greeting-ripple.md`).
Not a feedback round — no board items. **Shipped:** `build/slice0@02511f7` → `main` as `26eebbe`.
Deployed 05:54:58 +08 (`✓ Ready in 128ms`, `GET /` 401). Verified live on the server: the CHECK
constraint applied and BOTH guard triggers (`app_user_subject_guard`, `app_invitation_lifecycle_guard`)
are present.

**Gate:** clean-room **PASS** — **4722/4722 tests, 437 files** · `tsc` clean · `next build` clean ·
3 mandated adversarial rounds (13 agents, 768 tool uses), all passed · plus an independent operator-
takeover probe run by hand against a real DB.

### The vulnerability was real and was reproduced before any fix

Exploits were written FIRST and run against unpatched `main`: **5 succeeded.** A customer's group
admin — and even a single-company `hr_admin` — could mint themselves the installation-tier `operator`
role through the invitation seam and consume it into a real grant.

Two facts combined: `app_invitation_rls`'s WITH CHECK (0151:51-53) had **no role conjunct**, and
`app.consume_invitation` is SECURITY DEFINER (0281) inserting `v_inv.role` into `role_assignment`
uncritically — and `role_assignment` is not FORCE-RLS, so 0295's matrix **never evaluated**. The
invitation seam was a way to write a grant the grant table itself would have refused.

### Decisions

**1. The initial fix was correct but badly incomplete — three further paths were found under review.**
- **`person_id` is also a payload, and it is the sharper hole.** Consume does
  `UPDATE app_user SET workos_user_id = <accepter>` on the target person's existing login. An
  invitation with a *legitimate* role (hr_admin, own company) pointing at the group super_admin's
  **person** hands the accepter that identity and every grant it carries, and locks the victim out.
  **It needs no forbidden role at all**, so a role-only fix sails straight past it.
- **Invitation rows were mutable after issue.** `ai_hr_app` held UPDATE on every column with a
  scope-only USING, so a `revoked` invitation could be flipped back to `pending`, `accepted_at`
  blanked, `expires_at` extended and `token_hash` replaced — defeating single-use, expiry and
  `revokeInvitation` in one statement. A WITH CHECK **cannot** fix this: it sees only the new row,
  never the transition. Required a trigger.
- **The seam was not even the shortest path.** `app_user`'s policy (0016:191-193) lets any GROUP
  admin run `UPDATE app_user SET workos_user_id = '<my account>'` on ANY login in the tenant —
  including the `operator` login, which `app_user.tenant_id NOT NULL` guarantees lives in one
  (db/seed.ts:181-193). No invitation involved. Closing the seam alone left this wide open.

**2. `SECURITY DEFINER` helpers were `pg_temp`-shadowable.** Postgres searches the session's TEMP
schema first when `pg_temp` is not named, so the house-standard `SET search_path = public` does not
protect a definer: any `ai_hr_app` session may `CREATE TEMP TABLE employment(...)` and choose the
answer a helper returns — defeating the new person-scope conjunct. Every function this migration
creates uses `SET search_path = pg_catalog, public, pg_temp` **and** schema-qualifies its relations
(both, so neither is solely load-bearing), and the two pre-existing helpers in the chain
(`is_company_descendant`, `has_role_for`) are re-issued for the same reason.

**3. Two of the first-round tests passed for the WRONG reason.** `consume_invitation` opens with
`UPDATE app_invitation SET status='accepted'`, and a CHECK constraint is re-evaluated on the updated
row — so with the constraint restored right after a forged insert, the *constraint* was refusing the
row and the RAISE guard was never exercised. Green while asserting a different mechanism than
claimed. Fixed by holding the constraint off across the whole legacy window and asserting the RAISE
text specifically. **This is the failure mode to watch for in every later slice.**

**4. Deliberate deviation from the slice plan.** The plan called for consume to refuse "company-scoped
rows unless hr_admin". Rejected as wrong: 0295's group branch permits a group admin to grant any
customer role at any scope (a company-scoped `manager` is legitimate), and at consume time the session
is the INVITEE's, so inviter-context conjuncts are not re-evaluable. Consume checks only static row
facts. Also corrected: the plan's headline `super_admin` example was already closed — 0020's
`role_assignment_super_admin_group_wide` blocks it at the grant table. **`operator` was the open path.**

### Outstanding

- **Kept false positive (ops debt):** a person with an ACTIVATED login who must move to a new WorkOS
  subject (email change, re-hire, lost account) can no longer be re-bound by invitation — the invitee
  gets a raw 500 and recovery is owner-side only. The rejection reasoning holds (the DB cannot
  distinguish an innocent re-bind from a takeover) but it is reachable from the shipped person
  dropdown in `app/admin/users/page.tsx`, which does not filter people who already hold a login.
- **Next slice candidate:** the remaining 0015/0016 definer helpers (`can_see_person`,
  `can_admin_employment`, `can_see_employment`, `company_subtree`) still carry
  `SET search_path = public` and read relations unqualified — same `pg_temp` defect, live elsewhere in
  the RLS surface. Nothing 0312 guarantees routes through them.
- **Accepted residual:** a company-scoped hr_admin may still activate an un-activated, grant-less login
  of a person in its own subtree. Bounded by the person conjunct; closing it would break
  `db/provision.ts` and `bootstrap-invite.ts`.
- **Recurring flake class, spun off separately:** `test/cp38.test.ts` (and previously
  `test/zakat-history.test.ts`) assert a secret's absence by substring-matching `JSON.stringify` of a
  payload containing a random UUID — ~1% failure per run. Same defect class twice now; should assert
  on parsed fields.

---

## r70 — 2026-07-25 — 2 approved items (1 a re-fix of a contested r69 item)

**Shipped:** `build/r70@c130ff7` → merged to `main` as `8ce75a3`. Both `deployed`. `deploy.sh` migrated +
restarted, 14:17:10 +08 (`✓ Ready in 136ms`, `GET /` 401 = password gate).

**Gate:** clean-room **PASS** — **4678/4678 tests, 436 files** · `tsc` clean · `next build` clean. Plus a
manual browser measurement of `7fe7e1ae` (below) — the step the automated gate structurally cannot do.

| id | Item |
|---|---|
| `7fe7e1ae` | Action search bar — focus-ring overlap (RE-FIX; r69's attempt was a verified no-op) |
| `2bba9e35` | Service-Based Entitlements is now the full policy editor (unblocks `bc9be1e8`) |

### Decisions

**1. r69's `7fe7e1ae` fix was a provable no-op, and the loop's gate could not have caught it.** The
reporter contested it: *"It still looks the same."* Correct. r69 swapped the modal input's `w-full` for
`min-w-0 flex-1` on a horizontal-overflow theory; measured in the running app at 1280×720 and 375×812, the
before/after geometry is **byte-identical** (input 285px, 17px right-slack, `scrollWidth−clientWidth=0`).
There was never any horizontal overflow. The **real** defect is vertical: the input carries
`outline:2px, offset:2px` (a 4px-outset ring), sits flush at the modal's zero-padding top edge, and is
`autoFocus` — so its ring paints ~3px **above** the modal, across the 24px rounded corners, every time it
opens. r69 shipped anyway because its test was a **source-string** assertion (`min-w-0` present) that
cannot see pixels; the build agent flagged this as a KNOWN GAP and it shipped regardless. **This is the
loop's structural blind spot: the build phase forbids starting a dev server (hang-guard), so it literally
cannot verify a visual fix.** The operator must do the browser measurement for any UI-geometry item.

**2. The re-fix was verified by measurement, not assertion, and the panel found a bug the operator's own
diagnosis missed.** Fix: add the house `py-3` to the search row + `p-3` to the results wrapper (this row
was the ONLY `border-b border-border px-4` in the repo with no vertical padding — an oversight vs 35 other
CardHeader sites), and `outline:none` on `Dialog.Content`. That last one is the missed bug: Radix renders
`Dialog.Content` with `tabindex=-1`, so on Enter the **dialog itself** caught a focus ring across all four
corners — a worse version of the same defect. Browser-measured after the fix (ring inset vs the modal clip
box, positive = inside): search input **+8px** top (was −3px, outside); result row **+8px** all sides;
dialog container ring suppressed (`outline:none`); wide delegation state (max-w-4xl) no h-overflow, +29px
inside. The `inset-ring` alternative was rejected in planning: `app/globals.css` defines the focus rule
**unlayered**, so it beats every Tailwind utility — `outline-none`/`ring-inset` on the input are inert, and
routing around it would fork the app-wide focus ring for one field.

**3. `2bba9e35` was built to UNBLOCK `bc9be1e8`, and `bc9be1e8` was deliberately held out of this round.**
`bc9be1e8` (remove the Company Entitlements tab) must build off a `main` that already contains the full
editor, or its agent reads a tree where Service-Based Entitlements still can't add/delete and either
no-ops or deletes the only policy-management UI. Building both in one parallel batch off the *current*
`main` would have defeated exactly that ordering. So `2bba9e35` shipped alone this round; `bc9be1e8` is now
unblocked for r71. Browser-confirmed the new capability renders: the Service Based Entitlements sub-step
now shows "+ Add entitlement", "Remove", and the Earning Method control, not just day figures.

### Integration

Trivial — the two patches share no files (command-bar vs leave-type-panel), applied clean, no locale
overlap. The real work this round was verification, not merging.

### Outstanding

- **`bc9be1e8` is now BUILDABLE** — its blocker (`2bba9e35`) shipped to `main` this round. It is the only
  approved item on the board. r71: build it off `main` (which now contains the full editor), and confirm
  by hand that add/edit/**delete** of a per-company policy all work inside Service-Based Entitlements
  before removing the old tab — that hand-check is the item's own precondition, see r68 Decision 1.
- **Local dev DB drifts behind `main` between rounds.** It was a migration behind this round (`0311` from
  r68 never applied), so the app 500'd on load — which is *why* r69's visual bug was never seen before
  shipping. Run `npx drizzle-kit migrate` against `ai_hr_dev` (port 5433) before any browser check. An
  `r70-integration` entry was added to this worktree's `.claude/launch.json` (port 3011) to run built code.
- **The loop cannot self-verify UI geometry.** The build phase's hang-guard forbids a dev server, so every
  visual/layout item needs an operator browser measurement before release. r69→r70 is the cautionary tale.
- The hourly watcher still polls the stale `IMPROVE_SSH_HOST` default (`10.20.30.20`) and reports
  `approved=0`. Fix the plist before it hides a real backlog again.

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

`build/r68@d8f9869` → `main` as `c008ac3`. All 8 `deployed`. Gate: clean-room PASS, 4609/4609 tests, 432
files. Shipped: anniversary→up-front grant (`adcdf215`, closing r66 Decision 1), service-based entitlements
by company×grade (`0b7eeb4b`), Grade→Job Grade (`02594a47`), medical/hosp balance fix (`6574c6b4`),
rounding reaches the balance (`5c928c07`), leave-criteria org fields (`7648a6c7`), company-change before
payroll (`9464bd56`), auto payroll-cycle catalog on company create + migration `0311` (`361e3b15`). Two
integration defects the full suite caught in patches that merged with ZERO textual conflict — the round's
lesson: **a clean three-way merge is not a clean semantic merge.** (1) `361e3b15` imported `core/payroll-
cycle` straight into `core/admin.ts`, breaking the ADR-0080 shrink-only pack ratchet; fixed by routing
through the `packs/payroll/service` facade, not by widening the allowlist. (2) `adcdf215` changed the a2c
first-year figure (10.90→19.73) that `5c928c07`'s test had hard-coded, so a green-looking assertion was
stale; repointed 11→20, kept it biting on the rounding. `bc9be1e8` was approved by the reporter but held
back: its plan forbids removing the Company Entitlements tab until add/edit/delete work inside Service-Based
Entitlements — verified against the merged `0b7eeb4b` that they do not yet. That gap became board item
`2bba9e35`, shipped in r70.
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


---

# ARCHIVED FROM HANDOFF.md on 2026-08-13 (during r191) — rounds r187, r188, r189

### r189 (2026-08-12) — CLAIMS GRADE-FIRST LIMITS (`0435`) AND THE PAY-ITEM FORMULA BUILDER

`e7eb5d83` rev5 + `e318eaec`. Gate **660 declared / 660 counted / every chunk exit=0 / 8,597 tests / 0
AssertionErrors / 0 timeouts**; tsc 0; `next build` 0; `gate:shadow` PASS 354/354; render 0 MISSING_MESSAGE
across 6 routes × 6 locales. Catalogues audited base-aware, 9023 → 9025, **all 17 deliberate deletions
confirmed absent BY NAME**.

⚠️ **THE FIX WAS HALF-ARMED UNTIL A SCRIPT RAN BY HAND — AND `deploy.sh` DOES NOT RUN SCRIPTS.**
Every mileage claim on production was priced by a legacy `mileage_flat` 0.70 scalar, because all five real
`claim_mileage_rate` bands sit on GRADE 12, **which has zero employments**. The limit editor no longer
offers that rate kind, so ANY re-save of the Mileage limit would have written `{"kind":"receipt"}`, dropped
the 0.70, and stopped mileage claiming for all 40 people. Verified not yet triggered.
The code fix (carry `rate_config` forward on re-save; delete the dead parser branch) stops FUTURE damage.
Making the band table the live path needed `scripts/backfill-mileage-flat-rate.ts --apply`, run manually
after the deploy — dry-run first, then verified: one company-wide band `[0 km → ∞] @ 0.70` from the flat
policy's own `valid_from`, GRADE 12's five bands untouched, nobody's claim changed by a cent.

**REVISION 4 REFUSED A VALID REQUEST BY MISREADING THE LEVEL, AND THE SCHEMA NOW RECORDS IT.** The reporter
asked for sub-claim limits; rev 4 deflected it as "a third group/claim/sub-claim level" and scoped it out.
`MEDICAL 001` is the claim TYPE and `MEDICAL 002/003` are its `claim_item` rows — **the SECOND level, which
has existed since the module shipped.** `0435` adds `claim_policy.claim_item_id`.

⚠️ **EVERY TYPE-LEVEL READ NOW CARRIES `claim_item_id IS NULL`, AND ONE OMISSION WOULD DESTROY, NOT MISREAD.**
Resolution picks the latest `valid_from` within a tier, so an item row is otherwise indistinguishable from a
newer version of the type's own policy. In `setClaimPolicy`'s close-and-insert predicate that means **saving
a limit for Outpatient would CLOSE Medical's own open version.** Readers were enumerated by grepping
`claimPolicy` repo-wide and cross-checking `graphify explain "getActiveClaimPolicy"`, not from the plan's
list. `deleteClaimType`'s DELETE is deliberately NOT filtered — item rows belong to the type being deleted.

**`e318eaec` SHIPS A RENDERER, NOT A PARSER — AND THAT REFUSAL IS THE ITEM.** The ticket asked for "normal
operator precedence". The reporter's live `OT1_5` is stored as a LEFT-TO-RIGHT FOLD, and that is the only
reason it computes the intended answer; literal precedence would have silently re-priced overtime that has
already paid real money. `test/pay-rule-format.test.ts` asserts RM584.13 for 15h, asserts the precedence
reading is a DIFFERENT number, and round-trips the rendered line through a reference precedence parser over
`OT1_5` **and all 64 three-step operator combinations**, with a vacuity check that the 0-clamp never engages.

**`first_name`/`last_name` ARE NULL ON 40 OF 40 PEOPLE** — every name lives in `full_name`. A dropdown built
from `${firstName} ${lastName}` read "null null" for EVERY option, not merely some. Fixed against the house
display-name source (`person.fullName` + `employment.employeeCode`); a repo-wide grep found no second site.

**KNOWN CONSEQUENCE, FLAGGED NOT ABSORBED: `fixed_allowance` can no longer be CREATED from any screen.**
Deleting the old limit editor was the plan's instruction and the grid posts no rate by design. Existing ones
(MOBILE 001, RM180) survive via the carry-forward and are pinned by a test, but a new one has no home. A rate
control belongs on Claim Types. Needs its own item.

### r188 (2026-08-12) — ONE DEFECT FIX, NO MIGRATION. "Apply to Early Overtime" could not be unticked.

`7c834696` came back contested with *"How come I cannot untick Apply to Early Overtime?"* — and they were
right. **A hidden input is submitted ALWAYS, whatever its value**, and the reader asked only whether the
field was PRESENT (`fd.get(key) != null`). Unticked sent `''`; `'' != null` is true; the flag saved ON every
time, on a setting that folds pre-shift minutes into PAID OVERTIME. Both production rules carried it true,
including `Standard`, the tenant default.

**Fixed on BOTH sides so neither depends on the other**: the hidden field renders only when on (absent when
off, exactly like a real checkbox), and `bool()` requires a non-empty value. The other three `bool()` fields
are real checkboxes and were never affected — verified, not assumed.

**NOT introduced by r186's rounding work** — it arrived with the original attendance-rule library.

**The test is SOURCE-SHAPE on purpose:** the defect lived in the form contract BETWEEN two files, so a unit
test of either half in isolation passed throughout, which is exactly why it shipped. It also pins that **no
OTHER hidden input on these forms is read by the presence-only pattern**, so the trap cannot generalise.

### r187 (2026-08-12) — EIGHT APPROVED ITEMS, SHIPPED. Migrations `0430` · `0432` · `0433` · `0434`.

`017d9c25` · `2961a7ae` · `1372d169` · `4e403268` · `5c65367d` · `579255c3` · `2166ef79`, plus the payroll
pack-facade fix. Gate **657 declared / 657 counted / every chunk exit=0 / 8,545 tests / 1 expected fail /
0 AssertionErrors / 0 timeouts**; tsc 0; `next build` 0; `gate:shadow` PASS 353/353; render check 0
MISSING_MESSAGE across 22 routes × 6 locales. Verified live: 353 migrations, all four objects present with
GRANTs, **payslips 84 and batches 22 UNCHANGED**, `GET /` 401, zero-change arrival dry-run.

#### ⚠️⚠️ CENTRAL ALLOCATION IS NOT ENOUGH — MERGE ORDER CAN STILL SILENTLY SKIP A MIGRATION
**This is a NEW failure mode and it nearly shipped.** The standing rule says allocate migration numbers
centrally, and I did — `0430`–`0434`, one per parallel agent. But allocation fixes each `when` BY NUMBER
while leaving **merge and deploy order free**, and drizzle's watermark is the last applied `when`.

On the shared dev cluster `0433` was applied first, pushing the watermark to `1781862533000` — so `0430`
(…530000) and `0432` (…532000) were **silently skipped, `drizzle-kit migrate` exit 0, no error, no table.**
Two agents hit it independently; one caught it only by comparing migration HASHES.

It would have been severe: `generatePayslips` now selects `payroll_statutory_adjustment` on EVERY run, so
a skipped `0430` makes every payroll generation on production throw.

**Production was safe only because r187 shipped as ONE unit** — the watermark was `1781862529000` and all
four sat above it, so a single deploy applied all four in journal order (verified after: 353 applied,
`0430` present with its 4 GRANTs).

**THE RULE, going forward:** when parallel agents each get a migration number, **they must reach production
in one pass or strictly ascending — never a subset out of order.** And `gate:shadow` cannot catch this: it
applies the whole journal in order against a fresh schema, so it passes either way.

#### `017d9c25` — THE DIAGNOSIS WAS INVERTED, AND THE FIX MOVED REAL MONEY
Payroll does NOT hold a stale copy of pay-item config — `core/payroll.ts` joins `pay_component` live at
generate time. The proof is in the reporter's own data: Director Fee was created 10 Aug, January was
processed 24 Jul, and it IS on the January payslip, because they reprocessed on the 10th. **The reprocess
read the NEW config and ignored the EPF box.** Root cause: a declared `pcbRemunerationType` short-circuited
the EPF/SOCSO flag inference and routed the amount into the `wage` bucket feeding all four statutories —
and the form makes that field compulsory once PCB is ticked, so the operator could not avoid it.

**Measured impact: 30 of 31 itemised payslips across the three open runs. Employee net +RM859.90, employer
cost −RM703.60.** Two results that contradict the approved plan and are both correct:
- **EPF employer RISES RM38 for two employees** — dropping the EPF wage below RM5,000 moves the employer
  rate from 12% to 13% under Third Schedule Part A. "EPF falls" is not universally true.
- **PCB does NOT move for the reported employee** — the LHDN annual EPF+life relief cap (RM4,000) was
  already reached at both figures, so K and the MTD are identical.

**A deliberate narrowing:** `epfBonus2012` is exempted from the plan's "SOCSO tick adds to the base" rule,
because SOCSO Act 1969 s.2 excludes a bonus from wages — honouring the tick there would compute an illegal
contribution. The existing golden test stayed green UNCHANGED.

#### THE PACK RATCHET FIRED FOR THE SECOND ROUND RUNNING
`core/payroll-txn-import.ts` imported four payroll-pack modules directly (r186 was `core/absence-days.ts`
against the attendance pack). **Any new `core/` file that needs a pack service must import
`packs/<pack>/service`** — brief agents on this up front. The fix is never
`test/pack-drift-allowlist.json`; the guard refuses additions in its own message because that list is
audited kernel-contract debt and only ever shrinks. Seven `core/` files already import a facade, so there
is precedent and no cycle.

#### A SCOPE LEAK FOUND INCIDENTALLY, WORTH KNOWING
`loadCatalogs` passed `scopeIds` straight to `listEmployees`, **which treats an empty array as "no filter"
and returned the whole tenant.** Now fails closed, pinned by a test. Found by an agent testing the
boundary rather than the happy path.

#### `579255c3` — TWO DEFECTS THAT ONLY RENDERING CAUGHT
`GROUP BY employmentStatusSql()` **fails outright** — the expression carries `today` as a bind parameter,
so rendering it twice yields `$1/$2` against `$3/$4` and Postgres rejects the statement (fixed to
`GROUP BY 1`). And the Draft card read **0** whenever another card was selected, because it counted under
the already-chosen bucket while clicking a card REPLACES the bucket — every individual count was correct,
which is exactly why only a render found it.

### ✅ THE FIXTURE TIME BOMB IS DEFUSED — the clock pinning HELD on 2026-08-12

It fired on 2026-08-10 (three cases) and 2026-08-11 (**11 cases across 3 files**, mid-gate at 00:24 MYT:
`LeaveCancellationTooLateError: Leave for 2026-08-11 can no longer be cancelled`). The fixtures hardcode a
10–12 Aug 2026 window chosen when that was "well in the future", and each day more of it rotted into the
past while the product correctly refused. **`1d5ceab0` pinned the clock on 24 cases (13 were already
pinned, 2 deliberately left on the real clock), and on 2026-08-12 — the last day of that window, when the
bomb should have been at its worst — two full gates ran with ZERO date-shaped failures.** The fix is
confirmed working, not merely believed to work.

**Keep this entry anyway**, because the reasoning is what generalises and this class WILL recur:

**THE FIX IS TO PIN THE CLOCK, NOT TO MOVE THE WINDOW.** `edd9707d` tried deriving the window from
`todayInKualaLumpur()` and went from 3 failures to 16 — roughly 100 assertions are pinned to the literal
dates. Pinning the clock moves one variable; moving the window moves a hundred. `requestLeaveCancellation`
takes an injectable `today` for exactly this.

**TWO TRAPS INSIDE THE FIX, both of which bit on 08-11:**
1. **Some calls pass `today` as a SHORTHAND property**, not `today:`. A substring check for `today:` misses
   them and writes a DUPLICATE key. tsc catches it — match the property name with a regex.
2. **DO NOT PIN THE CLOCK-RELATIVE TESTS.** The past/future gate test derives its dates from
   `todayInKualaLumpur()` precisely so it holds whenever the suite runs. Pinning it made it PASS FOR THE
   WRONG REASON — it stopped rejecting, and the failure read `AssertionError: promise resolved`. A test
   that starts passing when you pin its clock is a test you have just broken.
State after 08-11: **24 pinned, 13 already pinned, 2 deliberately left on the real clock.**

⚠️ **`scripts/gate-chunked.sh` WIPES `ai_hr_dev`.** It rebuilds the cluster between chunks, which drops the
dev database with it. Both r184 build agents found 0 tenants and 0 payroll batches and could not render-check
because of it. **Seed AFTER the gate, never before** — and a render check run before a gate proves nothing
about the tree you are about to ship.


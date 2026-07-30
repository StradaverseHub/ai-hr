# Handoff — ai-hr

Updated after **every release/deploy**. Newest round first; older rounds compress to a line.

The high-value part of each entry is **Decisions** — calls that the tickets themselves did not
settle. Those cannot be reconstructed from the diff later; everything else can.

## CURRENT STATE — read this first (updated 2026-07-31, after r85)

**If you read nothing else, read these seven lines.**
1. Deployed head is `main@e05099b`, migrations through `0334`, **283 applied on production**. **Next free
   number is `0335`.** No held branch currently claims a number — but **check any held branch's `when`
   against the deployed watermark before merging it** (see Traps: a stale number is a SILENT SKIP, and
   r85 caught `build/r83a` in exactly that state).
2. **CHECK `git branch --show-current` AT THE REPO ROOT, and `pwd` in every gate command.** The root is
   on `fix/companies-list`, many rounds behind, and **its HANDOFF.md is STALE**. `main` lives at
   `.claude/worktrees/mainwt`. r83 lost a full suite AND a `next build` to a `cd` that left the shell at
   the root — both reported GREEN.
3. **THE ENTITLEMENT KEYSTONE IS DONE.** `9816a5ad` step 2 is deployed: the engines read the five rules
   from `leave_type`, there is a real editor for them, and ANNUAL carry-forward expiry is **6 months**
   (the reporter's new policy — carried leave now forfeits two months earlier than before).
   **Step 3 `fa3f4ccb` is CONTESTED**, because the reporter asked to remove the STATUTORY MINIMUM. That
   was refused in rev 4 — it is the EA 1955 legal floor. Do not build it without an explicit written
   instruction from them.
4. **Three live payroll faults are planned and unanswered, and one is severe:** `ef31d251` — **no employee
   has ever seen a payslip**, because no run has ever been closed (47 payslips, 18 runs). Also
   `d0d2c9d1` (RM23,170 entered and never paid) and `97a9b0ab` (which is **NOT a fault** — PCB is
   cumulative, so revising an earlier month legitimately moves a later one; see its plan).
5. **THE LOCAL POSTGRES WAS WIPED AND REBUILT on 2026-07-31**, and the difference is the whole argument
   for keeping it clean: rehearsal **6s** (was 25–52 min), full migration chain from zero **2.3s** (the
   test template alone once took 49 min), Postgres starts in **4s** (recovery once took 53 min). The old
   data directory is at `/opt/homebrew/var/aihr-pg14.broken-20260731`. Teardown now stops the leak
   returning — **do not invent a `TEST_DB_NAMESPACE` unless you are running parallel agents.**
6. **Browser verification works and is worth doing.** It settled a contested item in five minutes.
   ai-hr is NOT publicly served — it is loopback-only behind a **cloudflared quick tunnel**,
   `https://remove-source-wood-currently.trycloudflare.com` (whose hostname CHANGES if that process
   restarts). Everything since r70 except `1ef1cf95` remains unverified.
7. **Reply on Telegram when the owner writes from Telegram.** Terminal output never reaches their chat.

### `9816a5ad` — SHIPPED in r85. Kept for the reasoning; step 3 is the open part

Step 1 shipped (r81, `0325`): ten rule columns on `leave_type`, backfilled, read by nothing.
Step 2 (`build/r83a`, `0328`) repoints the engines onto those columns. It is **built, gated and held.**

**`0328` is an assertion with no DDL, and on 2026-07-30 it FIRED against production:**

    leave type ANNUAL, rule carryForwardExpiryMonths, 1 policy row disagreeing

56 of 57 ANNUAL policy rows read 8 months; one reads 6. **It is a LIVE EDIT, not stale data** —
`leave-policy.updated` carries 8 at 10:06 that morning and 6 at 11:10. Consolidating would have silently
reverted it and aborted `deploy.sh` partway. Blast radius is nil (0 employments on that company+grade),
so **the agreed fix is to harmonise that row to 8, not to weaken the assertion.** Revision 7 of the plan
tells the reporter exactly that and invites a reject if they meant 6 for everyone.

**`leave_policy` has no `updated_at`.** `created_at` on that row is 2026-07-26, which says nothing about
when the value changed — that is why `0325`'s distinctness check passed on 07-29 and `0328` fires now.
**On this table, use the `leave-policy.updated` events, never `created_at`, to date a change.**

Step 2 also already decides the per-band question this file previously flagged as open: per-band
`carryForwardDays` and per-band carry expiry (`9d8cf621`) collapse into the type-level setting and stop
being read; the columns, JSONB keys and readers are retained, not dropped.

**Step 3 is `fa3f4ccb`** — it removes the Company Entitlements band surface and zeroes `leave_policy`.
Its `blockedById` guard has been released, so **nothing but this note now stops it being built first.**
Alone it stops accrual for all 22 employees: `leave_policy` is still the only home for earning method,
carry-forward, rounding and `maxBalanceDays`, and 57 of 67 policy rows are `earned_monthly`.

Written 2026-07-29, updated after r83 on 2026-07-30. Everything below the
`---` after this section is the per-round history; this part is the standing contract and the live
state. Update it when the state changes, not just when a round ships.

## How this project is actually run

**Deploy is automatic after a green gate.** The repo documents a human release gate (ADR-0045); the
owner has overridden it. Once tsc + the full suite + next build + the upgrade rehearsal are green, merge
to main, rsync, run deploy.sh, verify, mark the items deployed. Do not stop to ask.

**A round is not finished until HANDOFF.md records it.** Standing instruction from the owner.

**The gate, in full.** `pnpm exec tsc --noEmit` · `pnpm vitest run` (the WHOLE suite, not a subset) ·
`pnpm exec next build` · `./scripts/upgrade-rehearsal.sh main <scratch-db>` whenever a migration is
involved. The rehearsal is the one that catches "this applies to an empty database but not a populated
one".

**Deploy mechanics.** SSH is on **port 8288**, not 22 — `IMPROVE_SSH_HOST=203.142.6.241`, user `ubuntu`,
app at `/opt/ai-hr`. Deploy is rsync (excluding node_modules/.next/.git/.env*/.turbo/coverage/.claude)
then `./deploy/deploy.sh` on the box, which migrates, seeds catalogs, runs backfills and restarts. The
server has NO git checkout — rsync only, so `git log` there tells you nothing.

**Health check.** `GET /` returning **401** is CORRECT — it is the password gate, not a failure. Check
`systemctl is-active aihr` and curl `http://127.0.0.1:3000/` from the box.

## The feedback board — how the loop works

**Commands** (all from the repo root, `IMPROVE_SSH_HOST=203.142.6.241 pnpm improve:<cmd>`):
`pull` (open + contested) · `pull-approved` · `pull-blocked` · `push-plan` · `block` / `unblock` ·
`build-start` / `build-complete` · `release` · `mark-deployed` · `raise`.

Parsing tip: `pnpm` prints a banner before the JSON. Split on the first `\n[\n`, not the first `[`.

**Plans are PLAIN TEXT.** The board renders them RAW — no Markdown. Asterisks, hashes, backticks and
pipe tables all show as literal clutter to a non-technical reader. There is a skill for this:
`.claude/skills/feedback-plan`. Read it before writing any plan. Business language above the dashed
line, all technical detail in the BUILD NOTES trailer below it.

**Approve carries NO payload.** `approveFeedbackPlan` sends only the item id, so a plan that asks the
reporter to choose between options can never be answered — one item sat unbuilt three rounds that way.
State ONE course of action, recommend it, and tell them to reject with a reason if they want otherwise.

**Statuses:** open → planned → approved → building → done → deployed. Plus `contested` (reporter pushed
back, will be re-planned) and `blocked` (approved but waiting on an answer — added this session, 0317).
`startFeedbackBuild` accepts ONLY `approved`, which is what makes `blocked` a real guard.

**Plan history exists now (0318).** Every plan version and every push-back is kept in
`feedback_plan_revision`, append-and-close-once. Do not try to "tidy" it; a closed revision is immutable
by policy and by trigger.

## Running builds with subagents

Established pattern, used for r73/r74/r75. It works, with rules learned the hard way:

- **Group by FILE OVERLAP, never by theme.** r74 lost a round because a four-part delivery
  (650b6eb8 + its three siblings) was split across two agents; the agent correctly refused to build a
  navigation whose other tabs would 404. If two items touch the same screen, they go to one agent.
- **Anything cross-cutting runs SOLO and LAST**, against the settled tree. Pagination touched ~30 list
  pages; run alone it produced no collisions.
- **Every agent needs its own `TEST_DB_NAMESPACE`.** Without it they drop each other's template
  mid-run and both sets of results become noise that looks like real failures.
- **Tell each agent the traps its items will hit** — the guards it must not weaken, the writers that
  recently broke, the contracts it may not change. The best results this session came from briefs that
  named the specific hazard.
- **Agents must REPRODUCE before fixing. This is now the single highest-yield rule in this file.**
  **FIVE** reported faults this session were not the bug described. The failure modes, in the order you
  should check them: **already built** (`1ef1cf95` — shared leave groups shipped in migration 0220, only
  the creation button was missing) · **mislabelled** (`a324a4b3` — the row was renamed 3 weeks earlier;
  the plan was written off key names) · **on the adjacent screen** (`48224d12`, and the second picker was
  on a different sub-step) · **the reporter's diagnosis inverted** (`ae3bd088` — the screen was losing
  rows in transport, not filtering them) · **wider than reported** (`4d391ab7` — every hire with a
  manager was also duplicating, which nobody had raised).
  So: check *already built → mislabelled → adjacent screen* BEFORE checking *absent*. A held-back item
  with findings is a good result, and three of these would have shipped a wrong change if built to the
  ticket.
- **Enumerate every caller before changing any of them.** r78 was asked to fix one duplicate history
  row and found three more writers plus a live-but-unreferenced RPC endpoint. The enumeration was worth
  more than the fix.
- **The integration gate catches what no agent can see.** Every agent's own tests passed in r74 and
  r75; the full suite still found a permission-matrix omission and a nested-form bug. Per-agent runs
  are necessary and never sufficient.

## Traps that cost real time this session

**A `labelKey` IS NOT THE LABEL — and a plan written off key names will be wrong.** r78's `a324a4b3`
plan asserted that the shift-library nav row "reads Attendance Policy", because its descriptor says
`labelKey: 'attendancePolicy'`. It does not: `nav.attendancePolicy` has resolved to **"Shift settings"**
in all six catalogs since R17 (`c9f7211`, 8 Jul). All three renames that plan proposed were already
live. The lesson is the same one this file gives agents and it was broken while WRITING the plan:
**resolve the key against `messages/en.json` before describing what a screen says.** (The round still
had value — the keys were renamed so key ≡ its own string, closing a real landmine, and a test now pins
key ≡ camelCase(English label). No i18n guard could see this: check C walks only `app/` + `components/`,
so a nav key naming the wrong screen inside `packs/` was invisible.)

**A DATE DERIVED FROM AN INSTANT MUST GO THROUGH THE TENANT TIMEZONE — and the suite will not tell you.**
`toISOString()` is UTC and this product runs at UTC+8, so `new Date().toISOString().slice(0, 10)` is
YESTERDAY between 00:00 and 08:00 Malaysian time. r85 found one live for a day on `core/movement.ts`'s
`entryDate`, and it had passed three green gates purely because **the suite had only ever been run during
the Malaysian working day.** It failed the first time a run happened at 01:46.

Use `todayInKualaLumpur()` — it accepts an optional `Date`, so it converts a stored instant too. The
distinction that matters: date-only ARITHMETIC (`Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS`) is
correct in UTC and must stay that way; only "what date is this INSTANT" needs the timezone. Of 92
`toISOString().slice(0, 10)` sites, most are the former. About five are the latter and remain unfixed —
raised as `bb4f2265`.

**If you are ever debugging a date that is off by one, check the clock before the code.**

**A STALE MIGRATION NUMBER IS A SILENT SKIP — and it is far likelier than the reused-number case.**
drizzle-kit reads the LAST APPLIED `when` as a watermark and ignores every journal entry below it. So a
branch cut before other migrations merged carries a `when` that is now too old, and merging it produces
no error, no conflict, and no migration: the tables are simply never created, surfacing weeks later as a
missing relation.

r76 found the REUSED-number version of this (an abandoned branch reusing a shipped number). r84 found the
STALE version: `build/r81b`'s `0326` (`when=…426000`) against a production watermark of `0330`
(`when=…430000`). **Every held branch is a candidate**, because the watermark moves every time anything
else ships.

**Before merging ANY held branch: compare its journal `when` against the deployed watermark, and renumber
above it if lower.** Check with
`psql "$MIGRATION_DATABASE_URL" -At -c "select max(created_at) from drizzle.__drizzle_migrations"` or
simply against the highest `idx` in `main`'s journal. Renumbering means the SQL file, the journal entry's
`idx`/`when`/`tag`, and any source comment citing the old number — a number no file carries is a dead end
for the next reader.

**THIS DOCUMENT'S SHIPPED LISTS ARE NOT EVIDENCE.** r76 found an item recorded here as shipped in r74
that had never merged — and the same file listed it as still planned twenty lines earlier. The reporter
was shown, and refuted, a feature that did not exist. Before trusting any "shipped" claim, run
`git log -S <a symbol the work introduced> main`. An empty result means it never landed, whatever this
file says. The abandoned branch also carried a migration number `main` had already used, which merges as
a **silent skip**, not a conflict.

**TEST DATABASES LEAK.** `TEST_DB_NAMESPACE` has no teardown — each parallel round permanently adds a
template plus ten workers. It reached **366 test databases**, at which point DROP/CREATE DATABASE hangs
and a normally 1-7s template build took **1308s**. It looked exactly like a catastrophically slow
migration and nearly got reported as a 22-minute production deploy window. It is not: production has a
handful of databases. Cleanup restored a 7-second rehearsal. The harness should drop a namespace's
databases when its run ends.

**r83 found where that bill is REALLY paid, and it is not the checkpoint.** The box wedged: `CREATE
DATABASE` and `DROP DATABASE` both hung 10+ minutes at `CheckpointStart`, and an explicit `CHECKPOINT`
timed out at 120s while `checkpoints_req` / `buffers_checkpoint` / `checkpoint_sync_time` stayed
**byte-identical across 40 minutes**. That triple staying frozen is the diagnostic: **frozen counters mean
wedged, not slow.** Disk was fine, no fsync or panic in the log. `pg_ctl -m fast` cannot stop it — fast
shutdown waits on the very checkpoint that is stuck — so it takes `-m immediate`.

Recovery then ran **42 minutes**, and the log is the lesson:

    redo done at 50/E14139D0 system usage: CPU: user: 0.00 s, system: 0.00 s, elapsed: 0.00 s

**WAL replay was INSTANTANEOUS.** All 42 minutes were the pre-redo pass where Postgres walks every
database directory on disk, and there were **67**. Confirmed live with `lsof` on the startup process,
which held `base/` and one database directory open throughout. So the leaked databases do not slow
checkpoints — **they slow CRASH RECOVERY, and they slow it entirely.** Sweep them BEFORE you need them
swept. After the restart a `CHECKPOINT` completes in **0.078s**; the sweep then dropped 28 in seconds
(67 → 39).

**Each `CREATE DATABASE` forces a checkpoint, and test setup does ELEVEN of them** (one template + ten
workers). On a dirtied 8 GB `shared_buffers` that is what turns a ~3s template build into the
**2943s** one r83 measured — the same shape as the 1308s incident, arrived at from the other direction.

**`TaskStop` DOES NOT STOP THE DATABASE WORK A TEST RUN STARTED.** Killing a background vitest left its
server-side `CREATE DATABASE` running and wedged. The next full-suite run returned **12 failures, every
one a 30-second timeout — including a test whose body is only a file read** — and took 947s against 438s
for the same tree. All twelve were artefacts of that one orphaned statement. **Kill the client, then check
`pg_stat_activity` and cancel what it left behind.**

**Local Postgres after a reboot.** Data dir `/opt/homebrew/var/aihr-pg14`, but its config defaults to
port **5432** while the project uses **5433** — it must be started with `-o "-p 5433"`. After an unclean
stop it needs several minutes of crash recovery (397s this time). A launchd unit would end this.

**tsc CANNOT see a missing translation key** — `t('historyRevision')` type-checks and fails at runtime.
**CORRECTED r77: a guard DOES exist and this file previously said it did not.** `test/i18n-coverage.test.ts`
has three checks: (A) every `en.json` key present and non-blank in all six locales, (B) every namespace
resolves, (C) every static `t('…')` key resolves in `en.json`.

There are TWO holes in check C, both narrow and both real:
1. **It skips any file using more than one namespace** (`i18n-coverage.test.ts:84`, "can't attribute keys
   statically"). Exactly how r76's `t('historyRevision')` reached runtime.
2. **It only matches LITERAL keys** — the regex reads `t('some.key')`. A computed key such as
   `t(importFileMessageKey(err))` is invisible to it (found in r78). Any indirection through a helper
   that returns a key name is unguarded.

So: a missing literal key in a single-namespace file is caught; everything else is not. Check those by
hand across all six locales, prefer one namespace per file, and when a key is computed, add a test that
asserts every value the helper can return resolves.

**`rejects.toThrow()` passes on the WRONG throw.** Two tests this session passed for the wrong reason —
one because a fixture used a non-existent field so the insert failed on NOT NULL before ever reaching
the constraint under test. Assert the constraint NAME or match the real Postgres error via the `.cause`
chain; Drizzle wraps errors as "Failed query: …".

**Fetching page HTML to check the UI gives false positives.** Next.js embeds the whole i18n catalog in
the payload, so grepping rendered HTML for a label finds it whether or not the component rendered.
Check the component source.

**A GATE YOU CANNOT TRACE TO A TREE IS NOT EVIDENCE — and it will read GREEN.** In r83 a single `cd` to
the repo root (to read a script) left the shell there, and the next full suite AND `next build` ran
against **`fix/companies-list`** instead of the integration branch. Both reported clean. The tell was in
the output the whole time: **vitest prints its root on the `RUN` line**, and the counts were 479 files /
5359 tests where the tree under test was 488 / 5576. **Start every gate command with an explicit `cd` to
the worktree, or echo `pwd` alongside it**, and read the count against the tree you think you are on.
This is the same root-worktree trap that cost r79 a round, arriving by a different route.

**`next build` OOMs ON THE SERVER as the tree grows, and `deploy.sh` runs it BEFORE `db:migrate`.**
r83 died at ~3013 MB against the 3072 MB cap with "Ineffective mark-compacts near heap limit" during
"Running TypeScript" — the identical failure R52 hit at ~1.95 GB against the old 2 GB default, and the
same diagnosis both times: nothing wrong with the code, `tsc --noEmit` and the full suite green locally.
**Raised to 4096 in r83.** The ordering is the saving grace and worth knowing: because the build precedes
the migrate, an OOM aborts with production's schema UNTOUCHED and the service still serving the previous
`.next` — a non-event rather than a half-applied release. Always verify that after a failed deploy
(`systemctl is-active aihr`, `GET /` 401, and the migration count) rather than assuming it. If it OOMs
again, check `free -m` first: the box has 3.9 GB RAM and 3.9 GB swap, so past ~4096 this stops being a
headroom problem and becomes a bigger-box one. **Never reach for `typescript.ignoreBuildErrors`** — the
build's type pass catches RSC client/server boundary errors that `tsc` alone does not.

## Live state — accurate as of the end of the 2026-07-29 session

**Deployed:** `main@e82c519`, service active, migrations through **0322**. r77, the companies hotfix and
r78 added no migration, so **the next free number is `0323`** — allocate it centrally, never let an agent
pick one (r76 found an abandoned branch reusing a shipped number, which merges as a SILENT SKIP).

**Board, counted on production at handover:** `approved = 11` · `contested = 4` · `open = 6` ·
`blocked = 2` · `deployed = 506` · `cancelled = 9`.

### START HERE — the four contested items are all small and all actionable

Three of these are post-deploy push-backs on work that shipped THIS session. None disputes the build;
each asks for a little more. Re-plan and build them first — they are the cheapest value on the board.

- **`9816a5ad` rev 5 — this is an AGREEMENT, not an objection.** The reporter writes "we can proceed
  with consolidating these settings" and confirms the split: **Leave Year Type, Earning Method, Carry
  Forward Policy, Rounding and Maximum Balance stay at LEAVE TYPE level and stop being duplicated per
  company+grade; Benefit Scheme → Service Based Entitlements controls DAYS only.** Their stated business
  rule: "Annual Leave rules are the same for everyone and only the entitlement days differ by grade."
  That matches what the data already shows (see below). **This is the keystone item — `fa3f4ccb` is
  blocked solely on it.** Re-plan as rev 6 restating the agreed structure and get it approved.
- **`33bf1a2d`** — remove the "13.5d left" sub-line under the Days column, and apply the same layout to
  the **leave cancellation** category as well. (r77 restyled only the leave-request table.)
- **`d6429eb4`** — "Submit Decision" → "Submit", **including inside the pop-out after Review dates**.
  Note r77 deliberately held `submitDecisions` back as outside the approved plan; the reporter has now
  asked for it explicitly, so it is in scope.
- **`1ef1cf95`** — the reporter finally states the real rule, and it is more than r78 investigated:
  seven leave types (CGL, CPL, NDL, EXM, GD, MRL, STD) share **one combined 10-day annual entitlement**,
  AND **each application is capped at 3 consecutive days regardless of type**. The combined pool already
  exists (`scheme_leave_combined_limit`, migration 0220). **The per-application 3-day cap is the part to
  verify — it may not exist at all.** Check before planning.

### The 11 approved items — nothing is blocked, but read the sequencing

**Ready to build now, no dependencies:** `fc776376` (pagination — **SOLO AND LAST**, cross-cutting, ~30
list pages) · `deec1691` (dependency explorer) · `9cbf5e0d` (Employee Status state machine, LARGE —
supersedes what r75 shipped) · `241817ef` (approval workflow — **the plan requires repointing the gate
BEFORE removing the company toggle**; 6 of 8 companies currently have multi-step OFF and would start
running their assigned template).

**The movement cluster — one body of work, in this order:** `941c9dac` (effective date vs entry date)
→ `ae9350f2` (Termination movement type). Both land on `core/movement.ts` and its projection, which r78
has just reworked. `4d391ab7` shipped in r78 and is the enabler; do not undo its tagging.

**The import pair:** `d8471481` (.xlsx redesign) supersedes the file picker r78 shipped. `lib/import-file.ts`
was deliberately built so the READ step swaps for a workbook decoder without touching PARSE or the write
path — `lib/spreadsheet.ts` `workbookToCsvText` already does this for the leave importer.

**The payroll cluster:** `4fb8b75a` rev 2 is the approved MAP with a six-step order (see r78 Decision 3).
Steps 1–4 do not touch Payroll Items, so `61bf109d` (pay item input types + formula) can run in parallel
— but any later step reorganising Payroll Items must follow it.

**`1f6fd6d8`** (Leave Balance Summary rebuild, LARGE) — the reporter supplied an exact layout and
formula. Its plan flags one deviation to keep: YTD Entitled must render the granted-to-date ledger figure,
not a prorated projection, or the column stops adding up to Available Balance for the 10 up-front-granted
policies. **Sequence AFTER `9816a5ad`**, because it reads carry-forward expiry from settings that item
relocates.

### The 2 blocked items — each needs one answer, then unblock

- **`fa3f4ccb`** — blocked on `9816a5ad` being approved. It is step 3 of that same job. Alone it removes
  the only home for earning method and carry-forward and **stops accrual for all 22 employees**.
- **`956cec85`** (statutory forms) — blocked on the reporter naming which submission channels and file
  formats they actually use. A statutory form with an invented layout is worse than no form.

### The 6 open items — 4 are new and unplanned, 2 were raised by us

New from the reporter, never planned: `4d6eae7b` (Leave Year Type step in General workflow) ·
`9f5164d8` (entitlement rounding with custom decimals) · `a1d82340` (redesign the overall payroll process
flow) · `031fa21b` (remove a duplicate Request subsection from Employee Details).

Raised by us from the r78 payroll map, both with live evidence and both correctness issues:
- **`b84821cf`** — two employees flagged subject to HRDF at companies that are not registered. The
  payslip stamps `hrdfSubject: true` then computes zero. **ISEDECOR BINA has run eight payrolls in this
  state.** UI-only warning exists at `app/admin/personnel/[employmentId]/page.tsx:2460-2464`; there is NO
  run-level check.
- **`707b3851`** — Chin Hin Property Group and SpaceX both name "Monthly" as their default payroll cycle
  while having **no cycle defined at all**, so both are silently blocked from running payroll and never
  have. `core/payroll-run-group.ts:224-238` refuses with `INVALID_CYCLE`.

### Entitlement facts you will need before touching leave (verified on production)

Both configurations are live: for Annual Leave **6 of 22 employees take days from a Benefit Scheme and
16 fall through to `leave_policy`** (Medical 5 / 17). Precedence is one composition,
`entitledDays = max(floorDays, schemeDays ?? policyDays)` (`core/leave-compute.ts:502`), four call sites
in `core/leave.ts`. `schemeBandDays` returning **null — not zero** — is the fallback trigger.

`leave_policy.accrual` exclusively owns earning method, carry-forward + expiry, rounding and
`maxBalanceDays`, read for **every** employee including scheme-driven ones; `accrueEarnedLeave` asserts
`pol!` non-null, so an earned-method type cannot accrue without a policy row. **57 of 67 policy rows are
`earned_monthly`.**

**What makes the reporter's consolidation safe:** grouping `leave_policy` by leave type, EVERY type has
exactly ONE distinct method, ONE carryForwardMax and ONE roundingMethod across all its rows — ANNUAL has
57 rows and 1 of each. The collapse to type level is therefore lossless against current data. The
capability lost is per-company rule variation, which is real but unexercised; the reporter has been told
and has accepted.

**Coverage gap that bites at reset time:** 12 of 41 benefit schemes have zero entitlement rows, and
ISEDECOR BINA + Demo Group Holdings have no schemes at all between their 8 employments. After the reset
those employees drop to the statutory floor until their schemes are filled in.

## Carried debt — none of it blocking, all of it real

1. **BROWSER VERIFICATION IS NOW THE TOP RECOMMENDATION, not just debt.** Nothing has been
   browser-verified since **r70**. r71–r78 plus slice 4 moved Payroll's navigation to a fly-out, split
   Attendance three ways, renamed leave labels, added four inquiry surfaces, added pagination to ~17
   screens, gated menu rows by entitlement, restyled the approvals table, made the Employment tab
   read-only and rebuilt the emergency-contact section.

   **This stopped being theoretical on 2026-07-29.** The Organization Companies screen rendered 1 of 8
   companies for 24 days behind a fully green suite, an item was closed telling the reporter the screen
   was correct, and only a user's screenshot overturned it. See the hotfix entry. **Two specific
   unexercised surfaces to look at first:** r77's approvals client island
   (`app/approvals/leave-decide-controls.tsx` — reject-reason box revealed by state) and r78's
   employee-import file picker. This repo has **no DOM or interaction test runner at all**, so neither
   can be covered by a test today.

   Recommended first move for a new session: a browser pass over r71–r78 before building anything new.

2. **A rendered-markup test can still be blind.** The companies bug survived a test upgraded from
   "checks props" to "asserts rendered markup", because the markup came from props that had never
   crossed the RSC transport. When a client component receives server-passed nodes, the fixture must be
   the **post-transport** shape. `test/organization-list-rsc-lazy.test.ts` is the worked example.
   Grepping `cloneElement|isValidElement|Children.` across `app/ components/ lib/` finds no other site
   today — but the cliff is data-dependent (more rows, fuller fields), so it fails silently and only
   past a size threshold.

3. **Pagination pages in memory on ten tables** — `paginateRows()` fetches everything then slices. The
   reader-visible contract holds and the 2,000-row ceiling still protects the browser, but the plan
   promised faster loads and for those ten that is not yet true. Pushing limit/offset into ~10 read
   functions is the follow-up. Relevant now: `fc776376` is approved and cross-cutting.

4. **ADR-0077 slices 5-10 are unbuilt.** Plan at `~/.claude/plans/resilient-greeting-ripple.md`. Slice 4
   had to be re-aimed at r74's `navNodes` contract because the plan predates it — expect the same for
   later slices.

5. **TEST-DB TEARDOWN IS A CONCRETE ONE-PLACE FIX — do this before the next big parallel round.**
   `test/global-setup.ts` drops databases only for its OWN namespace and only at the START of a run
   (drop-then-recreate). There is no teardown, so every finished agent orphans 1 template + 10 workers
   **permanently**. ~20 namespaces were created in the 2026-07-29 session alone. It reached 296 databases
   / 7.3 GB, a single checkpoint ran 46 minutes, five agents queued behind it, and the upgrade rehearsal
   could not create its scratch database at all. Swept to 31 DBs / 1.6 GB with the owner's authorisation.
   **The fix: drop the namespace's template and workers when the run exits.** Note `git branch -f` and
   bare `DROP DATABASE` are both blocked by the permission classifier — the sweep needs the owner to run
   it, or a `Bash(psql:*)` rule. **138 git worktrees** are also still lying around.

6. **Two dead/misplaced things found in r78 and deliberately not changed:** `payment_basis` on the
   payroll config screen is written, validated, stored and **read by nothing**; and probation months,
   review reminder days and default currency live on the payroll screen while belonging to hiring,
   appraisals and compensation. Both are steps 2 and 3 of the approved `4fb8b75a` order.

7. **`transferEmployee` now has zero production callers** but was kept deliberately (r78) — it is the
   only writer of `assignment.transferred`, a type years of production history contains and which
   `reverseLegTx` still replays. Do not delete it as dead code.


---

# Round history

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

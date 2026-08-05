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

## CURRENT STATE — snapshot 2026-08-06 (r160 SHIPPED)

**`main@7cae348b` is what runs. Production on 327 migrations. Next free migration number is `0404`**
(0389, 0401 and 0402 were never claimed and are dead; r160 added NO migration). No half-applied
migration, no pending deploy, nothing in flight. Verified after deploy: service `active`, `GET /` 401,
and `rsync -azi --delete --dry-run` reporting **zero changes**.

### The board — counted on production 2026-08-06 after r160 shipped (owner role; `DATABASE_URL` is RLS-blocked)

**`deployed = 589` · `approved = 7` · `building = 2` · `cancelled = 12`. `open`, `contested` and
`planned` are all ZERO.** The board moves under this file between rounds; re-count rather than trusting
this line.

**THE REPORTER APPROVED ALL SIX PLANS pushed on 2026-08-05**, which is why `approved` went 5 → 7 while
four items shipped. Every premise in them was reproduced in source AND measured on production before the
plan was written — **the measurements are IN the plans; quote them rather than re-running.**

**THE 7 APPROVED AND UNBUILT:**
- `0bb0e303` rev 2 — My Attendance needs a third row, Attendance Request. Rows 1 and 2 already ship; the
  request forms live inside `app/me/page.tsx:287-406` and move to a new `/attendance/requests`.
- `7c834696` rev 2 — four amendments to shipped attendance stage 1. Points 1/2/4 are cheap; point 3 (the
  calculation breakdown) is the only engine work. **Point 4 is a trap: "Difference / Value (RM/%)" is NOT
  a calculation setting** — it is `shift.differential`, the premium `core/payroll.ts:1968` prefills, live
  on 2 of 9 shifts. Late/early grace ARE free to remove (0 shifts carry either). All 9 rules still have
  deductions OFF, which is most of why the reporter says the settings do nothing.
- `35524d1f` — Create Employee refuses a blank Identity No when any statutory field is filled. Fix at
  `setStatutoryProfileMY` (`localization/my/statutory.ts:236`), mirroring `setIcProfileMY`. **No
  migration: `ic_number` is already nullable and its unique index is already partial.**
- `a00c4f64` — Team Leave Tracker. The calendar is the dashboard's FIXED full-width row and is
  `mandatory` in `dashboard_card_config` for both tenants.
- `3ced1040` — Confirmation becomes a COMPARISON kind (like Promotion). `movement_event_type` has ZERO
  rows, so no tenant override to consider. Watch `MovementNoChangeError`.
- `bd89ccd8` — asks for Delete on movement events. **ALREADY BUILT as Roll Back + Edit, and a hard
  delete was settled AGAINST (`9064cffb`). Do not re-add it.** The real gaps are the mandatory reason
  (**10 of 11 rollbacks recorded none**) and pending-row wording.
- `2ef69d1e` (Back Pay — the largest thing left, must go LAST). **Its plan's mandatory pre-build count is
  DONE, measured 2026-08-06: 26 compensation rows / 22 employees / 3 periods were keyed AFTER the payroll
  they should have affected, 9 of them with a real salary difference, and it moves in BOTH directions
  (one is 6000 → 5500). The naive query — valid_from before the last payslip — returns 41/36 and is
  WRONG; that is just "everyone has a salary".**

**STILL `building`, both deliberately partial. `improve:pull` HIDES `building`, so nothing but this
file will ever surface them.** Their board `build_ref` was stamped 2026-08-05 and is now STALE for
`35b7af0a` (it still says 25 labels / groups 6+ unbuilt, and names an `8590615a` overlap that is
deployed). Updating it was refused as an out-of-scope production write, so **the bullets below are the
authority, not the board field.**

- **`6e9a126e` — releases ONE (r141) and TWO (r159) are live. RELEASE THREE IS DATA-BLOCKED, not
  merely awaiting a decision.** Measured on production 2026-08-05: `leave_policy` **67** rows,
  `benefit_scheme` **41**, `scheme_leave_entitlement` **292** — against **0** in both
  `entitlement_template` and `entitlement_eligibility_rule`. Release two made the engines resolve
  `template ?? scheme ?? policy`, so with the new layer empty everything still falls through to the
  old one; dropping it without migrating those 400 rows first would resolve every entitlement to the
  statutory floor. **A data migration must come first, and it does not exist yet.**
  **The OTHER blocker is CLEARED as of r160**: `1ae7f3ab`+`4fdb69b2` shipped, and `deleteLeaveType` no
  longer hand-counts limbs. `core/leave-type-refs.ts` is the single declaration and
  `test/leave-type-referrers.test.ts` compares it against the live foreign keys **in both directions**,
  so dropping `leave_policy` now FAILS THE SUITE until its disposition is updated, instead of silently
  removing a guard. `employment.benefit_scheme_id` is already at **0** rows, so that column alone is safe.
  **Nothing has been dropped or cleared — release three is the OWNER'S decision, not a build task.** The
  proof that releases one and two are inert, and the carry-forward defect to re-read before planning
  three, are in `docs/HANDOFF-HISTORY.md` → r159 Decisions; read them there rather than re-deriving.
  `build/r154` is squashed and ancestrally unrelated to what shipped — ignore it in any branch scan.
- **`35b7af0a` — groups 1-2 (r138), 3-5 (r159) and group 6 (r160) are live. 24 labels remain**, measured
  not estimated. Group 6 was Tax Category: the Personnel card had always named five circumstances while
  the wizard labelled its options "1", "2" and "3", so a hire needed the LHDN numbering by heart and a
  wrong pick is invisible afterwards — it is simply the wrong monthly tax until someone notices. Both now
  render `components/tax-category-field.tsx`. Remaining: the identity, org-cascade and residual statutory
  groups. **3 of the defined keys only LOOK retirable — see the computed-key trap below; they are pinned
  by test and deleting them breaks real screens.** The `8590615a` overlap is GONE (it is deployed).

### THE DELETE GUARD IS FIXED (r160) — and the durable lesson is the count, not the fix

`deleteLeaveType` counted FIVE tables, `listLeaveTypes`' `inUse` predicate counted THREE, and the
database carries **TWELVE** foreign keys to `leave_type`. So Delete was offered on a type Postgres would
refuse and the admin got a raw 23503 — the reported "Special Leave cannot be deleted".

**Both plans and this file said ELEVEN. The twelfth, `leave_generation_run_item`, arrived with
`6e9a126e` release two and no hand-written list caught up.** That is the lesson worth keeping: a list of
referrers maintained by hand is wrong the moment anyone adds a table.

So there is no list any more. `core/leave-type-refs.ts` declares each referrer with a disposition —
`history` REFUSES the delete, `config` is CASCADED with it in one transaction, and the self-reference
`leave_type.balance_source_type_id` is NULLED on the OTHER type (deleting Caregiver Leave because it
drew from Special Leave would be catastrophic). Both the button predicate and the delete guard are
GENERATED from it, and `test/leave-type-referrers.test.ts` fails if the declaration and the live foreign
keys disagree in either direction, or if a cascaded table ever acquires a referrer of its own.

**`inUse` CHANGED MEANING and it is easy to misread:** it is now "this type has HISTORY", not "anything
points at it", because configuration no longer blocks a delete. A type carrying only policies and
approval rules is correctly deletable and shows Delete.

**`core/read.ts` around line 1770 documents the identical hazard for job grades** and requires the
button predicate and the delete guard to stay byte-identical. That rule is now structural for leave
types rather than remembered.

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

### ⚠️ TWO OWNER DECISIONS OPEN ON ATTENDANCE — free to make NOW, expensive later

1. **THE OT ROUNDING RULE IS AMBIGUOUS IN THE APPROVED PLAN.** It gives two mutually exclusive
   examples: "0:01–0:59 at round-to 60 → 60" implies round UP; "121 at round-to 30 → 120" implies
   NEAREST. Nearest is what ships, unchanged from before. Production has exactly ONE rounding band —
   rule `A01`, 61–119 minutes, round-to 60 — so today 61–89 rounds DOWN to 60 while 90–119 already
   rounds up. **It costs nobody anything yet**: `A01` is not the tenant default and no shift selects
   it, so it decides ZERO days. The moment someone assigns `A01` to a shift it becomes an hour of
   overtime pay per occurrence. `test/attendance-stage1-calc.test.ts` pins today's behaviour against
   `A01`'s real geometry, so choosing round-up will fail a test that names the exact minutes that move.
2. **"Overtime beyond the final band shall not be counted"** would cut `ot_minutes` DOWNWARD and
   retroactively. Not built — those minutes keep the final band's rate. Truncation needs its own opt-in.

**One human-visible consequence of r140 on production:** rule `A01`'s band ladder breaks contiguity,
so the new validation refuses to SAVE it until repaired. Deliberate — a hole in the ladder used to be
cosmetic and now decides which rate column overtime lands in. The band editor flags the offending row
on OPEN, in the same wording as the save error, so it is visible rather than a surprise at save time.

### ⚠️ THE PAID-ITEM GUARD IS ONLY ~14% EFFECTIVE TODAY, AND THAT IS BY DESIGN

`f1123afd` refuses to remove a recurring pay item that was paid on a processed payslip. **It can only
fire where the payslip stored WHICH component produced a line — and measured 2026-08-05, only 7 of 50
payslips carry `statutory.componentLines` (3 carry `recordLines`).** Line stamping began on
2026-08-01 (`862ed0ad`) and the kernel's own comment says earlier runs cannot be itemised
retrospectively.

**There is no payslip LINE TABLE at all.** `payslip` holds aggregate columns plus a `statutory` jsonb,
and the per-item detail lives inside it keyed by catalog CODE — **not** by
`employment_pay_component.id`. So the stored link is to the pay ITEM, not to the specific
effective-dated row; the guard additionally requires the batch's stored `pay_period` to fall inside
that row's own `valid_from`/`valid_to` window to attribute a line to it rather than a sibling.

**When there is no stored evidence the removal is ALLOWED, deliberately.** Refusing on absence of
evidence would block removing almost every recurring item paid before August with no way for an admin
to prove otherwise. The choice is pinned by an explicit test, so reversing it requires changing a test
and saying why. **The guard becomes fully effective as new payslips accrue** — it is protection going
forward, not a repair of history. Say that plainly rather than implying the paid items are protected.

### FOLLOW-UPS MEASURED BUT NOT BUILT

- **"Processed By" on the payroll dashboard is viable** — measured on production: 43 processed events,
  **43 with a resolvable actor name**. The agent shipped the date alone because it could not verify
  from its sandbox. It is now a two-join + one-`<td>` change.
- **A company logo EXISTS** (`company_logo`, read by the report letterhead). `169e3c24`'s plan said
  none existed and promised the reporter a payslip without one, so it shipped without — but a
  letterhead is now cheap.

### Durable product facts from the 2026-08-04 measurements (the items themselves have all SHIPPED)

**Re-counted 2026-08-05: `7cd914b1`, `8590615a`, `65f466e2`, `c459bff9`, `2e3ec77d` and `9861b8a4`
are all `deployed`, and `2e3ec77d`'s relief-stripping bug is verifiably fixed (the form now spreads
`...base.pcb`).** The per-item measurement block and the two "awaiting the OWNER" findings that stood
here were planning inputs for work that has since shipped — they are in `docs/HANDOFF-HISTORY.md`
under their rounds. What survives is the handful of facts that outlive their tickets:

- **`employment_type` lives on `assignment`, NOT `employment`** — a query against
  `employment.employment_type` errors.
- **`expireAgedLeave` has forfeited 0 rows / 0 days, ever** (only RL has expiry configured), and
  deleting `scripts/expire-aged-leave.ts` without first removing its `30 3 * * *` crontab line leaves
  cron firing at a missing file.
- **`EMERGENCY_LEAVE_CODE = 'EMERGENCY'` is still hardcoded** (`core/leave.ts:1877`) while production's
  type is `EL` — the constant is now documented as "the code the PACK SEEDS" and the resolver changed,
  so **re-verify against the tree before reusing the old diagnosis**, which named line numbers that
  have moved.
- **Five of the eleven items planned 2026-08-04 reported something DIFFERENT from what was actually
  wrong** (`65f466e2`, `b1f984fe`, `44129979`, `7f6ca478`/`1b87e8a0`/`18103ba4` asked for payroll
  statuses/columns that do not exist as data — `payrollStatusEnum` is `['draft','processed','closed']`
  and generation is synchronous, so a failed run leaves NOTHING to display). **Reproduce on production
  BEFORE agreeing a plan's premise.** The 2026-08-05 planning pass hit the same rate: of six items,
  two were already built (`0bb0e303` rows 1-2, `bd89ccd8` entirely) and one asked to remove a payroll
  premium it had mistaken for a calculation setting.

### Waiting on the owner, not on code

1. **`usage:capture` is the ONLY unscheduled sweep, and the gap BLEEDS** — usage cannot be
   backfilled, so every unscheduled day is permanently unbillable. **FOUR** jobs run (verified with `crontab -l` on 2026-08-05): `accrue-earned` (monthly, 1st 02:00),
   `review-sweep` (daily 03:00), `expire-carry` (yearly, 1 Apr 03:00) and `provision-runner` (every
   minute). **`expire-aged-leave` is NOT among them** — an older note here claimed five including it. **Verify with `crontab -l` as `ubuntu`, NOT `systemctl list-timers`** (no timers
   exist). Suggested: daily 01:00, ahead of the leave sweeps.
2. **Slice 6's deploy-failing flip** (unclassifiable company: warning → failed deploy) needs explicit
   confirmation before shipping — right end state, deliberate foot-gun.

### Known live defects, deliberately left standing

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
- **Slice 9's remainder**: tenant CLOSURE (dual-controlled, own retention check) and REACTIVATION
  (record the suspended window, replay skipped sweeps with it EXCLUDED from expiry clocks — the r108
  history entry explains why expiry cannot simply re-run).
- **Slice 10's dashboard**, now that the meter records. Arguably wants slice 7's platform plane first.
- **Slices 7 and 8** — the big untouched ones (platform role/process/systemd; audit-chain lifecycle).

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

**Deploy is automatic after a green gate.** The repo documents a human release gate (ADR-0045); the
owner has overridden it. Once tsc + the full suite + next build + the upgrade rehearsal are green,
merge to main, rsync, run deploy.sh, verify, mark the items deployed. Do not stop to ask.

**A round is not finished until HANDOFF.md records it.** Standing instruction from the owner.

**The gate, in full.** `pnpm exec tsc --noEmit` · `pnpm vitest run` (the WHOLE suite, not a subset) ·
`pnpm exec next build` · `./scripts/upgrade-rehearsal.sh main <scratch-db>` whenever a migration is
involved. The rehearsal catches "applies to an empty database but not a populated one".

**Deploy mechanics.** SSH port **8288**, `ubuntu@203.142.6.241`, app at `/opt/ai-hr`. Deploy is rsync
(excluding node_modules/.next/.git/.env*/.turbo/coverage/.claude) then `./deploy/deploy.sh` on the
box, which migrates, seeds catalogs, runs backfills and restarts. **The server has NO git checkout** —
`git log` there tells you nothing.

**Health check.** `GET /` returning **401** is CORRECT — the password gate, not a failure. Check
`systemctl is-active aihr` and curl `http://127.0.0.1:3000/` from the box.

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

**`graphify-out/` in THIS worktree holds a knowledge graph of the whole codebase** (~13k nodes /
~38k edges at r137-era — counts drift per round; the graph is the authority, not this line), built by
[graphify](https://github.com/Graphify-Labs/graphify) from local tree-sitter AST (no API key, no
LLM). ~99% of edges are EXTRACTED (explicit in the code), the rest INFERRED. It is **untracked by
git and excluded from the deploy rsync** — it lives on disk here only, regenerable in ~a minute.

**Use it FIRST when you need to understand code** — who calls what, with file:line, read from the
tree rather than from this file's prose (line numbers in prose go stale; the graph does not — it
already corrected one of this file's own citations). All commands run from this worktree:

    graphify explain "applyLeaveTypeRules"     # a node + every caller/import, with file:line
    graphify query "how does X reach Y?"       # BFS over the graph, --budget N tokens (default 2000)
    graphify path "requestLeave" "core/payroll.ts"   # shortest path between two nodes
    graphify affected "withTenant" --depth 2   # reverse traversal: what breaks if X changes
    graphify god-nodes --top 20                # the architectural hubs
    graphify-out/GRAPH_REPORT.md               # community map of the codebase (labels = hub node names)

**Keep it current — every build updates it.** After shipping a round (or any merge to main):
`graphify update .` — incremental re-extraction of changed files, seconds, no LLM. After a refactor
that DELETES a lot of code, add `--force`. Rebuild from nothing: `graphify extract . --code-only`.

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

### Local Postgres — THE CAUSE WAS A LOCK BUG IN THE HARNESS, NOT THE CLUSTER (corrected r160)

- Data dir **`/opt/homebrew/var/aihr-pg16`** (now a SYMLINK to a RAM disk, below), binaries
  **`/opt/homebrew/opt/postgresql@16/bin`** (keg-only — PG14 shadows `psql` on PATH, use the explicit
  path or `pnpm db:start`). Port **5433**.

**⚠️ EVERY EARLIER VERSION OF THIS SECTION BLAMED THE CLUSTER, AND r160 LOST HOURS TO THAT.** The
`fsync=off` fix is real and is applied; it is simply not what was producing "false failures across files
unrelated to the change". Read this before re-tuning anything.

**THE ACTUAL BUG: `resetDb()`'s TRUNCATE had no `lock_timeout`, and TWO connection pools sit on every
worker database** — `owner` (test/harness.ts, which issues the TRUNCATE) and the application's own pool
(db/client.ts) used by every `withTenant` call in the code under test. `TRUNCATE … CASCADE` takes an
AccessExclusiveLock on ~100 tables, so any app-pool connection still holding a lock from the test that
just finished blocks it — and with locks held on both sides they deadlock outright (the server log shows
"Process A waits for AccessExclusiveLock … blocked by B; B waits for RowShareLock … blocked by A").
With no timeout that wait is **unbounded**: a millisecond reset became a 15-minute hang, surfacing as
`Hook timed out in 30000ms` in `beforeEach` of whichever file drew the short straw.

**THE EVIDENCE IT WAS NEVER THE CODE, and the shape to look for next time:** one chunk of 194 files
produced 17 failures across 9 unrelated files — 7 hook timeouts, 3 TRUNCATE errors, and **ZERO assertion
failures**. Another 194 files of the same commit passed 194/194 in 136s. After the fix the first chunk
went **1170s → 149s and green**. *If a red gate contains no assertion failures, suspect the harness.*

Fixed in `test/harness.ts`: `lock_timeout = 5s` plus a bounded retry, inside ONE transaction (`SET LOCAL`
is meaningless outside one, and with a pool a bare `SET` can land on a different connection than the
TRUNCATE; a `;`-joined multi-statement does not work either, because drizzle's `execute` uses the
extended protocol). The last attempt terminates other backends on the database. **Deliberately NOT a
raised hook timeout** — that hides the wait and keeps such runs 15 minutes long.

**WAL: the second, genuinely separate problem — and `min_wal_size` is the setting that mattered.** Every
checkpoint in this repo's history reported `N removed, 0 recycled`. `removed` = unlinked; `recycled` =
renamed and reused. PostgreSQL only keeps segments for reuse up to `min_wal_size`, which was **128MB**,
so this workload unlinked essentially every segment it produced. Checkpoint `total` tracked segments
removed (~8s each on disk) while `write` stayed flat at ~3s and `sync` was ~0 — so slow checkpoints let
WAL grow, which meant more to unlink. **The old advice here to make `max_wal_size`/`min_wal_size`
SMALLER was backwards**: a smaller `min_wal_size` unlinks more.

`./scripts/dev-db-rebuild.sh` now: puts the data directory on an **8GB RAM disk** (mounted at
`<DATA>-ram` with `<DATA>` a symlink, because `initdb` refuses a mount point as PGDATA), sets
`min_wal_size = 3GB` so segments RECYCLE, and keeps `fsync=off` and friends. Opt out with
`AIHR_RAMDISK_GB=0`. **A RAM disk does not survive a reboot — re-run the script.**

**THE SUITE STILL GENERATES MORE WAL THAN THIS MACHINE RETIRES IN REAL TIME** (~10GB per full run), so
`./scripts/gate-chunked.sh` runs it in 3 chunks, rebuilding the cluster between each, and no chunk gets
past ~73% of the volume. It covers **586 files — both vitest projects** (`test/**/*.test.ts` +
`test/**/*.dom.test.tsx`) and asserts that vitest COUNTED as many files as it was asked to run, because
a file whose worker fails to spawn is not counted at all and reads as green. The real cure is in the
harness — a ~100-table TRUNCATE per test file where `CREATE DATABASE … TEMPLATE` would write a fraction
of the WAL — and that is worth doing deliberately, not at the end of a release.

**Apex One** real-time scanning of the data directory was excluded by the owner on 2026-08-04 and that
exclusion should stay; the ~8s-per-unlink cost measured on disk is consistent with it not covering
everything. The RAM disk sidesteps the question entirely.

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
   | 6 | **steps 1–5 done** (r102/r103/r110/r111/r115). Remaining: sweep reports for one-jurisdiction assumptions · per-country subtotals + mixed-currency refusal · the deploy-failing flip (**confirm first**) |
   | 7 | **PARTLY BUILT — the old "appears in zero files" note was STALE.** `core/platform-usage.ts` (148 lines), `test/platform-plane.test.ts` (203) and the `ai_hr_platform` role definition in `deploy/bootstrap-db.sql` all exist. **But the role does NOT exist on production** (only `ai_hr_app`) — written, never provisioned |
   | 8 | **PARTLY BUILT — also stale.** `core/audit-chain-arming.ts` (90 lines) exists, and it documents a real hazard: **DISARMING THE CHAIN IS NEITHER REVERSIBLE NOR VISIBLE.** Events appended while the gate is off carry `chain_seq IS NULL`, so they are ABSENT from the chain rather than breaking it; re-arming links onto the last chained event, every `prev_hash` matches, and `verifyTenantChain()` returns valid over a log with an unprotected hole — the DPO surface renders a green "intact". Decide whether that gate should be removable at all |
   | 9 | **mostly done** (r104/r105/r108/r109). Remaining: CLOSURE (dual-controlled, own retention check) · REACTIVATION (suspended window excluded from expiry clocks) |
   | 10 | **THE METER HAS RUN EXACTLY ONCE.** Verified 2026-08-05: `usage_snapshot` holds **8 rows, all dated 2026-08-02** — one distinct day. **`usage:capture` IS NOT IN THE CRONTAB.** Usage CANNOT be backfilled, so every unscheduled day is permanently unbillable and the count grows daily. One crontab line fixes it (suggested 01:00, ahead of the 02:00/03:00 leave sweeps so it meters the day before they mutate it). The dashboard that reads it is also unbuilt |
   Slice 9's enforcement is inert in production today (both tenants `active`); `apply-dunning` is
   report-only and unscheduled.
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

**Nothing is in flight.** r159 shipped and is verified on production; the 2026-08-05 planning pass
after it wrote NO code — it pushed six plans and this snapshot, nothing more. Both pre-planning checks
were run first and both were clean: the dry-run rsync reported ZERO changes (production matches
`main`), and the only unmerged `build/*` branches are the three known-stale ones (`r71`, `r83`, and
`r154`, which is squashed and ancestrally unrelated). When a round is built but unshipped, its entry
goes HERE and CURRENT STATE says so; on ship it moves to the top of `docs/HANDOFF-HISTORY.md`.
**"Nothing in flight" is a claim about BRANCHES — it is not a claim that `main` has been deployed.
Prove that separately with the dry-run rsync above; r159 exists because those two were conflated.**

**Shipped round entries (r66–r159): `docs/HANDOFF-HISTORY.md`.**

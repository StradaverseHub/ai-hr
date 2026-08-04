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

## CURRENT STATE — snapshot 2026-08-04 (r137 SHIPPED)

**`main@1e737a36` is what runs. Production on 312 migrations. Next free migration number is `0386`.**
No half-applied migration, no pending deploy, nothing in flight. None of r134–r137 adds a migration.
Verified after deploy: service active, `GET /` 401, `/login` 200, `rsync --dry-run` zero changes.

### The board — counted on production 2026-08-04 after r137

**`deployed = 569` · `approved = 17` · `cancelled = 12`. `building = 0`, `open = 0`, `contested = 0`,
`planned = 0`.** Every remaining item is APPROVED and buildable — the board is waiting on us, not on
the reporter, for the first time. `improve:pull` returns ONLY open+contested and hides `building`
(that is how `a1d82340` stayed invisible for a week); use `pull-approved` and the DB.

### THE 17 APPROVED ITEMS — sequenced into rounds from the plans' OWN sequencing sections

Migration numbers are pre-assigned so parallel agents cannot collide (next free `0386`).

| round | items | migration | why grouped / sequenced |
|---|---|---|---|
| r138 | `7cd914b1` + `65f466e2` | 0386, 0387 | Both edit `components/leave-type-panel.tsx` (different sections) → one agent. **Both must precede `6e9a126e`**, which rewrites those files |
| r139 | `7b5f18c3` → `1b87e8a0` | none | Both invent the same "System Settings list+detail" idiom, which **does not exist yet**. Hiring Defaults first (genuinely per-company); Movement reuses its shape and must NOT grow a company list |
| r140 | `8590615a` → `35b7af0a` | 0388 | Same two files (`personnel/[employmentId]/page.tsx`, `new/wizard.tsx`). "Land 8590615a first or it adds fields to a screen being taken apart" |
| r141 | `169e3c24` + `3c473773` | 0389 | Same display pipeline (payslip earnings buckets / transaction view). Keep `169e3c24` away from `2ef69d1e` — both edit the exact-set `EXPECTED_SET` in the nav test |
| r142 | `44129979` | none | "Do NOT build alongside `2ef69d1e` or `7f6ca478`." Lands before both |
| r143 | `7f6ca478` | none | Same reads as r142 → separate round. Only 3 statuses exist — do not invent Processing/Failed |
| r144 | `18103ba4` | none | Needed `38f1fd40` first (shipped in r137) so "Adjustments" means one thing |
| r145 | `6e122302` | 0390+ | MUST generalise `resolveAdjustmentTargets` out of `core/leave-adjustment.ts`, not copy it |
| r146 | `e7eb5d83` stage 1 | 0391 | Stage 1 only (draft + limit reservation) — the real wrong-answer bug |
| r147 | `7c834696` stage 1 | 0392+ | "Stage 1 must not share a release with any other attendance change" |
| r148+ | `6e9a126e` | 0393+ | **OWN SESSION.** Drops `benefit_scheme`, `scheme_leave_entitlement`, `leave_policy` |
| r149 | `93249794` | TBD | Waits on `6e9a126e`'s eligibility layer, else you build a second criteria engine |
| r150 | `2ef69d1e` | TBD | Largest on the board, ship LAST. Pass 2 after `7c834696` |

- **`6e9a126e` IS THE BIG ONE.** Its approved plan stages it across three releases. It deserves a
  session of its own, not the tail of one. **Its rev-3 claim that "all line numbers were re-verified"
  was FALSE at HEAD — re-locate every anchor by symbol.**
- **`3c473773` alleges a LIVE payroll calculation fault** (overtime pay-item classification +
  employer-borne statutory contributions), raised off a real verification against employee `X000001`.
  Its own plan finds the employer-borne CALCULATION is correct and only the DISCLOSURE is missing —
  resist "fixing" the arithmetic.

### Production measurements that change plans (taken 2026-08-04)

- **`7cd914b1`'s data migration is a NO-OP — RE-CONFIRMED 2026-08-04 after r137**: rows with
  `carry_forward_percent > 0 AND carry_forward_max > 0` = ZERO (only ANNUAL holds a cap, 10.00, and it
  carries no percentage). Say so plainly rather than quietly shipping it. The reporter also narrowed
  it: no Carry cap (days) when the option is percentage-of-remaining-balance; keep the carry expiry
  boxes.
- **`8590615a` is PARTLY BUILT**: `employment.contract_end_date` already exists on production;
  `contract_start_date` and `contract_remark` do not. Only 2 live contract employments, both lacking
  an end date. **`employment_type` lives on `assignment`, NOT `employment`** — a query against
  `employment.employment_type` errors.
- **`65f466e2`**: there is NO entitlement validation on emergency leave. `core/leave.ts:1844`
  hardcodes `EMERGENCY_LEAVE_CODE = 'EMERGENCY'`; production's type is **`EL`**, already deducting
  from ANNUAL, so the lookup at `:2479` returns nothing and `:2481` throws before any entitlement is
  consulted. The same defect silently kills `REPLACEMENT`, `MATERNITY`, `PATERNITY` (production has
  `RL`, `MTL`, `PTL`) — so Emergency Leave is subject to the minimum-advance-notice rule it exists to
  bypass (`:3155`), and `LOCKED_CODES` (`core/admin.ts:3997`) does not lock the statutory types.
  **All anchors re-located by symbol 2026-08-04; the plan's numbers had drifted by 5–35 lines.**
- **`c459bff9`'s reject-path fork is MOOT**: `expireAgedLeave` has forfeited **0 rows / 0 days,
  ever** (only RL has expiry configured). Do not put that fork to the reporter again. Real split of
  the 54 `sys:` adjustment rows: `carry_forward_cap` 14/−550.67 · `profile_recalc` 13/−738.00 ·
  `a2c_recalc` 8/−25.67 · `policy_recalc` 19/−26.33. And deleting `scripts/expire-aged-leave.ts`
  without first removing its `30 3 * * *` crontab line leaves cron firing at a missing file.
- **Five of the eleven items planned 2026-08-04 reported something DIFFERENT from what was actually
  wrong** (`65f466e2`, `b1f984fe`, `44129979`, `7f6ca478`/`1b87e8a0`/`18103ba4` asked for payroll
  statuses/columns that do not exist as data — `payrollStatusEnum` is `['draft','processed','closed']`
  and generation is synchronous, so a failed run leaves NOTHING to display). **Reproduce on production
  BEFORE agreeing a plan's premise.**

### Two open items awaiting the OWNER (raised by r123, both live findings)

- **`2e3ec77d` — a LIVE bug**: the advanced statutory editor silently strips the disabled-person tax
  relief on every save (`statutory-config-form.tsx:186-192` rebuilds `pcb.reliefs` without spreading
  the base; `payroll.ts:373` falls back to the built-in default, so the loss is invisible). Asks
  whether any company has already lost a customised figure.
- **`9861b8a4`** — `allow_negative_balance` does not bind at approval, so a balance cannot go negative
  through apply-and-approve at all. **Do not relax `core/leave.ts:3386` without the owner's answer** —
  fixing it immediately loosens every type that already has the switch on.

### Waiting on the owner, not on code

1. **`usage:capture` is the ONLY unscheduled sweep, and the gap BLEEDS** — usage cannot be
   backfilled, so every unscheduled day is permanently unbillable. Five jobs DO run via a crontab
   installed 2026-07-21: `accrue-earned` (monthly, 1st 02:00) · `review-sweep` (daily 03:00) ·
   `expire-aged-leave` (daily 03:30) · `expire-carry` (yearly, 1 Apr 03:00) · `provision-runner`
   (every minute). **Verify with `crontab -l` as `ubuntu`, NOT `systemctl list-timers`** (no timers
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
- **`c33d9bbb` is PARKED BY THE OWNER** (2026-07-31). It stays `contested` because the board has no
  defer state. Writing a rev 2 would re-open a settled decision.
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

**Before planning ANYTHING, check for an unshipped round** — r86 was 13 finished items sitting
unmerged while `main` stood at r85, and a finished round nobody shipped looks exactly like no round:

    for b in $(git branch --list 'build/*' | tr -d ' *'); do \
      n=$(git log --oneline main..$b | wc -l | tr -d ' '); \
      [ "$n" != 0 ] && echo "$b: $n unmerged"; done

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

### Local Postgres (16.14)

- Data dir **`/opt/homebrew/var/aihr-pg16`**, binaries **`/opt/homebrew/opt/postgresql@16/bin`**
  (keg-only — PG14 still shadows `psql` on PATH, use the explicit path or `pnpm db:start`/`db:stop`).
  Port **5433**. Production has always been 16.14; local matched it at r97.
- **Apex One (Trend Micro) was real-time scanning the data directory until 2026-08-04**, when the
  owner excluded the path. Measured: cluster start 10+ min → **<1 s**; full suite 2848 s with 98 fake
  failures → **761 s, all green**. Most historical "wedge" lore predates the exclusion — check the
  exclusion still stands before diagnosing slowness.
- **The teardown checkpoint stall is real but NOT understood.** Two root-cause claims (Apex One,
  `pkill -9` during teardown) were both DISPROVEN, and r137 measured one "wedge" completing on its own
  after ~1 hour — "wedged" was never actually established as permanent. Do not write a third
  diagnosis without evidence that survives the next occurrence. What is established: vitest's
  teardown DROPs its worker DBs; `DROP DATABASE` forces an immediate checkpoint; that checkpoint
  sometimes stalls (signature: `checkpoint starting` with no `checkpoint complete`,
  `pg_stat_bgwriter` counters frozen, checkpointer burning 15–27% CPU) while the cluster serves
  ordinary connections but refuses every CREATE/DROP DATABASE — hence `CONNECT_TIMEOUT` from a
  cluster `psql` calls fine.
- **The working response:** results are FINAL at the log's `Duration` line — read them; teardown only
  frees databases. If you need the database sooner, **rebuild** (recipe below, under a minute) rather
  than waiting or killing. Never `pkill -9` (an interrupted drop cannot help). `.claude/gate-watch.sh`
  reports at 900 s.
- **Rebuild recipe** (everything local is disposable — dev + test DBs):

      PG16=/opt/homebrew/opt/postgresql@16/bin
      $PG16/pg_ctl -D /opt/homebrew/var/aihr-pg16 -m immediate stop   # -m fast cannot stop a checkpoint stall
      mv /opt/homebrew/var/aihr-pg16 /opt/homebrew/var/aihr-pg16.wedged-$(date +%H%M)   # mv, not rm -rf
      $PG16/initdb -U postgres -D /opt/homebrew/var/aihr-pg16 --encoding=UTF8 --locale=en_US.UTF-8
      # append to postgresql.conf: max_wal_size = 4GB / checkpoint_timeout = 30min
      $PG16/pg_ctl -D /opt/homebrew/var/aihr-pg16 -o "-p 5433" -l <log> start
      psql -p 5433 -U postgres -d postgres \
        -c "CREATE ROLE ai_hr_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;" \
        -c "CREATE DATABASE ai_hr_dev OWNER ai_hr_app;" \
        -c "CREATE DATABASE ai_hr_test OWNER ai_hr_app;"

  **`NOBYPASSRLS` is the detail that costs an hour** — a superuser `ai_hr_app` bypasses RLS and ~18
  tests fail in a way that reads as a security regression in the code. Authority:
  `deploy/bootstrap-db.sql`. The `.wedged-*` directories in `/opt/homebrew/var/` are disposable.
- **WAL bloat degrades a long session**: after ~5 full suites `pg_wal` reaches GBs and `resetDb()`
  starts LOSING deadlock races. Symptom: ONE unrelated file fails with 22–27 hook timeouts and passes
  in isolation; the buried error is `TRUNCATE … deadlock detected`. The tell is printed every run:
  `global-setup` timing drifting from 3–10 s toward 18–24 s. **Rebuild the cluster; do not conclude
  "flaky test".**

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
  namespace, and only matches LITERAL keys — `t(helperReturningKey(x))` is invisible. Prefer one
  namespace per file; for computed keys, test every value the helper can return.
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
   | 7 | **NOT BUILT** (`ai_hr_platform` appears in zero files) |
   | 8 | **NOT BUILT** (audit chain still env + gate script) |
   | 9 | **mostly done** (r104/r105/r108/r109). Remaining: CLOSURE (dual-controlled, own retention check) · REACTIVATION (suspended window excluded from expiry clocks) |
   | 10 | **meter shipped r113, verified against production.** Remaining: the dashboard · scheduling the sweep (owner decision) |
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

**Nothing is in flight.** When a round is built but unshipped, its entry goes HERE and
CURRENT STATE says so; on ship it moves to the top of `docs/HANDOFF-HISTORY.md`.

**Shipped round entries (r66–r137): `docs/HANDOFF-HISTORY.md`.**

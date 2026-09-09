<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Standing orders — read before doing anything in this repo

**Orient first.** The canonical handoff is `.claude/worktrees/mainwt/HANDOFF.md` — read its CURRENT
STATE before planning or building anything. It is a snapshot, not a log; keep it that way when you
update it (replace stale lines, move shipped round entries to `docs/HANDOFF-HISTORY.md`, keep it
under ~700 lines). A round is not finished until HANDOFF.md records it.

**Understand code through the graph, not by grepping cold.** `.claude/worktrees/mainwt/graphify-out/`
is a queryable knowledge graph of the whole codebase (run commands from mainwt):
`graphify explain "<symbol>"` (every caller/import with file:line) · `graphify query "<question>"` ·
`graphify path "A" "B"` · `graphify affected "X"` (reverse impact) · `graphify god-nodes`.
**Every build must refresh it**: `graphify update .` in mainwt after any merge to main (seconds, no
LLM; `--force` after big deletions). Details in HANDOFF.md → "The code graph".

**Which tree you are on** — the repo ROOT is a scratch worktree on `local/root-scratch`, far behind
main. **`main` lives at `.claude/worktrees/mainwt`.** Put `cd .../mainwt &&` in EVERY command, including
read-only greps: the shell's cwd resets between tool calls. Check `pwd`/branch in every gate command and
read vitest's `RUN` line + file count; a gate in the wrong tree reports green for the wrong code, and a
GREP in the wrong tree silently answers about code from weeks ago. **This has now landed five times** —
most recently on 2026-08-19, when a run of cold greps against the root scratch tree concluded that
`individual-payslip`, `pcb-detail` and `cp39` did not exist, and an investigation was written on it
before the contradiction between `git cat-file -e main:<path>` (exists) and `ls` (does not) gave it away.
Never let `isolation: 'worktree'` cut an agent's tree from the root HEAD — create worktrees from `main`
yourself, with an ABSOLUTE path (rule 24).

**The mistakes this repo keeps re-making** (details in HANDOFF.md → Environment/Traps). Rules 13-22
were added on 2026-08-12/13, 23-28 on 2026-08-20 and 10b + 28b + 29-31 on 2026-08-21, each after it cost
a real round:

1. **One vitest at a time.** A second run wipes the first's worker DBs. Parallel agents get their own
   `TEST_DB_NAMESPACE`; otherwise never invent one.
2. **Long commands: `> file 2>&1`, never a pipe.** Undrained pipes hang forever; exit codes read
   through a pipe are the last command's.
3. **"Is it stuck?" — grep the log for `Duration`, never read the process list.** vitest often does
   not exit after reporting; a finished run and a hung one look identical in `ps`. And never
   `pgrep -f` a string your own waiter contains.
4. **Read vitest's exit code AND file count**, not just the summary — a file whose worker fails to
   spawn is not counted at all.
5. **A migration is a journal entry, not a `.sql` file.** Allocate numbers centrally (agents all pick
   the same next one); before merging a held branch check its journal `when` against the deployed
   watermark (stale = silent skip); a CREATE TABLE migration must also GRANT.
6. **A 200 is not a render check.** `MISSING_MESSAGE` and RSC boundary bugs pass tsc, the suite,
   `next build` and return 200 — render the page on a dev server and read the dev log.
7. **Reproduce on production before agreeing a ticket's premise.** Check already-built → mislabelled
   → adjacent screen → diagnosis inverted → wider than reported, before "absent". Repeatedly, the
   reported fault was not the real one.
8. **The deploy rsync DOES carry `--delete`** (release.ts:71; verified r137 — corrected from an older
   note here that said it did not). Keep it in any hand-rolled rsync; excluded paths like
   `.env.production` are protected from deletion. Proof of arrival is a zero-change
   `rsync -azi --dry-run`, not `deploy.sh` succeeding.
9. **Board plans are plain text, one course of action** — approve carries no payload, so a plan that
   asks the reporter to choose can never be answered. Use the `feedback-plan` skill.
10. **The Postgres wedge is FIXED (2026-08-05) — don't re-diagnose it.** `DROP DATABASE` forces an
    immediate checkpoint that fsyncs everything; `fsync=off` on this disposable cluster took four
    CREATE/DROP from >5 minutes to 0.47s. If the cluster ever misbehaves, run
    `./scripts/dev-db-rebuild.sh` (<1 min, applies the settings and the `NOBYPASSRLS` role) rather
    than waiting, killing, or theorising.
    **10b (r218) — A KILLED GATE POISONS EVERY LATER RUN, AND THE RESULT READS AS A CODE FAILURE.**
    Interrupting `gate-chunked.sh` between `dev-db-rebuild.sh`'s `rm -f $DATA` and its `ln -s` leaves a
    SELF-REFERENTIAL symlink — `<ramdisk>/data/data → <ramdisk>/data` — so the data directory is never
    empty again and every later `initdb` dies with "exists but is not empty". The gate prints
    `cluster rebuild FAILED` and **then runs the chunk against the STALE cluster anyway**: 48 failures,
    ZERO AssertionErrors, 107 `does not exist`. `grep "rebuild FAILED"` before believing a red, then
    `rm -f <ramdisk>/data/data` and re-run the rebuild script. **Start a gate with the harness's own
    background flag, NEVER a bare `&`** — a `&` job dies with the tool call that spawned it, which is
    what caused this.
11. **COMMIT A WIP CHECKPOINT BEFORE ANY COMMAND THAT CAN UNDO A FILE.** Two agents lost work this way
    on 2026-08-05, by different mechanisms with one cause — uncommitted work has no undo.
    - `git stash` is REPO-GLOBAL, not per-worktree: an agent ran `git stash pop` and got a DIFFERENT
      agent's stash into its tree (restored via `git stash store`, but the two worktrees were one
      command away from silently mixing uncommitted work).
    - `git checkout -- <file>` reverts to **HEAD, not to your working state**. r154 used it to undo
      each mutation in a watched-fail script and destroyed a whole release's uncommitted edits to
      three core files on the FIRST run. Revert a deliberate mutation from a `cp` copy taken up front.
    `git commit` is per-branch and cannot collide. Checkpoint first, then experiment.
11b. **DO NOT REWRITE A COMMIT ANOTHER AGENT MAY ALREADY HAVE INTEGRATED.** r154 squashed two commits
    with `git reset --soft` after the integrator had already merged them; the trees were identical so
    nothing was lost, but the branch and its integrated copy stopped being ancestrally related. Once
    you have pushed work an integrator can see, only ADD commits.
12. **NEVER run an agent and a gate against the same cluster at once.** Twice in one session that
    bloated WAL to 5GB and produced 32 false failures across files unrelated to the change. Agents
    run only their own targeted tests; the parent runs the single full gate, alone. **This recurred on
    2026-08-12 because the PARENT briefed planning agents to render on dev servers mid-gate** — three
    chunks came back red with ZERO `AssertionError`s and ~187s timeouts. Diagnose with a per-chunk
    cause tally, and read `/tmp/aihr-gate/chunkN.log` — the summary the gate prints carries counts only,
    so grepping IT for `AssertionError` finds nothing and invites "it was all environmental".
13. **`deploy.sh` RUNS MIGRATIONS, NOT SCRIPTS.** r189's live-risk fix was half-armed until a backfill
    script was run BY HAND after the deploy. If a round's fix depends on a script, the round is not
    finished when `deploy.sh` returns — run it, and verify the rows it writes.
14. **CENTRAL MIGRATION ALLOCATION IS NOT ENOUGH — MERGE ORDER CAN STILL SILENTLY SKIP ONE.** Handing
    each parallel agent a number fixes its `when` BY NUMBER while leaving merge/deploy order free, and
    drizzle's watermark is the last applied `when`. On 2026-08-12 `0433` went first on a shared cluster
    and silently skipped `0430` and `0432` — exit 0, no error, no table. **They must reach production in
    ONE pass or strictly ascending.** `gate:shadow` cannot catch it: it dumps schema only and applies the
    whole journal in order, so it passes either way — and for the same reason it cannot catch a migration
    whose precondition is DATA (`0426` would have aborted on one inverted row).
15. **A NEW `core/` FILE MUST IMPORT `packs/<pack>/service`, NEVER the pack's implementation.** The
    ratchet fired in THREE consecutive rounds on new `core/` files. The fix is never
    `test/pack-drift-allowlist.json` — the guard refuses additions in its own failure message because
    that list is audited debt and only shrinks. Check first for the documented comment false positive:
    the ratchet does not strip comments, so a quoted `from '…'` inside one reads as a real edge.
16. **A BACKGROUND `Bash` TASK'S EXIT CODE IS ITS LAST COMMAND'S.** `gate.sh > log; echo "EXIT=$?"; date`
    reports **`date`'s** status, so the harness said "completed (exit code 0)" over a RED gate. Read the
    real code out of the output file, never the notification. Same class as the pipe trap in rule 2.
17. **A FORM FIELD THAT IS ALWAYS SUBMITTED CANNOT BE READ BY PRESENCE.** A hidden input is sent whatever
    its value, so `fd.get(key) != null` reads an unticked box as TRUE. That shipped a pay-affecting
    setting nobody could turn off, for as long as the screen existed. It also generalises: when a defect
    lives in the CONTRACT BETWEEN two files, a unit test of either half passes throughout — pin it with
    source-shape assertions across both.
18. **A GUARD MAY PIN THE DECISION YOU ARE REVERSING — UPDATE IT, DO NOT DELETE THE CASE.** r190 reversed
    "Pay Items deliberately has no per-row Edit" on the reporter's approved instruction, and a shape guard
    asserted exactly that. Half of it was still right (no INLINE editor) and was kept; only the retired
    half moved. **Two tests asserting opposite things are invisible to targeted runs — only the full gate
    sees both.**

19. **DO NOT INTEGRATE WHILE AGENTS ARE STILL COMMITTING — A MERGED SNAPSHOT GOES STALE SILENTLY.** r191
    merged seven branches at 13:04 while a resumed workflow was still running; three more commits landed on
    two of those branches at 13:37–13:44 and **missed the release entirely**, including a real defect fix.
    Nothing complains: the merge succeeded, the gate was green, and the round looked finished.
    **A workflow reporting "N workstreams complete" is not the same as its branches being frozen** — a
    resumed or retried run spawns fresh agents that keep committing. Before merging, and again immediately
    before the final gate, run `git log --oneline main..<branch>` for EVERY branch and confirm the tip is
    what you merged. Recording the tip SHA per branch at merge time is what makes that check meaningful.
19b. **AUDIT MERGED `messages/*.json` BASE-AWARE — but compare against the side you MERGED, not the branch's
    current HEAD.** `i18n-check.mjs` answers "is the key there?" (parity + placeholders), never "is the value
    the one someone chose", so a stale VALUE passes it. A base-aware diff (base vs merged vs every side)
    catches that, and it is what caught r191's stale `payroll.cp22.monthHint` — a hint describing a form
    field the same round had deleted. **But read the verdict carefully: r191's audit said CLOBBERED and the
    round wrote it up as a hunk-granularity merge fault, which was WRONG.** Re-checked against the merge
    commits, the value was the base value at every single merge including that branch's own — the branch had
    simply moved on since (rule 19). Same root as the presence-is-a-value trap: consult the base for absence
    AND for the old value — and consult the right side.
20. **A NEW GUARDED `page.tsx` NEEDS A COLUMN IN THE FUNCTION-ACCESS MATRIX** (`lib/permissions.ts`), or
    `test/function-access.test.ts`'s reverse-completeness case fails — the route becomes a screen nobody can
    grant or revoke. Attach it to an EXISTING screen key where one fits (the screen that links to it) and
    forward completeness is already satisfied. Route handlers (`route.ts`) are not pages and are not listed.
    **The branch that adds the page cannot see this** — 18 test files read that registry across the suite,
    so only the full gate catches it, and a targeted re-run after fixing it is not trustworthy.

21. **`node --env-file=` CANNOT RUN ON THE SERVER — the box is node v18.19.1 and that flag arrived in
    node 20.** It exits 9 with `bad option: --env-file`. **23 scripts in `scripts/` document exactly that
    invocation** for production, and not one of them works as written. Run them by sourcing instead, which
    also keeps credentials on the box:
    `cd /opt/ai-hr && set -a && . ./.env.production && set +a && node --import tsx scripts/<x>.ts`
    This compounds rule 13: the round is not finished until the script has RUN, and the command the script
    itself documents will fail on the only machine that can run it.
22. **THE MIGRATION JOURNAL IS APPEND-ONLY — NEVER RE-SORT IT.** Resolving a merge conflict in
    `_journal.json` by sorting every entry on `when` breaks the *other* invariant: idx 240 shares its
    `when` with 220 and sits below 230's, so sorting relocates it and
    `test/migration-journal-ordering.test.ts`'s "strictly ascending idx" case fails. That 240/230 inversion
    is deliberate and GRANDFATHERED (`GRANDFATHERED_NON_ASCENDING`) because both shipped in one R44 deploy
    and re-stamping an applied migration would desync every migrated database's `created_at`. Keep the
    existing order and APPEND. And when several branches each add a migration, resolve the conflict as the
    UNION — taking either side DROPS a migration, leaving a `.sql` with no journal entry, which never runs
    and reports nothing.

23. **A GREEN GATE AND GREEN TARGETED TESTS ARE NOT EVIDENCE THE WORK IS RIGHT. THE ADVERSARIAL VERIFY IS
    THE LOAD-BEARING STEP.** r209 built eleven items as seven workstreams; ALL SEVEN reported tsc-clean
    and test-green, and the verify pass then found **19 majors, 13 of them introduced by the build
    itself** — a payroll figure that silently deleted money, a statutory form printing RM 0.00 for money
    it printed elsewhere, a health card reporting green for a leave type the engine granted to nobody.
    A gate would have shipped every one. **Brief the verifier to RE-DERIVE the builder's non-vacuity
    claim itself** (revert the fix from a `cp` copy, watch the named assertion fail) rather than trust
    the report — that instruction is what finds defects the builder sincerely believed it had tested.
    Budget for it: verification took as long as building, and was worth more.

23b. **ONE FIX PASS, THEN HAND-FIX.** A second agent pass on the same code is where this repo goes
    backwards — r197-r199 and r201 each made a workstream WORSE that way. Send the verify findings back
    once, with "fix the defect, not the test; decline anything you disagree with rather than change code
    you do not believe in"; hand-fix whatever the recheck still reports. Anything money-affecting is
    hand-fixed on the first pass, not delegated.

24. **CREATE WORKTREES WITH AN ABSOLUTE PATH, AND NEVER READ A CLEAN RESULT OUT OF A `git -C` YOU HAVE
    NOT CONFIRMED EXISTS.** `git worktree add .claude/worktrees/x` run from mainwt NESTS them at
    `mainwt/.claude/worktrees/x`, so briefs quoting the flat path are wrong. Worse, `git -C <missing dir>
    status --short | wc -l` prints **0** — indistinguishable from "clean" — which is how r209 believed
    two workstreams had written nothing for an hour. Same family as the wrong-tree trap, which has now
    landed FIVE times: the tell is a contradiction between `git cat-file -e main:<path>` and `ls`.

25. **A FRESH WORKTREE HAS NO `.env.local`** (it is gitignored), and vitest dies with
    `TEST_MIGRATION_DATABASE_URL must be set` in global-setup **before running a single test** — which
    reads like a broken harness, not a missing file. Copy it in when you create the worktree, along with
    the `node_modules` symlink.

26. **`pnpm improve:push-plan` EXITS NON-ZERO ON SUCCESS** — pnpm raises ELIFECYCLE over the SSH client's
    stderr noise while the plan pushes fine. Grep the output for `pushed plan`, never the exit code
    (same family as rules 2 and 16). And drive it ONE ITEM AT A TIME: a `while read` loop around it
    pushed only the first of seven while reporting failure for all seven.

27. **SOURCE-SCANNING GUARDS DO NOT STRIP COMMENTS.** Documented for the pack-drift ratchet; it is
    general. r209's fix for the UTC-date guard failed THAT SAME GUARD because the explanatory comment
    spelled the forbidden expression out. Reword the comment — do NOT add a source file to the guard's
    quote-allowlist, which exists for the guards themselves.

28. **NEVER PRINT A FIGURE OR AN ASSURANCE ON A STATUTORY DOCUMENT THAT YOU CANNOT STAND BEHIND. AN
    ABSENT BOX ASSERTS NOTHING; A BOX READING 0.00 ASSERTS THE MONEY DOES NOT EXIST.** Twice in r209, on
    two different forms. The EA gained manual Part B boxes drawn at their derived value — always 0, since
    only an `ea_override` writes them — so a director paid RM 48,000 in commission got "Fees (incl.
    director's fees) RM 0.00" beside an Allowances figure carrying it, on a C.P.8A. The CP39 gained a
    printed sentence asserting the row count matched Bilangan Pekerja, which is false whenever the PCB
    and CP38 sets differ. **Adding a box or a caption can make a form WORSE than the gap it filled** —
    incomplete becomes affirmatively false, and on a tax document that is the more expensive failure.

28b. **AND NEVER ASSERT A FACT ABOUT AN AGENCY YOU CANNOT SOURCE — INCLUDING BY MOVING A FORM INTO A
    STATUS WHOSE SHARED WORDING ALREADY ASSERTS ONE.** r218 reworded the CP39's provenance notice to say
    "because LHDN publishes no blank one to print onto" in six locales. Nothing supports it; LHDN's own
    specimen carries "Borang ini boleh difotokopi". The claim is true and sourced for PERKESO and KWSP,
    where it lives in their own modules. Worse, promoting `my.cp39` into `agency-layout` put the SAME
    unsourced claim onto the shared status chip and the vocabulary definition — **a shared string acquires
    a new subject the moment a new member joins the set, and nothing warns you.** So: a shared caption may
    only say what is true of EVERY member and checkable from this repository ("WE hold no blank" —
    `public/forms` answers that); anything stronger belongs in the one form's own module beside its
    evidence. When you promote a form into a status, re-read every string that status renders.

29. **DIFF THE APPROVED PLAN AGAINST THE BRIEF BEFORE YOU LAUNCH AN AGENT.** r218's plan told the reporter,
    in its build notes, that the verification WAS the deliverable — generate their own file from production
    and compare it character by character. The brief the parent then wrote listed five other things and not
    that one. The agent said so in `notBuilt` instead of quietly skipping it, which is the only reason it
    happened at all — and it changed the round's answer completely. **A plan is a promise to the reporter;
    a brief is an instruction to an agent, and nothing checks that the second contains the first.** Read
    them side by side, and brief every agent to report what it did NOT do.

30. **CHECK THE ITEM'S ATTACHMENTS BEFORE RECORDING SOMETHING AS UNOBTAINABLE.** Two rounds of `lib/cp39-form-pdf.ts`
    said the LHDN masthead and the A / B / C panels could not be drawn because no legible specimen existed
    in this repository. It had been sitting on the board the whole time — inside a `.docx` attachment, as
    `word/media/image2.png`, a full CP39 Pin.2015 at 1212x829. `unzip` the attachment and look. This is
    rule 7's family: verify the premise, including your own file's stated blocker, before repeating it.
    Attachments live in `feedback_attachment`; pull one with
    `psql -tAc "select encode(content,'base64') from feedback_attachment where id='…'" | base64 -d`.

31. **WHEN A VERIFICATION CONTRADICTS SOMETHING YOU HAVE ALREADY TOLD THE REPORTER, SAY SO IN PLAIN WORDS.**
    r218's pushed plan told them their pasted example "does not come from your file". Generating the file
    from production showed it was our record 1, verbatim, with the runs of spaces collapsed by whatever
    they pasted it into. The board has no edit-in-place for a plan already approved (pushing one resets the
    status), so the correction goes in the item you raise back to them — `68147833` carries it — and it
    goes near the TOP, not buried under the good news.

32. **PIN THE INVARIANT, NEVER THE TAIL — A TEST THAT ASSERTS A POSITION IS A TIME BOMB WITH A FUSE THE
    NEXT ROUND LIGHTS.** r254 asserted its migration was the LAST journal entry; `0457` broke it in r256,
    producing one AssertionError on a chunk of completely correct code and costing a full re-gate. The
    fix is not a bigger number — assert what is actually true forever (the entry EXISTS; everything
    before it has a lower idx, everything after a higher one). Same shape anywhere you are tempted by
    `[length - 1]`, "the newest row", or "the last commit".

33. **A COUNT TAKEN THROUGH RLS IS NOT A ROW COUNT.** `select count(*) from shift` as the APP role with
    no tenant context returns **0** on a table holding 11 rows — indistinguishable from an empty table,
    and it will happily talk you out of a migration that matters. Read production facts through
    `MIGRATION_DATABASE_URL`, and treat a suspiciously empty answer as a question about your session,
    not about the data. Same family as rule 24's `git -C <missing dir>` printing 0.

34. **VITE'S DEP SCANNER IS STATIC, SO A DYNAMIC IMPORT IN A BROWSER TEST DUPLICATES REACT — AND THE
    ERROR BLAMES AN INNOCENT LIBRARY.** A test that must reach a component through `await import(...)`
    (to land a `vi.mock` before a module opens a DB connection) hides that component's whole import
    graph. Those deps get discovered at RUNTIME, forcing a second optimize pass and a second copy of
    React; react-dom then installs the hook dispatcher on one copy while the component reads the other,
    and you get `Cannot read properties of null (reading 'useContext')` thrown from inside lucide-react.
    On a COLD cache it is worse — every browser file fails to import ("Vite unexpectedly reloaded a
    test") and the suite reports red having run **zero** assertions. `resolve.dedupe` plus
    `optimizeDeps.include` in `vitest.browser.config.ts`; anything a browser test reaches only
    dynamically belongs in that list. **And check that a new test's assertions ever EXECUTED** — these
    nine had never run once.

**Deploy is automatic after a green gate** (owner's standing override of ADR-0045): tsc → full suite
→ `next build` → rehearsal (if migration) → merge → rsync → `deploy.sh` → **run any script the round
depends on** → verify → mark deployed. `GET /` returning 401 is the healthy password gate. Proof of
arrival is a zero-change `rsync -azi --dry-run`, never `deploy.sh` succeeding. Reply on Telegram when the
owner writes from Telegram.

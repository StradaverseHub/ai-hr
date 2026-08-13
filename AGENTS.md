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
main. **`main` lives at `.claude/worktrees/mainwt`.** Check `pwd`/branch in every gate command and
read vitest's `RUN` line + file count; a gate in the wrong tree reports green for the wrong code
(this has happened three times). Never let `isolation: 'worktree'` cut an agent's tree from the root
HEAD — create worktrees from `main` yourself.

**The mistakes this repo keeps re-making** (details in HANDOFF.md → Environment/Traps). Rules 13-20
were all added on 2026-08-12/13, each after it cost a real round:

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

19. **A CLEAN AUTO-MERGE OF `messages/*.json` PROVES NOTHING — AUDIT IT BASE-AWARE.** Git merges JSON by
    LINE and resolves at HUNK granularity, so a branch that edited lines *next to* a key while carrying the
    base value *for* that key silently wins, reverting the other branch's edit with **no conflict raised**.
    r191 lost a rewritten `payroll.cp22.monthHint` in all six catalogues this way, and `i18n-check.mjs`
    passed the whole time — the key was present, parity held, placeholders matched; only the TEXT was stale,
    and it described a form field the same branch had deleted. **`i18n-check` answers "is the key there?",
    never "is the value the one someone chose".** After merging two or more branches that touch `messages/`,
    diff base vs merged vs EVERY side and report RESURRECTED / LOST / CLOBBERED. Same root as the
    presence-is-a-value trap: consult the base for absence AND for the old value.
20. **A NEW GUARDED `page.tsx` NEEDS A COLUMN IN THE FUNCTION-ACCESS MATRIX** (`lib/permissions.ts`), or
    `test/function-access.test.ts`'s reverse-completeness case fails — the route becomes a screen nobody can
    grant or revoke. Attach it to an EXISTING screen key where one fits (the screen that links to it) and
    forward completeness is already satisfied. Route handlers (`route.ts`) are not pages and are not listed.
    **The branch that adds the page cannot see this** — 18 test files read that registry across the suite,
    so only the full gate catches it, and a targeted re-run after fixing it is not trustworthy.

**Deploy is automatic after a green gate** (owner's standing override of ADR-0045): tsc → full suite
→ `next build` → rehearsal (if migration) → merge → rsync → `deploy.sh` → **run any script the round
depends on** → verify → mark deployed. `GET /` returning 401 is the healthy password gate. Proof of
arrival is a zero-change `rsync -azi --dry-run`, never `deploy.sh` succeeding. Reply on Telegram when the
owner writes from Telegram.

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

**The ten mistakes this repo keeps re-making** (details in HANDOFF.md → Environment/Traps):

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
10. **Don't re-diagnose the Postgres teardown checkpoint stall.** Results are final at `Duration`;
    if you need the DB, rebuild the cluster (<1 min, recipe in HANDOFF.md) — `ai_hr_app` must be
    `NOBYPASSRLS`.

**Deploy is automatic after a green gate** (owner's standing override of ADR-0045): tsc → full suite
→ `next build` → rehearsal (if migration) → merge → rsync → `deploy.sh` → verify → mark deployed.
`GET /` returning 401 is the healthy password gate. Reply on Telegram when the owner writes from
Telegram.

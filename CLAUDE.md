# ai-hr — how to work here

The only instruction file, for Claude and Codex alike: `AGENTS.md` is a symlink to it. Never replace
the link with a copy. Live state comes from git, the server and the board (§3), never from a document.
History: `docs/HANDOFF-HISTORY.md` (rounds, newest first). Decisions: `docs/adr/`.

**Keep this file short.** A lesson learned the hard way goes into a test, a script or a lint first;
the incident story goes into the round entry. Add a line here only when no check can enforce it, and
delete a line when a check takes it over.

## 1. How to think

You are the architect and engineer for an HRIS: decide what the system should be, then build it.
Challenge weak requirements and code with evidence; an instruction reaffirmed after a challenge is
the owner's decision. Pick the smallest change that fully delivers the outcome; prefer deleting.

- **Domain rules you may never invent:** HR policy, statutory/payroll figures, legal rules, API or
  framework behaviour. Unverified means say so and say how to verify. A constant marked
  "RATE-ONLY, NOT YET VERIFIED" is not a confirmation of anything.
- **Identity:** USER ≠ PERSON ≠ EMPLOYEE ≠ EMPLOYMENT ≠ ROLE ≠ PERMISSION ≠ SCOPE. Multiple
  employments, companies, rehire and suspension must stay representable.
- **One owner per business fact.** Everything else is derived, cached or AI context.
- **AI** inherits the caller's authorization and is never a source of truth. A model proposes;
  deterministic code adjudicates; a model never raises a `block` (ADR-0084). For pay, termination,
  ratings, hiring, promotion, discipline and access a human decides. The LLM never computes money.
- **Product:** design around the user's job (My HR · My Team · Workforce Operations · Workforce
  Intelligence · System Configuration). Every page answers "what is this user deciding or doing?"
- **Done** = every requested outcome demonstrated on the real app, permissions and data integrity
  checked, and anything unverified reported as unverified. Test counts alone are not done.

## 2. Where you are

- **`main` lives in `~/Projects/ai-hr/.claude/worktrees/mainwt`.** The repo root is an old scratch
  tree; a grep there answers about weeks-old code. The shell cwd resets: `cd` explicitly every time.
- Build worktrees: create them yourself from `main` under `~/Projects/ai-hr/.claude/worktrees/`
  (never an agent's `isolation: 'worktree'`, which cuts from the scratch HEAD). Copy `.env.local`;
  give it a **real** `node_modules` (`pnpm install`, ~4 s) — a symlink breaks Next 16.3 builds.
  Do not set `turbopack.root`.
- Stack: Next.js 16 App Router (read `node_modules/next/dist/docs` before framework work), Postgres 16
  + drizzle, vitest 4, next-intl (six locales in `messages/`), WorkOS. Kernel `core/`, packs
  `packs/<pack>/` (ADR-0080), screens `app/`.
- `tsc` and `next build` need `NODE_OPTIONS=--max-old-space-size=10240` locally.
- A green result is evidence only about the tree and machine it ran on. The box is Linux x86_64 /
  node 20; this Mac is arm64 / node 22.
- `grep -a` for repo-wide searches: one source file contains a NUL byte and plain grep skips it.
- A **Codex** session also works this repo on `codex/*` branches. Ask before touching them.

## 3. Read state before planning a release

Not needed for documentation-only work. Before planning implementation or a release, run from mainwt:

    # Does production run main? Zero lines = yes.
    rsync -azi --delete --dry-run -e "ssh -p 8288 -o BatchMode=yes" --exclude node_modules \
      --exclude .next --exclude .git --exclude '.env*' --exclude .turbo --exclude coverage \
      --exclude .claude --exclude graphify-out --exclude .vitest-attachments \
      --exclude /docs/HANDOFF-HISTORY.md --exclude /docs/adr/ ./ ubuntu@203.142.6.241:/opt/ai-hr/
    IMPROVE_SSH_HOST=203.142.6.241 pnpm improve:status        # the board
    for b in $(git for-each-ref --format='%(refname:short)' refs/heads/build refs/heads/r*); do
      n=$(git rev-list --count main..$b); [ "$n" != 0 ] && echo "$b: $n unmerged"; done

Merged is not deployed; only the rsync check sees a merged-but-unshipped round.
`build/r360-security-fixes` is a known trap: its useful fixes are already in main and merging it
deletes ~62k lines. Do not merge or reinvestigate it. Before naming a round
`rN`, read the top of `docs/HANDOFF-HISTORY.md` and the `note` in `.gate-receipt.json`.

## 4. Verify, then gate once

1. **Before building:** list each requested outcome, the screens/roles it touches, and how you will
   show it works. Keep exclusions visible.
2. **While building:** run the focused tests for what changed and its consumers. A bug fix needs a test
   that fails on the old code (prove it for money, authorization and data integrity).
3. **Before the gate:** walk the changed journey on a dev server with realistic data — roles,
   empty/error states, save and reopen. Read the dev log: `MISSING_MESSAGE`, `FORMATTING_ERROR` and
   server/client boundary bugs pass tsc, tests and `next build`. A 200 is not a render check.
4. **Gate once, on the final candidate:** push the branch and mark its PR ready; CI runs the gate (below).
   Run no full suite on this Mac. Only during a GitHub outage, gate locally (ADR-0114) and release with
   the override:

       pnpm exec tsc --noEmit
       bash scripts/gate.sh > /tmp/aihr-gate-impact.log 2>&1   # read exit code and counted totals
       pnpm exec next build
       env -u MIGRATION_DATABASE_URL -u DATABASE_URL pnpm gate:shadow   # only if migrations changed

   The local gate writes `.gate-receipt.json` only for a clean tree at the exact HEAD. Never copy a
   receipt. A dev server rewrites the Next.js block at the end of this file — check `git status -s` is
   empty before gating.
5. **Report** what was demonstrated, where, and what was not verified.

Documentation-only changes need a diff, link and consistency review — no build, DB or deploy.

**CI is the release gate** (`.github/workflows/gate.yml`, GitHub Actions, private repo `zenlam/ai-hr`,
free plan): typecheck, migration order, `next build` on node 20 and the suite in 8 parallel shards. It runs
only on a **ready** pull request (drafts run nothing — every run spends plan minutes) and again on every
push to it, testing the PR's own head commit. `improve:release` ships only a commit with a green `gate`
run whose `verify` job passed; merge with `--ff-only` so `main`'s commit is the tested one. If GitHub
Actions is down, `AIHR_RELEASE_WITHOUT_CI=github-outage` falls back to the local receipt above — record
any use in the round entry. No branch protection (not on the free plan): the release check is the guard.
Everything a test needs must be installable in CI: a tool or package you installed by hand (`pdftotext`,
PyMuPDF, `mobile/`'s npm dependencies) goes into the workflow. A test may only `git show` a commit that
`main` contains — one that exists only on a local branch passes here and fails on every fresh clone.

**When the gate is red:** if the failing test and everything it imports are identical to main, it
fails on main too — suspect the environment or the **calendar** (tests seeded by calendar year).
Many failures with zero AssertionErrors mean a crashed import or a starved/rebuilt database, not code.

Test-writing rules the gate cannot catch: pin invariants, not positions (no `[length-1]`; `ORDER BY`
on any asserted query); derive dates from the clock via `todayInKualaLumpur()`; a guard that slices
source between markers must assert both markers were found (`>= 0`) and the slice is long; layout
fixes need `pnpm test:browser` (jsdom has no layout). Allowlists (`test/pack-drift-allowlist.json`)
only shrink. A new guarded `page.tsx` needs a `SCREENS` column in `lib/permissions.ts`.

Statutory documents: print no figure you cannot stand behind. An empty box asserts nothing; `0.00`
asserts the money does not exist.

## 5. Local machine

- PG16: `/opt/homebrew/opt/postgresql@16/bin`, port 5433, RAM disk, disposable. Check
  `psql -p 5433 -U postgres -tAc 'select 1'` before blaming code. Broken → `./scripts/dev-db-rebuild.sh`
  (export `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` first). Never recover, never copy its settings to a server.
- The app role is `NOBYPASSRLS`: a count without tenant context returns 0. Read facts as the migration role.
- Moved-aside clusters (`aihr-pg16.wedged-*`) fill the disk; delete their `pg_wal` first.
- **Concurrency is RAM-bound.** Every `vitest`, `tsc` and `next build` runs through
  `~/.aihr-gate-state/testlock.sh <slot> -- <cmd>`; each parallel agent gets its own `TEST_DB_NAMESPACE`,
  worktree, scratch dir and dev port. `gate.sh` holds both slots and rebuilds the cluster, so **while a
  gate runs, agents only read, write and commit.** Dispatch builders or gate, never both.
  `devdb-lock.sh` does not reap a dead holder: if everything blocks, look for one.
- A fixture script must end with `process.exit(0)`: `db/client.ts` opens a second pool at import, so
  a finished script idles forever. Zero active queries means finished, not stuck.
- `pnpm db:seed` creates no payslips and no company addresses: drive the kernel for payroll documents.

## 6. Migrations

- The journal `db/migrations/meta/_journal.json` is the migration; a `.sql` without an entry never runs.
  Append only, never re-sort, never edit an applied file.
- **Allocate the next number from `max(entries[].idx) + 1`, not `entries.length`.** A `when` below
  drizzle's watermark is skipped silently with exit 0. Parallel agents get numbers from the parent.
- A migration that creates a table must GRANT on it. Before adding a constraint to an existing table,
  list every writer (including erasure and sweeps).
- `deploy.sh` runs migrations, not scripts: a round that needs a script runs it on the box and checks rows.

## 7. Release and deploy

Deploy is automatic after a green gate (owner's standing decision). From mainwt:

1. Merge to main with `--ff-only` once the PR's CI is green (if main moved, update the branch, push, and
   let CI re-run — the merged commit must be the tested one). Push `main` to GitHub.
2. `IMPROVE_SSH_HOST=203.142.6.241 pnpm improve:release` (closes board items) or
   `pnpm improve:deploy <worktree>` (no board item). Both check CI for HEAD, rsync and run `deploy.sh`.
3. On the box: `cd /opt/ai-hr && deploy/deploy-state.sh status`. `state=ok stale_build=0` and
   `built_ref` = your HEAD → `sudo systemctl restart aihr` yourself. `stale_build=1` or a failed build →
   **never restart** (it takes production down); fix and redeploy. "died (phase: restart)" from the
   watcher is often a race — check the box before acting.
4. Prove arrival: the rsync check prints zero lines and `GET localhost:3000/` on the box returns 401.
5. Record the round (§10) and run `graphify update .`.

Server: `ssh -p 8288 ubuntu@203.142.6.241`, app `/opt/ai-hr`, no git. Run scripts with
`set -a && . ./.env.production && set +a && /opt/node20/bin/node --import tsx scripts/<x>.ts`.
`crontab -l` there is the truth about scheduled jobs.

## 8. The feedback board

Statuses: open → planned → approved → building → done → deployed; plus contested, blocked, rejected,
cancelled. Always set `IMPROVE_SSH_HOST=203.142.6.241` (the default host is LAN-only).

- Plans are plain text for a non-technical consultant: use the `feedback-plan` skill. **One course of
  action** — approve carries no payload, so a plan offering choices cannot be answered. Attach a
  rendered mockup (`pnpm mockup`) for any screen.
- Reproduce on production before accepting a ticket's premise. Check `git log --all --grep=<id>` first:
  an approved item may already be shipped (then `mark-deployed`, don't rebuild).
- `push-plan` deletes the contest wording: quote it in the plan's opening paragraph.
- Pushing a plan onto a deployed item resets it to planned; `raise` a new item instead.
- Run `build-start` right after the builder has read its plan (`pull-approved` only returns `approved`
  items), so the board never shows `approved` for work in progress.
- Reply on Telegram when the owner writes from Telegram.

## 9. Subagents and git

- The parent creates worktrees, allocates migration numbers, keeps agents on disjoint files and runs
  the final gate alone. Agents commit on their own branch: never amend, rebase or `git stash`.
- Builders report green over real defects. Verify independently against the acceptance list, not the
  builder's tests; for money, fix by hand. Verify your own raised items and briefs the same way.
- Before merging, `git log --oneline main..<branch>` for every branch; read the uncommitted diff of
  any agent you stopped. Merging `messages/*.json`: consult the merge base, or deletions come back.
- After changing behaviour, grep `messages/`, comments and test names for sentences describing the old
  rule. Retire message keys, don't delete them; grep computed keys (`` t(`prefix.${x}`) ``) too.
- Code graph: `graphify explain|query|path|affected` in mainwt before grepping cold.

## 10. Recording a round

Prepend one entry to `docs/HANDOFF-HISTORY.md`: round id and date, `main@sha`, migration, items
closed, decisions the tickets didn't settle, corrections owed to the reporter, and what was NOT done.
A decision that binds future work becomes an ADR.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

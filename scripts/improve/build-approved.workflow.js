/**
 * Build phase (ADR-0045, IL-4). Given the APPROVED feedback items (from `improve:pull-approved`, passed as
 * `args`), build each one's plan in an isolated git worktree, gate on `tsc` + the tests it touches, and
 * return a green-verified patch per item. Returns artifacts only — it NEVER touches the server and NEVER
 * releases.
 *
 * Invoke:  Workflow({ scriptPath: 'scripts/improve/build-approved.workflow.js', args: <pull-approved array> })
 *   → [{ id, tenantId, reporterEmploymentId, title, testsPass, patch, diffstat, summary, blockers }]
 * The operator then (per green item): mark build-start/-complete on the server, apply the patch to a preview
 * worktree, preview it, and — only after a human approves — `improve:release`.
 *
 * SPEED NOTES (measured on a real 7-item run, see the audit that motivated this rewrite):
 *  - Items now flow through Triage → Build as a pipeline (no barrier), so the runtime's own per-workflow
 *    concurrency cap governs how many build sooner in parallel. The old version awaited each build in a
 *    strict `for` loop; the comment justifying that said a *shared* test database would race, but each
 *    build already provisions its OWN uniquely-named isolated database — that race no longer exists, so
 *    serializing was leaving real concurrency on the table. (First run under this version: watch for
 *    Postgres connection/CPU contention if several `pnpm build`s land at once — that's a resource-limit
 *    concern, not a correctness one, and is worth confirming empirically.)
 *  - A one-time Prepare step migrates a golden template database that every build clones via
 *    `CREATE DATABASE ... TEMPLATE`, instead of each build replaying all migrations from empty (measured:
 *    94s per build → ~1-2s per clone). Falls back to the old replay-from-empty path per-build if the
 *    template is missing, so a Prepare failure degrades speed, not correctness.
 *  - The per-build gate no longer runs the full suite (measured: 7.2 min of a 30 min build, ~1377 tests
 *    that mostly have nothing to do with the one feature being built). `scripts/improve/release.ts` already
 *    re-runs `tsc` + the FULL `vitest run` as its own final gate before anything ships, so nothing here
 *    trades away safety — it just stops paying the full-suite cost twice (once here, again at release).
 *  - A cheap Triage pass skips items whose OWN approved plan recommends not writing code (e.g. "close as
 *    duplicate", "needs a decision before this is buildable") — observed once in seven items in the run
 *    that prompted this: a full worktree+xhigh build agent spun up only to correctly do nothing.
 */
export const meta = {
  name: 'build-approved',
  description: 'Build each approved feedback item in an isolated worktree; gate on tsc + the tests it touches',
  phases: [
    { title: 'Prepare', detail: 'migrate a golden template database once for every build to clone' },
    { title: 'Triage', detail: 'skip items whose own approved plan says not to build' },
    { title: 'Build', detail: 'implement, typecheck, run the tests it touches — items flow independently' },
  ],
};

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    noBuildRecommended: {
      type: 'boolean',
      description:
        'true ONLY if the plan itself, not the original feedback, recommends NOT writing code right now — e.g. it closes the item as a duplicate of existing behaviour, or says a decision/clarification is needed before anything is buildable. false for any plan that gives the build team steps to implement, even a small one.',
    },
    reason: { type: 'string', description: 'One sentence, quoting or paraphrasing the plan\'s own disposition.' },
  },
  required: ['noBuildRecommended', 'reason'],
};

const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    testsPass: {
      type: 'boolean',
      description:
        'true ONLY if `tsc --noEmit` is clean, every test file you added or modified is green, AND `pnpm build` compiles. Do NOT run the full suite — release.ts re-verifies the full suite as its own final gate before anything ships, so this stage only needs to prove your own change and its own tests are sound.',
    },
    summary: { type: 'string', description: '2–3 sentences on what was built.' },
    patch: { type: 'string', description: 'Full `git diff --cached` text of the change (empty if testsPass is false).' },
    diffstat: { type: 'string', description: '`git diff --cached --stat` output.' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'If testsPass is false, the specific reasons.' },
  },
  required: ['testsPass', 'summary'],
};

const REPO = '/Users/zenlam/Projects/ai-hr';
const GOLDEN_DB = 'ahr_build_golden';
const items = (typeof args === 'string' ? JSON.parse(args || '[]') : args) || [];

function brief(fb) {
  return [
    `Type: ${fb.category ?? 'unknown'}`,
    `Title: ${fb.title ?? ''}`,
    `Description: ${fb.description ?? ''}`,
    fb.expected_behavior ? `Expected behaviour: ${fb.expected_behavior}` : '',
    fb.expected_function ? `Expected function: ${fb.expected_function}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

phase('Prepare');
await agent(
  `In ${REPO} (the main checkout, NOT a worktree — this is one-time shared setup, not a code change), ` +
    `prepare a golden migrated Postgres template database that every build in this run will clone from ` +
    `instead of replaying all migrations itself:\n` +
    `  1. psql "postgres://postgres@127.0.0.1:5433/postgres" -c "DROP DATABASE IF EXISTS ${GOLDEN_DB} WITH (FORCE);"\n` +
    `  2. psql "postgres://postgres@127.0.0.1:5433/postgres" -c "CREATE DATABASE ${GOLDEN_DB} OWNER postgres;"\n` +
    `  3. Run: MIGRATION_DATABASE_URL="postgres://postgres@127.0.0.1:5433/${GOLDEN_DB}" npx drizzle-kit migrate\n` +
    `     (drizzle.config.ts reads MIGRATION_DATABASE_URL; the inline assignment above overrides whatever ` +
    `.env.local sets for this one command only — do not edit .env.local).\n` +
    `  4. Verify with: psql "postgres://postgres@127.0.0.1:5433/${GOLDEN_DB}" -c "\\dt" — confirm the app tables exist.\n` +
    `Report only whether this succeeded, with any error output verbatim. Do not touch app code, do not run tests.`,
  { phase: 'Prepare', label: 'migrate golden template db', effort: 'low' },
);

phase('Triage');
phase('Build');
const results = await pipeline(
  items,
  // ── Triage: does this item's OWN approved plan actually ask for code? ──────────────────────────
  (fb) =>
    agent(
      `Read the approved implementation plan in full with the Read tool from ${fb.planPath ?? '(missing planPath)'}. ` +
        `Does the PLAN ITSELF (not the original feedback ticket) recommend NOT writing code right now — e.g. it ` +
        `closes the item as already-covered/duplicate, or says a decision is needed before anything is ` +
        `buildable? Most plans DO ask for code; only flag the rare one that explicitly doesn't.\n\nFEEDBACK:\n${brief(fb)}`,
      { schema: TRIAGE_SCHEMA, phase: 'Triage', label: `triage:${(fb.title || '').slice(0, 24)}`, effort: 'low' },
    ),
  // ── Build (skipped when triage says so) — items flow independently, no barrier between them ────
  (triage, fb, idx) => {
    if (triage?.noBuildRecommended) {
      log(`skipped ${idx + 1}/${items.length}: ${fb.title?.slice(0, 40)} → plan itself says no build (${triage.reason})`);
      return {
        id: fb.id,
        tenantId: fb.tenant_id,
        reporterEmploymentId: fb.reporter_employment_id,
        title: fb.title,
        testsPass: false,
        patch: '',
        diffstat: '',
        summary: `Not built — the approved plan itself recommends no code change: ${triage.reason}`,
        blockers: [triage.reason],
      };
    }
    return agent(
      `You are implementing an APPROVED feature in the ai-hr codebase, in a fresh ISOLATED git worktree.\n` +
        `🔒 WORKTREE CONFINEMENT (critical — a stray write corrupts other builds): your current working ` +
        `directory IS your private worktree. Run \`pwd\` first and confirm it is under .claude/worktrees/. Stay ` +
        `there. Run EVERY command (git add / git diff / pnpm / psql / node) from this cwd. Use ONLY relative ` +
        `paths or paths under this cwd when editing. You may READ from ${REPO} (to copy node_modules/.env in ` +
        `setup), but NEVER \`cd\` into ${REPO}, NEVER edit a file under ${REPO}, and NEVER run \`git add\`/` +
        `\`git commit\` against ${REPO} — that is the shared main repo and writing to its index breaks the run.\n\n` +
        `SETUP (do this first, the worktree has no deps/env):\n` +
        `  1. \`ln -s ${REPO}/node_modules ./node_modules\` (reuse the installed deps).\n` +
        `  2. \`cp ${REPO}/.env.local ./.env.local\` (the Vitest harness config).\n` +
        `  3. Give yourself a PRIVATE, isolated test database so your migrations never collide with another ` +
        `build's. Try the fast path first, fall back if it's unavailable:\n` +
        `       DB=ahr_build_${(fb.id || '').slice(0, 8)}\n` +
        `       psql "postgres://postgres@127.0.0.1:5433/postgres" -c "DROP DATABASE IF EXISTS $DB;"\n` +
        `       # fast path — clone the pre-migrated golden template (near-instant, no migration replay):\n` +
        `       psql "postgres://postgres@127.0.0.1:5433/postgres" -c "CREATE DATABASE $DB TEMPLATE ${GOLDEN_DB} OWNER postgres;" \\\n` +
        `         || { echo "template unavailable, falling back to a full migrate"; \\\n` +
        `              psql "postgres://postgres@127.0.0.1:5433/postgres" -c "CREATE DATABASE $DB OWNER postgres;" && \\\n` +
        `              MIGRATION_DATABASE_URL="postgres://postgres@127.0.0.1:5433/$DB" npx drizzle-kit migrate; }\n` +
        `       # rewrite the two TEST_* urls in ./.env.local to use $DB (keep the ai_hr_app / postgres roles):\n` +
        `       #   TEST_DATABASE_URL=postgres://ai_hr_app@127.0.0.1:5433/$DB\n` +
        `       #   TEST_MIGRATION_DATABASE_URL=postgres://postgres@127.0.0.1:5433/$DB\n` +
        `     Either way you end up with a fresh, fully-migrated DB no other build touches. (If you add a ` +
        `migration, append its db/migrations/meta/_journal.json entry as usual — the golden template will not ` +
        `include it, so run your own migrate afterward to pick it up.)\n\n` +
        `IMPLEMENT the approved plan below EXACTLY — scope strictly to it, add no extras. Follow the repo's ` +
        `conventions without exception: Drizzle hand-written migrations (db/migrations/NNNN_*.sql + a manual ` +
        `db/migrations/meta/_journal.json append), the DomainEvent substrate on every state-changing service ` +
        `method (appendEvent/actorOf), i18n in all 6 locales (messages/{en,ms,ta,th,vi,zh}.json), and RLS for ` +
        `any new table. Add the tests the plan specifies.\n\n` +
        `GATE — you MUST reach ALL THREE before returning testsPass=true:\n` +
        `  • \`npx tsc --noEmit\` is clean.\n` +
        `  • The test file(s) you added or modified are green — run them scoped, e.g. \`pnpm vitest run ` +
        `test/your-file.test.ts\`. Do NOT run the full \`pnpm vitest run\` suite: release.ts re-runs the entire ` +
        `suite as its own final gate before anything ships, so re-running ~1370 unrelated tests here only costs ` +
        `time without adding safety. If your change plausibly affects another module's existing tests (you ` +
        `touched a shared helper, a migration, a shared component), scope your run to that module's test files ` +
        `too — use judgement, not the whole suite.\n` +
        `  • \`pnpm build\` (next build) compiles successfully. This catches React Server Component boundary ` +
        `errors — a \`'use client'\` component importing a server-only module (e.g. anything that imports the DB ` +
        `client) — which tsc + vitest do NOT catch and which BREAK the production deploy. One-shot, ~1 min; it ` +
        `does NOT start a server. If it fails with a client/server "module not found", split the pure helpers/` +
        `constants/types into a db-free module and import THAT from the client component (e.g. core/loans-compute.ts).\n` +
        `⛔ HANG GUARDS (the previous run stalled on these): do NOT start the dev server (\`pnpm dev\` / \`next ` +
        `dev\`), do NOT run browser/preview verification, and do NOT run any long-lived or watch-mode process. ` +
        `Use ONLY \`tsc --noEmit\`, scoped \`vitest run\`, and \`pnpm build\` (all one-shot). If a command hangs > 2 min, kill it and treat ` +
        `it as a blocker rather than waiting.\n` +
        `When green: \`git add -A\`, then PERSIST your work before returning so a later build's failure cannot ` +
        `lose it — write the full \`git diff --cached\` to \`${REPO}/.improve/patches/${fb.id}.patch\` (use the ` +
        `Write tool or \`git diff --cached > …\`). Return: testsPass=true, that same diff as \`patch\`, the ` +
        `\`git diff --cached --stat\` as \`diffstat\`, and a short summary.\n\n` +
        `If you cannot reach green after a genuine effort, return testsPass=false with the specific blockers. ` +
        `NEVER weaken, skip, or delete tests to go green. NEVER return a red/partial patch as if it passed. ` +
        `Spend at most ~30 minutes per build; if not green by then, return testsPass=false with what's left.\n\n` +
        `FEEDBACK:\n${brief(fb)}\n\n` +
        `APPROVED PLAN: read it IN FULL with the Read tool from ${fb.planPath ?? '(missing planPath — stop and report this as a blocker)'} ` +
        `before implementing. It is the adversarially-refined plan the reporter approved; implement exactly it.`,
      { schema: BUILD_SCHEMA, phase: 'Build', label: `build ${idx}:${(fb.title || '').slice(0, 24)}`, effort: 'xhigh', isolation: 'worktree' },
    ).then((built) => {
      const r = {
        id: fb.id,
        tenantId: fb.tenant_id,
        reporterEmploymentId: fb.reporter_employment_id,
        title: fb.title,
        testsPass: !!(built && built.testsPass),
        patch: (built && built.patch) || '',
        diffstat: (built && built.diffstat) || '',
        summary: (built && built.summary) || '(no summary)',
        blockers: (built && built.blockers) || (built ? [] : ['build agent returned nothing']),
      };
      log(`built ${idx + 1}/${items.length}: ${fb.title?.slice(0, 40)} → ${r.testsPass ? 'GREEN' : 'failed'}`);
      return r;
    });
  },
);

return results.filter(Boolean);

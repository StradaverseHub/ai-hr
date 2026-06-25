/**
 * Build phase (ADR-0045, IL-4). Given the APPROVED feedback items (from `improve:pull-approved`, passed as
 * `args`), build each one's plan in an isolated git worktree, gate on `tsc` + `vitest`, and return a
 * green-verified patch per item. Returns artifacts only — it NEVER touches the server and NEVER releases.
 *
 * Builds run SEQUENTIALLY on purpose: the Vitest suite migrates a shared test database, so two concurrent
 * builds would race it. One build at a time keeps the gate trustworthy.
 *
 * Invoke:  Workflow({ scriptPath: 'scripts/improve/build-approved.workflow.js', args: <pull-approved array> })
 *   → [{ id, tenantId, reporterEmploymentId, title, testsPass, patch, diffstat, summary, blockers }]
 * The operator then (per green item): mark build-start/-complete on the server, apply the patch to a preview
 * worktree, preview it, and — only after a human approves — `improve:release`.
 */
export const meta = {
  name: 'build-approved',
  description: 'Build each approved feedback item in an isolated worktree; gate on tsc + vitest',
  phases: [{ title: 'Build', detail: 'implement + typecheck + test, one item at a time' }],
};

const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    testsPass: { type: 'boolean', description: 'true ONLY if tsc is clean AND the whole vitest suite is green.' },
    summary: { type: 'string', description: '2–3 sentences on what was built.' },
    patch: { type: 'string', description: 'Full `git diff --cached` text of the change (empty if testsPass is false).' },
    diffstat: { type: 'string', description: '`git diff --cached --stat` output.' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'If testsPass is false, the specific reasons.' },
  },
  required: ['testsPass', 'summary'],
};

const REPO = '/Users/zenlam/Projects/ai-hr';
const items = (typeof args === 'string' ? JSON.parse(args || '[]') : args) || [];

phase('Build');
const results = [];
// Sequential: await each build before starting the next (shared test DB must not be raced).
for (let i = 0; i < items.length; i++) {
  const fb = items[i];
  const brief = [
    `Type: ${fb.category ?? 'unknown'}`,
    `Title: ${fb.title ?? ''}`,
    `Description: ${fb.description ?? ''}`,
    fb.expected_behavior ? `Expected behaviour: ${fb.expected_behavior}` : '',
    fb.expected_function ? `Expected function: ${fb.expected_function}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const built = await agent(
    `You are implementing an APPROVED feature in the ai-hr codebase. You are in a fresh, isolated git ` +
      `worktree off main — make ALL changes here; do not touch ${REPO}.\n\n` +
      `SETUP (do this first, the worktree has no deps/env):\n` +
      `  1. \`ln -s ${REPO}/node_modules ./node_modules\` (reuse the installed deps).\n` +
      `  2. \`cp ${REPO}/.env.local ./.env.local\` (the Vitest harness config).\n` +
      `  3. Give yourself a PRIVATE, isolated test database so your migrations never collide with another ` +
      `build's (the harness migrates-forward only; a shared DB breaks across builds). Pick a unique name and ` +
      `point .env.local at it:\n` +
      `       DB=ahr_build_${(fb.id || '').slice(0, 8)}\n` +
      `       psql "postgres://postgres@127.0.0.1:5433/postgres" -c "DROP DATABASE IF EXISTS $DB; CREATE DATABASE $DB OWNER postgres;"\n` +
      `       # rewrite the two TEST_* urls in ./.env.local to use $DB (keep the ai_hr_app / postgres roles):\n` +
      `       #   TEST_DATABASE_URL=postgres://ai_hr_app@127.0.0.1:5433/$DB\n` +
      `       #   TEST_MIGRATION_DATABASE_URL=postgres://postgres@127.0.0.1:5433/$DB\n` +
      `     The harness will migrate this fresh DB from zero on first use — no reset, no collision. (If you add ` +
      `a migration, append its db/migrations/meta/_journal.json entry as usual.)\n\n` +
      `IMPLEMENT the approved plan below EXACTLY — scope strictly to it, add no extras. Follow the repo's ` +
      `conventions without exception: Drizzle hand-written migrations (db/migrations/NNNN_*.sql + a manual ` +
      `db/migrations/meta/_journal.json append), the DomainEvent substrate on every state-changing service ` +
      `method (appendEvent/actorOf), i18n in all 6 locales (messages/{en,ms,ta,th,vi,zh}.json), and RLS for ` +
      `any new table. Add the tests the plan specifies.\n\n` +
      `GATE — you MUST reach BOTH before returning testsPass=true:\n` +
      `  • \`npx tsc --noEmit\` is clean.\n` +
      `  • \`pnpm vitest run\` is fully green against YOUR isolated DB (set up above). The harness migrates it ` +
      `from zero, so there is no shared-DB collision and no reset to run.\n` +
      `⛔ HANG GUARDS (the previous run stalled on these): do NOT start the dev server (\`pnpm dev\` / \`next ` +
      `dev\`), do NOT run browser/preview verification, and do NOT run any long-lived or watch-mode process. ` +
      `Use ONLY \`tsc --noEmit\` and \`vitest run\` (one-shot). If a command hangs > 2 min, kill it and treat ` +
      `it as a blocker rather than waiting.\n` +
      `When green: \`git add -A\`, then PERSIST your work before returning so a later build's failure cannot ` +
      `lose it — write the full \`git diff --cached\` to \`${REPO}/.improve/patches/${fb.id}.patch\` (use the ` +
      `Write tool or \`git diff --cached > …\`). Return: testsPass=true, that same diff as \`patch\`, the ` +
      `\`git diff --cached --stat\` as \`diffstat\`, and a short summary.\n\n` +
      `If you cannot reach green after a genuine effort, return testsPass=false with the specific blockers. ` +
      `NEVER weaken, skip, or delete tests to go green. NEVER return a red/partial patch as if it passed. ` +
      `Spend at most ~30 minutes per build; if not green by then, return testsPass=false with what's left.\n\n` +
      `FEEDBACK:\n${brief}\n\n` +
      `APPROVED PLAN: read it IN FULL with the Read tool from ${fb.planPath ?? '(missing planPath — stop and report this as a blocker)'} ` +
      `before implementing. It is the adversarially-refined plan the reporter approved; implement exactly it.`,
    { schema: BUILD_SCHEMA, phase: 'Build', label: `build ${i}:${(fb.title || '').slice(0, 24)}`, effort: 'xhigh', isolation: 'worktree' },
  );

  results.push({
    id: fb.id,
    tenantId: fb.tenant_id,
    reporterEmploymentId: fb.reporter_employment_id,
    title: fb.title,
    testsPass: !!(built && built.testsPass),
    patch: (built && built.patch) || '',
    diffstat: (built && built.diffstat) || '',
    summary: (built && built.summary) || '(no summary)',
    blockers: (built && built.blockers) || (built ? [] : ['build agent returned nothing']),
  });
  log(`built ${i + 1}/${items.length}: ${fb.title?.slice(0, 40)} → ${results[i].testsPass ? 'GREEN' : 'failed'}`);
}

return results;

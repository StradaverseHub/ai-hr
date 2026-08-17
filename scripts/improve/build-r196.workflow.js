/**
 * r196 build round — six approved feedback items, one pre-made worktree each, then an adversarial
 * verify pass per item. Returns artifacts only: it NEVER merges, NEVER touches the server, NEVER releases.
 *
 * WHY THIS EXISTS BESIDE build-approved.workflow.js. That script hardcodes
 * `REPO = '/Users/zenlam/Projects/ai-hr'` — the ROOT scratch worktree, which sits on `local/root-scratch`
 * and is FAR BEHIND main — and asks the runtime for `isolation: 'worktree'`, which cuts each agent's tree
 * from that root HEAD. AGENTS.md forbids exactly that ("Never let isolation: 'worktree' cut an agent's tree
 * from the root HEAD — create worktrees from main yourself"). So here the PARENT creates the worktrees from
 * `main` before the workflow starts, hands each agent its absolute path, and no agent asks for isolation.
 *
 * It also drops that script's `ahr_build_golden` CREATE-DATABASE-TEMPLATE dance. The harness already has the
 * documented mechanism for parallel agents: `TEST_DB_NAMESPACE` (test/db-names.ts) gives each run its own
 * template + worker databases AND marks them ephemeral so they are torn down instead of leaking. One
 * namespace per workstream, handed out below — never invented by the agent (AGENTS rule 1).
 *
 * Invoke: Workflow({ scriptPath: 'scripts/improve/build-r196.workflow.js' })  — items are inline, not args.
 */
export const meta = {
  name: 'build-r196',
  description: 'Build six approved board items in pre-made worktrees, then verify each against this repo\'s known traps',
  phases: [
    { title: 'Build', detail: 'implement the approved plan in a worktree cut from main; tsc + own tests + next build' },
    { title: 'Verify', detail: 'adversarial pass per item against the repo traps a targeted test run cannot see' },
  ],
};

const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    testsPass: {
      type: 'boolean',
      description:
        'true ONLY if `npx tsc --noEmit` is clean, every test file you added or modified is green, and `pnpm build` compiles. Never true on a partial or red change.',
    },
    summary: { type: 'string', description: '3-5 sentences: what you built, and any decision the plan left open that you had to take.' },
    filesTouched: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths you changed.' },
    diffstat: { type: 'string', description: '`git diff --cached --stat` output (or `git show --stat HEAD` if you committed).' },
    commitSha: { type: 'string', description: 'The commit you made on your branch, or empty if you left the work staged.' },
    migrationTag: { type: 'string', description: 'The migration file name if you added one, else empty.' },
    scopeCuts: { type: 'array', items: { type: 'string' }, description: 'Anything in the plan you deliberately did NOT build, and why.' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'If testsPass is false, the specific reasons.' },
  },
  required: ['testsPass', 'summary'],
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          trap: { type: 'string', description: 'Which rule/trap this violates, e.g. "rule 20 function-access matrix".' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'should-fix', 'note'] },
        },
        required: ['trap', 'detail', 'severity'],
      },
    },
    planFidelity: { type: 'string', description: 'Does the diff implement the approved plan, and where does it diverge?' },
    verdict: { type: 'string', enum: ['ship', 'fix-first', 'reject'] },
  },
  required: ['findings', 'verdict'],
};

const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const MAIN = `${WT}/mainwt`;
const PLANS = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad/plans';

// One workstream per worktree. `ns` is the TEST_DB_NAMESPACE handed out centrally — never invented by an
// agent. `migration` is the CENTRALLY ALLOCATED number (AGENTS rules 5/14/22): only one this round, so it
// cannot be skipped by merge order. Every other agent is told explicitly that it gets none.
const WORK = [
  { slug: 'repl', ns: 'r196repl', ids: ['5ff7daff'], title: 'Replacement Leave — employee request/approval/balance', migration: null },
  { slug: 'entl', ns: 'r196entl', ids: ['31e39d74'], title: 'Medical & Hospitalization entitlement not reflected in My Leave', migration: null },
  { slug: 'txn', ns: 'r196txn', ids: ['c11e81aa'], title: 'Individual Transaction — pay item info, entry UX, pay cycle', migration: '0441_individual_txn_intended_cycle' },
  { slug: 'payitem', ns: 'r196payitem', ids: ['6b134681', '417d4937'], title: 'Pay item code/description in results + amount mismatch (one root cause, two symptoms)', migration: null },
  { slug: 'org', ns: 'r196org', ids: ['3c2f55d7'], title: 'Organization module — company setup card redesign', migration: null },
  { slug: 'attend', ns: 'r196attend', ids: ['ad52212d'], title: 'Attendance Settings — ROUNDS 1 AND 2 ONLY (no migration)', migration: null },
];

const houseRules = (w) =>
  `HOUSE RULES — this repo re-makes the same mistakes, and these are the ones that would bite YOU:\n` +
  `  • This is NOT the Next.js you know (v16, Turbopack). Read node_modules/next/dist/docs/ before writing ` +
  `anything framework-shaped rather than trusting training data.\n` +
  `  • Understand code through the graph, not by grepping cold: run \`graphify explain "<symbol>"\`, ` +
  `\`graphify query "<question>"\` or \`graphify affected "X"\` from ${MAIN} (read-only) before spelunking.\n` +
  `  • i18n in ALL SIX locales (messages/{en,ms,ta,th,vi,zh}.json). A key added to en only fails the gate. ` +
  `Resolve keys in the namespace the screen actually reads — a screen reading a namespace that never had ` +
  `its keys renders MISSING_MESSAGE on every page and still returns 200.\n` +
  `  • Any new guarded page.tsx NEEDS a column in the function-access matrix (lib/permissions.ts), or ` +
  `test/function-access.test.ts's reverse-completeness case fails. Attach it to the EXISTING screen key that ` +
  `links to it. Route handlers (route.ts) are not pages and are not listed.\n` +
  `  • A new core/ file must import packs/<pack>/service, NEVER a pack's implementation. Do not touch ` +
  `test/pack-drift-allowlist.json — the guard refuses additions by design.\n` +
  `  • Every state-changing service method appends a DomainEvent (appendEvent/actorOf).\n` +
  `  • A form field that is ALWAYS submitted cannot be read by presence — a hidden input is sent whatever its ` +
  `value, so \`fd.get(k) != null\` reads an unticked box as true.\n` +
  `  • A guard may pin the very decision you are reversing. UPDATE the case, never delete it.\n` +
  (w.migration
    ? `  • MIGRATION: you are allocated EXACTLY ONE, \`db/migrations/${w.migration}.sql\`, journal idx 441, ` +
      `when 1781862541000. Hand-write the .sql AND append the journal entry (never re-sort the journal — it is ` +
      `append-only and a deliberate 240/230 inversion is grandfathered). A CREATE TABLE must also GRANT; an ` +
      `ADD COLUMN on an existing granted table does not. Do not invent any other number.\n`
    : `  • NO MIGRATION for your workstream. If you conclude the plan cannot be built without one, STOP and ` +
      `return testsPass=false naming that — do NOT allocate a number yourself (two agents picking the same ` +
      `number, or a number reaching production out of order, silently skips a migration).\n`);

const setup = (w) =>
  `YOUR WORKTREE IS ALREADY MADE, cut from \`main\` at the commit that includes the r195 recovery, with ` +
  `node_modules symlinked and .env.local copied. It is:\n    ${WT}/r196-${w.slug}   (branch build/r196-${w.slug})\n` +
  `🔒 CONFINEMENT: \`cd\` there FIRST and run \`pwd\` + \`git branch --show-current\` to confirm before anything ` +
  `else — this repo has shipped green gates for the wrong tree three times. Run EVERY command from that ` +
  `directory. You may READ ${MAIN}; never edit it, never \`git add\`/\`git commit\` against it, and never touch ` +
  `another r196-* worktree.\n\n` +
  `YOUR TEST DATABASE NAMESPACE IS \`${w.ns}\` — set it on EVERY vitest invocation:\n` +
  `    TEST_DB_NAMESPACE=${w.ns} pnpm vitest run test/<your-file>.test.ts\n` +
  `That gives you your own template + worker databases and marks them ephemeral. Do NOT invent a different ` +
  `namespace, do NOT run without it (you would wipe a sibling's databases mid-run), and do NOT run the FULL ` +
  `suite — the parent runs the single full gate alone, afterwards. Scope your run to the files you touched ` +
  `plus any module whose existing tests your change plausibly affects.\n`;

const gate = () =>
  `GATE — all three before you may return testsPass=true:\n` +
  `  1. \`npx tsc --noEmit\` clean.\n` +
  `  2. Your own new/modified test files green (namespaced, as above).\n` +
  `  3. \`pnpm build\` compiles. This is the only thing that catches an RSC boundary error — a 'use client' ` +
  `file importing a server-only module — which tsc and vitest both pass and which breaks the deploy.\n` +
  `⛔ HANG GUARDS: never start a dev server, a watch mode, or a browser. Only one-shot commands. If anything ` +
  `runs past ~3 minutes with no output, kill it and treat it as a blocker. Long command output goes to a file ` +
  `with \`> log 2>&1\` — never through a pipe (undrained pipes hang, and an exit code read through a pipe is ` +
  `the last command's).\n` +
  `NEVER weaken, skip or delete a test to go green. NEVER report a red or partial change as passing — a false ` +
  `green costs more than a reported blocker. When green: \`git add -A\` and COMMIT on your own branch, then ` +
  `report the sha.\n`;

phase('Build');
phase('Verify');

const results = await pipeline(
  WORK,
  // ── Build ────────────────────────────────────────────────────────────────────────────────────────
  (w) =>
    agent(
      `You are implementing APPROVED board item(s) ${w.ids.join(' + ')} in the ai-hr codebase ` +
        `(Next.js 16 App Router, Drizzle, PostgreSQL with RLS, next-intl, Vitest).\n\n` +
        `WORKSTREAM: ${w.title}\n\n` +
        `${setup(w)}\n${houseRules(w)}\n${gate()}\n` +
        `THE APPROVED PLAN(S) — read each IN FULL with the Read tool before writing any code:\n` +
        w.ids.map((id) => `    ${PLANS}/${id}.md`).join('\n') +
        `\nEach file holds the reporter's original request AND the plan they approved. Implement EXACTLY the ` +
        `plan, scoped strictly to it: add no extras, and where the plan says something is already built, ` +
        `VERIFY that in the code before either re-building it or trusting it. Several of these plans open with ` +
        `a verdict like "Partly there already" — that verdict is load-bearing, not padding.\n` +
        (w.ids.length > 1
          ? `\nYOUR TWO ITEMS ARE ONE ROOT CAUSE, TWO SYMPTOMS. Fix the cause once and let both surfaces read it; ` +
            `do not write two independent patches that can disagree.\n`
          : '') +
        (w.slug === 'attend'
          ? `\n⚠️ SCOPE CEILING: build ROUNDS 1 AND 2 ONLY. The plan's own text says rounds 1-2 need no ` +
            `migration and round 3 does. Stop at the end of round 2 and list rounds 3+ in scopeCuts.\n`
          : '') +
        `\nReturn the schema fields honestly, including scopeCuts for anything you chose not to build.`,
      { schema: BUILD_SCHEMA, phase: 'Build', label: `build:${w.slug}`, effort: 'xhigh' },
    ).then((built) => ({ w, built })),
  // ── Verify: adversarial, and blind to the builder's own reasoning ────────────────────────────────
  (prev) => {
    if (!prev || !prev.built) return { w: prev?.w, built: null, verify: null };
    const { w, built } = prev;
    if (!built.testsPass) {
      log(`build:${w.slug} came back RED — skipping verify (${(built.blockers || []).join('; ').slice(0, 120)})`);
      return { w, built, verify: null };
    }
    return agent(
      `Adversarially review a change that its own author says is green. You are looking for the failure modes ` +
        `a TARGETED test run structurally cannot see — the ones this repo has actually shipped.\n\n` +
        `The change is on branch build/r196-${w.slug} in ${WT}/r196-${w.slug}. Read it with ` +
        `\`git diff main...HEAD\` from that directory (read-only — do NOT edit, commit, or run the test suite; ` +
        `the parent runs the single full gate alone and a second vitest would wipe a sibling's databases).\n\n` +
        `CHECK, concretely, each of these against the diff:\n` +
        `  1. i18n: every new key present in ALL SIX of messages/{en,ms,ta,th,vi,zh}.json, with matching ` +
        `placeholders, and resolved from the namespace the screen actually reads.\n` +
        `  2. Any new guarded page.tsx has a column in the function-access matrix (lib/permissions.ts).\n` +
        `  3. Any new core/ file imports packs/<pack>/service, not a pack implementation.\n` +
        `  4. Every state-changing service method appends a DomainEvent.\n` +
        `  5. Migration: present only if allocated (${w.migration ?? 'NONE allocated'}), journal APPENDED not ` +
        `re-sorted, CREATE TABLE also GRANTs.\n` +
        `  6. No test weakened, skipped, deleted, or narrowed to pass. Check for an existing guard that ` +
        `asserts the OPPOSITE of what this change does — if there is one, was it updated (correct) or deleted ` +
        `(not correct)?\n` +
        `  7. Presence-vs-value bugs on form fields, and RSC boundary risk ('use client' reaching a ` +
        `server-only import).\n` +
        `  8. Plan fidelity: read ${w.ids.map((id) => `${PLANS}/${id}.md`).join(' and ')} and say where the ` +
        `diff diverges from what the reporter approved — in EITHER direction (missing, or unrequested extra).\n\n` +
        `The author's own summary, for contrast — treat it as a claim to test, not as evidence:\n${built.summary}\n\n` +
        `Report only what you can point at in the diff. "No findings" is a valid and useful answer; do not ` +
        `invent work. verdict=ship if nothing needs changing before the full gate.`,
      { schema: VERIFY_SCHEMA, phase: 'Verify', label: `verify:${w.slug}`, effort: 'high' },
    ).then((verify) => {
      const blockers = (verify?.findings || []).filter((f) => f.severity === 'blocker').length;
      log(`verify:${w.slug} → ${verify?.verdict ?? 'no verdict'}${blockers ? ` (${blockers} blocker(s))` : ''}`);
      return { w, built, verify };
    });
  },
);

const out = results.filter(Boolean).map((r) => ({
  slug: r.w?.slug,
  ids: r.w?.ids,
  branch: `build/r196-${r.w?.slug}`,
  testsPass: !!r.built?.testsPass,
  commitSha: r.built?.commitSha || '',
  migrationTag: r.built?.migrationTag || '',
  diffstat: r.built?.diffstat || '',
  summary: r.built?.summary || '(none)',
  scopeCuts: r.built?.scopeCuts || [],
  blockers: r.built?.blockers || [],
  verdict: r.verify?.verdict || 'not-verified',
  findings: r.verify?.findings || [],
  planFidelity: r.verify?.planFidelity || '',
}));

log(`r196: ${out.filter((o) => o.testsPass).length}/${out.length} green · ` +
  `${out.filter((o) => o.verdict === 'ship').length} verified ship · ` +
  `${out.reduce((n, o) => n + o.findings.filter((f) => f.severity === 'blocker').length, 0)} blocker finding(s)`);

return out;

/**
 * r197 build round — the remaining approved queue: five build workstreams in pre-made worktrees, plus ONE
 * investigation that must not become a build. Same confinement rules as r196; merges nothing, releases
 * nothing.
 *
 * THE STATUTORY TRIO IS NOT IN THE BUILD PHASE ON PURPOSE. `621c929d` (Socso Borang 8A), `d21e667e`
 * (KWSP/EPF Borang A) and `e0cd4583` (CP39-MTD/PCB) are NEW BOARD IDS FOR FORMS THIS REPO HAS ALREADY
 * SHIPPED under different ids (`8ca344bf`, `9c8dad7a`+`3aae0789`, and the CP22 work). Building them blind
 * would either rebuild working screens or quietly reverse a decision the earlier round took on purpose. So
 * one agent establishes duplicate-vs-rework FIRST, and returns a recommendation — no code.
 */
export const meta = {
  name: 'build-r197',
  description: 'Build the remaining approved items; triage the three statutory forms instead of rebuilding them',
  phases: [
    { title: 'Build', detail: 'five workstreams, each in its own worktree cut from main' },
    { title: 'Triage', detail: 'duplicate-vs-rework for the three statutory-form items — investigation only' },
    { title: 'Verify', detail: 'adversarial pass per built workstream' },
  ],
};

const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    testsPass: { type: 'boolean', description: 'true ONLY if tsc is clean, your new/changed tests are green, and pnpm build compiles.' },
    summary: { type: 'string', description: '3-5 sentences: what you built, and any decision the plan left open that you had to take.' },
    diffstat: { type: 'string' },
    commitSha: { type: 'string' },
    migrationTag: { type: 'string', description: 'Migration file name if you added one, else empty.' },
    scopeCuts: { type: 'array', items: { type: 'string' }, description: 'Anything in the plan you deliberately did NOT build, and why.' },
    blockers: { type: 'array', items: { type: 'string' } },
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
          trap: { type: 'string' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'should-fix', 'note'] },
        },
        required: ['trap', 'detail', 'severity'],
      },
    },
    planFidelity: { type: 'string' },
    verdict: { type: 'string', enum: ['ship', 'fix-first', 'reject'] },
  },
  required: ['findings', 'verdict'],
};

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          disposition: { type: 'string', enum: ['duplicate-already-shipped', 'genuine-rework', 'genuinely-new', 'unclear'] },
          evidence: { type: 'string', description: 'What is on disk / on the board that decides it, with file:line or item id.' },
          whatIsMissing: { type: 'string', description: 'If rework or new: precisely what the shipped code does NOT do that this item asks for.' },
          recommendation: { type: 'string', description: 'Close as duplicate / build now / needs a re-plan — and why.' },
        },
        required: ['id', 'disposition', 'evidence', 'recommendation'],
      },
    },
  },
  required: ['items'],
};

const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const MAIN = `${WT}/mainwt`;
const PLANS = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad/plans';

const WORK = [
  {
    slug: 'entity', ns: 'r197entity', ids: ['1b0943d5', '3c88d593'],
    title: 'Entity transfer stage two — cross-batch segments, and the completeness control',
    migration: '0442_payslip_coverage_dates',
    extra:
      `⚠️ THIS IS THE ONE THAT STOPS SOMEONE BEING UNDERPAID, AND IT IS THE RISKIEST IN THE QUEUE. Read the ` +
      `plan's ordering literally: it DELIBERATELY REVERSES the item as it was raised — cross-batch segment ` +
      `creation comes FIRST, attendance/leave/reporting LAST. Do not restore the original order.\n\n` +
      `Three things the plan names, all verified in code, and none of them a sums problem:\n` +
      `  1. BATCH MEMBERSHIP IS BY CURRENT COMPANY — \`eq(employment.companyId, batch.companyId)\` at six ` +
      `sites in core/payroll.ts (1388, 2434, 3186, 5873, 6143, plus the scope path). TREAT EACH OF THE SIX ` +
      `AS ITS OWN DECISION and record why in the code: some legitimately want today's employer (the leavers ` +
      `sweep keyed on terminatedOn does). A blanket replace silently rescopes payroll for the whole tenant. ` +
      `Reuse core/employment-company.ts; do not write a second resolver.\n` +
      `  2. A PAYSLIP CANNOT STATE ITS COVERAGE — the table has days_worked and no period columns. That is ` +
      `your migration, and it is the reporter's own requirement ("Payroll Period: 01 Aug – 10 Aug 2026"). ` +
      `Nullable, so every existing row stays valid and unchanged.\n` +
      `  3. THE COMPLETENESS CHECK IS A DELIVERABLE, NOT AN EXTRA — segments must tile the month with no gap ` +
      `and no overlap and sum to the un-segmented figure, and the run must REFUSE rather than commit a ` +
      `partial set. The real shortfall in r194 was caught only because the batch total happened to fall by ` +
      `exactly the missing amount. That is luck, not a control.\n\n` +
      `Ground truth from production, r194: employee 100814 transferred Fiamma → ISEDECOR BINA effective ` +
      `2026-08-11; 6,600.00 ÷ 31 × 21 was produced for ISEDECOR and the Fiamma 1–10 Aug counterpart ` +
      `(6,600 ÷ 31 × 10 = 2,129.03) was never created, because every company has its OWN batch for a period ` +
      `and reprocessSelectedEmployees recomputes strictly within the ONE batch it is given.`,
  },
  {
    slug: 'grade', ns: 'r197grade', ids: ['9a65f808'],
    title: 'Move Grade Group Selection to Eligibility Rules',
    migration: null,
    extra: `This plan is at revision 3 — read its KNOWN OPEN POINTS section if it has one; that is where an ` +
      `unresolved objection from an earlier review is recorded.`,
  },
  {
    slug: 'epfcycle', ns: 'r197epfcycle', ids: ['bdf7d248'],
    title: 'EPF calculation across multiple payroll cycles in the same month',
    migration: null,
    extra: `Statutory arithmetic. Where the plan and the live PERKESO/KWSP tables disagree, the plan is ` +
      `wrong — say so as a blocker rather than encoding a figure you cannot source.`,
  },
  {
    slug: 'pcbview', ns: 'r197pcbview', ids: ['45df860a'],
    title: 'Detailed PCB / MTD calculation view',
    migration: null,
    extra: `The plan says this rides on statutory.pcbMeta (jsonb) as an ADDITIVE trace — no DDL, forward-only. ` +
      `Payslips written before this ships carry no trace: they must be FLAGGED as "not recorded", never ` +
      `silently rendered as zeroes or back-derived. That exact failure has shipped here before.`,
  },
  {
    slug: 'width', ns: 'r197width', ids: ['152fea7f'],
    title: 'Standardize all payroll screens to full-width layout',
    migration: null,
    extra: `THIS TOUCHES MANY OF THE SAME FILES AS THE OTHER PAYROLL WORKSTREAMS IN THIS ROUND. Keep your ` +
      `diff to layout: container/width classes and the wrappers that carry them. Do NOT reflow markup, ` +
      `rename props, or "tidy" anything you pass through — every extra line is a merge conflict against a ` +
      `sibling branch, and the integrator resolving it cannot tell your intent from your accident.`,
  },
];

const houseRules = (w) =>
  `HOUSE RULES — the ones that would bite YOU:\n` +
  `  • This is NOT the Next.js you know (v16, Turbopack). Read node_modules/next/dist/docs/ before writing ` +
  `anything framework-shaped.\n` +
  `  • Use the code graph before grepping cold: \`graphify explain "<symbol>"\` / \`graphify affected "X"\` ` +
  `from ${MAIN} (read-only).\n` +
  `  • i18n in ALL SIX locales (messages/{en,ms,ta,th,vi,zh}.json), resolved from the namespace the screen ` +
  `actually reads — a screen reading a namespace that never had its keys renders MISSING_MESSAGE on every ` +
  `page and still returns 200.\n` +
  `  • A new guarded page.tsx NEEDS a column in lib/permissions.ts, or test/function-access.test.ts fails.\n` +
  `  • A new core/ file imports packs/<pack>/service, never a pack implementation. Never touch ` +
  `test/pack-drift-allowlist.json — that list only shrinks, and it is scanned from the FILESYSTEM, so a ` +
  `stray scratch file left in the tree trips it too.\n` +
  `  • Every state-changing service method appends a DomainEvent (appendEvent/actorOf).\n` +
  `  • A field that is ALWAYS submitted cannot be read by presence.\n` +
  `  • If an existing guard asserts the decision you are reversing, UPDATE the case; never delete it.\n` +
  `  • THE COMMENT IS THE GUARD. If your change falsifies a documented invariant, fix EVERY statement of ` +
  `it, not just the code that reads it — r196 shipped a fix that left five copies of a dead rule behind.\n` +
  (w.migration
    ? `  • MIGRATION: you are allocated EXACTLY ONE, \`db/migrations/${w.migration}.sql\`, journal idx 442, ` +
      `when 1781862542000. Hand-write the .sql AND append the journal entry — the journal is APPEND-ONLY and ` +
      `must never be re-sorted. ADD COLUMN inherits the table's grants; only CREATE TABLE owes a GRANT.\n`
    : `  • NO MIGRATION for your workstream. If you conclude the plan cannot be built without one, STOP and ` +
      `return testsPass=false saying so — never allocate a number yourself.\n`);

const setup = (w) =>
  `YOUR WORKTREE IS ALREADY MADE, cut from \`main@f5181a15\` (r196 shipped), node_modules symlinked and ` +
  `.env.local copied:\n    ${WT}/r197-${w.slug}   (branch build/r197-${w.slug})\n` +
  `🔒 \`cd\` there FIRST and confirm with \`pwd\` and \`git branch --show-current\` before anything else — this ` +
  `repo has shipped green gates for the wrong tree four times. Run EVERY command from there. You may READ ` +
  `${MAIN}; never edit it, never git-add against it, never touch a sibling r197-* worktree.\n\n` +
  `TEST DATABASE NAMESPACE: \`${w.ns}\` — on EVERY vitest run:\n` +
  `    TEST_DB_NAMESPACE=${w.ns} pnpm vitest run test/<file>.test.ts\n` +
  `Never omit it (you would wipe a sibling's databases), never invent another, never run the full suite — ` +
  `the parent runs the single full gate alone, afterwards.\n`;

const gate =
  `GATE — all three before testsPass=true: \`npx tsc --noEmit\` clean · your new/changed test files green ` +
  `(namespaced) · \`pnpm build\` compiles (the only thing that catches an RSC boundary error).\n` +
  `⛔ No dev server, no watch mode, no browser, nothing long-lived. Long output to a file with ` +
  `\`> log 2>&1\`, never a pipe. If a command runs past ~3 minutes with no output, kill it and report it as ` +
  `a blocker.\n` +
  `NEVER weaken, skip or delete a test to go green. NEVER report a red or partial change as passing. When ` +
  `green: \`git add -A\` and commit on your branch, then report the sha.\n`;

phase('Build');
phase('Triage');
phase('Verify');

// ── The investigation, running alongside the builds and deliberately producing NO code ───────────────
const triage = agent(
  `INVESTIGATION ONLY — you must not write, edit or commit any application code.\n\n` +
    `Three approved board items ask for Malaysian statutory forms this repo may ALREADY have shipped under ` +
    `different board ids. Establish, for each, whether it is a duplicate, a genuine rework of something ` +
    `that shipped but is wrong, or genuinely new work.\n\n` +
    `  · \`621c929d\` Socso Borang 8A      — plan at ${PLANS}/621c929d.md\n` +
    `  · \`d21e667e\` KWSP/EPF Borang A    — plan at ${PLANS}/d21e667e.md\n` +
    `  · \`e0cd4583\` CP39-MTD/PCB         — plan at ${PLANS}/e0cd4583.md\n\n` +
    `WHAT ALREADY SHIPPED, per this repo's handoff history — verify each claim against the tree rather than ` +
    `trusting it:\n` +
    `  · r193 shipped \`8ca344bf\` SOCSO Borang 8A. Look at app/payroll/borang-8a/ and localization/my/.\n` +
    `  · r194 shipped \`9c8dad7a\` + \`3aae0789\` EPF Borang A (printed form AND i-Akaun text file). Look at ` +
    `app/payroll/borang-a/.\n` +
    `  · CP22 (\`88076362\`) has a screen at app/payroll/cp22/. NOTE CP39 IS A DIFFERENT FORM FROM CP22 — do ` +
    `not conflate them; check whether anything implements CP39 at all.\n\n` +
    `Read ${MAIN}/HANDOFF.md's statutory-form section first — it records four findings from the earlier ` +
    `round that change the work, including that the EPF and SOCSO reference attachments are NOT agency ` +
    `artwork but completed forms from another payroll system, and the +1-month rule that distinguishes ` +
    `Borang A (cycle +1) from Borang 8A (cycle month directly).\n\n` +
    `For each item decide the disposition and give the evidence that decides it — a path and line, or a ` +
    `board id — not an impression. Where an item is a genuine rework, say precisely what the shipped code ` +
    `does NOT do that the item asks for. "unclear" is an acceptable answer when the evidence genuinely does ` +
    `not settle it; a confident wrong answer here costs a whole round.`,
  { schema: TRIAGE_SCHEMA, phase: 'Triage', label: 'triage:statutory-trio', effort: 'high' },
);

const results = await pipeline(
  WORK,
  (w) =>
    agent(
      `You are implementing APPROVED board item(s) ${w.ids.join(' + ')} in the ai-hr codebase (Next.js 16 ` +
        `App Router, Drizzle, PostgreSQL with RLS, next-intl, Vitest).\n\n` +
        `WORKSTREAM: ${w.title}\n\n${setup(w)}\n${houseRules(w)}\n${gate}\n` +
        `THE APPROVED PLAN(S) — read each IN FULL with the Read tool before writing any code:\n` +
        w.ids.map((id) => `    ${PLANS}/${id}.md`).join('\n') +
        `\nEach file carries the reporter's original request AND the plan they approved. Implement exactly ` +
        `the plan, scoped strictly to it. Where a plan says something already exists, VERIFY that in the ` +
        `code before either rebuilding it or trusting it.\n\n${w.extra}\n\n` +
        (w.ids.length > 1
          ? `YOUR TWO IDS ARE ONE PROBLEM — 3c88d593 is the item, 1b0943d5 is its stage two. Build them as ` +
            `one coherent change, not two patches.\n\n`
          : '') +
        `Return the schema fields honestly, including scopeCuts for anything you chose not to build.`,
      { schema: BUILD_SCHEMA, phase: 'Build', label: `build:${w.slug}`, effort: 'xhigh' },
    ).then((built) => ({ w, built })),
  (prev) => {
    if (!prev?.built) return { w: prev?.w, built: null, verify: null };
    const { w, built } = prev;
    if (!built.testsPass) {
      log(`build:${w.slug} RED — skipping verify (${(built.blockers || []).join('; ').slice(0, 110)})`);
      return { w, built, verify: null };
    }
    return agent(
      `Adversarially review a change whose author says it is green. Look for what a TARGETED test run ` +
        `structurally cannot see — the failure modes this repo has actually shipped.\n\n` +
        `Branch build/r197-${w.slug} in ${WT}/r197-${w.slug}; read it with \`git diff main...HEAD\` from ` +
        `that directory. READ-ONLY: do not edit, do not commit, do not run the test suite (a second vitest ` +
        `would wipe a sibling's databases).\n\n` +
        `Check each of these against the diff, concretely:\n` +
        `  1. i18n: every new key in ALL SIX catalogues, placeholders matching, resolved from the namespace ` +
        `the screen reads.\n` +
        `  2. New guarded page.tsx has a lib/permissions.ts column.\n` +
        `  3. New core/ file imports packs/<pack>/service, not a pack implementation.\n` +
        `  4. Every state-changing service method appends a DomainEvent.\n` +
        `  5. Migration present only if allocated (${w.migration ?? 'NONE'}), journal APPENDED not re-sorted.\n` +
        `  6. No test weakened, skipped, deleted or narrowed. Is there an existing guard asserting the ` +
        `OPPOSITE of this change — updated (correct) or deleted (not correct)?\n` +
        `  7. THE COMMENT IS THE GUARD: does the diff falsify a documented invariant anywhere in the repo ` +
        `and leave the sentence standing? Search for other statements of the rule, not just the code that ` +
        `reads it.\n` +
        `  8. Presence-vs-value on form fields; RSC boundary risk.\n` +
        `  9. Plan fidelity against ${w.ids.map((id) => `${PLANS}/${id}.md`).join(' and ')} — divergence in ` +
        `EITHER direction (missing, or unrequested extra).\n` +
        (w.slug === 'entity'
          ? `  10. THE COMPLETENESS CONTROL SPECIFICALLY: do the segments provably tile the month with no ` +
            `gap and no overlap, do they sum to the un-segmented figure, and does the run REFUSE rather ` +
            `than commit a partial set? A test that only checks the happy path does not establish this. ` +
            `Try to construct an input that produces a gap, an overlap, or a partial commit.\n`
          : '') +
        `\nThe author's own summary, to test rather than to trust:\n${built.summary}\n\n` +
        `Report only what you can point at in the diff. "No findings" is valid and useful; do not invent ` +
        `work. verdict=ship if nothing needs changing before the full gate.`,
      { schema: VERIFY_SCHEMA, phase: 'Verify', label: `verify:${w.slug}`, effort: 'high' },
    ).then((verify) => {
      const blockers = (verify?.findings || []).filter((f) => f.severity === 'blocker').length;
      log(`verify:${w.slug} → ${verify?.verdict ?? 'none'}${blockers ? ` (${blockers} blocker(s))` : ''}`);
      return { w, built, verify };
    });
  },
);

const statutory = await triage;

const out = results.filter(Boolean).map((r) => ({
  slug: r.w?.slug,
  ids: r.w?.ids,
  branch: `build/r197-${r.w?.slug}`,
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

log(`r197: ${out.filter((o) => o.testsPass).length}/${out.length} green · ` +
  `${out.filter((o) => o.verdict === 'ship').length} verified ship · ` +
  `${out.reduce((n, o) => n + o.findings.filter((f) => f.severity === 'blocker').length, 0)} blocker finding(s)`);

return { builds: out, statutoryTriage: statutory?.items || [] };

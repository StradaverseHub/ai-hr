/**
 * r206 — the six approved items that are genuinely buildable, in five workstreams grouped BY FILE AREA.
 *
 * The grouping is not cosmetic. r199 put two payroll items in separate worktrees and they collided on
 * app/payroll/transaction-view/page.tsx twice, once structurally; the integrator had to reconstruct intent
 * from two diffs. So the two employee-facing leave items travel together, and the payroll pair is split
 * across the two screens they actually touch.
 *
 * NOT HERE, DELIBERATELY: `bdf7d248` (owner decision on EPF rounding — not a build) and `7ad37961`
 * (TP1 — two agent passes made it worse; the conflict is in the plan, not the code).
 */
export const meta = {
  name: 'r206',
  description: 'Build six approved items in five workstreams; one migration (0447)',
  phases: [{ title: 'Build', detail: 'five workstreams, one worktree each' }, { title: 'Verify', detail: 'adversarial pass per workstream' }],
};

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    testsPass: { type: 'boolean' }, summary: { type: 'string' }, diffstat: { type: 'string' },
    commitSha: { type: 'string' }, migrationTag: { type: 'string' },
    scopeCuts: { type: 'array', items: { type: 'string' } },
    alreadyBuilt: { type: 'string', description: 'What the plan claimed exists that you VERIFIED exists, with file:line.' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['testsPass', 'summary'],
};
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { trap: { type: 'string' }, detail: { type: 'string' }, severity: { type: 'string', enum: ['blocker','should-fix','note'] } },
      required: ['trap','detail','severity'] } },
    planFidelity: { type: 'string' }, verdict: { type: 'string', enum: ['ship','fix-first','reject'] },
  },
  required: ['findings','verdict'],
};

const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const MAIN = `${WT}/mainwt`;
const PLANS = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad/plans';

const WORK = [
  { slug: 'txnsplit', ns: 'r206txn', ids: ['3c88d593'], migration: null,
    title: 'Transaction Detail shows a transferred employee split per company',
    extra:
      `THE DATA IS ALREADY THERE — this is presentation, not calculation, and the plan says so. r204 shipped\n` +
      `payslip.coverage_from / coverage_to (migration 0446) and payslipSegmentOf; the reporter has CONFIRMED\n` +
      `the split payslip works. What they want is Transaction Detail to stop consolidating the month into one\n` +
      `result and show it per company assignment. Nothing about their figures changes — say that in the code\n` +
      `where a later reader will find it.\n` +
      `⚠️ app/payroll/transaction-view/ IS THE FILE r199 COLLIDED ON TWICE. Keep your diff inside the\n` +
      `Transaction Detail path and do not reflow neighbouring markup.` },
  { slug: 'process', ns: 'r206proc', ids: ['65e2d5de'], migration: null,
    title: 'Payroll Process — improve the Reset / Reprocess workflow',
    extra:
      `⚠️ MUCH OF THIS MAY ALREADY BE LIVE and the plan reports three of six asks already built. r198 shipped\n` +
      `9066bd6c (Remove Employee Payroll: its own screen, search, multi-select, required reason, audited,\n` +
      `refusing to empty a run) and Back navigation across the payroll screens; r197 shipped 152fea7f\n` +
      `(full-width). VERIFY each ask against app/payroll/[batchId]/remove/, app/payroll/back.ts and\n` +
      `lib/return-to.ts before building anything, and report what you confirmed in alreadyBuilt with\n` +
      `file:line. The plan also flags that ONE ask is a reversal of a change the reporter approved — do not\n` +
      `quietly reverse it; leave it and name it in scopeCuts.` },
  { slug: 'leaveess', ns: 'r206ess', ids: ['ad965821', '5f2e20fb'], migration: null,
    title: 'Employee leave screens — eligibility-filtered dropdown, and Leave History filters',
    extra:
      `TWO ITEMS, ONE SET OF SCREENS, WHICH IS WHY THEY TRAVEL TOGETHER.\n` +
      `  · ad965821: filter the leave-type dropdown by the employee's configured eligibility and hide\n` +
      `    ineligible types COMPLETELY — no message, no hint they exist. ⚠️ r203 shipped 5570c6a2 and\n` +
      `    464b58e6 on this exact dropdown hours ago: the Document Required suffix is gone and Employee\n` +
      `    Visibility is now ONE tick box with one meaning (visible_to_employee via resolvePlacement in\n` +
      `    lib/leave-groups.ts; employee_can_apply is the other). **DO NOT INTRODUCE A THIRD MECHANISM** —\n` +
      `    removing that duplication is exactly what 464b58e6 just did. Eligibility lives in\n` +
      `    entitlement_eligibility_rule; establish whether the option builder already consults it.\n` +
      `  · 5f2e20fb: a date range and multi-select filter on Employee Leave History.` },
  { slug: 'leavecfg', ns: 'r206cfg', ids: ['7daac043'], migration: '0447_leave_type_min_advance_day_type',
    title: 'Advance notice — calendar days or working days',
    extra:
      `YOUR MIGRATION IS **0447**, journal idx 447, when 1781862547000. The plan's own note says the journal\n` +
      `tail is 0443 and warns not to assume 0444 — that note is now stale: 0446 shipped in r204, and\n` +
      `0444/0445 sit dead on a held branch. 0447 is the centrally issued number; do not pick your own.\n` +
      `Nullable text with a CHECK constraining it to ('calendar_days','working_days'); NULL means calendar\n` +
      `days so every existing row reproduces today's behaviour byte for byte and no backfill is needed.\n` +
      `ALTER TABLE only — ADD COLUMN inherits the table's grants. The journal is APPEND-ONLY, never re-sorted.\n` +
      `The plan names Maximum Consecutive Leave (c6ffa725, migration 0343) as the precedent to copy exactly —\n` +
      `follow it, including the maxConsecutiveUnit comment style.` },
  { slug: 'feedback', ns: 'r206fb', ids: ['e14334ef'], migration: null,
    title: 'Feedback module — show the latest action date',
    extra:
      `THE PLAN'S FINDING IS THAT THIS IS A DISPLAY CHANGE, NOT A COLUMN: feedback_request already carries\n` +
      `created_at, updated_at and decided_at, and every transition appends a domain_event. Verify that before\n` +
      `adding anything to the schema — no migration is allocated to you. This is the board's OWN module, so a\n` +
      `mistake here is visible to the reporter on the screen they use to talk to us.` },
];

const house =
  `HOUSE RULES: Next.js 16 — read node_modules/next/dist/docs/ before anything framework-shaped. Use ` +
  `\`graphify explain\` / \`graphify affected\` from ${MAIN} (read-only) before grepping cold. i18n in all six ` +
  `locales, resolved from the namespace the screen actually reads. A new or moved guarded page.tsx needs its ` +
  `lib/permissions.ts column. A new core/ file imports packs/<pack>/service, never a pack implementation, ` +
  `and NEVER edit test/pack-drift-allowlist.json — it is scanned from the FILESYSTEM, so a stray scratch ` +
  `file in your tree trips it; delete anything throwaway before you finish. Every state-changing service ` +
  `appends a DomainEvent. A field that is ALWAYS submitted cannot be read by presence — a DISABLED control ` +
  `posts nothing at all, which r203 found reading as "false" and refusing a save nobody had changed. If a ` +
  `guard asserts the decision you are reversing, UPDATE the case. THE COMMENT IS THE GUARD — if you falsify ` +
  `a documented invariant, fix EVERY statement of it, not just the code that reads it.\n`;

const gate =
  `GATE: \`npx tsc --noEmit\` clean · your new/changed tests green (namespaced) · \`pnpm build\` compiles. ` +
  `No dev server, no watch mode, nothing long-lived. Long output to a file with \`> log 2>&1\`, never a pipe. ` +
  `Never weaken or delete a test to go green. When green: \`git add -A\` and commit on your branch.\n`;

phase('Build');
phase('Verify');

const results = await pipeline(
  WORK,
  (w) => agent(
    `You are implementing APPROVED board item(s) ${w.ids.join(' + ')} — ${w.title}.\n\n` +
      `🔒 WORKTREE (made from main, node_modules symlinked, .env.local copied): ${WT}/r206-${w.slug} ` +
      `(branch build/r206-${w.slug}). \`cd\` there FIRST and confirm with \`pwd\` and ` +
      `\`git branch --show-current\` — this repo has shipped green gates for the wrong tree four times. Run ` +
      `every command from there. READ ${MAIN} freely; never edit it, never touch a sibling worktree.\n\n` +
      `TEST DB NAMESPACE \`${w.ns}\` on EVERY vitest run:\n    TEST_DB_NAMESPACE=${w.ns} pnpm vitest run test/<file>.test.ts\n` +
      `Never omit it, never invent another, never run the full suite.\n\n${house}` +
      (w.migration
        ? `MIGRATION: exactly one, ${w.migration}.\n`
        : `NO MIGRATION for your workstream. If the item cannot be built without one, STOP and return ` +
          `testsPass=false saying so — never allocate a number yourself.\n`) +
      `\n${gate}\n` +
      `THE APPROVED PLAN(S) — read each IN FULL before writing code:\n` +
      w.ids.map((id) => `    ${PLANS}/${id}.md`).join('\n') + `\n` +
      `Implement exactly the plan, scoped strictly to it.\n\n` +
      `⚠️ EVERY ONE OF THESE PLANS SAYS SOMETHING IS ALREADY BUILT, and on this board that has been true ` +
      `seventeen items running. VERIFY each such claim in the code before rebuilding or trusting it, and ` +
      `report what you confirmed in \`alreadyBuilt\` with file:line. Finding that most of your item already ` +
      `works is a GOOD outcome, not a failed one.\n\n${w.extra}\n\n` +
      `Return the schema fields honestly, including scopeCuts.`,
    { schema: BUILD_SCHEMA, phase: 'Build', label: `build:${w.slug}`, effort: 'xhigh' },
  ).then((b) => ({ w, b })),
  (prev) => {
    if (!prev?.b) return { w: prev?.w, b: null, v: null };
    const { w, b } = prev;
    if (!b.testsPass) { log(`build:${w.slug} RED — skipping verify`); return { w, b, v: null }; }
    return agent(
      `Adversarially review a change its author says is green. Find what a targeted test run structurally ` +
        `cannot see. Branch build/r206-${w.slug} in ${WT}/r206-${w.slug}; read it with ` +
        `\`git diff main...HEAD\`. READ-ONLY — no edits, and do NOT run the test suite (a second vitest ` +
        `wipes a sibling's databases).\n\n` +
        `Check: i18n keys in all six catalogues with matching placeholders and the right namespace; new or ` +
        `moved guarded pages have their lib/permissions.ts column; new core/ files import the pack facade; ` +
        `DomainEvents on state changes; migration present ONLY if allocated (${w.migration ?? 'NONE'}), ` +
        `journal APPENDED not re-sorted; no test weakened, deleted or narrowed; a guard asserting the ` +
        `opposite UPDATED not deleted; THE COMMENT IS THE GUARD — does the diff falsify a documented ` +
        `invariant anywhere and leave the sentence standing; presence-vs-value on form fields, including ` +
        `DISABLED controls that post nothing; RSC boundary risk; plan fidelity in BOTH directions.\n` +
        (w.slug === 'leaveess'
          ? `SPECIFICALLY: did it add a THIRD way to express leave-type visibility beside visible_to_employee ` +
            `and employee_can_apply? r203 just removed exactly that duplication and a new one would pass ` +
            `every test.\n`
          : '') +
        `\nThe author's summary, to test rather than trust:\n${b.summary}\n\n` +
        `Report only what you can point at in the diff. "No findings" is valid and useful.`,
      { schema: VERIFY_SCHEMA, phase: 'Verify', label: `verify:${w.slug}`, effort: 'high' },
    ).then((v) => {
      const n = (v?.findings || []).filter((f) => f.severity === 'blocker').length;
      log(`verify:${w.slug} → ${v?.verdict ?? 'none'}${n ? ` (${n} blocker(s))` : ''}`);
      return { w, b, v };
    });
  },
);

const out = results.filter(Boolean).map((r) => ({
  slug: r.w?.slug, ids: r.w?.ids, branch: `build/r206-${r.w?.slug}`,
  testsPass: !!r.b?.testsPass, commitSha: r.b?.commitSha || '', migrationTag: r.b?.migrationTag || '',
  diffstat: r.b?.diffstat || '', summary: r.b?.summary || '', alreadyBuilt: r.b?.alreadyBuilt || '',
  scopeCuts: r.b?.scopeCuts || [], blockers: r.b?.blockers || [],
  verdict: r.v?.verdict || 'not-verified', findings: r.v?.findings || [],
}));
log(`r206: ${out.filter((o) => o.testsPass).length}/${out.length} green · ${out.filter((o) => o.verdict === 'ship').length} ship`);
return out;

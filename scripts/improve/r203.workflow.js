/**
 * r203 — the only two approved items that are genuinely unstarted, built as ONE workstream.
 *
 * 5570c6a2 ("hide Document Required from the employee's leave-type dropdown") and 464b58e6 ("simplify
 * employee leave visibility and application settings") are the same screens and the same concern: what an
 * employee sees when they pick a leave type. Split across two worktrees they would collide on every file;
 * together they are one coherent change.
 *
 * The other six approved items are NOT here and that is deliberate — four are built and held on live
 * blockers, one must be re-planned rather than built, and one awaits an owner decision. See HANDOFF.
 */
export const meta = {
  name: 'r203',
  description: 'Build the two unstarted approved items as one ESS-leave workstream',
  phases: [{ title: 'Build', detail: 'one worktree, two board items, one concern' }, { title: 'Verify', detail: 'adversarial pass' }],
};

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    testsPass: { type: 'boolean' }, summary: { type: 'string' }, diffstat: { type: 'string' },
    commitSha: { type: 'string' }, scopeCuts: { type: 'array', items: { type: 'string' } },
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

phase('Build');
phase('Verify');

const built = await agent(
  `You are implementing TWO APPROVED board items as ONE change: \`5570c6a2\` (hide the "Document Required" ` +
    `text from the employee's leave-type dropdown) and \`464b58e6\` (simplify employee leave visibility and ` +
    `application settings). They are the same screens and the same concern — what an employee sees when ` +
    `they pick a leave type — so build them coherently, not as two patches.\n\n` +
    `🔒 WORKTREE (made from main, node_modules symlinked, .env.local copied): ${WT}/r203-essleave ` +
    `(branch build/r203-essleave). \`cd\` there FIRST and confirm with \`pwd\` and ` +
    `\`git branch --show-current\` — this repo has shipped green gates for the wrong tree four times. Run ` +
    `every command from there. READ ${MAIN} freely; never edit it.\n\n` +
    `TEST DB NAMESPACE \`r203ess\` on EVERY vitest run:\n    TEST_DB_NAMESPACE=r203ess pnpm vitest run test/<file>.test.ts\n` +
    `Never omit it, never invent another, never run the full suite — the parent gates once, alone.\n\n` +
    `THE APPROVED PLANS — read BOTH in full before writing code:\n` +
    `    ${PLANS}/5570c6a2.md\n    ${PLANS}/464b58e6.md\n` +
    `Both say NO MIGRATION and no data change, and none is allocated. If you conclude otherwise, STOP and ` +
    `return testsPass=false — never allocate a number yourself.\n\n` +
    `⚠️ THE 464b58e6 PLAN NAMES THE TRAP EXPLICITLY, AND IT IS THE ONE THAT MATTERS: the single hidden ` +
    `mechanism is \`visible_to_employee\`, resolved by resolvePlacement (lib/leave-groups.ts). ` +
    `\`ess_placement\` is CHECK-constrained to primary|secondary, so 'hidden' is NEVER stored. **Do not add ` +
    `a second hidden column and do not reroute hidden through employee_can_apply.** r199 shipped 5ff7daff, ` +
    `which made that same resolvePlacement default ROLE-aware — read it before you touch the function, ` +
    `because a second way to express one idea is exactly what this pair is meant to remove.\n\n` +
    `HOUSE RULES: Next.js 16 — read node_modules/next/dist/docs/ before anything framework-shaped. Use ` +
    `\`graphify explain\` / \`graphify affected\` from ${MAIN} before grepping cold. i18n in all six locales, ` +
    `resolved from the namespace the screen actually reads. A new guarded page.tsx needs its ` +
    `lib/permissions.ts column. A new core/ file imports packs/<pack>/service, never a pack implementation, ` +
    `and NEVER edit test/pack-drift-allowlist.json — it is scanned from the FILESYSTEM, so a stray scratch ` +
    `file in your tree trips it; delete anything throwaway before you finish. Every state-changing service ` +
    `appends a DomainEvent. A field that is ALWAYS submitted cannot be read by presence. If a guard asserts ` +
    `the decision you are reversing, UPDATE the case, never delete it. THE COMMENT IS THE GUARD — if you ` +
    `falsify a documented invariant, fix EVERY statement of it, not just the code that reads it.\n\n` +
    `GATE: \`npx tsc --noEmit\` clean · your new/changed tests green (namespaced) · \`pnpm build\` compiles. ` +
    `No dev server, no watch mode. Long output to a file with \`> log 2>&1\`, never a pipe. Never weaken or ` +
    `delete a test to go green. When green: \`git add -A\` and commit on your branch.\n\n` +
    `Where a plan says something already exists, VERIFY it in the code before rebuilding or trusting it — ` +
    `on this board seventeen consecutive items have reported something already built.`,
  { schema: BUILD_SCHEMA, phase: 'Build', label: 'build:essleave', effort: 'xhigh' },
);

let verify = null;
if (built?.testsPass) {
  verify = await agent(
    `Adversarially review a change its author says is green. Find what a targeted test run structurally ` +
      `cannot see. Branch build/r203-essleave in ${WT}/r203-essleave; read it with ` +
      `\`git diff main...HEAD\`. READ-ONLY — no edits, and do NOT run the test suite.\n\n` +
      `Check: i18n keys in all six catalogues with matching placeholders and the right namespace; no ` +
      `migration was added (none is allocated); a new guarded page has its lib/permissions.ts column; new ` +
      `core/ files import the pack facade; DomainEvents on state changes; no test weakened, deleted or ` +
      `narrowed; a guard asserting the opposite UPDATED not deleted; THE COMMENT IS THE GUARD — does the ` +
      `diff falsify a documented invariant anywhere and leave the sentence standing; presence-vs-value on ` +
      `form fields; RSC boundary risk; plan fidelity in BOTH directions against ${PLANS}/5570c6a2.md and ` +
      `${PLANS}/464b58e6.md.\n` +
      `SPECIFICALLY: did it add a SECOND way to express "hidden"? The plans are explicit that ` +
      `visible_to_employee is the one mechanism, that ess_placement cannot store 'hidden', and that ` +
      `employee_can_apply must not be repurposed. A duplicate mechanism is the exact defect this pair ` +
      `exists to remove, and it would pass every test.\n\n` +
      `The author's summary, to test rather than trust:\n${built.summary}\n\n` +
      `Report only what you can point at in the diff. "No findings" is valid and useful.`,
    { schema: VERIFY_SCHEMA, phase: 'Verify', label: 'verify:essleave', effort: 'high' },
  );
  const n = (verify?.findings || []).filter((f) => f.severity === 'blocker').length;
  log(`verify:essleave → ${verify?.verdict ?? 'none'}${n ? ` (${n} blocker(s))` : ''}`);
} else {
  log('build:essleave RED — skipping verify');
}

return {
  slug: 'essleave', ids: ['5570c6a2', '464b58e6'], branch: 'build/r203-essleave',
  testsPass: !!built?.testsPass, commitSha: built?.commitSha || '', diffstat: built?.diffstat || '',
  summary: built?.summary || '', scopeCuts: built?.scopeCuts || [], blockers: built?.blockers || [],
  verdict: verify?.verdict || 'not-verified', findings: verify?.findings || [],
};

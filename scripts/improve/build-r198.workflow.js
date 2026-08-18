/**
 * r198 — build the three genuinely-buildable approved items, and RE-PLAN the five items that need words
 * rather than code (two contested, three newly raised).
 *
 * THE TWO CONTESTED ITEMS ARE MINE. r196 shipped 6b134681 + 417d4937 and the reporter tested and pushed
 * back. The diagnosis below is measured on production, not guessed, and the re-plans must lead with it:
 * their reproduction steps could never have worked, and saying so plainly is the point.
 */
export const meta = {
  name: 'build-r198',
  description: 'Build three approved items; re-plan two contested and three new open items',
  phases: [
    { title: 'Build', detail: 'three approved items, one worktree each' },
    { title: 'Plan', detail: 'consultant-readable plans for two contested + three new items' },
    { title: 'Verify', detail: 'adversarial pass per built workstream' },
  ],
};

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    testsPass: { type: 'boolean' },
    summary: { type: 'string' },
    diffstat: { type: 'string' },
    commitSha: { type: 'string' },
    scopeCuts: { type: 'array', items: { type: 'string' } },
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
    planFidelity: { type: 'string' },
    verdict: { type: 'string', enum: ['ship','fix-first','reject'] },
  },
  required: ['findings','verdict'],
};

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    plan: { type: 'string', description: 'The full board plan as PLAIN TEXT. No Markdown at all.' },
    mockupHtml: { type: 'string', description: 'Absolute path of the mockup HTML file you wrote, or empty if a mockup genuinely cannot help.' },
    verdictLine: { type: 'string', description: 'The VERDICT/SIZE line, repeated for the operator summary.' },
  },
  required: ['plan'],
};

const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const MAIN = `${WT}/mainwt`;
const PLANS = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad/plans';
const MOCKUPS = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad/mockups';

const DIAGNOSIS =
  `MEASURED ON PRODUCTION 2026-08-18, and it explains BOTH contested items. Do not re-derive it; do verify ` +
  `anything you intend to state as fact.\n` +
  `  · The ANGPOW pay item is code BOOO1, kind=allowance, display_category='bonus', ` +
  `pcb_remuneration_type='additional'.\n` +
  `  · Three ANGPOW individual transactions exist, all pay_period 2026-01, RM500 each. The one for A0002 ` +
  `was re-entered on 2026-08-18 and WAS consumed by batch 97921ff0 (ISEDECOR BINA, 2026-01, run_type ` +
  `BONUS, processed, 19 employees). A0002's payslip on that batch shows bonus = 500.00 — THE MONEY ` +
  `ARRIVED CORRECTLY.\n` +
  `  · That payslip carries NO componentLines stamp at all. And it is not alone: across production, ` +
  `REGULAR runs have 62 payslips of which 24 carry a stamp, and BONUS runs have 19 payslips of which ` +
  `**ZERO** carry a stamp. The additional/bonus run path never writes componentLines.\n` +
  `  · Therefore there is nothing on a bonus payslip that says "ANGPOW", and every screen can only fall ` +
  `back to the box label — which reads BONUS. r196's 6b134681 work reads componentLines, so it is ` +
  `STRUCTURALLY INERT on bonus runs. The reporter's three attempts (reprocess, delete and re-enter, ` +
  `re-enter via Individual Transaction) could not have worked, because none of them causes a bonus run to ` +
  `write a stamp. THE REPORTER IS RIGHT AND OUR FIX DID NOT REACH THEIR CASE.\n` +
  `  · For 417d4937: the A0020 DIRECTOR FEE line the reporter says is wrong sits on the SpaceX 2026-08 ` +
  `payslip's stamp, and its individual transaction is attached to that batch (batch_id set) but ` +
  `consumed_batch_id is NULL — i.e. the payslip shows it as paid while the ledger does not mark it ` +
  `consumed. Establish whether that is the defect they are seeing, or a second one beside it.`;

const BUILDS = [
  { slug: 'remove', ns: 'r198remove', id: '9066bd6c', title: 'Payroll Process — Back navigation + Remove Employee Payroll',
    extra: `The approved plan is one I wrote, so treat its claims as claims: it says Back exists on 17 of 35 ` +
      `payroll screens and that removal is the per-employee slice of resetProcessedBatch's unwind plus the ` +
      `subset path's delta accounting. VERIFY both before relying on them. The plan's own refusals matter: ` +
      `removal must refuse the LAST payslip on a run (that is a Reset) and refuse on a closed month, and ` +
      `the full removed payslip must be snapshotted because after removal there is no other copy.` },
  { slug: 'personnel', ns: 'r198personnel', id: '4ea70bb7', title: 'Personnel Management rename + service duration to the day',
    extra: `Smallest item in the round. The trap is named in the plan and is real: people.list.title is ` +
      `rendered by BOTH the admin list and the employee-facing directory, so renaming it in place renames a ` +
      `screen the item never mentioned. Add a separate admin title key. serviceYearsMonthsDaysAt already ` +
      `exists and is already live as "Year of Service" — reuse it, do not write a second one.` },
  { slug: 'cp39', ns: 'r198cp39', id: 'e0cd4583', title: 'CP39 — MTD/PCB printed form',
    extra: `CP39 IS NOT CP22 — do not reuse CP22's artwork or its assertions. A triage agent established ` +
      `that my.cp39 exists today only as a figures table plus a submission text file, with no printed form, ` +
      `and recommended scoping this as a printed-form layer mirroring the Borang A three-layer split that ` +
      `shipped in r194 (a pure model module, a renderer, and a route). Follow that shape. Read HANDOFF's ` +
      `statutory-form section FIRST — it records that agency reference attachments in this repo have turned ` +
      `out to be completed forms from another payroll system rather than official artwork, which governs ` +
      `what fidelity value you may claim.` },
];

const NEEDS_PLAN = [
  { id: '6b134681', kind: 'contested', title: 'Pay Item Code + Description in transaction results' },
  { id: '417d4937', kind: 'contested', title: 'Pay item amount mismatch across transactions/results/payslip' },
  { id: '6df24751', kind: 'open', title: 'Payroll Settings — redesign Payroll Cycles / Pay Schedule' },
  { id: 'bd14b7e2', kind: 'open', title: 'Payroll Transaction View — standardize employee search UI' },
  { id: '4509d2b8', kind: 'open', title: 'Relocate Holidays to System Settings' },
];

const house =
  `HOUSE RULES: Next.js 16 — read node_modules/next/dist/docs/ before anything framework-shaped. Use ` +
  `\`graphify explain\` / \`graphify affected\` from ${MAIN} (read-only) before grepping cold. i18n in all six ` +
  `locales, resolved from the namespace the screen reads. A new guarded page.tsx needs a column in ` +
  `lib/permissions.ts. A new core/ file imports packs/<pack>/service, never a pack implementation, and ` +
  `NEVER edit test/pack-drift-allowlist.json — it is scanned from the FILESYSTEM, so even a stray scratch ` +
  `file in the tree trips it. Every state-changing service appends a DomainEvent. A field that is always ` +
  `submitted cannot be read by presence. If a guard asserts the decision you are reversing, UPDATE the case. ` +
  `THE COMMENT IS THE GUARD — if you falsify a documented invariant, fix EVERY statement of it.\n` +
  `NO MIGRATION IS ALLOCATED TO ANY WORKSTREAM THIS ROUND. 0442 is already claimed by an unmerged branch. ` +
  `If you conclude your item cannot be built without one, STOP and return testsPass=false saying so.\n`;

const gate =
  `GATE: \`npx tsc --noEmit\` clean · your new/changed tests green (namespaced) · \`pnpm build\` compiles. ` +
  `No dev server, no watch mode, nothing long-lived; long output to a file with \`> log 2>&1\`, never a pipe. ` +
  `Never weaken or delete a test to go green. When green: \`git add -A\` and commit on your branch.\n`;

phase('Build');
phase('Plan');
phase('Verify');

// ── Plans: five items that need words, not code ──────────────────────────────────────────────────────
const plans = parallel(NEEDS_PLAN.map((it) => () =>
  agent(
    `Write the board plan for item \`${it.id}\` (${it.title}). It is currently **${it.kind}**.\n\n` +
      `Read the item IN FULL first: ${PLANS}/${it.id}.md — it carries the reporter's words, and for a ` +
      `contested item the CONTEST REASON (their push-back) and the PREVIOUS PLAN that failed them.\n\n` +
      (it.kind === 'contested'
        ? `THIS IS A RE-PLAN OF WORK WE SHIPPED AND THEY REJECTED. Lead with what was actually wrong. Here ` +
          `is the measured diagnosis:\n${DIAGNOSIS}\n\nYour plan must (a) say plainly that the earlier fix ` +
          `did not reach their case and why, without excuses, (b) state what will actually change, and ` +
          `(c) not promise anything you have not verified in the code.\n\n`
        : `This item has never been planned. Investigate the codebase before proposing anything — several ` +
          `items on this board turned out to be already built, mislabelled, or on an adjacent screen. State ` +
          `plainly if part of it already works.\n\n`) +
      `FORMAT — read ${MAIN}/.claude/skills/feedback-plan/SKILL.md and follow it exactly. The board renders ` +
      `the plan RAW: no Markdown, no asterisks, no backticks, no pipes, no headers. UPPERCASE section ` +
      `labels, "- " bullets, blank lines between sections. Business language above a plain dashed line; ` +
      `ALL technical detail in a BUILD NOTES trailer below it. The reader is a non-technical business ` +
      `consultant who will press approve or reject.\n` +
      `NEVER ask the reporter to choose between options — approve carries no payload, so a plan that asks a ` +
      `question can never be answered. Pick the best course, recommend it, and say "reject with a reason if ` +
      `you'd rather have X".\n\n` +
      `MOCKUP: write a self-contained HTML mockup to ${MOCKUPS}/${it.id}.html (create the directory if ` +
      `needed). Everything inline — no external CSS, fonts or images; the renderer blocks them and fails ` +
      `loudly. Use the reporter's OWN measured data where you have it, never invented employees or figures. ` +
      `A mockup is a PROMISE: draw only what will be built and leave the uncertain parts in words. Prefer ` +
      `BEFORE and AFTER where the screen already exists. Return its absolute path.\n\n` +
      `Work read-only in ${MAIN} — investigate freely, but do not edit, commit, or touch any worktree.`,
    { schema: PLAN_SCHEMA, phase: 'Plan', label: `plan:${it.id}`, effort: 'high' },
  ).then((p) => ({ id: it.id, kind: it.kind, title: it.title, ...p }))
));

// ── Builds ───────────────────────────────────────────────────────────────────────────────────────────
const built = await pipeline(
  BUILDS,
  (w) => agent(
    `You are implementing APPROVED board item \`${w.id}\` in the ai-hr codebase.\n\nWORKSTREAM: ${w.title}\n\n` +
      `🔒 YOUR WORKTREE (already made from main, node_modules symlinked, .env.local copied): ` +
      `${WT}/r198-${w.slug} (branch build/r198-${w.slug}). \`cd\` there FIRST and confirm with \`pwd\` and ` +
      `\`git branch --show-current\` — this repo has shipped green gates for the wrong tree four times. Run ` +
      `every command from there. You may READ ${MAIN}; never edit it, never touch a sibling worktree.\n\n` +
      `TEST DATABASE NAMESPACE \`${w.ns}\` on EVERY vitest run:\n    TEST_DB_NAMESPACE=${w.ns} pnpm vitest run test/<file>.test.ts\n` +
      `Never omit it, never invent another, never run the full suite — the parent gates once, alone.\n\n` +
      `${house}\n${gate}\n` +
      `THE APPROVED PLAN — read it IN FULL with the Read tool before writing code: ${PLANS}/${w.id}.md\n` +
      `Implement exactly it, scoped strictly to it. Where the plan says something already exists, VERIFY ` +
      `that in the code before rebuilding it or trusting it.\n\n${w.extra}\n\n` +
      `Return the schema fields honestly, including scopeCuts for anything you chose not to build.`,
    { schema: BUILD_SCHEMA, phase: 'Build', label: `build:${w.slug}`, effort: 'xhigh' },
  ).then((b) => ({ w, b })),
  (prev) => {
    if (!prev?.b) return { w: prev?.w, b: null, v: null };
    const { w, b } = prev;
    if (!b.testsPass) { log(`build:${w.slug} RED — skipping verify`); return { w, b, v: null }; }
    return agent(
      `Adversarially review a change its author says is green. Find what a TARGETED test run structurally ` +
        `cannot see. Branch build/r198-${w.slug} in ${WT}/r198-${w.slug}; read it with ` +
        `\`git diff main...HEAD\`. READ-ONLY — no edits, no test suite (a second vitest wipes a sibling's DBs).\n\n` +
        `Check: i18n keys in all six catalogues with matching placeholders and the right namespace; a new ` +
        `guarded page has a lib/permissions.ts column; new core/ files import the pack facade; DomainEvents ` +
        `on state changes; NO migration was added (none is allocated); no test weakened, deleted or narrowed; ` +
        `an existing guard asserting the opposite was UPDATED not deleted; THE COMMENT IS THE GUARD — does ` +
        `the diff falsify a documented invariant and leave the sentence standing anywhere in the repo; ` +
        `presence-vs-value on form fields; RSC boundary risk; and plan fidelity against ${PLANS}/${w.id}.md ` +
        `in BOTH directions (missing, or unrequested extra).\n\n` +
        `The author's summary, to test rather than trust:\n${b.summary}\n\n` +
        `Report only what you can point at in the diff. "No findings" is valid. verdict=ship if nothing ` +
        `needs changing before the full gate.`,
      { schema: VERIFY_SCHEMA, phase: 'Verify', label: `verify:${w.slug}`, effort: 'high' },
    ).then((v) => {
      const n = (v?.findings || []).filter((f) => f.severity === 'blocker').length;
      log(`verify:${w.slug} → ${v?.verdict ?? 'none'}${n ? ` (${n} blocker(s))` : ''}`);
      return { w, b, v };
    });
  },
);

const planned = await plans;

const builds = built.filter(Boolean).map((r) => ({
  slug: r.w?.slug, id: r.w?.id, branch: `build/r198-${r.w?.slug}`,
  testsPass: !!r.b?.testsPass, commitSha: r.b?.commitSha || '', diffstat: r.b?.diffstat || '',
  summary: r.b?.summary || '', scopeCuts: r.b?.scopeCuts || [], blockers: r.b?.blockers || [],
  verdict: r.v?.verdict || 'not-verified', findings: r.v?.findings || [],
}));

log(`r198: ${builds.filter((b) => b.testsPass).length}/${builds.length} green · ` +
  `${builds.filter((b) => b.verdict === 'ship').length} ship · ` +
  `${(planned || []).filter(Boolean).length} plans written`);

return { builds, plans: (planned || []).filter(Boolean) };

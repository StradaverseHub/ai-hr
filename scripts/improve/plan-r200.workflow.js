/**
 * Plan the five newly raised items. INVESTIGATION AND WRITING ONLY — no code, no tests, no database.
 *
 * ⚠️ A FULL GATE IS RUNNING ON THE SAME MACHINE while these agents work. They must not run vitest, must
 * not start a dev server, and must not touch Postgres: a second vitest wipes the gate's worker databases
 * and the RAM disk has already been exhausted once today. Reading files and querying the code graph is
 * all any of these agents needs.
 */
export const meta = {
  name: 'plan-r200',
  description: 'Write consultant-readable plans with mockups for the five newly raised items',
  phases: [{ title: 'Plan', detail: 'investigate, then write a plain-text plan and a mockup per item' }],
};

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    plan: { type: 'string', description: 'The full board plan as PLAIN TEXT. No Markdown anywhere.' },
    mockupHtml: { type: 'string', description: 'Absolute path of the mockup HTML you wrote, or empty if a mockup genuinely cannot help.' },
    verdictLine: { type: 'string' },
    alreadyBuilt: { type: 'string', description: 'Anything the item asks for that ALREADY works today, with file:line. Empty if none.' },
  },
  required: ['plan'],
};

const MAIN = '/Users/zenlam/Projects/ai-hr/.claude/worktrees/mainwt';
const PLANS = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad/plans';
const MOCKUPS = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad/mockups';

const STATUTORY_CONTEXT =
  `⚠️ READ ${MAIN}/HANDOFF.md's statutory-form section BEFORE forming any opinion — it records four ` +
  `findings from the round that BUILT these forms, and this item cannot be planned honestly without them:\n` +
  `  · THE EPF AND SOCSO REFERENCE ATTACHMENTS ARE NOT AGENCY ARTWORK. Both are Developer Express ` +
  `(DXperience) outputs — COMPLETED FORMS FROM ANOTHER PAYROLL SYSTEM, with the auto-filled values ` +
  `highlighted. The highlighting was used as the field map. But it means neither form can ever claim ` +
  `fidelity 'official': PERKESO and KWSP publish no blank template for these. The shipped forms use a ` +
  `shared 'agency-layout' fidelity — OUR drawing of the agency's layout.\n` +
  `  · So if this item asks us to match "the official template", the honest answer may be that there is no ` +
  `official template to match, and that what the reporter is comparing against is another vendor's ` +
  `rendering. SAY THAT PLAINLY if the evidence supports it — do not promise a fidelity we cannot source.\n` +
  `  · If the reporter has attached a NEW specimen, treat it the same way: establish what it actually is ` +
  `before treating it as authority.\n` +
  `  · The +1-month rule distinguishes the two forms: Borang A is the cycle month PLUS ONE; Borang 8A is ` +
  `the cycle month directly. Both are pinned by a joint test that fails if they ever agree.\n`;

const ITEMS = [
  { id: '16f2aac1', title: 'Regenerate the Borang 8A PDF template to match PERKESO', extra: STATUTORY_CONTEXT },
  { id: 'cc9f9420', title: "Re-configure the EPF Borang A template to match KWSP's official layout", extra: STATUTORY_CONTEXT },
  { id: '5570c6a2', title: 'Hide "Document Required" text from the Leave Type dropdown for employees',
    extra: `Small and ESS-facing. r199 shipped 5ff7daff, which made the ESS leave placement default ` +
      `ROLE-aware; check whether this text is already conditional on something before proposing a new flag.` },
  { id: '7ad37961', title: 'TP1 Relief — redesign and complete the LHDN TP1 (2026) form',
    extra: `A statutory form with its own screens under app/payroll/transactions/tp1. Establish what is ` +
      `already built before proposing a redesign — TP1 has shipped work behind it, and the reporter says ` +
      `"complete", which usually means specific missing reliefs rather than a rebuild.` },
  { id: '464b58e6', title: 'Simplify employee leave visibility and application settings',
    extra: `This is adjacent to 5570c6a2 and to the ESS placement work 5ff7daff shipped in r199 ` +
      `(role-aware default placement, primary vs secondary vs hidden). Read that before proposing a new ` +
      `settings model — the risk here is inventing a second way to express what one column already says.` },
];

phase('Plan');

const results = await parallel(ITEMS.map((it) => () =>
  agent(
    `Write the board plan for newly raised item \`${it.id}\` — ${it.title}.\n\n` +
      `⚠️ READ-ONLY, AND THIS MATTERS RIGHT NOW: a full vitest gate is running on this machine. Do NOT run ` +
      `vitest, do NOT start a dev server, do NOT connect to Postgres, do NOT run any script that touches a ` +
      `database. A second vitest wipes the gate's worker databases and today's RAM disk has already been ` +
      `exhausted once. Read files, and use \`graphify explain\` / \`graphify query\` / \`graphify affected\` ` +
      `from ${MAIN} — that is all you need. Do not edit, stage or commit anything.\n\n` +
      `THE ITEM: ${PLANS}/${it.id}.md — the reporter's own words. Read it in full first.\n\n` +
      `INVESTIGATE BEFORE PROPOSING. On this board, items have repeatedly turned out to be already built, ` +
      `mislabelled, on an adjacent screen, or wider than reported. Two of the last nine were exact ` +
      `duplicates of shipped work. Establish what exists today with file:line evidence, and report it in ` +
      `\`alreadyBuilt\`. A plan that says "this already works, here is where" is a good outcome, not a ` +
      `failure.\n\n${it.extra}\n\n` +
      `FORMAT — read ${MAIN}/.claude/skills/feedback-plan/SKILL.md and follow it exactly. The board renders ` +
      `the plan RAW: no Markdown, no asterisks, no backticks, no pipes, no headers, no tables. UPPERCASE ` +
      `section labels, "- " bullets, blank lines between sections. Business language above a plain dashed ` +
      `line; ALL technical detail in a BUILD NOTES trailer below it. The reader is a non-technical business ` +
      `consultant who will press approve or reject.\n` +
      `NEVER ask the reporter to choose between options — approve carries no payload, so a plan that asks a ` +
      `question can never be answered. Pick the best course, recommend it, and say "reject with a reason if ` +
      `you would rather have X".\n\n` +
      `MOCKUP: write a self-contained HTML mockup to ${MOCKUPS}/${it.id}.html (create the directory if ` +
      `needed). Everything inline — no external CSS, fonts or images; the renderer blocks them and fails ` +
      `loudly. Use the reporter's OWN data where you have it and never invent employees or figures. A ` +
      `mockup is a PROMISE: draw only what will be built, and keep anything uncertain in words. Prefer ` +
      `BEFORE and AFTER where the screen already exists. Return its absolute path.`,
    { schema: PLAN_SCHEMA, phase: 'Plan', label: `plan:${it.id}`, effort: 'high' },
  ).then((p) => ({ id: it.id, title: it.title, ...p }))
));

const out = (results || []).filter(Boolean);
log(`plan-r200: ${out.length}/${ITEMS.length} plans · ${out.filter((p) => p.mockupHtml).length} with mockups · ` +
  `${out.filter((p) => (p.alreadyBuilt || '').trim()).length} report something already built`);
return out;

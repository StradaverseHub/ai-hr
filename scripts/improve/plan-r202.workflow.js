/**
 * Plan the four open items. INVESTIGATION AND WRITING ONLY — no code, no tests, no database.
 *
 * Two of these carry measured production facts that a planning agent cannot obtain for itself (it has no
 * box access), and one of them CORRECTS this repo's own handoff note. They are supplied below.
 */
export const meta = {
  name: 'plan-r202',
  description: 'Plan the four open items, with the production evidence each needs',
  phases: [{ title: 'Plan', detail: 'investigate the tree, then write a plain-text plan and a mockup' }],
};

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    plan: { type: 'string' },
    mockupHtml: { type: 'string' },
    verdictLine: { type: 'string' },
    alreadyBuilt: { type: 'string' },
    premiseCheck: { type: 'string', description: 'Is the reporter\'s stated premise actually true? Say so plainly, with file:line or the supplied production evidence.' },
  },
  required: ['plan'],
};

const MAIN = '/Users/zenlam/Projects/ai-hr/.claude/worktrees/mainwt';
const S = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad';
const PLANS = `${S}/plans`;
const MOCKUPS = `${S}/mockups`;

const ITEMS = [
  {
    id: '70ac09ef', title: 'Investigate Medical and Hospitalization leave balances showing zero',
    extra:
      `⚠️ I MEASURED THIS ON PRODUCTION FOR YOU — you have no box access, and this CORRECTS the repo's own\n` +
      `handoff note, so do not repeat that note as fact:\n` +
      `  · HOSPITALIZATION: **35 leave_ledger rows exist**, all entry_type 'accrual', effective 2026-01-01\n` +
      `    through 2026-07-27, and they sum to **0.00 days**. The engine RAN and granted nothing.\n` +
      `  · SICK (Medical Leave): **0 ledger rows at all**.\n` +
      `  · UPM (Unpaid Medical): 0 rows.\n` +
      `HANDOFF.md says both read 0.00 "because no rows exist, not because something granted zero". That is\n` +
      `TRUE for Medical and FALSE for Hospitalization, and the difference points at two different causes.\n\n` +
      `Where to look, and why: the c8052ae3 leave reset (2026-08-12) archived and deleted 147 leave_ledger\n` +
      `rows under capture tag c8052ae3-2026-08-12; the record is at /admin/leave/entitlements/ledger-archive.\n` +
      `Separately, r199's 31e39d74 work found that openLeaveYear writes NO row for an EARNED accrual method,\n` +
      `and writes a zero/no_entitlement outcome when days <= 0 — "reachable whenever a table resolves for the\n` +
      `employee but bandFor returns null because their service length falls in a band gap". Thirty-five rows\n` +
      `granting exactly zero is that shape. Establish WHICH cause applies to each type from the code and the\n` +
      `configuration, and say plainly if the answer is "this is the reset you approved" for one and a real\n` +
      `defect for the other. The reporter asked us to INVESTIGATE — a plan that reports the finding and\n` +
      `recommends the smallest correct action is exactly right here; do not invent a feature.`,
  },
  {
    id: '65e2d5de', title: 'Payroll Process — improve Reset / Reprocess workflow and full width',
    extra:
      `⚠️ SOMETHING THE REPORTER MAY NOT HAVE SEEN YET. Hours ago we deployed 9066bd6c, which added a\n` +
      `**Remove Employee Payroll** action (its own screen, search, multi-select, required reason, audited,\n` +
      `refusing to empty a run) plus Back navigation across the payroll screens — and 152fea7f, which\n` +
      `standardised the payroll screens to full width. Both are live on main. Read what shipped BEFORE\n` +
      `proposing anything: app/payroll/[batchId]/remove/, app/payroll/back.ts, lib/return-to.ts, and\n` +
      `test/payroll-screens-layout.test.ts. A large part of this request may already be answered, and saying\n` +
      `so with file:line is the most valuable thing this plan can do.`,
  },
  {
    id: '301d3f6b', title: 'Special Leave balance should reflect unused entitlement from last year',
    extra:
      `This is carry-forward, and leave has had heavy recent work: 46afcc48 shipped shared leave groups\n` +
      `(a pooled ceiling with its own ESS placement), 5ff7daff made the ESS placement default role-aware,\n` +
      `and 31e39d74 added the entitlement-status caption. Establish how carry-forward works today for\n` +
      `ordinary types before proposing anything for Special Leave — the risk is inventing a second mechanism\n` +
      `beside one that already exists. Check core/leave.ts's year-open path and any carry/expiry columns on\n` +
      `leave_type.`,
  },
  {
    id: 'e14334ef', title: 'Add a latest-action updated date field to the Feedback module',
    extra:
      `This one is about the feedback board ITSELF — the module this whole improvement loop runs on\n` +
      `(core/feedback.ts, db/schema.ts feedback_request, app/feedback). feedback_request already carries\n` +
      `created_at, updated_at and decided_at, and every transition appends a domain_event. So the data may\n` +
      `well already be there and the ask may be a DISPLAY change. Establish that before proposing a column.`,
  },
];

phase('Plan');

const results = await parallel(ITEMS.map((it) => () =>
  agent(
    `Write the board plan for open item \`${it.id}\` — ${it.title}.\n\n` +
      `⚠️ READ-ONLY. Do not edit, commit, or touch any worktree. Do NOT run vitest, do not start a dev\n` +
      `server, do not connect to Postgres. Read files and use \`graphify explain\` / \`graphify query\` /\n` +
      `\`graphify affected\` from ${MAIN}.\n\n` +
      `THE ITEM: ${PLANS}/${it.id}.md — the reporter's own words, read in full first.\n\n` +
      `⚠️ CHECK THE PREMISE BEFORE YOU PLAN. On this board the reported fault has repeatedly not been the\n` +
      `real one: items have turned out already built, mislabelled, on an adjacent screen, or the consequence\n` +
      `of something the reporter themselves approved. Of the last thirteen items planned here, EVERY ONE\n` +
      `reported something already built and two were exact duplicates of shipped work. Put your answer in\n` +
      `\`premiseCheck\` with file:line, and in \`alreadyBuilt\` list what already works. "This already works,\n` +
      `here is where" and "this is the change you approved on 12 August" are both excellent outcomes.\n\n` +
      `${it.extra}\n\n` +
      `FORMAT — read ${MAIN}/.claude/skills/feedback-plan/SKILL.md and follow it exactly. PLAIN TEXT only:\n` +
      `no Markdown, no asterisks, no backticks, no pipes, no headers, no tables. UPPERCASE section labels,\n` +
      `"- " bullets, blank lines between sections. Business language above a plain dashed line; ALL technical\n` +
      `detail in a BUILD NOTES trailer below it. The reader is a non-technical business consultant who will\n` +
      `press approve or reject. NEVER ask them to choose between options — approve carries no payload, so a\n` +
      `plan that asks a question can never be answered. Pick the best course, recommend it, and say "reject\n` +
      `with a reason if you would rather have X".\n\n` +
      `MOCKUP: write a self-contained HTML mockup to ${MOCKUPS}/${it.id}.html (everything inline; the\n` +
      `renderer blocks external requests and fails loudly). Use the reporter's own data and the measured\n` +
      `figures above where they apply — never invent employees or numbers. A mockup is a PROMISE: draw only\n` +
      `what will be built, and keep the uncertain parts in words. Where the honest answer is a FINDING rather\n` +
      `than a new screen, draw the finding — a before/after of what the balance shows and why. Return its\n` +
      `absolute path.`,
    { schema: PLAN_SCHEMA, phase: 'Plan', label: `plan:${it.id}`, effort: 'high' },
  ).then((p) => ({ id: it.id, title: it.title, ...p }))
));

const out = (results || []).filter(Boolean);
log(`plan-r202: ${out.length}/${ITEMS.length} plans · ${out.filter((p) => p.mockupHtml).length} mockups · ` +
  `${out.filter((p) => (p.alreadyBuilt || '').trim()).length} report something already built`);
return out;

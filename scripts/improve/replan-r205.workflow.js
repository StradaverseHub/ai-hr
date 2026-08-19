/**
 * r205 — re-plan the four contested items. INVESTIGATION AND WRITING ONLY.
 *
 * NONE OF THESE IS A REJECTION OF OUR DIAGNOSIS, and reading them as one would waste the round. Three are
 * follow-ons from work that landed, and one is a sharp product question we should answer rather than
 * deflect. The measured production evidence each needs is supplied below — a planning agent has no box
 * access and would otherwise guess.
 */
export const meta = {
  name: 'replan-r205',
  description: 'Re-plan four contested items, each with the production evidence its push-back needs',
  phases: [{ title: 'Re-plan', detail: 'read the push-back, verify against the tree, write the plan' }],
};

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    plan: { type: 'string' }, mockupHtml: { type: 'string' }, verdictLine: { type: 'string' },
    alreadyBuilt: { type: 'string' },
    whatTheyAreActuallyAsking: { type: 'string', description: 'One paragraph: is this a rejection, a follow-on, or a question? Say which, plainly.' },
  },
  required: ['plan'],
};

const MAIN = '/Users/zenlam/Projects/ai-hr/.claude/worktrees/mainwt';
const S = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad';
const PLANS = `${S}/plans`;
const MOCKUPS = `${S}/mockups`;

const ITEMS = [
  {
    id: '70ac09ef', title: 'Medical vs Hospitalization entitlement — why one needs Generate and the other does not',
    extra:
      `⚠️ THIS IS THE MOST IMPORTANT OF THE FOUR, AND IT IS NOT A REJECTION — IT IS A GOOD QUESTION WE SHOULD\n` +
      `ANSWER STRAIGHT. Our plan told them to set Hospitalization's earning method and then run Generate for\n` +
      `Medical. THEY DID, AND THE FIRST HALF WORKED. Measured on the box 2026-08-19:\n` +
      `  · HOSPITALIZATION: **70 leave_ledger rows totalling 2,100.00 days** — it was 35 rows at 0.00 when we\n` +
      `    planned this. Setting the earning method fired the cohort reprojection and credited everyone,\n` +
      `    exactly as the plan promised. SAY SO: they followed our instruction and it did what we said.\n` +
      `  · SICK (Medical): still **0 rows**, and Generate Entitlement reports every employee as FAILED.\n` +
      `  · Both types are now configured the SAME on the surface: accrual_method = grant_on_hire_prorated,\n` +
      `    accrual_unconfigured not set, role sick / hospitalization respectively.\n` +
      `  · THE DIFFERENCE I FOUND: **SICK has 6 rows in entitlement_template; HOSPITALIZATION has 1**\n` +
      `    (ANNUAL has 16). Six tables and one employee means something must CHOOSE, and r193's a9d0a94a\n` +
      `    work is about exactly that resolution path. Find the code that picks a template, work out what it\n` +
      `    does with six candidates for one person, and get the ACTUAL failure string the dry run emits —\n` +
      `    core/leave-generation.ts runs openLeaveYear with dryRun and there is a per-employee CSV\n` +
      `    (leaveGenerationRunCsv). The reporter asked for "the exact failure reason for each employee";\n` +
      `    give them the real string and what causes it, not a category.\n\n` +
      `THEIR SECOND QUESTION IS THE DEEPER ONE AND DESERVES A DIRECT ANSWER: why does Medical need a manual\n` +
      `Generate when Hospitalization reflected automatically? The mechanism is that\n` +
      `reprojectEntitlementForLeaveTypeCohort only reaches employees who ALREADY have a materialized accrual\n` +
      `row — Hospitalization had 35 zero rows to reproject, Medical has none, so saving its earning method\n` +
      `credits nobody. Verify that in the code. Then answer the question they actually asked: SHOULD saving\n` +
      `an earning method open the year for a type with no rows at all? If yes, that is the fix and it makes\n` +
      `the two behave alike; if no, explain why in business terms. Do not leave the asymmetry undefended.`,
  },
  {
    id: '3c88d593', title: 'Transaction Detail must show a transferred employee split per company',
    extra:
      `⚠️ NOT A REJECTION — READ IT CAREFULLY. Their opening sentence is "The payroll calculation is now able\n` +
      `to correctly split the payslip when an employee has a Company Transfer within the same payroll month."\n` +
      `That is r204 (main@774a7257, shipped 2026-08-19: cross-batch segments, payslip.coverage_from /\n` +
      `coverage_to via migration 0446, and a completeness control). THEY ARE CONFIRMING IT WORKS and asking\n` +
      `for the next thing: Transaction Detail still consolidates the month into one result, and they want it\n` +
      `broken out per company assignment.\n\n` +
      `THE BUILD THAT SHIPPED PREDICTED THIS ASK. Its own scopeCuts said: "No UI indicator on the Payroll\n` +
      `Process screen for 'Entity Transfer - Split Payroll' and no split grouping in Transaction View. Both\n` +
      `are read-side presentation of a fact the payslip now carries in columns." So the data is already\n` +
      `there — payslip.coverage_from / coverage_to, plus payslipSegmentOf — and this is a presentation\n` +
      `change, not a calculation one. Establish that in the code and say so plainly: nothing about their\n` +
      `figures changes.`,
  },
  {
    id: '301d3f6b', title: 'Six Special Leave types must share ONE 10-day pool',
    extra:
      `THEIR PUSH-BACK NARROWS THE ITEM TO ONE SENTENCE: the six leave types must not each get their own 10\n` +
      `days — they must share a single 10-day pool, so 2 days of Caregiver Leave takes the shared balance\n` +
      `from 10 to 8 whichever of the six was used.\n\n` +
      `THAT IS WHAT SHARED LEAVE GROUPS ARE. r193 shipped 46afcc48 — a pooled CEILING across several leave\n` +
      `types with its own ESS placement, migration 0438 — and r199's 5ff7daff and the r196 work touched the\n` +
      `same area. So the question is almost certainly NOT "build a pool" but "are these six configured into\n` +
      `one, and does the pool deduct the way they describe". Read core/leave.ts and the shared-group code,\n` +
      `establish whether a group exists for these six and whether consumption draws from the pooled ceiling,\n` +
      `and report it in alreadyBuilt with file:line. If the mechanism exists and is simply not configured,\n` +
      `the honest plan is a configuration instruction, not a build.`,
  },
  {
    id: 'ad965821', title: 'Hide ineligible leave types from the employee dropdown entirely',
    extra:
      `THEIR PUSH-BACK IS A NARROWING, and it is specific: filter the Leave Type dropdown by the employee's\n` +
      `configured eligibility conditions, and hide ineligible types COMPLETELY — no explanatory message, no\n` +
      `hint that they exist.\n\n` +
      `r203 shipped 5570c6a2 and 464b58e6 hours ago (main@eb9a2e2f): the "Document Required" suffix is gone\n` +
      `from that same dropdown, and Employee Visibility is now one tick box with one meaning\n` +
      `(visible_to_employee resolved by resolvePlacement in lib/leave-groups.ts; employee_can_apply is the\n` +
      `other). Read that first — the dropdown they are describing is the one we just changed. Establish\n` +
      `whether eligibility (entitlement_eligibility_rule) is already consulted when building those options,\n` +
      `and be careful not to propose a THIRD mechanism beside visible_to_employee and employee_can_apply;\n` +
      `removing that duplication is precisely what 464b58e6 just did.`,
  },
];

phase('Re-plan');

const results = await parallel(ITEMS.map((it) => () =>
  agent(
    `RE-PLAN contested board item \`${it.id}\` — ${it.title}.\n\n` +
      `⚠️ READ-ONLY. Do not edit, commit, or touch any worktree. Do not run vitest, do not start a dev\n` +
      `server, do not connect to Postgres. Read files and use \`graphify explain\` / \`graphify query\` /\n` +
      `\`graphify affected\` from ${MAIN}.\n\n` +
      `THE ITEM: ${PLANS}/${it.id}.md. It carries THE REPORTER PUSH-BACK first, then THE PLAN THEY\n` +
      `REJECTED, then their original words. **Read the push-back before anything else and take it\n` +
      `literally.** A contested item is not automatically a wrong plan — on this board these have turned\n` +
      `out to be follow-ons, narrowings and questions at least as often. Say which this one is in\n` +
      `\`whatTheyAreActuallyAsking\`, plainly, before you propose anything.\n\n` +
      `${it.extra}\n\n` +
      `FORMAT — read ${MAIN}/.claude/skills/feedback-plan/SKILL.md and follow it exactly. PLAIN TEXT only:\n` +
      `no Markdown, no asterisks, no backticks, no pipes, no headers, no tables. UPPERCASE section labels,\n` +
      `"- " bullets, blank lines between sections. Business language above a plain dashed line; ALL\n` +
      `technical detail in a BUILD NOTES trailer below it. NEVER ask them to choose between options —\n` +
      `approve carries no payload. Pick the best course, recommend it, and say "reject with a reason if you\n` +
      `would rather have X".\n\n` +
      `WHERE WE GOT SOMETHING RIGHT, SAY SO WITHOUT PREENING; WHERE WE GOT IT WRONG, SAY THAT PLAINLY AND\n` +
      `FIRST. A plan that opens by conceding is worth more than one that defends.\n\n` +
      `MOCKUP: write a self-contained HTML mockup to ${MOCKUPS}/${it.id}.html (everything inline; the\n` +
      `renderer blocks external requests and fails loudly). Use the reporter's own data and the measured\n` +
      `figures above — never invent employees or numbers. Draw only what will be built; where the honest\n` +
      `answer is an explanation rather than a screen, draw the explanation. Return its absolute path.`,
    { schema: PLAN_SCHEMA, phase: 'Re-plan', label: `replan:${it.id}`, effort: 'high' },
  ).then((p) => ({ id: it.id, title: it.title, ...p }))
));

const out = (results || []).filter(Boolean);
log(`replan-r205: ${out.length}/${ITEMS.length} · ${out.filter((p) => p.mockupHtml).length} mockups`);
return out;

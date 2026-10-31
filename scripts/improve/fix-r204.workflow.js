/**
 * r204 fix pass. No blockers this round — but one should-fix is mislabelled: cp39 introduces a NEW 500
 * PATH on two screens that previously degraded gracefully, which is a regression on shipped behaviour and
 * is treated here as a blocker. cp39 therefore gets a re-verify; the other two do not.
 */
export const meta = {
  name: 'fix-r204',
  description: 'Apply the r204 verify findings; re-verify both — one decides pay, the other explains tax',
  phases: [
    { title: 'Fix', detail: 'each branch addresses its own findings' },
    { title: 'Re-verify', detail: 'tp1 and bora — money-affecting and statutory-document changes' },
  ],
};

const FIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    testsPass: { type: 'boolean' },
    addressed: { type: 'array', items: { type: 'string' } },
    declined: { type: 'array', items: { type: 'string' } },
    commitSha: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['testsPass', 'addressed'],
};
const RE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    resolved: { type: 'array', items: { type: 'string' } },
    unresolved: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['ship', 'fix-first', 'reject'] },
  },
  required: ['verdict', 'resolved', 'unresolved'],
};

const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const MAIN = `${WT}/mainwt`;
// The APPROVED plan text is the `plan` field of these JSON payloads — the ones actually pushed to the
// board and approved this morning. scratchpad/plans/<id>.md is the PRE-REPLAN capture and is stale for
// every item in this round; pointing a fix agent at it would scope the work to a plan nobody approved.
const PLANJSON = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad';
// Findings are EMBEDDED, not read from disk: workflow scripts have no filesystem and no Node APIs, and
// an earlier `require('fs')` here killed the run at line 1 before any agent started.
const F = {
  "entity": [
    {
      "sev": "blocker",
      "trap": "outstanding after the r197 fix pass",
      "detail": "NEW BLOCKER \u2014 THE SPLIT-ONLY FAST PATH IS DECIDED FROM TODAY'S HISTORY, NOT FROM WHAT THE PAYSLIPS CLAIM, so cancelling or re-dating a recorded transfer after the outgoing run is processed removes the underpaid employment from the examined population entirely. Buildable sequence, all first-class supported operations: (1) Entity Transfer X Fiamma -> ISEDECOR effective 11 Aug is recorded; (2) Fiamma's August regular run is generated and X's payslip is written CORRECTLY as coverage_from=2026-08-01, coverage_to=2026-08-10, gross 2129.03; (3) the movement is CORRECTED \u2014 the effective date is re-dated to 11 September (an ordinary fat-finger fix), or the transfer is rolled back via reverseLegTx (core/movement.ts:2712 supersedes the assignment row, :2749 restores employment.company_id, and its own docstring confirms the assignment leg is reversed in the same transaction); (4) closeBatch on Fiamma's August run. entityChangedDuring and the resolver now see ONE segment for August, so X is dropped at segmentedCoverage's `splitIds` filter (core/payroll-coverage.ts:180) BEFORE any of the three arms is evaluated \u2014 no defect, no counterpart, no missingCompanyIds. The run closes clean with X paid 2129.03 for a month Fiamma employed them all 31 days: short 4470.97, the exact production figure this item exists to prevent. Nothing else catches it \u2014 I checked all 20 markBatchNeedsRecalc call sites and no movement or entity-history path marks a processed run, so BatchNeedsRecalculationError does not cover it. This is the same defect as B1 and B2 a third time: a signal that is computed and never read. The slip is sitting there with coverage_from/coverage_to NARROWER THAN THE PERIOD \u2014 in the very columns migration 0442 added this round \u2014 and nothing reads them unless today's history still calls the month split. FIX: add a third arm to the same union in closeBatch \u2014 any employment whose slip on THIS batch has `coverage_from > periodStart OR coverage_to < periodEnd` (period intersect tenure), independent of entityChangedDuring. It is one predicate on the run's own payslips, needs no entity history at all, and payslip_employment_idx (added by this same migration) already serves it. Note the re-date variant does not even need the rollback path: correcting the effective date from 11 Aug to 11 Sept leaves employment.company_id at ISEDECOR and the Fiamma row still matching entityChangedDuring, but August resolves to the single segment Fiamma[01-31], so splitIds excludes X just the same."
    },
    {
      "sev": "blocker",
      "trap": "outstanding after the r197 fix pass",
      "detail": "SECONDARY \u2014 THE CLOSE CHECK IS NOT GATED ON run_type, and the decision is not recorded. closeBatch's batch select (core/payroll.ts:5687-5694) does not read runType, so the new refusal also fires when closing an off-cycle, bonus or adjustment run: a bonus run for August, for a company whose period happens to contain a split employment, is refused until EVERY employer's regular run tiles the month \u2014 a refusal on a run that owes those days nothing. It is conservative rather than money-losing, but core/payroll-coverage.ts's 'REGULAR RUNS ONLY' note governs what is COUNTED as a claim, not what is CHECKED at close, so this is currently inherited rather than decided. Either gate the check on batch.run_type = 'regular' or say in code why an additional run's close is the right place for it."
    },
    {
      "sev": "blocker",
      "trap": "outstanding after the r197 fix pass",
      "detail": "NOTED, NOT BLOCKING \u2014 generatePayslips's PayrollCounterpartClosedError (core/payroll.ts:5271) throws out of the whole transaction, so one mover with a frozen counterpart aborts the entire run for every other employee on it. This is stated as deliberate ('refuse rather than commit a partial set') and the alternative is unrecoverable, so I am not calling it a defect \u2014 but it is an operational consequence a 500-head payroll will meet, and it is worth one sentence in the error's docstring saying the blast radius is the run, not the employee."
    },
    {
      "sev": "blocker",
      "trap": "outstanding after the r197 fix pass",
      "detail": "NOTED, ALREADY DOCUMENTED \u2014 the RLS residual on the population read survives B2's fix. employment_rls resolves through TODAY's employment.company_id (core/employment-company.ts:332-336), so an operator scoped ONLY to the outgoing company cannot see a transferred-out employment at all: closeOwed returns nothing for them and the outgoing run closes clean while owing the mover its days. It is contained rather than silent \u2014 the incoming run's close is then refused, because that operator CAN see the employment \u2014 and the module states the limitation and names the group-wide operator as the intended user. Flagging only so the residual is on the record beside the newly-closed hole."
    }
  ],
  "pcbview": [
    {
      "sev": "blocker",
      "trap": "outstanding after the r197 fix pass",
      "detail": "NEW BLOCKER \u2014 on an ADDITIONAL (bonus / off-cycle) run the entire screen is a working for a number nobody deducted, with no banner. core/payroll.ts:4652 stores deltaStat(now, before); deltaStat (core/payroll.ts:389) overwrites only DELTA_KEYS, and pcbMeta is not one of them, so the snapshot carried through `{ ...now }` is the CUMULATIVE month while st.pcb becomes now.pcb - before.pcb. Concrete run (wage 12,000, month 6, prior PCB 2,000, bonus 20,000 on an off-cycle run): stored st.pcb = 4,999.85 (7,071.30 - 2,071.45). The net-MTD substitution renders `max( 0, 2071.45 - 0.00 ) + max( 0, 4999.85 - max( 0, 0.00 - 2071.45 ) )` = 7,071.30 printed beside `= RM 4,999.85` \u2014 an overshoot of 2,071.45. The summary block prints normal 2,071.45 + additional 4,999.85 above a Net MTD of 4,999.85; the bracket-line Formula lands on RM 2,071.45, money nobody deducted on that slip; step 12 shows `2,071.45 \u00b7 4,999.85` above a final PCB of 4,999.85; and the same screen shows pcbNormal = 0.00 (derived as pcbSystem - pcbAdditional) contradicting the summary's 2,071.45. explanation.override is null so no banner fires. The flat-rate branch has the identical shape: pcbMeta.trace.remuneration/additional are cumulative while sys is the delta, so ( remuneration + additional ) x rate overshoots too. Reachable on every such payslip \u2014 app/payroll/transaction-view/history-table.tsx:251 links the PCB amount unconditionally and CYCLE_LABEL explicitly handles off_cycle and bonus. No test covers it: every reconciliation case in test/pcb-detail.test.ts calls pcbMonth directly, where total = normal + additional by construction, so the delta path is invisible to the whole suite. This is the same defect class as B1/S1/S2."
    },
    {
      "sev": "blocker",
      "trap": "outstanding after the r197 fix pass",
      "detail": "MINOR \u2014 flatRoundingNote contradicts its own code. It says the product 'lands within 5 sen of the figure beside it' in the same sentence that names the RM10 floor; with the floor the gap can be up to RM 9.99 (remuneration 30 x 30% = 9.00 printed beside `= RM 0.00`). Either say 'within 5 sen, or shown as nil when below RM10', or render the floored case as its own line."
    }
  ]
};

const WORK = [
  { slug: 'entity', ns: 'r197entity', id: '1b0943d5', reverify: true,
    head: `THIS IS THE ITEM THAT STOPS SOMEONE BEING UNDERPAID, AND IT IS CLOSER THAN THE LAST NOTE SAID.\n` +
          `A correction first: scripts/backfill-assignment-company.ts HAS RUN on production — I checked, and ` +
          `all 55 current assignment rows carry a company_id (59 total, the 4 without are superseded and the ` +
          `resolver filters those). An earlier note claimed the feature was inert for want of that backfill. ` +
          `It is not. The resolver has its data; what remains is the hole below.\n\n` +
          `THE BLOCKER: the split-only fast path is decided from TODAY'S history, not from what the payslips ` +
          `claim, so cancelling or re-dating a recorded transfer AFTER the outgoing run is processed removes ` +
          `the underpaid employment from the examined population entirely — every step of which is a ` +
          `first-class supported operation. Also address the run_type point: the close check is not gated on ` +
          `run_type, so a bonus run is refused until every employer's REGULAR run tiles the month, which it ` +
          `owes nothing to. Either gate it or record in code why an additional run is checked.` },
  { slug: 'pcbview', ns: 'r197pcbview', id: '45df860a', reverify: true,
    head: `ONE BLOCKER, AND THE DECISION IT NEEDS IS ALREADY MADE BY PRECEDENT IN YOUR OWN FILE — do not ` +
          `treat it as an open product question.\n` +
          `On an ADDITIONAL run the whole screen is a working for a number nobody deducted: deltaStat ` +
          `overwrites only DELTA_KEYS, pcbMeta is not one of them, so the trace carried through is the ` +
          `CUMULATIVE month while st.pcb is the delta (7,071.30 printed beside a deducted 4,999.85).\n` +
          `core/pcb-explain.ts ALREADY has the concept for exactly this: PcbOverride, pcbSystem and the rule ` +
          `stated in its own docblock — "a screen that did not notice would present a complete, ` +
          `correct-looking LHDN working as the explanation of an amount nobody computed — the exact failure ` +
          `this whole item exists to remove, wearing a respectable formula". The delta run is that shape. ` +
          `Extend the SAME mechanism: pcbSystem is what the recorded working explains, pcb is what was ` +
          `deducted, and the screen says plainly which is which. Do not invent a second concept beside it, ` +
          `and do not silently render the cumulative working.` },
];

const preamble = (w) =>
  `You are FIXING verify findings on an existing branch. The work is committed and green; do not regress it.\n\n` +
  `🔒 WORKTREE: ${WT}/r197-${w.slug} (branch build/r197-${w.slug}). \`cd\` there FIRST, confirm with \`pwd\` ` +
  `and \`git branch --show-current\`, run everything from there. READ ${MAIN} freely; never edit it, never ` +
  `touch a sibling worktree. Read what is already on your branch with \`git diff main...HEAD\` first — the ` +
  `findings are about THAT diff.\n\n` +
  `TEST DB NAMESPACE \`${w.ns}\` on EVERY vitest run: TEST_DB_NAMESPACE=${w.ns} pnpm vitest run test/<file>. ` +
  `Never omit it, never invent another, never run the full suite.\n\n` +
  `APPROVED PLAN for scope: ${PLANJSON}/plans/${w.id}.md — pulled from the board, so it IS the approved text. Fixing a finding never licenses new scope.\n\n` +
  `GATE before testsPass=true: tsc clean, your touched tests green, \`pnpm build\` compiles, then commit. ` +
  `Never weaken or delete a test; if a guard asserts the opposite of your change, UPDATE the case. No dev ` +
  `server, no watch mode. Long output to a file with \`> log 2>&1\`, never a pipe.\n\n` +
  `You may DECLINE a finding you can show is wrong — put it in \`declined\` with evidence.\n\n` +
  `${w.head}\n\nFINDINGS:\n` +
  (F[w.slug] || []).map((f, i) => `\n[${i + 1}] ${f.trap}\n${f.detail}`).join('\n');

phase('Fix');
phase('Re-verify');

const results = await pipeline(
  WORK,
  (w) => agent(preamble(w), { schema: FIX_SCHEMA, phase: 'Fix', label: `fix:${w.slug}`, effort: 'xhigh' }).then((fix) => ({ w, fix })),
  (prev) => {
    const { w, fix } = prev || {};
    if (!w) return null;
    if (!w.reverify || !fix?.testsPass) return { w, fix, re: null };
    return agent(
      `Second look at a fix for a REGRESSION. Branch build/r197-${w.slug} in ${WT}/r197-${w.slug}; read it ` +
        `with \`git diff main...HEAD\`. READ-ONLY — no edits, no test suite.\n\n` +
        `The findings raised:\n` + (F[w.slug] || []).map((f) => `- ${f.trap}: ${f.detail.slice(0, 400)}`).join('\n') +
        `\n\nThe author says:\n${(fix.addressed || []).map((a) => `  - ${a}`).join('\n')}\n` +
        ((fix.declined || []).length ? `Declined:\n${fix.declined.map((d) => `  - ${d}`).join('\n')}\n` : '') +
        `\nDecide from the CODE whether each is genuinely resolved. Specifically: can you still reach a 500 ` +
        `on either screen with an input a user can produce? Construct the input if so. Then look once for a ` +
        `defect the fix introduced. verdict=ship only if nothing is left.`,
      { schema: RE_SCHEMA, phase: 'Re-verify', label: `reverify:${w.slug}`, effort: 'high' },
    ).then((re) => { log(`reverify:${w.slug} → ${re?.verdict} (${(re?.unresolved || []).length} unresolved)`); return { w, fix, re }; });
  },
);

const out = results.filter(Boolean).map((r) => ({
  slug: r.w.slug, id: r.w.id, testsPass: !!r.fix?.testsPass, commitSha: r.fix?.commitSha || '',
  addressed: r.fix?.addressed || [], declined: r.fix?.declined || [], blockers: r.fix?.blockers || [],
  reverify: r.re?.verdict || 'n/a', unresolved: r.re?.unresolved || [],
}));
log(`fix pass: ${out.filter((o) => o.testsPass).length}/${out.length} green`);
return out;

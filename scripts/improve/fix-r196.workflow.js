/**
 * r196 fix pass — feed each workstream its OWN verify findings back into its OWN worktree, then
 * re-verify the two that carry pay-affecting risk. Same confinement and namespace rules as the build
 * pass; still merges nothing and releases nothing.
 *
 * `repl` is absent on purpose: it came back verdict=ship with two notes, neither of which asks for a
 * code change. Re-opening a green branch to address a "note" is how a clean workstream acquires a defect.
 */
export const meta = {
  name: 'fix-r196',
  description: 'Apply the r196 verify findings on each branch, then re-verify the two pay-affecting ones',
  phases: [
    { title: 'Fix', detail: 'each branch addresses its own findings in its own worktree' },
    { title: 'Re-verify', detail: 'independent second look at the two pay-affecting workstreams' },
  ],
};

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    testsPass: { type: 'boolean', description: 'true ONLY if tsc is clean, your tests are green, and pnpm build compiles, AFTER the fixes.' },
    addressed: { type: 'array', items: { type: 'string' }, description: 'One line per finding: what you changed, or why you are declining it.' },
    declined: { type: 'array', items: { type: 'string' }, description: 'Findings you judged wrong or out of scope, with the reason.' },
    commitSha: { type: 'string' },
    diffstat: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['testsPass', 'addressed'],
};

const REVERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    resolved: { type: 'array', items: { type: 'string' }, description: 'Findings you confirmed are genuinely fixed, and how you confirmed it.' },
    unresolved: { type: 'array', items: { type: 'string' }, description: 'Findings still live, or newly introduced by the fix.' },
    verdict: { type: 'string', enum: ['ship', 'fix-first', 'reject'] },
  },
  required: ['verdict', 'resolved', 'unresolved'],
};

const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const MAIN = `${WT}/mainwt`;
const PLANS = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad/plans';

const WORK = [
  {
    slug: 'txn', ns: 'r196txn', ids: ['c11e81aa'], reverify: true,
    mandate:
      `THREE BLOCKERS, all pay-affecting. Fix ALL THREE or return testsPass=false — a partial fix here is worse ` +
      `than no change, and the approved plan itself says "DO NOT ship Tier 1 without Tier 2".\n\n` +
      `  B1 RUN-TYPE MATCHING COLLIDES ON THE DEFAULT CATALOGUE. core/payroll-cycle.ts:115-125 seeds THREE ` +
      `cycles with runType 'off_cycle' ('Off-cycle', 'Advance Salary', 'Mid-Month'). Both new resolvers — ` +
      `core/payroll.ts intentCycleIds and core/payroll-view.ts runCycleIds — select EVERY payroll_cycle row of ` +
      `the batch's runType and then match intended_cycle_id against that set, so a row saved as 'Mid-Month' is ` +
      `collected and paid by an 'Advance Salary' run. Only 'regular' is protected (one-active-regular is ` +
      `enforced); bonus/off_cycle/adjustment are not. The intent column stores a CYCLE ID — resolve on the ` +
      `run's own cycle identity, not on its runType. If a batch cannot name its cycle today, say so as a ` +
      `blocker rather than widening the match.\n\n` +
      `  B2 THE SCREEN STAMPS A CYCLE THE OPERATOR NEVER CHOSE. The new cycle <select> in txn-workspace.tsx ` +
      `has no blank option (the run picker it replaced had one), and resolvedCycleId always resolves to ` +
      `something. Create sends it unconditionally; update sends it whenever companyCycles is non-empty and the ` +
      `cycle is not locked. So editing ONLY THE AMOUNT of a legacy pre-0441 row silently stamps an intent it ` +
      `never had. Restore an explicit empty choice, and never write intended_cycle_id from an edit that did ` +
      `not touch it — a field that is always submitted cannot be read by presence (house rule).\n\n` +
      `  B3 TWO READERS OF THE 'REGULAR RUN ONLY' INVARIANT ARE NOW STALE. core/payroll-view.ts ` +
      `listUnattachedTxnSummary documents that invariant in its docstring and keys its LEFT JOIN on ` +
      `run_type='regular'; unattachedHoldersOutsideSelection returns [] on the same reasoning. Your change ` +
      `falsifies both, so the Payroll Process wizard's Validation pre-flight (app/payroll/process/actions.ts:103) ` +
      `goes SILENT for exactly the rows a regular run now abandons. Update the join, the derivation AND the ` +
      `comment — the comment is the guard here.\n\n` +
      `  S1 (should-fix) The multi-run picker disappeared: with any configured cycle the run <select> is gone, ` +
      `so in a month with two runs of the same type the operator can no longer target #2. The approved build ` +
      `note said Tier 1 keeps existing-run targeting where a run exists. Restore it, or state plainly why not.`,
  },
  {
    slug: 'payitem', ns: 'r196payitem', ids: ['6b134681', '417d4937'], reverify: true,
    mandate:
      `ONE SHOULD-FIX, and it is the exact defect these two items exist to remove — four surfaces that can ` +
      `disagree about one payslip.\n\n` +
      `app/payroll/individual-payslip/page.tsx:555 and :570 render the new Overtime and Bonus sub-lines ` +
      `UNGUARDED, while lib/payslip-pdf.ts:1048-1058 and app/me/payslip/[payslipId]/page.tsx:66-67 gate the ` +
      `identical lists behind payItemLinesReconcile. The lists are NOT interchangeable: b.bonus / b.overtime ` +
      `come from payslipDisplayEarnings (the DISPLAY boxes) while componentsByBucket is grouped by the KERNEL ` +
      `bucket, and core/pay-display-category.ts exists precisely because those two diverge (an item declared ` +
      `display_category='overtime' but routed to the bonus bucket). Apply the same reconciliation gate on the ` +
      `third surface so all four agree, and add the case that would have caught it.`,
  },
  {
    slug: 'org', ns: 'r196org', ids: ['3c2f55d7'], reverify: false,
    mandate:
      `TWO SHOULD-FIX, both user-visible on the screen this item redesigns.\n\n` +
      `  1. PREVIEW STATE OUTLIVES THE CONTROL THAT CONSUMES IT. components/company-logo.tsx keeps \`preview\` ` +
      `in CompanyLogoEdit, OUTSIDE PhotoEditMenu, but components/photo-edit-menu.tsx:53 renders children behind ` +
      `{open && (...)} — it UNMOUNTS the form — and its backdrop is fixed inset-0, so any outside click closes ` +
      `it. Result: pick a file, click away, and the user is left looking at an unsaved preview being told to ` +
      `press a button that no longer exists. Either keep the preview inside the popover's lifetime or clear it ` +
      `when the popover closes. Pin it with a test that closes the menu and asserts the caption is gone.\n\n` +
      `  2. THE CAPTION NAMES A BUTTON THAT DOES NOT EXIST. logoPreviewPending reads "Preview — press Save to ` +
      `apply" in all six locales, but the form's submit is captioned Replace logo / Upload logo, and the only ` +
      `"Save" on the General tab belongs to the company-details form, which does not touch the logo. Reword in ` +
      `all six catalogues to name the real control.`,
  },
  {
    slug: 'attend', ns: 'r196attend', ids: ['ad52212d'], reverify: false,
    mandate:
      `ONE SHOULD-FIX, and it must be fixed BEFORE the gate because domain_event is APPEND-ONLY — once these ` +
      `events are written under the wrong name, the history keeps them.\n\n` +
      `core/attendance-rule.ts:762 emits 'attendance-rule.status-changed'. lib/audit-format.ts:250 actionOf() ` +
      `classifies on the last dot-segment and knows 'activated' → unarchived and 'deactivated' → archived, but ` +
      `not 'status-changed', so it falls through to 'other' and an administrator filtering the Audit Trail for ` +
      `Activate/Deactivate will never find an overtime-pattern activation. Six of the seven status-flip ` +
      `services in core/ already emit the .activated/.deactivated pair (payroll-policy.ts:266, ` +
      `employee-id-config.ts:316, leave-approval-template.ts:297, profile-options.ts:430, ` +
      `dashboard-card-config.ts:269, payroll-cycle.ts:360); attendance-allowance.ts:337 is the lone outlier. ` +
      `Follow the house shape: emit the pair. Do NOT "fix" it by teaching actionOf about status-changed.`,
  },
  {
    slug: 'entl', ns: 'r196entl', ids: ['31e39d74'], reverify: false,
    mandate:
      `TWO SHOULD-FIX, one root cause: a status derivation that tells the user to run a remedy that will do ` +
      `nothing.\n\n` +
      `core/read.ts:2851 derives \`not_generated\` from (template in force) + (no accrual/in_lieu_accrual row in ` +
      `the window). But openLeaveYear writes NO ledger row for an EARNED method (core/leave.ts:6300-6303 logs ` +
      `'earned_method' and continues) — those rows come only from accrueEarnedLeave, a separate sweep. So for ` +
      `any earned_monthly/earned_quarterly/earned_daily type WITH an entitlement table — the ordinary Annual ` +
      `Leave shape — every surface captions the figure "Not yet generated" from cycle rollover until the first ` +
      `accrual top-up, and the "Run Generate Entitlement" instruction it offers will skip that type every time. ` +
      `Three further no-row outcomes collapse the same way: days<=0 → no_entitlement (a band gap), frozenSet → ` +
      `frozen, packBlocked → pack_blocked.\n\n` +
      `Fix the derivation so it cannot claim 'not generated' for a state where generating is a no-op: ` +
      `distinguish the earned-accrual case at minimum, and prefer reading the outcome the engine already logs ` +
      `over re-deriving it from the absence of a row. Where a state genuinely cannot be distinguished with ` +
      `today's inputs, say so in the caption rather than offering a remedy that will not fire. Cover the ` +
      `earned-method case in a test.`,
  },
];

const preamble = (w) =>
  `You are FIXING findings on an existing branch of the ai-hr codebase. The work is already committed and ` +
  `green; your job is to address the findings below WITHOUT regressing it.\n\n` +
  `🔒 YOUR WORKTREE: ${WT}/r196-${w.slug} (branch build/r196-${w.slug}). \`cd\` there FIRST and confirm with ` +
  `\`pwd\` and \`git branch --show-current\` — this repo has shipped green gates for the wrong tree three ` +
  `times. Run every command from there. You may READ ${MAIN}; never edit it and never touch a sibling ` +
  `r196-* worktree. Review what is already on your branch with \`git diff main...HEAD\` before changing ` +
  `anything — the findings are about THAT diff.\n\n` +
  `YOUR TEST DATABASE NAMESPACE IS \`${w.ns}\` — set it on EVERY vitest run:\n` +
  `    TEST_DB_NAMESPACE=${w.ns} pnpm vitest run test/<file>.test.ts\n` +
  `Never run without it, never invent another, never run the full suite (the parent gates once, alone).\n\n` +
  `THE APPROVED PLAN(S), for scope: ${w.ids.map((id) => `${PLANS}/${id}.md`).join(', ')}. Fixing a finding ` +
  `never licenses new scope.\n\n` +
  `HOUSE RULES that bite here: i18n in all six locales; a new guarded page needs a column in ` +
  `lib/permissions.ts; every state-changing service appends a DomainEvent; never weaken, skip or delete a ` +
  `test to go green; if a guard asserts the opposite of your change, UPDATE the case, do not delete it; long ` +
  `output to a file with \`> log 2>&1\`, never a pipe; no dev server, no watch mode, no browser.\n\n` +
  `GATE before returning testsPass=true: \`npx tsc --noEmit\` clean, your touched tests green (namespaced), ` +
  `\`pnpm build\` compiles. Then \`git add -A\` and commit on your branch.\n\n` +
  `YOU MAY DECLINE A FINDING if you can show it is wrong — put it in \`declined\` with the evidence. Do not ` +
  `decline merely because it is inconvenient.\n\nFINDINGS TO ADDRESS:\n${w.mandate}`;

phase('Fix');
phase('Re-verify');

const results = await pipeline(
  WORK,
  (w) => agent(preamble(w), { schema: FIX_SCHEMA, phase: 'Fix', label: `fix:${w.slug}`, effort: 'xhigh' }).then((fix) => ({ w, fix })),
  (prev) => {
    const { w, fix } = prev || {};
    if (!w) return null;
    if (!w.reverify || !fix?.testsPass) {
      if (w.reverify) log(`fix:${w.slug} did not reach green — skipping re-verify`);
      return { w, fix, re: null };
    }
    return agent(
      `Second, independent look at a PAY-AFFECTING fix. Branch build/r196-${w.slug} in ${WT}/r196-${w.slug}; ` +
        `read it with \`git diff main...HEAD\` from that directory. READ-ONLY — do not edit, do not run the ` +
        `test suite (a second vitest would wipe a sibling's databases).\n\n` +
        `These findings were raised against the earlier state of this branch:\n${w.mandate}\n\n` +
        `The author now claims to have addressed them:\n${(fix.addressed || []).map((a) => `  - ${a}`).join('\n')}\n` +
        (fix.declined?.length ? `They declined:\n${fix.declined.map((d) => `  - ${d}`).join('\n')}\n` : '') +
        `\nFor EACH finding decide, from the code and not from the claim, whether it is genuinely resolved. ` +
        `Then look once more for a NEW defect the fix introduced — a widened match, a guard removed to make a ` +
        `test pass, a comment now contradicting its code, a value written on a path that should not write it. ` +
        `verdict=ship only if every blocker is genuinely gone and you found nothing new.`,
      { schema: REVERIFY_SCHEMA, phase: 'Re-verify', label: `reverify:${w.slug}`, effort: 'high' },
    ).then((re) => {
      log(`reverify:${w.slug} → ${re?.verdict ?? 'none'} (${(re?.unresolved || []).length} unresolved)`);
      return { w, fix, re };
    });
  },
);

const out = results.filter(Boolean).map((r) => ({
  slug: r.w.slug,
  ids: r.w.ids,
  branch: `build/r196-${r.w.slug}`,
  testsPass: !!r.fix?.testsPass,
  commitSha: r.fix?.commitSha || '',
  diffstat: r.fix?.diffstat || '',
  addressed: r.fix?.addressed || [],
  declined: r.fix?.declined || [],
  blockers: r.fix?.blockers || [],
  reverifyVerdict: r.re?.verdict || (r.w.reverify ? 'not-run' : 'n/a'),
  unresolved: r.re?.unresolved || [],
}));

log(`fix pass: ${out.filter((o) => o.testsPass).length}/${out.length} green · ` +
  `re-verified ship: ${out.filter((o) => o.reverifyVerdict === 'ship').length}`);

return out;

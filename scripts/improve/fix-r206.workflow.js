/**
 * r206 fix pass. No blockers this round — but one should-fix is mislabelled: cp39 introduces a NEW 500
 * PATH on two screens that previously degraded gracefully, which is a regression on shipped behaviour and
 * is treated here as a blocker. cp39 therefore gets a re-verify; the other two do not.
 */
export const meta = {
  name: 'fix-r206',
  description: 'Apply the r206 verify findings; re-verify the two that regressed shipped behaviour',
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
  "process": [
    {
      "sev": "blocker",
      "trap": "Implicit form submission \u2014 the new search box fires the payroll recalculation on Enter",
      "detail": "/Users/zenlam/Projects/ai-hr/.claude/worktrees/r206-process/app/payroll/[batchId]/reprocess/reprocess-form.tsx:180-191 puts `<input type=\"search\">` INSIDE `<form action={reprocessSelectedAction}>`. The form's default button is `<Button type=\"submit\" disabled={count === 0 || pending}>` (line 417). Per HTML implicit submission, pressing Enter in a text-type field clicks the default button. On main this was unreachable: `git show main:.../reprocess-form.tsx` has no text/search input at all \u2014 only hidden inputs, checkboxes and a textarea (Enter in a textarea inserts a newline). This diff introduces the first blocking field, so Enter in the search box now runs reprocessSelectedEmployees immediately, with no review click and no confirmation, on whatever is currently ticked. And it is ticked by default: `selected` is seeded from `preselectedIds` (batch.recalcEmploymentIds) plus every addable, in-scope New/Pending candidate (lines 100-110), so `count > 0` \u2014 the button is enabled \u2014 on exactly the runs where a search is worth having. Under an active search the submitted set is the full selection, because pickedOffscreen carries the hidden rows too. The author's summary says the search was 'ported from remove-form.tsx ... so the two selection screens under a payroll run behave identically'; that is falsified here \u2014 /Users/zenlam/Projects/ai-hr/.claude/worktrees/r206-process/app/payroll/[batchId]/remove/remove-form.tsx has no submit button at all (ConfirmSubmit's trigger is `type=\"button\"`), so the consequence of Enter is completely different on the two screens. No test can see this: test/payroll-reprocess-form.dom.test.tsx only ever calls `user.type(search, '\u2026')` and then inspects `new FormData(form)` \u2014 it never presses Enter, and jsdom's userEvent does not perform implicit submission for you."
    },
    {
      "sev": "should-fix",
      "trap": "The reversal lands the operator on a filtered list the reset run has just dropped out of",
      "detail": "resetAction now redirects to `payrollListReturnTo(formData.get('from'))` (/Users/zenlam/Projects/ai-hr/.claude/worktrees/r206-process/app/payroll/actions.ts:373, 396) and both forms post the live filter query \u2014 `dashboardHref(filters)` on app/payroll/page.tsx:432 and `backHref` on app/payroll/[batchId]/page.tsx:406. `dashboardHref` (app/payroll/dashboard-logic.ts:223-234) emits `status=\u2026` whenever a status is selected, and app/payroll/dashboard-filters.tsx:188 is a Status dropdown whose natural use is 'Processed' \u2014 the only status that offers Reset at all. applyFilters (dashboard-logic.ts:169-186) intersects on status, so after a successful reset the run is Draft and is filtered OUT of the very list the operator is redirected to. They get a success toast over a list where the row they just acted on has vanished. The plan (/Users/zenlam/Projects/ai-hr/.claude/worktrees/r206-process/docs/mockups/65e2d5de-r202.html) promises the opposite in as many words: 'Back on the list, refreshed, with your year / month / company / status filters still set, the run now showing Draft'. Both halves cannot hold at once, and the code comment at actions.ts:357-358 ('the list is where the run's new Draft status can actually be seen') asserts the half that fails. Every guard on this path is a source-shape assertion (test/payroll-reset-flow-7076f8af.test.ts case 1, test/payroll-draft-resume.test.ts a3 both compose strings), so nothing evaluates the filter against the post-reset row."
    },
    {
      "sev": "should-fix",
      "trap": "A third divergent copy of the shared employee-search rule, with the sentence claiming one implementation left standing",
      "detail": "/Users/zenlam/Projects/ai-hr/.claude/worktrees/r206-process/lib/employee-search.ts opens with 'THE \"find an employee by partial ID or partial name\" RULE \u2014 one implementation, shared', and exports `matchesEmployeeSearch`, which folds separators (`fold()` strips `[\\s._-]`) so that 'emp0008' finds 'EMP-0008'. The new predicate at app/payroll/[batchId]/reprocess/reprocess-form.tsx:136-137 hand-rolls `(e.employeeCode ?? '').toLowerCase().includes(needle) || e.name.toLowerCase().includes(needle)` \u2014 no folding \u2014 rather than importing the shared rule. Consequence: on the Reprocess screen typing an employee ID the way it is spoken ('emp0008', 'a 0001') matches nobody, while the same string finds the person in the Payroll Process wizard's Step-2 picker, the Personnel switcher, Transaction Detail and Individual Payslip, all of which go through matchesEmployeeSearch. The request being satisfied is literally 'search by employee ID'. test/employee-search-shared.test.ts pins the shared rule and this copy escapes it; test/payroll-process-workflow-65e2d5de.test.ts:D instead pins the hand-rolled regex, cementing the divergence. (remove-form.tsx carries the same weaker copy on main \u2014 porting it forward propagated the defect rather than inheriting a decision.)"
    }
  ],
  "leaveess": [
    {
      "sev": "blocker",
      "trap": "on-behalf list is an INTERSECTION, not the subject's own set \u2014 the docblock says the opposite",
      "detail": "app/leave/page.tsx:246 sets `requestLeaveTypeOptions = eligibleLeaveTypes.map(...)`, i.e. the types the VIEWER qualifies for, and passes it as `types=` at :786. components/leave-duration-fields.tsx:181-187 then filters that prop down again: `visibleTypes = types.filter(x => set.has(x.id))` where the set is `eligibleTypeIdsByEmployment[employmentId]`. The offered list for a report is therefore eligible(manager) INTERSECT eligible(report), never eligible(report). A male manager cannot apply for Maternity on behalf of a female report; an unmarried manager cannot apply for Paternity for a married one. On main the manager was handed the full catalogue, so this is a regression, not a narrowing. The core/read.ts docblock above eligibleLeaveTypeIdsFor states 'the SAME predicate the single-employee read uses, so the manager's list and the employee's own list can never disagree' \u2014 the diff falsifies that sentence and leaves it standing, and the author's summary repeats it. It is structurally invisible to the run: test/leave-ess-eligible-dropdown.test.ts:221-243 asserts exactly `map[report] toContain(mat)` and `map[manager] not.toContain(mat)` \u2014 the read is correct in isolation; the page composes it wrongly, and every page-level guard is a source-string assertion. Compounding it, `employmentId` defaults to `employeeOptions[0].id` (leave-duration-fields.tsx:165), so a manager opening the dialog lands on a report immediately, not on themselves."
    },
    {
      "sev": "should-fix",
      "trap": "a second, unannounced consumer of the newly-narrowed array \u2014 the Replacement Leave dialog",
      "detail": "`requestLeaveTypeOptions` is handed to TWO dialogs, not one: app/leave/page.tsx:786 (RequestLeaveDialog) and :813 (ReplacementLeaveRequestDialog). The summary, the ad965821 comment at :243-245 ('MAPPED OFF THE ELIGIBLE LIST... A male employee has no Maternity row here at all'), and every test discuss only the apply dropdown. The comment at :253-254 \u2014 'One line covers BOTH dropdowns: this array is handed to RequestLeaveDialog and to ReplacementLeaveRequestDialog' \u2014 is still there, unedited, now describing an array whose meaning changed under one of its two consumers. Replacement Leave asks which type a CREDIT for hours already worked lands in; the apply gate answers which type you may TAKE. `employee_can_apply=false` (the 'can look but can't apply' switch) and `visible_to_employee=false` now silently remove types from the credit-target picker. components/leave/replacement-leave-request-dialog.tsx:125 renders `<select name=\"leaveTypeId\">` with no `required` and no empty option, so if HR has set employee_can_apply=false on the REPLACEMENT-role type (a natural configuration, since you request that credit through this separate button rather than the dropdown) the select renders empty, `replacementRequest.allowed` still shows the button, and the form posts leaveTypeId=''. Config-dependent, which is why the seeded fixtures pass."
    },
    {
      "sev": "should-fix",
      "trap": "the newly-added probation gate is evaluated at TODAY; requestLeave evaluates it at the leave START DATE",
      "detail": "core/read.ts:894 calls `isLeaveEligible(elig, emp, today)` with `todayInKualaLumpur()`. core/leave.ts:2492 calls `assertEligible(elig, emp, p.startDate)`, and core/leave.ts:1214-1218 branches on `onProbationAsOf(emp, asOf)`. The import comment at core/read.ts:51-52 claims the apply-menu gate merges probation in 'exactly as requestLeave/editLeave do' \u2014 the merge is identical, the as-of is not. Consequence: an employee on probation today whose confirmation date falls before their intended leave date can no longer see a confirmed_only type in the dropdown at all, even though requestLeave would accept the submission. Because ad965821's stated design is that removal is silent (no caption, no greyed row, no count), the employee has no way to discover the type exists or to book it. minServiceMonths already had this skew, but probation is what this round newly routed through the read, and it is the rule most likely to flip within a booking horizon. Invisible to the tests: leave-ess-eligible-dropdown.test.ts uses `setConfirmation(..., '2099-01-01')`, so no case ever puts a start date on the far side of a confirmation date."
    },
    {
      "sev": "should-fix",
      "trap": "empty type select is a dead-end form; the page-level emptiness guard only covers the viewer",
      "detail": "app/leave/page.tsx:784 gates the trigger on `ess && requestLeaveTypeOptions.length > 0` \u2014 the VIEWER's own eligible count. In the on-behalf path the manager passes that gate, selects a report, and if `visibleTypes` is empty (very reachable given finding 1) leave-duration-fields.tsx:190-194 sets `typeId` to '' and :336-338 renders `<select name=\"leaveTypeId\" required value=\"\">` with zero `<option>`s. HTML5 required-select validation reports valueMissing with nothing selectable, so the dialog cannot be submitted and cannot be satisfied; there is no message, because the design forbids one. Separately, the same gate means a manager who personally qualifies for nothing loses the on-behalf trigger entirely."
    }
  ],
  "leavecfg": [
    {
      "sev": "should-fix",
      "trap": "comment-is-the-guard / dead plumbing \u2014 the override pop-out shows a working-days count under calendar-days wording",
      "detail": "core/leave.ts:3485-3487 adds `minAdvanceDayType?: AdvanceNoticeDayType` to `LeaveOverridePreview` with the comment \"carried so the form is never left describing a working-days rule with a calendar-days number\", and previewLeaveDeduction populates it (core/leave.ts:3437). NOTHING READS IT. `grep -rn minAdvanceDayType app components lib` returns zero consumers outside the type declaration. The only renderer of that preview, /Users/zenlam/Projects/ai-hr/.claude/worktrees/r206-leavecfg/components/leave-duration-fields.tsx:470-475, is untouched by the diff and still does:\n\n    t('override.convertNotice', { typeName: o.fromTypeName ?? '', days: o.minAdvanceDays ?? 0, given: o.daysInAdvance ?? 0 })\n\nand `leave.override.convertNotice` in all six catalogues is unchanged (messages/en.json:2025): \"This application does not meet the {days}-day notice period for {typeName} (you have given {given} day(s) notice).\" Before this change `given` was always a calendar count and the wording was true. After it, on a working-days type `given` is the WORKING-day count printed as \"day(s)\" \u2014 an employee applying on a Friday for the following Wednesday under a 7-working-day rule is told \"you have given 3 day(s) notice\" when the wall calendar says 5, on the very dialog they must tick to consent. The approved mockup (docs/mockups/7daac043-r201.html) both lists \"Employee picks dates on the leave form \u2014 the advance-notice warning shown before submitting is measured in the chosen day type\" AND shows the new \"working day(s)\" wording; the build shipped the measurement and not the wording. Structurally invisible to a targeted run: no test asserts convertNotice rendering, and an optional field that no component reads is perfectly type-clean, so tsc and `next build` are green."
    },
    {
      "sev": "should-fix",
      "trap": "DomainEvent payload asymmetry on the second write path \u2014 audit unit missing from the EL command event",
      "detail": "core/leave.ts:2236-2239 states the invariant: \"`daysInAdvance` is measured in `dayType`'s unit, so the unit is stamped WITH it. Without it '5' on a working-days type and '5' on a calendar-days type are the same number describing different amounts of notice, and the history stops being readable.\" insertLeaveRequest honours it (core/leave.ts:2363-2370, `advanceNoticeDayType`). `requestEmergencyLeave` does not: its `leave-request.emergency.submitted` payload at core/leave.ts:3774-3785 stamps `advanceNoticeOverride` / `daysInAdvance` / `minAdvanceDays` from the same `overrideAudit` and stops there \u2014 no `advanceNoticeDayType`. That function is reached for EVERY advance-notice conversion whose target EL has no balanceSourceTypeId (core/leave.ts:2761-2763, `return requestEmergencyLeave(tx, ctx, {...p, leaveTypeId: target.id}, overrideAudit)`), so the conversion emits child events carrying the unit and one command event that does not. Its own doc comment (core/leave.ts:3609-3612) says the audit is \"Stamped on EVERY child's submitted event AND on the EL command event, because the decomposition means there is no single row an auditor can look at \u2014 the conversion has to be findable from any of them\" \u2014 the one event written for that auditor is the unit-less one, and that sentence is left standing. The author's summary claims \"Same for the Override-rule conversion payload\", which is true of one of the two payload sites. No test in the diff reads this event: `grep -rn 'emergency.submitted' test/` hits only test/emergency-leave.test.ts:543, on the non-converted path."
    },
    {
      "sev": "should-fix",
      "trap": "plan fidelity (under-delivery) \u2014 the mockup's explanatory help under the new select was not shipped",
      "detail": "docs/mockups/7daac043-r201.html renders, directly beneath the Day type select and above \"Custom system message\", the paragraph: \"Calendar Days counts every day, including weekends, rest days and public holidays. Working Days counts only the days the employee is scheduled to work. Existing leave types stay on Calendar Days, so nothing already saved changes.\" The diff ships exactly one new admin key \u2014 `admin.leave.minAdvanceDayTypeLabel` = \"Day type\" \u2014 in six locales, and no help key (`grep -n 'dayTypeHelp\\|DayTypeHelp' messages/en.json` \u2192 nothing). `admin.leave.advanceNoticeSectionHelp` is unchanged and still describes only the figure (\"How many days before the start date an employee must submit...\"), so it does not cover the unit. components/leave-type-panel.tsx:2791-2800 renders label + select and nothing else. Net effect: the admin gets a two-option select with no in-product statement of what Working Days counts, and no sight of the \"nothing already saved changes\" reassurance the reporter approved on the screen \u2014 which is the whole point of a configuration change whose two settings look identical (both read \"7\"). i18n-check cannot see a key that was never added."
    }
  ],
  "feedback": [
    {
      "sev": "should-fix",
      "trap": "Test that cannot fail \u2014 the 'sort composes with filter' case is vacuous, and its comment describes a setup that doesn't happen",
      "detail": "test/feedback.test.ts:242-247. The case filters to `status: 'contested'` and asserts `expect([...stamps].sort((a,b)=>b-a)).toEqual(stamps)`. At that point the tenant holds exactly ONE contested row. The only other contest in the file (line 109) is immediately re-planned back to `planned` at line 115 (`setFeedbackPlan` \u2192 status 'planned', asserted at 117), and `second` is never moved off `open`, so it is excluded by the filter the test itself asserts at line 244. A one-element array sorted descending always equals itself: the ordering assertion can never fail, in any ordering, including if the ORDER BY were deleted. The author's summary lists this as 'a status filter composes with the order' \u2014 that coverage does not exist. The comment above it is wrong twice over: 'leaving it the most recently moved `open` item of the pair' \u2014 `first` is `contested`, not `open`, and `second` is not in the filtered set, so there is no pair to compare. Fix: assert against a filter that returns both rows (e.g. `status: 'open'` with two touched items, or contest both), or drop the misleading comment and the dead stamps assertion."
    },
    {
      "sev": "should-fix",
      "trap": "THE COMMENT IS THE GUARD \u2014 the diff's own new prose falsifies a standing comment 15 lines below it and leaves the sentence standing",
      "detail": "app/feedback/bulk-table.tsx:70-71 is untouched and still reads: 'Paging happens AFTER the caller's ordering and filtering, over the full set \u2014 see client-pager.tsx. This is the product's largest list (517 rows on production)'. The same diff adds, at lines 53-55 and again at lib/feedback-sort.ts:11 and core/feedback.ts:792-794, the opposite fact: 'listFeedback caps the board at 200 rows (517 on production)'. Both cannot be true. `core/feedback.ts:825` has `.limit(200)`, so the client component never holds 517 rows and never pages 'over the full set' \u2014 it pages over a server-truncated 200. This is the precise reasoning error the change was built to prevent (the new comments argue correctly that a client-side sort would rank only 200 of 517), yet the sentence that would lead the next reader back into it is still there, now sitting directly beneath its own refutation."
    },
    {
      "sev": "should-fix",
      "trap": "The 200-row cap is invisible on screen, and this diff is the first feature that makes it user-visible",
      "detail": "`listFeedback` returns at most 200 rows (core/feedback.ts:825) while the 'All' chip renders `total` from `feedbackStatusCounts`, which is unlimited (app/feedback/page.tsx:99-100, 122). On production that paints 'All 517' beside a list containing 200. ClientPager's truncation notice structurally cannot fire: `truncated` is `q.size === 'all' && safeTotal > ALL_ROW_CEILING` where ALL_ROW_CEILING is 2000 (lib/pagination.ts:31, 102), and `safeTotal` is computed from the already-truncated 200. The cap and the mismatch are pre-existing, but the new heading link is what turns them into a contradiction: flipping to `updated_asc` does not reverse the list you were looking at, it swaps in a largely disjoint set (the 200 stalest instead of the 200 freshest), with nothing on the page saying 317 rows were never sent. No DB-level test can see this \u2014 the suite never builds a tenant with more than a handful of feedback rows."
    }
  ]
};

const WORK = [
  { slug: 'process', ns: 'r206proc', id: '65e2d5de', reverify: true,
    head: `THE BLOCKER IS A KEYSTROKE THAT RUNS PAYROLL. Your new search box is the first text field inside ` +
          `\`<form action={reprocessSelectedAction}>\`, so by HTML implicit submission, pressing Enter in it ` +
          `clicks the default submit — firing reprocessSelectedEmployees immediately, with no review click ` +
          `and no confirmation, on whatever is currently ticked. And it is ticked BY DEFAULT: \`selected\` is ` +
          `seeded from preselectedIds plus every addable New/Pending candidate, so the button is enabled on ` +
          `exactly the runs where a search is worth having. On main this was unreachable — there was no ` +
          `text input on that form at all. Fix it so Enter cannot submit, and pin it.` },
  { slug: 'leaveess', ns: 'r206ess', id: 'ad965821', reverify: true,
    head: `THE BLOCKER IS A REGRESSION IN WHO A MANAGER CAN APPLY FOR. The on-behalf list is now ` +
          `eligible(MANAGER) INTERSECT eligible(report) rather than eligible(report): app/leave/page.tsx ` +
          `builds the options from the VIEWER's eligible types and leave-duration-fields.tsx filters that ` +
          `prop again by the subject. So a male manager cannot apply for Maternity on behalf of a female ` +
          `report, and an unmarried manager cannot apply for Paternity for a married one. On main the ` +
          `manager was handed the full catalogue, so this is a regression, not the narrowing the item asked ` +
          `for. It also falsifies the docblock above eligibleLeaveTypeIdsFor — which says the manager's list ` +
          `and the employee's own list "can never disagree" — and leaves that sentence standing, and your ` +
          `own summary repeats it. Fix the list to be the SUBJECT's, and correct the sentence.` },
  { slug: 'leavecfg', ns: 'r206cfg', id: '7daac043', reverify: false,
    head: `No blockers — three should-fix. You carry the round's only migration (0447); do not touch it or ` +
          `the journal unless a finding names them.` },
  { slug: 'feedback', ns: 'r206fb', id: 'e14334ef', reverify: false,
    head: `No blockers — three should-fix. This is the board's OWN module, the screen the reporter uses to ` +
          `talk to us, so a mistake here is visible to them immediately.` },
];

const preamble = (w) =>
  `You are FIXING verify findings on an existing branch. The work is committed and green; do not regress it.\n\n` +
  `🔒 WORKTREE: ${WT}/r206-${w.slug} (branch build/r206-${w.slug}). \`cd\` there FIRST, confirm with \`pwd\` ` +
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
      `Second look at a fix for a REGRESSION. Branch build/r206-${w.slug} in ${WT}/r206-${w.slug}; read it ` +
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

// ── txnsplit: built green, then its agent hit the StructuredOutput retry cap and returned nothing. The
// WORK is committed and I verified it myself (tsc 0, 77 tests green across its four files), but it is the
// only branch in this round that never got an adversarial pass. Give it one now.
const txnsplitVerify = await agent(
  `Adversarially review a change whose author produced NO summary — its agent died before emitting one, so ` +
    `there is no claim to test against and you are the first reader. Branch build/r206-txnsplit in ` +
    `${WT}/r206-txnsplit; read it with \`git diff main...HEAD\`. READ-ONLY — no edits, no test suite.\n\n` +
    `THE ITEM: 3c88d593 — Transaction Detail must show a transferred employee's payroll split per company ` +
    `rather than consolidated into one monthly result. The approved plan is ${PLANJSON}/plans/3c88d593.md. ` +
    `The data already exists: r204 shipped payslip.coverage_from / coverage_to (migration 0446) and ` +
    `payslipSegmentOf, and the reporter has CONFIRMED the split payslip itself works — so this should be ` +
    `presentation only, and any change to a calculation path is out of scope and worth flagging.\n\n` +
    `Check: i18n keys in all six catalogues with the right namespace; NO migration (none was allocated); ` +
    `no test weakened, deleted or narrowed; a guard asserting the opposite UPDATED not deleted; THE COMMENT ` +
    `IS THE GUARD; presence-vs-value on form fields; RSC boundary risk; and plan fidelity in BOTH ` +
    `directions. app/payroll/transaction-view/ is the file r199 collided on twice — check the diff stays ` +
    `inside the Transaction Detail path and does not reflow neighbouring markup.\n\n` +
    `Report only what you can point at in the diff. "No findings" is valid and useful.`,
  { schema: RE_SCHEMA, phase: 'Re-verify', label: 'verify:txnsplit', effort: 'high' },
);
log(`verify:txnsplit → ${txnsplitVerify?.verdict ?? 'none'} (${(txnsplitVerify?.unresolved || []).length} unresolved)`);

const out = results.filter(Boolean).map((r) => ({
  slug: r.w.slug, id: r.w.id, testsPass: !!r.fix?.testsPass, commitSha: r.fix?.commitSha || '',
  addressed: r.fix?.addressed || [], declined: r.fix?.declined || [], blockers: r.fix?.blockers || [],
  reverify: r.re?.verdict || 'n/a', unresolved: r.re?.unresolved || [],
}));
log(`fix pass: ${out.filter((o) => o.testsPass).length}/${out.length} green`);
return { fixes: out, txnsplit: txnsplitVerify };

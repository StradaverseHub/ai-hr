/**
 * r198 fix pass. No blockers this round — but one should-fix is mislabelled: cp39 introduces a NEW 500
 * PATH on two screens that previously degraded gracefully, which is a regression on shipped behaviour and
 * is treated here as a blocker. cp39 therefore gets a re-verify; the other two do not.
 */
export const meta = {
  name: 'fix-r198',
  description: 'Apply the r198 verify findings; re-verify cp39, which introduced a regression',
  phases: [
    { title: 'Fix', detail: 'each branch addresses its own findings' },
    { title: 'Re-verify', detail: 'cp39 only — it regressed two existing screens' },
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
const PLANS = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad/plans';
// Findings are EMBEDDED, not read from disk: workflow scripts have no filesystem and no Node APIs, and
// an earlier `require('fs')` here killed the run at line 1 before any agent started.
const F = {
  "remove": [
    {
      "trap": "presence-vs-value on form fields",
      "detail": "app/payroll/[batchId]/remove/remove-form.tsx \u2014 the table body renders `visible.map(...)` (search-filtered), so a row that no longer matches the search box is UNMOUNTED and its `<input type=\"checkbox\" name=\"employmentIds\">` leaves the DOM. But `picked`, `wholeRun`, the button label `removeSubmitN`, the review list and the confirm body `removeConfirmBody` are all computed from `employees` (unfiltered). ConfirmSubmit submits via `ref.current?.closest('form')?.requestSubmit()` (components/ui/confirm-submit.tsx:162), which posts only mounted controls. Concrete failure: tick A, B and C; type a search string matching only A; the dialog states \"The selected 3 employees' payroll results for this run will be removed\" and the button reads \"Remove 3 employee payroll\", but FormData carries one employmentId and only A is removed. The operator is told one thing about payroll money and another thing happens. A DB-level targeted test structurally cannot see this \u2014 every guard in test/payroll-remove-employee.test.ts calls removeEmployeePayroll() directly with an id array. Fix: render hidden `employmentIds` inputs for selected-but-not-visible ids, or drop the selection when the search changes."
    },
    {
      "trap": "unwind omits a per-employee row that gates the next step",
      "detail": "core/payroll.ts removeEmployeePayroll step 4 unwinds loan_repayment, claim_request, payroll_individual_txn and payroll_statutory_adjustment for the removed employments \u2014 but not payroll_anomaly_verdict. closeBatch (core/payroll.ts:5475) calls openBlockingVerdicts(tx, p.batchId), which is keyed on batchId alone (core/payroll-anomaly.ts:573-587, no payslip join), so a standing unresolved BLOCK verdict for a removed employee still refuses the close, and app/payroll/actions.ts:545 renders `closeBlockedByAnomalies` counting an employee who has no payslip on the run. resetProcessedBatch never hit this because it drops the run to draft and forces a regeneration (which supersedes every verdict for the batch, core/payroll-anomaly.ts:478-500); removal deliberately leaves the run Processed, and Close is the operator's very next action. Recoverable \u2014 re-running the checks supersedes, and anomalyQueue does not join payslip so the row is still resolvable \u2014 but it is a new failure mode with no test and no mention in the diff's own step-4 comment."
    },
    {
      "trap": "the comment is the guard \u2014 schema action columns",
      "detail": "db/schema.ts:5206 `action: text('action').notNull(), // 'rollback' | 'unlock' | 'close' | 'reprocess'` and db/schema.ts:5230 `action: text('action').notNull(), // 'reprocess'` are both falsified by this diff, which writes `'remove-employee'` (core/payroll.ts:6682) and `'remove'` (core/payroll.ts:6643). The block header at db/schema.ts:5195-5197 (\"capture actor/timestamp/reason + before/after snapshot for every rollback, unlock and reprocess\") is stale for the same reason. This matters more than usual here: \"every row in payroll_employee_result_history is a reprocess\" is EXACTLY the wrong premise the diff itself had to repair in core/payroll-view.ts:1865 (the ne(action,'remove') filter, added because diffPayslipVersions would otherwise render \"gross NaN\"). Leaving the sentence standing hands the next reader the same premise that just cost this round a bug."
    },
    {
      "trap": "a documented refusal surface that does not cover every refusal",
      "detail": "app/payroll/[batchId]/remove/page.tsx claims in its header: \"THE ENGINE IS THE AUTHORITY. removeEmployeePayroll re-asserts the setting gate, the module gate, payroll.remove.employee, processed-only, period-open... The refusals rendered below are a SECOND surface \u2014 the operator is told why the door is shut instead of finding out by pressing the button.\" The rendered refusal set is only permitted/processed/periodClosed (removeEligibility returns exactly those three). The page notFound()s on the module gate, but it never checks `payroll.reset_enabled` \u2014 so with that setting off, a direct visit to /payroll/<id>/remove renders the full selection form and the operator learns by pressing the button. Worse, app/payroll/actions.ts removeEmployeePayrollAction maps six typed errors but not SettingNotEnabledError or ModuleNotEnabledError (both thrown BEFORE the reason check in removeEmployeePayroll), so it falls through to `(e as Error).message` and the error banner shows raw untranslated English (\"Payroll reset is not enabled.\") in all six locales."
    }
  ],
  "personnel": [
    {
      "trap": "THE COMMENT IS THE GUARD \u2014 falsified invariant left standing (in the file the diff edits)",
      "detail": "app/admin/personnel/[employmentId]/page.tsx:3853-3855, inside the Employment Dates fieldset, still says: \"b75b2a23 \u2014 the cc681bd5 Year of Service row moved from here onto the top summary card so the figure is visible the moment a profile opens and lives in exactly one place.\" That sentence sits ~17 lines BELOW the caption this diff changed at line 3836 \u2014 `{t('employmentInfo.groupService')}: {groupServiceLabel ?? '\u2014'}` \u2014 which is now `fmtServiceYmd(emp.hiredOn)`, i.e. character-for-character the same string the summary card prints as Year of Service (`const yearOfServiceLabel = fmtServiceYmd(emp.hiredOn);`, line 3552). The figure no longer lives in exactly one place; it lives in two, on the same page. The author DID qualify the twin comment at line 4540-4546 (\"one figure, two captions, one calculation\") and left this one \u2014 the one on the very card that gained the second display \u2014 untouched. tsc, a targeted run and `next build` are all structurally blind to it: nothing asserts on this comment. Fix: qualify it the same way the 4544 comment was qualified."
    },
    {
      "trap": "THE COMMENT IS THE GUARD \u2014 same invariant, in the test file the author rewrote",
      "detail": "test/personnel-year-of-service.test.ts:6-7 still reads \"...and removed the Employment-tab row so the figure has exactly one authoritative display.\" The diff edits that exact sentence (it changed \"Join Date\" to \"Group Join Date\" on the line immediately above) and leaves the false half. As of this change the Employment tab's Group Service caption is the same figure from the same date through the same formatter, so \"exactly one authoritative display\" is no longer true \u2014 and this is the docblock a future agent reads to decide whether adding a second display is allowed. Line 22 of the same block (\"no longer duplicates it on the Employment Information card\") is technically still true only because the duplicate landed on the Employment DATES card instead; it will read as a licence to nobody."
    },
    {
      "trap": "Rename applied to one back link and not its two siblings \u2014 invisible to any test",
      "detail": "The item renames the admin module to Personnel Management. The author extended that beyond the approved mockup to `people.wizard.backLabel` (\"Back to Personnel\" \u2192 \"Back to Personnel Management\", app/admin/personnel/new/page.tsx:75,141). Two other back links into the SAME destination were left reading the pre-Personnel module name: `people.detail.backToPeople` = \"People\" (app/admin/personnel/[employmentId]/page.tsx:246, href '/admin/personnel') and `people.import.backLabel` = \"People\" (app/admin/personnel/import/page.tsx:41, href '/admin/personnel'). After this diff a user on a profile clicks a link labelled \"People\" and lands on a page headed \"Personnel Management\", while the adjacent wizard says \"Back to Personnel Management\" \u2014 three names for one module, English only (ms/ta/th/vi/zh render these two keys as \"Personnel\", not \"People\"). Either fix both or leave the wizard alone; the current state is the inconsistency the item exists to remove. NOTE for whoever fixes it: `people.detail.backToPeople` is read by BOTH app/admin/personnel/[employmentId]/page.tsx:246 (\u2192 /admin/personnel) and app/personnel/[employmentId]/page.tsx:35 (\u2192 /personnel) \u2014 exactly the shared-key trap the author correctly avoided on people.list.title, so it needs a second key, never a rename in place."
    }
  ],
  "cp39": [
    {
      "trap": "unhandled-throw-on-existing-screens",
      "detail": "NEW 500 PATH ON TWO SCREENS THAT PREVIOUSLY DEGRADED GRACEFULLY. `cp39()` (localization/my/reports.ts:459-470) now calls `cp39FormExtras` UNCONDITIONALLY and before the `hasBatch` check; `cp39FormExtras` (localization/my/cp39-form.ts:~120) opens with `cp39DeductionPeriodFor(p.periodKey)`, which throws on anything not matching /^\\d{4}-(0[1-9]|1[0-2])$/. Two callers hand it unvalidated input:\n\n(a) /Users/zenlam/Projects/ai-hr/.claude/worktrees/r198-cp39/app/payroll/reports/page.tsx:35-37 \u2014 `const periodKey = sp.periodKey || ''` then `reportPreview(...)` with NO validation. The period box (same file, line ~86) is a free-text `<input name=\"periodKey\">` whose placeholder flips between '2026' and '2026-07' depending on the selected report. Realistic trigger: view an annual report (box holds '2026'), switch the report dropdown to CP39, press Preview -> throw -> the whole Reports page 500s.\n\n(b) /Users/zenlam/Projects/ai-hr/.claude/worktrees/r198-cp39/app/payroll/statutory-forms/[formId]/page.tsx:135-140 \u2014 `fallback` is validated only against /^\\d{4}-\\d{2}$/, which accepts '2026-13', '2026-99', '2026-00'; `month` then falls through to `fallback.slice(5,7)` and `periodKey` becomes '2026-13'. `reportPreview` at line 147 has no try/catch, so `?periodKey=2026-13` 500s the CP39 figures screen.\n\nBefore this change both paths were total: `loadBatchRows` (localization/my/reports.ts:267-279) never throws on a bad period, it returns `hasBatch:false` and the 'No payroll run' card rendered. `loadCp39Form` is safe (it regex-validates first and try/catches `reportPreview`), so none of the 12 re-run guard files nor test/cp39-form.test.ts touches this path. Note the precedent: `borangAReport` (localization/my/borang-a.ts:125) already throws the same way, so this is not a novel class \u2014 but `my.cp39` has been non-throwing since slice 0 and this silently changes that. Cheapest fix that keeps the author's intent: move the `cp39FormExtras` call BELOW `if (!b.hasBatch) return empty(...)`, which also removes four wasted queries on the empty path where `loadCp39Form` discards the header anyway."
    },
    {
      "trap": "read-layer-has-no-database-test",
      "detail": "THE PLAN'S OWN BUILD NOTE REQUIRED A READ TEST AND IT WAS NOT WRITTEN. Plan text: \"Tests mirror test/borang-a.test.ts (pagination no-double-count) + a pdf smoke test + a read test (employer header, cp38 aggregation, readiness on missing TIN)\". /Users/zenlam/Projects/ai-hr/.claude/worktrees/r198-cp39/test/cp39-form.test.ts imports only lib/cp39-form, lib/cp39-form-pdf, localization/my/cp39-file and lib/borang-a \u2014 nothing from db/, no `withTenant`, no `reportPreview`, no `cp39FormExtras`. All 58 tests are pure-function or source-text (`expect(SHARED_CODE).toContain(...)`) assertions.\n\nSo the 232 new lines in /Users/zenlam/Projects/ai-hr/.claude/worktrees/r198-cp39/localization/my/cp39-form.ts are never executed by the targeted run: the employer header assembly, `addressLines`, the four-table preparer join (person -> employee_statutory_my -> employment -> assignment -> position, all leftJoin with `.limit(1)`), and the employmentId->{employeeNo,passport} map. The only DB exercise anywhere is test/slice0.test.ts:1084/1105, which asserts `cp39.totals.pcb` and `cp39.readiness` and never inspects `meta.formHeader` or the new row keys. That catches a hard SQL error and nothing else.\n\nConcrete failures this leaves invisible: a preparer join that picks the wrong assignment row (`.limit(1)` over leftJoins with no ordering, so a signatory with two open assignments gets an arbitrary Jawatan); an employer header where every value silently coalesces to '' because `companyStatutoryMy` has no row (which then reads as 'headerMissing' and blocks all downloads, indistinguishable from a genuine gap); `cp38` aggregation across multiple runs of one month. Borang A shipped `test/borang-a-report.test.ts` as its DB twin \u2014 the exact file this build's template has and this build does not."
    },
    {
      "trap": "plan-fidelity-missing-payment-instrument-inputs",
      "detail": "THE APPROVED, REPORTER-FACING PLAN PROMISED AN EDITABLE FIELD GROUP THAT WAS NOT BUILT, AND THE DEVIATION IS NOT IN THE AUTHOR'S SUMMARY. Plan, WHAT WE WILL DO item 1: \"a filter (Payroll Cycle, Month, Year) -> a Preview (auto-filled data shown; the preparer block and payment-instrument fields editable) -> Download PDF\". Plan, MANUAL FIELDS: \"Payment instrument details: cheque/bank draft/postal order no. and branch\" listed under \"leave blank/editable on preview\".\n\nBuilt: /Users/zenlam/Projects/ai-hr/.claude/worktrees/r198-cp39/app/payroll/cp39/preview/page.tsx has inputs for prepName/prepIc/prepPosition/prepPhone/date only. There is no cheque-number or branch input anywhere; app/payroll/cp39/shared.ts documents the omission as deliberate (\"THE PAYMENT INSTRUMENT FIELDS HAVE NO INPUT, DELIBERATELY\") and lib/cp39-form-pdf.ts draws ruled blanks instead. The reasoning is sound, but the reporter approved a screen where those boxes are typed.\n\nAlso missing from the same sentence: the Payroll Cycle selector. The preview filter is Company / Year / Month. (This one is arguably correct \u2014 `loadBatchRows` aggregates across ALL runs of the month by design, so a cycle selector would contradict the arithmetic \u2014 but it is still a named plan element that is absent.)\n\nEither add the two boxes, or the round note must tell the reporter these were dropped and why, because approve carried no payload and they will look for them."
    }
  ]
};

const WORK = [
  { slug: 'cp39', ns: 'r198cp39', id: 'e0cd4583', reverify: true,
    head: `⚠️ YOUR FIRST FINDING IS A REGRESSION ON SHIPPED BEHAVIOUR AND OUTRANKS THE OTHERS: cp39FormExtras ` +
          `is called unconditionally and throws on an unvalidated periodKey, so two screens that previously ` +
          `degraded gracefully now 500. Fix that first and prove the degradation is restored with a case.\n` +
          `Your THIRD finding is a plan-fidelity miss the reporter will notice: the approved plan promised ` +
          `editable payment-instrument fields (cheque / bank draft / postal order no. and branch) and they ` +
          `were not built, and the deviation was not disclosed. Either build them, or put the omission in ` +
          `\`declined\` in words the operator can relay to the reporter — do not leave it silent.` },
  { slug: 'remove', ns: 'r198remove', id: '9066bd6c', reverify: false,
    head: `⚠️ YOUR FIRST FINDING IS A CORRECTNESS BUG, not a nicety: the search filter unmounts rows, so a ` +
          `ticked employee who no longer matches the search box leaves the DOM and is NOT submitted — while ` +
          `the count, the button label, the review list and the confirmation body are all computed from the ` +
          `UNFILTERED list and still name them. The operator is shown one set and removes another, on a ` +
          `destructive payroll action. Fix it so the submitted set and the confirmed set are the same set, ` +
          `and pin it with a case that ticks a row and then searches it out of view.` },
  { slug: 'personnel', ns: 'r198personnel', id: '4ea70bb7', reverify: false,
    head: `Two of your three findings are the same rule twice — a documented invariant this diff falsified, ` +
          `left standing once in the source file it edits and once in the test file it rewrote. The third is ` +
          `user-visible: the module rename reached one back link and not its two siblings, so the same ` +
          `destination is named two different things.` },
];

const preamble = (w) =>
  `You are FIXING verify findings on an existing branch. The work is committed and green; do not regress it.\n\n` +
  `🔒 WORKTREE: ${WT}/r198-${w.slug} (branch build/r198-${w.slug}). \`cd\` there FIRST, confirm with \`pwd\` ` +
  `and \`git branch --show-current\`, run everything from there. READ ${MAIN} freely; never edit it, never ` +
  `touch a sibling worktree. Read what is already on your branch with \`git diff main...HEAD\` first — the ` +
  `findings are about THAT diff.\n\n` +
  `TEST DB NAMESPACE \`${w.ns}\` on EVERY vitest run: TEST_DB_NAMESPACE=${w.ns} pnpm vitest run test/<file>. ` +
  `Never omit it, never invent another, never run the full suite.\n\n` +
  `APPROVED PLAN for scope: ${PLANS}/${w.id}.md. Fixing a finding never licenses new scope.\n\n` +
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
      `Second look at a fix for a REGRESSION. Branch build/r198-${w.slug} in ${WT}/r198-${w.slug}; read it ` +
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

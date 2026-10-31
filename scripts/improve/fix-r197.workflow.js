/**
 * r197 fix pass. Four workstreams address their own verify findings; the fifth — `epfcycle` — is NOT a fix
 * and must not become one.
 *
 * WHY epfcycle IS AN INVESTIGATION. Its approved plan's whole verdict is "No change to the EPF calculation
 * is needed", on the stated premise that the engine already does the combined-month treatment with the
 * monthly contribution ROUNDED ONCE — and ADR-0024 D6 says the same, down to an accountant sign-off
 * worksheet row. The verify pass says the shipped engine is the SUM OF PER-RUN ROUND-UPS, and the build
 * agent's response was to rewrite test comments to match the code. That is the wrong direction of fit: if
 * the code contradicts an approved decision about statutory money, the answer is not to update the prose
 * until it agrees. One of the two is wrong, it changes real EPF contributions, and it is not an agent's
 * call to settle by editing a document. So: establish what the code DOES, with a worked example, and stop.
 */
export const meta = {
  name: 'fix-r197',
  description: 'Apply the r197 verify findings; investigate (not fix) the EPF rounding contradiction',
  phases: [
    { title: 'Fix', detail: 'four branches address their own findings in their own worktrees' },
    { title: 'Investigate', detail: 'EPF rounding: what the engine actually does, and which document is wrong' },
    { title: 'Re-verify', detail: 'independent second look at the two money-affecting workstreams' },
  ],
};

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    testsPass: { type: 'boolean' },
    addressed: { type: 'array', items: { type: 'string' } },
    declined: { type: 'array', items: { type: 'string' } },
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
    resolved: { type: 'array', items: { type: 'string' } },
    unresolved: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['ship', 'fix-first', 'reject'] },
  },
  required: ['verdict', 'resolved', 'unresolved'],
};

const EPF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    whatTheEngineDoes: { type: 'string', description: 'Per-run round-up, combined round-once, or something else — with the call chain and a worked example in ringgit.' },
    workedExample: { type: 'string', description: 'Two runs in one month, real numbers, showing what the engine returns and what each reading would return.' },
    theyDiffer: { type: 'boolean', description: 'Do the two readings produce different money on ordinary inputs?' },
    whichDocumentIsWrong: { type: 'string', description: 'ADR-0024 D6, the approved plan, the tests, or the engine — say which, and on what evidence.' },
    reporterImpact: { type: 'string', description: 'In business terms: is the reporter being told something untrue by the approved plan?' },
    recommendation: { type: 'string', description: 'Close as no-change / re-plan the item / fix the engine — and why. Do NOT recommend editing a document to match the code unless the code is provably right.' },
  },
  required: ['whatTheEngineDoes', 'theyDiffer', 'whichDocumentIsWrong', 'recommendation'],
};

const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const MAIN = `${WT}/mainwt`;
const PLANS = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad/plans';

const WORK = [
  {
    slug: 'entity', ns: 'r197entity', ids: ['1b0943d5', '3c88d593'], reverify: true,
    mandate:
      `TWO BLOCKERS, and they are the same defect seen twice: THE COMPLETENESS CONTROL DOES NOT CONTROL. Its ` +
      `own doctrine is "close is the moment by which every excuse has expired", and both holes let a month ` +
      `close with somebody underpaid. Fix both or return testsPass=false.\n\n` +
      `  B1 THE CLOSE CHECK IS COMPANY-BLIND. core/payroll.ts:5744 filters on \`defects\` + ` +
      `\`missingCompanyIds\` only. \`coverageDefects\` walks date ranges without asking WHICH employer claims ` +
      `each segment, and \`missingCompanyIds\` fires only when a segment's company has no regular batch at ` +
      `all. \`EmploymentCoverage.counterparts[].stale\` — "processed, and what it issued is not what the ` +
      `history now says it owes" (core/payroll-coverage.ts:218) — is COMPUTED AND NEVER READ. Ordinary ` +
      `sequence that closes clean today: Fiamma's August is processed BEFORE the transfer is recorded (mover ` +
      `holds a whole-month slip), the transfer to ISEDECOR effective 11 Aug is then recorded, ISEDECOR's ` +
      `batch exists as a DRAFT — and segmentedCoverage counts a draft because its batch read filters only ` +
      `payPeriod + runType, with no status filter. Decide deliberately whether a DRAFT counterpart should ` +
      `satisfy the check at all, and say why in the code.\n\n` +
      `  B2 THE EXAMINED POPULATION COMES FROM THE BATCH'S OWN PAYSLIPS. core/payroll.ts:5723-5731 derives ` +
      `\`closeIds\` from \`select employmentId from payslip where batchId = …\`, so an employment with no ` +
      `slip on the closing run is never examined. That state is SUPPORTED and pinned: ` +
      `test/r194-entity-transfer-payroll.test.ts:772-798. Consequence — an outgoing scoped run that excluded ` +
      `the mover closes with no refusal; the incoming run is then refused by PayrollCounterpartClosedError; ` +
      `and the operator's natural escape (drop the mover from the incoming scope too) leaves BOTH runs ` +
      `closed clean with the employee paid NOTHING for August, control never firing. Derive the population ` +
      `from what the period's employment history says belongs to this company, not from what the run ` +
      `happened to pay.\n\n` +
      `  S1 THE COMMENT IS THE GUARD. updateBatchScope's docstring (core/payroll.ts:1449-1450) and the inline ` +
      `at :1478 both still say it applies "the SAME cross-company guard" as createRunAction — this diff made ` +
      `updateBatchScope dated and left app/payroll/process/actions.ts:137 on the column. Either date that ` +
      `site too (recording why, as its own decision) or correct both statements.\n\n` +
      `  S2 MIGRATION 0442 DECLARES IN SQL WHAT db/schema.ts DOES NOT. The .sql creates ` +
      `\`payslip_employment_idx\` and the \`payslip_coverage_ordered\` CHECK; db/schema.ts:5206 still declares ` +
      `only the unique index. This repo declares both kinds in the ORM schema (check() appears sixteen ` +
      `times). Add them, or the next drizzle diff proposes dropping them.\n\n` +
      `  S3 A MID-MONTH HIRE PLUS A SAME-MONTH TRANSFER PRODUCES A NON-ADJACENT DUPLICATE. ` +
      `mergeCompanySegments fills uncovered days with the CURRENT company, so hire into A on 15 Aug then ` +
      `A→B on 25 Aug yields B[01-14], A[15-24], B[25-31] — B twice, and coverage before the hire date. ` +
      `Clamp the window to the employment's own dates.`,
  },
  {
    slug: 'pcbview', ns: 'r197pcbview', ids: ['45df860a'], reverify: true,
    mandate:
      `ONE BLOCKER AND TWO SHOULD-FIX, all the same class: a screen whose printed working does not evaluate ` +
      `to the number printed beside it. That is precisely the defect this item exists to remove, so a ` +
      `half-fix is worse than nothing.\n\n` +
      `  B1 THE P-SECTION FORMULA OVERSHOOTS ITS OWN ANSWER ON ANY BONUS MONTH. In ` +
      `app/payroll/pcb-detail/pcb-detail-view.tsx, \`pHeading\`'s substituted string appends ` +
      `\`+ ( Yt − Kt )\` whenever trace.Yt > 0, but the result it lands on is P₁ ` +
      `(localization/my/payroll.ts:541), which has NO Yₜ term — that leg belongs to P₂ (:559). The rendered ` +
      `expression is neither: it keeps trace.K2 (K2n, P₁'s estimated EPF) while adding P₂'s Yₜ leg, and P₂'s ` +
      `own K2a is stored as trace.K2t and never rendered. Worked case: monthlyWage 12,000, month 6, ` +
      `additional 20,000, epfOnAdditional 2,200 — the line overshoots the printed P by 17,800.\n\n` +
      `  S1 THE NET-MTD SUBSTITUTION IGNORES THE §E.3 RM10 FLOOR AND THE ZERO-CLAMPS BESIDE IT. ` +
      `\`formulaNet\` prints \`mtdNormalCalc + mtdAdditionalCalc − zakatCurrent\`, but the engine is ` +
      `applyZakatOffset (localization/my/payroll.ts:324-336): rm10Floor each leg (:317, n < 10 ? 0 : n), ` +
      `then max(0, …) against zakat and its leftover.\n\n` +
      `  S2 A MANUALLY ADJUSTED PCB TURNS THE WHOLE SCREEN INTO A WORKING FOR A NUMBER NOBODY DEDUCTED. ` +
      `core/payroll.ts:4745 applies applyStatutoryAdjustment, overwriting st.pcb and recording before/after ` +
      `under st.adjustment; st.pcbMeta is NOT rewritten, and core/pcb-explain.ts reads pcb from st.pcb while ` +
      `every trace member describes the pre-override computation. Detect the override and SAY so on the ` +
      `screen — never render a working that explains a figure that was replaced by hand.`,
  },
  {
    slug: 'grade', ns: 'r197grade', ids: ['9a65f808'], reverify: false,
    mandate:
      `FOUR SHOULD-FIX. Three are the same one — this diff falsifies a documented rule in three places and ` +
      `leaves every statement of it standing, including inside a hunk it edits.\n\n` +
      `  1. core/benefit-scheme.ts:2 and :12-13 — the module that OWNS listGradeGroups — still says grade ` +
      `groups are "the leave APPROVAL-ROUTING scope" and "no longer select an entitlement. Entitlement ` +
      `targeting is entitlement_eligibility_rule's job."\n` +
      `  2. app/admin/leave/entitlements/page.tsx:207-209 still says the editor lives at /admin/leave/approval ` +
      `and "a grade group is an approval-routing scope, not an entitlement axis".\n` +
      `  3. app/admin/actions.ts:2043-2046, INSIDE updateGradeGroupAction which this diff edits three lines ` +
      `below, still states the old rule. Note its CONCLUSION (no reprojection) may well survive — keep what ` +
      `is still true and correct only what is not, rather than deleting the paragraph.\n\n` +
      `  4. ARCHIVED JOB GRADES LEAK INTO THE PICKER AS RAW UUIDs. ` +
      `components/leave/eligibility-rule-form.tsx:192-199 — optionsFor() unions allGroupMemberGradeIds ` +
      `(every member grade of every group, ticked or not) into the gradeIds options, and withStored labels ` +
      `any id absent from the active catalogue as its own raw value, while loadEntitlementTablesData reads ` +
      `listJobGrades(s), which is active-only. So an archived grade renders as a bare UUID the operator can ` +
      `select.`,
  },
  {
    slug: 'width', ns: 'r197width', ids: ['152fea7f'], reverify: false,
    mandate:
      `TWO SHOULD-FIX.\n\n` +
      `  1. THE COMMENT IS THE GUARD, and this one is an argument, not a label. ` +
      `app/admin/personnel/page.tsx:331-335 (untouched by your branch) explains WHY the cap exists: ` +
      `"max-w-[100rem] is not a new number: it is the container this codebase already settled on for wide ` +
      `screens (payroll, the transaction screens, the leave inquiries), chosen there after measuring — ` +
      `capped rather than full-bleed, because an uncapped table on an ultrawide display is unreadable in the ` +
      `other direction." Your diff removes that cap from payroll. Either that reasoning was wrong — say so ` +
      `where the reasoning lives — or the approved item overrides it for payroll specifically and the ` +
      `sentence must stop claiming payroll as its evidence. Do NOT leave it asserting a fact about payroll ` +
      `that payroll no longer exhibits.\n\n` +
      `  2. THE NEW GUARD'S NAME CLAIMS COVERAGE ITS LOOP DOES NOT HAVE. ` +
      `test/payroll-screens-layout.test.ts:132 is named "the old max-w-[100rem] cap is gone from the module, ` +
      `not merely from most of it", and its own comment says a partial sweep is the defect — but the loop ` +
      `iterates ALL_WIDE, the nineteen files this round already edited, so it can only ever confirm what the ` +
      `round did. Three payroll screens are reportedly still outside it. Either enumerate the module from ` +
      `disk so the case means what its name says, or rename the case to what it actually checks. A guard ` +
      `that cannot fail is worse than no guard, because it reads as coverage.`,
  },
];

const preamble = (w) =>
  `You are FIXING findings on an existing branch. The work is committed and green; address the findings ` +
  `WITHOUT regressing it.\n\n` +
  `🔒 YOUR WORKTREE: ${WT}/r197-${w.slug} (branch build/r197-${w.slug}). \`cd\` there FIRST and confirm with ` +
  `\`pwd\` and \`git branch --show-current\`. Run every command from there. You may READ ${MAIN}; never edit ` +
  `it, never touch a sibling r197-* worktree. Review what is already on your branch with ` +
  `\`git diff main...HEAD\` before changing anything — the findings are about THAT diff.\n\n` +
  `TEST DATABASE NAMESPACE \`${w.ns}\` on EVERY vitest run:\n` +
  `    TEST_DB_NAMESPACE=${w.ns} pnpm vitest run test/<file>.test.ts\n` +
  `Never omit it, never invent another, never run the full suite.\n\n` +
  `PLAN(S) for scope: ${w.ids.map((id) => `${PLANS}/${id}.md`).join(', ')}. Fixing a finding never licenses ` +
  `new scope.\n\n` +
  `GATE before testsPass=true: \`npx tsc --noEmit\` clean, your touched tests green, \`pnpm build\` compiles. ` +
  `Then \`git add -A\` and commit on your branch. Never weaken, skip or delete a test to go green; if a guard ` +
  `asserts the opposite of your change, UPDATE the case. No dev server, no watch mode. Long output to a ` +
  `file with \`> log 2>&1\`, never a pipe.\n\n` +
  `YOU MAY DECLINE A FINDING if you can show it is wrong — put it in \`declined\` with the evidence. Do not ` +
  `decline because it is inconvenient.\n\nFINDINGS TO ADDRESS:\n${w.mandate}`;

phase('Fix');
phase('Investigate');
phase('Re-verify');

// ── EPF: establish the truth, change nothing ─────────────────────────────────────────────────────────
const epf = agent(
  `INVESTIGATION ONLY — do not edit, commit, or "fix" anything, in any worktree. Read-only.\n\n` +
    `A contradiction about STATUTORY MONEY has surfaced and it must be settled by evidence, not by editing ` +
    `whichever document is easier to change.\n\n` +
    `THE APPROVED PLAN for board item \`bdf7d248\` (${PLANS}/bdf7d248.md) says, as its entire verdict: "No ` +
    `change to the EPF calculation is needed", on the premise that when two cycles fall in one month the ` +
    `system "works out EPF on the COMBINED monthly wage and charges the second cycle only the difference", ` +
    `with the monthly contribution ROUNDED ONCE. It tells the reporter their calculation is already correct.\n\n` +
    `ADR-0024 D6 (${MAIN}/docs/adr/0024-multi-cycle-payroll.md:98-99) says the same: "Rounding: round the ` +
    `combined monthly contribution once — the monthly EPF is round(Σ run EPF-wages × rate), not the sum of ` +
    `per-run round-ups, for return consistency." Line ~155 carries an accountant sign-off worksheet row ` +
    `deriving RM1,650 from ceil((5,000 + 10,000) × 11%).\n\n` +
    `A REVIEW OF THE r197 BUILD SAYS THE ENGINE IS THE SUM OF PER-RUN ROUND-UPS — i.e. that the plan's ` +
    `premise and the ADR's D6 are both false — and the build agent's response was to rewrite test comments ` +
    `to match the engine.\n\n` +
    `Settle it from the code in ${MAIN} (branch main), read-only:\n` +
    `  · localization/my/payroll.ts — epf() / epfContribution() / statutory(), the Third Schedule bands and ` +
    `ceilRinggit.\n` +
    `  · the multi-cycle increment path: how the second run's contribution is derived from the first.\n` +
    `  · test/multicycle-compute.test.ts and test/multicycle-kernel.test.ts — what the assertions actually ` +
    `pin, as opposed to what their comments say.\n` +
    `  · docs/architecture/STATUTORY-SOURCES.md for the sourced rules.\n\n` +
    `Produce a WORKED EXAMPLE in ringgit for two runs in one month (use the ADR's own 5,000 + 10,000 if it ` +
    `is representative) showing what the engine returns and what each reading would return, employee AND ` +
    `employer — the employer band is anchored differently and a review comment says the two readings ` +
    `disagree there too.\n\n` +
    `Then say which is wrong: the engine, ADR-0024 D6, the approved plan, or the tests. **Do NOT recommend ` +
    `editing a document to match the code unless the code is provably right** — if the engine violates an ` +
    `approved decision about statutory money, the finding is that the engine is wrong and the reporter has ` +
    `been told something untrue. If the evidence does not settle it, say so plainly; a confident wrong ` +
    `answer here changes real people's EPF contributions.`,
  { schema: EPF_SCHEMA, phase: 'Investigate', label: 'investigate:epf-rounding', effort: 'xhigh' },
);

const results = await pipeline(
  WORK,
  (w) => agent(preamble(w), { schema: FIX_SCHEMA, phase: 'Fix', label: `fix:${w.slug}`, effort: 'xhigh' }).then((fix) => ({ w, fix })),
  (prev) => {
    const { w, fix } = prev || {};
    if (!w) return null;
    if (!w.reverify || !fix?.testsPass) {
      if (w.reverify) log(`fix:${w.slug} not green — skipping re-verify`);
      return { w, fix, re: null };
    }
    return agent(
      `Second, independent look at a MONEY-AFFECTING fix. Branch build/r197-${w.slug} in ` +
        `${WT}/r197-${w.slug}; read it with \`git diff main...HEAD\`. READ-ONLY — no edits, no test suite.\n\n` +
        `These findings were raised against the earlier state:\n${w.mandate}\n\n` +
        `The author now claims to have addressed them:\n${(fix.addressed || []).map((a) => `  - ${a}`).join('\n')}\n` +
        (fix.declined?.length ? `They declined:\n${fix.declined.map((d) => `  - ${d}`).join('\n')}\n` : '') +
        `\nDecide from the CODE, not the claim, whether each is genuinely resolved. Then hunt once more for a ` +
        `defect the fix introduced: a widened predicate, a guard relaxed to make a test pass, a comment now ` +
        `contradicting its code, a refusal that now fires on a legitimate case.\n` +
        (w.slug === 'entity'
          ? `For this one specifically: try to construct a sequence that still closes a month with somebody ` +
            `underpaid — a scoped-out mover, a draft counterpart, a stale whole-month slip, a mid-month hire ` +
            `plus transfer. If you can build one, that is unresolved.\n`
          : `For this one specifically: pick two or three concrete inputs, evaluate the rendered formula ` +
            `string BY HAND, and check it equals the figure printed beside it. That arithmetic is the whole ` +
            `deliverable.\n`) +
        `\nverdict=ship only if every blocker is genuinely gone and you found nothing new.`,
      { schema: REVERIFY_SCHEMA, phase: 'Re-verify', label: `reverify:${w.slug}`, effort: 'high' },
    ).then((re) => {
      log(`reverify:${w.slug} → ${re?.verdict ?? 'none'} (${(re?.unresolved || []).length} unresolved)`);
      return { w, fix, re };
    });
  },
);

const epfFinding = await epf;

const out = results.filter(Boolean).map((r) => ({
  slug: r.w.slug,
  ids: r.w.ids,
  branch: `build/r197-${r.w.slug}`,
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
  `re-verified ship: ${out.filter((o) => o.reverifyVerdict === 'ship').length} · ` +
  `EPF: ${epfFinding?.theyDiffer ? 'READINGS DIFFER' : 'readings agree'}`);

return { fixes: out, epf: epfFinding };

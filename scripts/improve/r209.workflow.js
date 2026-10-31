export const meta = {
  name: 'r209-build-approved',
  description: 'Build the 11 approved board items as 7 workstreams, each verified adversarially',
  phases: [
    { title: 'Build' },
    { title: 'Verify' },
  ],
};

// The parent created every worktree from main and linked node_modules. Agents MUST stay inside their
// own path — `isolation: 'worktree'` is forbidden here (AGENTS: it would cut the tree from root HEAD).
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r209plans';

const COMMON = `
ENVIRONMENT AND HARD RULES — read before touching anything.

- Your worktree is the ONLY place you may edit. cd into it in EVERY bash command; the shell's cwd resets
  between calls and the repo ROOT is a stale scratch tree. This has cost five rounds. Verify with
  \`pwd\` and \`git rev-parse --abbrev-ref HEAD\` in your first command.
- This is NOT the Next.js you know. Read the relevant guide under node_modules/next/dist/docs/ before
  writing any Next-specific code.
- Understand code through the graph, not by grepping cold: from ${WT}/mainwt run
  \`graphify explain "<symbol>"\`, \`graphify query "<question>"\`, \`graphify affected "<symbol>"\`.
- TESTS: run ONLY narrowly targeted files — the ones you add plus the ones directly covering what you
  changed. NEVER run the full suite; the parent runs the single full gate alone afterwards. Always
  \`npx vitest run <specific files> > /tmp/<slug>.log 2>&1\` then read the log — never pipe to tail, and
  read the exit code plus the file count, not just the summary.
- You have your own TEST_DB_NAMESPACE (below). Export it in every test command. Do not invent another.
- \`npx tsc --noEmit\` must be clean before you commit.
- A new file under core/ must import packs/<pack>/service, NEVER the pack implementation — the
  pack-drift ratchet scans the FILESYSTEM (a stray untracked file trips it) and test/borang-a.test.ts's
  code() strips comments while the ratchet does not. The fix is never the allowlist.
- A new guarded page.tsx needs a column in the function-access matrix (lib/permissions.ts) or
  test/function-access.test.ts's reverse-completeness case fails. Attach it to an EXISTING screen key.
- A guard may pin the decision you are reversing. UPDATE its case with the new reasoning; never delete
  the case. Two tests asserting opposite things are invisible to a targeted run.
- i18n: add keys to messages/en.json AND ms, zh, ta, th, vi. Parity is enforced; a stale VALUE is not,
  so write real translations rather than copying English.
- A form field that is always submitted cannot be read by presence, and a DISABLED control posts
  nothing. When a defect lives in the CONTRACT between two files, pin it with source-shape assertions
  across BOTH — a unit test of either half passes throughout.
- COMMIT your work on your branch when done (git commit; never amend or rebase, never git stash —
  stashes are repo-global and another agent will get yours).

EVERY TEST YOU ADD MUST BE PROVED NON-VACUOUS: revert the fix (from a \`cp\` copy taken first, never
\`git checkout --\`), watch the intended assertion FAIL, then restore. A guard that passes with the fix
removed is worse than none — this session has shipped three of them. State in your report which
assertion you watched fail.

Return a report: what you changed, the tests you added and what each pins, the non-vacuity proof, and
anything in the plan you did NOT build and why.
`;

const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'committed', 'tscClean', 'testsPass', 'summary', 'notBuilt'],
  properties: {
    slug: { type: 'string' },
    committed: { type: 'boolean', description: 'true if you committed on your branch' },
    commitSha: { type: 'string' },
    tscClean: { type: 'boolean' },
    testsPass: { type: 'boolean' },
    testFiles: { type: 'array', items: { type: 'string' } },
    nonVacuityProof: { type: 'string', description: 'which assertion you watched fail with the fix reverted' },
    summary: { type: 'string' },
    notBuilt: { type: 'array', items: { type: 'string' }, description: 'plan points deliberately not built, with the reason' },
    migrationsUsed: { type: 'array', items: { type: 'string' } },
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'verdict', 'findings'],
  properties: {
    slug: { type: 'string' },
    verdict: { type: 'string', enum: ['ship', 'fix-first'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'claim', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          claim: { type: 'string' },
          evidence: { type: 'string', description: 'file:line plus the concrete input that reaches it' },
          introducedByThisBranch: { type: 'boolean' },
        },
      },
    },
  },
};

const WORK = [
  {
    slug: 'leave',
    ns: 'r209leave',
    items: ['70ac09ef', '301d3f6b', '273e6fc7'],
    brief: `THREE ITEMS, ONE ROOT CAUSE — build them together or they will fight each other.

Read all three approved plans: ${PLANS}/70ac09ef.txt, ${PLANS}/301d3f6b.txt, ${PLANS}/273e6fc7.txt.

THE SHARED FACT, measured on production and stated in all three plans: there is exactly ONE
entitlement_eligibility_rule on the tenant, it points at the PERMANENT Medical template, and
valid_to = 2026-08-13 — expired. Since then NO employee resolves to any entitlement template.

WHAT TO BUILD (this is a CODE round; the customer's own configuration data is theirs to enter):
1. Surface the causes that are currently silent. On the leave type list and editor, show per type:
   whether an earning method is set (leave_type.accrual_method / accrual_unconfigured — already
   populated, read by NO surface today, which is the defect), how many entitlement templates it has,
   and whether any eligibility rule actually points at each template.
2. A "why is this balance zero" explanation on the employee leave balance surface: name the specific
   missing piece — no earning method / no entitlement table / no eligibility rule matches you / capped
   by Maximum Balance — instead of rendering 0.00 silently.
3. WARN when an eligibility rule is expired or expiring, and when a Job Grade belongs to no template.
   Both are silent today and are why this went unnoticed from 13 August.
4. Show which entitlement TABLE an employee resolved to, so HR can confirm the right one was chosen
   rather than inferring it from the day count.
5. Recalculate on save: saving an entitlement template or leave type should trigger the existing
   entitlement recompute for affected employments rather than relying on a manual Generate Entitlement.
   Keep the manual action; make it unnecessary. leave_entitlement_recalc_audit already exists.

SCOPE FENCES — do not cross these:
- Do NOT change what maxBalanceDays: 0 MEANS. core/leave-compute.ts bandMaxBalance treats any finite
  number >= 0 as a real cap and that is deliberate. Item 301d3f6b's plan flags the usability trap
  explicitly OUTSIDE the item. You may WARN that a cap of 0 zeroes the type; you may not change the
  semantics.
- Do NOT write eligibility rules or leave-type configuration as a migration or a seed. The editor
  exists; the customer configures through it. Your job is to make the missing configuration VISIBLE and
  the resolution EXPLAINABLE.
- Grade "Executive" maps to no Medical template and the reporter has not yet said which it should use.
  Leave it unmapped — your warning from (3) is exactly what should surface it. Do not guess a mapping.
- The shared Special Leave pool uses leave_type.balance_source_type_id, which ALREADY works (Emergency
  Leave draws from Annual Leave on production). Verify the refusal path when an application exceeds the
  shared balance, and make the employee-facing balance read as ONE shared figure with the contributing
  types named. Do not build a second pooling mechanism.

Expect NO migration. If you believe you need one, stop and say so in your report instead of taking a
number — numbers are allocated centrally.`,
  },
  {
    slug: 'cp39',
    ns: 'r209cp39',
    items: ['7ee14bbc'],
    brief: `Read the approved plan: ${PLANS}/7ee14bbc.txt. It contradicts three of the five points in the
original ticket, on measured evidence. Build what the PLAN says, not what the ticket says.

1. FILTER THE PRINTED TABLE to rows with pcb > 0 OR cp38 > 0. The header counts (pcbEmployees /
   cp38Employees, lib/cp39-form.ts:398-399) already count exactly that and match cp39-file.ts's record
   rule; the table prints everyone the run paid. On the customer's 2026-08 run that is 38 rows against a
   count of 7. Pin that printed rows === the corresponding count. \`employees\` (rows.length) stays as
   the "everyone paid" figure — it is not a box on the form.
2. IC FORMATTING to XXXXXX-XX-XXXX at RENDER ONLY. The e-Data upload file is fixed-width and must stay
   unformatted (lib/cp39-form.ts:539 pads to 14). Assert the generated FILE is byte-identical before and
   after your change — that assertion is the point of this task, not an extra.
3. DUPLICATE TAX NUMBER WARNING on the preview, naming both employees. readinessFor already flags a
   MISSING tax number; this adds DUPLICATED. On production five numbers are each shared by 2-3 people
   with different ic_numbers (e.g. SG90010101 is Aisyah Rahman and Irwin Law) — it is real data, not a
   join bug, so the warning is the deliverable and the export must keep printing what is filed.
4. LAYOUT: transcribe the LHDN masthead and the A/B/C instruction panels from the customer's specimen.
   lib/cp39-form-pdf.ts's header currently records that these are deliberately NOT drawn because we had
   never read them. UPDATE that comment with the new source and its provenance — do not delete it, and
   do NOT raise fidelity above 'figures': the specimen is Developer Express DXperience output, a vendor
   rendering, not LHDN artwork.
5. cp39-form-pdf.ts:367 uses textClip for names, which truncates. lib/borang-a-pdf.ts moved to textFit
   for exactly this reason — do the same here.

No migration.`,
  },
  {
    slug: 'ea',
    ns: 'r209ea',
    items: ['6036dab7'],
    brief: `Read the approved plan: ${PLANS}/6036dab7.txt.

The BM EA already exists (my.ea.ms, localization/my/reports.ts:1229; item 587ee719 split en/ms as a
\`lang\` param over ONE renderer, lib/ea-pdf.ts). DO NOT ADD A SECOND RENDERER — the header comment there
explains why and it still holds: two renderers can disagree about one employee's income on a tax document.

Against the customer's field mapping, lib/ea-pdf.ts prints today:
  A: name, taxNo, ic, epfNo, socsoNo, mtdCategory, children, employmentPeriod
  B: grossSalary, bonus, allowances, exemptAllowances, total (benefitsInKind + livingAccommodation are
     hardcoded to t.notTracked)
  C: ABSENT ENTIRELY — no sectionC constant exists
  D: mtd (cp38 and zakat hardcoded to t.notTracked)
  E: epf, socso, eis

BUILD, in this order of value:
1. SECTION C (Pencen dan Lain-lain): pension and annuity, plus the section total. This is the clearest gap.
2. CP38 and ZAKAT in section D. Both figures now EXIST (r.st.cp38 is stamped and read by cp39(); zakat
   has its own transactions screen) — those two "not tracked" lines are stale, not unimplemented. Confirm
   an ANNUAL aggregate exists before wiring, and keep the muted "not tracked" style for anything
   genuinely absent.
3. Section A: job title, employee code, passport. All exist on tables already joined — cp39FormExtras
   reads the passport for the same purpose. Reuse that read; do not add a column.
4. Section B breakdown: separate lines for director's fees, perquisites, tax borne by employer, gratuity,
   arrears — per the mapping. Where a line has no payroll source, it belongs in (5), not invented here.
5. Manual-entry boxes (ESOS, gratuity, benefits in kind, living accommodation, unapproved fund refunds,
   compensation for loss of employment): EXTEND the existing generic amend mechanism
   (app/payroll/reports/ea/[employmentId]/ea-amend-panel.tsx takes {field, amount, reason, year,
   employmentId} and the PDF already prints an "amended" footnote). Extend the allowed field list — do
   NOT build a second override path.

If (4) and (5) cannot be finished cleanly, ship 1-3 and say so in notBuilt. The plan itself proposes
that split; a partial that is correct beats a whole that is not.

If you need a migration, say so in your report — do not take a number.`,
  },
  {
    slug: 'payslip',
    ns: 'r209payslip',
    items: ['6b4ca488', '5a29686c'],
    brief: `TWO ITEMS, ONE FILE — they both edit app/payroll/individual-payslip/page.tsx, which is why they
are one workstream. Read both approved plans: ${PLANS}/6b4ca488.txt and ${PLANS}/5a29686c.txt.

PART 1 (6b4ca488, small and mandatory — do this FIRST and commit it before starting anything else):
app/payroll/individual-payslip/page.tsx:675 renders
    <span className="tabular-nums">−{rm(b.totalDeductions)}</span>
That is a literal U+2212 prefix on an already-positive formatted value. Remove it. Sweep Transaction
View's history and detail surfaces for the same prefix — the ticket names both screens and r206 touched
the history pivot. Add a source-shape assertion so the sign cannot come back.

PART 2 (6b4ca488, large): a Statutory Explanation covering EPF, SOCSO, EIS, HRDF, SKBBK and PCB —
statutory wage, the rule/rate applied, the working, and the final employee and employer amounts.
- Reachable BOTH from the Individual Payslip for the slip on screen AND as a new tab under
  /payroll/transaction-view (that page already has fixed/individual/history/outstanding tabs — add
  alongside, same mechanism).
- READ THE PERSISTED WORKING ONLY. The precedent is app/payroll/pcb-detail (item 45df860a), which reads
  the payslip's OWN pcbMeta so an old slip explains itself with the rules that were true when it ran.
  DO NOT recompute from today's configuration: an explanation that disagrees with the payslip beside it
  is the worst possible outcome here.
- payslip.statutory.bases is stamped only from r187 onward and is present on a MINORITY of payslips.
  Pre-r187 rows must be FLAGGED as "working not recorded" — never silently fall back to gross.
- A summary of all six with employee and employer amounts, and an Excel export (reuse the existing
  grid-export route pattern; do not write a new exporter).
- The new tab needs a lib/permissions.ts entry attached to the Transaction View screen key.

PART 3 (5a29686c, small): the plan's verdict is ALREADY WORKS — the Company/Year/Month/Cycle dropdowns
exist and desc(payPeriod) + matches[0] already opens the latest run. Build ONLY the two real gaps:
- page.tsx:228 \`years = Array.from({length: 11}, (_, i) => nowYear + 1 - i)\` is a fixed window. Replace
  with the distinct periods the EMPLOYEE actually has payslips for; same for months within the chosen
  year. Keep a sensible fallback when they have none.
- Give the otherRuns SectionHeader a one-line subtitle saying what it is for (it appears only when more
  than one run matches all four dropdowns — a regular plus a bonus run, or a re-issue).
DO NOT remove or restructure the otherRuns card. It is the only control that separates two runs sharing
company + year + month + cycle, and its gating on matches.length > 1 is deliberate.

No migration expected.`,
  },
  {
    slug: 'attendance',
    ns: 'r209att',
    items: ['0bade264', '6448574f'],
    brief: `TWO ITEMS, ONE NAV — both edit the sidebar and messages/*.json. Read both approved plans:
${PLANS}/0bade264.txt and ${PLANS}/6448574f.txt.

PART 1 (6448574f, label-only). Change the VALUES, not the key names:
  nav.attendanceRequest  "Attendance Request" -> "Attendance Irregularity"
  nav.planOvertime       "Plan OT"            -> "Self Overtime"
  me.attendanceRequest   "Attendance Request" -> "Attendance Irregularity"
  me.planOtTitle         "Plan OT"            -> "Self Overtime"
Sweep en + ms, zh, ta, th, vi, AND the body copy/subtitles on those two screens — a renamed menu leading
to a page that still says the old name is the half-done version. Routes stay as they are; renaming
/attendance/requests would break existing links for no gain.

PART 2 (0bade264, the rename WITH A COLLISION YOU MUST HANDLE):
- nav.attendanceSettings "Attendance settings" -> "Attendance", as the customer asked.
- BUT nav.attendance is ALREADY "Attendance" (the operational module). Doing only the above yields TWO
  identical menu entries. The approved plan says: rename the operational one to "Attendance Records".
  Do both, or the result is worse than before.
- components/sidebar.tsx:106-111 records that ad52212d renamed \`attendance\` -> \`attendanceSettings\` at
  this same reporter's request, and test/attendance-menu-relocation.test.ts pins the const's MOUNT
  POSITION through that identifier. UPDATE that test's case and the comment with the new reasoning —
  the mount-position half is still correct and must be kept. Do not delete the case.

PART 3 (0bade264, the real build): Schedule Assignment under Attendance.
- A list of every employee's CURRENT shift arrangement: employee ID, name, shift type, backup shift,
  effective date, current/latest status. Search and filter. A View/Edit action per row.
- The model already exists and needs NO migration: employment_shift_arrangement (db/schema.ts:4145) —
  shiftType ('fixed'|'roster', CHECK-constrained), shiftId NOT NULL (b8aa3466 made the backup shift
  mandatory), validFrom, and a "live" unique index employment_shift_arrangement_live_uq. THE LIVE INDEX
  IS WHAT "current arrangement" MEANS — read it; do not compute latest by sorting in application code.
- View/Edit must open the SAME editor used under Personnel Management > Employee > Attendance > Shift
  Arrangement. The customer's requirement is that both surfaces act on one record; two editors is
  exactly how they drift. Reuse, do not duplicate.
- The new page.tsx needs a lib/permissions.ts entry attached to the existing attendance screen key.

No migration.`,
  },
  {
    slug: 'tp1',
    ns: 'r209tp1',
    items: ['7ad37961'],
    brief: `Read the approved plan: ${PLANS}/7ad37961.txt. This one is a REWORK of held work, not a fresh build.

The completed 2026 TP1 e-form already exists on branch build/r201-tp1 (commits e2b98f60 and c0fbe661:
778 lines added to core/tax-relief.ts, migrations 0444+0445, ADR-0081, the full form, approval step,
bilingual PDF and payroll link). It was HELD, never merged, for one reason.

THE CONFLICT: 0445's backfill marks every legacy declaration approved and effective ALL YEAR. The payroll
feed SUMs the effective rows so it takes the FULL amount, while the limit check accumulates through
accumulate(), which skips non-catalogue shapes, so the backfilled row contributes ZERO to the "Remaining"
figure HR keys against. A legacy RM 9,000 declaration therefore adds nothing to what HR is told is left
and its full amount to what payroll receives. HR keys an increment against a baseline missing the legacy
row and the PCB is silently wrong, reachable through the shipped UI.

HOW TO REWORK IT:
1. Start from build/r201-tp1's content — merge that branch into YOUR branch and work forward. Do not
   rewrite it from scratch and do not rewrite ITS commits.
2. ⚠️ MIGRATIONS 0444 AND 0445 ARE DEAD. They sit below the deployed watermark now that 0446 and 0447
   have shipped, so merging either would be SILENTLY SKIPPED (a migration numbered below the watermark
   never runs and reports nothing). REISSUE THEM AS **0448** and **0449** — those numbers are allocated
   to you and to nobody else. Renumber the .sql files AND their journal entries; the journal is
   APPEND-ONLY and must never be re-sorted, and idx must ascend.
   ⚠️ 0444's own header records that it REPLACES the tp1_status enum rather than adding values, and that
   a new enum value cannot be used by another migration in the same run — 0445's backfill hit exactly
   that. Carry that note across to the new numbers; it is the kind of thing rediscovered expensively.
3. THE FIX IS ONE DECISION APPLIED TWICE, not a patch to either side. The approved plan's rule: a legacy
   declaration is effective from the month it was APPROVED, not the whole year. Express that ONCE and
   have BOTH the limit check and prefillTp1FromSelfRelief consume it.
4. Show HR, on the screen, what has already been counted for the year and where it came from, so the
   remaining figure is not a number they must trust blindly.
5. Add a reconciliation: run every existing declaration through both paths and assert they agree. The
   defect lives in the CONTRACT between two files, so a unit test of either half passes throughout —
   pin it with a case that drives BOTH from ONE fixture and asserts equality.

Two agent fix passes already made this worse by patching one side at a time. Do not do that again: if
you cannot express the rule once and consume it twice, stop and report rather than patching.`,
  },
  {
    slug: 'epf',
    ns: 'r209epf',
    items: ['bdf7d248'],
    brief: `Read the approved plan: ${PLANS}/bdf7d248.txt. READ THE SEQUENCING SECTION TWICE.

THE FINDING: localization/my/multicycle.ts implements the entire ADR-0024 Wave 2C design — the statutory
month as ONE computation, runs as increments, SOCSO/EIS charged once per Act 4 s.6(7)/6(9), EPF on the
combined-month round-up. Its only export, computeMonthlyRuns, is imported by
test/multicycle-compute.test.ts AND BY NOTHING ELSE. Its header's "NOT wired into the live payroll
kernel" is still true. Meanwhile MULTI_CYCLE_PAYROLL_ENABLED=true on production gates CREATING additional
same-month runs (core/payroll.ts:1415), so the situation is reachable and the handling for it is not
connected. The live path calls pack.payroll.statutory(...) per batch (core/payroll.ts:4860) and each run
bands independently.

⚠️⚠️ WHAT YOU MUST **NOT** DO: do NOT wire computeMonthlyRuns into the payroll kernel. ADR-0024 §5 gates
that on accountant sign-off of the §7 worksheet, and the approved plan explicitly sequences the worksheet
FIRST. Changing live statutory EPF without that sign-off is out of scope and would be the whole reason
this item was held.

WHAT TO BUILD — the worksheet, and only the worksheet:
- A READ-ONLY replay over historical payroll: for every (company, month, employee) that had MORE THAN ONE
  run, compute what the statutory figures ARE today (the sum of the independent per-run results, which is
  what was actually paid) and what they WOULD BE under computeMonthlyRuns, and show the difference per
  statutory item (EPF employee/employer, SOCSO, EIS, PCB).
- NO WRITES. No recompute of issued payslips, no mutation of any payroll row. This is a report.
- Totals: how many employee-months are affected, how many differ at all, and the total ringgit movement
  per statutory item and per side. The plan promises the customer "the worksheet will tell you exactly
  how often, on your own data, rather than us guessing" — that number is the deliverable.
- EXCLUDE any month containing a reversal or a negative delta rather than silently clamping. ADR-0024 §6
  puts reversals out of scope and computeMonthlyRuns clamps deltas at >= 0; a clamped month would
  understate the difference and the worksheet would be quietly wrong.
- Flag months where the per-run inputs cannot be reconstructed (e.g. missing persisted statutory bases)
  rather than assuming.
- A worked example of the arithmetic on screen so an accountant can follow one employee end to end.
- The new page.tsx needs a lib/permissions.ts entry; attach it to an existing payroll screen key.

Reference figures for your own test, verified against the code: wage 5,001 with a second run of 1,001,
employee side — two independent runs give epf(5001,0)=561 + epf(1001,0)=113 = 674, while the month as one
wage gives epf(6002,0)=671. RM3. Note that the existing golden case 5,000 + 10,000 yields 1,650 under
BOTH readings, so it cannot distinguish them — do not use it as your fixture.

No migration.`,
  },
];

phase('Build');
log(`r209: ${WORK.length} workstreams covering 11 approved items`);

const results = await pipeline(
  WORK,
  (w) =>
    agent(
      `You are building workstream "${w.slug}" of round r209, covering board item(s) ${w.items.join(', ')}.

YOUR WORKTREE: ${WT}/r209-${w.slug}   (branch build/r209-${w.slug}, created from main by the parent)
YOUR TEST DB NAMESPACE: export TEST_DB_NAMESPACE=${w.ns}

${w.brief}

${COMMON}`,
      { label: `build:${w.slug}`, phase: 'Build', schema: BUILD_SCHEMA },
    ),
  (built, w) => {
    if (!built) return null;
    return agent(
      `ADVERSARIAL VERIFICATION of workstream "${w.slug}" (board item(s) ${w.items.join(', ')}), round r209.

WORKTREE: ${WT}/r209-${w.slug}   (branch build/r209-${w.slug})
TEST DB NAMESPACE (if you need to run anything): export TEST_DB_NAMESPACE=${w.ns}v

The approved plan(s) are at ${w.items.map((i) => `${PLANS}/${i}.txt`).join(' and ')}.

The builder reported:
${JSON.stringify(built, null, 2)}

YOUR JOB IS TO TRY TO BREAK IT, not to confirm it. Read the actual diff (\`git diff main...HEAD\`) and the
files around it. Default to scepticism: a claim in the builder's report is a hypothesis, not evidence.

Look specifically for:
1. A DEFECT THIS BRANCH INTRODUCED. Rank these highest and set introducedByThisBranch. Something that
   worked before and does not now is worse than something that was already imperfect.
2. A GUARD THAT CANNOT FAIL. Re-derive the non-vacuity claim yourself — revert the fix from a cp copy and
   check the named assertion actually fails. This session has shipped three vacuous guards; two were
   caught only by doing exactly this.
3. THE PLAN'S PROMISE vs WHAT SHIPPED. The plan is what the customer approved. Anything promised and not
   built, or built differently, is a finding — as is anything built that the plan did not promise.
4. SCOPE FENCES CROSSED. Each brief named things NOT to do (do not change maxBalanceDays semantics; do
   not wire computeMonthlyRuns into the kernel; do not raise CP39 fidelity; do not add a second EA
   renderer; do not remove the otherRuns card; do not build a second pooling mechanism). Check each.
5. Money- or pay-affecting behaviour reachable through the UI with ordinary input.
6. Anything a reader of the code in six months would misread, especially a comment that is now false.

Give each finding a concrete failure path — the input or state that reaches it, with file:line. A finding
without one is a guess; say so or drop it. Verdict 'fix-first' only if a blocker or a real major exists.`,
      { label: `verify:${w.slug}`, phase: 'Verify', schema: VERIFY_SCHEMA },
    ).then((v) => ({ built, verify: v }));
  },
);

const done = results.filter(Boolean);
const green = done.filter((r) => r.built?.committed && r.built?.tscClean && r.built?.testsPass);
const blockers = done.flatMap((r) =>
  (r.verify?.findings ?? [])
    .filter((f) => f.severity === 'blocker')
    .map((f) => ({ slug: r.built.slug, ...f })),
);

log(`build: ${green.length}/${WORK.length} green · ${blockers.length} blocker(s) across all workstreams`);

return {
  workstreams: done.map((r) => ({
    slug: r.built.slug,
    committed: r.built.committed,
    commitSha: r.built.commitSha,
    tscClean: r.built.tscClean,
    testsPass: r.built.testsPass,
    migrationsUsed: r.built.migrationsUsed,
    notBuilt: r.built.notBuilt,
    nonVacuityProof: r.built.nonVacuityProof,
    verdict: r.verify?.verdict ?? 'no-verify',
    findings: r.verify?.findings ?? [],
  })),
  blockers,
};

export const meta = {
  name: 'r253-build-approved',
  description: 'Build 6 approved board items as 6 workstreams, each verified adversarially',
  phases: [{ title: 'Build' }, { title: 'Verify' }],
};

// The PARENT created every worktree from main, copied .env.local and symlinked node_modules.
// `isolation: 'worktree'` is FORBIDDEN here (HANDOFF: it cuts the tree from root HEAD, and the repo
// root is a stale scratch worktree).
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r253plans';

const COMMON = `
ENVIRONMENT AND HARD RULES — read before touching anything.

- Your worktree is the ONLY place you may edit. Put \`cd <your worktree> &&\` in EVERY bash command; the
  shell's cwd resets between calls and the repo ROOT is a stale scratch tree. This has cost five rounds.
  Prove it in your FIRST command: \`cd <wt> && pwd && git rev-parse --abbrev-ref HEAD\`.
- This is NOT the Next.js you know (16.2.7). Read the relevant guide under node_modules/next/dist/docs/
  before writing any Next-specific code. Heed deprecation notices.
- Understand code through the graph, not by grepping cold: from ${WT}/mainwt run
  \`graphify explain "<symbol>"\`, \`graphify query "<question>"\`, \`graphify affected "<symbol>"\`.
- TESTS: run ONLY narrowly targeted files — the ones you add plus the ones directly covering what you
  changed. NEVER run the full suite; the parent runs the single full gate alone afterwards. Always
  \`npx vitest run <specific files> > /tmp/<slug>.log 2>&1\` then READ the log — never pipe to tail, and
  read the exit code AND the file count, not just the summary.
- You have your own TEST_DB_NAMESPACE (below). Export it in every test command. Do not invent another.
  Two agents sharing a namespace wipe each other's worker databases.
- \`npx tsc --noEmit\` must be clean before you commit.
- NO MIGRATION IS EXPECTED IN THIS ROUND. Every field these items need already exists (verified by the
  parent). If you believe you need one, STOP and say so in your report — numbers are allocated centrally
  and taking one yourself silently breaks the deploy ordering.
- A new file under core/ must import packs/<pack>/service, NEVER the pack implementation — the
  pack-drift ratchet scans the FILESYSTEM (a stray untracked file trips it) and does NOT strip comments,
  so a quoted import inside a comment reads as a real edge. The fix is never the allowlist.
- A new guarded page.tsx needs a column in the function-access matrix (lib/permissions.ts) or
  test/function-access.test.ts's reverse-completeness case fails. Attach it to an EXISTING screen key.
- A guard may pin the decision you are reversing. UPDATE its case with the new reasoning; never delete
  the case. Two tests asserting opposite things are invisible to a targeted run.
- i18n: add keys to messages/en.json AND ms, zh, ta, th, vi. Key parity is enforced by a test; a stale
  or English VALUE is NOT, so write real translations rather than copying English through.
- SOURCE-SCANNING GUARDS DO NOT STRIP COMMENTS. If you write a guard that greps a file for a forbidden
  expression, do not spell that expression out in a nearby comment — it will fail its own check.
- A form field that is always submitted cannot be read by presence, and a DISABLED control posts
  nothing. When a defect lives in the CONTRACT between two files, pin it with source-shape assertions
  across BOTH — a unit test of either half passes throughout.
- COMMIT your work on your branch when done (git commit; never amend, never rebase, never git stash —
  stashes are REPO-GLOBAL and another agent will get yours).

EVERY TEST YOU ADD MUST BE PROVED NON-VACUOUS: revert the fix (from a \`cp\` copy taken FIRST, never
\`git checkout --\`, which reverts to HEAD and has destroyed a whole round's work here), watch the
intended assertion FAIL, then restore from the copy. A guard that still passes with the fix removed is
worse than no guard. State in your report exactly which assertion you watched fail.

BUILD WHAT THE APPROVED PLAN SAYS, not what the original ticket says — where they differ, the plan is
what the customer approved and the difference is usually deliberate and explained in the plan. If you
cannot build something the plan promised, do NOT silently skip it: put it in notBuilt with the reason.
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
    nonVacuityProof: { type: 'string', description: 'which assertion you watched FAIL with the fix reverted' },
    summary: { type: 'string' },
    notBuilt: { type: 'array', items: { type: 'string' }, description: 'plan points deliberately not built, with the reason' },
    migrationsUsed: { type: 'array', items: { type: 'string' } },
    filesTouched: { type: 'array', items: { type: 'string' } },
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'verdict', 'findings'],
  properties: {
    slug: { type: 'string' },
    verdict: { type: 'string', enum: ['ship', 'fix-first'] },
    nonVacuityRederived: { type: 'boolean', description: 'true only if YOU reverted the fix and watched the assertion fail' },
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
    slug: 'rename',
    ns: 'r253rename',
    wt: `${WT}/r253-rename`,
    items: ['8041aa84'],
    brief: `Read the approved plan: ${PLANS}/8041aa84.txt. Rename the Payroll "Transactions" sub-menu to
"Transaction Entry". This is WORDING ONLY — no route, guard, calculation or workflow changes.

The parent already located every string; the plan's BUILD NOTES list them. Change these FIVE message
VALUES in all six locales (en, ms, ta, th, vi, zh):
  nav.payrollTransactions · payroll.transactions.title · payroll.historyImport.backLabel ·
  payroll.guide.linkTransactions · payroll.process.transactionsPrerequisiteNote (prose: "...on the
  Transactions screen before running" → name the new label).

SCOPE FENCES — crossing any of these breaks something:
- Do NOT rename the KEYS. labelKey 'payrollTransactions' is asserted in test/payroll-flyout-nav.test.ts
  line 55 and is the nav registry's identifier.
- Do NOT touch the two PascalCase map entries \`transactions: 'Transactions'\` in
  app/payroll/[batchId]/page.tsx line 159 and app/payroll/setup/page.tsx line 80. They are readiness-check
  KEY FRAGMENTS — line 661 composes tg(\`check\${CHECK_CAP[c.key]}Title\`). Renaming the value looks up a
  message key that does not exist and renders MISSING_MESSAGE, which passes tsc, the suite AND next build
  and only appears on screen.
- Do NOT change payroll.batch.scopeUnattachedTitle, payroll.batch.outstandingTxnLink or
  payroll.process.unattachedScopeTitle — those use "transactions" as a common noun for the DATA, and
  renaming them makes the sentences wrong. Same for payroll.batch.transactionDetail (a different export)
  and payroll.guide.phase5Title 'Transaction view' (a different screen).
- The route /payroll/transactions stays. Bookmarks must keep working.

The ms/ta/th/vi/zh values are real translations of "Transactions" today ("Transaksi", "交易", ...). Write
real translations of "Transaction Entry" — i18n-check.mjs enforces key parity and placeholders only and
CANNOT tell whether a value is the right words, so English left in place would ship silently.

Then sweep the app for any remaining user-visible "Transactions" that names THIS screen and fix it. Add a
test pinning that the five keys carry the new label in all six locales and that the two PascalCase map
entries are untouched.`,
  },
  {
    slug: 'reprocess-link',
    ns: 'r253reproc',
    wt: `${WT}/r253-reprocess-link`,
    items: ['b372e923'],
    brief: `Read the approved plan: ${PLANS}/b372e923.txt. After a payroll reprocess, give every employee
in the result table a link to their payroll result.

MEASURED BY THE PARENT: app/payroll/[batchId]/reprocess/page.tsx imports next/link ZERO times — the
result table has no links at all. The data you need is already in scope, so this is a rendering change,
not a read change:
  - each row of \`jobRows\` carries r.employmentId (used at ~line 219 to filter against
    thisJob.employmentIds), plus r.employeeCode, r.employeeName and the diff;
  - \`slips\` is already loaded on the same page (referenced ~line 262 as slips.length) and is where the
    payslip id for each employment on this run comes from.

TARGET HREF — reuse the existing shape, do not invent one:
  /payroll/individual-payslip?employmentId=<id>&payslipId=<id>
built the same way as app/payroll/pcb-detail/page.tsx line 72 and app/payroll/statutory-detail/page.tsx
line 57.

REQUIREMENTS:
1. Join jobRows to slips by employmentId to resolve payslipId. Render the cell as a Link.
2. An ADD (r.action === 'add') has a payslip too — it was created by this reprocess — so it links like
   the rest. A row with NO resolvable payslip renders plain text, never a dead link.
3. Carry the run's existing \`from\` through, so Back from the payslip returns the Payroll Process list as
   the operator left it (app/payroll/back.ts payrollProcessBack is already wired into individual-payslip).
4. New message key for the link label in all six locales.

SCOPE FENCES:
- Do NOT change the reprocess calculation, the job record, or the before/after figures. Those come from
  the stored snapshots the run wrote at the time (payroll_employee_result_history), and a results screen
  that re-derived them could disagree with the payslip it claims to describe.
- Do NOT add a second payslip screen. Link to the existing one.

TEST THAT MATTERS: pin that each jobRow's anchor carries BOTH employmentId AND payslipId FOR THAT ROW.
The reporter explicitly asked that it must not open another employee's result, and a link built from the
wrong row's ids is invisible to a test that merely counts anchors.`,
  },
  {
    slug: 'personnel-row',
    ns: 'r253prow',
    wt: `${WT}/r253-personnel-row`,
    items: ['420ebab5'],
    brief: `Read the approved plan: ${PLANS}/420ebab5.txt. Build PART ONE ONLY, plus the classification
document that de-risks part two. The plan itself says part one ships on its own first — do NOT attempt the
one-Save-per-tab consolidation in this round.

PART ONE — the clickable employee row (app/admin/personnel/page.tsx).
MEASURED: line 578 renders \`<tr className="hover:bg-muted/40">\` and the ONLY Link is at lines 587-592
wrapping e.name. So the row already LOOKS clickable and is not — that is the reported defect.
  - Make the whole row open /admin/personnel/<employmentId>?from=personnel.
  - Do NOT wrap <tr> in an anchor (invalid HTML) and do NOT put a bare onClick on the row (it kills
    keyboard access and middle-click-to-new-tab). Use the stretched-link overlay idiom, or a full-row
    Link inside each cell — whichever you choose, the row must stay keyboard reachable and the
    EmployeeCode and StatusBadge cells must not become dead zones.
  - Add cursor-pointer. The hover tint already exists and is exactly why the row currently lies.
  - Search, filters, column picker and the draft rows above the employee rows are UNCHANGED.

PART TWO PREP — the classification, delivered as a document, not code.
app/admin/personnel/[employmentId]/page.tsx is 4,740 lines carrying 35 \`<form action={...}>\` bound to 31
distinct server actions (actions.ts exports 39). Classify EVERY one of the 35 into:
  (a) FIELD EDITS on the person/employment record — these are what part two will consolidate under one
      Save per tab (e.g. setPersonAction ~line 881, setContactAddressAction ~line 1017);
  (b) CHILD-RECORD LIFECYCLE — discrete acts with their own confirmation, several money-affecting, which
      KEEP their own buttons: dependants (~1825, ~1936), qualifications (~2044, ~2115), emergency
      contacts (~848), CP38 (~1313, ~1449), encashment (~1508, ~1524), compensation revisions (~2630),
      pay items (~1169).
Write it to docs/audits/420ebab5-personnel-save-classification.md as a table: line, action, tab, bucket,
and WHY. This is the deliverable that makes part two safe — a tab-wide "Discard Changes" that appeared to
cover a recorded salary revision would be a control lying about what it does.

SCOPE FENCES:
- No changes to app/admin/personnel/[employmentId]/page.tsx in this round beyond reading it.
- No change to employee information, business rules, validation or permissions.

TEST: pin that the row exposes a single accessible link target to the right employmentId, and that the
name link still resolves to the same href (so nothing that works today stops working).`,
  },
  {
    slug: 'settings-paging',
    ns: 'r253paging',
    wt: `${WT}/r253-settings-paging`,
    items: ['9da61c86'],
    brief: `Read the approved plan: ${PLANS}/9da61c86.txt. Add the product's EXISTING paging idiom to the
master-data grids that never got it.

REUSE, DO NOT REBUILD. lib/pagination (pageState, parsePageQuery, paginateRows, PAGE_SIZE_OPTIONS,
ALL_ROW_CEILING, pageHref, showPager) with components/pager.tsx / components/page-size-select.tsx is the
established idiom, already on ~20 screens. app/admin/organization/page.tsx is the closest model: imports
line 21, pageState line 134, <Pager basePath=... params={{q,status,sort}} state={pgState}/> line 285.

TARGETS (verified 2026-09-07 — all three have search/filter, NONE has a pager):
  components/system-labels-grid.tsx    1033 lines
  components/profile-options-grid.tsx   537 lines
  components/grade-labels-grid.tsx      668 lines

THE ONE REAL CONSTRAINT: these are CLIENT components with inline spreadsheet-style editing, while
components/pager.tsx is a SERVER component (it calls getTranslations). components/client-pager.tsx exists
for exactly this case — read it first and check it fits. If it does not, EXTEND it; do not hand-roll a
fourth pager.

REQUIREMENTS:
1. Page size (the existing PAGE_SIZE_OPTIONS), first/prev/page numbers/next/last, and the
   "showing X to Y of N" line — whatever the existing Pager already renders, not a new design.
2. Remember the chosen page size for the screen.
3. Keep search, filter and page position across an add/edit round trip, so the user returns to the row
   they were working on.
4. Inline editing must keep working exactly as it does now, on the paged subset.
5. THE PLAN PROMISED A SWEEP, so do it: after the three grids, look for any other admin master-data list
   rendering every row with no pager, and apply the same idiom. Report what you found and what you
   deliberately left alone — the reporter was told "any other screen we find in the same state", and a
   silent decision not to look would be breaking that promise.

SCOPE FENCES:
- Do NOT convert these grids into read-only lists with a separate edit screen. Edit-in-place is the
  current behaviour and the reporter did not ask for it to change.
- Do NOT touch app/admin/organization (already paged) or the records themselves. No data is moved,
  renamed or removed.
- Item 15277676 ALREADY rebuilt Profile Options from a stack of one Card+table per category into the
  category-rail + single-grid layout, precisely because it forced excessive scrolling. Do not redo the
  layout; the remaining gap is paging WITHIN the selected category.

TEST: a list longer than one page renders only that page's rows and the correct total; editing a row on
page 3 returns to page 3 with the same search still applied.`,
  },
  {
    slug: 'import-template',
    ns: 'r253import',
    wt: `${WT}/r253-import-template`,
    items: ['2983802f'],
    brief: `Read the approved plan: ${PLANS}/2983802f.txt. Close the gap between the employee import
template and the employee record.

READ THIS FIRST — HALF THE TICKET IS ALREADY BUILT AND MUST NOT BE REBUILT. Multi-company import shipped
as item d8471481: lib/import-schema.ts IMPORT_COLUMNS.optional already carries 'company', matched per row
by legal name / company label / registration number, with department/position/cost-centre lookups done
against THAT company, and ImportPreview already carries a resolved \`company\` per row. The screen
(app/admin/personnel/import/employee-import.tsx) already runs Phase 'idle' → 'previewed' → 'done' with a
generated template, validate, preview and result. Do NOT build any of that again.

CURRENT COVERAGE — 6 required + 23 optional:
  required: full_name, email, department, hired_on, ic_number, basic_salary
  optional: company, employee_code, phone, position, cost_center, employment_type, monthly_allowance,
            bank_name, bank_account_no, epf_number, socso_number, tax_number, tax_category, num_children,
            eis_eligible, is_resident, epf_citizenship, pay_mode, payment_term, rate_amount

GENUINELY ABSENT, and this is the work: passport, address, emergency contact, probation, notice period,
direct superior, family.

NO MIGRATION — the parent verified every target column already exists (employment.probationEndDate,
probationMonths, probationDays, resignationNoticeMonths, terminationNoticeDays; passport and address
fields on person; person_emergency_contact; employee_dependent; reporting_line for the superior).

REQUIREMENTS, in this order:
1. FIRST, the test that pins template-versus-fields parity: derive the expected column set from the
   employee field registry and FAIL when a field is added with neither a column nor an explicit,
   named exclusion. The reporter's real ask is that the template stays in step — without this the item
   recurs every time Personnel gains a field. Build this before the columns.
2. The new columns, with validation and per-row/per-column error reporting in the existing style.
3. FAMILY IS THE STRUCTURAL ONE: employee_dependent is one-to-many, so it cannot be flat columns without
   an arbitrary cap. Put dependants on a SECOND SHEET keyed by employee_code, validated as its own row
   set, imported in the same transaction. DECIDE AND DOCUMENT what happens when the dependants sheet
   names an employee_code the employee sheet does not — reject the file, do not import half of it.
4. DIRECT SUPERIOR IS A FORWARD REFERENCE: A0002's manager may be A0005 further down the same file.
   Resolve after ALL employee rows are staged, never row by row, or a valid file fails on ordering alone.
5. Label the screen's existing phases as the numbered steps the plan describes. This is labelling, not a
   new process.

SCOPE FENCE: a file that imports successfully today must still import successfully. Every new column is
optional. Pin that with a test using the current template shape.`,
  },
  {
    slug: 'payroll-filter',
    ns: 'r253filter',
    wt: `${WT}/r253-payroll-filter`,
    items: ['d75b0c11'],
    brief: `Read the approved plan: ${PLANS}/d75b0c11.txt. THIS ITEM IS ALREADY BUILT AND WORKING — the
approved plan says so. Your job is to PROVE it stays working and to close any gap in coverage. Do NOT
"fix" the filter memory; there is nothing wrong with it.

WHAT THE PARENT MEASURED ON PRODUCTION, 2026-09-07:
  - app/payroll/page.tsx line 128 builds fromQuery = encodeURIComponent(dashboardHref(filters)) and hangs
    it on every row link (lines 353, 399, 413, 439).
  - Emitted href, verbatim: /payroll/451792d9-...?from=%2Fpayroll%3Fyear%3D2026%26m%3D1
  - app/payroll/[batchId]/page.tsx line 68 backHref = payrollListReturnTo(from). The run screen,
    /reprocess, /remove and /reset ALL rendered Back as href="/payroll?year=2026&m=1".
  - lib/return-to.ts payrollListReturnTo keeps the whole query, stripping only toast= and error=.
  - Multi-month round-trips: dashboard-logic.ts dashboardHref appends one m= per month (line 230) and
    emits m=all for the empty set; parseMonths accepts arrays and comma lists. company/cycle/status use
    the same append idiom.

⚠️ TRAP THAT WILL WASTE YOUR TIME IF YOU HAND-TEST: \`from\` must stay PERCENT-ENCODED. Passing it decoded
makes &m=1 parse as a separate parameter of the OUTER url, and Back then renders /payroll?year=2026 with
the month missing — which looks exactly like the reported fault and is NOT. The parent hit this and
nearly reported a bug that did not exist.

WORK TO DO:
1. THE TEST — this is the deliverable. Pin the contract END TO END: the list renders row links whose
   \`from\` decodes to the current dashboardHref, and [batchId], reprocess, remove and reset each render a
   Back whose href equals it. Cover a single month, MULTIPLE months, the whole-year (m=all) case, and
   company/cycle/status together. Nothing guards this today.
   Source-shape alone is NOT enough: the defect would live in the CONTRACT between app/payroll/page.tsx
   and lib/return-to.ts, and a unit test of either half passes throughout.
2. Sweep every remaining screen under app/payroll/ for a Back that ignores \`from\` and route it through
   payrollProcessBack (app/payroll/back.ts). Already covered: back-pay, individual-payslip,
   process/result, statutory-adjustment, statutory-forms, transaction-view. Report which ones you found
   and fixed, and which legitimately should not carry it.

SCOPE FENCE: opening Payroll fresh from the sidebar deliberately does NOT remember — it defaults to the
current period, which is point 3 of the reporter's own request. Do not "fix" that.

NON-VACUITY for this one is unusual and you must do it properly: the fix already exists, so prove your
test by REMOVING the \`?from=\${fromQuery}\` from a row link in a cp copy and watching your assertion fail,
then restore.`,
  },
];

const built = await parallel(
  WORK.map((w) => () =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${w.wt}
YOUR BRANCH:   r253/${w.slug}
YOUR TEST_DB_NAMESPACE: ${w.ns}   (export TEST_DB_NAMESPACE=${w.ns} in every test command)
BOARD ITEM(S): ${w.items.join(', ')}

${w.brief}`,
      { label: `build:${w.slug}`, phase: 'Build', schema: BUILD_SCHEMA },
    ),
  ),
);

const results = await parallel(
  built.map((b, i) => () => {
    const w = WORK[i];
    if (!b) return null;
    return agent(
      `ADVERSARIAL VERIFICATION of workstream "${w.slug}" on branch r253/${w.slug}, worktree ${w.wt}.

You are NOT the builder and you do not take the builder's word for anything. Put \`cd ${w.wt} &&\` in every
bash command. Your TEST_DB_NAMESPACE is ${w.ns}v — export it in every test command. Run ONLY targeted
tests, never the full suite.

Read the approved plan (${w.items.map((i2) => `${PLANS}/${i2}.txt`).join(', ')}) and the branch's diff
(\`git diff main...HEAD\`). The builder reported:

${JSON.stringify(b, null, 2)}

LOOK FOR, IN THIS ORDER:
1. A DEFECT THIS BRANCH INTRODUCED. Rank these highest and set introducedByThisBranch. Something that
   worked before and does not now is worse than something that was already imperfect.
2. A GUARD THAT CANNOT FAIL. RE-DERIVE the non-vacuity claim YOURSELF — take a \`cp\` copy, revert the
   fix, run the named assertion, confirm it actually fails, restore. Do not trust the builder's report;
   this repo has shipped vacuous guards that their authors sincerely believed they had tested. Set
   nonVacuityRederived only if you actually did this.
3. THE PLAN'S PROMISE vs WHAT SHIPPED. The plan is what the customer approved. Anything promised and not
   built, built differently, or built that the plan did not promise, is a finding.
4. SCOPE FENCES CROSSED. Each brief named things NOT to do. Check every one of them:
   rename → keys not renamed, the two PascalCase readiness map entries untouched, common-noun strings
     left alone, real translations in all six locales rather than English;
   reprocess-link → calculation and stored before/after figures untouched, no second payslip screen,
     no dead links, the href carries THAT row's ids;
   personnel-row → part two NOT attempted, the detail page not modified, row still keyboard reachable
     and middle-clickable, EmployeeCode/StatusBadge cells not dead;
   settings-paging → edit-in-place still works on the paged subset, no fourth pager hand-rolled,
     Profile Options layout not redone;
   import-template → a file that imports today still imports, every new column optional, dependants
     sheet's missing-employee case decided rather than left to chance, superior resolved after staging;
   payroll-filter → nothing "fixed" that was not broken, sidebar-fresh-entry behaviour untouched.
5. Money- or pay-affecting behaviour reachable through the UI with ordinary input.
6. A user-visible string that is wrong, untranslated, or renders MISSING_MESSAGE. Remember a 200 is not
   a render check.
7. Anything a reader of the code in six months would misread — especially a comment that is now false.

Give each finding a concrete failure path: the input or state that reaches it, with file:line. A finding
without one is a guess — say so or drop it. Verdict 'fix-first' ONLY if a blocker or a real major exists.`,
      { label: `verify:${w.slug}`, phase: 'Verify', schema: VERIFY_SCHEMA },
    ).then((v) => ({ built: b, verify: v }));
  }),
);

const done = results.filter(Boolean);
const green = done.filter((r) => r.built?.committed && r.built?.tscClean && r.built?.testsPass);
const blockers = done.flatMap((r) =>
  (r.verify?.findings ?? [])
    .filter((f) => f.severity === 'blocker' || f.severity === 'major')
    .map((f) => ({ slug: r.built.slug, ...f })),
);

log(`build: ${green.length}/${WORK.length} green · ${blockers.length} blocker/major finding(s)`);

return {
  workstreams: done.map((r) => ({
    slug: r.built.slug,
    committed: r.built.committed,
    commitSha: r.built.commitSha,
    tscClean: r.built.tscClean,
    testsPass: r.built.testsPass,
    testFiles: r.built.testFiles,
    filesTouched: r.built.filesTouched,
    migrationsUsed: r.built.migrationsUsed,
    notBuilt: r.built.notBuilt,
    nonVacuityProof: r.built.nonVacuityProof,
    verdict: r.verify?.verdict ?? 'no-verify',
    nonVacuityRederived: r.verify?.nonVacuityRederived,
    findings: r.verify?.findings ?? [],
  })),
  blockers,
};

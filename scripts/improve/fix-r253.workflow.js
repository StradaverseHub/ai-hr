export const meta = {
  name: 'r253-fix-verified',
  description: 'One fix pass over the 27 verify findings, then the parent hand-fixes whatever remains',
  phases: [{ title: 'Fix' }],
};

// AGENTS 23b: ONE fix pass, then hand-fix. A SECOND agent pass over the same code is where this repo
// goes backwards (r197-r199, r201 each made a workstream WORSE that way). So this workflow runs once,
// the parent reads what comes back, and the parent fixes the rest by hand.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r253plans';
const FIND = '/tmp/r253fix';

const COMMON = `
YOU ARE FIXING VERIFIED FINDINGS ON YOUR OWN BRANCH. Read them at the path below. They come from an
adversarial verifier that re-derived each claim itself; most are real, but not all of them will be.

THE RULE THAT MATTERS MOST: FIX THE DEFECT, NOT THE TEST. If a finding says a guard is weak, strengthen
what it proves — do not delete the case, and do not loosen an assertion so it stops failing. If you
genuinely DISAGREE with a finding, DECLINE IT and say why in \`declined\` with your evidence. Changing
code you do not believe in is how this repo has gone backwards before; a reasoned decline is a better
outcome than a bad edit.

ORDER OF WORK: blockers, then majors, then minors. If you run short, leave minors undone and SAY SO —
an unfixed minor you reported is fine; a major you quietly skipped is not.

ENVIRONMENT — same hard rules as the build pass:
- Put \`cd <your worktree> &&\` in EVERY bash command; the shell's cwd resets and the repo ROOT is a
  stale scratch tree. Prove it first: \`cd <wt> && pwd && git rev-parse --abbrev-ref HEAD\`.
- Export your TEST_DB_NAMESPACE in every test command. Run ONLY targeted tests — never the full suite;
  the parent runs the single full gate alone afterwards. \`npx vitest run <files> > /tmp/<slug>-fix.log
  2>&1\` then READ the log, exit code AND file count.
- \`npx tsc --noEmit\` clean before you commit. Commit on your branch; never amend, rebase or git stash.
- No migration. If you think you need one, stop and say so.
- i18n keys go in all six locales with REAL translations, never English copied through.
- Source-scanning guards do not strip comments: do not spell a forbidden expression out in a comment
  next to the guard that forbids it.
- A new or changed test must be NON-VACUOUS: revert the fix from a \`cp\` copy (never \`git checkout --\`),
  watch the named assertion FAIL, restore. Say which assertion you watched fail.
`;

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'committed', 'tscClean', 'testsPass', 'fixed', 'declined', 'remaining'],
  properties: {
    slug: { type: 'string' },
    committed: { type: 'boolean' },
    commitSha: { type: 'string' },
    tscClean: { type: 'boolean' },
    testsPass: { type: 'boolean' },
    fixed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding', 'what'],
        properties: {
          finding: { type: 'string', description: 'the finding number and severity' },
          what: { type: 'string', description: 'what you changed and how you proved it' },
        },
      },
    },
    declined: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding', 'why'],
        properties: { finding: { type: 'string' }, why: { type: 'string' } },
      },
    },
    remaining: { type: 'array', items: { type: 'string' }, description: 'findings left unfixed, with why' },
    nonVacuityProof: { type: 'string' },
  },
};

const WORK = [
  {
    slug: 'personnel-row',
    ns: 'r253prow',
    wt: `${WT}/r253-personnel-row`,
    items: ['420ebab5'],
    extra: `YOUR BLOCKER IS THE MOST IMPORTANT THING IN THIS WHOLE ROUND: on Safari/WebKit the stretched-link
overlay is NOT confined to its row, because WebKit does not honour \`position: relative\` on a <tr>. That
makes the employee list actively wrong in a browser we ship to — worse than the defect it fixed.

Do not paper over it with a WebKit-only hack you cannot test here. The reliable options are (a) put the
positioning context on a block-level wrapper INSIDE the cell rather than on the <tr>, or (b) drop the
overlay and make each cell's content a Link. Pick the one that keeps the row keyboard-reachable and
middle-clickable, and that does not turn the EmployeeCode and StatusBadge cells into dead zones.

ALSO: finding 3 says the reported defect SURVIVES on the draft rows at the top of the same table
(introducedByThisBranch=false). The reporter asked for the employee list's rows to be clickable and the
draft rows are rows in that list. Fix them the same way, or state plainly why they should differ.

And correct the two header comments the verifier flagged: they read as though the cross-browser question
was settled by measurement when only Chromium was measured. A comment that overstates its evidence is
exactly what AGENTS warns about.`,
  },
  {
    slug: 'settings-paging',
    ns: 'r253paging',
    wt: `${WT}/r253-settings-paging`,
    items: ['9da61c86'],
    extra: `THREE MAJORS, and two of them are regressions you introduced in screens that worked before:

1. Every keystroke in the search box now fires a client navigation. That is a performance and usability
   regression on the exact screens this item was meant to improve. Debounce it, or keep the search
   client-side and page the filtered result without navigating per character.
2. ADDING A HOLIDAY NO LONGER SHOWS THE NEW ROW. This is the worst one: a user does something and the
   product appears not to have done it. Work out what the redirect must carry so the new row is on the
   page the user lands on, and pin it with a test.
3. lib/pagination.ts's module header still says grade labels are a surface paging is "deliberately NOT
   applied to" — which your branch just contradicted. UPDATE the comment with the new reasoning; do not
   delete the paragraph (AGENTS 18: a guard or a note may pin the decision you are reversing).

Then the minors: the blank table body past the end of the list, the explicit size= written into every
holiday redirect, and Pay Items status links dropping ?size=. The finding marked
introducedByThisBranch=false about the plan's "keep your position when you come back" bullet is a PROMISE
TO THE REPORTER — if it is not met, meet it or put it in \`remaining\` with a reason.`,
  },
  {
    slug: 'import-template',
    ns: 'r253import',
    wt: `${WT}/r253-import-template`,
    items: ['2983802f'],
    extra: `YOUR MAJOR IS A CORRECTNESS BUG WITH A CLEAR FAILURE PATH: passport_issuing_country is validated
against the \`country\` catalog (country NAMES) when it should be validated against the issuing-country
catalog the rest of the product uses. A valid file would be rejected, or an invalid value accepted —
either way the importer lies about the data. Fix the catalog it checks against and pin it with a case
that would have caught it.

Then the three minors, in order: the skipped direct_superior error case, carry()'s third parameter
conflating "blank" with "the catalog rejected it" (that ambiguity is how a silently-dropped field
happens — the exact failure this whole item exists to prevent), and the six-step rail reporting step 4
before anything has been validated.

Keep the parity test you built. It is the durable half of this item and the reporter's real ask.`,
  },
  {
    slug: 'payroll-filter',
    ns: 'r253filter',
    wt: `${WT}/r253-payroll-filter`,
    items: ['d75b0c11'],
    extra: `⚠️ READ THIS FIRST — YOUR MAJOR FINDING OVERTURNS WHAT THE CUSTOMER WAS TOLD, AND IT IS RIGHT.

The approved plan told the reporter this item ALREADY WORKS. The parent verified that on production and
it is true for LINK navigation. It is NOT true after an ACTION, and the verifier found the exact path the
reporter described:

  Payroll Process → Year 2026 + Month January → View a processed run → Close payroll
  → lands on /payroll/<batchId>?toast=Payroll+closed  (no \`from\`)
  → press Back → /payroll → September 2026.

closeAction (app/payroll/actions.ts:650), generateAction (:127), unlockAction (:599) and
reprocessSelectedAction (:500) all redirect to a hardcoded path with NO \`from\`, and the forms that post
to them carry only batchId. Your sweep audited Back LINKS and never looked at ACTION REDIRECTS.

SO THE ITEM IS NOT "already works". FIX IT:
1. Carry \`from\` through those four actions — hidden input on the posting form, preserved in the redirect
   — so the destination re-renders with the selection intact. app/payroll/[batchId]/page.tsx:423 already
   does exactly this for the reset form; follow that precedent rather than inventing one.
2. reprocess/page.tsx uses sp.from for the header only (:138) and never passes it to ReprocessForm
   (:362). Pass it.
3. EXTEND YOUR TEST to the action path. Your case G currently asserts that a MISSING \`from\` resolves to
   /payroll — which documents the bug rather than catching it. The new case must fail on today's code.
4. Your other findings say the Anomalies chain and the draft-adjustment panel drop it too. Same fix.

Also fix the two you introduced: the wizard header Back label silently changed from "Back" to "Payroll"
(a user-visible string nobody approved), and case D's title claims render coverage it does not have.

Tell the parent clearly in \`fixed\` what now works that did not, because the customer has to be told
their complaint was real after we said it was not.`,
  },
  {
    slug: 'reprocess-link',
    ns: 'r253reproc',
    wt: `${WT}/r253-reprocess-link`,
    items: ['b372e923'],
    extra: `YOUR MAJOR IS A BROKEN PROMISE TO THE CUSTOMER: the approved plan's work item 3 says "Carry the
run's existing \`from\` through so Back from the payslip returns the list as left" — and it never reaches
the link. Build it.

Your second finding matters more than its "minor" label suggests: the link opens a DIFFERENT payroll
result screen from the one the normal Payroll Process run screen links to. The reporter's own words were
"the same screen, layout, information and calculation result as the normal Payroll Process result" and
"there should not be a separate or different payroll-result interface for Reprocess". Make it the same
destination the run screen uses, or explain in \`declined\` why the run screen's own destination is not
what they meant.

Then relax the three over-tight source-substring guards so they pin BEHAVIOUR rather than exact
formatting — without weakening what they actually prove.`,
  },
  {
    slug: 'rename',
    ns: 'r253rename',
    wt: `${WT}/r253-rename`,
    items: ['8041aa84'],
    extra: `The verifier said SHIP. Three minors only, and one is a genuine language bug worth fixing:

1. The Vietnamese "Nhập giao dịch" reuses the verb this catalog uses for IMPORT, so on
   /payroll/transactions/fixed the Back link now reads the same as the Excel-import action on the same
   screen. Pick a Vietnamese rendering that cannot be read as "Import transactions".
2. Update the stale code comments that still spell "Payroll → Transactions → Zakat" while the message
   three lines away now says "Transaction Entry" — a reader cannot tell which is stale. Comments naming
   the ROUTE (/payroll/transactions) are still true; leave those.
3. You changed two keys outside the plan's five (people.detail.zakatSummaryDescription and
   people.detail.zakatMoved). That edit is CORRECT — they spell the menu path — so keep it. Just make
   sure it is stated plainly in your report so the parent can tell the reporter what shipped beyond the
   plan.`,
  },
];

const fixes = await parallel(
  WORK.map((w) => () =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${w.wt}
YOUR BRANCH:   r253/${w.slug}
YOUR TEST_DB_NAMESPACE: ${w.ns}   (export it in every test command)
APPROVED PLAN: ${w.items.map((i) => `${PLANS}/${i}.txt`).join(', ')}
YOUR FINDINGS: ${FIND}/${w.slug}.txt   ← read this first

${w.extra}`,
      { label: `fix:${w.slug}`, phase: 'Fix', schema: FIX_SCHEMA },
    ),
  ),
);

const done = fixes.filter(Boolean);
log(`fix: ${done.filter((f) => f.committed && f.tscClean && f.testsPass).length}/${WORK.length} green`);

return {
  workstreams: done.map((f) => ({
    slug: f.slug,
    committed: f.committed,
    commitSha: f.commitSha,
    tscClean: f.tscClean,
    testsPass: f.testsPass,
    fixedCount: (f.fixed ?? []).length,
    fixed: f.fixed,
    declined: f.declined,
    remaining: f.remaining,
    nonVacuityProof: f.nonVacuityProof,
  })),
};

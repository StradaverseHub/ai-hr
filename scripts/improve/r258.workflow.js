export const meta = {
  name: 'r258-build-verify',
  description: 'Leave Configuration Round 2 (new leave type screen) and the draft employee record on tabs',
  phases: [{ title: 'Build' }, { title: 'Verify' }],
};

// AGENTS 35 (added last round, after this exact mistake): the verify stage closes over the parent's own
// WORK entry — `(build, w) =>` — and NEVER re-derives a path or an item id from the builder's echoed
// `slug`. Last round that handed all three verifiers the wrong item's plan and a directory that does not
// exist, while the workflow reported 6/6 complete and 0 errors.
//
// WHY 9583deac IS NOT HERE. It is approved and ready, but its stage one reuses the SAME personnel section
// components that 759dfc7d is re-binding this round, and its own approved build notes say not to make a
// third branch edit them. It is the next round's first item, not this one's third.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r258plans';

const COMMON = `
ENVIRONMENT — read this before your first command.

- Put "cd <your worktree> &&" in EVERY bash command, including read-only greps. The shell's cwd resets
  between calls and the repo ROOT is a STALE scratch tree far behind main. A grep in the wrong tree
  silently answers about code from weeks ago; this has landed five times. Prove your tree first:
  cd <wt> && pwd && git rev-parse --abbrev-ref HEAD
- Export your TEST_DB_NAMESPACE in every test command. TARGETED TESTS ONLY, never the full suite —
  the parent runs the single full gate alone, and a second vitest wipes the first's worker DBs.
  npx vitest run <files> > /tmp/<slug>.log 2>&1   then READ the log: exit code AND file count.
  Never pipe a long command; redirect.
- ⚠️ THE LOCAL CLUSTER IS ON DISK. If you rebuild it: AIHR_RAMDISK_GB=0 ./scripts/dev-db-rebuild.sh —
  the 8GB RAM disk IS memory on this 18GB machine and OOM-killed three gates.
- npx tsc --noEmit clean before you commit. Commit on YOUR branch. Never amend, rebase, or git stash —
  stashes are REPO-GLOBAL and one agent has already popped another's into its tree.
- i18n: EVERY new key in ALL SIX locales with REAL translations, never English copied through.
- ⚠️ A 200 IS NOT A RENDER CHECK. MISSING_MESSAGE and RSC boundary bugs pass tsc, the suite and
  next build and still return 200. If you add or change a screen you MUST run a dev server, load the
  page, and READ THE DEV LOG. Say in "renderChecked" which URL you loaded and what the log said.
- Any test you add or change must be NON-VACUOUS, and the bar was raised last round because a verifier
  caught proofs that perturbed the TEST HARNESS rather than shipped code: revert the SHIPPED behaviour
  from a "cp" copy (NEVER "git checkout --", which reverts to HEAD and has destroyed a release's
  uncommitted work), watch the named assertion FAIL, restore. Say which assertion failed and which
  SHIPPED line you broke to make it fail.
- Dates: never the argless new Date().toISOString().slice(0, 10). That is a UTC date and this product
  runs at UTC+8, so it names YESTERDAY between 00:00 and 08:00 MYT. Use todayInKualaLumpur()
  from lib/hr-date.
  A tree-wide guard turned the gate red on exactly this last round.

REPORT WHAT YOU DID NOT DO. A plan is a promise to the reporter and a brief is an instruction to you;
nothing checks that the second contains the first. Anything you skip goes in "notBuilt" in plain words.
An unfinished item you REPORTED is acceptable; one you quietly dropped is not.
`;

const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'committed', 'tscClean', 'testsPass', 'built', 'notBuilt', 'risks'],
  properties: {
    slug: { type: 'string' },
    committed: { type: 'boolean' },
    commitSha: { type: 'string' },
    tscClean: { type: 'boolean' },
    testsPass: { type: 'boolean' },
    renderChecked: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    built: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'evidence'],
        properties: { what: { type: 'string' }, evidence: { type: 'string' } },
      },
    },
    notBuilt: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'why'],
        properties: { what: { type: 'string' }, why: { type: 'string' } },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    nonVacuityProof: { type: 'string' },
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'findings', 'verdict'],
  properties: {
    slug: { type: 'string' },
    verdict: { type: 'string', enum: ['ship', 'fix-first', 'reject'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'claim', 'evidence', 'introducedByThisBranch'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          introducedByThisBranch: { type: 'boolean' },
          file: { type: 'string' },
        },
      },
    },
    nonVacuityRederived: { type: 'string' },
  },
};

const WORK = [
  {
    slug: 'leave-types',
    ns: 'r258leave',
    item: 'a6fe37fc',
    brief: `YOU ARE BUILDING ROUND 2 ONLY of the Leave Configuration replacement. READ
docs/design/a6fe37fc-migration-order.md "Round 2" IN FULL FIRST, and docs/design/a6fe37fc-leave-config-ia.md
sections 1.2, 2, 2.1, 2.2 and 3.1. The approved plan is at ${PLANS}/a6fe37fc.txt. Round 1 (the approval
replay harness) is already built and deployed — do not touch core/leave-approval-policy.ts,
core/leave-approval-consolidation.ts or scripts/replay-approval-routing.ts.

⚠️ THIS ROUND ADDS AND REMOVES NOTHING. Build the new screen ALONGSIDE the old one. The plan promised the
reporter "something that works at every point". Specifically:
  · /admin/leave/entitlements and components/leave-type-panel.tsx are UNTOUCHED and remain what the menu
    links to. Do not edit, delete or redirect them. That is Round 5.
  · NO MIGRATION. No table is created, altered or dropped. If you conclude you need a column, STOP and
    say so in notBuilt rather than inventing a number.
  · The engine is never touched: core/leave.ts, core/leave-compute.ts, core/entitlement-template.ts.

WHAT TO BUILD: app/admin/leave-config/types/page.tsx and the components under it — a NEW page component,
NOT an edit of components/leave-type-panel.tsx. The old screen's four steps and six sub-steps become FIVE
TABS, and the 24 sub-forms are rewritten onto them. The left rail that picks a leave type is RE-CREATED,
not dropped — it is the only way to choose one.

THE THREE RULES THE REWRITE OBEYS, because a rewritten form is exactly where this goes wrong:

1. ⚠️ EVERY SUB-FORM KEEPS ITS TRI-STATE MARKER AND ITS HIDDEN name. A form that posts updateTypeAction
   WITHOUT its marker does not fail to save — it saves, and WIPES THE COLUMNS A NEIGHBOURING FORM OWNS.
   Nothing type-checks this and no test will catch it for you. IA §1.2's marker list is the checklist;
   walk it form by form and say in your report that you did.
2. NO SERVER ACTION CHANGES SIGNATURE AND NO NEW ACTION IS WRITTEN. The new forms post the EXISTING
   actions. If a field needs an action that does not exist, the round stops and says so in notBuilt.
3. Two settings move in because they are properties of the leave type: send_to_payroll (today on Payroll
   impact) into TAB 1, and per_date_approval (today in General setting) into TAB 5. NEITHER OLD SCREEN
   LOSES ITS COPY THIS ROUND — a setting editable in two places for one round is deliberate and is
   resolved at Round 5.

⚠️ THE STORAGE-KEY TRIPWIRE DOES NOT EXIST AND THIS ROUND MUST WRITE IT, BEFORE NAMING A SINGLE TAB.
The new tab keys must NOT be 'approval', 'display' or 'calculation' — those are retired accordion keys
from the pre-c979aa8b panel, and reusing one makes an administrator's stored leaveTypeCards:<id> payload
hydrate onto the WRONG tab. test/leave-type-config-categories.test.ts asserted exactly that and was
DELETED in c9e18c7e; of the 29 test files that read leave-type-panel.tsx, NONE asserts those three
strings absent. So nothing will catch a wrong key — tsc, targeted tests and the full gate all pass.
Add the assertion against your own new file as a case in the new screen's shape test FIRST.
Proposed keys, from the design: identity · eligibility · entitlement · application · approvers.
Also add the hydration guard that remaps every RETIRED key (general, ess, entitlement, custom,
eligibility, workflow) onto its new tab, rather than snapping an administrator back to tab 1.

GUARDS THAT PIN THE OLD ARRANGEMENT MUST STAY GREEN AND MUST NOT BE EDITED — they read
leave-type-panel.tsx, which you do not touch: leave-type-general-substeps, leave-condition-substeps,
leave-type-config-active-section, leave-type-workspace, leave-type-partial-approval-toggle. They come due
in Round 5. If one of them goes red you have touched something you should not have.

RENDER CHECK IS MANDATORY AND IS CALLED OUT IN THE DESIGN: r127 shipped this very screen with two label
sets that did not exist. Every new tab label in all six locales with real translations, then run a dev
server, load /admin/leave-config/types, and READ THE DEV LOG for MISSING_MESSAGE. Report the URL and what
the log said in "renderChecked".

SCOPE FENCE: app/admin/leave-config/** (new), and your new tests. You may READ leave-type-panel.tsx and
the existing actions. Do NOT touch app/admin/personnel/** or app/me/** — another agent is in personnel.
If this is too large to finish, build the tabs in the design's order and report the rest in notBuilt —
a stated shortfall is fine, a silent one is not.`,
  },
  {
    slug: 'draft-tabs',
    ns: 'r258draft',
    item: '759dfc7d',
    brief: `YOUR APPROVED PLAN IS AT ${PLANS}/759dfc7d.txt AND ITS FIRST SECTION TELLS THE REPORTER THE
HARDEST PART IS ALREADY DONE. Read it before you write code, and do not rebuild what is there.

ALREADY BUILT AND DEPLOYED — MEASURED, DO NOT REDO:
  · lib/employee-draft-schema.ts:195 DRAFT_STEPS = ['profile','employment','statutory','payroll','family'].
  · app/admin/personnel/new/family-step.tsx (23KB) is the Family step.
  · core/employee-draft.ts:586-594 validates the family BEFORE anything is created (activation is ONE
    transaction, so every refusal the dependent writer can make must be provoked there), and
    materialiseDependents (core/dependents.ts) writes the real rows at Activate, sharing ONE column
    mapping with addDependent.
  · Pinned by test/employee-draft-family.test.ts and test/draft-family-step.dom.test.tsx.
  · ⚠️ STEP_NUMBERS: 5 IS RETIRED and family is 6, because drafts abandoned on the old Review step sit in
    production RIGHT NOW as current_step = 5. Never renumber positionally.

WHAT IS LEFT IS THE LAYOUT: move the draft off the five-step wizard onto the SAME TABS an active employee
uses. The plan promises the reporter: same section names, same fields, same dropdowns, same validation;
tabs Profile, Employment, Bank and Statutory, Payroll and Family; a "Draft — pending activation" label on
the record rather than a different kind of screen; save at any point without filling everything in;
nothing validated until Activate; the screen still says what is outstanding; and Activate keeps
everything already entered.

ROUTE A, AND ROUTE B STAYS REJECTED. Keep the draft as ONE jsonb blob (employee_draft.data) and give the
shared tab sections a SECOND BINDING so each section can read/write either the real tables or the draft
blob. Do NOT make a draft create real person/employment rows in a 'draft' state — that inverts the
invariant the whole feature rests on (a draft creates no person and no employment, and is absent from
headcount, payroll, leave and every report), and every consumer including RLS would have to learn to
exclude it.

⚠️ THE SHARED SECTIONS WERE CONSOLIDATED LAST ROUND AND YOU ARE BINDING INTO THAT WORK, NOT AROUND IT.
420ebab5 shipped one Save per tab through a shared runTabSave: lib/personnel-tab-sections.ts declares the
section order per tab, app/admin/personnel/[employmentId]/actions.ts has save<Tab>TabAction, the page
marks each card data-save-section="<id>", lib/tab-save-dom.ts packs the dirty ones into one payload and
diffs old→new, lib/unsaved-changes.ts joins the two client islands, components/tab-save-scope.tsx owns
the dirty state and the Save/Discard/Cancel dialog. READ THOSE FILES BEFORE DESIGNING ANYTHING. A draft
tab should reuse that machinery, not grow a parallel one.

DO NOT LOSE ON THE WAY, all pinned today: company and reserved employee code are read-only via
saveEmployeeDraft; save-WITHOUT-validation must survive the move to tabs; discard must still release the
reserved code back to its issuing config, or to the tenant counter when reservedConfigId is null;
missingByStep becomes missingByTab and stays THE ONE rule the server re-runs before activating.

THE FOUR TABS A DRAFT DOES NOT GET are Career Movement, Attendance, Leave and Documents — they describe
things that have happened to an employee and a draft has no employment for them to have happened to.
QUALIFICATION AND OTHERS: the plan puts them after activation too and invites the reporter to reject if
they want Qualification earlier. Follow the plan — after activation — and do not quietly include them.

TEST THE THING THIS ITEM IS ABOUT: everything entered on a draft survives Activate, asserted FIELD BY
FIELD, not by spot check. A silently dropped field is the failure mode this whole request exists about.

RENDER CHECK MANDATORY: load the new-employee screen on a dev server and read the dev log.

SCOPE FENCE: app/admin/personnel/new/**, lib/employee-draft-schema.ts, core/employee-draft.ts, and the
shared personnel section components you must re-bind. Do NOT touch app/me/** (that is 9583deac, next
round), app/admin/personnel/import/**, or core/leave-*. No new migration — the draft is a jsonb blob and
that is the point.`,
  },
];

const results = await pipeline(
  WORK,
  (w) =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${WT}/r258-${w.slug}
YOUR BRANCH:   r258/${w.slug}
YOUR TEST_DB_NAMESPACE: ${w.ns}
BOARD ITEM:    ${w.item}
APPROVED PLAN: ${PLANS}/${w.item}.txt   <- read it before you write code (AGENTS 29)

${w.brief}`,
      { label: `build:${w.slug}`, phase: 'Build', schema: BUILD_SCHEMA },
    ),
  (build, w) =>
    agent(
      `ADVERSARIALLY VERIFY the branch r258/${w.slug} in ${WT}/r258-${w.slug}.

A GREEN BUILD IS NOT EVIDENCE THE WORK IS RIGHT. Every workstream last round reported tsc-clean and
test-green and every one came back fix-first, two with blockers — including a cutover harness that
printed its success tick while a live employee's approver had moved. You are the load-bearing step.

THE BUILDER'S OWN REPORT (a claim to be checked, never a fact):
${JSON.stringify({ built: build.built, notBuilt: build.notBuilt, risks: build.risks, renderChecked: build.renderChecked, nonVacuityProof: build.nonVacuityProof, filesTouched: build.filesTouched }, null, 1)}

APPROVED PLAN: ${PLANS}/${w.item}.txt
${w.item === 'a6fe37fc' ? 'DESIGN: docs/design/a6fe37fc-migration-order.md "Round 2" and docs/design/a6fe37fc-leave-config-ia.md §1.2, §2.' : ''}

DO THESE, IN THIS ORDER:
1. RE-DERIVE THE NON-VACUITY CLAIM YOURSELF. Do not trust nonVacuityProof — last round a builder's proof
   perturbed the TEST HARNESS rather than shipped code and so proved nothing. Take a "cp" copy, revert
   the SHIPPED behaviour by hand, run the named test, WATCH IT FAIL, restore from your copy. NEVER
   "git checkout --". Report what you observed in nonVacuityRederived.
2. READ THE APPROVED PLAN AND THE DIFF SIDE BY SIDE. Anything promised the reporter that the diff does
   not deliver is a finding, even if the builder listed it in notBuilt.
${w.item === 'a6fe37fc'
  ? `3. ⚠️ WALK THE TRI-STATE MARKERS FORM BY FORM. A rewritten sub-form that posts updateTypeAction without
   its hidden marker SAVES and WIPES the columns a neighbouring form owns. Nothing type-checks it and no
   existing test catches it. Compare every new form against IA §1.2's marker list and against the old
   form in components/leave-type-panel.tsx. This is the single most likely way this round destroys data.
4. Check the storage-key tripwire actually exists and can FAIL, and that no new tab key is 'approval',
   'display' or 'calculation'. Check the old screen still works and none of the five old guards was edited.`
  : `3. ⚠️ CHECK THAT EVERYTHING ENTERED ON A DRAFT SURVIVES ACTIVATE, FIELD BY FIELD. A silently dropped
   field is the failure mode this whole item exists about, and a spot-check test will not find it.
   Verify the family materialisation still works and that STEP_NUMBERS did not get renumbered.
4. Check save-without-validation still works, the reserved employee code is still released on discard,
   and the draft still creates no person and no employment before Activate.`}
5. VERIFY THE RENDER CHECK HAPPENED AND WAS REAL. Run the dev server yourself, load the page, read the
   log. A 200 is not a render check and MISSING_MESSAGE returns 200.
6. Run the branch's targeted tests yourself with TEST_DB_NAMESPACE=${w.ns}v. Targeted only.

Put "cd <worktree> &&" in every command. Judge severity by consequence: a blocker is wrong money, lost
data, or a promise to the reporter silently unmet. Say "ship" only if you would put your own name on it.`,
      { label: `verify:${w.slug}`, phase: 'Verify', schema: VERIFY_SCHEMA },
    ).then((v) => ({ ...build, slug: w.slug, item: w.item, verify: v })),
);

const done = results.filter(Boolean);
log(`r258: ${done.filter((r) => r.committed && r.tscClean).length}/${WORK.length} committed clean`);
for (const r of done) {
  const f = r.verify?.findings ?? [];
  log(`  ${r.slug}: ${r.verify?.verdict} — ${f.filter((x) => x.severity === 'blocker').length} blocker, ${f.filter((x) => x.severity === 'major').length} major, ${f.filter((x) => x.severity === 'minor').length} minor`);
}

return {
  workstreams: done.map((r) => ({
    slug: r.slug,
    item: r.item,
    committed: r.committed,
    commitSha: r.commitSha,
    tscClean: r.tscClean,
    testsPass: r.testsPass,
    renderChecked: r.renderChecked,
    filesTouched: r.filesTouched,
    built: r.built,
    notBuilt: r.notBuilt,
    risks: r.risks,
    verdict: r.verify?.verdict,
    findings: r.verify?.findings,
    nonVacuityRederived: r.verify?.nonVacuityRederived,
  })),
};

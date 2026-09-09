export const meta = {
  name: 'r256-fix-verified',
  description: 'One fix pass over the four fix-first workstreams',
  phases: [{ title: 'Fix' }],
};

// AGENTS 23b: ONE fix pass, then the parent hand-fixes whatever remains. The four 'ship' workstreams
// (name-link, reprocess-status, txn-prompt, personnel-tabs) are NOT here — their findings are minors the
// parent will read and decide on rather than send an agent at.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r256plans';
const FIND = '/tmp/r256fix';

const COMMON = `
YOU ARE FIXING VERIFIED FINDINGS ON YOUR OWN BRANCH. Read them at the path below. They come from an
adversarial verifier that re-derived each claim itself — several were PROVEN with throwaway probes.

FIX THE DEFECT, NOT THE TEST. Never delete a case or loosen an assertion so it stops failing. If you
genuinely DISAGREE, DECLINE it in "declined" with your evidence — a reasoned decline beats an edit you do
not believe in.

ORDER: blockers, then majors, then minors. Running short is fine if you SAY SO.

ENVIRONMENT:
- Put "cd <your worktree> &&" in EVERY bash command; the shell's cwd resets and the repo ROOT is stale.
- Export your TEST_DB_NAMESPACE in every test command. Targeted tests ONLY, never the full suite.
- THE LOCAL CLUSTER IS ON DISK. If you rebuild: AIHR_RAMDISK_GB=0 ./scripts/dev-db-rebuild.sh
- npx tsc --noEmit clean before committing. Commit on your branch; never amend, rebase or git stash.
- i18n keys in all six locales with REAL translations.
- Any test you add or change must be NON-VACUOUS: revert from a cp copy (never git checkout --), watch
  the named assertion FAIL, restore. Say which assertion you watched fail.
`;

const FIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['slug','committed','tscClean','testsPass','fixed','declined','remaining'],
  properties: {
    slug:{type:'string'}, committed:{type:'boolean'}, commitSha:{type:'string'},
    tscClean:{type:'boolean'}, testsPass:{type:'boolean'},
    fixed:{type:'array',items:{type:'object',additionalProperties:false,required:['finding','what'],
      properties:{finding:{type:'string'},what:{type:'string'}}}},
    declined:{type:'array',items:{type:'object',additionalProperties:false,required:['finding','why'],
      properties:{finding:{type:'string'},why:{type:'string'}}}},
    remaining:{type:'array',items:{type:'string'}}, nonVacuityProof:{type:'string'},
  },
};

const WORK = [
  { slug:'shift', ns:'r256shift', items:['6340aecb'], extra:
`YOUR BLOCKER IS A RED GUARD YOU LEFT BEHIND: test/attendance-screens-layout.test.ts fails because
shift-form.tsx is still listed as something it no longer is after your redesign. That is AGENTS 18 —
the guard pins a decision this branch reverses. UPDATE its case with the new reasoning and move the
entry; do NOT delete the case, and do NOT revert the redesign to make it pass. A full gate would have
caught this; a targeted run did not, which is exactly why the case matters.

THEN the minors. Note the verifier's own premise refinement: BreakPeriod JSONB has carried a PER-WINDOW
'flexible' flag since f3321963, so shift-level flexible is not wholly new — make sure the two cannot
disagree, and say in your report which one wins when both are set.

⚠️ UNCHANGED AND NON-NEGOTIABLE: flexible break defaults OFF on every existing row and a shift without it
must compute BYTE-IDENTICALLY to before. Break handling feeds worked minutes, which feeds overtime. Keep
that golden test green; if your blocker fix touches it, re-prove it.` },

  { slug:'labels', ns:'r256lbl', items:['f1bbc572'], extra:
`YOUR MAJOR WAS PROVEN WITH A PROBE, NOT REASONED, AND IT HAS TWO SEPARATE HALVES. Fix both.

(a) A company-scoped hr_admin can now SEE and EDIT a Global label whose ORIGIN company they do not
    administer. RLS refuses the UPDATE (0016_company_scoped_authz.sql:101-103, app.is_admin_for is false
    for that company), so the whole ATOMIC save rolls back — every other row they edited in that Save is
    lost with it. Your fix made the rows visible; it did not make them editable. Decide and implement the
    honest behaviour: render those rows READ-ONLY for an admin who cannot write them (the grid renders
    ordinary editable inputs today, components/system-labels-grid.tsx:874-885), and make Duplicate not
    offer a copy that will be refused (it copies src.companyId at :306).

(b) THE ERROR HANDLING LEAKS SQL TO THE SCREEN, and this is worth fixing even though the verifier ranked
    it inside the same finding. core/admin.ts:2631-2634 isPrivilegeError reads e.code, but drizzle puts
    42501 on e.cause — so the outer code is undefined, the catch at :2773-2778 falls through to
    'else throw e', and app/admin/settings/actions.ts:288 passes the raw message to the banner. The
    captured text was 'Failed query: update "department" set ... params: RenamedByB,,edited by B,b22d7f28…'
    — untranslated SQL and parameter values in an admin-facing banner. Read the code from .cause as well
    as .code, and return a translated refusal.

THEN the minor: your in-memory rule is NOT gated on company.shared_system_labels while the server
resolver still is, so on a company with the sharing opt-out off a label is visible in maintenance and
refused by every picker — the exact 'visible in the list, unavailable in the picker' state the plan told
you was WORSE than today. Align them, or state plainly why you cannot.` },

  { slug:'header', ns:'r256hdr', items:['fbf6abd0'], extra:
`YOUR MAJOR IS THAT THE FEATURE DOES NOT DELIVER ITS ONE PROMISE: at 1280 and 1440 CSS px — laptop
screens, i.e. most of your users — the signed-in person's name and Employee ID do not render. An
identification feature that disappears on the common screen size has not been built.

Fix the layout so the identity is visible at 1280 and 1440, and PIN IT: this repo already has
topbar-overlap-guard-style tests that measure at specific widths. Add the widths that failed to whatever
guards the top bar, so a future round cannot silently squeeze it out again. If something else in the
cluster has to give way to make room, say which and why — do not just shrink the name to nothing.

THEN the four minors.

⚠️ KEEP the four-state fallback you found by rendering (employed+code / employed+no code / named but not
employed / no person at all). That was the correction your own render check produced and it is right —
the seeded HR Admin is a named human with no employment, and labelling them 'Platform account' was the
bug. Do not regress it while fixing the layout.
⚠️ AND RENDER IT AGAIN AFTER FIXING. This is the app shell; a 200 is not a render check, and the layout
is precisely what a static test misses.` },

  { slug:'statutory', ns:'r256stat', items:['858a1128'], extra:
`YOUR MAJOR IS A WRONG DEFAULT WITH A SEASONAL FAILURE WINDOW: the criteria step defaults to a period
that has not happened yet in January, and to the wrong tax year for the whole Jan–Mar annual-filing
season — which is exactly when the EA and the annual forms are actually filed.

The repo already has the right idiom and a comment explaining it: app/payroll/statutory-forms/page.tsx
had 'Default to the month just ENDED — the one whose submission is actually open' (~:229), and
app/payroll/dashboard-logic.ts documents why the tenant clock is used rather than new Date() (between
00:00 and 08:00 MYT the UTC date is still the previous day). Use the tenant clock, default the monthly
forms to the month just ended, and default the ANNUAL forms (C.P.8A / EA) to the year being filed FOR,
not the calendar year the browser is in.

Pin both with tests that pretend it is 5 January and 5 March — the two dates where the naive default is
wrong — and prove non-vacuity by reverting to the naive default and watching them fail.

THEN the three minors. Keep the CP22/CP22A worklist card you deliberately left with its own company +
year + month form; the verifier noted it and it is a reasonable exception — just make sure the round
report says so.` },
];

const fixes = await parallel(WORK.map((w) => () =>
  agent(`${COMMON}

YOUR WORKTREE: ${WT}/r256-${w.slug}
YOUR BRANCH:   r256/${w.slug}
YOUR TEST_DB_NAMESPACE: ${w.ns}
APPROVED PLAN: ${w.items.map((i) => `${PLANS}/${i}.txt`).join(', ')}
YOUR FINDINGS: ${FIND}/${w.slug}.txt   <- read this first

${w.extra}`, { label: `fix:${w.slug}`, phase: 'Fix', schema: FIX_SCHEMA })));

const done = fixes.filter(Boolean);
log(`fix: ${done.filter((f) => f.committed && f.tscClean && f.testsPass).length}/${WORK.length} green`);
return { workstreams: done.map((f) => ({
  slug: f.slug, committed: f.committed, commitSha: f.commitSha, tscClean: f.tscClean,
  testsPass: f.testsPass, fixed: f.fixed, declined: f.declined, remaining: f.remaining,
  nonVacuityProof: f.nonVacuityProof })) };

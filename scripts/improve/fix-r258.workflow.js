export const meta = {
  name: 'r258-fix-verified',
  description: 'One fix pass over the r258 verify findings; the parent hand-checks after',
  phases: [{ title: 'Fix' }],
};

// AGENTS 23b: ONE fix pass, then hand-fix. The blocker (leave pack import ratchet) was already
// hand-fixed by the parent in b28d2ab0 — structurally, in ALWAYS_ALLOWED, never in the audited
// debt allowlist.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r258plans';
const FIND = '/tmp/r258fix';

const COMMON = `
YOU ARE FIXING VERIFIED FINDINGS ON YOUR OWN BRANCH. Read them at the path below. They come from an
adversarial verifier that re-derived each claim itself. Most are real; not all will be.

FIX THE DEFECT, NOT THE TEST. If a finding says a guard is weak, strengthen what it proves — never delete
a case or loosen an assertion so it stops failing. If you genuinely DISAGREE, DECLINE it and say why in
"declined" with your evidence. A reasoned decline beats an edit you do not believe in.

ORDER: majors, then minors. Running short is fine if you SAY SO.

ENVIRONMENT:
- Put "cd <your worktree> &&" in EVERY bash command; the shell's cwd resets and the repo ROOT is a stale
  scratch tree. Prove it first: cd <wt> && pwd && git rev-parse --abbrev-ref HEAD
- Export your TEST_DB_NAMESPACE in every test command. Targeted tests ONLY, never the full suite.
  Redirect to a log and READ it: exit code AND file count. Never pipe.
- ⚠️ RUN EVERY DIRECTORY-WALKING GUARD THAT COULD SEE YOUR NEW FILES, and name which ones you ran. The
  build pass claimed "every directory-walking guard" was green while test/leave-pack-drift.test.ts was
  RED and had never been run. A guard you did not run is not a guard you passed.
- ⚠️ THE LOCAL CLUSTER IS ON DISK: AIHR_RAMDISK_GB=0 ./scripts/dev-db-rebuild.sh if you must rebuild.
- npx tsc --noEmit clean before committing. Commit on your branch; never amend, rebase or git stash.
- No new migration. i18n keys in all six locales with REAL translations.
- Any test you add or change must be NON-VACUOUS: revert the SHIPPED behaviour from a cp copy (never
  "git checkout --"), watch the named assertion FAIL, restore. Say which shipped line you broke.
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
    guardsRun: { type: 'array', items: { type: 'string' } },
    fixed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding', 'what'],
        properties: { finding: { type: 'string' }, what: { type: 'string' } },
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
    remaining: { type: 'array', items: { type: 'string' } },
    reporterOwed: { type: 'array', items: { type: 'string' } },
    nonVacuityProof: { type: 'string' },
  },
};

const WORK = [
  {
    slug: 'leave-types',
    ns: 'r258leavef',
    item: 'a6fe37fc',
    extra: `⚠️ YOUR MAJOR IS THAT TWO LIVE SURFACES ARE MISSING FROM THE NEW SCREEN AND RECORDED NOWHERE —
not in IA §3.1's function table, not in your anti-drop guard, not in notBuilt. The board plan promises
the reporter "every current function accounted for", so an unrecorded omission breaks that promise even
though nothing is lost while the old screen is live.

The two are on app/admin/leave/entitlements/page.tsx today:
  (a) line ~420, the Link to /leave/employee-balances — the r242 fix (3a3f5a2d), whose own comment says
      "THE WAY IN THE REPORTER WENT LOOKING FOR ... an HR admin who wants to look one person's balances
      up came here, to Leave Config, and found nothing pointing at it". Removing it silently at Round 5
      would re-create the exact complaint r242 answered.
  (b) lines ~449-468, the negativeBalanceNeedsLimit Card — the r126 surface (ab876f73) commented as
      "THE LIST THE PLAN PROMISED", naming every leave type set to allow a negative balance with no
      maximum.
Also dropped without mention: data-tour="leave-config" and the in-page <LeaveConfigMap current=…>, which
leaves the new screen with no navigation to its sibling leave-config screens.

DO BOTH OF THESE:
  1. CARRY (a) AND (b) ONTO THE NEW SCREEN. They are page-level surfaces of the screen you are replacing;
     both are read-only reads, so neither needs an action or a marker. Put the LeaveConfigMap and the
     tour anchor on too, or say in "remaining" precisely why a sibling-navigation element should wait for
     Round 3/5 — do not just drop them.
  2. ⚠️ CORRECT THE DESIGN DOCUMENT. IA §3.1's 32-function table for this screen is STALE — both
     surfaces landed BEFORE the design's baseline (main@0c01befc) and the table never listed them, which
     is why your anti-drop guard could not see them: it is keyed to that table. Add them to §3.1 with a
     note saying they were missing, and extend the anti-drop guard to cover them. A wrong document
     outlives a wrong line of code, and Rounds 3-5 are all keyed to this table.

THEN THE MINORS:
- ⚠️ THE MARKER GUARD STOPS ONE LEVEL ABOVE THE DEFECT IT EXISTS TO CATCH. It pins that each form posts
  its marker, its id and its hidden name — but NOT that the form still posts the FIELDS that marker's
  action branch reads. A field lost from a marker-carrying form SAVES AND WIPES ITS OWN COLUMN, and the
  suite stays green. That is the precise failure this whole round was briefed to avoid, so strengthen the
  guard: for each marker, assert the fields its branch in updateLeaveTypeAction actually reads are
  present in the form that carries it. Prove it non-vacuously by deleting one real field and watching it
  fail.
- The identity form is always in edit mode: the old panel's Rename toggle and its "Discard changes"
  button are gone. It is in a code comment but absent from your report and from notBuilt. Either restore
  the toggle or put it in "remaining" AND in "reporterOwed" in plain words — an always-editable name
  field on a screen that used to require an explicit Rename is a behaviour change the reporter will see.
- F31 on Tab 1 rather than Tab 3: your reason holds (one form, two markers, splitting it would create two
  writers over one save). Record it in IA §3.1 as a deliberate deviation so the table and the code agree.

DO NOT: touch components/leave-type-panel.tsx, app/admin/leave/**, core/leave*, or any migration. Do not
edit the five old guards. Do not add an entry to test/pack-drift-allowlist.json.`,
  },
  {
    slug: 'draft-tabs',
    ns: 'r258draftf',
    item: '759dfc7d',
    extra: `YOUR VERDICT WAS "ship" WITH FOUR MINORS AND NO BLOCKER OR MAJOR. Two are code, two are
things the reporter must be told; fix the code and write the other two for the parent.

CODE:
- ⚠️ THE URL LIES. The screen now WRITES ?tab=<key> into the address bar on every tab switch but IGNORES
  it on load, so a reloaded or shared draft link reopens on the saved current_step rather than the tab
  the URL names. The activated record you are unifying with DOES honour ?tab=. Either honour it (read it
  on load, with the stored step as the fallback) or stop writing it — a URL that names a tab it will not
  open is worse than no parameter at all. Honouring it is the one that matches the record screen.
- ⚠️ A COMMENT THAT STATES A FALSE MECHANISM IS A TRAP FOR THE NEXT READER. Your report and the code
  comments say a value survives a tab switch "because ClientTabs keeps hidden panels MOUNTED". It does
  not. It works because the wizard holds its data in useState ABOVE ClientTabs and every input is
  controlled. The behaviour is right and the guarantee written beside it is false — correct the comment,
  and make the DOM test actually guard the mechanism that is real (unmount the panel and prove the value
  still survives, or assert the state lives above the tab shell).

FOR THE PARENT, in "reporterOwed", in plain business words (do NOT change the behaviour for either):
- The draft's tabs are in a different ORDER from the activated record's — Family is last on the draft and
  second on the record — and your reason (DRAFT_TABS is what current_step maps onto, so reordering is a
  data migration disguised as a UI change) is correct and must be stated, along with the fact that a
  display order separate from the number order is a small follow-up if they want the strips identical.
- The plan promised "the same section names, fields, dropdowns and validation". Section NAMES are
  delivered and pinned; FIELDS are not — the draft's tabs carry materially fewer controls, because a
  field only reaches the draft when Activate can actually carry it. Say which cards are absent and why,
  so the reporter is not left to discover it.

DO NOT touch app/me/**, app/admin/personnel/import/**, app/admin/personnel/[employmentId]/** beyond the
two optional props you already added to components/personnel-tabs.tsx, or any migration.`,
  },
];

const fixes = await parallel(
  WORK.map((w) => () =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${WT}/r258-${w.slug}
YOUR BRANCH:   r258/${w.slug}
YOUR TEST_DB_NAMESPACE: ${w.ns}
APPROVED PLAN: ${PLANS}/${w.item}.txt
YOUR FINDINGS: ${FIND}/${w.slug}.txt   ← read this first

${w.extra}`,
      { label: `fix:${w.slug}`, phase: 'Fix', schema: FIX_SCHEMA },
    ),
  ),
);

const done = fixes.filter(Boolean);
log(`fix: ${done.filter((f) => f.committed && f.tscClean && f.testsPass).length}/${WORK.length} green`);
return { workstreams: done };

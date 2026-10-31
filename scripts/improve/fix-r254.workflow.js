export const meta = {
  name: 'r254-fix-verified',
  description: 'One fix pass over three workstreams; the money one is hand-fixed by the parent',
  phases: [{ title: 'Fix' }],
};

// AGENTS 23b: ONE fix pass, then hand-fix — a second agent pass over the same code is where this repo
// goes backwards. And "anything money-affecting is hand-fixed on the first pass, not delegated", which is
// why r254-payitem-orp is NOT in this workflow: its two majors both move real pay and statutory bases.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r254plans';
const FIND = '/tmp/r254fix';

const COMMON = `
YOU ARE FIXING VERIFIED FINDINGS ON YOUR OWN BRANCH. Read them at the path below. They come from an
adversarial verifier that re-derived each claim itself. Most are real; not all will be.

FIX THE DEFECT, NOT THE TEST. If a finding says a guard is weak, strengthen what it proves — never delete
a case or loosen an assertion so it stops failing. If you genuinely DISAGREE, DECLINE it and say why in
\\\`declined\\\` with your evidence. A reasoned decline is a better outcome than an edit you do not believe in.

ORDER: blockers, then majors, then minors. Running short is fine if you SAY SO — an unfixed minor you
reported is acceptable; a major you quietly skipped is not.

ENVIRONMENT:
- Put \\\`cd <your worktree> &&\\\` in EVERY bash command; the shell's cwd resets and the repo ROOT is a stale
  scratch tree. Prove it first: \\\`cd <wt> && pwd && git rev-parse --abbrev-ref HEAD\\\`.
- Export your TEST_DB_NAMESPACE in every test command. Targeted tests ONLY, never the full suite.
  \\\`npx vitest run <files> > /tmp/<slug>-fix.log 2>&1\\\` then READ the log: exit code AND file count.
- \\\`npx tsc --noEmit\\\` clean before committing. Commit on your branch; never amend, rebase or git stash.
- No new migration. If you think you need one, stop and say so.
- i18n keys in all six locales with REAL translations, never English copied through.
- Source-scanning guards do not strip comments.
- Any test you add or change must be NON-VACUOUS: revert from a \\\`cp\\\` copy (never \\\`git checkout --\\\`),
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
    nonVacuityProof: { type: 'string' },
  },
};

const WORK = [
  {
    slug: 'personnel-save',
    ns: 'r254save',
    wt: `${WT}/r254-personnel-save`,
    items: ['420ebab5'],
    extra: `YOUR BLOCKER IS SILENT DATA LOSS AND IT COMES FIRST: pressing Enter to pick an option in any
Combobox on the Profile tab fires the consolidated save with the OLD value, then marks the tab clean — so
the user's change is gone AND the screen says everything is saved. Fix the key handling so Enter commits
the combobox selection to state and does NOT submit the form; a save must never run on a value the user
has just replaced.

THEN THE TWO UNMET PLAN PROMISES, because they are promises to the customer, not polish:
- The plan says the plain information cards lose their individual Save buttons "within each tab". Only
  the Profile tab was converted. Either convert the rest, or put in \\\`remaining\\\` exactly which tabs are
  still on per-card saves so the parent can tell the reporter what is and is not done.
- The request lists "Click Back" as an unsaved-changes trigger and browser Back/Forward currently leaves a
  dirty tab without asking.

THEN: the no-baseline-until-rendered problem (a section that was not mounted reads every non-empty field
as an unsaved edit the moment it appears), the false "no-JavaScript fallback" justification in the comment
for four of the five consolidated cards — correct the comment rather than the code if the code is right —
and the capture-phase click guard hijacking the bare Excel export anchor, which turns a download into an
unsaved-changes prompt.

The finding marked introducedByThisBranch=false (a bucket (b) write destroying pending bucket (a) edits
with no prompt) is REAL and predates you. Fix it if you can do so safely; if not, put it in
\\\`remaining\\\` in plain words — it is the one navigation route the new guard cannot see.

SCOPE FENCE UNCHANGED: do not touch app/admin/personnel/new/**.`,
  },
  {
    slug: 'draft-family',
    ns: 'r254draft',
    wt: `${WT}/r254-draft-family`,
    items: ['759dfc7d'],
    extra: `YOUR MAJOR IS A REAL CUSTOMER-VISIBLE BUG: the draft Family step's Relationship dropdown renders
the raw profile_option label, so on every tenant seeded by migration 0305 (where label = value) it shows
the machine value instead of a human label. Render it the way the Personnel Family tab already does —
find that code and reuse its resolution rather than writing a second one.

THEN, and finding 2 matters more than "minor" suggests: appending \\\`family\\\` to DRAFT_STEPS moves an
existing PRODUCTION draft onto a different step. The cohort saved at \\\`current_step = 5\\\` lands somewhere
they did not leave it. Work out the correct handling for drafts already in flight — a stored step index is
a pointer into a list you just changed — and pin it with a test that starts from a draft created BEFORE
your change.

THEN: the childTaxRelief null-vs-false divergence between the draft and the Personnel gesture (the same
action on two screens must store the same thing), and the Study country select's missing legacy-value
tolerance, which makes a deactivated catalog option render as empty rather than as what was stored.

SCOPE FENCE UNCHANGED: do not touch app/admin/personnel/[employmentId]/**.`,
  },
  {
    slug: 'leave-design',
    ns: 'r254leave',
    wt: `${WT}/r254-leave-design`,
    items: ['a6fe37fc'],
    extra: `⚠️ YOUR TWO MAJORS BOTH SAY THE SAME THING: THE DESIGN PROMISES THE CUSTOMER LESS THAN THE PLAN
DID, AND THE MOCKUPS PROMISE MORE THAN THE CODE CAN. Both must be fixed before this goes in front of them.

1. THE DESIGN KEEPS ALL TEN SCREENS and proposes a re-tabbing. The approved plan told them, after they
   asked twice, that "the old Leave Configuration screens come out and a new module goes in", and that we
   would stop arguing against it. A re-tab is the argument again, in another form. Either propose the
   structure the plan promised — screens that are genuinely removed, with every current function mapped
   onto the new ones or explicitly named as dropped — or, if you believe removal is genuinely wrong, say
   so ONCE in the document as a clearly-labelled recommendation the reporter can reject, and still show
   them the removal design beside it. Do not quietly deliver less than was approved.
2. TWO MOCKUPS DRAW CONTROLS THAT CANNOT BE BUILT inside the design's own "no new column, no migration"
   fence — on images that explicitly claim to be buildable. A mockup is a PROMISE (scripts/mockup/README.md
   says so). Either remove those controls, or state on the image and in the document exactly what they
   would cost. A picture cannot hedge; the caption must.

THEN THE FOUR ACCURACY FINDINGS, and treat them as seriously as the majors, because this document's whole
value is that its numbers are the customer's real ones:
- "14 of your 16 Annual Leave tables reach nobody" is subtraction (16 − 2), not a measurement, and it is
  presented as measured on three surfaces. Either measure it or say plainly how it is derived.
- §1.2's headline counts do not reproduce from source. Re-derive them or remove them.
- The migration order tells a future round that a source-scanning guard will catch a wrong tab storage
  key. That guard was deleted a year ago. Do not leave a future builder relying on a guard that does not
  exist.
- The cutover mockup says the approval replay runs on a COPY of production; the migration order says it
  runs against production itself. Those cannot both be true, and one of them is a promise about touching
  live data. Decide, and make both say the same thing.

STILL NO CODE, NO MIGRATION, NO TABLE PROPOSED FOR DROPPING, AND THE DAY-COUNT ENGINE STAYS.`,
  },
];

const fixes = await parallel(
  WORK.map((w) => () =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${w.wt}
YOUR BRANCH:   r254/${w.slug}
YOUR TEST_DB_NAMESPACE: ${w.ns}
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
    fixed: f.fixed,
    declined: f.declined,
    remaining: f.remaining,
    nonVacuityProof: f.nonVacuityProof,
  })),
};

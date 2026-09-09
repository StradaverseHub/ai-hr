export const meta = {
  name: 'r255-fix-verified',
  description: 'One fix pass over txn-scope and personnel-save; the parent hand-fixes the money one',
  phases: [{ title: 'Fix' }],
};

// AGENTS 23b: ONE fix pass, then hand-fix — and "anything money-affecting is hand-fixed on the first
// pass, not delegated". r255-zakat is therefore NOT in this workflow: its three majors are a double
// charge, a negative net pay, and historical payslips that no longer add up. The parent takes those.
// r255-draft-tabs is also absent — its build agent stalled on all six attempts and left unverified,
// untested work checkpointed on the branch; it is deferred, not fixed.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r255plans';
const FIND = '/tmp/r255fix';

const COMMON = `
YOU ARE FIXING VERIFIED FINDINGS ON YOUR OWN BRANCH. Read them at the path below. They come from an
adversarial verifier that re-derived each claim itself. Most are real; not all will be.

FIX THE DEFECT, NOT THE TEST. If a finding says a guard is weak, strengthen what it proves — never delete
a case or loosen an assertion so it stops failing. If you genuinely DISAGREE, DECLINE it and say why in
"declined" with your evidence. A reasoned decline beats an edit you do not believe in.

ORDER: blockers, then majors, then minors. Running short is fine if you SAY SO — an unfixed minor you
reported is acceptable; a major you quietly skipped is not.

ENVIRONMENT:
- Put "cd <your worktree> &&" in EVERY bash command; the shell's cwd resets and the repo ROOT is a stale
  scratch tree. Prove it first: cd <wt> && pwd && git rev-parse --abbrev-ref HEAD
- Export your TEST_DB_NAMESPACE in every test command. Targeted tests ONLY, never the full suite.
  npx vitest run <files> > /tmp/<slug>-fix.log 2>&1 then READ the log: exit code AND file count.
- ⚠️ THE LOCAL CLUSTER IS ON DISK. If you rebuild it: AIHR_RAMDISK_GB=0 ./scripts/dev-db-rebuild.sh —
  recreating the 8GB RAM disk on this 18GB machine OOM-killed three gates last round.
- npx tsc --noEmit clean before committing. Commit on your branch; never amend, rebase or git stash.
- No new migration. If you think you need one, stop and say so.
- i18n keys in all six locales with REAL translations, never English copied through.
- Any test you add or change must be NON-VACUOUS: revert from a cp copy (never git checkout --), watch
  the named assertion FAIL, restore. Say which assertion you watched fail.
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
    slug: 'txn-scope',
    ns: 'r255txn',
    wt: `${WT}/r255-txn-scope`,
    items: ['4b909202'],
    extra: `YOUR MAJOR IS A DEAD END YOU CREATED: the new "Add {employee} to this run" button marks a
processed run for a recalculation that can never actually be performed for the employee just added. A
button that leaves the operator with a run they cannot close is worse than the refusal it replaced —
read the finding's evidence and make the added employee genuinely reprocessable, or do not offer the
button in that state at all. Whichever you choose, prove it with a test that adds an out-of-scope
employee to a PROCESSED run and then completes the reprocess.

THEN THE THREE MINORS, and the last two are the kind that mislead a future reader:
- addEmploymentToBatchScope does a read-modify-write of the run's scope with no lock, so two concurrent
  adds can lose one. Serialise it.
- A comment this branch introduced is FALSE about what the message catalogue does with the pay period.
  Correct the comment; a false comment beside correct code is a trap for whoever reads it next.
- Dropping 'employeeNotInScope' from page.tsx's errorKeys set means that error URL now renders the raw
  key token instead of a sentence. Put it back, or prove nothing can produce that URL any more.

SCOPE FENCES UNCHANGED: closed runs stay refused; do NOT add a per-save confirmation prompt or a
per-transaction status column (the plan told the reporter both are not planned and invited a reject);
do NOT touch core/payroll.ts — the parent is hand-fixing the deduction totals there this round.`,
  },
  {
    slug: 'personnel-save',
    ns: 'r255save',
    wt: `${WT}/r255-personnel-save`,
    items: ['420ebab5'],
    extra: `⚠️ YOUR MAJOR IS MONEY AND IT IS MARKED introducedByThisBranch=FALSE — READ IT FIRST AND DO NOT
DISMISS IT AS PRE-EXISTING. A lone Statutory (Malaysia) save writes is_resident=false on an employee
whose tax residency is 'resident', and that alone charges the flat non-resident tax rate. Whether or not
this branch created it, this branch is the one consolidating those saves, so it is the round that either
fixes it or knowingly ships past it. Fix it if you safely can and pin it with a test that saves ONLY the
statutory card and asserts the residency flag is untouched. If you cannot fix it safely, put it in
"remaining" in plain words with the failure path, so the parent can decide — do not leave it silent.

⚠️ AND CORRECT THE DOCUMENT, because a wrong document outlives a wrong line of code: the classification
this branch ships records that behaviour as inert, which the finding shows is false. Fix the sentence.
Same for lib/tab-save-dom.ts's header, which still states the safety argument this branch invalidated.

THEN:
- On the Employment tab the tab-wide Save/Discard bar renders in the MIDDLE of the tab, above two
  editable cards it does not cover. A control that appears to cover what it does not is the exact class
  of defect the bucket (a)/(b) split exists to prevent. Move it, or scope it visibly.
- The Attendance tab's reading order changed, reversing item 52a30630's "Holiday Calendar pinned first",
  and no guard caught it. Restore the order AND add the guard, so the next round cannot repeat it.
- Payroll is not consolidated although the approved plan's build notes name setPaymentMethodAction in
  bucket (a). Either consolidate it or say plainly in "remaining" which tabs are still per-card, so the
  reporter can be told the truth rather than inferring it.

FAMILY AND QUALIFICATION STAY OUT — every form on them is a child record, so a tab-wide Save would have
nothing to save. That is a finding to communicate, not a thing to build.

SCOPE FENCE UNCHANGED: do not touch app/admin/personnel/new/**.`,
  },
];

const fixes = await parallel(
  WORK.map((w) => () =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${w.wt}
YOUR BRANCH:   r255/${w.slug}
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

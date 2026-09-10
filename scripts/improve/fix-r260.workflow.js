export const meta = {
  name: 'r260-fix-verified',
  description: 'One fix pass over the r260 verify findings; the parent hand-checks after',
  phases: [{ title: 'Fix' }],
};

// AGENTS 23b: ONE fix pass, then hand-fix.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r260plans';
const FIND = '/tmp/r260fix';

const COMMON = `
YOU ARE FIXING VERIFIED FINDINGS ON YOUR OWN BRANCH. Read them at the path below. They come from an
adversarial verifier that proved each claim at runtime, with planted sentinel values, rather than by
reading code. Most are real; not all will be.

FIX THE DEFECT, NOT THE TEST. If a finding says a guard is weak, strengthen what it proves — never delete
a case or loosen an assertion. If you genuinely DISAGREE, DECLINE it and say why in "declined".

ORDER: blockers, then majors, then minors. Running short is fine if you SAY SO.

ENVIRONMENT:
- Put "cd <your worktree> &&" in EVERY bash command; the shell's cwd resets and the repo ROOT is stale.
- Export your TEST_DB_NAMESPACE in every test command. Targeted tests ONLY. Redirect, never pipe; read
  the exit code AND the file count.
- ⚠️ RUN EVERY DIRECTORY-WALKING GUARD THAT COULD SEE YOUR FILES and name them in "guardsRun".
- ⚠️ THE LOCAL CLUSTER IS ON DISK: AIHR_RAMDISK_GB=0 ./scripts/dev-db-rebuild.sh if you must rebuild.
- npx tsc --noEmit clean before committing. Commit on your branch; never amend, rebase or git stash.
- No new migration. i18n keys in all six locales with REAL translations.
- A 200 IS NOT A RENDER CHECK. Re-render what you change and read the dev log.
- Any test you add or change must be NON-VACUOUS: revert the SHIPPED behaviour from a cp copy (never
  "git checkout --"), watch the named assertion FAIL, restore. Name the shipped line you broke.
`;

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'committed', 'tscClean', 'testsPass', 'fixed', 'declined', 'remaining'],
  properties: {
    slug: { type: 'string' }, committed: { type: 'boolean' }, commitSha: { type: 'string' },
    tscClean: { type: 'boolean' }, testsPass: { type: 'boolean' },
    guardsRun: { type: 'array', items: { type: 'string' } },
    fixed: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['finding', 'what'], properties: { finding: { type: 'string' }, what: { type: 'string' } } } },
    declined: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['finding', 'why'], properties: { finding: { type: 'string' }, why: { type: 'string' } } } },
    remaining: { type: 'array', items: { type: 'string' } },
    reporterOwed: { type: 'array', items: { type: 'string' } },
    nonVacuityProof: { type: 'string' },
  },
};

const WORK = [
  {
    slug: 'profile-requests',
    ns: 'r260profilef',
    item: '9583deac',
    extra: `⚠️ BLOCKER 1 — YOUR MIGRATION CAN ABORT A PDPA ERASURE, AND IT WAS PROVEN ON A LIVE PROBE TABLE.
0458's NOT VALID CHECK is still enforced on the NEW row version of any UPDATE. core/pdpa.ts:163-166
updates EVERY profile_change_request row for the subject — no status filter — inside the single erasure
transaction. So on any deployment holding a rejected request with no reason (exactly the legacy rows your
migration deliberately leaves blank), the erasure UPDATE violates the constraint and THE WHOLE ERASURE
ABORTS. Nothing is erased for that employee. The suite cannot see it: test/pdpa-erasure.test.ts never
mentions this table and every test DB is migrated fresh, so a legacy reasonless rejection cannot exist
there.

Your header's defence — that decideProfileChange refuses to re-decide a settled request — enumerates the
callers you thought of and misses the eraser, which is precisely why a database constraint is the wrong
place for this rule.

FIX IT BY REMOVING THE CONSTRAINT AND ENFORCING THE RULE WHERE THE DECISION IS MADE. Migration 0458 adds
a NULLABLE column and nothing else. core/profile.ts refuses a rejection with no reason. That keeps the
promise to the reporter ("Rejecting asks for a reason") without letting a data rule take a PDPA erasure
down with it. Keep the number 0458 — it is allocated to you and nothing else uses it — and rewrite the
file. Then ADD THE TEST THAT WAS MISSING: an erasure over an employee who has a rejected, reasonless
request must succeed and must redact it.

⚠️ BLOCKER 2 — THREE STATIC GUARDS ARE RED AND YOU RAN NEITHER FILE. Your report claims "23 files / 288
tests, exit 0" and lists neither test/me-tabs.test.ts nor test/company-panel-bank-statutory-layout.test.ts
in guardsRun. Run alone they give 3 failed / 229 passed:
  · me-tabs.test.ts:93 — form action={myRequestProfileChange} moved to app/me/request-change-card.tsx
  · me-tabs.test.ts:247 — the [data-tour="me-bank"] anchor moved to request-change-card.tsx:128
  · company-panel-bank-statutory-layout.test.ts — the masking literal moved to lib/profile-requestable-fields.ts
The BEHAVIOUR is fine (the form, the anchor and the masking all render). RE-POINT the guards at the new
files, exactly as you already did for test/me-profile-visibility.test.ts. AGENTS 18: update the case,
never relax it. The parent's full gate cannot go green until these three pass.
⚠️ AND THIS IS THE SECOND ROUND RUNNING THAT A BUILD REPORTED GUARDS GREEN WITHOUT RUNNING THEM. Before
you commit, run EVERY test file that greps app/me/ or lib/profile-* and name them all.

⚠️ MAJOR — THE APPROVER IS SHOWN RAW STORED VALUES. On /admin/personnel, describeProposed resolves a
select option to \`.value\` instead of its label, so an approver sees "Tax Category → 2" and
"Gender → male" where the old code printed "PCB → Married · spouse working". \`options?.find(o => o.value
=== String(value))?.value\` is a no-op that returns the string it just matched on. /me does it correctly
in this same round (request-change-card.tsx displayProposedValue resolves opt.labelKey), so the two
screens now disagree about the same request — the opposite of the single-master property this item is
sold on. Fix the admin side to resolve the label, and pin both screens to the SAME resolver so they
cannot drift again. An approver deciding a pay-affecting PCB change must not be reading an LHDN code.

THEN THE MINORS in your findings file. Fix what you can; anything you leave, say so in "remaining".

SCOPE FENCE: app/me/**, core/profile.ts, core/pdpa.ts (only if the erasure test needs it),
db/migrations/0458*, lib/profile-requestable-fields.ts, the admin approval surface, your tests, docs/,
six locales. Do NOT touch app/admin/leave-config/**. Do NOT change the migration NUMBER.`,
  },
  {
    slug: 'leave-round4',
    ns: 'r260leavef',
    item: 'a6fe37fc',
    extra: `⚠️ YOUR BLOCKER IS THAT THE RESTORATION RESTORES NOTHING ON A CONVERTED TENANT — WHICH IS WHAT
PRODUCTION IS. IA §4.1 asks for a surface for a rule's business unit / department / position scope. You
filtered the read-out to templateId === null. But convertLegacyApprovalRules COPIES those scope columns
onto the expanded rows and stamps templateId, so the converted rows — the population the design names,
"so CONVERTED rows may still carry them" — are excluded by your filter. They appear only in the
assignment list, which does not select, pass or render the three scope columns. So their org scope stays
invisible: exactly the thing this round exists to end.

Proven empirically, not argued: with one converted-shape rule inserted (active, templateId set,
department = Finance), the read-out said "Rules not built from a template (2)" and excluded it; the
assignment row rendered with no scope at all; and the string "Finance" appeared exactly ONCE in the whole
764KB response — inside the i18n catalogue, as a placeholder example.

FIX: show the scope for EVERY active rule that carries one, whether or not it came from a template. Widen
the read-out, or add the columns to the assignment rows, or both — your call, but the property to land is
that a stored scope column which decides who approves is VISIBLE SOMEWHERE. Prove it with the converted
shape (templateId NOT NULL + departmentId set), not just the untemplated one.

⚠️ THE MAJOR IS THE USER-VISIBLE FACE OF THAT BLOCKER AND IS INDEPENDENTLY WRONG. The empty state says:
"Every active approval rule is built from a template, so everything that routes a request is shown
above." On a fully-converted tenant that sentence is the ONLY thing the restoration ever renders, and its
second clause tells an administrator nothing is hidden at the exact moment the most-hidden thing is
hidden. AGENTS 28: an absent box asserts nothing, but a sentence asserting completeness that is false is
worse than the gap it fills. Reword it in all six locales to claim only what it can support — that no
rule carries its own chain — and never that everything routing a request is shown.

THEN THE MINORS in your findings file.

SCOPE FENCE: app/admin/leave-config/**, lib/permissions.ts, your tests, six locales. You MAY read
core/leave-approval-template.ts and app/admin/leave-approval/** to widen what is selected, and may add a
read-only projection there if that is the cleanest route — but change no action, no signature and no
write path, and do not touch app/admin/leave/**, components/leave-type-panel.tsx or app/me/**.
NO MIGRATION — everything you need is already stored.`,
  },
];

const fixes = await parallel(
  WORK.map((w) => () =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${WT}/r260-${w.slug}
YOUR BRANCH:   r260/${w.slug}
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

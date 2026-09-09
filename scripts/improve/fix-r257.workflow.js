export const meta = {
  name: 'r257-fix-verified',
  description: 'One fix pass over the r257 verify findings; the parent hand-checks after',
  phases: [{ title: 'Fix' }],
};

// AGENTS 23b: ONE fix pass, then hand-fix. A SECOND agent pass on the same code is where this repo goes
// backwards — r197-r199 and r201 each made a workstream WORSE that way. Everything still open after this
// pass is the parent's to fix by hand.
//
// NOTE ON INPUT QUALITY: the verify stage of r257 was handed the wrong approved-plan path for two of the
// three branches (the parent branched on the builder's self-reported `slug`, which came back prefixed).
// Code-level findings are unaffected and several are proven at runtime; plan-conformance findings may
// cite the wrong item. Each fix brief below carries the CORRECT plan path, and the two branches whose
// plan check was compromised are told to redo it as part of this pass rather than in a third pass.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r257plans';
const FIND = '/tmp/r257fix';

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
- ⚠️ THE LOCAL CLUSTER IS ON DISK. If you rebuild it: AIHR_RAMDISK_GB=0 ./scripts/dev-db-rebuild.sh.
- npx tsc --noEmit clean before committing. Commit on your branch; never amend, rebase or git stash.
- No new migration. If you think you need one, stop and say so.
- i18n keys in all six locales with REAL translations, never English copied through.
- Any test you add or change must be NON-VACUOUS, and the bar is higher than last round because the
  verifier caught proofs that perturbed the TEST HARNESS rather than shipped code: revert the SHIPPED
  behaviour from a cp copy (never "git checkout --"), watch the named assertion FAIL, restore. Say which
  assertion you watched fail and which SHIPPED line you broke to make it fail.
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
    reporterOwed: { type: 'array', items: { type: 'string' } },
    nonVacuityProof: { type: 'string' },
  },
};

const WORK = [
  {
    slug: 'leave-replay',
    ns: 'r257leavef',
    item: 'a6fe37fc',
    extra: `⚠️ YOUR BLOCKER IS THE WHOLE POINT OF THIS ROUND, AND IT WAS PROVEN AT RUNTIME. The cutover gate
can print "✓ every baseline routing case still reaches the same approver" and exit 0 while a live
employee's approver has genuinely moved. verifyApprovalRouting treats "is not one of today's tuple
representatives" as "has left the company", so ordinary staff turnover between baseline and verify
silently drops whole routing tuples out of the comparison. The verifier demonstrated it: Ada and Bob
share one Finance tuple, the baseline picks Ada, Ada is terminated, a new rule moves that tuple's ANNUAL
routing to payroll, Bob is still active and his chain moved — and the result was changed=0, gone=3,
added=3, exit 0, tick printed.

THIS IS A HARNESS THAT CERTIFIES A CUTOVER. A harness that can pass while routing moved is worse than no
harness at all, because Round 5 deletes ten screens on the strength of it. Fix it properly.

THE ROOT CAUSE, and the design note that caused it: the baseline stores only employmentId + companyId per
case (attrs "deliberately not stored"), and listRoutingSubjects returns ONE ARBITRARY representative per
tuple with no ORDER BY. So when the representative leaves, the tuple cannot be re-associated with the
colleague who is still in it. Storing the tuple's own identity — the attributes that DECIDE routing —
lets a tuple be matched across a change of representative, and a case should count as "gone" only when
the tuple has NO live members left. That also bears on your unbounded-cost major: a tuple-keyed grid is
the smaller thing to iterate. Whatever you choose, the property to land is: A ROUTING CHANGE AFFECTING
ANY LIVE EMPLOYEE MUST FAIL THE VERIFY AND EXIT NON-ZERO.

THEN THE MAJORS:
- The gate test that was supposed to cover this encodes a weaker property than its name and docblock
  claim, which is exactly why the defect survived a green suite. Strengthen it to the real property and
  make it fail on the unfixed code first.
- The replay's cost is unbounded and unmeasured against the tenant it is designed for: every grid cell
  issues two fresh queries. Bound it (hoist the per-cell reads, or key the grid by tuple) and SAY what
  the new shape costs.
- Round 1's exit condition is half met: the production baseline has not been captured. That half is the
  PARENT'S to run on the box — do not run anything against production yourself. Leave it in "remaining".

MINOR: --baseline and --verify swallow a following flag as their filename, contradicting the script's own
advertised property that malformed input is refused rather than guessed at. Refuse it.

DO NOT: add an --apply flag or any writer; touch core/leave.ts, core/leave-compute.ts or
core/entitlement-template.ts; touch any screen; add a migration.

ALSO OWED TO THE REPORTER, put it in "reporterOwed" rather than fixing it in code: the board plan's
reporter-facing half never tells them this check connects to their PRODUCTION database, and one claim
about touching live data reads as inverted. The parent will correct that on the board.`,
  },
  {
    slug: 'import-sections',
    ns: 'r257impf',
    item: '2983802f',
    extra: `⚠️ YOUR BLOCKER IS A DIVERGENCE FROM WHAT THE REPORTER APPROVED, AND THE PARENT HAS ALREADY
DECIDED HOW IT RESOLVES — READ THIS BEFORE YOU CHANGE ANY BEHAVIOUR.

The approved plan says: "Employee ID becomes the key. If it matches somebody who already exists, the file
updates them; if it does not, it creates them." You built UPDATE-ONLY and refuse every unmatched row.

YOUR ENGINEERING JUDGEMENT IS CORRECT AND IS BEING KEPT. A narrow section file carries no full_name, no
email, no department, no hired_on and no basic_salary — all required to create a person — so "create from
a Bank and Statutory file" cannot be made to work without inventing data. DO NOT BUILD CREATE-FROM-A-
SECTION-FILE. The parent is raising the correction to the reporter in plain words (AGENTS 31).

WHAT YOU MUST DO INSTEAD is make the product honest about it, because right now the divergence is
invisible: the refusal message must say plainly that a section file only updates people who already
exist and name the full employee template as the way to add someone, and the template chooser / preview
must say the same BEFORE a file is uploaded rather than after it fails. Put the exact wording you ship in
"reporterOwed" so the parent's correction and the screen say the same thing.

THEN THE MAJORS, and the first three are data-integrity:
- A Profile section file silently gives two employees the SAME work/login email: no preview error, no
  in-file duplicate check, no existing-owner check. Catch it in the preview.
- The dry run does not detect two rows in ONE file assigning the same NRIC. Both preview as "Update /
  Ready" and the second dies at commit with a raw driver error. Catch it in the preview too.
- Four of the Employment section's six columns write LEGACY employment columns the Personnel Employment
  tab no longer reads (probation_months, resignation_notice_* among them). An import that appears to
  succeed and changes nothing the user can see is the worst kind of pass. Either write what the screen
  reads, or drop those columns from the section and say so.
- The test file does not pin four of the "blank means leave this as it is" merges — THE MECHANISM THE
  WHOLE ITEM TURNS ON. All 15 tests stay green with the merge broken. Pin every one of them, and prove
  non-vacuity by breaking the SHIPPED merge, not the harness.
- The fence refuses 17 of the 49 wide-template columns with a message telling the user to "choose the
  section that owns them" — but no section owns any of them. That message sends people to a door that
  does not exist. Either give them a home or say plainly they are not importable per-section yet.

MINORS: the preview reports all five emergency-contact columns as changed even when the value is
identical, turning a no-change row into an update; Import History records a fully-up-to-date run as
FAILED; and — this one matters more than its severity suggests — RAW DRIVER ERROR TEXT INCLUDING BOUND
PARAMETER VALUES SUCH AS AN NRIC is persisted into employee_import_run.errors and rendered to the admin.
This is an HR product under PDPA. Do not persist raw driver text; map it to a message that names the
column and the row without echoing the value.

SCOPE FENCE UNCHANGED: app/admin/personnel/import/**, lib/import-schema.ts, core/import-sections.ts,
lib/import-sections.ts and your tests. Do NOT touch app/admin/personnel/[employmentId]/** or
app/admin/personnel/page.tsx or app/admin/personnel/new/** — other branches own those. No new migration.
DO NOT absorb Attendance, Leave or Career Movement.`,
  },
  {
    slug: 'personnel-close',
    ns: 'r257persf',
    item: '420ebab5',
    extra: `⚠️ FIRST, REDO THE PLAN CONFORMANCE CHECK — YOUR VERIFIER WAS GIVEN THE WRONG PLAN. Through an
orchestration bug the verify pass was handed the IMPORT item's plan instead of yours, so the one check
that matters most for a CLOSE-OUT — does the branch deliver every promise the reporter approved? — was
never really performed. Your own build brief had the right plan and your audit was sound; this is asking
you to close the loop rather than to start again. Read ${PLANS}/420ebab5.txt promise by promise against
what is now on your branch plus main, and report any promise still unmet in "remaining". Do NOT rebuild
what is already shipped.

YOUR MAJOR IS WORSE THAN YOU DOCUMENTED IT, and that is the finding to act on. You recorded the Discard
race as "restores the values the page opened with" — showing stale values. The verifier's evidence is
that it SILENTLY WRITES A PREVIOUSLY-SAVED FIELD BACK TO ITS PRE-SAVE VALUE, i.e. it loses a save that
had already succeeded. That is data loss in a narrow window, not a display quirk.

You declined both fixes you considered and your reasoning was sound for both — restoring from the posted
values breaks server normalisation, and gating the button on the refresh landing can disable it forever.
But those are not the only two options, and a third is not obviously worse: the scope knows it is waiting
for a refresh, so Discard during that window can restore from the values the SERVER returned for the
fields it has, and leave the re-baseline until the refresh lands; or the window can be closed by
re-baselining from the server's response payload rather than from the next render. Try to close it. If
after trying you still believe every available fix is worse than the window, DECLINE it with the evidence
— that is a legitimate answer — but then FIX THE TWO RECORDS, because both currently understate it:
the audit doc's "The one thing left open" section and the §14 docblock must say a previously-saved value
can be overwritten, not that stale values are shown.

THEN THE TWO MINORS ABOUT YOUR OWN PROOFS, and they are the reason the bar moved this round:
- Your nonVacuityProof for §14 and §15 perturbed the TEST HARNESS, not shipped code, so it did not
  establish what it claimed. Redo both against the shipped behaviour and say which shipped line you broke.
- §15's headline assertion — the recorded revision is still on screen after Discard — cannot fail: it is
  structurally guaranteed by the harness. Rewrite it so it is capable of failing, or replace it with an
  assertion that is.

SCOPE FENCE: app/admin/personnel/[employmentId]/**, app/admin/personnel/page.tsx, the shared personnel
components, lib/tab-save-dom.ts, lib/unsaved-changes.ts, lib/personnel-tab-sections.ts and your tests.
Do NOT touch app/admin/personnel/import/** or lib/import-schema.ts (another branch owns the importer),
app/admin/personnel/new/**, app/me/**, or core/leave-*. No new migration. Do not edit HANDOFF.md.`,
  },
];

const fixes = await parallel(
  WORK.map((w) => () =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${WT}/r257-${w.slug}
YOUR BRANCH:   r257/${w.slug}
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
for (const f of done) {
  log(`  ${f.slug}: ${f.fixed?.length ?? 0} fixed, ${f.declined?.length ?? 0} declined, ${f.remaining?.length ?? 0} remaining`);
}

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
    reporterOwed: f.reporterOwed,
    nonVacuityProof: f.nonVacuityProof,
  })),
};

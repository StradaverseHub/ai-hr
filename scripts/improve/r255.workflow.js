export const meta = {
  name: 'r255-build-approved',
  description: 'Build 4 approved board items as 4 workstreams, each verified adversarially',
  phases: [{ title: 'Build' }, { title: 'Verify' }],
};

// The PARENT created every worktree from main, copied .env.local and symlinked node_modules.
// `isolation: 'worktree'` is FORBIDDEN here (it cuts the tree from root HEAD; the repo root is stale).
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r255plans';

const COMMON = `
ENVIRONMENT AND HARD RULES — read before touching anything.

- Your worktree is the ONLY place you may edit. Put "cd <your worktree> &&" in EVERY bash command; the
  shell's cwd resets between calls and the repo ROOT is a stale scratch tree. This has cost five rounds.
  Prove it in your FIRST command: cd <wt> && pwd && git rev-parse --abbrev-ref HEAD
- This is NOT the Next.js you know (16.2.7). Read the relevant guide under node_modules/next/dist/docs/
  before writing Next-specific code.
- Understand code through the graph rather than grepping cold: from \${WT}/mainwt run
  graphify explain "<symbol>" · graphify query "<question>" · graphify affected "<symbol>".
- TESTS: run ONLY narrowly targeted files. NEVER the full suite — the parent runs the single gate alone.
  npx vitest run <files> > /tmp/<slug>.log 2>&1 then READ the log: exit code AND file count, never the
  summary alone, and never pipe a long command to tail.
- Export your own TEST_DB_NAMESPACE in every test command. Two agents sharing one wipe each other's
  worker databases.
- npx tsc --noEmit clean before you commit.
- ⚠️ THE LOCAL CLUSTER IS ON DISK THIS ROUND, NOT ON THE RAM DISK (r254). Do NOT run
  dev-db-rebuild.sh without AIHR_RAMDISK_GB=0 — recreating the 8GB RAM disk on this 18GB machine is
  what OOM-killed three gates. If you must rebuild: AIHR_RAMDISK_GB=0 ./scripts/dev-db-rebuild.sh
- NO MIGRATION IS EXPECTED. If you believe you need one, STOP and say so — numbers are allocated
  centrally and taking one yourself silently breaks deploy ordering. (0457 is the next free number; do
  not use it without being told to.)
- A new file under core/ must import packs/<pack>/service, never the pack implementation. The ratchet
  scans the FILESYSTEM and does NOT strip comments.
- A new guarded page.tsx needs a column in lib/permissions.ts or the reverse-completeness case fails.
- A guard may pin the decision you are reversing: UPDATE its case with the new reasoning, never delete
  it. r254 hit this — a layout guard pinned "single-record forms stay narrow" while the approved plan
  asked for full width; the fix was to move the entry and write the argument, not to delete the case.
- i18n: keys in messages/en.json AND ms, zh, ta, th, vi. Parity is enforced by a test; a stale or
  English VALUE is not, so write real translations.
- Source-scanning guards do not strip comments: never spell a forbidden expression out beside its guard.
- COMMIT on your branch when done. Never amend, never rebase, never git stash — stashes are REPO-GLOBAL.

EVERY TEST YOU ADD MUST BE PROVED NON-VACUOUS: revert the change from a cp copy taken FIRST (never
git checkout --, which reverts to HEAD and has destroyed a round's work here), watch the intended
assertion FAIL, restore. State which assertion you watched fail.

BUILD WHAT THE APPROVED PLAN SAYS, not what the original ticket says. Anything you cannot build goes in
notBuilt with the reason, never silently skipped.

⚠️ VERIFY THE PLAN'S PREMISE BEFORE BUILDING ON IT. Repeatedly here the reported fault was not the real
one. If measurement contradicts the plan, STOP and report rather than building on it.
`;

const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'committed', 'tscClean', 'testsPass', 'summary', 'notBuilt'],
  properties: {
    slug: { type: 'string' },
    committed: { type: 'boolean' },
    commitSha: { type: 'string' },
    tscClean: { type: 'boolean' },
    testsPass: { type: 'boolean' },
    testFiles: { type: 'array', items: { type: 'string' } },
    nonVacuityProof: { type: 'string' },
    summary: { type: 'string' },
    notBuilt: { type: 'array', items: { type: 'string' } },
    migrationsUsed: { type: 'array', items: { type: 'string' } },
    filesTouched: { type: 'array', items: { type: 'string' } },
    premiseCheck: { type: 'string' },
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'verdict', 'findings'],
  properties: {
    slug: { type: 'string' },
    verdict: { type: 'string', enum: ['ship', 'fix-first'] },
    nonVacuityRederived: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'claim', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          introducedByThisBranch: { type: 'boolean' },
        },
      },
    },
  },
};

const WORK = [
  {
    slug: 'zakat',
    ns: 'r255zakat',
    wt: `${WT}/r255-zakat`,
    items: ['3a092cf0'],
    brief: `Read the approved plan: ${PLANS}/3a092cf0.txt.

⚠️ THIS ONE CHANGES REAL TAKE-HOME PAY, AND IT CHANGES IT DOWNWARD. Affected employees will be paid LESS,
correctly, because money that should have been deducted as zakat was being left in their pay. Do not
"preserve behaviour" anywhere — the current behaviour IS the defect.

THE DEFECT IS ONE LINE, ALREADY LOCATED BY THE PARENT. core/payroll.ts:5441:
  const statDeductions = round2(
    st.epfEmployee + st.socsoEmployee + st.socsoSkbbk + st.eisEmployee + st.pcb - employerBorneTotal,
  );
\`st.zakat\` is absent. totalDeductionsRaw (5481) and net (5483) are both composed from statDeductions, so
the omission propagates consistently — which is why every affected payslip still reconciles internally
and nothing looked wrong.

MEASURED ON PRODUCTION 2026-09-08 (use these as your fixtures; do not invent figures):
  SIG01, batch 2026-01, processed: basic 3708.00 · allowance 600.00 · gross 4308.00
  epfEmployee 410 · socsoEmployee 18.75 · socsoSkbbk 0 · eisEmployee 7.5 · pcb 0 · zakat 30
  other_deductions 0.00 · total_deductions 436.25 · net_pay 3871.75
  pcbMeta.trace: mtdNormalCalc 7.9 · mtdNormalFloored 0 · zakatCurrent 30 · zakatLeftover 30
  410 + 18.75 + 0 + 7.5 + 0 = 436.25 exactly. Correct: 466.25, net 3841.75.

⚠️ THE OFFSET IS ALREADY CORRECT AND MUST NOT BE TOUCHED. The engine already applies zakat against the
PCB liability and records the remainder. SIG01's PCB is zero because 7.90 fell under the RM10 remittance
FLOOR — not because zakat consumed it — so the whole 30 is genuinely owed. Adding st.zakat to
statDeductions is the correct fix; the double-charge risk is prevented by the existing offset, NOT by
excluding zakat from the total.

REQUIRED TESTS — the pair is the point, one alone proves nothing:
  (a) SIG01's shape: PCB floored to zero, full zakat charged, total 466.25 and net 3841.75.
  (b) A shape where PCB BEFORE zakat EXCEEDS the zakat: the offset absorbs it, PCB drops, and NOTHING
      extra is charged — proving nobody pays twice.

THEN THE SWEEP, which is half the plan's promise: every result surface must show one consistent total.
The reporter named payroll result, transaction entry, transaction view, transaction detail, transaction
view history, individual payslip and the statutory explanation. Find any screen that SUMS ITS OWN
deduction lines rather than reading the stored total — that is a second source of truth and is exactly
where this recurs. Report what you found either way.

SCOPE FENCES:
- Do NOT change the PCB calculation, the RM10 floor, the zakat offset, or any other deduction.
- Do NOT write a data migration to correct stored payslips. Corrected figures come from REPROCESSING a
  run, which is an operator action. Two of the nine affected payslips are on CLOSED runs and are frozen;
  the plan puts that decision to the reporter and you must not pre-empt it.
- Do NOT touch core/payroll-individual-txn.ts — another workstream owns it this round.`,
  },
  {
    slug: 'txn-scope',
    ns: 'r255txn',
    wt: `${WT}/r255-txn-scope`,
    items: ['4b909202'],
    brief: `Read the approved plan: ${PLANS}/4b909202.txt.

⚠️ MOST OF THIS TICKET IS ALREADY BUILT AND THE PLAN SAYS SO. Do not rebuild it. Verified by the parent
on 2026-09-08:
  core/payroll-individual-txn.ts:688-690 — on ADD, if (target.status === 'processed') →
    markBatchNeedsRecalc, in the SAME transaction as the insert (feature 49e7e0a2). Same call on bulk
    save (876), edit (1063), delete (1115). core/payroll.ts:150 refuses close while anyone is pending.
  Live: 6 batches carry needs_recalc_at right now; payroll_reprocess_job holds 103 rows.
So request points 1, 3, 4, 5 and 6 are shipped. Building them again would be the round's biggest waste.

THE ACTUAL BLOCKER is C4, the batch SCOPE check, core/payroll-individual-txn.ts:788-796 — it tests scope
membership (departments ∪ explicit employments), NEVER status, and fires identically on a DRAFT run.
app/payroll/transactions/individual/actions.ts:69-70 maps it to the key \`employeeNotInScope\`, whose text
is the sentence the reporter quoted. Production: 12 of 27 batches are scoped, 11 of those processed.

BUILD:
1. Replace the message with one that names the RUN, the EMPLOYEE and the scope reason. The current key
   takes no values, so this is a parameterised replacement, not a reword. All six locales, real
   translations.
2. THE ONE GENUINELY NEW PIECE: an "add this employee to the run" action. It must extend the run's scope
   AND, when the run is processed, call markBatchNeedsRecalc for that employment — otherwise the newly
   added person is silently absent from the payslips, which is worse than the refusal it replaces.
   PREFER appending an explicit-employment exception over rewriting the operator's stored department
   choice; say which you did and why.
3. Apply the same message to the other entry points — core/payroll-txn-import.ts:150 already maps the
   same error — so one situation reads one way everywhere.

REQUIRED TESTS:
  - the scope refusal fires on a DRAFT run (this is what proves it is not about status);
  - an add to a processed, in-scope run still flags recalc (the existing behaviour, unbroken);
  - adding an out-of-scope employee to a PROCESSED run both widens scope AND flags that employment.

SCOPE FENCES:
- Closed runs stay refused. The request itself asks for that.
- Do NOT add a confirmation prompt on every save, and do NOT add a per-transaction "Pending
  Reprocessing" column. The plan explicitly tells the reporter both are NOT planned and invites them to
  reject if they disagree. Building them anyway would ship scope they never approved.
- Do NOT touch core/payroll.ts's deduction totals — another workstream owns that file this round.`,
  },
  {
    slug: 'personnel-save',
    ns: 'r255save',
    wt: `${WT}/r255-personnel-save`,
    items: ['420ebab5'],
    brief: `Read the approved plan: ${PLANS}/420ebab5.txt. Part one (clickable row) shipped in r253; the
Profile tab's consolidated Save shipped in r254. FINISH THE REMAINING TABS.

START FROM WHAT r254 LEFT: docs/audits/420ebab5-personnel-save-classification.md classifies all 35 forms
into bucket (a) field edits and bucket (b) child-record lifecycle. The Profile tab is the working pattern
— follow it rather than inventing a second one.

STILL ON PER-CARD SAVES, from r254's own report:
  BANK & STATUTORY (4): setBankAction, setStatutoryAction, setTaxAction, setOthersStatutoryAction
  ATTENDANCE (3): setEmploymentHolidayCalendarAction, setEmployeeClockingLocationsAction, setGeofencingAction
  PAYROLL (3): setPaymentMethodAction, assignPolicyAction, setTp3Action
  JOB (1): setEmploymentInfoAction

⚠️ r254 MEASURED THAT BANK & STATUTORY IS NOT THE MECHANICAL REPEAT THE WRITE-UP ASSUMED — read its note
in the round record before estimating. Do the tabs you can do properly and SAY which you did not, with
the reason. A half-applied pattern reported honestly is fine; a silently skipped tab is not.

⚠️ FAMILY AND QUALIFICATION ARE NOT IN SCOPE AND MUST NOT BE FORCED. r254 established that every form on
both is a child record, so a tab-wide Save would have nothing to save and a tab-wide Discard would cover
nothing. The reporter named Family explicitly, so the round owes them an explanation — put it in
notBuilt in plain words rather than building something that pretends.

⚠️ THE BUCKET (b) FENCE IS THE WHOLE SAFETY ARGUMENT. Add/edit/archive of dependants, qualifications,
emergency contacts, CP38, encashment, compensation revisions and pay items KEEP their own buttons and
confirmations. Several move money. A tab-wide Discard that appeared to cover a recorded salary revision
would be a control lying about what it does. If you think something is mis-bucketed, report it; do not
re-bucket it yourself.

EFFECTIVE DATING SURVIVES (ADR-0001/0003): a save CLOSES the current version and INSERTS a new one. A
consolidated Save must still call the SAME services per section, in order — never one blanket write, and
never bypass a service to write a table directly.

SCOPE FENCE: do NOT touch app/admin/personnel/new/** — another workstream owns it this round.`,
  },
  {
    slug: 'draft-tabs',
    ns: 'r255draft',
    wt: `${WT}/r255-draft-tabs`,
    items: ['759dfc7d'],
    brief: `Read the approved plan: ${PLANS}/759dfc7d.txt. Stage one (Family on drafts, including
materialisation at activation) shipped in r254. BUILD THE REMAINING TABS onto the same foundation.

lib/employee-draft-schema.ts already carries:
  export const DRAFT_STEPS = ['profile', 'employment', 'statutory', 'payroll', 'family'] as const;
so the step list is in place and Family proved the pattern end to end.

WHAT REMAINS: bring Profile Details, Employment, Bank & Statutory and Payroll onto the same tabbed
structure and the same field set the ACTIVE employee record uses, so an administrator sees one screen
shape rather than two.

⚠️ ROUTE A ONLY, AND THE PLAN CHOSE IT DELIBERATELY. A draft is ONE row whose \`data\` is a jsonb blob:
"a draft still creates no person and no employment, and is still absent from headcount, payroll, leave
and every report." Give the shared sections a second binding that reads/writes the draft blob. Route B —
making a draft create real person/employment rows in a 'draft' state — was REJECTED because it inverts
that invariant and would force headcount, payroll eligibility, leave accrual, reports and RLS all to
learn a new state. If you find yourself needing Route B, STOP and report it.

⚠️ ACTIVATION IS WHERE THIS BREAKS IF IT BREAKS. Family established the pattern: blob entries become real
rows, idempotently and all-or-nothing WITH the rest of activation. Every tab you add must materialise the
same way. Test FIELD BY FIELD that everything entered on a draft survives Activate with nothing retyped —
do not spot-check; a silently dropped field is the exact failure this whole item exists to prevent.

DO NOT LOSE: company and the reserved employee code stay read-only (saveEmployeeDraft pins them);
save-without-validation must still work — that is what a draft IS; discard must still release the
reserved code to its issuing config, or to the tenant counter when reservedConfigId is null.

THE FOUR TABS THAT DO NOT APPEAR ON A DRAFT stay absent, and the plan told the reporter why: Career
Movement, Attendance, Leave and Documents describe things that have happened to an employment, and a
draft has none. Do not add them.

SCOPE FENCE: do NOT modify anything under app/admin/personnel/[employmentId]/** — another workstream is
restructuring that screen's save behaviour this round. If reusing one of its components looks right, say
so in your report and leave it for the next round.`,
  },
];

const built = await parallel(
  WORK.map((w) => () =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${w.wt}
YOUR BRANCH:   r255/${w.slug}
YOUR TEST_DB_NAMESPACE: ${w.ns}   (export it in every test command)
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
      `ADVERSARIAL VERIFICATION of workstream "${w.slug}" on branch r255/${w.slug}, worktree ${w.wt}.

You are NOT the builder and take nothing on trust. Put "cd ${w.wt} &&" in every bash command. Your
TEST_DB_NAMESPACE is ${w.ns}v. Targeted tests only, never the full suite. The local cluster is ON DISK —
if you rebuild it, use AIHR_RAMDISK_GB=0.

Read the approved plan (${w.items.map((i2) => `${PLANS}/${i2}.txt`).join(', ')}) and the branch diff
(git diff main...HEAD). The builder reported:

${JSON.stringify(b, null, 2)}

LOOK FOR, IN THIS ORDER:
1. A DEFECT THIS BRANCH INTRODUCED. Rank highest; set introducedByThisBranch.
2. MONEY. For zakat especially: does the fix charge the zakat EXACTLY ONCE? Construct the case where PCB
   before zakat exceeds the zakat and prove nothing extra is charged, and the case where PCB is floored
   to zero and prove the full zakat is charged. Re-derive both yourself — a fix that double-charges is
   worse than the defect it replaces.
3. A GUARD THAT CANNOT FAIL. Re-derive the non-vacuity claim YOURSELF: cp copy, revert, run the named
   assertion, confirm it fails, restore. This repo has shipped vacuous guards whose authors sincerely
   believed they had tested them. Set nonVacuityRederived only if you actually did this.
4. THE PLAN'S PROMISE vs WHAT SHIPPED — including things built that the plan did NOT promise.
5. SCOPE FENCES CROSSED:
   zakat → PCB calc, RM10 floor and the offset untouched; no data migration; closed runs not pre-empted;
     the deduction-total sweep actually done rather than claimed;
   txn-scope → the already-built recalc flow not rebuilt; closed runs still refused; NO per-save
     confirmation prompt and NO per-transaction status column (the plan told the reporter these are not
     planned — building them ships unapproved scope);
   personnel-save → bucket (b) keeps its own buttons and is NOT covered by the tab's Discard; effective
     dating preserved (close+insert, per-section services, no blanket write); Family/Qualification not
     forced; new/** untouched;
   draft-tabs → Route B not substituted; [employmentId]/** untouched; save-without-validation still
     works; reserved code still released on discard; the four employment-history tabs still absent.
6. A user-visible string that is wrong, untranslated, or renders MISSING_MESSAGE.
7. A comment that is now false.

Give each finding a concrete failure path — the input or state that reaches it, with file:line. A finding
without one is a guess: say so or drop it. Verdict 'fix-first' ONLY for a blocker or a real major.`,
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

log(`build: ${green.length}/${WORK.length} green · ${blockers.length} blocker/major`);

return {
  workstreams: done.map((r) => ({
    slug: r.built.slug,
    committed: r.built.committed,
    commitSha: r.built.commitSha,
    tscClean: r.built.tscClean,
    testsPass: r.built.testsPass,
    premiseCheck: r.built.premiseCheck,
    migrationsUsed: r.built.migrationsUsed,
    notBuilt: r.built.notBuilt,
    nonVacuityProof: r.built.nonVacuityProof,
    verdict: r.verify?.verdict ?? 'no-verify',
    nonVacuityRederived: r.verify?.nonVacuityRederived,
    findings: r.verify?.findings ?? [],
  })),
  blockers,
};

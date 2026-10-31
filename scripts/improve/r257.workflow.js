export const meta = {
  name: 'r257-build-verify',
  description: 'Three disjoint approved items: leave approval replay harness, 420ebab5 close-out, per-section import',
  phases: [{ title: 'Build' }, { title: 'Verify' }],
};

// AGENTS 12: agents run ONLY their own targeted tests. The parent runs the single full gate, alone.
// AGENTS 1: one vitest at a time — every agent gets its own TEST_DB_NAMESPACE.
// AGENTS 23: the adversarial verify is the load-bearing step. r209 shipped seven green workstreams and
// the verify pass found 19 majors, 13 introduced by the build itself. Budget for it.
//
// WHY ONLY THREE OF THE FIVE APPROVED ITEMS ARE HERE. 759dfc7d (draft employee onto the shared tabs) and
// 9583deac (My Profile) both rebuild against the SAME personnel section components that 420ebab5 is
// finishing in this round. 9583deac's own approved build notes say so: "Do NOT start stage one until
// 420ebab5's consolidation has landed, or this becomes the third branch editing the same file — r253
// already cost a five-file hand-resolved conflict from two." Those two go back to the reporter as plans.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r257plans';

const COMMON = `
ENVIRONMENT — read this before your first command.

- Put "cd <your worktree> &&" in EVERY bash command, including read-only greps. The shell's cwd resets
  between calls and the repo ROOT is a STALE scratch tree far behind main. A grep in the wrong tree
  silently answers about code from weeks ago; this has landed five times. Prove your tree first:
  cd <wt> && pwd && git rev-parse --abbrev-ref HEAD
- Export your TEST_DB_NAMESPACE in every test command. TARGETED TESTS ONLY, never the full suite —
  the parent runs the single full gate alone, and a second vitest wipes the first's worker DBs.
  npx vitest run <files> > /tmp/<slug>.log 2>&1   then READ the log: exit code AND file count.
  Never pipe a long command; redirect. An undrained pipe hangs forever and reports the wrong exit code.
- ⚠️ THE LOCAL CLUSTER IS ON DISK. If you rebuild it: AIHR_RAMDISK_GB=0 ./scripts/dev-db-rebuild.sh —
  the 8GB RAM disk IS memory on this 18GB machine and OOM-killed three gates two rounds ago.
- npx tsc --noEmit clean before you commit. Commit on YOUR branch. Never amend, rebase, or git stash —
  stashes are REPO-GLOBAL and one agent has already popped another's into its tree. Checkpoint with a
  commit instead.
- i18n: any new key goes into ALL SIX locales with REAL translations, never English copied through.
- Any test you add or change must be NON-VACUOUS. Revert your fix from a "cp" copy you took up front
  (NEVER "git checkout --", which reverts to HEAD and has destroyed a release's uncommitted work),
  watch the named assertion FAIL, then restore. Say which assertion you watched fail.
- A 200 is not a render check. MISSING_MESSAGE and RSC boundary bugs pass tsc, the suite and next build
  and still return 200. If you change a screen, render it on a dev server and read the dev log.

REPORT WHAT YOU DID NOT DO. A plan is a promise to the reporter and a brief is an instruction to you;
nothing checks that the second contains the first. If you skip or cannot finish something the approved
plan promised, put it in "notBuilt" in plain words. An unfinished item you REPORTED is acceptable; one
you quietly dropped is not. This is how r218's real deliverable was recovered.
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
    slug: 'leave-replay',
    ns: 'r257leave',
    item: 'a6fe37fc',
    brief: `YOU ARE BUILDING ROUND 1 ONLY of the Leave Configuration replacement, exactly as
docs/design/a6fe37fc-migration-order.md defines it. READ THAT DOCUMENT'S SECTION 0 AND "Round 1" FIRST,
and docs/design/a6fe37fc-leave-config-ia.md for context. The approved plan is at ${PLANS}/a6fe37fc.txt.

⚠️ NOTHING ABOUT ANY SCREEN CHANGES IN THIS ROUND, AND NO MIGRATION. Round 1 is the acceptance test,
built BEFORE the thing it tests, because "building it last would mean discovering a routing change after
it had shipped". The ten old pages are NOT touched, NOT deleted and NOT redirected — that is Round 5.
The engine (core/leave.ts, core/leave-compute.ts, core/entitlement-template.ts) is NEVER touched: the
customer's 297 balance records were produced by it and are reconciled against it. If you conclude you
need a migration or a column, STOP and say so in notBuilt rather than inventing a number.

WHAT TO BUILD, and the design names all four:

1. resolveApprovalDecision(tx, companyId, leaveTypeId, attrs) in core/leave-approval-policy.ts, returning
   { levels, ruleId, source } where source is 'rule' | 'tenant-default' | 'fallback'.
   resolveApprovalChain becomes a ONE-LINE WRAPPER returning levels. ONE MATCHER, TWO CALLERS — a second
   ranking of the same rules is the exact defect this whole item exists to remove, so do not copy the
   ranking logic into the new function and leave the old one beside it.

2. approvalRoutingSnapshot(tx) and diffApprovalRouting(before, after, subjects) — these are the two
   PRIVATE functions core/leave-approval-consolidation.ts already has (snapshotApprovalRouting,
   diffSnapshots), promoted to exports. NO NEW LOGIC IS WRITTEN. If you find yourself rewriting them,
   you have misread the task.

3. scripts/replay-approval-routing.ts with --baseline <file>, --verify <file>, and --coverage.
   ⚠️ IT CONNECTS TO THE PRODUCTION DATABASE ITSELF, NOT A COPY, AND THAT IS DELIBERATE — there is no
   rehearsal copy of this tenant and a replay against one would prove nothing about the rows that route
   real requests. What makes it safe is its SHAPE, and you must preserve every part of it:
     · READS ONLY.
     · ONE TRANSACTION THAT ALWAYS ROLLS BACK.
     · THERE IS NO --apply FLAG. scripts/convert-approval-rules.ts has one; this must NOT. Do not add it,
       do not add anything that writes, and do not add a "just in case" escape hatch.
   It enumerates tenants through MIGRATION_DATABASE_URL exactly as convert-approval-rules.ts does.
   DOCUMENT THE INVOCATION IN THE FILE HEADER and get it right — "node --env-file=" EXITS 9 on the server
   (bad option; the box is node v18.19.1). The only form that runs there is:
       cd /opt/ai-hr && set -a && . ./.env.production && set +a \\
         && node --import tsx scripts/replay-approval-routing.ts --baseline …
   23 scripts in scripts/ document the broken form. Do not make it 24.

4. test/leave-approval-replay.test.ts — the same harness against a SEEDED tenant, running on every gate.

EXIT CONDITION, and it is the part that is easy to skip: PROVE THE HARNESS CAN FAIL (design §2.4). A
comparison harness that cannot fail is worse than none, because it certifies the cutover. Read §2.4 and
do what it says; state in nonVacuityProof exactly which mutation you made and which assertion caught it.
Also implement --coverage (§2.3) — which rules ever WIN — because a replay over rules that never match
proves nothing about them.

DO NOT RUN THE SCRIPT AGAINST PRODUCTION YOURSELF. Build it, test it against the seeded tenant, and say
in notBuilt that the production baseline is the parent's to capture.

SCOPE FENCE: core/leave-approval-policy.ts, core/leave-approval-consolidation.ts, the new script and the
new test. You are the ONLY agent in this round touching core/leave-*. Do not touch app/admin/personnel/**
or app/me/** — two other agents are in those trees.`,
  },
  {
    slug: 'personnel-close',
    ns: 'r257pers',
    item: '420ebab5',
    brief: `THIS IS A CLOSE-OUT, NOT A REBUILD, AND YOUR FIRST JOB IS TO MEASURE RATHER THAN BUILD.

420ebab5 has been built across FOUR rounds (r253 personnel-row, r254/r255 personnel-save, r256
personnel-tabs) and has never been closed. Much of the approved plan at ${PLANS}/420ebab5.txt is already
SHIPPED on main. Measured before this brief was written:
  · Part 1, the clickable row — SHIPPED. app/admin/personnel/employee-row.tsx, a per-CELL transparent
    link overlay (the positioning context is the <td>, never the <tr>, because WebKit computes
    position:relative on a row as static). Read its header before touching anything near it.
  · The classification of all 35 forms into (a) field edits and (b) child-record lifecycle — WRITTEN,
    at docs/audits/420ebab5-personnel-save-classification.md.
  · Consolidated per-tab save — FIVE tabs are wired through one shared runTabSave:
    PROFILE, BANK_STATUTORY, ATTENDANCE, JOB and PAYROLL (lib/personnel-tab-sections.ts orders,
    app/admin/personnel/[employmentId]/actions.ts save*TabAction).
  · The unsaved-changes guard — lib/unsaved-changes.ts, a module-level registry joining two client
    islands that React context cannot.
  · The before/after change summary — lib/tab-save-dom.ts diffTab returns every field whose submitted
    value differs from the snapshot, with labels and before/after.
  · The r255 money defect — FIXED: a lone Statutory save no longer invents is_resident=false and move
    the employee onto flat-rate PCB. Residency now comes from the stored row.

SO YOUR TASK IS: read the approved plan promise by promise, check each against what is actually on main,
and CLOSE THE GAPS. Report the audit as your "built" entries with evidence, and put anything still
outstanding in "notBuilt" with a plain reason. DO NOT REBUILD WHAT IS ALREADY THERE — re-implementing a
shipped behaviour is how this repo goes backwards, and it is why this item has stayed open.

THE THINGS MOST LIKELY STILL OPEN — verify each, and fix only what is genuinely missing:
  · The plan promises the prompt offers SAVE, DISCARD or CANCEL, and that "Discard puts the information
    back to the last saved version". Check Discard actually restores to the last SAVED snapshot, not to
    the initial page render, after a successful save has moved the baseline.
  · The plan promises leaving THE SCREEN (not only the tab) with unsaved changes asks first. An in-app
    Link is a client-side navigation that beforeunload never sees — check both paths.
  · Bucket (b) MUST NOT be captured by the tab's Discard. Pin it: a test that records a compensation
    revision, then presses tab-Discard, and asserts the revision SURVIVES. AGENTS 28's principle — a
    control that appears to do something it does not is worse than an absent one, and a Discard that
    appeared to cover a salary revision would be exactly that.
  · r255's verify pass reported the Employment tab's save bar rendering in the MIDDLE of the tab, above
    two editable cards it does not cover, and the Attendance tab's reading order reversing item
    52a30630's "Holiday Calendar pinned first". Check whether both were actually fixed; if not, fix them
    and ADD THE GUARD for the ordering so the next round cannot repeat it.

SCOPE FENCES, and they are hard because two other agents are working beside you:
  · DO NOT TOUCH app/admin/personnel/import/** or lib/import-schema.ts — another agent owns the importer
    this round.
  · DO NOT TOUCH app/admin/personnel/new/** (the draft wizard) or app/me/** — those are 759dfc7d and
    9583deac, which are NOT being built this round.
  · DO NOT TOUCH core/leave-*.
  · No new migration.`,
  },
  {
    slug: 'import-sections',
    ns: 'r257imp',
    item: '2983802f',
    brief: `YOUR APPROVED PLAN IS AT ${PLANS}/2983802f.txt AND IT OPENS WITH A CORRECTION TO THE
REPORTER. Read it: two of the things the request called missing already exist, and the plan says so with
measurements. Do not rebuild them.

ALREADY THERE, MEASURED, DO NOT REDO:
  · lib/import-schema.ts IMPORT_COLUMNS is 6 required + 43 optional = 49 main-sheet columns, including
    passport (4), address (7), emergency contact (5), probation (4), notice period (2) and direct
    superior. Plus the FAMILY SHEET (import-schema.ts, "THE FAMILY SHEET"), keyed to the employee row.
  · Multi-company in one file: the "company" column has been optional-per-row since d8471481, resolving
    by legal name / label / registration number, with department, position and cost centre checked
    against THAT row's company. The preview already shows which company each row resolved to.

WHAT IS GENUINELY NEW, and it is the whole job:

1. PER-SECTION TEMPLATES. The import screen gains a first step: choose what you are importing. Each
   choice downloads its own template carrying only that section's columns. The sections are PROFILE,
   EMPLOYMENT, BANK AND STATUTORY, and FAMILY. The preview must know which section it is validating.

2. UPDATE-EXISTING BY employee_code — today the importer ONLY creates. This is the risky half:
   · An explicit per-row CREATE-vs-UPDATE verdict shown in the preview BEFORE anything is written.
   · ⚠️ A BLANK CELL MEANS "LEAVE THIS AS IT IS", NEVER "CLEAR IT". A wide file that nulled omitted
     columns would silently wipe data across many employees at once, and that is the single most
     expensive way this feature can fail. Pin it with a test that imports a Bank and Statutory file for
     an existing employee and asserts their ADDRESS is untouched.

3. SECTION FENCES: decide, and enforce, what a section file may NOT touch — a Bank and Statutory import
   must not reach a Profile field even if the column is present in the sheet. Enforce it server-side,
   not only by which columns the template ships with, because the file is user-supplied.

DELIBERATELY DECLINED, AND THE REPORTER HAS BEEN TOLD WHY — DO NOT ABSORB THEM:
ATTENDANCE, LEAVE and CAREER MOVEMENT. They are transaction records, not employee information, and carry
their own period/approval/immutability rules (a closed payroll period, an approved leave request, a
recorded movement). The plan tells the reporter they need their own design and their own conversation.
If you find yourself adding any of the three, stop.

ALSO PROMISED: errors continue to be reported by row, field and reason, as they are today; and the new
per-section flow is built ALONGSIDE the existing wide template — the reporter was promised they are
"never without a working import", so do NOT delete the current template in this round.

SCOPE FENCE: app/admin/personnel/import/**, lib/import-schema.ts, and any new lib/ file you need.
DO NOT TOUCH app/admin/personnel/[employmentId]/** or app/admin/personnel/page.tsx — another agent is
consolidating that screen this round. DO NOT TOUCH app/admin/personnel/new/** or app/me/**.
No new migration; if you think you need one, stop and say so in notBuilt.`,
  },
];

// ⚠️ THE VERIFY STAGE MUST NOT BRANCH ON THE BUILDER'S SELF-REPORTED `slug`, AND THIS IS WHY.
// The first r257 run did exactly that. The build agents each returned slug = 'r257-<name>' (they read it
// off their branch) rather than the '<name>' the parent had in WORK, so `build.slug === 'leave-replay'`
// was false for all three, every verifier was handed the IMPORT plan, and `${WT}/r257-${build.slug}`
// resolved to `/…/r257-r257-leave-replay`, a path that does not exist. Two of the three verify passes
// were therefore reading the wrong item's promises — and "diff the approved plan against what shipped"
// is the step that catches an unmet promise to the reporter.
// The closure below captures `w` from WORK, which the parent controls. Never re-derive a control-flow
// value from an agent's echo of it.
const results = await pipeline(
  WORK,
  (w) =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${WT}/r257-${w.slug}
YOUR BRANCH:   r257/${w.slug}
YOUR TEST_DB_NAMESPACE: ${w.ns}
BOARD ITEM:    ${w.item}
APPROVED PLAN: ${PLANS}/${w.item}.txt   <- read it before you write code (AGENTS 29)

${w.brief}`,
      { label: `build:${w.slug}`, phase: 'Build', schema: BUILD_SCHEMA },
    ),
  (build, w) =>
    agent(
      `ADVERSARIALLY VERIFY the branch r257/${w.slug} in ${WT}/r257-${w.slug}.

A GREEN BUILD IS NOT EVIDENCE THE WORK IS RIGHT. r209 built eleven items as seven workstreams; all seven
reported tsc-clean and test-green, and the verify pass found 19 majors, 13 of them introduced by the
build itself. Across r253/r254/r255 nearly every workstream built green and most were still wrong. You
are the load-bearing step.

THE BUILDER'S OWN REPORT (treat as a claim to be checked, never as fact):
${JSON.stringify({ built: build.built, notBuilt: build.notBuilt, risks: build.risks, nonVacuityProof: build.nonVacuityProof, filesTouched: build.filesTouched }, null, 1)}

APPROVED PLAN: ${PLANS}/${w.item}.txt

DO THESE, IN THIS ORDER:
1. RE-DERIVE THE NON-VACUITY CLAIM YOURSELF. Do not trust nonVacuityProof. Take a "cp" copy of the file,
   revert the fix by hand, run the named test, WATCH IT FAIL, restore from your copy. NEVER use
   "git checkout --" for this: it reverts to HEAD and has destroyed a release's uncommitted work.
   Report what you actually observed in nonVacuityRederived. This instruction is what finds the defects
   builders sincerely believe they have tested.
2. READ THE APPROVED PLAN AND THE DIFF SIDE BY SIDE. Anything the plan promised the reporter that the
   diff does not deliver is a finding, even if the builder listed it in notBuilt — the reporter is owed
   the truth about their own approved plan.
3. HUNT FOR WHAT THE BUILD BROKE, not only for what it failed to do. Set introducedByThisBranch honestly;
   a pre-existing defect you find is still worth reporting, but it must be labelled as such.
4. Run the branch's targeted tests yourself with TEST_DB_NAMESPACE=${w.ns}v. Targeted only.

Put "cd <worktree> &&" in every command. Judge severity by consequence: a blocker is wrong money, lost
data, or a promise to the reporter that is silently unmet; a major is a real defect a user will hit.
Say "ship" only if you would put your own name on it.`,
      { label: `verify:${w.slug}`, phase: 'Verify', schema: VERIFY_SCHEMA },
    ).then((v) => ({ ...build, verify: v })),
);

const done = results.filter(Boolean);
log(`r257: ${done.filter((r) => r.committed && r.tscClean).length}/${WORK.length} committed clean`);
for (const r of done) {
  const f = r.verify?.findings ?? [];
  log(`  ${r.slug}: ${r.verify?.verdict} — ${f.filter((x) => x.severity === 'blocker').length} blocker, ${f.filter((x) => x.severity === 'major').length} major, ${f.filter((x) => x.severity === 'minor').length} minor`);
}

return {
  workstreams: done.map((r) => ({
    slug: r.slug,
    committed: r.committed,
    commitSha: r.commitSha,
    tscClean: r.tscClean,
    testsPass: r.testsPass,
    filesTouched: r.filesTouched,
    built: r.built,
    notBuilt: r.notBuilt,
    risks: r.risks,
    verdict: r.verify?.verdict,
    findings: r.verify?.findings,
    nonVacuityRederived: r.verify?.nonVacuityRederived,
  })),
};

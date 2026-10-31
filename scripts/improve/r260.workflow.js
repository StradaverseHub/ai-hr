export const meta = {
  name: 'r260-build-verify',
  description: 'Leave Configuration Round 4 (approval chains + tab 5 read-out) and My Profile stage two (change requests)',
  phases: [{ title: 'Build' }, { title: 'Verify' }],
};

// AGENTS 35: the verify stage closes over the parent's own WORK entry — (build, w) — and never
// re-derives a path or an item id from the builder's echoed slug.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r260plans';

const COMMON = `
ENVIRONMENT — read this before your first command.

- Put "cd <your worktree> &&" in EVERY bash command, including read-only greps. The shell's cwd resets
  between calls and the repo ROOT is a STALE scratch tree far behind main. Prove your tree first:
  cd <wt> && pwd && git rev-parse --abbrev-ref HEAD
- Export your TEST_DB_NAMESPACE in every test command. TARGETED TESTS ONLY, never the full suite.
  Redirect to a log and READ it: exit code AND file count. Never pipe a long command.
- ⚠️ RUN EVERY DIRECTORY-WALKING GUARD THAT COULD SEE YOUR NEW FILES, and NAME them in "guardsRun".
  Last round a build reported "every directory-walking guard green" while test/leave-pack-drift.test.ts
  was RED and had never been run. A guard you did not run is not a guard you passed. At minimum:
  function-access, server-client-boundary, rsc-boundary-guard, i18n-coverage, today-in-myt-drift,
  module-catalog-drift, system-explorer, and the pack-drift ratchet for any pack you import.
- ⚠️ THE LOCAL CLUSTER IS ON DISK: AIHR_RAMDISK_GB=0 ./scripts/dev-db-rebuild.sh if you must rebuild.
- npx tsc --noEmit clean before committing. Commit on YOUR branch. Never amend, rebase or git stash.
- i18n: EVERY new key in ALL SIX locales with REAL translations, never English copied through.
- ⚠️ A 200 IS NOT A RENDER CHECK. Run a dev server, load each new page, READ THE DEV LOG, and prove the
  page rendered its own DOM with a probe for a element you know is on it — not by the status code and
  not by the byte count. Say all of that in "renderChecked".
- Dates: never the argless new Date().toISOString().slice(0, 10) — a UTC date names YESTERDAY between
  00:00 and 08:00 MYT. Use todayInKualaLumpur() from lib/hr-date. A guard turned a gate red on this.
- Any test you add or change must be NON-VACUOUS: revert the SHIPPED behaviour from a cp copy (never
  "git checkout --"), watch the named assertion FAIL, restore. Say which shipped line you broke.

REPORT WHAT YOU DID NOT DO in "notBuilt", in plain words. A stated shortfall is acceptable; a silent one
is not.
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
    guardsRun: { type: 'array', items: { type: 'string' } },
    filesTouched: { type: 'array', items: { type: 'string' } },
    built: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['what', 'evidence'],
        properties: { what: { type: 'string' }, evidence: { type: 'string' } },
      },
    },
    notBuilt: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['what', 'why'],
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
        type: 'object', additionalProperties: false,
        required: ['severity', 'claim', 'evidence', 'introducedByThisBranch'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          claim: { type: 'string' }, evidence: { type: 'string' },
          introducedByThisBranch: { type: 'boolean' }, file: { type: 'string' },
        },
      },
    },
    nonVacuityRederived: { type: 'string' },
  },
};

const WORK = [
  {
    slug: 'leave-round4',
    ns: 'r260leave',
    item: 'a6fe37fc',
    brief: `YOU ARE BUILDING ROUND 4 ONLY. READ docs/design/a6fe37fc-migration-order.md "Round 4" IN FULL
FIRST, plus IA docs/design/a6fe37fc-leave-config-ia.md §4.1 and §6.4. Rounds 1-3 are built and DEPLOYED:
the replay harness, /admin/leave-config/types (five tabs), and the seven Round 3 screens. Read the Round 3
pages — they are the pattern, including how routes register and how the area map and preview note work.

⚠️ THIS ROUND STILL ADDS AND REMOVES NOTHING. The ten old screens stay live and stay what the menu links
to; that is Round 5. NO MIGRATION — if you think you need a column, STOP and say so in notBuilt.

WHAT TO BUILD, two things:

1. app/admin/leave-config/approval-chains/page.tsx — templates, assignment and escalation as today,
   MOUNTING the same shared components the old approval screen mounts.
   ⚠️ PLUS THE THING THAT IS SHOWN NOWHERE TODAY: a READ-ONLY list of the approval rules that are NOT
   built from a template, showing their business unit / department / position scope and their effective
   chain. Those columns are STORED, are READ by resolveApprovalChain, DECIDE WHO APPROVES, and have been
   invisible since 706d34e8 removed the only surface that displayed them (IA §4.1). This is the round
   that gives them back a surface.
   ⚠️ THE PERMISSION EXCEPTION: this page attaches to the leaveApproval screen key and keeps
   scopedSession — NOT leaveConfig, NOT requireAdmin. IA §6.4: a company-scoped admin must keep seeing
   only their own companies. Every other Round 3 page went on leaveConfig; this one does not. Get it
   right and say you checked.

2. TAB 5 on /admin/leave-config/types — the read-out Round 2 deferred: which chain reaches this leave
   type, its ordered steps, the escalation. READ-ONLY, linking to Approval chains to change anything.
   Round 2's Tab 5 is currently the per-date-approval setting only; this adds the read-out beside it.

⚠️ A GUARD'S CASE MUST BE CARRIED, NOT DELETED (AGENTS 18). test/leave-approval-page-restructure.test.ts
asserts <WorkflowMatrix is ABSENT from the approval page. It STAYS absent, and the assertion is
re-pointed at the new page rather than removed. Write the new reasoning into the case explicitly: what
706d34e8 removed was a second EDITOR over rows the assignment section already maintains; a READ-ONLY
read-out of a column that routes live requests is not that editor. Say it in the test so the next reader
does not re-delete the read-out as a regression.

⚠️ THE REPLAY IS PART OF THIS ROUND'S EVIDENCE. A read-only view changes no rule, so the expected result
is ZERO differences. Run it against the seeded local cluster before and after your change:
  AIHR_RAMDISK_GB=0 TEST_DB_NAMESPACE=<yours> npx vitest run test/leave-approval-replay.test.ts
and say the result. Do NOT run it against production — that is the parent's, and only with the committed
baseline at docs/baselines/a6fe37fc-approval-baseline.json.

CARRY FORWARD: every sub-form keeps its tri-state marker and hidden name; put <LeaveConfigMap> and the
preview note on the new page as Round 3 does; cross-screen links resolve through leaveConfigScreenHref
(components/leave-config-map.tsx) rather than hard-coded hrefs — a guard walks the module and enforces it.

SCOPE FENCE: app/admin/leave-config/** , lib/permissions.ts (routes only), your tests, six locales.
Do NOT touch app/admin/leave/**, app/admin/leave-approval/**, components/leave-type-panel.tsx,
core/leave*, or app/me/** (another agent is there).`,
  },
  {
    slug: 'profile-requests',
    ns: 'r260profile',
    item: '9583deac',
    brief: `YOU ARE BUILDING STAGE TWO ONLY of ${PLANS}/9583deac.txt. Stage one shipped in r259 — My
Profile now renders the Personnel record's six tabs as a READ surface, with docs/me-profile-field-
visibility.md as its written account. READ BOTH before you start, and read app/me/record.ts: it projects
exactly what an employee may see and a guard now runs Personnel -> /me so a field cannot appear on one
and not be accounted for on the other.

⚠️ STAGE THREE IS NOT YOURS. Do not build the field-by-field permission SETTING or the approver-choice
setting. Stage two is "asking for a change", and the plan tells the reporter stage three follows.

⚠️ THE MECHANISM ALREADY EXISTS AND YOU ARE EXTENDING IT, NOT INVENTING IT. Our own earlier build note
wrongly said stage two needed a request store; the correction is at the top of the approved plan and you
must not contradict it. db/schema.ts:4659 profile_change_request already holds tenant, employment,
person, proposed jsonb, a status enum, decided_by_employment_id and decided_at, and core/profile.ts
implements ADR-0012's two paths by risk: low-risk contact fields self-edit under RLS; pay-affecting
fields (bank, dependants, PCB category) raise a request an admin approves through assertCanDecide.

WHAT STAGE TWO IS, in the plan's own words to the reporter:
  · The existing request-and-approve path is WIDENED to the other fields you allow, instead of only bank
    details, family and PCB category. Which fields those are is a stage-three SETTING — for now, widen to
    a declared set and name it in one place, keyed by the same field keys the visibility manifest uses so
    a permission and a request can never disagree about what a field is called.
  · A field with a request waiting shows BOTH values — what it is now and what was asked for — so nobody
    is confused about which one is real. The MASTER value is what the record shows; the request is drawn
    beside it, never in place of it.
  · REJECTING ASKS FOR A REASON, and the reason is stored and shown to the employee. ⚠️ THIS IS THE ONE
    THING THAT GENUINELY DOES NOT EXIST: there is no reason column on profile_change_request and no
    reason parameter in core/profile.ts.
  · The employee can see the status of their own requests: waiting, approved or rejected.

⚠️ YOUR MIGRATION NUMBER IS 0458 AND IT WAS ALLOCATED CENTRALLY — do not pick your own, and do not use
any other number. You are the only branch this round with a migration. Rules that have cost this repo a
round each: a migration is a journal entry, not just a .sql file; APPEND to the journal, never re-sort it;
and if the table needs new privileges say so (this is an ALTER on an existing table, so it inherits the
grants and the row policies it already has — state that in a comment rather than leaving it unsaid).

THE SAFETY PROPERTY OF THE WHOLE CHANGE: a pending request MUST NEVER reach the master record without a
decision, and a rejected one must never be applied at all. Pin it with a test that raises a request,
rejects it with a reason, and asserts the master column is byte-identical to before.

SECURITY, same as stage one: every read and write scoped to the caller's own employment through the
session, never through a client-supplied id. An employee must not be able to see or decide anybody
else's request. Test it adversarially.

SCOPE FENCE: app/me/**, core/profile.ts, db/schema.ts + db/migrations (0458 only), the admin approval
surface for these requests, your tests, docs/, six locales. Do NOT touch app/admin/leave-config/**
(another agent is there), core/payroll.ts, or app/admin/personnel/[employmentId]/**.`,
  },
];

const results = await pipeline(
  WORK,
  (w) =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${WT}/r260-${w.slug}
YOUR BRANCH:   r260/${w.slug}
YOUR TEST_DB_NAMESPACE: ${w.ns}
BOARD ITEM:    ${w.item}
APPROVED PLAN: ${PLANS}/${w.item}.txt   <- read it before you write code (AGENTS 29)

${w.brief}`,
      { label: `build:${w.slug}`, phase: 'Build', schema: BUILD_SCHEMA },
    ),
  (build, w) =>
    agent(
      `ADVERSARIALLY VERIFY the branch r260/${w.slug} in ${WT}/r260-${w.slug}.

A GREEN BUILD IS NOT EVIDENCE THE WORK IS RIGHT. Last round a build reported every directory-walking
guard green while one was RED and had never been run, and the round before that two blockers were found
in work that was tsc-clean and test-green. You are the load-bearing step.

THE BUILDER'S OWN REPORT (a claim to be checked, never a fact):
${JSON.stringify({ built: build.built, notBuilt: build.notBuilt, risks: build.risks, renderChecked: build.renderChecked, guardsRun: build.guardsRun, nonVacuityProof: build.nonVacuityProof, filesTouched: build.filesTouched }, null, 1)}

APPROVED PLAN: ${PLANS}/${w.item}.txt

DO THESE, IN ORDER:
1. RE-DERIVE THE NON-VACUITY CLAIM YOURSELF from a cp copy, never "git checkout --". Report what you saw.
2. ⚠️ RUN THE GUARDS THE BUILDER SAYS IT RAN, PLUS THE ONES IT DOES NOT MENTION. Enumerate the
   directory-walking guards yourself (grep test/ for ones that read app/ or components/) and run every
   one that could see the new files. Report any the builder claimed but did not run.
3. READ THE APPROVED PLAN AND THE DIFF SIDE BY SIDE. A promise the diff does not deliver is a finding
   even if the builder listed it in notBuilt.
${w.item === 'a6fe37fc'
  ? `4. ⚠️ COMPARE THE NEW APPROVAL PAGE AGAINST THE OLD ONE IT SHADOWS, not against a design table — one of
   those was found TWO FUNCTIONS SHORT two rounds ago, so a table-keyed check inherits its gaps.
5. ⚠️ CHECK THE PERMISSION EXCEPTION. This page must attach to leaveApproval with scopedSession, NOT to
   leaveConfig with requireAdmin like the Round 3 pages. Getting that wrong widens who can see other
   companies' approval configuration. Verify it in lib/permissions.ts AND by reasoning about the guard.
6. Run the replay yourself against the seeded cluster. A read-only view changes no rule, so ANY routing
   difference means something in the round did more than it said.`
  : `4. ⚠️ THE BLOCKER THIS ITEM CAN PRODUCE IS A PENDING OR REJECTED REQUEST REACHING THE MASTER RECORD.
   Raise a request, reject it, and prove the master column did not move. Then approve one and prove it
   did. Then try to decide somebody else's request as an ordinary employee, and to read one.
5. ⚠️ CHECK THE MIGRATION IS 0458, that it is a journal ENTRY and not just a .sql file, that the journal
   was APPENDED and not re-sorted, and that it applies to a table that already has rows.
6. Check both values are shown for a pending field — master AND requested — and that the MASTER is what
   the record reports, never the pending value.`}
6. VERIFY THE RENDER CHECK WAS REAL: run the dev server yourself, load the pages, read the log.
7. Run the branch's targeted tests with TEST_DB_NAMESPACE=${w.ns}v.

Put "cd <worktree> &&" in every command. A blocker is wrong money, lost or leaked data, or a promise to
the reporter silently unmet. Say "ship" only if you would put your own name on it.`,
      { label: `verify:${w.slug}`, phase: 'Verify', schema: VERIFY_SCHEMA },
    ).then((v) => ({ ...build, slug: w.slug, item: w.item, verify: v })),
);

const done = results.filter(Boolean);
log(`r260: ${done.filter((r) => r.committed && r.tscClean).length}/${WORK.length} committed clean`);
for (const r of done) {
  const f = r.verify?.findings ?? [];
  log(`  ${r.slug}: ${r.verify?.verdict} — ${f.filter((x) => x.severity === 'blocker').length}B ${f.filter((x) => x.severity === 'major').length}M ${f.filter((x) => x.severity === 'minor').length}m`);
}
return { workstreams: done };

export const meta = {
  name: 'r263-fix-verified',
  description: 'One fix pass over the r263 verify findings; the parent hand-checks after',
  phases: [{ title: 'Fix' }],
};

// AGENTS 23b: ONE fix pass, then hand-fix.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r263plans';
const FIND = '/tmp/r263fix';

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
    slug: 'sched-assign',
    ns: 'r263assignf',
    item: 'a485afa1',
    extra: `⚠️ MAJOR 1 — A MALFORMED QUERY PARAMETER CRASHES THE PAGE. \`?assign=not-a-uuid\` returns
HTTP 500: the raw value reaches \`eq(employment.id, …)\` on a uuid column before any validation, so
Postgres throws "invalid input syntax for type uuid" and your own \`panelMissing\` branch — written for
exactly this case, "a stale bookmark" — never runs. A well-formed-but-unknown uuid is handled correctly
and renders "That employee is no longer on this list."; only a malformed one crashes. It was the ONLY 500
in a 76-line dev log across ~35 requests. Validate the shape before it reaches the query, and make the
existing panelMissing branch handle it. Pin it with a case that requests a malformed value and asserts
the page renders rather than throws.

⚠️ MAJOR 2 — REMOVE IS ONE CLICK, UNCONFIRMED, AND IRREVERSIBLE FOR ANY PERIOD THAT IS NOT THE NEWEST.
Your notBuilt justified shipping without a confirmation by saying removal "is recoverable … saving that
date again re-creates it". The verifier proved that is FALSE for middle periods: after removing the
middle of a three-period ladder, re-posting the identical save is refused with ShiftBackInsertError —
back-insert is explicitly out of scope for v1 — so the removal cannot be undone at EITHER door. Only the
newest period is re-creatable, which is presumably the case you tested.
Nothing is destroyed at row level (superseded, plus a DomainEvent) and the ladder stays coherent, so this
is not lost data — but a mis-click on an older history row permanently reverts a schedule change.
EITHER add the confirmation, OR restrict Remove to the newest period (the only one that is genuinely
recoverable) and say so on screen. Whichever you choose, CORRECT THE NOTE — the claim that removal is
recoverable must not survive in the code or the report.

THEN THE MINORS, and two of them are about honesty rather than behaviour:
- A malformed employmentId posted to the save action reflects RAW DRIZZLE SQL — table name, column list,
  bound parameters — into the on-screen error banner. Pre-existing (the personnel card does the same and
  you mirrored it faithfully), but this is an HR product: map it to a message that names the field
  without echoing the statement. Fixing it only at the new door is acceptable; say so.
- ⚠️ A SENTENCE THE REPORTER WILL READ IS WRONG AFTER THIS SHIPS. The approved plan says "Adding and
  removing a schedule arrangement are done from this screen as well, not only from Personnel Management",
  which tells them removal ALREADY exists in Personnel Management. It does not, and does not gain it
  here. Put the correction in "reporterOwed" in plain words — the parent will carry it to the board.
- The scope fence said app/admin/attendance/schedule-assignment/** and the diff adds 124 lines to the
  shared core/shift-arrangement.ts. The new writer is defensible — the alternative was a second writer,
  which the plan forbids — but say it plainly in "remaining" rather than leaving it unremarked.
- The test file now carries FILE-LEVEL vi.mock of ../lib/authz, next/cache, next/navigation and
  next-intl/server, with beforeAll/afterAll hoisted to module scope. Any describe added later silently
  inherits a fake requireAdmin. Write that into the file's header so the next author is not caught.
- Clean up after yourself: the local dev database is left carrying fabricated shift ladders from two
  rounds of render checking, including a superseded 2026-10-01 period on EMP-0001.

SCOPE FENCE unchanged: app/admin/attendance/schedule-assignment/**, core/shift-arrangement.ts, your
tests, six locales. Do NOT touch app/admin/personnel/** and do NOT touch packs/attendance/index.ts —
the other agent owns that file this round.`,
  },
  {
    slug: 'sched-config',
    ns: 'r263configf',
    item: '1c5602cc',
    extra: `⚠️ YOUR MAJOR IS THAT THE PLAN'S HEADLINE CLAIM IS FALSE — AND IT IS THE PARENT'S ERROR, NOT
YOURS. The approved plan says a menu row named "Work Schedule" opens a page named "Shift settings". THE
PARENT HAS RE-CHECKED AND THE VERIFIER IS RIGHT: app/admin/attendance-policy/schedule/page.tsx:120-122
renders PageHeader title={tr('scheduleSectionTitle')}, NOT admin.attendancePolicy.pageTitle. That
"Shift settings" string is the H1 of app/admin/attendance/page.tsx:54 — the row labelled "Shift". The
parent grepped the namespace and never checked which page rendered it.

WHAT YOU MUST DO:
  1. REMOVE THE FALSE CLAIM FROM THE CODE. packs/attendance/index.ts:288-289 now carries it as a
     recommendation for the cutover round to act on. A wrong comment outlives a wrong line of code, and
     this one would send a future round to rename a page that is already named correctly.
  2. Replace it with what IS true and is the substantive point: the existing Work Schedule screen
     already holds backup shift coverage, overtime rates, the per-company attendance policy and
     registered clocking devices — material belonging to the Overtime and Attendance tabs. That part was
     verified and stands.
The parent is separately carrying the correction to the reporter (AGENTS 31).

THEN THE MINORS:
- A PLAN PROMISE THE DIFF DOES NOT DELIVER: the plan's GOOD TO KNOW told the reporter the overtime hour
  cap was among the things "already recorded somewhere" this tab would give "one home". The General tab
  shows no figure, only a sentence pointing at Payroll. Your justification checks out and it is disclosed
  on screen — but put it in "reporterOwed" so they are told rather than left to notice.
- YOUR OWN RISK NOTE STATES THE OPPOSITE OF WHAT THE CODE DOES. It says "an administrator with a narrow
  scope sees only their companies' working weeks"; the page seeds getScopeIds from listCompanies
  (TENANT-wide), so a company-scoped hr_admin sees every company. This is NOT new exposure — the existing
  Work Schedule screen uses the identical pattern over the identical data — but a false note is a trap.
  Correct it, and state the actual behaviour.
- The "Not configured here" card has no staleness guard: it is honest today and becomes wrong the moment
  rotation storage or a relocated OT cap ships, and nothing fails. Add a guard that ties the card to the
  absence it claims, or say in "remaining" why it cannot be tied.

⚠️ MERGE HAZARD THE PARENT WILL HANDLE, do not work around it: both r263 branches were briefed to edit
packs/attendance/index.ts. Keep your change to the ONE import and the ONE nav row so the union resolves
cleanly.

SCOPE FENCE unchanged: app/admin/attendance/schedule/**, packs/attendance/index.ts, lib/permissions.ts,
your tests, six locales. Do NOT touch app/admin/attendance/schedule-assignment/** or
app/admin/attendance-policy/**.`,
  },
];

const fixes = await parallel(
  WORK.map((w) => () =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${WT}/r263-${w.slug}
YOUR BRANCH:   r263/${w.slug}
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

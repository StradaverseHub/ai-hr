export const meta = {
  name: 'r263-build-verify',
  description: 'Schedule Assignment edited in place, and the new Attendance Schedule screen (General tab only)',
  phases: [{ title: 'Build' }, { title: 'Verify' }],
};

// AGENTS 35: the verify stage closes over the parent's own WORK entry — (build, w) — and never
// re-derives a path or an item id from the builder's echoed slug.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r263plans';

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
    slug: 'sched-assign',
    ns: 'r263leave',
    item: 'a485afa1',
    brief: `YOUR APPROVED PLAN IS AT ${PLANS}/a485afa1.txt. Read it first — its business half is a
promise to the reporter and its build notes carry the measurements.

THE PREMISE IS CONFIRMED, NOT CORRECTED. app/admin/attendance/schedule-assignment/page.tsx (229 lines)
lists employees with columns Employee ID · Name · Company · Shift Type · Backup Shift · Effective From ·
Status, and its ONLY row action at :210-216 uses editHref built at :145 as
\`/admin/personnel/\${employmentId}?tab=attendance#section-default-shift\` — so View/Edit leaves the
Attendance module entirely.

WHAT IS ON THE OTHER END, and it is why this is Moderate rather than Large:
app/admin/personnel/[employmentId]/page.tsx:2235, card id="section-default-shift", is a form posting
setDefaultShiftAction over components/employee-shift-fields.tsx — THREE controls: shiftType (select),
shiftId i.e. the backup shift (select), effectiveFrom (date) — plus a read-only shiftArrangementHistory
table.

WHAT TO BUILD:
  · An edit panel on the Schedule Assignment screen itself, carrying those SAME three fields and Save.
  · The previous-arrangements history shown there too.
  · Add and remove a schedule arrangement from this screen as well.
  · REMOVE the redirect into Personnel Management.

⚠️ MOUNT components/employee-shift-fields.tsx — DO NOT FORK IT, and do not write a second writer.
core/shift-arrangement.ts already exports assignEmployeeShiftDated, shiftArrangementHistory and
listShiftArrangements. The plan promises the reporter the two screens "cannot drift apart" because they
are "two doors onto one record" — a forked field list or a second writer would make that sentence false,
and it is the sentence they will judge this by.

⚠️ EFFECTIVE DATING IS THE PART TO GET RIGHT. assignEmployeeShiftDated CLOSES and INSERTS a version
rather than updating in place (ADR-0001/0003). Call it exactly as the Personnel card does — same
arguments, same effective-date semantics. Pin it with a test that saves from the NEW screen and asserts
the history row it produces is identical in shape to one saved from Personnel.

⚠️ SCOPE FENCE, AND IT IS HARD: DO NOT EDIT app/admin/personnel/[employmentId]/page.tsx. The plan tells
the reporter Personnel Management KEEPS its copy — "you asked for a second entry point, not for the first
one to be taken away". Removing or altering that card would break the promise and collide with nothing
else this round is doing. Also do NOT touch packs/attendance/index.ts: Schedule Assignment already has
its nav row, and the other agent this round owns that file.

Permissions: the screen already exists and is already registered, so no new route is expected. If you add
a sub-route, it needs its lib/permissions.ts entry in the SAME commit (test/function-access.test.ts fails
both ways) — but check first whether you need one at all.

NO MIGRATION. RENDER CHECK MANDATORY: load /admin/attendance/schedule-assignment on a dev server, open
the panel, read the dev log, and probe the DOM for the three field names.`,
  },
  {
    slug: 'sched-config',
    ns: 'r263profile',
    item: '1c5602cc',
    brief: `YOUR APPROVED PLAN IS AT ${PLANS}/1c5602cc.txt AND IT OPENS WITH A CORRECTION TO THE
REPORTER. Read it before you write anything — you must not contradict it.

THE CORRECTION, MEASURED: Attendance ALREADY has a menu row labelled "Work Schedule"
(packs/attendance/index.ts:279 → /admin/attendance-policy/schedule), and the screen it opens is headed
"Shift settings". That screen ALREADY holds material belonging to the reporter's proposed tabs: backup
shift coverage (:129), overtime rates (:150), the per-company attendance policy (:196) and registered
clocking devices (:307). So this is partly a REORGANISATION, not purely a new build.

⚠️ ONLY THE GENERAL TAB IS IN SCOPE. The other five — Holiday, Overtime, Attendance, Request,
Notification — ship as NAMED, EMPTY tabs so the shape is visible and nobody wonders whether they were
forgotten. AGENTS 28: an empty named tab is honest; a placeholder implying a setting exists is worse than
an absent one. Do NOT draw a control for something nothing wires up.

WHAT TO BUILD: a new Schedule screen under Attendance, tabbed, with the General tab holding what governs
an employee's working pattern — which shifts are available, rest days and off days, working-hour limits,
how a rotation advances, exception conditions, and the Duty Roster controls.

⚠️ YOUR FIRST JOB IS AN AUDIT, NOT A SCREEN. Much of this is already stored and the plan says so. Before
building a control, find what backs it:
  · db/schema.ts:1287-1295 — day types are a CLOSED allow-list { offDay, restDay, publicHoliday,
    companyHoliday, shutdownDay }. offDay/restDay COLLAPSE to one non-working-weekday bucket, and
    companyHoliday/shutdownDay are STORED-BUT-INERT (their resolver is Phase B). Do NOT render an inert
    concept as though it works.
  · db/schema.ts:2506 maxHoursPerMonth — the OT hours cap (0/absent = no cap).
  · The shift library is /admin/attendance; the Duty Roster is components/roster-grid.tsx + app/roster.
Report the audit in "built": which concepts are stored, which are stored-but-inert, which do not exist.
THAT AUDIT IS A DELIVERABLE — the plan promises "where a setting genuinely does not exist yet we will say
so rather than draw a box that does nothing".

⚠️ NO MIGRATION IS EXPECTED. If the General tab needs a setting that is genuinely not stored, STOP and say
so in notBuilt rather than inventing a column. Do not pick a migration number.

FOLLOW THE a6fe37fc PLAYBOOK, which just shipped in five rounds and is the plan's stated model: build the
new screen ALONGSIDE — the existing Work Schedule row keeps working and is NOT moved or removed this
round. Register the new guarded page.tsx in lib/permissions.ts in the SAME commit
(test/function-access.test.ts fails both ways). NEVER rename a screen KEY — it may key stored role configs.

SCOPE FENCE: app/admin/attendance/schedule/** (new), packs/attendance/index.ts (the new nav row — you own
this file this round), lib/permissions.ts, your tests, six locales. Do NOT touch
app/admin/attendance/schedule-assignment/** (the other agent owns it), do NOT modify
app/admin/attendance-policy/schedule/** (it keeps working untouched), and only READ core/attendance.ts
and core/roster.ts.

RENDER CHECK MANDATORY: load the new screen on a dev server, read the dev log, and probe the DOM for each
tab name and at least one real control on General.`,
  },
];

const results = await pipeline(
  WORK,
  (w) =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${WT}/r263-${w.slug}
YOUR BRANCH:   r263/${w.slug}
YOUR TEST_DB_NAMESPACE: ${w.ns}
BOARD ITEM:    ${w.item}
APPROVED PLAN: ${PLANS}/${w.item}.txt   <- read it before you write code (AGENTS 29)

${w.brief}`,
      { label: `build:${w.slug}`, phase: 'Build', schema: BUILD_SCHEMA },
    ),
  (build, w) =>
    agent(
      `ADVERSARIALLY VERIFY the branch r263/${w.slug} in ${WT}/r263-${w.slug}.

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
${w.item === 'a485afa1'
  ? `4. ⚠️ THE PROMISE IS "TWO DOORS ONTO ONE RECORD". Prove it: save from the NEW screen, then read the
   value and the history from the PERSONNEL card, and vice versa. A forked field list or a second writer
   makes that promise false, and that is a blocker.
5. ⚠️ CHECK THE PERSONNEL CARD IS UNTOUCHED — the plan tells the reporter it keeps its copy. And check
   effective dating: a save must CLOSE and INSERT a version, never update in place.`
  : `4. ⚠️ CHECK NOTHING INERT IS DRAWN AS WORKING. companyHoliday/shutdownDay are stored-but-inert and
   offDay/restDay collapse to one bucket. A control that appears to set something it cannot is the
   failure this item can produce.
5. ⚠️ CHECK ONLY THE GENERAL TAB IS BUILT, that the other five are named and EMPTY rather than
   placeholder-filled, and that the existing Work Schedule screen still works untouched.`}
6. VERIFY THE RENDER CHECK WAS REAL: run the dev server yourself, load the pages, read the log.
7. Run the branch's targeted tests with TEST_DB_NAMESPACE=${w.ns}v.

Put "cd <worktree> &&" in every command. A blocker is wrong money, lost or leaked data, or a promise to
the reporter silently unmet. Say "ship" only if you would put your own name on it.`,
      { label: `verify:${w.slug}`, phase: 'Verify', schema: VERIFY_SCHEMA },
    ).then((v) => ({ ...build, slug: w.slug, item: w.item, verify: v })),
);

const done = results.filter(Boolean);
log(`r263: ${done.filter((r) => r.committed && r.tscClean).length}/${WORK.length} committed clean`);
for (const r of done) {
  const f = r.verify?.findings ?? [];
  log(`  ${r.slug}: ${r.verify?.verdict} — ${f.filter((x) => x.severity === 'blocker').length}B ${f.filter((x) => x.severity === 'major').length}M ${f.filter((x) => x.severity === 'minor').length}m`);
}
return { workstreams: done };

export const meta = {
  name: 'r259-build-verify',
  description: 'Leave Configuration Round 3 (the rest of the new module) and My Profile stage one',
  phases: [{ title: 'Build' }, { title: 'Verify' }],
};

// AGENTS 35: the verify stage closes over the parent's own WORK entry — (build, w) — and never
// re-derives a path or an item id from the builder's echoed slug.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r259plans';

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
    slug: 'leave-round3',
    ns: 'r259leave',
    item: 'a6fe37fc',
    brief: `YOU ARE BUILDING ROUND 3 ONLY. READ docs/design/a6fe37fc-migration-order.md "Round 3" IN FULL
FIRST, plus IA docs/design/a6fe37fc-leave-config-ia.md §2.0.3, §3.1 and §3.2. Rounds 1 and 2 are built
and DEPLOYED: the approval replay harness (do not touch core/leave-approval-*, scripts/replay-approval-
routing.ts or docs/baselines/) and app/admin/leave-config/types/ (read it — it is the pattern this round
follows, including how it registers its route and how it mounts shared components).

⚠️ THIS ROUND ADDS AND REMOVES NOTHING, exactly like Round 2. All seven pages are NEW page components
under /admin/leave-config. The ten old screens stay live and stay what the menu links to; that is Round
5. No migration — if you think you need a column, STOP and say so in notBuilt.

WHAT TO BUILD — seven pages:
  1. company-rules — THE ONE GENUINELY NEW SCREEN. It gathers four settings that belong to a COMPANY or
     the tenant and are today scattered across four surfaces: company half-day full deduction (today
     inside EVERY leave type's Condition step), company leave encashment policy (today on Payroll
     impact), per-company replacement-leave policy (today on Replacement leave), and tenant shared leave
     groups (today at the foot of the Leave types screen). Read IA §2.0.3 for why this screen exists.
  2-7. entitlement-tables · generate · adjustments · import · records/entitlement · records/balances —
     the six whose flows are NOT changing. Each MOUNTS THE SAME SHARED COMPONENTS its old page mounts.
     The page component is the only new thing. Do NOT re-implement a flow.

⚠️ THE PERMISSION COLUMNS ARE NOT OPTIONAL AND THEY LAND IN THE SAME COMMIT AS THE PAGES. Every new
guarded page.tsx needs its route in lib/permissions.ts or test/function-access.test.ts's reverse-
completeness case fails — a route nobody can grant or revoke. All SEVEN routes attach to the EXISTING
leaveConfig screen key, same requireAdmin guard, following the /admin/leave/generate precedent.

⚠️ THE SCREEN KEYS DO NOT CHANGE. lib/permissions.ts:107 records that a screen key "may key stored role
configs" — renaming leaveConfig would silently drop every tenant's existing grant for the whole area.
Only href and routes move, and not until Round 5.

THE SAME SETTING BEING EDITABLE ON TWO SCREENS DURING ROUNDS 3-4 IS DELIBERATE and is the price of
"something works at every point". Nothing is STORED twice: both editors write the same column through
the same action. Do not "fix" it by removing the old one.

CARRY FORWARD WHAT ROUND 2 LEARNED THE HARD WAY:
  · Every sub-form keeps its tri-state marker and its hidden name. A form that posts without its marker
    SAVES and WIPES the columns a neighbouring form owns. Nothing type-checks it.
  · The new leave-config directory is already declared in test/leave-pack-drift.test.ts ALWAYS_ALLOWED,
    so importing core/leave* from your new pages is fine — but RUN that guard and say you did. Never add
    anything to test/pack-drift-allowlist.json.
  · Round 2's anti-drop guard is keyed to IA §3's function table, and that table was found to be TWO
    FUNCTIONS SHORT (F47/F48, added last round). Before you claim a screen's functions are all carried,
    read the OLD page and compare it to the table — the table is not automatically right.
  · Put <LeaveConfigMap current="…" /> on each new page as Round 2 does, so the new screens can reach
    each other, and carry any data-tour anchor its old page has.

SCOPE FENCE: app/admin/leave-config/** (new), lib/permissions.ts (routes only), your new tests, and the
six locales. Do NOT touch app/admin/leave/**, components/leave-type-panel.tsx, core/leave*, app/me/**
(another agent is there), or app/admin/personnel/**.`,
  },
  {
    slug: 'my-profile',
    ns: 'r259profile',
    item: '9583deac',
    brief: `YOU ARE BUILDING STAGE ONE ONLY of ${PLANS}/9583deac.txt. Read the plan first — it opens with
a CORRECTION we made to the reporter and you must not contradict it.

⚠️ STAGE TWO AND STAGE THREE ARE NOT YOURS. Do not build request-a-change, do not build the approval
screen, do not build field-level permission settings, and do NOT add a migration. The plan tells the
reporter stage one is useful on its own and the later stages follow.

THE CORRECTION ALREADY MADE TO THE REPORTER, which you must build consistently with: a request-and-
approve path ALREADY EXISTS. db/schema.ts:4659 profile_change_request (tenant, employment, person,
proposed jsonb, status enum, decided_by_employment_id, decided_at) and core/profile.ts implement
ADR-0012's two paths by risk — low-risk contact fields self-edit the person record under RLS; pay-affecting
fields (bank, dependants, PCB category) raise a request an admin approves through assertCanDecide. Our
earlier build note wrongly said this had to be built. Do not build a second one, and do not remove it.

WHAT STAGE ONE IS:
  · My Profile is rebuilt with the SAME TABS and the SAME SECTION NAMES as Personnel Management:
    Profile, Employment, Bank and Statutory, Payroll, Family and Documents. Today app/me/page.tsx:234
    has five different ones (overview, profile, pay, performance, documents).
  · Full width, arranged in cards, so a section reads across the screen instead of being scrolled past.
  · Employees see ONLY their own record. There is no way to search for or open anybody else — assert it.

⚠️ IT IS A READ SURFACE THIS ROUND. Reuse the Personnel section components with an EMPLOYEE-SCOPED READ.
DO NOT FORK THEM — a fork is how the two screens drift apart again, which is the whole complaint. r258
just moved the DRAFT employee onto those same components (app/admin/personnel/new/wizard.tsx mounts
components/personnel-tabs.tsx), so there is now a worked example of a second consumer: read it.

⚠️ THE FIELD-VISIBILITY LIST IS A DELIVERABLE OF THIS ROUND, NOT AN IMPLEMENTATION DETAIL. The plan
promises the reporter: "The list of exactly which fields are hidden is written down and shown to you
before stage one is built, not decided as we go." So WRITE IT DOWN — a document under docs/ naming every
field an employee may NOT see and why (an employee has no business seeing their own cost centre or an
internal note, for instance). It is the difference between a self-service screen and a data leak. Put
the path in your report and list the omissions in "notBuilt" if any are uncertain.

SECURITY IS THE POINT OF THIS SCREEN. Every read must be scoped to the caller's own employment through
the session, never through a parameter the client can change. Pin it with a test that asserts another
employee's id cannot be reached, and check RLS is doing the work rather than a filter in the page.

RENDER CHECK MANDATORY: load /me on a dev server, read the dev log, and probe the DOM for the new tabs.

SCOPE FENCE: app/me/**, the shared personnel section components ONLY where a second consumer genuinely
needs a prop (and say so), lib/permissions.ts if a route is needed, your new tests, six locales.
Do NOT touch app/admin/leave-config/** or app/admin/leave/** (another agent is there), core/payroll.ts,
or any migration.`,
  },
];

const results = await pipeline(
  WORK,
  (w) =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${WT}/r259-${w.slug}
YOUR BRANCH:   r259/${w.slug}
YOUR TEST_DB_NAMESPACE: ${w.ns}
BOARD ITEM:    ${w.item}
APPROVED PLAN: ${PLANS}/${w.item}.txt   <- read it before you write code (AGENTS 29)

${w.brief}`,
      { label: `build:${w.slug}`, phase: 'Build', schema: BUILD_SCHEMA },
    ),
  (build, w) =>
    agent(
      `ADVERSARIALLY VERIFY the branch r259/${w.slug} in ${WT}/r259-${w.slug}.

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
  ? `4. ⚠️ COMPARE EACH NEW PAGE AGAINST THE OLD PAGE IT SHADOWS, not against IA §3's table — that table was
   found TWO FUNCTIONS SHORT last round, so a table-keyed check inherits its gaps. Anything on the old
   screen and not the new one is a finding.
5. Check every new page.tsx has its route in lib/permissions.ts, that no screen KEY changed, and that
   the old screens still work untouched.`
  : `4. ⚠️ SECURITY IS THE SUBJECT HERE. Try to reach another employee's data: a parameter, a header, a
   crafted id. Check the read is scoped through the SESSION and that RLS enforces it rather than a page
   filter. A self-service screen that leaks a colleague's record is the blocker this item can produce.
5. Check the field-visibility document exists, and that what it claims is hidden is ACTUALLY absent from
   the rendered page — not merely absent from the document's prose.`}
6. VERIFY THE RENDER CHECK WAS REAL: run the dev server yourself, load the pages, read the log.
7. Run the branch's targeted tests with TEST_DB_NAMESPACE=${w.ns}v.

Put "cd <worktree> &&" in every command. A blocker is wrong money, lost or leaked data, or a promise to
the reporter silently unmet. Say "ship" only if you would put your own name on it.`,
      { label: `verify:${w.slug}`, phase: 'Verify', schema: VERIFY_SCHEMA },
    ).then((v) => ({ ...build, slug: w.slug, item: w.item, verify: v })),
);

const done = results.filter(Boolean);
log(`r259: ${done.filter((r) => r.committed && r.tscClean).length}/${WORK.length} committed clean`);
for (const r of done) {
  const f = r.verify?.findings ?? [];
  log(`  ${r.slug}: ${r.verify?.verdict} — ${f.filter((x) => x.severity === 'blocker').length}B ${f.filter((x) => x.severity === 'major').length}M ${f.filter((x) => x.severity === 'minor').length}m`);
}
return { workstreams: done };

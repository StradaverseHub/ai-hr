export const meta = {
  name: 'r261-build-verify',
  description: 'Leave Configuration Round 5 (the cutover) and My Profile stage three (who may request, who approves)',
  phases: [{ title: 'Build' }, { title: 'Verify' }],
};

// AGENTS 35: the verify stage closes over the parent's own WORK entry — (build, w) — and never
// re-derives a path or an item id from the builder's echoed slug.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r261plans';

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
    slug: 'leave-cutover',
    ns: 'r261leave',
    item: 'a6fe37fc',
    brief: `YOU ARE BUILDING ROUND 5 — THE CUTOVER. READ docs/design/a6fe37fc-migration-order.md
"Round 5" IN FULL FIRST. This is the round that DELETES, and it is the one the whole sequence has been
building toward. Rounds 1-4 are deployed: the replay harness, /admin/leave-config/types (five tabs), the
seven Round 3 screens, and approval-chains + the Tab 5 read-out.

⚠️ THE SHAPE IS ONE COMMIT PER SCREEN, TEN TIMES. Not one big commit. For EACH of the ten screens, in a
SINGLE commit that does all of it together:
  · the map/menu entry and every inbound link move to the new address;
  · the old page.tsx is emptied to a REDIRECT STUB — the address must never 404, the reporter's bookmarks
    are the entire reason the stubs exist, and NO stub is ever deleted (Round 6 says so explicitly);
  · its route leaves lib/permissions.ts;
  · its private title key leaves messages/*.json (all six).
test/function-access.test.ts fails BOTH ways — a guarded page absent from the registry, and a registered
route whose page no longer calls a guard — so the halves land together or neither does. That is your
per-commit safety net; run it every time.

THE TEN, BY NAME (the design lists them with line counts, ~5,794 lines total):
  app/admin/leave/entitlements/page.tsx · components/leave-type-panel.tsx (3,367 lines, and with it the
  step bar, its two SubStepBar mountings, STEP_KEYS, GENERAL_SUB_STEP_KEYS, ESS_SUB_STEP_KEYS) ·
  approval/page.tsx · replacement/page.tsx · adjustments/page.tsx · generate/page.tsx ·
  entitlements/ledger-archive/page.tsx · entitlements/archive/page.tsx · payroll/page.tsx ·
  entitlements/templates/page.tsx · import/page.tsx

⚠️ components/leave-sub-step-bar.tsx IS NOT DELETED — components/leave/generate-form.tsx and
components/leave/adjustment-form.tsx still use it. Deleting it breaks two live screens.

⚠️ FIVE GUARDS PIN THE OLD ARRANGEMENT AND COME DUE NOW. They read components/leave-type-panel.tsx,
which you are deleting: leave-type-general-substeps, leave-condition-substeps, leave-type-config-active-
section, leave-type-workspace, leave-type-partial-approval-toggle. AGENTS 18: RE-POINT EACH CASE at the
new screen; do NOT delete them. The design's Round 2 table says where each one's reasoning goes, and it
names one specifically — "The tripwire asserting no Expiry form creeps back must be re-pointed at the new
file, not deleted — c459bff9 removed that step on purpose."

⚠️ ONE TEST IS EXPECTED TO FAIL AND YOU MUST NOT DELETE IT. test/leave-config-round3.test.ts → "the three
save banners on Company rules are DORMANT until Round 5" asserts the OLD redirect constant. Repointing
app/admin/_redirects.ts (ENTITLEMENTS / LEAVE / GENERATE / ADJUSTMENTS / ENTITLEMENT_TEMPLATES) and
app/admin/actions.ts's private LEAVE_REPLACEMENT is what makes those three banners LIVE. Re-point the
case, then RE-READ Company rules with each of ?saved= ?warning= ?error= and confirm each renders.
The warning= one carries the Phase-B #14 premium-equivalent BANKING-RISK warning, which was produced on
every qualifying save for months and silently dropped because the screen it landed on never read the
param. Shipping the screen that absorbs Replacement leave without that banner would set that up to happen
a second time, at exactly this cutover.

THE NAMES: every new screen and tab must render the string the menu shows for it, through
leaveConfigScreenTitle(). Delete the four private title keys IA §1.1 measured — admin.leave.pageTitle and
the archive, ledger-archive and approval keys — with the pages that owned them, in all six locales.
Repoint components/leave-config-map.tsx at the ten new hrefs and ADD Company rules;
test/leave-config-map.test.ts already enforces that every map href is a declared route.

⚠️ RUN THE REPLAY BEFORE AND AFTER EVERY ONE OF THE TEN COMMITS, against the SEEDED LOCAL cluster:
  AIHR_RAMDISK_GB=0 TEST_DB_NAMESPACE=<yours> npx vitest run test/leave-approval-replay.test.ts
Round 5 is where a live request path could change address without anyone noticing, and the replay is
exactly what §2 exists for. Report the result per commit. Do NOT touch production.

NO MIGRATION. RENDER CHECK MANDATORY: after the cutover load every one of the ten OLD addresses and
confirm each redirects (not 404s), and load all ten new screens and read the dev log.

SCOPE FENCE: app/admin/leave/**, app/admin/leave-config/**, components/leave-type-panel.tsx (delete),
components/leave-config-map.tsx, lib/permissions.ts, app/admin/_redirects.ts, app/admin/actions.ts (the
redirect constant only), the affected tests, six locales. Do NOT touch core/leave*, do NOT touch
app/me/** (another agent is there), and do NOT delete components/leave-sub-step-bar.tsx.`,
  },
  {
    slug: 'profile-stage3',
    ns: 'r261profile',
    item: '9583deac',
    brief: `YOU ARE BUILDING STAGE THREE — THE LAST STAGE of ${PLANS}/9583deac.txt. Stages one and two
are deployed: My Profile renders the Personnel record's six tabs as a read surface with a written
field-visibility account (docs/me-profile-field-visibility.md), and the request-and-approve path is
widened with a rejection reason (docs/me-profile-change-requests.md, migration 0458). READ BOTH DOCUMENTS
and lib/profile-requestable-fields.ts before you start — that file is the single declaration of which
fields are requestable, and stage three makes it configurable.

WHAT THE PLAN PROMISED THE REPORTER, in its own words:
  · "A setting that controls, field by field, which information an employee may ask to change."
  · "A setting that controls who approves, and an approval screen showing the current value beside the
    requested one, with Approve and Reject. Rejecting asks for a reason."
The approval screen and the reason already exist from stage two. What is new is the two SETTINGS.

⚠️ FIELD-LEVEL, NOT TAB-LEVEL. The plan says "per FIELD, not per tab (the reporter is explicit)". Model
it against the SAME field keys stage two records and the visibility manifest uses, so a permission and a
request can never disagree about what a field is called. There is already a guard that runs
Personnel -> /me over those keys; extend rather than fork.

⚠️ STORAGE — PREFER WHAT EXISTS. core/tenant-settings.ts is the app's writer of tenant_setting, and a
per-field allow list is tenant configuration. Use it if it fits. IF you genuinely need a table, migration
0459 IS ALLOCATED TO YOU AND IS THE ONLY NUMBER YOU MAY USE — a migration is a journal ENTRY, not just a
.sql file; APPEND to the journal, never re-sort it; and a CREATE TABLE must also GRANT and needs its RLS
policies, which an ALTER does not.
⚠️ AND HEED WHAT r260 COST: do NOT add a CHECK constraint to an existing table to enforce a decision rule.
A NOT VALID check is still enforced on every UPDATE, and r260's version would have aborted the whole PDPA
erasure for any employee holding a legacy row. Enforce decision rules in the service that decides.

THE SAFETY PROPERTIES, and they are the point of the whole item:
  · A field that is NOT allowed must offer no way to request a change — not a disabled control, no
    control. Assert it renders nothing rather than something inert.
  · Turning a field OFF must not silently apply or destroy a request already pending against it. Decide
    what happens (leave it decidable, or withdraw it explicitly) and TEST it — a pending request that
    quietly applies after the field was locked is the blocker this item can produce.
  · The approver setting must not let an employee approve their own request, and must not widen who can
    see other people's requests. Test both adversarially.
  · SINGLE-LEVEL APPROVAL, as the plan told the reporter: "We have planned a SINGLE approver to begin
    with ... If you want multi-level from the start, reject this plan and say so." They approved it as
    written. Do NOT build multi-level sequential approval.

RENDER CHECK MANDATORY: load the settings screen and /me on a dev server, read the dev log, and probe the
DOM for a field you have switched OFF to prove no control is offered.

SCOPE FENCE: app/me/**, the settings screen you add, core/profile.ts, core/tenant-settings.ts,
lib/profile-requestable-fields.ts, db/migrations (0459 ONLY, and only if truly needed), your tests, docs/,
six locales. Do NOT touch app/admin/leave/** or app/admin/leave-config/** — another agent is doing the
leave cutover this round and will conflict with you.`,
  },
];

const results = await pipeline(
  WORK,
  (w) =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${WT}/r261-${w.slug}
YOUR BRANCH:   r261/${w.slug}
YOUR TEST_DB_NAMESPACE: ${w.ns}
BOARD ITEM:    ${w.item}
APPROVED PLAN: ${PLANS}/${w.item}.txt   <- read it before you write code (AGENTS 29)

${w.brief}`,
      { label: `build:${w.slug}`, phase: 'Build', schema: BUILD_SCHEMA },
    ),
  (build, w) =>
    agent(
      `ADVERSARIALLY VERIFY the branch r261/${w.slug} in ${WT}/r261-${w.slug}.

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
  ? `4. ⚠️ THIS ROUND DELETES ~5,794 LINES. For EACH of the ten old addresses, load it and prove it
   REDIRECTS rather than 404s — the stubs are the reporter's bookmarks and none may ever be deleted.
   Then prove every one of the ten NEW screens renders and carries what its old one did.
5. ⚠️ CHECK THE FIVE GUARDS THAT PINNED THE OLD PANEL WERE RE-POINTED, NOT DELETED (AGENTS 18), and that
   the round3 banner case was re-pointed rather than removed — it was DESIGNED to fail here. Then load
   Company rules with ?saved= ?warning= ?error= and confirm each renders; the warning is a banking-risk
   warning that was already silently dropped once.
6. ⚠️ RUN THE REPLAY YOURSELF. A cutover is exactly where a live request path changes address unnoticed.
   Also confirm components/leave-sub-step-bar.tsx still EXISTS — two live forms use it.`
  : `4. ⚠️ TURN A FIELD OFF AND PROVE NO CONTROL IS OFFERED — not a disabled one, none. Then turn a field
   off while a request is PENDING against it and prove that request cannot quietly apply.
5. ⚠️ ADVERSARIAL: try to approve your own request, and to see or decide a colleague's. Check the scope
   is enforced by the session and RLS, not by a page filter.
6. Check no multi-level approval was built — the plan promised single-level and the reporter approved
   that. And check any migration is 0459, is a journal ENTRY, and adds NO check constraint to an
   existing table (r260's nearly aborted PDPA erasure).`}
6. VERIFY THE RENDER CHECK WAS REAL: run the dev server yourself, load the pages, read the log.
7. Run the branch's targeted tests with TEST_DB_NAMESPACE=${w.ns}v.

Put "cd <worktree> &&" in every command. A blocker is wrong money, lost or leaked data, or a promise to
the reporter silently unmet. Say "ship" only if you would put your own name on it.`,
      { label: `verify:${w.slug}`, phase: 'Verify', schema: VERIFY_SCHEMA },
    ).then((v) => ({ ...build, slug: w.slug, item: w.item, verify: v })),
);

const done = results.filter(Boolean);
log(`r261: ${done.filter((r) => r.committed && r.tscClean).length}/${WORK.length} committed clean`);
for (const r of done) {
  const f = r.verify?.findings ?? [];
  log(`  ${r.slug}: ${r.verify?.verdict} — ${f.filter((x) => x.severity === 'blocker').length}B ${f.filter((x) => x.severity === 'major').length}M ${f.filter((x) => x.severity === 'minor').length}m`);
}
return { workstreams: done };

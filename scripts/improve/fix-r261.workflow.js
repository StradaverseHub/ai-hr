export const meta = {
  name: 'r261-fix-verified',
  description: 'One fix pass over the r261 verify findings; the parent hand-checks after',
  phases: [{ title: 'Fix' }],
};

// AGENTS 23b: ONE fix pass, then hand-fix.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r261plans';
const FIND = '/tmp/r261fix';

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
    slug: 'profile-stage3',
    ns: 'r261profilef',
    item: '9583deac',
    extra: `⚠️ YOUR BLOCKER REWRITES A MASTER BANK ACCOUNT FROM A REQUEST THE EMPLOYER HAD ALREADY LOCKED,
AND IT WAS PROVEN ON A LIVE CLUSTER WITH 1000 SEEDED ROWS. A pending request naming a field that has
since been switched OFF can still be approved: withdrawProfileChangesForLockedFields returned
withdrawn: 0, a second save withdrew 0 as well (so your stated mitigation does not work), an HR admin
then approved it with NO error, and the master bank account went from 111122223333 to 999988887777.

TWO INDEPENDENT CAUSES AND YOU MUST FIX BOTH:
  1. core/profile.ts:796 selects pending rows with .limit(1000), NO filter on the locked keys and NO
     ordering — so past 1000 pending rows the matching row is simply never returned, on any number of
     saves. pendingProfileChangeCountsByKey at :750 has the identical cap, so the settings screen would
     under-report too. FILTER ON THE KEYS IN SQL and remove the blind cap (or paginate to exhaustion),
     so the sweep converges by construction rather than by luck.
  2. ⚠️ decideProfileChange HAS NO ALLOW-LIST CHECK AT ALL. Even with a perfect sweep, a request that
     slipped through — a race between the save and the decision, a row created a moment earlier — is
     approvable. THE DECISION IS THE LAST GATE AND IT MUST CHECK. Refuse to apply any key that is not
     currently allowed, whatever the row says.
Pin both: a test with more pending rows than the cap, and a test that approves a request whose key was
locked after it was raised and asserts the master column DID NOT MOVE.

⚠️ MAJOR 1 — /me AND /approvals NOW RETURN 500 WHERE THEY USED TO RENDER. Yours are the first THROWING
entitlement reads in app/: all 41 pre-existing reads use the quiet forms (settingEnabledOrDefault /
isModuleEnabledOrFalse), there is no app/error.tsx and no global-error.tsx, and the verifier isolated it
by reverting only your two reads. An employee's own profile page going 500 because a settings lookup
failed is a worse failure than the setting defaulting closed. Use the quiet form and decide the safe
default deliberately — for a permission, that is CLOSED (no field requestable) rather than open — and say
which you chose.

⚠️ MAJOR 2 — WRONG CUSTOMER-VISIBLE PROSE SHIPS TO PRODUCTION ON EVERY DEPLOY. packs/catalog.ts:232's
description for ess.profile_change_approver still describes the abandoned manager design ("an HR
administrator only, or the employee's manager as well"), it is customerVisible: true, and
scripts/seed-catalogs.ts:186 puts description in its onConflictDoUpdate SET clause while deploy.sh runs
seed-catalogs after db:migrate. So every deploy overwrites production's setting_definition.description
with a sentence that contradicts the code, the docs and the i18n strings. The shipped values are
['admin','group_admin'] and resolveRequestApprover maps 'manager' to 'admin' — no manager can ever
approve. Correct the description AND the block comment above it.

⚠️ MAJOR 3 IS A PROMISE PROBLEM, NOT A CODE ONE — DO NOT "FIX" IT BY BUILDING MANAGER APPROVAL. The plan
told the reporter "manager first, then HR ... we have planned a SINGLE approver to begin with", so they
will read "who approves" as manager-or-HR. What shipped is HR-admin vs group-admin. The verifier checked
your reason and confirmed it is genuine, not an excuse: a manager approver would have required widening
master-record write access product-wide (person_rls WITH CHECK app.is_admin() OR app.is_self_person(id)).
KEEP THE SAFE SHAPE. Write the explanation into "reporterOwed" in plain business words — what the setting
actually chooses between, why a manager cannot be an approver without changing who can edit master
records product-wide, and that we would plan that separately if they want it.

THEN THE MINORS in your findings file.

SCOPE FENCE: app/me/**, core/profile.ts, core/tenant-settings.ts, lib/profile-requestable-fields.ts,
packs/catalog.ts, the settings screen, your tests, docs/, six locales. Do NOT touch app/admin/leave/** or
app/admin/leave-config/** — the other agent owns the cutover. Do NOT change the migration number.`,
  },
  {
    slug: 'leave-cutover',
    ns: 'r261leavef',
    item: 'a6fe37fc',
    extra: `NO BLOCKERS — the cutover itself verified well: 13 old addresses all 307 (none 404), the
banking-risk banner reaches its reader, the five old guards were re-pointed rather than deleted, and the
seeded replay was 20/20 at every one of the eleven commits. Two majors and three minors.

⚠️ MAJOR 1 IS THE PARENT'S TO DISCHARGE, NOT YOURS — DO NOT TOUCH PRODUCTION. The item's named cutover
gate is the PRODUCTION --verify replay against docs/baselines/a6fe37fc-approval-baseline.json, and the
approved plan promises the reporter it runs "before anything is switched over". The parent will run it
before the deploy. Your job is only to make sure nothing in the branch makes it meaningless: confirm no
engine file is touched (core/leave-approval-policy.ts, core/leave-approval-consolidation.ts, core/leave.ts)
and say so in "remaining".

⚠️ MAJOR 2 — YOUR STATED MITIGATION FOR THE UNMOVED CONSTANT IS VACUOUS, AND THE VERIFIER PROVED IT.
You left app/admin/leave-approval/actions.ts's PAGE = '/admin/leave/approval' unmoved (defensible — it is
outside the constants Round 5 names) and justified it by saying test/leave-config-round4.test.ts "asserts
BOTH the literal and the stub's query forwarding". It does not: line 178-180 only asserts the stub
contains the token 'URLSearchParams' — the exact token-level shape you yourself replaced for the other
nine stubs. The verifier deleted the forwarding LOOP while leaving the declaration behind, and tsc and the
test both stayed green. /admin/leave/approval is the ONE stub whose forwarding is genuinely load-bearing
(an approval save 303s through it) and it is the one not covered by leave-config-round3's CUTOVER table,
whose keys are leaveTypes/templates/payroll/replacement/generate/adjustments/import/archive/ledgerArchive.
Give it the same real assertion the other nine have — or add it to that table — and prove it fails by
deleting the loop.

THEN THE THREE MINORS in your findings file.

SCOPE FENCE unchanged: app/admin/leave/**, app/admin/leave-config/**, components/leave-config-map.tsx,
lib/permissions.ts, app/admin/_redirects.ts, the affected tests, six locales. Do NOT touch core/leave*,
app/me/** (the other agent is there), and do NOT delete components/leave-sub-step-bar.tsx or any stub.`,
  },
];

const fixes = await parallel(
  WORK.map((w) => () =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${WT}/r261-${w.slug}
YOUR BRANCH:   r261/${w.slug}
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

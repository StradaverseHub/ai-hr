export const meta = {
  name: 'r256-build-approved',
  description: 'Build 8 approved board items as 8 workstreams, each verified adversarially',
  phases: [{ title: 'Build' }, { title: 'Verify' }],
};

const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r256plans';

const COMMON = `
ENVIRONMENT AND HARD RULES — read before touching anything.

- Your worktree is the ONLY place you may edit. Put "cd <your worktree> &&" in EVERY bash command; the
  shell's cwd resets and the repo ROOT is a stale scratch tree. Prove it first:
  cd <wt> && pwd && git rev-parse --abbrev-ref HEAD
- This is NOT the Next.js you know (16.2.7). Read node_modules/next/dist/docs/ before Next-specific code.
- Understand code through the graph: from \${WT}/mainwt run graphify explain / query / affected.
- TESTS: ONLY narrowly targeted files. NEVER the full suite — the parent runs the single gate alone.
  npx vitest run <files> > /tmp/<slug>.log 2>&1 then READ the log: exit code AND file count.
- Export your own TEST_DB_NAMESPACE in every test command.
- npx tsc --noEmit clean before you commit.
- ⚠️ THE LOCAL CLUSTER IS ON DISK. If you rebuild it: AIHR_RAMDISK_GB=0 ./scripts/dev-db-rebuild.sh —
  recreating the 8GB RAM disk on this 18GB machine OOM-killed three gates.
- MIGRATIONS ARE ALLOCATED CENTRALLY. Only the 'shift' workstream has a number (0457, when
  1781862557000). Everyone else: if you think you need one, STOP and say so.
- A guard may pin the decision you are reversing: UPDATE its case with the new reasoning, never delete it.
- i18n: keys in all six locales with REAL translations, never English copied through.
- Source-scanning guards do not strip comments.
- COMMIT on your branch. Never amend, rebase or git stash — stashes are REPO-GLOBAL.

EVERY TEST YOU ADD MUST BE PROVED NON-VACUOUS: revert from a cp copy taken FIRST (never git checkout --),
watch the intended assertion FAIL, restore. State which assertion you watched fail.

BUILD WHAT THE APPROVED PLAN SAYS. Anything you cannot build goes in notBuilt with the reason.

⚠️ VERIFY THE PLAN'S PREMISE BEFORE BUILDING ON IT. If measurement contradicts the plan, STOP and report.
`;

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['slug','committed','tscClean','testsPass','summary','notBuilt'],
  properties: {
    slug:{type:'string'}, committed:{type:'boolean'}, commitSha:{type:'string'},
    tscClean:{type:'boolean'}, testsPass:{type:'boolean'},
    testFiles:{type:'array',items:{type:'string'}}, nonVacuityProof:{type:'string'},
    summary:{type:'string'}, notBuilt:{type:'array',items:{type:'string'}},
    migrationsUsed:{type:'array',items:{type:'string'}}, filesTouched:{type:'array',items:{type:'string'}},
    premiseCheck:{type:'string'},
  },
};
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['slug','verdict','findings'],
  properties: {
    slug:{type:'string'}, verdict:{type:'string',enum:['ship','fix-first']},
    nonVacuityRederived:{type:'boolean'},
    findings:{type:'array',items:{type:'object',additionalProperties:false,
      required:['severity','claim','evidence'],
      properties:{severity:{type:'string',enum:['blocker','major','minor']},claim:{type:'string'},
        evidence:{type:'string'},introducedByThisBranch:{type:'boolean'}}}},
  },
};

const WORK = [
  { slug:'labels', ns:'r256lbl', items:['f1bbc572'], brief:
`Read ${PLANS}/f1bbc572.txt. A Global system label must be visible to EVERY company.

THE DEFECT IS ONE LINE, already located: app/admin/settings/system-labels/page.tsx:151
  const inScope = <T extends { companyId: string }>(rows: T[]) => rows.filter((r) => scopedIdSet.has(r.companyId));
It tests the row's ORIGIN company and never consults isGlobal. Applied at :153-156 to all four kinds.
MEASURED: 59 global rows (21 department / 27 position / 5 cost_center / 6 business_unit) created under
six different companies, in a tenant with TWELVE. So no company sees the whole global set.

FIX: admit a row when r.isGlobal OR its company is in scope.
⚠️ THEN SWEEP — the reporter's "any other screen that retrieves System Label Codes". Every dropdown
offering departments/positions/cost centres/business units per company needs the same union, or a label
is visible in maintenance and unavailable in the picker, which is WORSE than today. Use the code graph.
Report which you changed and which legitimately scope by origin.
DO NOT touch job_grade (system-labels-grid.tsx:193-194 records it is tenant-global by design).
TEST: a global row created under company A is returned for a scope containing only company B; a
company-A row is not; a single-company scope returns (that company's rows + all global).` },

  { slug:'header', ns:'r256hdr', items:['fbf6abd0'], brief:
`Read ${PLANS}/fbf6abd0.txt. Show who is signed in.

MEASURED: app/layout.tsx renders the header's right cluster as divider → language → theme → LogoutButton
(~:184-221). No name, no employee code, no avatar. DevIdentitySwitcher at :184 is dev/demo only and is
hidden on a real deployment, so a normal login shows no identity at all.

BUILD: name + employee ID in the top right on every screen, initials avatar, and a menu holding the same
name/ID, a link to the person's own profile, and Log out (which MOVES into the menu).
⚠️ lib/session.ts does NOT carry a display name and lib/principals.ts is the demo switcher list — do not
use it as the source. Read name and employee code through the session's employment. A principal with NO
employment (a platform/admin account) is a REAL case: decide what it shows, say so, and never render an
empty element.
⚠️ A 200 IS NOT A RENDER CHECK. This is the app shell, where MISSING_MESSAGE and RSC boundary faults
hide. Render on a dev server and read the log.
If a guard pins LogoutButton's current position, UPDATE it rather than deleting the case.` },

  { slug:'name-link', ns:'r256nl', items:['b372e923'], brief:
`Read ${PLANS}/b372e923.txt. THIS IS A CONTESTED ITEM — r253 shipped the wrong affordance and the
reporter rejected it. Build what they actually asked for.

MEASURED: app/payroll/[batchId]/page.tsx:1049-1056 wraps BOTH the EmployeeCode and the name in
<Link href={payslipDetailHref(...)}> — the run screen already behaves correctly.
app/payroll/[batchId]/reprocess/page.tsx:325 renders <span>{r.employeeName}</span> with a SEPARATE link
at :366. So we added a second control instead of the one that existed.

FIX (markup only — the destination helper app/payroll/payroll-result-href.ts is already shared):
wrap the name AND the EmployeeCode on the reprocess rows in the existing link; REMOVE the separate
"Payroll Result" column and its header; keep plain text for a row with no resolvable payslip.
The r253 test asserted the separate link carried BOTH ids for THAT row — KEEP that assertion and
re-point it at the name (AGENTS 18: update the case, never delete it).
"Regardless of status" needs NO work: resultHrefs joins jobRows to slips and never reads batch.status.
Say so rather than building a status check.
SCOPE FENCE: app/payroll/[batchId]/reprocess/** is YOURS this round. Do not touch app/payroll/page.tsx.` },

  { slug:'reprocess-status', ns:'r256rs', items:['0b326d5f'], brief:
`Read ${PLANS}/0b326d5f.txt. Show "Reprocess Required" in the Payroll Process listing.

⚠️ THE MECHANISM IS BUILT AND LIVE — this is a DISPLAY gap, not a behaviour gap. db/schema.ts:5262
needsRecalcAt + :5268 recalcEmploymentIds; core/payroll.ts:150 refuses close while pending;
markBatchNeedsRecalc fires on txn add/bulk/edit/delete. MEASURED on production: SIX batches carry
needs_recalc_at right now (2026-08 x1, 2026-07 x1, 2026-06 x3, 2026-05 x1, 2026-04 x2, 2026-03 x2).
Do NOT rebuild the detection.

⚠️ AND DO NOT ADD A FOURTH ENUM VALUE. db/schema.ts:5259 states verbatim: "NOT a fourth payroll status.
payrollStatusEnum is exactly ['draft','processed','closed'] ... the mark is an ATTRIBUTE of a processed
run, so nothing that switches on status has to learn a new value." The approved plan keeps that and tells
the reporter so. Derive a DISPLAY state instead: processed + needsRecalcAt ⇒ "Reprocess Required".

BUILD: the display state in the listing, the affected-employee count from recalcEmploymentIds, and a link
into the selective reprocess with that set preselected. New label in six locales.
The dashboard status FILTER is a single select bound to filters.statuses[0]
(app/payroll/dashboard-filters.tsx) — decide whether the new state is filterable and SAY WHICH; do not
leave a chip the filter cannot reach.
TEST: a processed run with needsRecalcAt shows the state and count; clearing the last employment returns
it to Processed; a CLOSED run never shows it whatever the flag says.
SCOPE FENCE: do NOT touch app/payroll/[batchId]/reprocess/** — another workstream owns it.` },

  { slug:'txn-prompt', ns:'r256txn', items:['4b909202'], brief:
`Read ${PLANS}/4b909202.txt. CONTESTED — and it is the reject our own plan invited, so treat it as an
agreed scope change rather than a defect.

TODAY (r255, deployed): a message naming the employee/run/scope, then a separate "Add X to this run"
button. The reporter wants ONE confirmation prompt with Continue / Cancel.

BUILD: collapse the two-step into a single confirm at the point of save.
  Continue → widen scope + insert the transaction + markBatchNeedsRecalc, as ONE transaction. The current
    two-step leaves a window where the employee is in scope but the transaction was never saved; a single
    prompt must NOT preserve that.
  Cancel → writes nothing at all.
  The separate "Add to this run" button goes away.

⚠️ KEEP THE NOT-EMPLOYED-IN-PERIOD REFUSAL. r255's fix pass added isEmployedDuringPeriod /
EmploymentNotActiveInPeriodError and canAddToRun precisely because adding a leaver marks a recalculation
that can never complete. When canAddToRun is false the prompt must NOT offer Continue — state the reason
instead. Do not regress that while changing the presentation.
Closed runs still refuse outright. i18n in six locales; retire the two-step's keys only after checking no
other caller resolves them.
SCOPE FENCE: do NOT touch app/payroll/page.tsx or reprocess/** — other workstreams own those.` },

  { slug:'shift', ns:'r256shift', items:['6340aecb'], brief:
`Read ${PLANS}/6340aecb.txt. Redesign Shift Settings.

MIGRATION 0457 IS YOURS — the only one this round. when = 1781862557000, tag 0457_shift_colour_flex_break.
Journal entry AND .sql; append, never re-sort.

ALREADY EXIST (db/schema.ts shift + app/admin/attendance/shift-form.tsx) — do NOT rebuild:
  halfDayFirstOut / halfDaySecondIn (request point 9 — BUILT, rendered at :236-238)
  earlyIn / lateOut (point 8 — the fields to RELABEL, at :220 and :223)
  startTime/endTime, breakMinutes, breakPeriods, grace minutes, crossesMidnight, lateOutNextDay
GENUINELY ABSENT: a shift COLOUR, and the FLEXIBLE BREAK (on/off + allowed duration). Those need 0457.

⚠️ FLEXIBLE BREAK IS NOT COSMETIC — break handling feeds worked minutes, which feeds overtime and the
attendance figures payroll reads. Default it OFF on every existing row and PIN A GOLDEN TEST that a shift
without it computes byte-identically to today. Same discipline 711adcd2's ORP flags needed, same reason:
a switch installed "to change nothing" must be PROVED to change nothing.
THE COLOUR MUST REACH THE DUTY ROSTER (request point 7). Check the roster's rendering path and say what a
shift with NO colour looks like — it must be unchanged.
RENAMES ARE LABELS ONLY. Do NOT rename the columns: earlyIn/lateOut are read across attendance and
payroll. Change the message VALUES in six locales.
Full-width layout, sections: Shift Identification / Working Times / Breaks / General Controls. Validate
time sequence. Existing shifts must round-trip unchanged — assert it.` },

  { slug:'statutory', ns:'r256stat', items:['858a1128'], brief:
`Read ${PLANS}/858a1128.txt. Statutory Forms becomes a form directory.

MEASURED: app/payroll/statutory-forms/page.tsx takes companyId/year/month as searchParams (:239-243) —
the period genuinely precedes the form choice. ALREADY BUILT and NOT to be rebuilt: the pack registers
EIGHT reports (:32) and each carries a FormStatus of 'official' | 'agency-layout' | 'figures' |
'draft-file' | 'planned' (:130). Carry that grouping and those chips across unchanged.

BUILD: a directory page with no period filters; a per-form criteria step (company + year + month) that
generates only on Generate; and for C.P.8A (EA) a TWO-STEP flow — company + year, then employee selection
with search by name AND employee code, select all, clear — and NO month box.

⚠️ AGENTS 28b: a shared status caption may only say what is true of EVERY form in that status. If you
re-render those chips somewhere new, re-read every string the status prints — r218 shipped an unsourced
claim about an agency exactly this way.
Keep existing generation entry points reachable (a redirect stub is cheaper than breaking a bookmark;
this screen is bookmarked monthly). A new guarded page.tsx needs a lib/permissions.ts column — attach it
to the EXISTING statutoryForms screen key, access is unchanged.` },

  { slug:'personnel-tabs', ns:'r256ptab', items:['420ebab5'], brief:
`Read ${PLANS}/420ebab5.txt. FINISH the remaining tabs. Part one (clickable row) shipped r253; Profile
consolidated r254; more in r255. THIS ITEM HAS BEEN BUILT THREE TIMES AND NEVER CLOSED — the goal this
round is to finish it or to state precisely what cannot be finished and why.

START FROM docs/audits/420ebab5-personnel-save-classification.md — it classifies all 35 forms into
(a) field edits, which consolidate, and (b) child-record lifecycle, which KEEP their own buttons.

STILL PER-CARD after r255: BANK & STATUTORY (setBankAction, setStatutoryAction, setTaxAction,
setOthersStatutoryAction), ATTENDANCE (setEmploymentHolidayCalendarAction,
setEmployeeClockingLocationsAction, setGeofencingAction), PAYROLL (setPaymentMethodAction,
assignPolicyAction, setTp3Action), JOB (setEmploymentInfoAction).

⚠️ FAMILY AND QUALIFICATION CANNOT BE CONSOLIDATED AT ALL — every form on both is a child record, so a
tab-wide Save would have nothing to save and a tab-wide Discard would cover nothing. Do NOT force them.
This is the fact that stops the item ever being "complete" as written, and the round owes the reporter
that sentence in plain words — put it in notBuilt.

⚠️ BUCKET (b) KEEPS ITS OWN BUTTONS. Several move money. A tab-wide Discard that appeared to cover a
recorded salary revision would be a control lying about what it does.
EFFECTIVE DATING SURVIVES (ADR-0001/0003): a save CLOSES and INSERTS a version. Call the SAME services per
section, in order — never one blanket write.
SCOPE FENCE: do NOT touch app/admin/personnel/new/** or app/me/**.` },
];

const built = await parallel(WORK.map((w) => () =>
  agent(`${COMMON}

YOUR WORKTREE: ${WT}/r256-${w.slug}
YOUR BRANCH:   r256/${w.slug}
YOUR TEST_DB_NAMESPACE: ${w.ns}
BOARD ITEM(S): ${w.items.join(', ')}

${w.brief}`, { label: `build:${w.slug}`, phase: 'Build', schema: BUILD_SCHEMA })));

const results = await parallel(built.map((b, i) => () => {
  const w = WORK[i];
  if (!b) return null;
  return agent(`ADVERSARIAL VERIFICATION of "${w.slug}" on branch r256/${w.slug}, worktree ${WT}/r256-${w.slug}.

You are NOT the builder and take nothing on trust. Put "cd ${WT}/r256-${w.slug} &&" in every bash command.
TEST_DB_NAMESPACE ${w.ns}v. Targeted tests only. Cluster is ON DISK — AIHR_RAMDISK_GB=0 if you rebuild.

Read the approved plan (${w.items.map((i2) => `${PLANS}/${i2}.txt`).join(', ')}) and git diff main...HEAD.
The builder reported:

${JSON.stringify(b, null, 2)}

LOOK FOR, IN ORDER:
1. A DEFECT THIS BRANCH INTRODUCED. Rank highest; set introducedByThisBranch.
2. MONEY / PAY-AFFECTING behaviour reachable with ordinary input. For 'shift' especially: prove a shift
   WITHOUT flexible break computes byte-identically to before — a break setting feeds worked minutes,
   which feeds overtime.
3. A GUARD THAT CANNOT FAIL. Re-derive the non-vacuity claim YOURSELF: cp copy, revert, run the named
   assertion, confirm it fails, restore. This repo has shipped vacuous guards whose authors believed they
   had tested them. Set nonVacuityRederived only if you actually did it.
4. THE PLAN'S PROMISE vs WHAT SHIPPED — including anything built the plan did NOT promise.
5. SCOPE FENCES: labels → job_grade untouched, the sweep actually done; header → no empty element for a
   principal with no employment, dev-server render actually run; name-link → separate column REMOVED and
   the r253 assertion re-pointed not deleted, page.tsx untouched; reprocess-status → NO fourth enum value,
   reprocess/** untouched, closed runs never show it; txn-prompt → Continue is ONE transaction, the
   not-employed refusal still withholds Continue, closed runs still refused; shift → columns NOT renamed,
   flexible OFF by default, colour reaches the roster, existing shifts round-trip; statutory → status
   chips' wording still true for every member, deep links still resolve; personnel-tabs → bucket (b) keeps
   its buttons, effective dating preserved, new/** and me/** untouched, Family/Qualification stated not forced.
6. A user-visible string that is wrong, untranslated, or renders MISSING_MESSAGE.

Give each finding a concrete failure path with file:line. A finding without one is a guess — say so or
drop it. Verdict 'fix-first' ONLY for a blocker or a real major.`,
    { label: `verify:${w.slug}`, phase: 'Verify', schema: VERIFY_SCHEMA }).then((v) => ({ built: b, verify: v }));
}));

const done = results.filter(Boolean);
const green = done.filter((r) => r.built?.committed && r.built?.tscClean && r.built?.testsPass);
const blockers = done.flatMap((r) => (r.verify?.findings ?? [])
  .filter((f) => f.severity === 'blocker' || f.severity === 'major')
  .map((f) => ({ slug: r.built.slug, ...f })));
log(`build: ${green.length}/${WORK.length} green · ${blockers.length} blocker/major`);
return {
  workstreams: done.map((r) => ({
    slug: r.built.slug, committed: r.built.committed, commitSha: r.built.commitSha,
    tscClean: r.built.tscClean, testsPass: r.built.testsPass, premiseCheck: r.built.premiseCheck,
    migrationsUsed: r.built.migrationsUsed, notBuilt: r.built.notBuilt,
    nonVacuityProof: r.built.nonVacuityProof, verdict: r.verify?.verdict ?? 'no-verify',
    nonVacuityRederived: r.verify?.nonVacuityRederived, findings: r.verify?.findings ?? [],
  })),
  blockers,
};

export const meta = {
  name: 'r254-build-approved',
  description: 'Build the 4 remaining approved items as 4 workstreams, each verified adversarially',
  phases: [{ title: 'Build' }, { title: 'Verify' }],
};

// The PARENT created every worktree from main, copied .env.local and symlinked node_modules.
// `isolation: 'worktree'` is FORBIDDEN here (it cuts the tree from root HEAD; the repo root is a stale
// scratch worktree).
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r254plans';

const COMMON = `
ENVIRONMENT AND HARD RULES — read before touching anything.

- Your worktree is the ONLY place you may edit. Put \\\`cd <your worktree> &&\\\` in EVERY bash command; the
  shell's cwd resets between calls and the repo ROOT is a stale scratch tree. This has cost five rounds.
  Prove it in your FIRST command: \\\`cd <wt> && pwd && git rev-parse --abbrev-ref HEAD\\\`.
- This is NOT the Next.js you know (16.2.7). Read the relevant guide under node_modules/next/dist/docs/
  before writing Next-specific code.
- Understand code through the graph rather than grepping cold: from \${WT}/mainwt run
  \\\`graphify explain "<symbol>"\\\`, \\\`graphify query "<question>"\\\`, \\\`graphify affected "<symbol>"\\\`.
- TESTS: run ONLY narrowly targeted files. NEVER the full suite — the parent runs the single gate alone.
  \\\`npx vitest run <files> > /tmp/<slug>.log 2>&1\\\` then READ the log: exit code AND file count, not the
  summary alone. Never pipe a long command to tail.
- Export your own TEST_DB_NAMESPACE in every test command. Do not invent another; two agents sharing one
  wipe each other's worker databases.
- \\\`npx tsc --noEmit\\\` clean before you commit.
- MIGRATIONS ARE ALLOCATED CENTRALLY. Only ONE workstream has a number this round and it is stated in its
  brief. If you believe you need one and have not been given a number, STOP and say so in your report.
  A migration is a JOURNAL ENTRY plus a .sql file; a CREATE TABLE must also GRANT.
- A new file under core/ must import packs/<pack>/service, never the pack implementation. The ratchet
  scans the FILESYSTEM and does NOT strip comments, so a quoted import inside a comment reads as a real
  edge. The fix is never the allowlist.
- A new guarded page.tsx needs a column in lib/permissions.ts or test/function-access.test.ts's
  reverse-completeness case fails. Attach it to an EXISTING screen key.
- A guard may pin the decision you are reversing: UPDATE its case with the new reasoning, never delete it.
- i18n: keys in messages/en.json AND ms, zh, ta, th, vi. Parity is enforced by a test; a stale or English
  VALUE is not, so write real translations.
- A form field that is always submitted cannot be read by presence, and a DISABLED control posts nothing.
- Source-scanning guards do not strip comments: never spell a forbidden expression out beside its guard.
- COMMIT on your branch when done. Never amend, never rebase, never \\\`git stash\\\` — stashes are
  REPO-GLOBAL and another agent will get yours.

EVERY TEST YOU ADD MUST BE PROVED NON-VACUOUS: revert the change from a \\\`cp\\\` copy taken FIRST (never
\\\`git checkout --\\\`, which reverts to HEAD and has destroyed a round's work here), watch the intended
assertion FAIL, restore. State which assertion you watched fail.

BUILD WHAT THE APPROVED PLAN SAYS, not what the original ticket says — the plan is what the customer
approved and the differences are deliberate and explained there. Anything you cannot build goes in
notBuilt with the reason, never silently skipped.

⚠️ VERIFY THE PLAN'S PREMISE BEFORE BUILDING ON IT. Repeatedly in this repo the reported fault was not the
real one. If measurement contradicts the plan, STOP and report it rather than building something the
measurement says is wrong.
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
    premiseCheck: { type: 'string', description: 'what you measured about the plan premise, and whether it held' },
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
    slug: 'payitem-orp',
    ns: 'r254orp',
    wt: `${WT}/r254-payitem-orp`,
    items: ['711adcd2'],
    brief: `Read the approved plan: ${PLANS}/711adcd2.txt.

⚠️ THIS ONE MOVES MONEY. It changes what feeds the overtime rate. Build it slowly, measure before you
change anything, and if the plan's premise does not hold, STOP AND REPORT rather than building on it.

MIGRATION 0456 IS YOURS — the only one allocated this round. \`when\` must be 1781862556000, tag
\`0456_pay_item_orp_flags\`. Journal entry AND .sql file; append to the journal, never re-sort it.

⚠️ CHECK THE PLAN'S PREMISE FIRST AND REPORT WHAT YOU FIND IN premiseCheck. The plan tells the customer
"today the system decides which pay items count towards overtime by their TYPE, not by a tick box. Every
non-statutory Allowance paid as a fixed amount counts." The parent started tracing that and it is NOT
obviously what the code does: core/payroll.ts:2818 selects \`compensation.basicSalary\` and
\`compensation.monthlyAllowance\` — COLUMNS on the compensation record — and line 2821 computes
\`(basic + allowance) / 26 / 8\`. Line 2611 calls that "s.2 wages (basic + fixed allowance) — the ORP
basis". There is ALSO a \`fixed_allowances\` aggregate in core/pay-rule.ts (referenced at payroll.ts:3883,
4098-4099) that deliberately excludes one-offs. So there may be TWO paths, or the compensation columns may
be derived from components somewhere. FIND OUT which one actually feeds overtime, and say so plainly.
localization/my/payroll.ts:1017 is the ORP definition (wages / 26, hourly = ORP / normal hours).

WHAT TO BUILD (per the plan):
1. RENAMES, wording only, no behaviour change: Category "Allowance" → "Earning"; "Non-Payable (BIK)" →
   "Non-Payable". Payroll Category "Allowance" → "Earning", and ADD "Benefit in Kind (BIK)".
   Also rename "Automatic (from Statutory Settings)" → "Work it out automatically" — the plan explains
   why it is KEPT rather than removed (six of the customer's 29 items use it, and it decides only which
   box an item prints in, nothing statutory).
2. TWO INDEPENDENT TICK BOXES per pay item: "Add to Unpaid Leave ORP Calculation" and "Add to Overtime
   ORP Calculation". Either, both or neither.
3. ⚠️ THE BACKFILL IS THE MOST IMPORTANT LINE IN THE PLAN: "Set those tick boxes, on the day we ship, so
   that every pay item keeps behaving exactly as it does today. Nobody's overtime or unpaid leave changes
   because we installed the switch." So 0456 must backfill from whatever the CURRENT rule actually is —
   which is why the premise check comes first. A wrong backfill silently changes real overtime pay.
4. The Pay Item screen as a full-width layout with the sections the customer drew: General Information,
   Ordinary Rate of Pay, Calculation, Statutory Configuration; Back top-left, Cancel and Save bottom-right.

SCOPE FENCES:
- Do NOT change the ORP formula itself (wages / 26). Only WHICH items feed it becomes configurable.
- Do NOT act on the customer's worked example that subtracts a deduction from the overtime base. The plan
  explicitly flags it as wrong under EA s.60I and says we would raise it rather than implement it.
- Keep "Work it out automatically". The plan promised it stays.

THE TEST THAT MATTERS MOST: a golden case proving that for every existing pay item shape, the overtime
figure computed AFTER your change with the backfilled flags is BYTE-IDENTICAL to the figure computed
before it. That is the promise the customer approved, and it is worth more than the tick boxes.`,
  },
  {
    slug: 'personnel-save',
    ns: 'r254save',
    wt: `${WT}/r254-personnel-save`,
    items: ['420ebab5'],
    brief: `Read the approved plan: ${PLANS}/420ebab5.txt. PART ONE (the clickable employee row) SHIPPED in
r253 and is live. Build PART TWO: one Save per tab on the employee detail screen.

START FROM THE CLASSIFICATION r253 PRODUCED: docs/audits/420ebab5-personnel-save-classification.md. It
sorts all 35 \`<form action={...}>\` on app/admin/personnel/[employmentId]/page.tsx (4,740 lines, 31
distinct server actions) into two buckets. READ IT FIRST and treat it as the design, not as background.

  (a) FIELD EDITS on the person/employment record — these consolidate under one Save per tab.
  (b) CHILD-RECORD LIFECYCLE — add/edit/archive of dependants, qualifications, emergency contacts, CP38,
      encashment adjustments, compensation revisions, pay items. These are discrete acts, several
      money-affecting, and they KEEP their own buttons and their own confirmations.

⚠️ THE BUCKET (b) FENCE IS THE WHOLE SAFETY ARGUMENT AND YOU MAY NOT MOVE IT. A tab-wide "Discard
Changes" that appeared to cover a recorded salary revision would be a control lying about what it does —
worse than the scattered buttons it replaced. If you believe an item is mis-bucketed, say so in your
report; do not re-bucket it yourself.

BUILD, per the plan:
1. One "Save Changes" button per tab covering bucket (a) only. Remove those sections' individual buttons.
2. Track edited fields and show what changed — old value vs new value — before saving.
3. Leaving a tab or the screen with unsaved changes prompts: Save / Discard / Cancel. Discard restores the
   last saved values. Cancel stays put and keeps the edits.
4. Start with the PROFILE tab as the pattern, get it right, then apply it. If you only finish some tabs,
   say which — a half-applied pattern reported honestly is fine; a silently skipped tab is not.

⚠️ EFFECTIVE DATING SURVIVES THIS. ADR-0001/0003: a save CLOSES the current version and INSERTS a new one
rather than updating in place. A consolidated Save must still call the SAME services per section, in
order — do not collapse it into one blanket write, and do not bypass a service to write a table directly.

SCOPE FENCE: do NOT touch app/admin/personnel/new/** — another workstream is working there this round.
If you need something from it, say so in your report instead of editing it.`,
  },
  {
    slug: 'draft-family',
    ns: 'r254draft',
    wt: `${WT}/r254-draft-family`,
    items: ['759dfc7d'],
    brief: `Read the approved plan: ${PLANS}/759dfc7d.txt. Build STAGE ONE ONLY — the plan's own work item
1: Family on drafts, end to end, including materialisation at activation, with tests on the activation
path. Do NOT attempt the other tabs this round.

THE LOAD-BEARING FACT, verified by the parent in db/schema.ts employeeDraft: a draft is ONE row whose
\`data\` is a single jsonb blob, plus companyId, label, currentStep and the reserved employee-code hold.
The schema comment is explicit: "a draft still creates no person and no employment, and is still absent
from headcount, payroll, leave and every report." So employee_dependent — which is keyed to the
employment — has NOWHERE to live for a draft except inside that blob, and activation must then create the
real rows.

THE PLAN CHOSE ROUTE A AND YOU MUST NOT SUBSTITUTE ROUTE B. Route A: keep the draft as a blob and let the
draft screen read/write family from it. Route B (make a draft create real person/employment rows in a
'draft' state) was REJECTED in the plan because it inverts the invariant above and would force headcount,
payroll eligibility, leave accrual, reports and RLS all to learn a new state. If you find yourself needing
Route B, stop and report it.

BUILD:
1. Family on the draft: the same add / edit / view / delete the active record offers, stored in the draft
   blob. lib/employee-draft-schema is where the shape and the completeness rule live.
2. MATERIALISATION AT ACTIVATION is the hard part and the reason this is stage one: turning blob entries
   into employee_dependent rows must be idempotent and all-or-nothing WITH the rest of activation. A
   half-activated employee with some dependants is worse than a failed activation.
3. Tests on the activation path asserting FIELD BY FIELD that everything entered on the draft survives
   Activate with nothing retyped. Do not spot-check — a silently dropped field is the exact failure this
   whole item exists to prevent.

DO NOT LOSE ON THE WAY: company and the reserved employee code stay read-only (saveEmployeeDraft pins
them); save-without-validation must still work — that is what a draft IS; and discard must still release
the reserved code back to its issuing config, or to the tenant counter when reservedConfigId is null.

⚠️ SCOPE FENCE, AND IT IS ABOUT A MERGE CONFLICT, NOT TASTE: do NOT modify anything under
app/admin/personnel/[employmentId]/**. Another workstream is restructuring that screen's save behaviour
this round. If reusing one of its components looks right, say so in your report and leave it for the next
round — the shared-component step is deliberately NOT in this stage.

No migration: the blob already exists and employee_dependent already exists.`,
  },
  {
    slug: 'leave-design',
    ns: 'r254leave',
    wt: `${WT}/r254-leave-design`,
    items: ['a6fe37fc'],
    brief: `Read the approved plan: ${PLANS}/a6fe37fc.txt, and the Phase 1 audit it refers to
(docs/audits/a6fe37fc-leave-config-audit.md).

⚠️ THIS IS A DESIGN DELIVERABLE, NOT A CODE ONE, AND THAT IS THE CUSTOMER'S OWN RULE. The approved plan
says: "We will come back to you with the proposed structure and screens before building. That is your own
Implementation Rule and it is the right one." So DO NOT build the new Leave Configuration module, do not
delete the old screens, and do not write a migration. Building now would break the promise they approved.

WHAT TO PRODUCE:
1. docs/design/a6fe37fc-leave-config-ia.md — the proposed structure, organised around what the customer is
   actually configuring, which the plan states as: the leave type, who is eligible, what they are entitled
   to, how it is applied for, and who approves it. Map EVERY function of the current nine screens onto the
   new structure, and name anything that has no home — a rebuild that silently drops a function is the
   failure mode here. The audit found four screens sharing one name and settings arranged by how the code
   grew; show concretely how the new structure fixes that.
2. MOCKUPS of each proposed screen as HTML, rendered to PNG with \`pnpm mockup <in.html> <out.png>\`. READ
   scripts/mockup/README.md FIRST — a mockup is a PROMISE, and a picture cannot hedge the way a sentence
   can. Do not draw a control you are not confident can be built, and do not invent data: the audit
   records the customer's real shape (45 template lineages all with valid_to IS NULL, only 4 eligibility
   rules in the whole tenant, Annual Leave carrying 16 tables against 2 rules).
3. docs/design/a6fe37fc-migration-order.md — the order of build, cutover and removal that keeps something
   working at every point, including the reconciliation the plan PROMISED: every one of the 261 approval
   rules must still reach the same approver for the same real employee, before and after. Describe how
   that comparison will actually be run.

⚠️ THE ONE THING THAT STAYS: the code that turns rules into a number of days. The plan says so explicitly
— the customer's 297 balance records were produced by it and are reconciled against it. Your structure
must sit ON TOP of that engine, not replace it. Say so in the document.

⚠️ AND THE CUSTOMER'S OWN CONSTRAINT: do not propose dropping any table that holds both configuration and
transaction data. Their leave tables hold 261 approval rules, 297 balances, 42 applications and 115
recalculation records. The tables stay.

No code changes outside docs/ and the mockup sources. No migration. Commit the documents and the PNGs.`,
  },
];

const built = await parallel(
  WORK.map((w) => () =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${w.wt}
YOUR BRANCH:   r254/${w.slug}
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
      `ADVERSARIAL VERIFICATION of workstream "${w.slug}" on branch r254/${w.slug}, worktree ${w.wt}.

You are NOT the builder and you take nothing on trust. Put \`cd ${w.wt} &&\` in every bash command. Your
TEST_DB_NAMESPACE is ${w.ns}v. Run ONLY targeted tests, never the full suite.

Read the approved plan (${w.items.map((i2) => `${PLANS}/${i2}.txt`).join(', ')}) and the branch diff
(\`git diff main...HEAD\`). The builder reported:

${JSON.stringify(b, null, 2)}

LOOK FOR, IN THIS ORDER:
1. A DEFECT THIS BRANCH INTRODUCED. Rank highest; set introducedByThisBranch.
2. MONEY. For payitem-orp especially: does the backfill genuinely preserve every existing overtime figure?
   Re-derive it — do not accept the builder's golden test as proof without checking it would fail if the
   backfill were wrong. A switch installed with the wrong default silently changes real pay.
3. A GUARD THAT CANNOT FAIL. Re-derive the non-vacuity claim YOURSELF: cp copy, revert the change, run the
   named assertion, confirm it fails, restore. This repo has shipped vacuous guards whose authors
   sincerely believed they had tested them. Set nonVacuityRederived only if you actually did this.
4. THE PLAN'S PROMISE vs WHAT SHIPPED. Anything promised and not built, built differently, or built that
   the plan did not promise, is a finding. For leave-design: the deliverable is DOCUMENTS AND MOCKUPS —
   if it wrote module code, that breaks the customer's Implementation Rule and is a blocker.
5. SCOPE FENCES CROSSED:
   payitem-orp → ORP formula unchanged; "Work it out automatically" kept; the customer's incorrect worked
     example NOT implemented; premise actually checked rather than assumed;
   personnel-save → bucket (b) actions still have their own buttons and are NOT covered by the tab's
     Discard; effective dating preserved (close+insert, services called per section, no blanket write);
     app/admin/personnel/new/** untouched;
   draft-family → Route B not substituted; app/admin/personnel/[employmentId]/** untouched; save-without-
     validation still works; reserved code still released on discard;
   leave-design → no module code, no migration, no table proposed for dropping, the day-count engine
     retained, every current function mapped or explicitly named as homeless.
6. A user-visible string that is wrong, untranslated, or renders MISSING_MESSAGE.
7. A comment that is now false, or a mockup that promises a control nobody could build.

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

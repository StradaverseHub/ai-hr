export const meta = {
  name: 'r259-fix-verified',
  description: 'One fix pass over the r259 verify findings; the parent hand-checks after',
  phases: [{ title: 'Fix' }],
};

// AGENTS 23b: ONE fix pass, then hand-fix.
const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const PLANS = '/tmp/r259plans';
const FIND = '/tmp/r259fix';

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
    slug: 'my-profile',
    ns: 'r259profilef',
    item: '9583deac',
    extra: `⚠️ YOUR BLOCKER IS AN EMPLOYEE SEEING TWO DIFFERENT ADDRESSES ON ONE CARD, WITH A SAVE BUTTON
THAT CHANGES NEITHER OF THEM. It was proved live with planted sentinels, not reasoned about: the served
HTML carries BOTH the read-only Permanent band (person.permanent*) and an editable fold-out bound to the
legacy person.addressLine1..country, and core/profile.ts updateOwnContact writes ONLY the legacy columns.
So the employee edits an address, saves, and the address displayed on that same card does not move —
while phone and personal email on the SAME card do update, because those columns are shared. Before this
round /me rendered only the legacy form and was self-consistent; this branch introduced the
contradiction.

IT ALSO BREAKS A PROMISE IN THE APPROVED PLAN, in the reporter's own words: "My Profile will not hold a
second copy of anybody's information. It reads the Personnel record and writes requests against it, so
there is only ever one master." Two address column families rendered on one card is precisely a second
copy.

FIX IT INSIDE THE FENCE AND DO NOT INVENT A MIGRATION. The two honest options the verifier names:
render the legacy home address READ-ONLY too (so everything on the card is consistent and the fold-out
edits what it displays), or drop the two Personnel address bands from /me until the columns are unified.
Pick one, say which and why, and make the card self-consistent: WHAT IS DISPLAYED IS WHAT SAVE CHANGES.
Whichever you choose, add a test that would have caught it — plant two different address values and
assert the card cannot show one while saving the other.

⚠️ MAJOR 1 — YOU FORKED THE FIELD LIST, WHICH IS THE DRIFT THIS ITEM WAS RAISED ABOUT.
The approved plan's build note says: "A READ surface: reuse the Personnel section components with an
employee-scoped read, do NOT fork them." app/me/read-field.tsx plus a hand-re-listing of every field in
app/me/page.tsx is a second, independent enumeration; only the label KEYS are shared. A field added to a
Personnel group will silently never appear on /me and nothing goes red.
The verifier names the route you did not take: components/person-details-fields.tsx is 'use client' with
an explicit mode:'form' branch that takes NO function props precisely so a server page can mount it (its
own header says so), and Personnel mounts it. The Family tab's own read-only idiom — <fieldset disabled>
around the EDIT layout, so "the read-only view can never drift from the Edit layout" — was available too.
Either mount the shared component, or, if you have a concrete reason you cannot, ADD THE GUARD THAT
CLOSES THE GAP: enumerate the people.detail.* fields Personnel renders and require each to be either on
/me or on the withheld list. Today the guard only runs manifest->Personnel and manifest->page, so the
Personnel->/me direction is unguarded. Say plainly which you did.

⚠️ MAJOR 2 — CONCURRENT EMPLOYMENTS LOST THEIR PAY. For an employee with two active employments
(ADR-0009, seeded as Daniel Tan) the retired Overview tab showed "Basic + allowance" for EVERY position;
now the "My positions" card drops the figures and the Payroll tab shows ONE unlabelled figure for the
primary employment with no company on it. The second employment's contractual pay renders nowhere.
Proved: basic 11000.00 renders, 4000 appears 0 times, 500.00 appears 0 times. This is a REMOVAL of
information the employee could previously see about themselves, and it is on neither the withheld list
nor notBuilt. Restore per-employment pay, labelled with its company, or put it on the withheld list with
a reason the reporter can read — do not leave it merely absent.

THEN THE MINORS:
- The redaction guard is weaker than its own docstring: both halves check a HARDCODED list of 12 column
  names instead of being driven by ME_HIDDEN_FIELDS, so a withheld-class column outside that list is
  added silently. Drive it from the manifest.
- Three me.* catalogue entries orphaned by the rewrite are dead in all six locales and still ship on
  every /me request because next-intl serialises the namespace into the client payload. Remove them,
  after checking nothing else resolves them.
- The field-visibility document is not the exhaustive account it declares itself to be: the Personnel
  Payroll tab's CP38 instalment orders and Zakat summary are on neither table. Complete it, and correct
  its own claim about when it was written — the plan promised the list BEFORE the build and it was
  written during. Say so in the document rather than letting the title overstate it.

SCOPE FENCE: app/me/**, the shared personnel components ONLY where a second consumer needs a prop (say
so), your tests, docs/, six locales. No migration. Do NOT touch app/admin/leave-config/**.`,
  },
  {
    slug: 'leave-round3',
    ns: 'r259leavef',
    item: 'a6fe37fc',
    extra: `YOUR VERDICT WAS "ship" WITH THREE MINORS AND NO BLOCKER OR MAJOR. Fix them.

- ⚠️ THE HALF-DAY PICKER'S adminOnly COMPANY SCOPE IS SECURITY-ADJACENT AND PINNED BY NO TEST, on the one
  genuinely new screen in the round. Silently widening it would pass every guard. Pin it: assert the
  company list the picker offers is the adminOnly scope and not the full tenant list, and prove the
  assertion can fail by widening it in a cp copy.
- The ?saved= / ?warning= / ?error= banners on company-rules are unreachable markup until Round 5 —
  including the premium-equivalent banking-risk warning, which is the one that matters. Either wire the
  actions' redirects so the banners can actually appear on the new screen, or say in "remaining" that
  they are deliberately dormant until the Round 5 cutover repoints the redirect constants. Do not leave
  a risk warning that cannot be shown without saying so.
- Navigation inside the preview module is inconsistent: the area map on all seven new pages links only to
  OLD addresses, while three of the new pages' back-links point INTO the new module. Make it consistent
  and say which direction you chose. The module is a preview until Round 5, so pointing the map at the
  old addresses is defensible — but then the back-links should match, and vice versa.

DO NOT touch app/admin/leave/**, components/leave-type-panel.tsx, core/leave*, app/me/**, or any
migration. Do not edit the five old guards or test/pack-drift-allowlist.json.`,
  },
];

const fixes = await parallel(
  WORK.map((w) => () =>
    agent(
      `${COMMON}

YOUR WORKTREE: ${WT}/r259-${w.slug}
YOUR BRANCH:   r259/${w.slug}
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

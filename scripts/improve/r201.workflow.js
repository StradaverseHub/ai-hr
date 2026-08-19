/**
 * r201 — build the three items the reporter approved from r200's plans, and plan the three leave items
 * raised since.
 *
 * THE SPECIMENS ARE NOT AGENCY ARTWORK, AND THIS IS NOW MEASURED TWICE. The reporter attached a
 * "Socso Borang 8A.pdf", an "EPF Borang A.pdf" and a "TP1 Form 2026.pdf" and asked us to match the
 * official layouts. Their PDF metadata says otherwise: both statutory ones are
 * `Developer Express Inc. DXperience (tm) v23.2.5` — the SAME producer as the specimens the round that
 * originally built these forms identified as completed forms from another payroll system — and the TP1 is
 * `Microsoft Word 2019`. Neither PERKESO nor KWSP publishes a blank template for these.
 *
 * That does NOT make the item invalid: the corrections are about the agency's own wording, legal
 * references and field names, which the specimen is good evidence OF. It changes what we may claim and
 * what we may copy. Read the specimen as a field map, never clone another vendor's page as artwork, and
 * do not promise a fidelity we cannot source.
 */
export const meta = {
  name: 'r201',
  description: 'Build the three approved statutory/TP1 items; plan the three new leave items',
  phases: [
    { title: 'Build', detail: 'three approved items, one worktree each' },
    { title: 'Plan', detail: 'three newly raised leave items' },
    { title: 'Verify', detail: 'adversarial pass per built workstream' },
  ],
};

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    testsPass: { type: 'boolean' },
    summary: { type: 'string' },
    diffstat: { type: 'string' },
    commitSha: { type: 'string' },
    migrationTags: { type: 'array', items: { type: 'string' } },
    scriptsToRunByHand: { type: 'array', items: { type: 'string' } },
    scopeCuts: { type: 'array', items: { type: 'string' } },
    specimenFindings: { type: 'string', description: 'What the attached PDF actually showed, and anything in it that contradicts the approved plan.' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['testsPass', 'summary'],
};
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { trap: { type: 'string' }, detail: { type: 'string' }, severity: { type: 'string', enum: ['blocker','should-fix','note'] } },
      required: ['trap','detail','severity'] } },
    planFidelity: { type: 'string' },
    verdict: { type: 'string', enum: ['ship','fix-first','reject'] },
  },
  required: ['findings','verdict'],
};
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    plan: { type: 'string' }, mockupHtml: { type: 'string' }, verdictLine: { type: 'string' },
    alreadyBuilt: { type: 'string' },
  },
  required: ['plan'],
};

const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const MAIN = `${WT}/mainwt`;
const S = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad';
const PLANS = `${S}/plans`;
const SPEC = `${S}/specimens`;
const MOCKUPS = `${S}/mockups`;

const SPECIMEN_TRUTH =
  `⚠️ THE ATTACHED SPECIMEN IS NOT AGENCY ARTWORK, AND THAT IS MEASURED, NOT ASSUMED.\n` +
  `I extracted the reporter's attachment from the board and read its metadata:\n` +
  `  · ${SPEC}/borang-8a.pdf — Producer: Developer Express Inc. DXperience (tm) v23.2.5, 1 page, A4\n` +
  `  · ${SPEC}/borang-a.pdf  — Producer: Developer Express Inc. DXperience (tm) v23.2.5, 1 page, A4\n` +
  `  · ${SPEC}/tp1.pdf       — Producer: Microsoft Word 2019, 2 pages, A4\n` +
  `DXperience is a reporting toolkit: these are ANOTHER PAYROLL SYSTEM'S rendered output, the same finding ` +
  `the round that first built these forms recorded about the earlier attachments. PERKESO and KWSP publish ` +
  `no blank template for these forms.\n\n` +
  `WHAT THAT MEANS FOR YOU, PRECISELY:\n` +
  `  1. READ the specimen — it is excellent evidence of the AGENCY'S required wording, legal references, ` +
  `field names and column order, and that is what the reporter's corrections are about.\n` +
  `  2. Do NOT clone it as artwork. You are implementing what the agency asks for, not reproducing a ` +
  `competitor's page.\n` +
  `  3. The shelf fidelity stays 'agency-layout'. It must NEVER become 'official' — there is nothing ` +
  `official to be faithful to, and claiming otherwise on a statutory document is the one thing this repo ` +
  `has refused twice now.\n` +
  `  4. If the specimen CONTRADICTS the approved plan, say so in \`specimenFindings\` and follow the ` +
  `specimen where it is about the agency's wording — but never silently. The plan was written without ` +
  `being able to open it.\n`;

const BUILDS = [
  { slug: 'b8a', ns: 'r201b8a', id: '16f2aac1', migrations: [], title: 'Borang 8A — regenerate the printed layout',
    extra: SPECIMEN_TRUTH +
      `\nTHE PLAN ESTABLISHED FIVE OF THE REPORTER'S NINE CORRECTIONS ALREADY PRINT TODAY. Verify that ` +
      `before rebuilding anything: the four-field row, the payment-deadline line (its DATE RULE is already ` +
      `correct — only the sentence changes), the collecting-agent box, and most of the payment block.\n` +
      `THE ONE REAL RISK, named in the plan: the current column headings were DELIBERATELY SHORTENED ` +
      `because the full wording overflowed and printed "(1) Tarikh Berhenti(2) Status" as one run — a ` +
      `heading is not clipped. The reporter wants the long names back. Solve the overflow (wrap over two ` +
      `or three lines, measure it) rather than reintroducing the bug the comment records.\n` +
      `This item SUPERSEDES 621c929d, which was closed as already-built. Do not re-open that.` },
  { slug: 'bora', ns: 'r201bora', id: 'cc9f9420', migrations: [], title: 'EPF Borang A — re-configure the printed layout',
    extra: SPECIMEN_TRUTH +
      `\nTHE PLAN FOUND SIX OF NINE ALREADY BUILT, including the carry-forward subtotals. Three are ` +
      `genuinely new. Verify each before touching it.\n` +
      `⚠️ THE +1-MONTH RULE IS LOAD-BEARING AND PINNED: Borang A is the cycle month PLUS ONE; Borang 8A is ` +
      `the cycle month directly. A joint test fails if the two ever agree. Do not disturb it.` },
  { slug: 'tp1', ns: 'r201tp1', id: '7ad37961', migrations: ['0444_tp1_status_values', '0445_tp1_approval'],
    title: 'TP1 Relief — redesign and complete the LHDN TP1 (2026) form',
    extra: SPECIMEN_TRUTH +
      `\nLARGEST ITEM IN THE ROUND, and the plan says roughly HALF is already shipped. Establish what exists ` +
      `before proposing to replace it.\n` +
      `YOU HAVE TWO MIGRATION NUMBERS, and the split is the plan's own finding, not a formality: ` +
      `**0444** (journal idx 444, when 1781862544000) carries the tp1_status enum value additions ALONE, ` +
      `because in Postgres a new enum value cannot be USED in the same transaction that adds it; ` +
      `**0445** (idx 445, when 1781862545000) carries the columns and anything referencing those values. ` +
      `Append both to the journal in that order — it is APPEND-ONLY and must never be re-sorted. Both ship ` +
      `in one pass, so they are strictly ascending and cannot be skipped.\n` +
      `THE BACKFILL (existing submitted rows stamped approved so the payroll feed does not go dark) is a ` +
      `DATA change. If you write it as a script, deploy.sh will NOT run it — list it in scriptsToRunByHand ` +
      `with the source-the-env invocation, because node 18 on the box has no --env-file.` },
];

const PLAN_ITEMS = [
  { id: 'ad965821', title: 'Link maternity and paternity leave eligibility to the Personnel profile' },
  { id: '5f2e20fb', title: 'Date range and multi-select filter on Employee Leave History' },
  { id: '7daac043', title: 'Calendar days / working days option for advance notice' },
];

const house =
  `HOUSE RULES: Next.js 16 — read node_modules/next/dist/docs/ before anything framework-shaped. Use ` +
  `\`graphify explain\` / \`graphify affected\` from ${MAIN} (read-only) before grepping cold. i18n in all ` +
  `six locales, resolved from the namespace the screen actually reads. A new or moved guarded page.tsx ` +
  `needs its lib/permissions.ts column. A new core/ file imports packs/<pack>/service, never a pack ` +
  `implementation, and NEVER edit test/pack-drift-allowlist.json — it is scanned from the FILESYSTEM, so a ` +
  `stray scratch file in your tree trips it. Delete anything throwaway before you finish. Every ` +
  `state-changing service appends a DomainEvent. A field that is always submitted cannot be read by ` +
  `presence. If a guard asserts the decision you are reversing, UPDATE the case. THE COMMENT IS THE GUARD ` +
  `— if you falsify a documented invariant, fix EVERY statement of it.\n`;

const gate =
  `GATE: \`npx tsc --noEmit\` clean · your new/changed tests green (namespaced) · \`pnpm build\` compiles. ` +
  `No dev server, no watch mode, nothing long-lived. Long output to a file with \`> log 2>&1\`, never a ` +
  `pipe. Never weaken or delete a test to go green. When green: \`git add -A\` and commit on your branch.\n`;

phase('Build');
phase('Plan');
phase('Verify');

const plans = parallel(PLAN_ITEMS.map((it) => () =>
  agent(
    `Write the board plan for newly raised item \`${it.id}\` — ${it.title}.\n\n` +
      `⚠️ READ-ONLY. Do not edit, commit, or touch any worktree. You may read ${MAIN} and use graphify. ` +
      `Other agents are building in sibling worktrees and running namespaced vitest — do NOT run vitest ` +
      `yourself, do not start a dev server.\n\n` +
      `THE ITEM: ${PLANS}/${it.id}.md — the reporter's own words, read in full first.\n\n` +
      `INVESTIGATE BEFORE PROPOSING. Of the last ten items planned on this board, EVERY ONE reported ` +
      `something already built and two were exact duplicates of shipped work. All three of these are LEAVE ` +
      `items, and leave has had a lot of recent work: r199 shipped role-aware ESS placement (5ff7daff) and ` +
      `an entitlement-status caption (31e39d74). Check against that before proposing anything new, and ` +
      `report what already works in \`alreadyBuilt\` with file:line.\n\n` +
      `FORMAT — read ${MAIN}/.claude/skills/feedback-plan/SKILL.md and follow it exactly. PLAIN TEXT only: ` +
      `no Markdown, no asterisks, no backticks, no pipes, no headers. UPPERCASE section labels, "- " ` +
      `bullets, blank lines between sections. Business language above a plain dashed line; all technical ` +
      `detail in a BUILD NOTES trailer below it. NEVER ask the reporter to choose between options — approve ` +
      `carries no payload. Pick the best course and say "reject with a reason if you would rather have X".\n\n` +
      `MOCKUP: write a self-contained HTML mockup to ${MOCKUPS}/${it.id}.html (everything inline; the ` +
      `renderer blocks external requests and fails loudly). Use the reporter's own data where you have it, ` +
      `never invented employees or figures. Draw only what will be built. Return its absolute path.`,
    { schema: PLAN_SCHEMA, phase: 'Plan', label: `plan:${it.id}`, effort: 'high' },
  ).then((p) => ({ id: it.id, title: it.title, ...p }))
));

const built = await pipeline(
  BUILDS,
  (w) => agent(
    `You are implementing APPROVED board item \`${w.id}\` — ${w.title}.\n\n` +
      `🔒 WORKTREE (made from main, node_modules symlinked, .env.local copied): ${WT}/r201-${w.slug} ` +
      `(branch build/r201-${w.slug}). \`cd\` there FIRST and confirm with \`pwd\` and ` +
      `\`git branch --show-current\` — this repo has shipped green gates for the wrong tree four times. Run ` +
      `every command from there. READ ${MAIN} freely; never edit it, never touch a sibling worktree.\n\n` +
      `TEST DB NAMESPACE \`${w.ns}\` on EVERY vitest run:\n    TEST_DB_NAMESPACE=${w.ns} pnpm vitest run test/<file>.test.ts\n` +
      `Never omit it, never invent another, never run the full suite.\n\n${house}` +
      (w.migrations.length
        ? `MIGRATIONS: you are allocated ${w.migrations.length} — ${w.migrations.join(' then ')}.\n`
        : `NO MIGRATION for your workstream. If the item cannot be built without one, STOP and return ` +
          `testsPass=false saying so — never allocate a number yourself.\n`) +
      `\n${gate}\n` +
      `THE APPROVED PLAN — read it IN FULL before writing code: ${PLANS}/${w.id}.md. Implement exactly it, ` +
      `scoped strictly to it. Where it says something already exists, VERIFY that before rebuilding or ` +
      `trusting it.\n\n${w.extra}\n\n` +
      `Return the schema fields honestly, including specimenFindings, scopeCuts and scriptsToRunByHand.`,
    { schema: BUILD_SCHEMA, phase: 'Build', label: `build:${w.slug}`, effort: 'xhigh' },
  ).then((b) => ({ w, b })),
  (prev) => {
    if (!prev?.b) return { w: prev?.w, b: null, v: null };
    const { w, b } = prev;
    if (!b.testsPass) { log(`build:${w.slug} RED — skipping verify`); return { w, b, v: null }; }
    return agent(
      `Adversarially review a change its author says is green. Find what a targeted test run structurally ` +
        `cannot see. Branch build/r201-${w.slug} in ${WT}/r201-${w.slug}; read it with ` +
        `\`git diff main...HEAD\`. READ-ONLY — no edits, and do NOT run the test suite (a second vitest ` +
        `wipes a sibling's databases).\n\n` +
        `Check: i18n keys in all six catalogues with matching placeholders and the right namespace; new or ` +
        `moved guarded pages have their lib/permissions.ts column; new core/ files import the pack facade; ` +
        `DomainEvents on state changes; migrations present ONLY if allocated (${w.migrations.join(', ') || 'NONE'}) ` +
        `with the journal APPENDED not re-sorted, and — for TP1 — the enum-value migration strictly BEFORE ` +
        `anything using those values; no test weakened, deleted or narrowed; a guard asserting the opposite ` +
        `UPDATED not deleted; THE COMMENT IS THE GUARD; presence-vs-value on form fields; RSC boundary ` +
        `risk; and plan fidelity in BOTH directions against ${PLANS}/${w.id}.md.\n` +
        `SPECIFICALLY: the shelf fidelity for a statutory form must NOT have become 'official'. The ` +
        `reporter's specimen is another vendor's rendering (DXperience / Word), not agency artwork, so ` +
        `there is nothing official to claim faithfulness to. Check what the diff claims.\n` +
        `Also check any printed-form column headings actually FIT — the previous implementation shortened ` +
        `them because the full wording overflowed and ran two headings together, and this round puts the ` +
        `long names back.\n\n` +
        `The author's summary, to test rather than trust:\n${b.summary}\n\n` +
        `Report only what you can point at in the diff. "No findings" is valid and useful.`,
      { schema: VERIFY_SCHEMA, phase: 'Verify', label: `verify:${w.slug}`, effort: 'high' },
    ).then((v) => {
      const n = (v?.findings || []).filter((f) => f.severity === 'blocker').length;
      log(`verify:${w.slug} → ${v?.verdict ?? 'none'}${n ? ` (${n} blocker(s))` : ''}`);
      return { w, b, v };
    });
  },
);

const planned = await plans;
const builds = built.filter(Boolean).map((r) => ({
  slug: r.w?.slug, id: r.w?.id, branch: `build/r201-${r.w?.slug}`,
  testsPass: !!r.b?.testsPass, commitSha: r.b?.commitSha || '', migrationTags: r.b?.migrationTags || [],
  diffstat: r.b?.diffstat || '', summary: r.b?.summary || '', scopeCuts: r.b?.scopeCuts || [],
  scriptsToRunByHand: r.b?.scriptsToRunByHand || [], specimenFindings: r.b?.specimenFindings || '',
  blockers: r.b?.blockers || [], verdict: r.v?.verdict || 'not-verified', findings: r.v?.findings || [],
}));

log(`r201: ${builds.filter((b) => b.testsPass).length}/${builds.length} green · ` +
  `${builds.filter((b) => b.verdict === 'ship').length} ship · ${(planned || []).filter(Boolean).length} plans`);
return { builds, plans: (planned || []).filter(Boolean) };

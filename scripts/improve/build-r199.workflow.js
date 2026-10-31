/**
 * r199 — the five items the reporter approved this morning, in four workstreams.
 *
 * MIGRATION NUMBERING, AND A TRAP THIS ROUND CREATES. main's last journal entry is 441. `0442` is claimed
 * by build/r197-entity, which is HELD with a live blocker and unmerged. r199's only migration is therefore
 * **0443**. Consequence, recorded here and in HANDOFF because nothing else will surface it: once 0443
 * reaches production, drizzle's watermark is past 0442, so if the entity branch ever merges carrying
 * `0442` it will be SILENTLY SKIPPED (AGENTS rule 14). Entity's migration is DEAD — when that item is
 * reworked it must take a fresh number.
 */
export const meta = {
  name: 'build-r199',
  description: 'Build the five newly approved items in four workstreams; one migration (0443)',
  phases: [
    { title: 'Build', detail: 'four workstreams, one worktree each' },
    { title: 'Verify', detail: 'adversarial pass per workstream' },
  ],
};

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    testsPass: { type: 'boolean' },
    summary: { type: 'string' },
    diffstat: { type: 'string' },
    commitSha: { type: 'string' },
    migrationTag: { type: 'string' },
    scriptsToRunByHand: { type: 'array', items: { type: 'string' }, description: 'Any script the round depends on that deploy.sh will NOT run.' },
    scopeCuts: { type: 'array', items: { type: 'string' } },
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

const WT = '/Users/zenlam/Projects/ai-hr/.claude/worktrees';
const MAIN = `${WT}/mainwt`;
const PLANJSON = '/private/tmp/claude-501/-Users-zenlam-Projects-ai-hr/3f8384ff-9d5e-4d50-8ed7-8efcb46feb13/scratchpad';

const WORK = [
  { slug: 'stamp', ns: 'r199stamp', ids: ['6b134681', '417d4937'], migration: null,
    title: 'Bonus runs must record per-item detail; and the consumed marker must agree with the payslip',
    extra:
      `THESE TWO IDS ARE ONE ROOT CAUSE AND THE REPORTER HAS ALREADY REJECTED ONE ATTEMPT AT THEM. Measured ` +
      `on production 2026-08-18, and re-verify it rather than trusting me:\n` +
      `  · REGULAR runs: 62 payslips, 24 carry a componentLines stamp. BONUS runs: 19 payslips, ZERO carry ` +
      `one. The additional/bonus run path never writes componentLines at all.\n` +
      `  · So a bonus payslip has nothing that says "ANGPOW" (pay code BOOO1 — that is the letter O three ` +
      `times, not zeros), and every screen falls back to the box label, which reads BONUS. The r196 fix ` +
      `reads componentLines, so it is structurally inert there. The reporter's three attempts could not ` +
      `have worked.\n` +
      `  · The money is CORRECT — A0002's January bonus payslip carries 500.00. This is a naming fault.\n` +
      `  · For 417d4937: the SpaceX 2026-08 Director Fee row has batch_id set and consumed_batch_id NULL ` +
      `while its payslip stamp shows the line as paid. The approved plan calls for a backfill to reconcile ` +
      `that. A BACKFILL IS A SCRIPT, AND deploy.sh RUNS MIGRATIONS, NOT SCRIPTS (AGENTS rule 13) — so it ` +
      `must be idempotent, must have a --apply/dry-run split like the repo's other scripts, and you must ` +
      `list it in scriptsToRunByHand or the round will ship half-armed.\n` +
      `Whatever you stamp, the itemised lines MUST reconcile to the figure they sit under — r196 built ` +
      `payItemLinesReconcile for exactly this and a bonus stamp that does not add up would re-create the ` +
      `defect one screen further along.` },
  { slug: 'paysettings', ns: 'r199paysettings', ids: ['6df24751'], migration: '0443_payroll_cycle_updated_at',
    title: 'Payroll Settings — redesign Payroll Cycles / Pay Schedule',
    extra:
      `LARGEST ITEM IN THE ROUND, and its own approved plan suggests sequencing it as several branches. You ` +
      `have ONE. Build the coherent core, and put anything you deliberately leave for a follow-up in ` +
      `scopeCuts with a reason — a partial build that is honest about its edges is worth far more than a ` +
      `sprawling one that is not. Your migration is 0443, journal idx 443, when 1781862543000: a NULLABLE ` +
      `updated_at on payroll_cycle. ADD COLUMN inherits the table's grants; only CREATE TABLE owes a GRANT. ` +
      `The journal is APPEND-ONLY — never re-sort it.` },
  { slug: 'txnsearch', ns: 'r199txnsearch', ids: ['bd14b7e2'], migration: null,
    title: 'Payroll Transaction View — standardize the employee search UI',
    extra: `The plan scopes this to ONE page (app/payroll/transaction-view/page.tsx), four tabs, no reads and ` +
      `no core/ change. Hold that line: this round also touches payroll screens in a sibling worktree, and ` +
      `every file you touch outside your page is a merge conflict someone else has to resolve blind.` },
  { slug: 'holidays', ns: 'r199holidays', ids: ['4509d2b8'], migration: null,
    title: 'Relocate Holidays to System Settings',
    extra: `Nav placement only — no migration, no schema change, no service change. The plan notes ` +
      `core/holidays.ts is SPINE, not the attendance pack; do not "tidy" it into a pack import. Moving a ` +
      `guarded page means the function-access matrix in lib/permissions.ts must follow it, or ` +
      `test/function-access.test.ts fails on a route nobody can grant.` },
];

const house =
  `HOUSE RULES: Next.js 16 — read node_modules/next/dist/docs/ before anything framework-shaped. Use ` +
  `\`graphify explain\` / \`graphify affected\` from ${MAIN} (read-only) before grepping cold. i18n in all six ` +
  `locales, resolved from the namespace the screen actually reads. A new or MOVED guarded page.tsx needs its ` +
  `column in lib/permissions.ts. A new core/ file imports packs/<pack>/service, never a pack implementation, ` +
  `and NEVER edit test/pack-drift-allowlist.json — it is scanned from the FILESYSTEM, so even a stray ` +
  `scratch file in your tree trips it. Every state-changing service appends a DomainEvent. A field that is ` +
  `always submitted cannot be read by presence. If a guard asserts the decision you are reversing, UPDATE ` +
  `the case, never delete it. THE COMMENT IS THE GUARD — if your change falsifies a documented invariant, ` +
  `fix EVERY statement of it, not just the code that reads it.\n`;

const gate =
  `GATE: \`npx tsc --noEmit\` clean · your new/changed tests green (namespaced) · \`pnpm build\` compiles. ` +
  `No dev server, no watch mode, nothing long-lived. Long output to a file with \`> log 2>&1\`, never a pipe; ` +
  `if a command runs past ~3 minutes with no output, kill it and report it as a blocker. Never weaken, skip ` +
  `or delete a test to go green. When green: \`git add -A\` and commit on your branch.\n`;

phase('Build');
phase('Verify');

const results = await pipeline(
  WORK,
  (w) => agent(
    `You are implementing APPROVED board item(s) ${w.ids.join(' + ')} in the ai-hr codebase.\n\n` +
      `WORKSTREAM: ${w.title}\n\n` +
      `🔒 WORKTREE (already made from main, node_modules symlinked, .env.local copied): ${WT}/r199-${w.slug} ` +
      `(branch build/r199-${w.slug}). \`cd\` there FIRST and confirm with \`pwd\` and ` +
      `\`git branch --show-current\` — this repo has shipped green gates for the wrong tree four times. Run ` +
      `every command from there. READ ${MAIN} freely; never edit it, never touch a sibling worktree.\n\n` +
      `TEST DB NAMESPACE \`${w.ns}\` on EVERY vitest run:\n    TEST_DB_NAMESPACE=${w.ns} pnpm vitest run test/<file>.test.ts\n` +
      `Never omit it, never invent another, never run the full suite — the parent gates once, alone.\n\n` +
      `${house}` +
      (w.migration
        ? `MIGRATION: you are allocated EXACTLY ONE — db/migrations/${w.migration}.sql, journal idx 443, ` +
          `when 1781862543000. Hand-write the .sql AND append the journal entry.\n`
        : `NO MIGRATION for your workstream. If you conclude your item cannot be built without one, STOP and ` +
          `return testsPass=false saying so — never allocate a number yourself.\n`) +
      `\n${gate}\n` +
      `THE APPROVED PLAN(S) — the reporter approved these THIS MORNING. Read each IN FULL before writing ` +
      `code; each JSON file's "plan" field is the text they approved:\n` +
      w.ids.map((id) => `    ${PLANJSON}/plan-${id}.json`).join('\n') +
      `\nImplement exactly the plan, scoped strictly to it. Where a plan says something already exists, ` +
      `VERIFY that in the code before rebuilding it or trusting it.\n\n${w.extra}\n\n` +
      `Return the schema fields honestly, including scopeCuts and scriptsToRunByHand.`,
    { schema: BUILD_SCHEMA, phase: 'Build', label: `build:${w.slug}`, effort: 'xhigh' },
  ).then((b) => ({ w, b })),
  (prev) => {
    if (!prev?.b) return { w: prev?.w, b: null, v: null };
    const { w, b } = prev;
    if (!b.testsPass) { log(`build:${w.slug} RED — skipping verify`); return { w, b, v: null }; }
    return agent(
      `Adversarially review a change its author says is green. Find what a targeted test run structurally ` +
        `cannot see. Branch build/r199-${w.slug} in ${WT}/r199-${w.slug}; read it with ` +
        `\`git diff main...HEAD\`. READ-ONLY — no edits, and do NOT run the test suite (a second vitest ` +
        `wipes a sibling's databases).\n\n` +
        `Check: i18n keys in all six catalogues with matching placeholders and the right namespace; a new or ` +
        `MOVED guarded page has its lib/permissions.ts column; new core/ files import the pack facade; ` +
        `DomainEvents on state changes; migration present only if allocated (${w.migration ?? 'NONE'}) and ` +
        `the journal APPENDED not re-sorted; no test weakened, deleted or narrowed; a guard asserting the ` +
        `opposite UPDATED not deleted; THE COMMENT IS THE GUARD — does the diff falsify a documented ` +
        `invariant and leave the sentence standing anywhere in the repo; presence-vs-value on form fields; ` +
        `RSC boundary risk; plan fidelity in BOTH directions against the approved plan.\n` +
        (w.slug === 'stamp'
          ? `SPECIFICALLY FOR THIS ONE: the reporter already rejected one attempt. Do the itemised lines ` +
            `provably reconcile to the figure they sit under on a BONUS run? Construct a case where they ` +
            `would not. And if a backfill script was written: is it idempotent, does it have a dry-run, and ` +
            `is it listed as needing a hand run — deploy.sh will not run it.\n`
          : '') +
        `\nThe author's summary, to test rather than trust:\n${b.summary}\n\n` +
        `Report only what you can point at in the diff. "No findings" is valid and useful.`,
      { schema: VERIFY_SCHEMA, phase: 'Verify', label: `verify:${w.slug}`, effort: 'high' },
    ).then((v) => {
      const n = (v?.findings || []).filter((f) => f.severity === 'blocker').length;
      log(`verify:${w.slug} → ${v?.verdict ?? 'none'}${n ? ` (${n} blocker(s))` : ''}`);
      return { w, b, v };
    });
  },
);

const out = results.filter(Boolean).map((r) => ({
  slug: r.w?.slug, ids: r.w?.ids, branch: `build/r199-${r.w?.slug}`,
  testsPass: !!r.b?.testsPass, commitSha: r.b?.commitSha || '', migrationTag: r.b?.migrationTag || '',
  diffstat: r.b?.diffstat || '', summary: r.b?.summary || '', scopeCuts: r.b?.scopeCuts || [],
  scriptsToRunByHand: r.b?.scriptsToRunByHand || [], blockers: r.b?.blockers || [],
  verdict: r.v?.verdict || 'not-verified', findings: r.v?.findings || [],
}));
log(`r199: ${out.filter((o) => o.testsPass).length}/${out.length} green · ${out.filter((o) => o.verdict === 'ship').length} ship`);
return out;

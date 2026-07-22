/**
 * Batch feedback planner (ADR-0044, IL-3). Same draft → adversarial-critique → refine pipeline as
 * feedback-refine.workflow.js, but over a BATCH of feedback items (passed as `args`, a JSON array from
 * `improve:pull`). Items flow through the three stages independently (pipeline, no barrier), so one item
 * can be refining while another is still drafting. Returns one push-ready record per item.
 *
 * Invoke:  Workflow({ scriptPath: 'scripts/improve/feedback-refine-batch.workflow.js', args: <pull array> })
 *   → [{ id, tenantId, reporterEmploymentId, title, plan, model, ... }]  → push each with improve:push-plan.
 */
export const meta = {
  name: 'feedback-refine-batch',
  description: 'Plan a batch of feedback items — each draft → critics fight back → refine',
  phases: [
    { title: 'Draft', detail: 'ground a first plan per item' },
    { title: 'Critique', detail: 'a panel of critics fights back from distinct lenses' },
    { title: 'Refine', detail: 'synthesize a plan that answers the critiques' },
  ],
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plan: { type: 'string', description: 'Implementation plan in PLAIN TEXT (no Markdown — the /feedback UI shows it raw). At the Refine stage this MUST follow the feedback-plan skill skeleton: VERDICT/SIZE line, business sections, a dashed separator, then a BUILD NOTES trailer.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Key files/dirs the change touches.' },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['plan', 'files'],
};

const CRITIQUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' }, description: 'Concrete problems with the plan.' },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['issues', 'severity'],
};

const LENSES = [
  { key: 'correctness', ask: 'Will this actually work? Find wrong assumptions about the codebase, RLS, the substrate (DomainEvents), or the data model.' },
  { key: 'scope-creep', ask: 'Is anything here beyond what the feedback asked, or speculative/over-engineered? Name what to cut.' },
  { key: 'missing-edges', ask: 'What edge cases, migrations-on-both-DBs, i18n parity, byte-identical/backward-compat, or test gaps does the plan miss?' },
  { key: 'simpler-way', ask: 'Is there a materially simpler approach that reuses an existing pattern (claims/leave/resignation/etc.)? Describe it.' },
];

// The Workflow runtime delivers `args` as a JSON string; parse it (tolerate an already-parsed array too).
const items = (typeof args === 'string' ? JSON.parse(args || '[]') : args) || [];
const repo = '/Users/zenlam/Projects/ai-hr';

function briefOf(fb) {
  return [
    `Type: ${fb.category ?? 'unknown'}`,
    `Title: ${fb.title ?? ''}`,
    `Description: ${fb.description ?? ''}`,
    fb.expected_behavior ? `Expected behaviour: ${fb.expected_behavior}` : '',
    fb.expected_function ? `Expected function: ${fb.expected_function}` : '',
    fb.contest_reason ? `Contest reason (this item was previously planned and the reporter pushed back): ${fb.contest_reason}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const tag = (fb, i) => `${i}:${(fb.title || '').slice(0, 22)}`;

const results = await pipeline(
  items,
  // ── Draft ──────────────────────────────────────────────────────────────────
  (fb, _orig, idx) => {
    const priorContext =
      fb.status === 'contested' && fb.plan
        ? `\n\nA PREVIOUS plan was sent back by the reporter.\nPrevious plan:\n${fb.plan}\n\nThe reporter asked for: ${fb.contest_reason ?? ''}\nYour draft MUST address that.`
        : '';
    return agent(
      `You are a senior engineer on the ai-hr codebase at ${repo} (Next.js App Router, Drizzle ORM, ` +
        `PostgreSQL with RLS, next-intl, Vitest). Read the relevant existing code there (services in core/, ` +
        `schema in db/schema.ts, pages in app/, the test conventions in test/) and write a concrete, ordered ` +
        `implementation plan for this product feedback. Cover the data-model/migration, service, UI, i18n ` +
        `(6 locales), and how to verify (tests + browser). Scope it to exactly what is asked — flag, but do ` +
        `not invent, extras.\n\n${briefOf(fb)}${priorContext}`,
      { schema: PLAN_SCHEMA, phase: 'Draft', label: `draft ${tag(fb, idx)}`, effort: 'high' },
    ).then((draft) => ({ draft }));
  },
  // ── Critique (4 lenses, parallel) ───────────────────────────────────────────
  (prev, fb, idx) =>
    parallel(
      LENSES.map((l) => () =>
        agent(
          `Adversarially critique this implementation plan for the ai-hr codebase at ${repo} through the ` +
            `**${l.key}** lens. ${l.ask} Read the code there to ground your critique. Be specific and harsh; ` +
            `if the plan is sound on this lens, say so with severity "low".\n\nFEEDBACK:\n${briefOf(fb)}\n\n` +
            `PLAN:\n${prev.draft.plan}\n\nFILES IT TOUCHES: ${(prev.draft.files || []).join(', ')}`,
          { schema: CRITIQUE_SCHEMA, phase: 'Critique', label: `critique:${l.key} ${idx}`, effort: 'high' },
        ).then((c) => ({ ...c, lens: l.key })),
      ),
    ).then((cs) => ({ draft: prev.draft, live: cs.filter(Boolean) })),
  // ── Refine ──────────────────────────────────────────────────────────────────
  (prev, fb, idx) => {
    const critiqueText = prev.live
      .map((c) => `### ${c.lens} (severity: ${c.severity})\n${(c.issues || []).map((i) => `- ${i}`).join('\n')}`)
      .join('\n\n');
    return agent(
      `Refine the implementation plan below to address EVERY valid critique from the panel. Where a critique ` +
        `is wrong, briefly note why you are not changing that part. Cut anything flagged as scope-creep.\n\n` +
        `FORMAT (CRITICAL) — the /feedback review screen shows this text RAW (no Markdown rendering) and the ` +
        `reviewer is a non-technical business consultant. Follow the feedback-plan skill's skeleton EXACTLY, ` +
        `plain text only:\n` +
        `  Line 1: VERDICT: <Not built yet | Partly there already | Already works>   ·   SIZE: <Quick | ` +
        `Moderate | Large> — exactly these two vocabularies; never small/medium/large, S/M/L, hours, or points.\n` +
        `  Then UPPERCASE sections with a blank line between each: THE SITUATION TODAY (2-4 plain sentences on ` +
        `what the user experiences right now); WHAT WE'LL CHANGE (one "- " bullet per change the user would ` +
        `notice); WHAT YOU'LL GET (1-3 sentences on the outcome in the reporter's terms); GOOD TO KNOW (only ` +
        `if relevant — already-partly-works, dependencies, timing).\n` +
        `  Then a plain line of dashes, then: BUILD NOTES (technical - skip this if you are reviewing the ` +
        `request) — ALL the engineering specifics (files, data changes, ordered steps, tests, edge cases), ` +
        `file/function names written plainly WITHOUT backticks. Technical terms are allowed ONLY here.\n` +
        `  Hard rules: NO Markdown characters anywhere (no ** or #, no backticks, no | tables, no > quotes; ` +
        `bullets are "- "). Above the dashes: zero developer terms — banned: migration, schema, RLS, enum, ` +
        `endpoint, API, component, boolean, null, backend, cron, service, plus any file path, function name, ` +
        `or line number. NEVER end the plan asking the reporter to pick an option — approving on the board ` +
        `sends no message back, so a plan that waits on a choice strands the item. If there is a real fork, ` +
        `choose the best option and state it as what WILL be built; note the alternative in GOOD TO KNOW as a ` +
        `possible follow-up.\n\n` +
        `FEEDBACK:\n${briefOf(fb)}\n\nORIGINAL PLAN:\n${prev.draft.plan}\n\nPANEL CRITIQUES:\n${critiqueText}`,
      { schema: PLAN_SCHEMA, phase: 'Refine', label: `refine ${tag(fb, idx)}`, effort: 'xhigh' },
    ).then((refined) => ({
      id: fb.id,
      tenantId: fb.tenant_id,
      reporterEmploymentId: fb.reporter_employment_id,
      title: fb.title,
      plan: refined.plan,
      files: refined.files,
      risks: refined.risks || [],
      model: 'improvement-loop/feedback-refine · opus-4-8 · 6-agent panel',
      critiquesAddressed: prev.live.length,
      highSeverityFound: prev.live.filter((c) => c.severity === 'high').length,
    }));
  },
);

return results.filter(Boolean);

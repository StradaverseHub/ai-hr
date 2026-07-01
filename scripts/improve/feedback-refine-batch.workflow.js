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
    plan: { type: 'string', description: 'A numbered, ordered implementation plan in PLAIN TEXT (no Markdown — the /feedback UI shows it raw).' },
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
        `FORMAT (CRITICAL) — the /feedback review screen shows this text RAW; it does NOT render Markdown, and ` +
        `the reviewer is a business stakeholder, NOT an engineer. So write the WHOLE plan as clean PLAIN TEXT: ` +
        `NO Markdown syntax at all — no ** bold, no # headers, no backticks, no tables, no > quotes. Use only ` +
        `plain-text structure: an UPPERCASE label on its own line for each section, "- " for bullets, and blank ` +
        `lines to separate. Structure it for THEM first:\n` +
        `  • Lead with a "SUMMARY (FOR REVIEW)" section in plain business language: the problem in everyday ` +
        `terms, what will change for the user, the visible outcome/benefit, a rough effort (small / medium / ` +
        `large) + risk read, and explicitly call out anything that ALREADY exists today. NO file paths, line ` +
        `numbers, table/column names, migration numbers, or framework jargon (RSC, RLS, etc.) in this section — ` +
        `a non-technical reader must be able to approve or push back on it.\n` +
        `  • THEN a "TECHNICAL DETAIL (FOR THE BUILD TEAM)" section (separate it with a plain line of dashes) ` +
        `carrying ALL the specifics (files, schema/migrations, ordered steps, tests, edge cases) the build agent ` +
        `needs — still as plain text, writing file/function names plainly without backticks. The reviewer reads ` +
        `the top; the build agent reads the bottom — keep both, concrete + verifiable.\n\n` +
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

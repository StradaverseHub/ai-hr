/**
 * Open-item planner (ADR-0044, IL-3) — a file-fed variant of feedback-refine-batch.workflow.js. Same
 * draft → adversarial-critique → refine pipeline, but each item's raw feedback lives in a file on disk
 * (`.improve/requests/<id>.md`) that the agents READ, so the workflow args stay tiny (just id, routing,
 * title, status, feedbackPath) instead of embedding every description inline. Items flow independently
 * (pipeline, no barrier). Returns one push-ready record per item → push each with improve:push-plan.
 *
 * Invoke:  Workflow({ scriptPath: 'scripts/improve/plan-open.workflow.js', args: <minimal array> })
 *   where each element is { id, tenant_id, reporter_employment_id, title, status, feedbackPath }.
 */
export const meta = {
  name: 'plan-open',
  description: 'Plan a batch of open feedback items (read from files) — draft → critics fight back → refine',
  phases: [
    { title: 'Draft', detail: 'read each item feedback file + code, ground a first plan' },
    { title: 'Critique', detail: 'a panel of critics fights back from distinct lenses' },
    { title: 'Refine', detail: 'synthesize a consultant-readable plan that answers the critiques' },
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

const items = (typeof args === 'string' ? JSON.parse(args || '[]') : args) || [];
const repo = '/Users/zenlam/Projects/ai-hr';
const tag = (fb, i) => `${i}:${(fb.title || '').slice(0, 22)}`;
const readInstr = (fb) =>
  `The RAW product feedback for this item is in a file — read it IN FULL with the Read tool from ${fb.feedbackPath ?? '(missing feedbackPath — stop and report this)'}. ` +
  `It contains the type, title, description, expected behaviour/function, and (if this item was contested) the previous plan plus the reporter's push-back you must address.`;

const results = await pipeline(
  items,
  // ── Draft ──────────────────────────────────────────────────────────────────
  (fb, _orig, idx) =>
    agent(
      `You are a senior engineer on the ai-hr codebase at ${repo} (Next.js App Router, Drizzle ORM, ` +
        `PostgreSQL with RLS, next-intl, Vitest). ${readInstr(fb)}\n\n` +
        `Then read the relevant existing code there (services in core/, schema in db/schema.ts, pages in app/, ` +
        `the test conventions in test/) and write a concrete, ordered implementation plan for this product ` +
        `feedback. Cover the data-model/migration, service, UI, i18n (6 locales), and how to verify (tests + ` +
        `browser). Scope it to exactly what is asked — flag, but do not invent, extras. If this item is ` +
        `contested, your draft MUST directly address the reporter's push-back.`,
      { schema: PLAN_SCHEMA, phase: 'Draft', label: `draft ${tag(fb, idx)}`, effort: 'high' },
    ).then((draft) => ({ draft })),
  // ── Critique (4 lenses, parallel) ───────────────────────────────────────────
  (prev, fb, idx) => {
    // If the draft itself was rate-limited/died, there is nothing to critique — carry the null forward.
    if (!prev || !prev.draft || !prev.draft.plan) return { draft: null, live: [] };
    return parallel(
      LENSES.map((l) => () =>
        agent(
          `Adversarially critique this implementation plan for the ai-hr codebase at ${repo} through the ` +
            `**${l.key}** lens. ${l.ask} Read the code there to ground your critique. ${readInstr(fb)} ` +
            `Be specific and harsh; if the plan is sound on this lens, say so with severity "low".\n\n` +
            `PLAN:\n${prev.draft.plan}\n\nFILES IT TOUCHES: ${(prev.draft.files || []).join(', ')}`,
          { schema: CRITIQUE_SCHEMA, phase: 'Critique', label: `critique:${l.key} ${idx}`, effort: 'high' },
        ).then((c) => ({ ...c, lens: l.key })),
      ),
    ).then((cs) => ({ draft: prev.draft, live: cs.filter(Boolean) }));
  },
  // ── Refine ──────────────────────────────────────────────────────────────────
  (prev, fb, idx) => {
    // No usable draft (rate-limited/died) ⇒ nothing to refine; drop the item (it will be re-planned).
    if (!prev || !prev.draft || !prev.draft.plan) return null;
    const draft = prev.draft;
    const critiqueText = (prev.live || [])
      .map((c) => `### ${c.lens} (severity: ${c.severity})\n${(c.issues || []).map((i) => `- ${i}`).join('\n')}`)
      .join('\n\n');
    return agent(
      `Refine the implementation plan below to address EVERY valid critique from the panel. Where a critique ` +
        `is wrong, briefly note why you are not changing that part. Cut anything flagged as scope-creep. ` +
        `${readInstr(fb)}\n\n` +
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
        `ORIGINAL PLAN:\n${prev.draft.plan}\n\nPANEL CRITIQUES:\n${critiqueText}`,
      { schema: PLAN_SCHEMA, phase: 'Refine', label: `refine ${tag(fb, idx)}`, effort: 'xhigh' },
    ).then((refined) => {
      // If refine was rate-limited/died, fall back to the (successful) draft plan rather than losing the item.
      const usedRefine = !!(refined && refined.plan);
      return {
        id: fb.id,
        tenantId: fb.tenant_id,
        reporterEmploymentId: fb.reporter_employment_id,
        title: fb.title,
        plan: usedRefine ? refined.plan : draft.plan,
        files: (usedRefine && refined.files) || draft.files || [],
        risks: (usedRefine && refined.risks) || [],
        model: usedRefine
          ? 'improvement-loop/plan-open · opus-4-8 · 6-agent panel'
          : 'improvement-loop/plan-open · opus-4-8 · draft-only (refine throttled)',
        critiquesAddressed: (prev.live || []).length,
        highSeverityFound: (prev.live || []).filter((c) => c.severity === 'high').length,
        refined: usedRefine,
      };
    });
  },
);

return results.filter(Boolean);

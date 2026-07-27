/**
 * Feedback planning agent FB-3 (ADR-0043). Contract:
 *   - reuses the AI gateway: resolves the tenant config, sends the feedback, stores the plan (status →
 *     planned, agent actor, revision bump);
 *   - PII redaction: emails / IC numbers in the free text are scrubbed before reaching the gateway;
 *   - gated twice, and both refusals are covered: OFF unless the tenant's `feedback.ai_planning_enabled`
 *     setting is true (ADR-0077 slice 3 — this was the FEEDBACK_AI_PLANNING_ENABLED env flag), and OFF
 *     with no AI config. Either way: FeedbackError, no LLM call, status untouched;
 *   - re-plan: a contested item's prompt carries the prior plan + the reporter's push-back.
 *
 * lib/ai generateDraft + core/ai-config resolveActiveAiConfig are mocked — never touches an SDK / key.
 * redactPII stays REAL (importActual) so redaction is genuinely exercised.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../lib/ai', async (importActual) => {
  const actual = await importActual<typeof import('../lib/ai')>();
  return { ...actual, generateDraft: vi.fn(async () => 'PLAN: 1. Do the thing. 2. Test it.') };
});
vi.mock('../core/ai-config', async (importActual) => {
  const actual = await importActual<typeof import('../core/ai-config')>();
  return {
    ...actual,
    resolveActiveAiConfig: vi.fn(async () => ({ provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-test' })),
  };
});

import { generateDraft } from '../lib/ai';
import { resolveActiveAiConfig } from '../core/ai-config';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  contestFeedbackPlan,
  FeedbackError,
  generateFeedbackPlan,
  getFeedback,
  submitFeedback,
} from '../core/feedback';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  eventTypesFor,
  migrateTestDb,
  resetDb,
  seedBase,
  setSetting,
  type Base,
} from './harness';

let base: Base;
/**
 * The context the agent runs on. It is `entitledCtx`, NOT `adminCtx`, and that is load-bearing after
 * ADR-0077 slice 3: the gate is now `settingEnabled(ctx, 'feedback.ai_planning_enabled')`, and
 * `adminCtx` carries a SYNTHETIC snapshot whose settings map is `legacyEnabledSettingsIn(process.env)`,
 * which the suite makes EMPTY — so it reads EVERY setting as its catalog default, `false` for this key.
 * Driven through `adminCtx` these tests would not fail loudly, they would all take the disabled branch,
 * so the fixture below resolves a REAL snapshot from the tenant's rows. The snapshot is a point-in-time
 * read, so it is built AFTER the `setSetting` that turns the agent on.
 */
let planCtx: SessionContext;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  // The in-app agent is gated off by default (ADR-0044): `feedback.ai_planning_enabled` is a
  // platform-scoped setting whose catalog default is false, and seedBase seeds no row for it.
  await setSetting(base.tenantId, 'feedback.ai_planning_enabled', true);
  planCtx = await entitledCtx(base);
  vi.mocked(generateDraft).mockReset().mockResolvedValue('PLAN: 1. Do the thing. 2. Test it.');
  vi.mocked(resolveActiveAiConfig)
    .mockReset()
    .mockResolvedValue({ provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-test' });
});
afterAll(async () => {
  await closeAll();
});

const hire = (name: string) =>
  hireEmployee(adminCtx(base), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const reporterCtx = async (personId: string): Promise<SessionContext> => {
  const uid = await createAppUser(base.tenantId, personId, 'employee');
  return { tenantId: base.tenantId, userId: uid, personId, roles: ['employee'] };
};

describe('FB-3 — feedback planning agent (ADR-0043)', () => {
  it('redacts the free text, calls the gateway, stores the plan (planned, agent actor)', async () => {
    const R = await hire('Planner Reporter');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'issue',
      title: 'Bug when emailing jane@acme.test',
      description: 'Crashes for IC 910101-01-1234 on the leave page.',
    });

    const { plan } = await generateFeedbackPlan(planCtx, { feedbackId: id });
    expect(plan).toContain('Do the thing');
    expect(generateDraft).toHaveBeenCalledTimes(1);

    // The gateway saw redacted text, not the raw PII.
    const { prompt } = vi.mocked(generateDraft).mock.calls[0][1];
    expect(prompt).toContain('[email]');
    expect(prompt).toContain('[id]');
    expect(prompt).not.toContain('jane@acme.test');
    expect(prompt).not.toContain('910101-01-1234');

    const d = (await getFeedback(adminCtx(base), id))!;
    expect(d.status).toBe('planned');
    expect(d.planRevision).toBe(1);
    expect(d.plan).toContain('Do the thing');
    expect(d.planModel).toBe('anthropic/claude-opus-4-8');
    expect(await eventTypesFor(base.tenantId, id)).toContain('feedback.plan.drafted');
  });

  it('is OFF when the tenant has not enabled feedback.ai_planning_enabled (FeedbackError, no LLM call)', async () => {
    // ADR-0077 slice 3 — the gate used to be FEEDBACK_AI_PLANNING_ENABLED in the environment and had no
    // coverage of the CLOSED path at all (the file only ever switched it on). It is now a per-tenant
    // setting, so the refusal is testable: turn it back off for THIS tenant and resolve a fresh
    // snapshot — the beforeEach one still carries the enabled value, by design.
    const R = await hire('Gated Off');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'enhancement',
      title: 'X',
      description: 'Y',
    });
    await setSetting(base.tenantId, 'feedback.ai_planning_enabled', false);
    const offCtx = await entitledCtx(base);
    await expect(generateFeedbackPlan(offCtx, { feedbackId: id })).rejects.toBeInstanceOf(FeedbackError);
    expect(generateDraft).not.toHaveBeenCalled();
    expect((await getFeedback(adminCtx(base), id))!.status).toBe('open'); // unchanged
  });

  it('is OFF when no AI config resolves (FeedbackError, no LLM call)', async () => {
    const R = await hire('No Config');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'enhancement',
      title: 'X',
      description: 'Y',
    });
    vi.mocked(resolveActiveAiConfig).mockResolvedValue(null);
    await expect(generateFeedbackPlan(planCtx, { feedbackId: id })).rejects.toBeInstanceOf(FeedbackError);
    expect(generateDraft).not.toHaveBeenCalled();
    expect((await getFeedback(adminCtx(base), id))!.status).toBe('open'); // unchanged
  });

  it('re-plan: a contested item carries the prior plan + the push-back into the prompt', async () => {
    const R = await hire('Re Planner');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'enhancement',
      title: 'Export payroll',
      description: 'Add CSV export.',
    });
    vi.mocked(generateDraft).mockResolvedValueOnce('PLAN A: basic export');
    await generateFeedbackPlan(planCtx, { feedbackId: id });
    await contestFeedbackPlan(rctx, { feedbackId: id, reason: 'Plan A misses the EPF column.' });

    vi.mocked(generateDraft).mockResolvedValueOnce('PLAN B: export with EPF column');
    await generateFeedbackPlan(planCtx, { feedbackId: id });
    const { prompt } = vi.mocked(generateDraft).mock.calls[1][1];
    expect(prompt).toContain('PLAN A: basic export');
    expect(prompt).toContain('Plan A misses the EPF column.');

    const d = (await getFeedback(adminCtx(base), id))!;
    expect(d.status).toBe('planned');
    expect(d.planRevision).toBe(2);
    expect(d.plan).toContain('PLAN B');
  });
});

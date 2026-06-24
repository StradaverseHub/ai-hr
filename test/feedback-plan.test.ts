/**
 * Feedback planning agent FB-3 (ADR-0043). Contract:
 *   - reuses the AI gateway: resolves the tenant config, sends the feedback, stores the plan (status →
 *     planned, agent actor, revision bump);
 *   - PII redaction: emails / IC numbers in the free text are scrubbed before reaching the gateway;
 *   - gated: with no AI config the agent is OFF (FeedbackError, no LLM call);
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
import { adminCtx, closeAll, createAppUser, eventTypesFor, migrateTestDb, resetDb, seedBase, type Base } from './harness';

let base: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  process.env.FEEDBACK_AI_PLANNING_ENABLED = 'true'; // the in-app agent is gated off by default (ADR-0044)
  vi.mocked(generateDraft).mockReset().mockResolvedValue('PLAN: 1. Do the thing. 2. Test it.');
  vi.mocked(resolveActiveAiConfig)
    .mockReset()
    .mockResolvedValue({ provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-test' });
});
afterAll(async () => {
  delete process.env.FEEDBACK_AI_PLANNING_ENABLED;
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

    const { plan } = await generateFeedbackPlan(adminCtx(base), { feedbackId: id });
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
    await expect(generateFeedbackPlan(adminCtx(base), { feedbackId: id })).rejects.toBeInstanceOf(FeedbackError);
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
    await generateFeedbackPlan(adminCtx(base), { feedbackId: id });
    await contestFeedbackPlan(rctx, { feedbackId: id, reason: 'Plan A misses the EPF column.' });

    vi.mocked(generateDraft).mockResolvedValueOnce('PLAN B: export with EPF column');
    await generateFeedbackPlan(adminCtx(base), { feedbackId: id });
    const { prompt } = vi.mocked(generateDraft).mock.calls[1][1];
    expect(prompt).toContain('PLAN A: basic export');
    expect(prompt).toContain('Plan A misses the EPF column.');

    const d = (await getFeedback(adminCtx(base), id))!;
    expect(d.status).toBe('planned');
    expect(d.planRevision).toBe(2);
    expect(d.plan).toContain('PLAN B');
  });
});

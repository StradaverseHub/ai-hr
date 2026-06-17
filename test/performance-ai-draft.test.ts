/**
 * Performance Phase B — AI-assisted review drafting (ADR-0022 slice 5, ADR-0007). Contract under test:
 *   - draft-only: a draft NEVER mutates the review (no rating, comment, status, or pay write);
 *   - human-in-the-loop gate: only the reviewer/admin may draft, never the subject;
 *   - graceful degradation: with the gateway unconfigured the feature is OFF (PerfError, no LLM call);
 *   - PII redaction: emails / IC numbers in free text are scrubbed before they reach the gateway;
 *   - auditability: a generated draft appends a `performance-review.ai-draft-generated` event.
 *
 * The LLM boundary (lib/ai) is mocked — these tests never touch the SDK, the network, or a real key.
 * redactPII + aiModel stay REAL (via importActual) so the redaction contract is genuinely exercised.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/ai', async (importActual) => {
  const actual = await importActual<typeof import('../lib/ai')>();
  return {
    ...actual, // keep redactPII + aiModel + AiNotConfiguredError real
    isAiConfigured: vi.fn(() => true),
    generateDraft: vi.fn(async () => 'DRAFT: the employee performed well this period.'),
  };
});

import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { generateDraft, isAiConfigured } from '../lib/ai';
import {
  createCycle,
  createGoal,
  draftManagerReview,
  linkGoalToReview,
  openCycle,
  PerfError,
  submitManagerReview,
  submitSelfReview,
} from '../core/performance';
import { hireEmployee, setReportingLine } from '../core/org';
import { adminCtx, closeAll, createAppUser, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

describe('ADR-0022 — AI-assisted review drafting', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    vi.mocked(isAiConfigured).mockReset().mockReturnValue(true);
    vi.mocked(generateDraft).mockReset().mockResolvedValue('DRAFT: the employee performed well this period.');
  });
  afterAll(async () => {
    await closeAll();
  });

  // Manager M reviews report E1: cycle open, E1's self-review submitted (with PII in the free text),
  // one goal linked. Returns the manager ctx, the subject ctx, and the review id.
  async function setup() {
    const a = adminCtx(base);
    const M = await hire(a, base, 'Manager');
    const E1 = await hire(a, base, 'Ann');
    await setReportingLine(a, {
      subordinateEmploymentId: E1.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    const mCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'], personId: M.personId };
    const uE = await createAppUser(base.tenantId, E1.personId, 'employee');
    const eCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'], personId: E1.personId };

    const { cycleId } = await createCycle(a, { name: '2026 Annual', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    await openCycle(a, { cycleId });
    const reviews = await owner.db
      .select()
      .from(schema.performanceReview)
      .where(eq(schema.performanceReview.cycleId, cycleId));
    const r1 = reviews.find((r) => r.employmentId === E1.employmentId)!;

    // Self-review carries PII in the free text — admin may submit on the employee's behalf.
    await submitSelfReview(a, {
      reviewId: r1.id,
      selfRating: 4,
      selfComments: 'Paired with jane@acme.test and shipped the 910101-01-1234 milestone.',
      goalsSummary: 'Shipped the new export pipeline.',
    });
    const { id: goalId } = await createGoal(a, {
      employmentId: E1.employmentId,
      cycleId,
      title: 'Improve test coverage to 80%',
    });
    await linkGoalToReview(a, { reviewId: r1.id, goalId });

    return { a, M, E1, mCtx, eCtx, cycleId, reviewId: r1.id };
  }

  it('drafts from redacted signals, never mutates the review, and audits the generation', async () => {
    const { mCtx, reviewId } = await setup();

    const res = await draftManagerReview(mCtx, { reviewId });
    expect(res.draft).toBe('DRAFT: the employee performed well this period.');
    expect(res.signals).toMatchObject({ hasSelf: true, goals: 1, priorRatings: 0, peerNotes: 0 });

    // The gateway saw redacted free text + the structured signals — and NOT the raw PII.
    expect(generateDraft).toHaveBeenCalledTimes(1);
    const { prompt } = vi.mocked(generateDraft).mock.calls[0][0];
    expect(prompt).toContain('[email]');
    expect(prompt).toContain('[id]');
    expect(prompt).not.toContain('jane@acme.test');
    expect(prompt).not.toContain('910101-01-1234');
    expect(prompt).toContain('Improve test coverage to 80%');
    expect(prompt).toContain('Employee self-rating: 4');

    // Draft-only: the review row is untouched.
    const [rev] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id, reviewId));
    expect(rev.managerRating).toBeNull();
    expect(rev.managerComments).toBeNull();
    expect(rev.status).toBe('manager_review');

    // …but the generation is on the audit log.
    expect(await eventTypesFor(base.tenantId, reviewId)).toContain('performance-review.ai-draft-generated');
  });

  it('is OFF when the gateway is unconfigured (PerfError, no LLM call)', async () => {
    const { mCtx, reviewId } = await setup();
    vi.mocked(isAiConfigured).mockReturnValue(false);
    await expect(draftManagerReview(mCtx, { reviewId })).rejects.toBeInstanceOf(PerfError);
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('the subject cannot draft their own review (human-in-the-loop is the manager)', async () => {
    const { eCtx, reviewId } = await setup();
    await expect(draftManagerReview(eCtx, { reviewId })).rejects.toThrow(/cannot decide your own/i);
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('only drafts inside the editable window (a finalized review cannot be drafted)', async () => {
    const { a, mCtx, reviewId } = await setup();
    await submitManagerReview(a, { reviewId, managerRating: 4, overallRating: 4 });
    await expect(draftManagerReview(mCtx, { reviewId })).rejects.toBeInstanceOf(PerfError);
    expect(generateDraft).not.toHaveBeenCalled();
  });
});

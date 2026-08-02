/**
 * 0348 — feedback_request.reporter_label: the board shows who WROTE the item.
 *
 * The improvement loop raises items on the reporter's behalf, borrowing their employment because
 * reporter_employment_id is NOT NULL and drives RLS can_see_employment(). Before this column the board
 * rendered person.full_name through that join, so every item CLAUDE raised carried the human
 * consultant's name. listFeedback now coalesces the label over the joined name.
 *
 * What these tests pin:
 *   1. NULL label ⇒ the person name, unchanged. This is every in-app submission and is the regression
 *      that matters — the fix must not rename anything a human wrote.
 *   2. A set label wins over the joined name.
 *   3. The label is DISPLAY ONLY: reporter_employment_id, reporter_user_id and the reporter's review
 *      authority are untouched, so a labelled item is still approvable by the person who owns it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { adminCtx, createAppUser, migrateTestDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { withTenant } from '../db/client';
import { feedbackRequest } from '../db/schema';
import { hireEmployee } from '../core/org';
import { approveFeedbackPlan, listFeedback, setFeedbackPlan, submitFeedback } from '../core/feedback';
import { OPERATOR_REPORTER_LABEL } from '../scripts/improve/remote';

let base: Base;
beforeAll(async () => {
  await migrateTestDb();
  base = await seedBase();
});

const hire = (name: string) =>
  hireEmployee(adminCtx(base), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const reporterCtx = async (personId: string): Promise<SessionContext> => {
  const uid = await createAppUser(base.tenantId, personId, 'employee');
  return { tenantId: base.tenantId, userId: uid, personId, roles: ['employee'] };
};

/** Stamp the label the way the migration's backfill and raiseFeedback both do. */
const setLabel = (ctx: SessionContext, id: string, label: string | null) =>
  withTenant(ctx, (tx) =>
    tx.update(feedbackRequest).set({ reporterLabel: label }).where(eq(feedbackRequest.id, id)),
  );

const rowFor = async (ctx: SessionContext, id: string) => {
  const rows = await listFeedback(ctx);
  const row = rows.find((r) => r.id === id);
  expect(row, 'the item should be visible in listFeedback').toBeTruthy();
  return row!;
};

describe('0348 — reporter_label on the feedback board', () => {
  it('the operator label is the exact string the owner asked for', () => {
    // Pinned deliberately: the migration backfill hardcodes this string in SQL, so a rename here without
    // a matching migration would silently split the two.
    expect(OPERATOR_REPORTER_LABEL).toBe('CLAUDE AI');
  });

  it('with no label, the board still shows the person who submitted it', async () => {
    const R = await hire('Label Fallback Reporter');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'issue',
      title: 'Balance reads oddly',
      description: 'The figure on the leave card does not match the history.',
    });

    const row = await rowFor(adminCtx(base), id);
    expect(row.reporter).toBe('Label Fallback Reporter');
  });

  it('a set label is what the board shows instead of the joined person name', async () => {
    const R = await hire('Borrowed Employment');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'enhancement',
      title: 'Two approved items contradict each other',
      description: 'Raised by the pipeline because the decision belongs to the reporter.',
    });

    expect((await rowFor(adminCtx(base), id)).reporter).toBe('Borrowed Employment');
    await setLabel(adminCtx(base), id, OPERATOR_REPORTER_LABEL);
    expect((await rowFor(adminCtx(base), id)).reporter).toBe(OPERATOR_REPORTER_LABEL);
  });

  it('the label is display only — it does not move the item or take review authority away', async () => {
    const R = await hire('Still The Reporter');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'issue',
      title: 'Authority must survive the label',
      description: 'Labelling the display name must not change who owns the item.',
    });
    await setLabel(adminCtx(base), id, OPERATOR_REPORTER_LABEL);

    // The employment the item hangs off is untouched, so RLS and ownership are unchanged...
    const [stored] = await withTenant(adminCtx(base), (tx) =>
      tx
        .select({
          employmentId: feedbackRequest.reporterEmploymentId,
          userId: feedbackRequest.reporterUserId,
          label: feedbackRequest.reporterLabel,
        })
        .from(feedbackRequest)
        .where(eq(feedbackRequest.id, id)),
    );
    expect(stored.employmentId).toBe(R.employmentId);
    expect(stored.userId).toBe(rctx.userId);
    expect(stored.label).toBe(OPERATOR_REPORTER_LABEL);

    // ...and the reporter can still review their own item, which is the gate that would break if the
    // label had been implemented by repointing the item at a synthetic "CLAUDE AI" employment.
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'A plan.', model: 'test' });
    await approveFeedbackPlan(rctx, { feedbackId: id });
    const row = await rowFor(adminCtx(base), id);
    expect(row.status).toBe('approved');
    expect(row.reporter).toBe(OPERATOR_REPORTER_LABEL);
  });
});

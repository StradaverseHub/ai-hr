/**
 * 0321 — a screenshot can be attached when pushing back, not only when raising the item.
 *
 * The board's loop is a negotiation: raise → plan → push back → re-plan. The reporter could attach an
 * image to the first step and nothing after it, which is backwards — "here is what is STILL wrong after
 * you shipped it" is the message a screenshot carries best, and it was the one moment they could not
 * provide one.
 *
 * The stage column is why this is more than a file input. Untagged, a push-back screenshot sits
 * indistinguishably beside the original bug screenshot; on an item that has been round three times that
 * is a pile of images with no story — the same failure 0318 fixed for the plan TEXT, reintroduced for
 * the pictures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  addFeedbackAttachment,
  approveFeedbackPlan,
  contestFeedbackPlan,
  getFeedback,
  setFeedbackPlan,
  submitFeedback,
} from '../core/feedback';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const PNG = Buffer.from('89504e470d0a1a0a', 'hex'); // a PNG magic number is enough — content is opaque here

async function itemWithPlan(): Promise<{ id: string; rctx: SessionContext; employmentId: string }> {
  const R = await hireEmployee(adminCtx(base), {
    person: { fullName: 'Screenshot Reporter', primaryEmail: `s_${randomUUID().slice(0, 6)}@t.local` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  const uid = await createAppUser(base.tenantId, R.personId, 'employee');
  const rctx: SessionContext = { tenantId: base.tenantId, userId: uid, personId: R.personId, roles: ['employee'] };
  const { id } = await submitFeedback(rctx, {
    reporterEmploymentId: R.employmentId,
    category: 'issue',
    title: 'The total is wrong',
    description: 'See attached.',
  });
  return { id, rctx, employmentId: R.employmentId };
}

describe('0321 — attachments record which round they belong to', () => {
  it('an attachment at submission has no plan to answer', async () => {
    const { id, rctx } = await itemWithPlan();
    await addFeedbackAttachment(rctx, { feedbackId: id, fileName: 'bug.png', mimeType: 'image/png', content: PNG });

    const [row] = await owner.db.select().from(schema.feedbackAttachment).where(eq(schema.feedbackAttachment.feedbackRequestId, id));
    expect(row.stage).toBe('submitted');
    // NULL, not 0. "No plan existed yet" and "revision 0" are different facts and only the first is true.
    expect(row.planRevision).toBeNull();
  });

  it('an attachment on a push-back names the revision it answers', async () => {
    const { id, rctx } = await itemWithPlan();
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'We will change X.' });
    await contestFeedbackPlan(rctx, { feedbackId: id, reason: 'Still wrong, see the screenshot.' });
    await addFeedbackAttachment(rctx, {
      feedbackId: id,
      fileName: 'still-wrong.png',
      mimeType: 'image/png',
      content: PNG,
      stage: 'contested',
    });

    const rows = await owner.db.select().from(schema.feedbackAttachment).where(eq(schema.feedbackAttachment.feedbackRequestId, id));
    const contested = rows.find((r) => r.stage === 'contested')!;
    expect(contested, 'the push-back attachment exists').toBeDefined();
    // Revision 1 — the plan the reporter was actually looking at when they objected. Derived from the
    // item, not passed by the caller, so a stale page cannot file an image against the wrong round.
    expect(contested.planRevision).toBe(1);
  });

  it('the revision is read at attach time, so a later re-plan does not re-date the image', async () => {
    const { id, rctx } = await itemWithPlan();
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'v1' });
    await contestFeedbackPlan(rctx, { feedbackId: id, reason: 'no' });
    await addFeedbackAttachment(rctx, {
      feedbackId: id, fileName: 'v1.png', mimeType: 'image/png', content: PNG, stage: 'contested',
    });
    // The agent re-plans; the item moves to revision 2. The image still answers v1.
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'v2' });

    const rows = await owner.db.select().from(schema.feedbackAttachment).where(eq(schema.feedbackAttachment.feedbackRequestId, id));
    expect(rows.find((r) => r.fileName === 'v1.png')!.planRevision).toBe(1);
  });

  it('THE CONSTRAINT: stage and revision cannot disagree', async () => {
    const { id, employmentId } = await itemWithPlan();
    // Asserting the CONSTRAINT NAME, not merely "it threw". The first version of this test used a
    // non-existent Base field, so employment_id was null and both inserts failed on NOT NULL — the CHECK
    // under test was never reached and the test passed for entirely the wrong reason.
    const violates = async (values: Record<string, unknown>) => {
      const err = await owner.db
        .insert(schema.feedbackAttachment)
        .values(values as never)
        .then(() => null, (e: Error & { cause?: Error }) => e);
      expect(err, 'the insert should have been refused').not.toBeNull();
      const chain = [err?.message, err?.cause?.message].filter(Boolean).join(' | ');
      expect(chain).toMatch(/feedback_attachment_stage_revision_ck/);
    };
    // A contested row with no revision would fall out of the timeline silently — the pairing IS the
    // point of the column, so the database refuses rather than trusting every future caller.
    await violates({
      tenantId: base.tenantId, feedbackRequestId: id, employmentId, content: PNG,
      fileName: 'orphan.png', mimeType: 'image/png', sizeBytes: PNG.byteLength,
      stage: 'contested', planRevision: null,
    });
    // …and the mirror: a submitted row that claims to answer a revision.
    await violates({
      tenantId: base.tenantId, feedbackRequestId: id, employmentId, content: PNG,
      fileName: 'mislabelled.png', mimeType: 'image/png', sizeBytes: PNG.byteLength,
      stage: 'submitted', planRevision: 1,
    });
  });

  it('reads back grouped, so the page can show each image beside the words it came with', async () => {
    const { id, rctx } = await itemWithPlan();
    await addFeedbackAttachment(rctx, { feedbackId: id, fileName: 'original.png', mimeType: 'image/png', content: PNG });
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'v1' });
    await contestFeedbackPlan(rctx, { feedbackId: id, reason: 'no' });
    await addFeedbackAttachment(rctx, {
      feedbackId: id, fileName: 'pushback.png', mimeType: 'image/png', content: PNG, stage: 'contested',
    });

    const detail = (await getFeedback(adminCtx(base), id))!;
    const byStage = Object.fromEntries(detail.attachments.map((a) => [a.fileName, a.stage]));
    expect(byStage['original.png']).toBe('submitted');
    expect(byStage['pushback.png']).toBe('contested');
  });

  it('existing attachments keep working — the default makes every pre-0321 row `submitted`', async () => {
    const { id, rctx, employmentId } = await itemWithPlan();
    // Insert WITHOUT naming stage, exactly as the pre-0321 service did.
    await owner.db.insert(schema.feedbackAttachment).values({
      tenantId: base.tenantId,
      feedbackRequestId: id,
      employmentId,
      content: PNG,
      fileName: 'legacy.png',
      mimeType: 'image/png',
      sizeBytes: PNG.byteLength,
    });
    const detail = (await getFeedback(rctx, id))!;
    expect(detail.attachments.find((a) => a.fileName === 'legacy.png')!.stage).toBe('submitted');
  });
});

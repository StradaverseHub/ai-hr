/**
 * 0406 — a PLAN can carry a mockup, and the mockup is pinned to the revision it illustrates.
 *
 * WHY THE STAGE EXISTS. Every stage 0321 defined is the REPORTER answering us: submitted / contested /
 * refuted are all things done TO a plan. There has never been a stage for the answer, so a plan could only
 * ever be ~6,000 characters of prose the board renders raw. Of 151 attachments on production, 143 are
 * IMAGES — the reporter communicates in pictures and we replied in paragraphs, and e7eb5d83 came back from
 * `deployed` as "the whole thing is crap".
 *
 * WHAT THESE TESTS ACTUALLY GUARD. Not "a file can be attached" — that already worked. They guard the
 * PINNING: a mockup that floated free of its revision would show the reporter a picture of a proposal that
 * no longer exists, which is the failure 0318 fixed for plan text and 0321 fixed for the reporter's own
 * screenshots. So the load-bearing test asserts POSTGRES refuses the bad row, by constraint name.
 *
 * Asserting the constraint NAME is deliberate and is a lesson from the 0321 file next door: its first
 * version used a non-existent Base field, so employment_id was null, the insert failed on NOT NULL, and
 * the CHECK under test was never reached — the test passed for entirely the wrong reason.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  addFeedbackAttachment,
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

const PNG = Buffer.from('89504e470d0a1a0a', 'hex'); // a PNG magic number is enough — the content is opaque here

async function item(): Promise<{ id: string; rctx: SessionContext; employmentId: string }> {
  const R = await hireEmployee(adminCtx(base), {
    person: { fullName: 'Mockup Reporter', primaryEmail: `m_${randomUUID().slice(0, 6)}@t.local` },
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
    title: 'The payslip screen is hard to use',
    description: 'Finding an employee takes too long.',
  });
  return { id, rctx, employmentId: R.employmentId };
}

describe('0406 — a plan can show the reporter what it means', () => {
  it('`plan` is an accepted stage at all — the 0321 list had no slot for our own answer', async () => {
    const { id } = await item();
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'We will replace the dropdown.' });

    const { id: attId } = await addFeedbackAttachment(adminCtx(base), {
      feedbackId: id,
      fileName: 'after.png',
      mimeType: 'image/png',
      content: PNG,
      stage: 'plan',
    });

    const detail = (await getFeedback(adminCtx(base), id))!;
    const mockup = detail.attachments.find((a) => a.id === attId)!;
    expect(mockup.stage).toBe('plan');
    expect(mockup.planRevision).toBe(1);
    // 0406 surfaced mimeType so the page can render an image inline and leave a PDF in the link list.
    expect(mockup.mimeType).toBe('image/png');
  });

  it('THE CONSTRAINT: a plan mockup that names no revision is refused by the database', async () => {
    const { id, employmentId } = await item();
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'v1' });

    const err = await owner.db
      .insert(schema.feedbackAttachment)
      .values({
        tenantId: base.tenantId,
        feedbackRequestId: id,
        employmentId,
        content: PNG,
        fileName: 'unpinned.png',
        mimeType: 'image/png',
        sizeBytes: PNG.byteLength,
        stage: 'plan',
        planRevision: null,
      } as never)
      .then(() => null, (e: Error & { cause?: Error }) => e);
    expect(err, 'an unpinned mockup should have been refused').not.toBeNull();
    const chain = [err?.message, err?.cause?.message].filter(Boolean).join(' | ');
    // 0321 wrote this as an EQUIVALENCE — (stage='submitted') = (plan_revision IS NULL) — rather than an
    // enumeration, so it generalised to a stage that did not exist when it was written. 0406 therefore
    // changes only the stage LIST; re-stating this one as an IN-list would narrow it back.
    expect(chain).toMatch(/feedback_attachment_stage_revision_ck/);
  });

  it('a re-plan leaves the old mockup on the old revision instead of relabelling it', async () => {
    const { id, rctx } = await item();

    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'v1' });
    await addFeedbackAttachment(adminCtx(base), {
      feedbackId: id, fileName: 'v1.png', mimeType: 'image/png', content: PNG, stage: 'plan',
    });

    // The reporter pushes back and we re-plan. THE OLD DRAWING MUST NOT FOLLOW THE NEW PLAN.
    await contestFeedbackPlan(rctx, { feedbackId: id, reason: 'not what I meant' });
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'v2' });
    await addFeedbackAttachment(adminCtx(base), {
      feedbackId: id, fileName: 'v2.png', mimeType: 'image/png', content: PNG, stage: 'plan',
    });

    const detail = (await getFeedback(adminCtx(base), id))!;
    const rev = Object.fromEntries(detail.attachments.map((a) => [a.fileName, a.planRevision]));
    expect(rev['v1.png']).toBe(1);
    expect(rev['v2.png']).toBe(2);
    expect(detail.planRevision).toBe(2);

    // The exact filter app/feedback/[id]/page.tsx renders with — one plan, one design.
    const shown = detail.attachments.filter(
      (a) => a.stage === 'plan' && a.planRevision === detail.planRevision && a.mimeType.startsWith('image/'),
    );
    expect(shown.map((a) => a.fileName)).toEqual(['v2.png']);
  });

  it('a non-image mockup is NOT rendered inline, and is not lost either', async () => {
    const { id } = await item();
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'v1' });
    await addFeedbackAttachment(adminCtx(base), {
      feedbackId: id, fileName: 'spec.pdf', mimeType: 'application/pdf', content: PNG, stage: 'plan',
    });

    const detail = (await getFeedback(adminCtx(base), id))!;
    const inline = detail.attachments.filter((a) => a.stage === 'plan' && a.mimeType.startsWith('image/'));
    expect(inline, 'a PDF in an <img> is a broken image').toHaveLength(0);
    // …but the page's stage list includes 'plan', so it still appears as a link rather than vanishing.
    expect(detail.attachments.some((a) => a.fileName === 'spec.pdf' && a.stage === 'plan')).toBe(true);
  });

  it('every pre-0406 attachment is untouched — submitted still means "no plan existed yet"', async () => {
    const { id, rctx } = await item();
    await addFeedbackAttachment(rctx, {
      feedbackId: id, fileName: 'bug.png', mimeType: 'image/png', content: PNG,
    });
    const [row] = await owner.db
      .select()
      .from(schema.feedbackAttachment)
      .where(eq(schema.feedbackAttachment.feedbackRequestId, id));
    expect(row.stage).toBe('submitted');
    expect(row.planRevision).toBeNull();
  });
});

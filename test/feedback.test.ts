/**
 * Feedback module FB-1 (ADR-0043) — capture + agent-plan + reporter review + build transitions. The
 * headline gate: only the person who raised the feedback may approve/contest the plan (an admin can SEE
 * it but cannot review on their behalf). Plans bump a revision; a contest re-opens for re-planning.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminCtx, createAppUser, eventTypesFor, latestEventPayload, migrateTestDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  addFeedbackAttachment,
  approveFeedbackPlan,
  completeFeedbackBuild,
  contestFeedbackPlan,
  FeedbackError,
  getFeedback,
  getFeedbackAttachment,
  listFeedback,
  markFeedbackDeployed,
  setFeedbackPlan,
  startFeedbackBuild,
  submitFeedback,
} from '../core/feedback';

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

describe('FB-1 — feedback capture + review (ADR-0043)', () => {
  it('submit → agent plans → reporter approves; a stranger (non-reporter, non-admin) cannot', async () => {
    const R = await hire('FB Reporter');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'issue',
      title: 'Leave page is confusing',
      description: 'The balance and the apply form are mixed together.',
      expectedBehavior: 'Balances and the apply form should be separated.',
    });
    expect((await getFeedback(rctx, id))!.status).toBe('open');

    // The planning agent writes a plan (agent actor) → planned, revision 1.
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: '1. Split the page\n2. Move balances up', model: 'test-model' });
    const planned = (await getFeedback(adminCtx(base), id))!;
    expect(planned.status).toBe('planned');
    expect(planned.planRevision).toBe(1);
    expect(planned.plan).toContain('Split the page');

    // The review gate: a stranger (neither the reporter nor an admin) cannot approve.
    const stranger = await hire('FB Stranger');
    const sctx = await reporterCtx(stranger.personId);
    await expect(approveFeedbackPlan(sctx, { feedbackId: id })).rejects.toBeInstanceOf(FeedbackError);

    // The reporter approves their own item.
    await approveFeedbackPlan(rctx, { feedbackId: id });
    expect((await getFeedback(rctx, id))!.status).toBe('approved');

    const types = await eventTypesFor(base.tenantId, id);
    expect(types).toEqual(expect.arrayContaining(['feedback.submitted', 'feedback.plan.drafted', 'feedback.plan.approved']));
  });

  it('an admin can approve on the reporter’s behalf — recorded as decidedBy:admin (triage)', async () => {
    const R = await hire('FB AdminApprove');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'enhancement',
      title: 'Add a thing',
      description: 'Please add the thing.',
    });
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'Build the thing', model: 'm' });

    // An admin (not the reporter) approves — triage path.
    await approveFeedbackPlan(adminCtx(base), { feedbackId: id });
    expect((await getFeedback(adminCtx(base), id))!.status).toBe('approved');

    // The approval event records that an admin decided, not the reporter.
    const ev = await latestEventPayload(base.tenantId, id, 'feedback.plan.approved');
    expect(ev?.decidedBy).toBe('admin');
  });

  it('contesting re-opens for re-planning (revision bumps, the contest reason clears)', async () => {
    const R = await hire('FB Contester');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'enhancement',
      title: 'Add CSV export to payroll',
      description: 'We need to export the batch.',
    });
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'Plan A', model: 'm' });
    await contestFeedbackPlan(rctx, { feedbackId: id, reason: 'Plan A misses the EPF column.' });
    const contested = (await getFeedback(adminCtx(base), id))!;
    expect(contested.status).toBe('contested');
    expect(contested.contestReason).toBe('Plan A misses the EPF column.');

    // The agent re-plans the contested item → planned again, revision 2, contest cleared.
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'Plan B (with EPF column)', model: 'm' });
    const replanned = (await getFeedback(adminCtx(base), id))!;
    expect(replanned.status).toBe('planned');
    expect(replanned.planRevision).toBe(2);
    expect(replanned.contestReason).toBeNull();
    expect(replanned.plan).toContain('Plan B');
  });

  it('supporting attachments store + serve, and the item lists', async () => {
    const R = await hire('FB Attacher');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'new_function',
      title: 'Shift swapping',
      description: 'Allow employees to swap shifts.',
    });
    const { id: attId } = await addFeedbackAttachment(rctx, {
      feedbackId: id,
      fileName: 'mockup.png',
      mimeType: 'image/png',
      content: Buffer.from('PNGDATA'),
    });
    const att = await getFeedbackAttachment(rctx, attId);
    expect(att?.fileName).toBe('mockup.png');
    expect(att?.content.toString()).toBe('PNGDATA');
    expect((await getFeedback(rctx, id))!.attachments.map((a) => a.fileName)).toContain('mockup.png');
    expect((await listFeedback(adminCtx(base), { status: 'open' })).some((f) => f.id === id)).toBe(true);
  });

  it('build transitions: approved → building → done (agent-tracked, never self-modifying)', async () => {
    const R = await hire('FB Builder');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'issue',
      title: 'Typo on dashboard',
      description: 'It says Dashbord.',
    });
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'Fix the typo', model: 'm' });
    await approveFeedbackPlan(rctx, { feedbackId: id });
    await startFeedbackBuild(adminCtx(base), { feedbackId: id });
    expect((await getFeedback(rctx, id))!.status).toBe('building');
    await completeFeedbackBuild(adminCtx(base), { feedbackId: id, buildRef: 'https://github.com/x/y/pull/42' });
    const done = (await getFeedback(rctx, id))!;
    expect(done.status).toBe('done');
    expect(done.buildRef).toContain('/pull/42');

    // The improvement loop releases it → deployed (closes the item; ADR-0044).
    await markFeedbackDeployed(adminCtx(base), { feedbackId: id });
    expect((await getFeedback(rctx, id))!.status).toBe('deployed');
    expect(await eventTypesFor(base.tenantId, id)).toContain('feedback.deployed');
  });

  /**
   * e14334ef — the board orders by LAST ACTION, not by creation, and the ordering is SQL.
   *
   * THE CASE THAT MATTERS is the one a browser-side sort gets wrong. `listFeedback` caps the board at
   * 200 rows over 517 on production; sorting the returned page would rank only the 200 newest-CREATED
   * items, so an item raised in March and moved this morning would never reach the top — which is
   * precisely what the reporter asked to see. Ordering therefore has to happen before the LIMIT, and
   * the assertion below is that a transition, not an insert, decides the position.
   */
  describe('board ordering by last action (e14334ef)', () => {
    it('an older item that was TOUCHED outranks a newer untouched one, and updated_asc reverses it', async () => {
      const R = await hire('FB Sorter');
      const rctx = await reporterCtx(R.personId);
      const mk = (title: string) =>
        submitFeedback(rctx, {
          reporterEmploymentId: R.employmentId,
          category: 'issue',
          title,
          description: `${title} body`,
        });

      // OLD is raised first, NEW second — so creation order alone puts NEW above OLD.
      const { id: oldId } = await mk('FB Sort Old');
      const { id: newId } = await mk('FB Sort New');

      // Nothing has happened to either yet: an untouched item carries its creation time, which is the
      // convention the reporter asked for and needs no special case in the service.
      const atRest = await listFeedback(adminCtx(base));
      const rest = new Map(atRest.map((r) => [r.id, r]));
      expect(rest.get(oldId)!.updatedAt.getTime()).toBe(rest.get(oldId)!.createdAt.getTime());
      expect(rest.get(newId)!.updatedAt.getTime()).toBe(rest.get(newId)!.createdAt.getTime());
      expect(atRest.findIndex((r) => r.id === newId)).toBeLessThan(atRest.findIndex((r) => r.id === oldId));

      // A real transition moves OLD — the same UPDATE that appends the domain event stamps updated_at.
      await setFeedbackPlan(adminCtx(base), { feedbackId: oldId, plan: 'Plan for the old one', model: 'm' });

      const newestFirst = await listFeedback(adminCtx(base));
      const dOld = newestFirst.findIndex((r) => r.id === oldId);
      const dNew = newestFirst.findIndex((r) => r.id === newId);
      expect(dOld, 'the touched item must be listed').toBeGreaterThanOrEqual(0);
      expect(dOld, 'the older item that just moved now outranks the newer untouched one').toBeLessThan(dNew);
      expect(newestFirst.find((r) => r.id === oldId)!.updatedAt.getTime()).toBeGreaterThan(
        newestFirst.find((r) => r.id === oldId)!.createdAt.getTime(),
      );

      // The default is updated_desc, so passing it explicitly must produce the same ranking.
      const explicit = await listFeedback(adminCtx(base), { sort: 'updated_desc' });
      expect(explicit.findIndex((r) => r.id === oldId)).toBeLessThan(explicit.findIndex((r) => r.id === newId));

      // Oldest-first is the other direction of the SAME key, not a different one.
      const oldestFirst = await listFeedback(adminCtx(base), { sort: 'updated_asc' });
      expect(oldestFirst.findIndex((r) => r.id === newId)).toBeLessThan(oldestFirst.findIndex((r) => r.id === oldId));
    });

    it('a status filter and the sort compose — the filter narrows, the sort orders what is left', async () => {
      const R = await hire('FB SortFilter');
      const rctx = await reporterCtx(R.personId);
      const { id: first } = await submitFeedback(rctx, {
        reporterEmploymentId: R.employmentId,
        category: 'issue',
        title: 'FB Filter First',
        description: 'first',
      });
      const { id: second } = await submitFeedback(rctx, {
        reporterEmploymentId: R.employmentId,
        category: 'issue',
        title: 'FB Filter Second',
        description: 'second',
      });
      // A third item stays `open` and is never touched — it is what the FILTER has to remove. Without it
      // the case could not tell a working filter from no filter at all.
      const { id: untouched } = await submitFeedback(rctx, {
        reporterEmploymentId: R.employmentId,
        category: 'issue',
        title: 'FB Filter Untouched',
        description: 'untouched',
      });

      // BOTH of the others are driven to `contested`, so the filtered set has two rows and the ordering
      // assertion below can actually fail. SECOND is contested FIRST, deliberately: that leaves FIRST —
      // the older of the two — carrying the later stamp, so the expected order is the OPPOSITE of the
      // order they were raised in. An ORDER BY that fell back to created_at would satisfy a same-order
      // pair silently; this pair rejects it.
      await setFeedbackPlan(adminCtx(base), { feedbackId: first, plan: 'p1', model: 'm' });
      await setFeedbackPlan(adminCtx(base), { feedbackId: second, plan: 'p2', model: 'm' });
      await contestFeedbackPlan(rctx, { feedbackId: second, reason: 'nor that' });
      await contestFeedbackPlan(rctx, { feedbackId: first, reason: 'not that' });

      // The filter NARROWS: the untouched `open` item is gone, both contested ones are present.
      const contested = await listFeedback(adminCtx(base), { status: 'contested' });
      const dFirst = contested.findIndex((r) => r.id === first);
      const dSecond = contested.findIndex((r) => r.id === second);
      expect(dFirst, 'the first-raised contested item must survive the filter').toBeGreaterThanOrEqual(0);
      expect(dSecond, 'the second-raised contested item must survive the filter').toBeGreaterThanOrEqual(0);
      expect(contested.map((r) => r.id)).not.toContain(untouched);
      // The sort ORDERS what is left, by last action: FIRST was contested last, so it leads — even though
      // it is the older item and creation order would have put it second.
      expect(dFirst, 'the most recently contested item leads the filtered page').toBeLessThan(dSecond);
      expect(contested[dFirst]!.updatedAt.getTime()).toBeGreaterThan(contested[dSecond]!.updatedAt.getTime());
      expect(contested[dFirst]!.createdAt.getTime()).toBeLessThan(contested[dSecond]!.createdAt.getTime());

      // …and the flip applies WITHIN the filter rather than resetting it.
      const oldestFirst = await listFeedback(adminCtx(base), { status: 'contested', sort: 'updated_asc' });
      expect(oldestFirst.findIndex((r) => r.id === second)).toBeLessThan(
        oldestFirst.findIndex((r) => r.id === first),
      );
      expect(oldestFirst.map((r) => r.id)).not.toContain(untouched);
    });
  });
});

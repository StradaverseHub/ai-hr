/**
 * The reporter can answer the question a `blocked` item is waiting on (migration 0323).
 *
 * WHAT WAS BROKEN. `blocked` (0317) means "approved, but waiting on an answer only the reporter can
 * give". The detail page rendered the question — and nothing to answer it with. The gates there were
 * `canReview` (planned), `canRefute` (deployed), `canRestore` (cancelled); `blocked` had none. So the
 * loop asked a question the product physically could not receive an answer to, and item 956cec85 sat
 * asking which statutory submission channels and file formats were in use with no way for the one person
 * who knows to reply. Same defect class as "approve carries no payload": a state the system can enter and
 * the user cannot leave.
 *
 * THE TWO LOAD-BEARING TESTS, both about the answer SURVIVING rather than the answer being taken:
 *   1. `the answer outlives the unblock that clears the question` — unblockFeedback wipes blocked_reason
 *      and blocked_by_id by design, so an answer kept beside them would either go with them or become a
 *      reply to a deleted question. This is the 0318 failure one layer down.
 *   2. `THE HANDOFF: the answer reaches what the build agent actually reads` — build agents read items
 *      through scripts/improve/remote.ts, which selects feedback_request COLUMNS and never touches
 *      domain_event. An answer living only in the event payload would be invisible to the only reader
 *      that has to act on it. That test runs the pull's REAL SQL, not a retyped equivalent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  answerBlockingQuestion,
  approveFeedbackPlan,
  blockFeedback,
  FeedbackError,
  getFeedback,
  setFeedbackPlan,
  startFeedbackBuild,
  submitFeedback,
  unblockFeedback,
} from '../core/feedback';
import {
  assertMoved,
  blockTrailSql,
  feedbackSelectByIdSql,
  feedbackSelectSql,
  markBlockedSql,
  markUnblockedSql,
} from '../scripts/improve/remote';
import { adminCtx, closeAll, createAppUser, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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

/**
 * Assert a statement failed for the REASON we mean. Drizzle wraps driver errors as "Failed query: …" and
 * hangs the real Postgres error off `.cause`, so matching the outer message would pass on ANY failure —
 * which is how a permissions test passes with permissions wide open.
 */
async function expectDbError(run: Promise<unknown>, pattern: RegExp): Promise<void> {
  const err = await run.then(
    () => null,
    (e: unknown) => e as Error & { cause?: Error },
  );
  expect(err, 'the statement should have been refused').not.toBeNull();
  const chain = [err?.message, err?.cause?.message].filter(Boolean).join(' | ');
  expect(chain).toMatch(pattern);
}

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

/** Walk an item to `approved` — the only status a block can be applied from. */
async function approvedItem(title = 'Fix the statutory export'): Promise<{ id: string; rctx: SessionContext; employmentId: string }> {
  const R = await hire(`Reporter ${randomUUID().slice(0, 4)}`);
  const rctx = await reporterCtx(R.personId);
  const { id } = await submitFeedback(rctx, {
    reporterEmploymentId: R.employmentId,
    category: 'issue',
    title,
    description: 'Something to fix.',
  });
  await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'Do the thing.' });
  await approveFeedbackPlan(rctx, { feedbackId: id });
  return { id, rctx, employmentId: R.employmentId };
}

/** The block episodes as stored, read past RLS so a test can see rows the app might not. */
async function episodes(feedbackId: string) {
  return owner.db
    .select()
    .from(schema.feedbackBlock)
    .where(eq(schema.feedbackBlock.feedbackRequestId, feedbackId))
    .orderBy(asc(schema.feedbackBlock.askedAt));
}

/**
 * Run a multi-statement psql script (BEGIN;…COMMIT;) the way the operator CLI pipes it to `psql -f -`.
 *
 * On a RESERVED connection, not the pool: the script carries its own BEGIN/COMMIT, and postgres.js refuses
 * that on a pooled connection (UNSAFE_TRANSACTION) because the next statement could land on a different
 * socket. `psql -f -` is one connection start to finish, so reserving one is what actually reproduces it —
 * splitting the script or letting the driver own the transaction would be testing something else.
 */
async function runScript(text: string): Promise<unknown> {
  const c = await owner.client.reserve();
  try {
    return await c.unsafe(text).simple();
  } finally {
    c.release();
  }
}

const QUESTION = 'Which statutory submission channels and file formats do you use for EPF and SOCSO?';
const ANSWER = 'EPF via i-Akaun with a fixed-width text file; SOCSO via ASSIST with the standard CSV.';

describe('answering a blocked item (0323)', () => {
  it('THE DEFECT: the reporter answers the question and the item returns to the build queue', async () => {
    const { id, rctx } = await approvedItem();
    await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });
    expect((await getFeedback(rctx, id))!.status).toBe('blocked');

    await answerBlockingQuestion(rctx, { feedbackId: id, answer: ANSWER });

    const d = (await getFeedback(rctx, id))!;
    expect(d.status).toBe('approved');
    // Not merely relabelled — the park is a pause and answering must genuinely restore the build path.
    await startFeedbackBuild(adminCtx(base), { feedbackId: id, buildRef: 'build/x' });
    expect((await getFeedback(rctx, id))!.status).toBe('building');
  });

  it('LOAD-BEARING: the answer outlives the unblock that clears the question', async () => {
    const { id, rctx } = await approvedItem();
    const { id: decisionId } = await approvedItem('DECISION NEEDED: which channel?');
    await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION, blockedById: decisionId });

    await answerBlockingQuestion(rctx, { feedbackId: id, answer: ANSWER });

    const d = (await getFeedback(rctx, id))!;
    // The item itself forgets the wait, exactly as before — that is deliberate, and it is the whole reason
    // the answer cannot live here.
    expect(d.blockedReason).toBeNull();
    expect(d.blockedById).toBeNull();
    // …and the pair survives, TOGETHER. Either half alone is useless: an answer without its question is
    // contextless, a question without its answer is the defect we started from.
    expect(d.blockHistory).toHaveLength(1);
    expect(d.blockHistory[0].question).toBe(QUESTION);
    expect(d.blockHistory[0].answer).toBe(ANSWER);
    expect(d.blockHistory[0].blockedById).toBe(decisionId);
    expect(d.blockHistory[0].resolvedAt).not.toBeNull();
    expect(d.blockHistory[0].answeredByUserId).toBe(rctx.userId);
  });

  it('THE HANDOFF: the answer reaches what the build agent actually reads', async () => {
    const { id, rctx } = await approvedItem();
    await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });
    await answerBlockingQuestion(rctx, { feedbackId: id, answer: ANSWER });

    // The EXACT queries `pnpm improve:pull-approved` issues. Retyping an equivalent would prove only that
    // the test author can write SQL; the claim under test is about the strings that really run.
    const [{ coalesce: itemsJson }] = (await owner.db.execute(
      sql.raw(feedbackSelectSql(`'approved'`)),
    )) as unknown as { coalesce: unknown }[];
    const items = (typeof itemsJson === 'string' ? JSON.parse(itemsJson) : itemsJson) as { id: string }[];
    const mine = items.find((r) => r.id === id);
    expect(mine, 'the answered item must be back in the build queue').toBeTruthy();
    // …and it carries NOTHING about the question on the row itself — which is precisely why the trail
    // query has to exist. If this assertion ever starts failing, the answer found another home and this
    // whole design should be revisited rather than patched.
    expect(JSON.stringify(mine)).not.toContain('i-Akaun');

    const [{ coalesce: trailJson }] = (await owner.db.execute(
      sql.raw(blockTrailSql([id])),
    )) as unknown as { coalesce: unknown }[];
    const trail = (typeof trailJson === 'string' ? JSON.parse(trailJson) : trailJson) as {
      feedback_request_id: string;
      question: string;
      answer: string | null;
    }[];
    expect(trail).toHaveLength(1);
    expect(trail[0].feedback_request_id).toBe(id);
    expect(trail[0].question).toBe(QUESTION);
    expect(trail[0].answer).toBe(ANSWER);
  });

  it('an admin may answer on the reporter’s behalf, and the event says which it was', async () => {
    const { id, rctx } = await approvedItem();
    await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });
    await answerBlockingQuestion(adminCtx(base), { feedbackId: id, answer: 'HR answered on their behalf.' });
    expect((await getFeedback(rctx, id))!.status).toBe('approved');
    const payload = (await latestEventPayload(base.tenantId, id, 'feedback.unblocked')) as {
      note: string;
      answeredBy: string;
    };
    expect(payload.answeredBy).toBe('admin');
    // The words travel in the audit stream too — the row is where readers get them, the event is the
    // record that it happened.
    expect(payload.note).toContain('HR answered');
  });

  describe('refusals — the guard, not just the happy path', () => {
    it('refuses every status that is not `blocked`', async () => {
      const { id, rctx } = await approvedItem();
      // approved: agreed and queued, nothing was asked.
      await expect(answerBlockingQuestion(rctx, { feedbackId: id, answer: ANSWER })).rejects.toThrow(
        /Only an item waiting on an answer/i,
      );

      const { id: planned, rctx: prctx } = await approvedItem();
      await owner.db.execute(sql`UPDATE feedback_request SET status = 'planned' WHERE id = ${planned}::uuid`);
      // planned: the reply that belongs here is approve or contest, which carry their own history.
      await expect(answerBlockingQuestion(prctx, { feedbackId: planned, answer: ANSWER })).rejects.toThrow(FeedbackError);
      expect((await getFeedback(prctx, planned))!.status).toBe('planned');
    });

    it('refuses a stranger — neither the reporter nor an admin — and changes nothing', async () => {
      const { id } = await approvedItem();
      await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });
      const S = await hire('Someone Else');
      const sctx = await reporterCtx(S.personId);

      // NOT the authority message, and the difference is worth stating: for an unrelated employee RLS
      // refuses FIRST — can_see_employment hides the item, so loadDecidable finds nothing and the service
      // never reaches assertCanReview. That is the stronger of the two refusals (a stranger cannot even
      // learn the item exists), and asserting the authority message here would have been asserting a
      // message this path cannot produce. assertCanReview still guards the case RLS lets through — someone
      // who CAN see the reporter's employment but did not raise the item — and is exercised by the
      // admin-on-behalf test above, which is the only context in this fixture that reaches it.
      await expect(answerBlockingQuestion(sctx, { feedbackId: id, answer: 'I reckon CSV.' })).rejects.toThrow(
        /not found \(or not visible\)/i,
      );
      const [ep] = await episodes(id);
      expect(ep.answer).toBeNull();
      expect(ep.resolvedAt).toBeNull();
      expect((await getFeedback(adminCtx(base), id))!.status).toBe('blocked');
    });

    it('refuses a blank answer — whitespace is not an answer', async () => {
      const { id, rctx } = await approvedItem();
      await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });
      await expect(answerBlockingQuestion(rctx, { feedbackId: id, answer: '   \n ' })).rejects.toThrow(
        /Please write your answer/i,
      );
      expect((await getFeedback(rctx, id))!.status).toBe('blocked');
    });
  });

  describe('append-and-close-once — the discipline 0318 exists to enforce', () => {
    it('a second block round appends; neither round overwrites the other', async () => {
      const { id, rctx } = await approvedItem();
      await blockFeedback(adminCtx(base), { feedbackId: id, reason: 'Round one: which channel?' });
      await answerBlockingQuestion(rctx, { feedbackId: id, answer: 'i-Akaun.' });
      await blockFeedback(adminCtx(base), { feedbackId: id, reason: 'Round two: which file format?' });
      await answerBlockingQuestion(rctx, { feedbackId: id, answer: 'Fixed-width text.' });

      const rows = await episodes(id);
      expect(rows.map((r) => [r.question, r.answer])).toEqual([
        ['Round one: which channel?', 'i-Akaun.'],
        ['Round two: which file format?', 'Fixed-width text.'],
      ]);
    });

    it('an operator unblock with no note ENDS the episode without inventing an answer', async () => {
      const { id } = await approvedItem();
      await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });
      await unblockFeedback(adminCtx(base), { feedbackId: id });

      const [ep] = await episodes(id);
      expect(ep.resolvedAt, 'the wait is over even though nothing was said').not.toBeNull();
      expect(ep.answer, 'a placeholder here would be a lie in the same place 0318 told one').toBeNull();

      // …and the episode being closed is what lets the item be parked again. If an unanswered episode
      // stayed open, the partial unique index would swallow the NEXT question silently.
      await blockFeedback(adminCtx(base), { feedbackId: id, reason: 'A different question.' });
      expect(await episodes(id)).toHaveLength(2);
    });

    it('TAMPER: a recorded answer cannot be rewritten through the app', async () => {
      const { id, rctx } = await approvedItem();
      await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });
      await answerBlockingQuestion(rctx, { feedbackId: id, answer: ANSWER });

      // Closure is ONE-WAY: the UPDATE policy's USING clause is `resolved_at IS NULL`, so a resolved row
      // matches no policy and is simply not there to hit. It changes nothing rather than raising.
      await withTenant(rctx, (tx) =>
        tx.execute(sql`UPDATE feedback_block SET answer = 'something else' WHERE feedback_request_id = ${id}::uuid`),
      );
      expect((await episodes(id))[0].answer).toBe(ANSWER);
    });

    it('TAMPER: resolving cannot rewrite the question on its way past', async () => {
      const { id, rctx } = await approvedItem();
      await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });

      // RLS is ROW-level: the resolve policy decides which rows may be touched, not which columns may
      // change. Only the trigger stops the question being rewritten by the same statement that answers it
      // — the exact move that destroyed the plan history before 0318. It must RAISE, not silently allow.
      await expectDbError(
        withTenant(rctx, (tx) =>
          tx.execute(
            sql`UPDATE feedback_block SET answer = 'x', resolved_at = now(), question = 'a question nobody asked'
                 WHERE feedback_request_id = ${id}::uuid`,
          ),
        ),
        /append-only/i,
      );
      expect((await episodes(id))[0].question).toBe(QUESTION);
    });

    it('TAMPER: the app cannot open an episode that is already answered', async () => {
      const { id, rctx } = await approvedItem();
      await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });
      // The INSERT policy requires `answer IS NULL AND resolved_at IS NULL`, so a pre-answered episode
      // cannot be fabricated — an answer can only be reached by ANSWERING an open question.
      await expectDbError(
        withTenant(rctx, (tx) =>
          tx.execute(
            sql`INSERT INTO feedback_block (tenant_id, feedback_request_id, question, answer, resolved_at)
                VALUES (${base.tenantId}::uuid, ${id}::uuid, 'invented', 'invented answer', now())`,
          ),
        ),
        /row-level security/i,
      );
      expect(await episodes(id)).toHaveLength(1);
    });

    it('TAMPER: episodes cannot be deleted through the app', async () => {
      const { id, rctx } = await approvedItem();
      await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });
      await expectDbError(
        withTenant(rctx, (tx) => tx.execute(sql`DELETE FROM feedback_block WHERE feedback_request_id = ${id}::uuid`)),
        /permission denied/i,
      );
      expect(await episodes(id)).toHaveLength(1);
    });

    it('the app role holds exactly SELECT, INSERT and UPDATE', async () => {
      // 0318's first cut granted SELECT only, on the false premise that the services write as owner. They
      // do not — they run as ai_hr_app through withTenant — and the answer box would have recorded
      // nothing while appearing to work. This asserts the grant directly rather than inferring it from a
      // write succeeding, because a write can succeed for the wrong reason.
      const [{ privs }] = (await owner.db.execute(
        sql`SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
              FROM information_schema.role_table_grants
             WHERE table_name = 'feedback_block' AND grantee = 'ai_hr_app'`,
      )) as unknown as { privs: string | null }[];
      expect(privs ?? '').toBe('INSERT,SELECT,UPDATE');
    });
  });

  describe('items parked before this table existed', () => {
    it('recreates the episode from blocked_reason so the answer is not dropped', async () => {
      const { id, rctx } = await approvedItem();
      await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });
      // Rewind to the pre-0323 world: parked, with the question surviving only on the request row. This is
      // the state every item blocked by hand-written SQL is in, and 956cec85 was in until the backfill.
      await owner.db.execute(sql`DELETE FROM feedback_block WHERE feedback_request_id = ${id}::uuid`);

      await answerBlockingQuestion(rctx, { feedbackId: id, answer: ANSWER });

      const rows = await episodes(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].question, 'the question is recovered from where it survived, not invented').toBe(QUESTION);
      expect(rows[0].answer).toBe(ANSWER);
      expect((await getFeedback(rctx, id))!.status).toBe('approved');
    });

    it('refuses when there is no recorded question at all, rather than answering nothing', async () => {
      const { id, rctx } = await approvedItem();
      await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });
      await owner.db.execute(sql`DELETE FROM feedback_block WHERE feedback_request_id = ${id}::uuid`);
      await owner.db.execute(sql`UPDATE feedback_request SET blocked_reason = NULL WHERE id = ${id}::uuid`);

      await expect(answerBlockingQuestion(rctx, { feedbackId: id, answer: ANSWER })).rejects.toThrow(
        /records no question to answer/i,
      );
      // Still parked: a refusal must not quietly release the item into the build queue.
      expect((await getFeedback(rctx, id))!.status).toBe('blocked');
    });
  });

  describe('the operator side writes the same trail', () => {
    /**
     * These run the SQL scripts `pnpm improve:block` / `improve:unblock` pipe to `psql -f -`, verbatim.
     * They are the only cover the operator path has: everything in scripts/improve/remote.ts otherwise
     * executes for the first time against PRODUCTION, over SSH, which is a poor place to discover that a
     * nested dollar-quoted DO block does not parse.
     */
    it('improve:block opens the episode and improve:unblock closes it with the note as the answer', async () => {
      const { id, rctx, employmentId } = await approvedItem();

      await runScript(markBlockedSql({ id, tenantId: base.tenantId, reporterEmploymentId: employmentId, reason: QUESTION }));
      const [opened] = await episodes(id);
      expect(opened.question).toBe(QUESTION);
      expect(opened.resolvedAt).toBeNull();

      await runScript(
        markUnblockedSql({ id, tenantId: base.tenantId, reporterEmploymentId: employmentId, note: ANSWER }),
      );
      const [closed] = await episodes(id);
      expect(closed.answer).toBe(ANSWER);
      expect(closed.resolvedAt).not.toBeNull();
      expect((await getFeedback(rctx, id))!.status).toBe('approved');
    });

    it('improve:unblock with no note ends the episode without an answer', async () => {
      const { id, employmentId } = await approvedItem();
      await runScript(markBlockedSql({ id, tenantId: base.tenantId, reporterEmploymentId: employmentId, reason: QUESTION }));
      await runScript(markUnblockedSql({ id, tenantId: base.tenantId, reporterEmploymentId: employmentId }));
      const [ep] = await episodes(id);
      expect(ep.resolvedAt).not.toBeNull();
      expect(ep.answer).toBeNull();
    });

    /**
     * REVERSED IN r355. This case used to read "improve:block opens NOTHING when the status guard did not
     * park the item", and it proved that with a `building` item — because markBlocked's UPDATE carried
     * `AND status = 'approved'`. That is the bug, not the rule: on 2026-09-29 a park of item 70294f7a,
     * abandoned mid-build for a question only building it revealed, matched no row, printed success, and
     * the reporter was never asked. `building` is parkable now. The no-op half of the old claim still
     * holds and is pinned below with a status that genuinely cannot be parked.
     */
    it('improve:block parks an item abandoned mid-build, with the question and the event', async () => {
      const { id, rctx, employmentId } = await approvedItem();
      await owner.db.execute(sql`UPDATE feedback_request SET status = 'building' WHERE id = ${id}::uuid`);

      await runScript(
        markBlockedSql({ id, tenantId: base.tenantId, reporterEmploymentId: employmentId, reason: QUESTION }),
      );

      expect((await getFeedback(rctx, id))!.status).toBe('blocked');
      const [opened] = await episodes(id);
      expect(opened.question).toBe(QUESTION);
      expect(opened.resolvedAt).toBeNull();
      expect(await latestEventPayload(base.tenantId, id, 'feedback.blocked')).toMatchObject({ reason: QUESTION });
    });

    it('improve:block records NOTHING AT ALL when the status cannot be parked', async () => {
      // A park that did not happen must leave no question, no event and no status change: all three are
      // history the reporter is shown, and a fabricated one is worse than a missing one. `done` is the
      // real case — an item already built, where the operator meant a different id.
      const { id, rctx, employmentId } = await approvedItem();
      await owner.db.execute(sql`UPDATE feedback_request SET status = 'done' WHERE id = ${id}::uuid`);
      await runScript(
        markBlockedSql({ id, tenantId: base.tenantId, reporterEmploymentId: employmentId, reason: 'never asked' }),
      );
      expect(await episodes(id)).toHaveLength(0);
      expect(await latestEventPayload(base.tenantId, id, 'feedback.blocked')).toBeNull();
      expect((await getFeedback(rctx, id))!.status).toBe('done');
    });

    it('improve:unblock records NOTHING when the item was never parked', async () => {
      // The asymmetric one, and the reason the script reads ROW_COUNT instead of re-reading the status: an
      // already-`approved` item looks EXACTLY the same after a release that never happened. A status
      // re-read would have closed an unrelated open episode and written an unblocked event for nothing.
      const { id, rctx, employmentId } = await approvedItem();
      await runScript(markUnblockedSql({ id, tenantId: base.tenantId, reporterEmploymentId: employmentId, note: ANSWER }));
      expect(await latestEventPayload(base.tenantId, id, 'feedback.unblocked')).toBeNull();
      expect((await getFeedback(rctx, id))!.status).toBe('approved');
    });

    it('the script reports back whether anything moved, so the CLI cannot call a no-op a success', () => {
      // assertMoved is what turns that report into an error. No database in it: the outcome line is the
      // last non-empty line psql printed.
      expect(() => assertMoved('id-1', 'blocked', 'blocked\n', 'why')).not.toThrow();
      expect(() => assertMoved('id-1', 'blocked', 'unchanged:building\n', 'only approved or building')).toThrow(
        /was NOT moved to blocked — it is still building\. only approved or building/,
      );
      expect(() => assertMoved('id-1', 'approved', '', 'only a blocked item')).toThrow(/not on this board/);
      expect(() => assertMoved('id-1', 'blocked', 'unchanged:?\n', 'why')).toThrow(/Nothing was recorded/);
    });

    it('survives a question containing the dollar-quote tags the script itself uses', async () => {
      // dq() and guardedOn() each pick a tag the payload does not contain. A reporter question quoting
      // `$fb$` or `$blk$` would otherwise terminate the literal (or the DO block) early and either fail
      // loudly or, far worse, execute something else.
      const nasty = "Do we use $fb$ or $blk$ markers, and what about a lone ' quote?";
      const { id, employmentId } = await approvedItem();
      await runScript(markBlockedSql({ id, tenantId: base.tenantId, reporterEmploymentId: employmentId, reason: nasty }));
      expect((await episodes(id))[0].question).toBe(nasty);
    });
  });

  it('one open episode per item at most — the database says so, not just the service', async () => {
    const { id } = await approvedItem();
    await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });
    // Named constraint, asserted by name: `rejects.toThrow()` alone would pass on any failure at all,
    // including an insert that died on a NOT NULL long before reaching the index under test.
    await expectDbError(
      owner.db.execute(
        sql`INSERT INTO feedback_block (tenant_id, feedback_request_id, question)
            VALUES (${base.tenantId}::uuid, ${id}::uuid, 'a second live question')`,
      ),
      /feedback_block_open_uq/,
    );
    const open = await owner.db
      .select()
      .from(schema.feedbackBlock)
      .where(and(eq(schema.feedbackBlock.feedbackRequestId, id), isNull(schema.feedbackBlock.resolvedAt)));
    expect(open).toHaveLength(1);
  });

  it('an answer cannot be recorded on an episode that is still open', async () => {
    const { id } = await approvedItem();
    await blockFeedback(adminCtx(base), { feedbackId: id, reason: QUESTION });
    // Because closure is one-way, an answer written without resolving would be permanently unclosable —
    // the CHECK is what keeps that row from existing. Asserted by constraint name.
    await expectDbError(
      owner.db.execute(sql`UPDATE feedback_block SET answer = 'half a record' WHERE feedback_request_id = ${id}::uuid`),
      /feedback_block_answer_resolves_ck/,
    );
  });
});

/**
 * r369 — A BUILDER MUST BE ABLE TO READ ITS OWN PLAN AFTER `build-start`.
 *
 * `pullApproved()` filters `status in ('approved')`, so the moment `build-start` moves an item to
 * `building` the plan text becomes unreachable through the pull commands — and a hand-rolled psql is
 * refused by the auto-mode classifier as a production read. Four builders on 2026-09-30 were dispatched
 * after their `build-start` and had to work from the parent's brief rather than the approved contract.
 *
 * The discipline is to capture the plan BEFORE the board write. This is the safety net, and it is pinned
 * here with the real string, not an equivalent one, for the same reason the pull query above is.
 */
describe('improve pull-item — one item by id, whatever its status', () => {
  it('returns the PLAN of an item that build-start has already moved to building', async () => {
    const PLAN = 'VERDICT: Not built yet   ·   SIZE: Quick\n\nTHE SITUATION TODAY\n\nA plan a builder must be able to read.';
    // Walked from `open` here rather than through the file's `approvedItem` helper, because a plan can only
    // be drafted while the item is open or contested — and the plan text has to be DISTINCTIVE or the
    // assertion below could pass on a shared fixture's placeholder.
    const R = await hire(`Reporter ${randomUUID().slice(0, 4)}`);
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'enhancement',
      title: 'readable after build-start',
      description: 'The plan must survive the status change.',
    });
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: PLAN });
    await approveFeedbackPlan(rctx, { feedbackId: id });
    await startFeedbackBuild(adminCtx(base), { feedbackId: id });

    // The premise, measured rather than assumed: pull-approved can no longer see it. Without this the
    // assertion below would pass just as well if nothing had moved.
    const [{ coalesce: approvedJson }] = (await owner.db.execute(
      sql.raw(feedbackSelectSql(`'approved'`)),
    )) as unknown as { coalesce: unknown }[];
    const approved = (typeof approvedJson === 'string' ? JSON.parse(approvedJson) : approvedJson) as { id: string }[];
    expect(
      approved.some((r) => r.id === id),
      'premise: a building item is invisible to pull-approved, which is the whole reason pull-item exists',
    ).toBe(false);

    // The EXACT query `pnpm improve:pull-item <id>` issues.
    const [{ coalesce: oneJson }] = (await owner.db.execute(
      sql.raw(feedbackSelectByIdSql(id)),
    )) as unknown as { coalesce: unknown }[];
    const rows = (typeof oneJson === 'string' ? JSON.parse(oneJson) : oneJson) as {
      id: string;
      status: string;
      plan: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status, 'it is fetched BECAUSE of its id, not despite its status').toBe('building');
    expect(rows[0].plan, 'the plan text is what the builder came for').toBe(PLAN);
  });

  it('refuses anything that is not a uuid rather than interpolating it', () => {
    // The id goes into the SQL by interpolation, so the uuid assertion is the only thing between this
    // helper and an injected statement. A test that only checked the happy path would not notice its loss.
    expect(() => feedbackSelectByIdSql("' or 1=1 --")).toThrow();
    expect(() => feedbackSelectByIdSql('not-a-uuid')).toThrow();
  });

  it('returns an empty array for an unknown id, so "no such item" is not an ssh failure', async () => {
    const [{ coalesce: json }] = (await owner.db.execute(
      sql.raw(feedbackSelectByIdSql('11111111-2222-3333-4444-555555555555')),
    )) as unknown as { coalesce: unknown }[];
    const rows = (typeof json === 'string' ? JSON.parse(json) : json) as unknown[];
    expect(rows).toEqual([]);
  });
});

/**
 * 6e122302 — Notice Board RLS (migration 0390).
 *
 * A notice board is the one surface in the product whose whole purpose is to show content to a chosen set
 * of people. Getting its row-level security wrong is not a bug in a feature — it is a disclosure of an
 * announcement to someone it was deliberately kept from, and of the announcement's very existence.
 *
 * Two audiences, so two policies per table:
 *   notice            — admins do everything; a recipient may SELECT a PUBLISHED, unarchived notice they
 *                       are in the snapshot for, within a window fenced one day either side (see the
 *                       migration for why the fence is deliberately wider than the product's).
 *   notice_recipient  — admins do everything; the employee may SELECT and UPDATE their OWN row (opening a
 *                       notice, dismissing its popup) and nobody else's.
 *
 * These specs are written as REFUSALS, because a permissive bug is silent: the service layer's own filters
 * would hide most of it, so every read below deliberately goes STRAIGHT to the table rather than through
 * core/notice.ts. If a policy were dropped, the service would still look correct and this file is what
 * would notice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createNotice, publishNotice, archiveNotice } from '../core/notice';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

const hire = (name: string, deptId?: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: deptId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });

/** A real employee session: a person, an app_user linked to it, and the 'employee' role. */
async function employeeSession(name: string, deptId?: string) {
  const e = await hire(name, deptId);
  const userId = await createAppUser(b.tenantId, e.personId, 'employee');
  const ctx: SessionContext = { tenantId: b.tenantId, userId, personId: e.personId, roles: ['employee'] };
  return { ...e, userId, ctx };
}

/**
 * Drizzle wraps a PostgresError in a "Failed query: …" Error, so a plain `toThrow(/row-level security/)`
 * only ever sees the WRAPPER and passes on the wrong throw — the exact trap that makes a refusal test
 * green for the wrong reason. Walk the cause chain and gather every field Postgres puts the real identity
 * in. Lifted from test/invitation-privesc.test.ts, which learned this the same way.
 */
function pgText(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const rec = cur as Record<string, unknown>;
    for (const k of ['message', 'detail', 'hint', 'constraint_name', 'where']) {
      if (typeof rec[k] === 'string') parts.push(rec[k] as string);
    }
    cur = rec.cause;
  }
  return parts.join(' | ');
}

/** A live notice targeted at ONE department, published. */
async function liveNoticeFor(deptId: string, title = 'Policy update') {
  const { id } = await createNotice(adminCtx(b), {
    title,
    body: 'Body',
    startOn: '2020-01-01',
    // Deliberately open-ended enough that the RLS window (current_date, ±1 day) can never be the reason a
    // spec below passes or fails — these specs are about the RECIPIENT predicate, not the dates.
    endOn: '2099-12-31',
    criteria: { departmentIds: [deptId] },
  });
  await publishNotice(adminCtx(b), id);
  return id;
}

describe('6e122302 · notice RLS — who can READ a notice', () => {
  it('a RECIPIENT reads the notice; a NON-RECIPIENT in another department cannot see it exists', async () => {
    const mine = await employeeSession('Recipient', b.deptA);
    const theirs = await employeeSession('Outsider', b.deptB);
    const id = await liveNoticeFor(b.deptA);

    const seenByRecipient = await withTenant(mine.ctx, (tx) =>
      tx.select({ id: schema.notice.id }).from(schema.notice),
    );
    expect(seenByRecipient.map((r) => r.id)).toEqual([id]);

    // Not "an empty body" or "a 403" — the row is not there at all, so the notice's EXISTENCE is not
    // disclosed either.
    const seenByOutsider = await withTenant(theirs.ctx, (tx) =>
      tx.select({ id: schema.notice.id }).from(schema.notice),
    );
    expect(seenByOutsider).toEqual([]);
  });

  it('a DRAFT is invisible to the people its criteria would select — nothing is published until it is', async () => {
    const mine = await employeeSession('Recipient', b.deptA);
    await createNotice(adminCtx(b), {
      title: 'Not yet',
      body: 'Body',
      startOn: '2020-01-01',
      endOn: '2099-12-31',
      criteria: { departmentIds: [b.deptA] },
    });
    expect(await withTenant(mine.ctx, (tx) => tx.select().from(schema.notice))).toEqual([]);
  });

  it('a draft with a recipient row ATTACHED is still invisible — the published_at clause is load-bearing on its own', async () => {
    // WHY THIS SPEC EXISTS, AND WHY THE OBVIOUS ONE ABOVE IS NOT ENOUGH. The spec above passes even with
    // `published_at IS NOT NULL` deleted from the policy — measured, not assumed — because today a draft
    // has no snapshot rows at all, so the EXISTS clause already excludes it. That makes the whole
    // draft-privacy property rest on an implementation detail of `publishNotice` rather than on the
    // policy. The moment anyone pre-resolves an audience (a "preview who this reaches" feature is the
    // obvious next ask) drafts would become readable, and nothing would have failed.
    //
    // So this forces the clause to be the reason: a recipient row is planted on an UNPUBLISHED notice
    // through the OWNER connection, and the employee must still see nothing.
    const mine = await employeeSession('Recipient', b.deptA);
    const { id } = await createNotice(adminCtx(b), {
      title: 'Draft with a planted recipient',
      body: 'Body',
      startOn: '2020-01-01',
      endOn: '2099-12-31',
      criteria: { departmentIds: [b.deptA] },
    });
    await owner.db
      .insert(schema.noticeRecipient)
      .values({ tenantId: b.tenantId, noticeId: id, employmentId: mine.employmentId });

    expect(await withTenant(mine.ctx, (tx) => tx.select().from(schema.notice))).toEqual([]);
  });

  it('an ARCHIVED notice disappears from its recipients at the DATABASE, not only in the service read', async () => {
    const mine = await employeeSession('Recipient', b.deptA);
    const id = await liveNoticeFor(b.deptA);
    expect((await withTenant(mine.ctx, (tx) => tx.select().from(schema.notice))).length).toBe(1);
    await archiveNotice(adminCtx(b), id);
    expect(await withTenant(mine.ctx, (tx) => tx.select().from(schema.notice))).toEqual([]);
  });

  it('a notice whose window has not opened is fenced by RLS as well as by the read', async () => {
    const mine = await employeeSession('Recipient', b.deptA);
    const { id } = await createNotice(adminCtx(b), {
      title: 'Next year',
      body: 'Body',
      startOn: '2099-01-01',
      endOn: '2099-12-31',
      criteria: { departmentIds: [b.deptA] },
    });
    await publishNotice(adminCtx(b), id);
    // The employee IS in the snapshot — publishing resolved them — and still cannot read it.
    const snapshot = await owner.db
      .select()
      .from(schema.noticeRecipient)
      .where(eq(schema.noticeRecipient.noticeId, id));
    expect(snapshot.length).toBe(1);
    expect(await withTenant(mine.ctx, (tx) => tx.select().from(schema.notice))).toEqual([]);
  });

  it('an employee cannot CREATE or EDIT a notice — publishing is an administrative act', async () => {
    const mine = await employeeSession('Recipient', b.deptA);
    const id = await liveNoticeFor(b.deptA);

    const insertErr = await withTenant(mine.ctx, (tx) =>
      tx.insert(schema.notice).values({
        tenantId: b.tenantId,
        title: 'Forged',
        body: 'Body',
        startOn: '2020-01-01',
        endOn: '2099-12-31',
      }),
    ).catch((e) => e);
    expect(insertErr).toBeInstanceOf(Error);
    expect(pgText(insertErr)).toMatch(/row-level security policy/i);

    // An UPDATE is not refused with an error — the recipient policy is SELECT-only, so the row simply is
    // not in the set an UPDATE can reach. Asserting the ROW is unchanged is the honest test: "no error"
    // and "no effect" look identical from the caller, and only one of them is safe.
    await withTenant(mine.ctx, (tx) =>
      tx.update(schema.notice).set({ title: 'Hijacked' }).where(eq(schema.notice.id, id)),
    );
    const [after] = await owner.db.select({ title: schema.notice.title }).from(schema.notice).where(eq(schema.notice.id, id));
    expect(after.title).toBe('Policy update');
  });
});

describe('6e122302 · notice_recipient RLS — the snapshot is per person', () => {
  it("an employee sees their OWN recipient row and not a colleague's", async () => {
    const mine = await employeeSession('Mine', b.deptA);
    const theirs = await employeeSession('Theirs', b.deptA);
    await liveNoticeFor(b.deptA);

    // Both are recipients (same department)…
    expect((await owner.db.select().from(schema.noticeRecipient)).length).toBe(2);
    // …and each sees exactly one row: their own.
    const seen = await withTenant(mine.ctx, (tx) =>
      tx.select({ e: schema.noticeRecipient.employmentId }).from(schema.noticeRecipient),
    );
    expect(seen.map((r) => r.e)).toEqual([mine.employmentId]);
    expect(seen.map((r) => r.e)).not.toContain(theirs.employmentId);
  });

  it("an employee cannot mark a COLLEAGUE's notice as viewed or dismiss their popup", async () => {
    const mine = await employeeSession('Mine', b.deptA);
    const theirs = await employeeSession('Theirs', b.deptA);
    await liveNoticeFor(b.deptA);

    await withTenant(mine.ctx, (tx) =>
      tx
        .update(schema.noticeRecipient)
        .set({ popupDismissedAt: new Date(), firstViewedAt: new Date() })
        .where(eq(schema.noticeRecipient.employmentId, theirs.employmentId)),
    );
    const [row] = await owner.db
      .select({ d: schema.noticeRecipient.popupDismissedAt, v: schema.noticeRecipient.firstViewedAt })
      .from(schema.noticeRecipient)
      .where(eq(schema.noticeRecipient.employmentId, theirs.employmentId));
    expect(row.d).toBeNull();
    expect(row.v).toBeNull();
  });

  it('an employee CAN dismiss their own popup — the write the module actually needs', async () => {
    const mine = await employeeSession('Mine', b.deptA);
    await liveNoticeFor(b.deptA);
    await withTenant(mine.ctx, (tx) =>
      tx
        .update(schema.noticeRecipient)
        .set({ popupDismissedAt: new Date() })
        .where(eq(schema.noticeRecipient.employmentId, mine.employmentId)),
    );
    const [row] = await owner.db
      .select({ d: schema.noticeRecipient.popupDismissedAt })
      .from(schema.noticeRecipient)
      .where(eq(schema.noticeRecipient.employmentId, mine.employmentId));
    expect(row.d).not.toBeNull();
  });

  it('an employee cannot ADD themselves to a notice they were not sent', async () => {
    // Someone must actually be in the audience, or publishing refuses ("would reach nobody") and the
    // spec would pass for the wrong reason — the RLS refusal below has to be the ONLY thing under test.
    await employeeSession('Intended', b.deptA);
    const outsider = await employeeSession('Outsider', b.deptB);
    const id = await liveNoticeFor(b.deptA);
    const err = await withTenant(outsider.ctx, (tx) =>
      tx.insert(schema.noticeRecipient).values({
        tenantId: b.tenantId,
        noticeId: id,
        employmentId: outsider.employmentId,
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(pgText(err)).toMatch(/row-level security policy/i);
  });
});

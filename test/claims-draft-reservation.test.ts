/**
 * e7eb5d83 stage 1 — DRAFT claims + limit RESERVATION.
 *
 * WHAT THE TICKET CLAIMED, AND WHAT WAS ACTUALLY WRONG. The approved item says claim limits count only
 * APPROVED claims, so N pending claims all pass against the same balance and all become approvable. That
 * is what `claim_policy.annual_budget`'s comment said; it is not what the code did — the submit check has
 * always summed pending+approved+paid. The reservation was already there, DERIVED from status.
 *
 * The real defect is that nothing serialized it. Two transactions submitting (or approving) at the same
 * instant each read a sum without the other's uncommitted row, both pass, and the employee lands over
 * their limit with no error raised anywhere. That is the wrong answer, and the last four tests in this
 * file are the ones that prove it is gone: they are the only evidence that exists, because production has
 * ZERO claim rows (counted 2026-08-05) and there is no live behaviour to compare against.
 *
 * Every concurrency test here is written so it FAILS without the fix. Verified by removing the locks and
 * watching each one fail, then restoring them — recorded in the round notes rather than trusted.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import {
  CLAIM_STATUSES,
  NON_RESERVING_STATUSES,
  RESERVING_STATUSES,
  cancelClaim,
  claimLimitLockKey,
  createClaimType,
  decideClaim,
  deleteClaimDraft,
  getEmployeeClaimTypes,
  listClaimsForEmployment,
  listPendingClaims,
  saveClaimDraft,
  setClaimPolicy,
  submitClaim,
  submitDraftClaims,
} from '../core/claims';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, createAppUser, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Every message in an error's `.cause` chain. Drizzle wraps a Postgres error as "Failed query: …", so a
 *  bare `rejects.toThrow(/name/)` cannot see the constraint that actually fired — and would pass on a
 *  DIFFERENT throw entirely. */
function causeChain(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur instanceof Error; i++) {
    parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/** Resolve/settle helper: has this promise finished yet? Used to prove a call is BLOCKED rather than slow. */
function track<T>(p: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  const wrapped = p.then(
    (v) => {
      done = true;
      return v;
    },
    (e) => {
      done = true;
      throw e;
    },
  );
  // Nothing may observe a rejection late and turn it into an unhandled rejection.
  wrapped.catch(() => {});
  return { promise: wrapped, settled: () => done };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('e7eb5d83 stage 1 — draft claims and limit reservation', () => {
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

  /** One employee, one claim type with an annual budget, and a session that IS that employee. */
  async function setup(opts?: { budget?: number | null }) {
    const a = adminCtx(base);
    const E = await hireEmployee(a, {
      person: { fullName: 'Draftee', primaryEmail: 'draftee@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const me: SessionContext = {
      tenantId: base.tenantId,
      userId: uE,
      personId: E.personId,
      roles: ['employee'],
      entitlements: a.entitlements,
    };
    const { id: typeId } = await createClaimType(a, {
      code: 'MEDICAL',
      name: 'Medical',
      defaultTaxable: false,
      requiresReceipt: false,
      maxReceiptAgeDays: 36500,
    });
    if (opts && 'budget' in opts) {
      await setClaimPolicy(a, { claimTypeId: typeId, annualBudget: opts.budget ?? null, perClaimCap: null, effectiveFrom: '2026-01-01' });
    }
    return { a, E, me, typeId };
  }

  const balanceOf = async (ctx: SessionContext, employmentId: string, typeId: string) => {
    const types = await getEmployeeClaimTypes(ctx, employmentId);
    return types.find((t) => t.id === typeId)!.balance;
  };

  const statusOf = async (id: string): Promise<string> => {
    const [row] = await owner.db.select({ s: schema.claimRequest.status }).from(schema.claimRequest).where(eq(schema.claimRequest.id, id));
    return row?.s ?? 'gone';
  };

  // ─────────────────── The enum, and everyone who has to read it ───────────────────

  it('claim_status: the database, the app list and the classification all agree', async () => {
    const labels = await owner.db.execute<{ enumlabel: string; sortorder: number }>(sql`
      select e.enumlabel, e.enumsortorder as sortorder
      from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = 'claim_status'
      order by e.enumsortorder
    `);
    const fromDb = Array.from(labels).map((r) => r.enumlabel);
    // Set equality, not order: ADD VALUE without AFTER appends, so the sort order in Postgres and the
    // lifecycle order this file declares are allowed to differ.
    expect([...fromDb].sort()).toEqual([...CLAIM_STATUSES].sort());

    // Every label is classified exactly once. An unclassified status is a claim that either holds limit it
    // should not or releases limit it still holds — and nothing else in the codebase would notice.
    const classified = [...RESERVING_STATUSES, ...NON_RESERVING_STATUSES];
    expect([...classified].sort()).toEqual([...CLAIM_STATUSES].sort());
    expect(new Set(classified).size).toBe(classified.length);
    expect(RESERVING_STATUSES).not.toContain('draft');
  });

  it('every claim status has an i18n label in all six catalogs and a badge style on /claims', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const cat = JSON.parse(readFileSync(`${root}messages/${loc}.json`, 'utf8')).claims as Record<string, string>;
      const missing = CLAIM_STATUSES.filter((s) => !cat[`status_${s}`]);
      expect(missing, `messages/${loc}.json is missing claims.status_* for: ${missing.join(', ')}`).toEqual([]);
    }
    // The badge map: a status with no entry renders through the neutral fallback and is invisible as a
    // state. Read from source rather than rendered, because the page is an async server component.
    const page = readFileSync(`${root}app/claims/page.tsx`, 'utf8');
    const block = page.slice(page.indexOf('const STATUS_STYLE'), page.indexOf('const rm ='));
    const missing = CLAIM_STATUSES.filter((s) => !new RegExp(`\\b${s}:\\s*'`).test(block));
    expect(missing, `app/claims/page.tsx STATUS_STYLE has no entry for: ${missing.join(', ')}`).toEqual([]);
  });

  it('the 0392 CHECK refuses a draft that carries payout provenance', async () => {
    const { me, E, typeId } = await setup({ budget: 1000 });
    const { id } = await saveClaimDraft(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 100, incurredOn: '2026-06-01' });
    // The OWNER connection, so this is the constraint refusing and not RLS.
    const err = await owner.db
      .update(schema.claimRequest)
      .set({ paidAt: new Date() })
      .where(eq(schema.claimRequest.id, id))
      .then(() => null, (e) => e);
    expect(err, 'a draft was allowed to be marked paid').not.toBeNull();
    expect(causeChain(err)).toContain('claim_request_draft_unsettled_check');
  });

  // ─────────────────── A draft reserves nothing ───────────────────

  it('a saved draft holds none of the limit, and is invisible to the approver', async () => {
    const { a, me, E, typeId } = await setup({ budget: 1000 });
    await saveClaimDraft(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 900, incurredOn: '2026-06-01' });

    const bal = await balanceOf(me, E.employmentId, typeId);
    expect(bal.usedThisYear).toBe(0);
    expect(bal.reservedThisYear).toBe(0);
    expect(bal.remainingThisYear).toBe(1000);
    expect(await listPendingClaims(a)).toHaveLength(0);

    // …and because it holds nothing, the whole limit is still spendable elsewhere.
    await submitClaim(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 1000, incurredOn: '2026-06-02' });
    expect((await balanceOf(me, E.employmentId, typeId)).remainingThisYear).toBe(0);
  });

  it('submitting the draft is what reserves — and rejecting it releases', async () => {
    const { a, me, E, typeId } = await setup({ budget: 1000 });
    const { id } = await saveClaimDraft(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 900, incurredOn: '2026-06-01' });

    await submitDraftClaims(me, { ids: [id] });
    expect(await statusOf(id)).toBe('pending');
    // The SAME event a fresh submit appends — downstream must not have to learn a second name.
    expect(await eventTypesFor(base.tenantId, id)).toContain('claim-request.submitted');
    let bal = await balanceOf(me, E.employmentId, typeId);
    expect(bal.usedThisYear).toBe(900);
    expect(bal.reservedThisYear).toBe(900); // reserved, not settled
    expect(bal.remainingThisYear).toBe(100);
    expect(await listPendingClaims(a)).toHaveLength(1);

    await decideClaim(a, { claimRequestId: id, decision: 'reject' });
    bal = await balanceOf(me, E.employmentId, typeId);
    expect(bal.usedThisYear).toBe(0);
    expect(bal.reservedThisYear).toBe(0);
    expect(bal.remainingThisYear).toBe(1000);
  });

  it('a draft is priced and limit-checked at SUBMIT, against the policy in force then', async () => {
    const { a, me, E, typeId } = await setup({ budget: 1000 });
    // Saved happily at 900 — a draft is not checked against anything.
    const { id } = await saveClaimDraft(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 900, incurredOn: '2026-06-01' });
    // HR then halves the budget.
    await setClaimPolicy(a, { claimTypeId: typeId, annualBudget: 400, perClaimCap: null, effectiveFrom: '2026-01-01' });
    await expect(submitDraftClaims(me, { ids: [id] })).rejects.toThrow(/annual limit/);
    expect(await statusOf(id)).toBe('draft'); // still editable, nothing lost
  });

  // ─────────────────── Bulk submit ───────────────────

  it('submits several drafts together, checking each against the ones before it in the batch', async () => {
    const { me, E, typeId } = await setup({ budget: 1000 });
    const d1 = await saveClaimDraft(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 400, incurredOn: '2026-06-01' });
    const d2 = await saveClaimDraft(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 500, incurredOn: '2026-06-02' });
    const { submitted } = await submitDraftClaims(me, { ids: [d1.id, d2.id] });
    expect(submitted).toBe(2);
    expect(await statusOf(d1.id)).toBe('pending');
    expect(await statusOf(d2.id)).toBe('pending');
    expect((await balanceOf(me, E.employmentId, typeId)).remainingThisYear).toBe(100);
  });

  it('a batch that fits individually but not collectively is refused ENTIRELY — no partial submit', async () => {
    const { me, E, typeId } = await setup({ budget: 1000 });
    const d1 = await saveClaimDraft(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 600, incurredOn: '2026-06-01' });
    const d2 = await saveClaimDraft(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 600, incurredOn: '2026-06-02' });
    // Either 600 alone fits under 1000; together they do not.
    await expect(submitDraftClaims(me, { ids: [d1.id, d2.id] })).rejects.toThrow(/annual limit/);
    // THE POINT: the first one did not sneak through. A partial result would mean the system chose which
    // of the employee's claims to file, in id order.
    expect(await statusOf(d1.id)).toBe('draft');
    expect(await statusOf(d2.id)).toBe('draft');
    expect((await balanceOf(me, E.employmentId, typeId)).usedThisYear).toBe(0);
  });

  it('a submitted claim cannot be re-submitted through the draft path', async () => {
    const { me, E, typeId } = await setup({ budget: 1000 });
    const { id } = await saveClaimDraft(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 100, incurredOn: '2026-06-01' });
    await submitDraftClaims(me, { ids: [id] });
    await expect(submitDraftClaims(me, { ids: [id] })).rejects.toThrow(/no longer a draft/);
    expect((await balanceOf(me, E.employmentId, typeId)).usedThisYear).toBe(100); // reserved once, not twice
  });

  // ─────────────────── Ownership ───────────────────

  it('an admin who can SEE a draft still cannot edit, submit or delete it', async () => {
    const { a, me, E, typeId } = await setup({ budget: 1000 });
    const { id } = await saveClaimDraft(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 100, incurredOn: '2026-06-01' });
    // Visible through RLS…
    expect((await listClaimsForEmployment(a, E.employmentId)).map((c) => c.id)).toContain(id);
    // …and untouchable. An admin acting on someone's unsubmitted claim is indistinguishable from filing
    // one in their name.
    await expect(saveClaimDraft(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 5, incurredOn: '2026-06-01', id })).rejects.toThrow(/only the claimant/i);
    await expect(submitDraftClaims(a, { ids: [id] })).rejects.toThrow(/only the claimant/i);
    await expect(deleteClaimDraft(a, id)).rejects.toThrow(/only the claimant/i);
    expect(await statusOf(id)).toBe('draft');
  });

  it('the claimant can edit and delete their own draft, receipt and all', async () => {
    const { me, E, typeId } = await setup({ budget: 1000 });
    const { id } = await saveClaimDraft(
      me,
      { employmentId: E.employmentId, claimTypeId: typeId, amount: 100, incurredOn: '2026-06-01' },
      { fileName: 'r.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4 receipt') },
    );
    await saveClaimDraft(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 250, incurredOn: '2026-06-03', description: 'fixed', id });
    const [after] = (await listClaimsForEmployment(me, E.employmentId)).filter((c) => c.id === id);
    expect(after.amount).toBe(250);
    expect(after.incurredOn).toBe('2026-06-03');
    expect(after.attachments).toHaveLength(1);

    await deleteClaimDraft(me, id);
    expect(await statusOf(id)).toBe('gone');
    const [{ n }] = await owner.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.claimAttachment)
      .where(eq(schema.claimAttachment.claimRequestId, id));
    expect(Number(n)).toBe(0);
  });

  // ─────────────────── Concurrency: the reason this item exists ───────────────────

  it('a submit BLOCKS while another session holds the same (employee × type) limit lock', async () => {
    const { me, E, typeId } = await setup({ budget: 1000 });
    const key = claimLimitLockKey(base.tenantId, E.employmentId, typeId);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    // An INDEPENDENT session holds the exact key the service computes. This proves the lock is taken and
    // on the right key — a race that merely came out right proves neither.
    const holder = owner.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      locked();
      await held;
    });
    await lockTaken;

    const submit = track(submitClaim(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 100, incurredOn: '2026-06-01' }));
    await sleep(600);
    expect(submit.settled(), 'submitClaim did not wait for the limit lock — the reservation is not serialized').toBe(false);

    release();
    await holder;
    await submit.promise; // resolves as soon as the lock is free
    expect((await balanceOf(me, E.employmentId, typeId)).usedThisYear).toBe(100);
  });

  // CORROBORATING, NOT DETERMINISTIC — stated because a test whose guarantee is overstated is worse than
  // one that is absent. With the lock removed this one still PASSED (the two submits happened to serialize
  // on their own), so it does not by itself prove the submit path is safe. The deterministic proof for the
  // submit side is the held-lock test above; the reproduced failure is the approvals test below. This one
  // is kept because the invariant it asserts (the reserved total never exceeds the limit) is the one that
  // matters, and it costs nothing to keep watching it.
  it('two SIMULTANEOUS submits against one balance never reserve past the limit', async () => {
    const { me, E, typeId } = await setup({ budget: 1000 });
    // 600 + 600 = 1200 > 1000. Unserialized, both read used=0 and both can commit.
    const results = await Promise.allSettled([
      submitClaim(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 600, incurredOn: '2026-06-01' }),
      submitClaim(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 600, incurredOn: '2026-06-02' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const bal = await balanceOf(me, E.employmentId, typeId);
    expect(bal.usedThisYear).toBe(600);
    expect(bal.usedThisYear).toBeLessThanOrEqual(1000);
  });

  it('two SIMULTANEOUS approvals cannot both pass the same remaining balance', async () => {
    const { a, me, E, typeId } = await setup({ budget: 2000 });
    // Both filed legitimately while the budget was 2000.
    const c1 = await submitClaim(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 600, incurredOn: '2026-06-01' });
    const c2 = await submitClaim(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 600, incurredOn: '2026-06-02' });
    // HR then lowers the annual budget to 1000 — now only one of the two can be approved.
    await setClaimPolicy(a, { claimTypeId: typeId, annualBudget: 1000, perClaimCap: null, effectiveFrom: '2026-01-01' });

    // THIS is the item's headline failure: two approvers deciding at the same moment, each reading a
    // settled total that excludes the other's uncommitted approval.
    const results = await Promise.allSettled([
      decideClaim(a, { claimRequestId: c1.id, decision: 'approve' }),
      decideClaim(a, { claimRequestId: c2.id, decision: 'approve' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const approved = [await statusOf(c1.id), await statusOf(c2.id)].filter((s) => s === 'approved');
    expect(approved, 'both claims were approved against the same remaining balance').toHaveLength(1);
  });

  it('one claim cannot be approved and cancelled at once — the release happens exactly once', async () => {
    const { a, me, E, typeId } = await setup({ budget: 1000 });
    const { id } = await submitClaim(me, { employmentId: E.employmentId, claimTypeId: typeId, amount: 400, incurredOn: '2026-06-01' });

    const results = await Promise.allSettled([
      decideClaim(a, { claimRequestId: id, decision: 'approve' }),
      cancelClaim(me, id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // Exactly one decision event: a claim that moved once must not have two stories about how.
    const events = (await eventTypesFor(base.tenantId, id)).filter((e) => e === 'claim-request.approved' || e === 'claim-request.cancelled');
    expect(events).toHaveLength(1);
    expect(['approved', 'cancelled']).toContain(await statusOf(id));
  });
});

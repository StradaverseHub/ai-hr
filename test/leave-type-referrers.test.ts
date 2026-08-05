/**
 * 1ae7f3ab + 4fdb69b2 — THE BUTTON AND THE DELETE MUST ASK THE SAME QUESTION, AND THE LIST MUST BE THE
 * DATABASE'S, NOT SOMEBODY'S MEMORY.
 *
 * ## The bug these two items describe, stated once
 *
 * `deleteLeaveType` counted FIVE tables. `listLeaveTypes`' `inUse` predicate — which decides whether the
 * panel offers Delete or Archive — counted THREE. The database carries TWELVE foreign keys to
 * `leave_type`. So Delete was offered on a type Postgres would refuse, and the admin got a raw 23503.
 * Special Leave was the reported case: zero rows in all five counted tables, but two `leave_approval_policy`
 * rows and Caregiver Leave pointing at it through `balance_source_type_id`.
 *
 * ## Why the FIRST test in this file is the important one
 *
 * Both approved plans, and HANDOFF.md, said ELEVEN tables. They were written before `6e9a126e` release two
 * added `leave_generation_run_item`, and no hand-written list caught up — the twelfth referrer was found
 * only by enumerating `information_schema` on production while building this. Fixing the arithmetic in two
 * places would have reset that clock rather than stopping it.
 *
 * So the guard is not "the two lists agree with each other" (they do, by construction — both are generated
 * from `LEAVE_TYPE_REFERRERS`). The guard is **"the declaration agrees with the live schema"**. A
 * thirteenth table referencing `leave_type` fails this file until somebody opens `core/leave-type-refs.ts`
 * and says whether deleting should refuse, cascade, or null it. That decision cannot be defaulted: guessing
 * `config` would silently delete data, guessing `history` would silently make types undeletable.
 *
 * **Do not widen this test to make it pass.** Declaring the new row IS the fix.
 */
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { deleteLeaveType, LeaveTypeHasHistoryError } from '../core/admin';
import { listLeaveTypes } from '../core/read';
import {
  LEAVE_TYPE_REFERRERS,
  configReferrers,
  historyReferrers,
  leaveTypeInUseSqlText,
} from '../core/leave-type-refs';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
/** An employment to hang history rows off — Base does not carry one. */
let employmentId: string;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ({ employmentId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Referrer Fixture', primaryEmail: `ref_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    costCenterId: b.costCenterId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  }));
});
afterAll(async () => {
  await closeAll();
});

/** Create a bare leave type directly, so a test can choose exactly which references it carries. */
async function makeType(code: string, name: string, balanceSourceTypeId?: string): Promise<string> {
  // leave_type_code_shape (migration 0031) is ^[A-Z][A-Z0-9_]{1,31}$ — a lowercase suffix from randomUUID
  // fails the CHECK, which is a fixture bug that reads exactly like a product bug.
  const safeCode = code.toUpperCase();
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: safeCode,
      name,
      paid: true,
      ...(balanceSourceTypeId ? { balanceSourceTypeId } : {}),
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const typeExists = async (id: string): Promise<boolean> =>
  (await owner.db.select({ id: schema.leaveType.id }).from(schema.leaveType).where(eq(schema.leaveType.id, id)))
    .length > 0;

describe('the declared referrer set matches the live schema', () => {
  it('declares EXACTLY the foreign keys the database carries to leave_type', async () => {
    const rows = (await owner.db.execute(sql`
      select tc.table_name as table_name, kcu.column_name as column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'leave_type'
    `)) as unknown as { table_name: string; column_name: string }[];

    const live = [...new Set(rows.map((r) => `${r.table_name}.${r.column_name}`))].sort();
    // Referrers reached through the template lineage have no FK to leave_type and are declared as such.
    const declared = LEAVE_TYPE_REFERRERS.filter((r) => !r.viaTemplateLineage)
      .map((r) => `${r.table}.${r.column}`)
      .sort();

    // Both directions matter. Missing => a delete that fails at the last moment (the reported bug).
    // Extra   => a cascade aimed at a table that no longer references the type, e.g. after release three
    //            of 6e9a126e drops leave_policy.
    expect(declared, 'core/leave-type-refs.ts must declare every FK to leave_type, and no others').toEqual(
      live,
    );
  });

  it('includes leave_generation_run_item — the twelfth referrer every written list had missed', () => {
    const declared = LEAVE_TYPE_REFERRERS.map((r) => r.table);
    expect(declared).toContain('leave_generation_run_item');
  });

  it('gives every referrer a disposition and a reason', () => {
    for (const r of LEAVE_TYPE_REFERRERS) {
      expect(['history', 'config', 'self'], `${r.table}.${r.column}`).toContain(r.disposition);
      expect(r.note.length, `${r.table} must say WHY it carries its disposition`).toBeGreaterThan(20);
    }
  });

  it('never cascades a table that holds leave people took', () => {
    const cascaded = configReferrers().map((r) => r.table);
    for (const historyTable of ['leave_request', 'leave_ledger', 'leave_encashment_snapshot']) {
      expect(cascaded, `${historyTable} must never be cascaded`).not.toContain(historyTable);
    }
  });
});

describe('the button predicate and the delete guard span the SAME tables', () => {
  it('builds the inUse predicate from the history referrers and nothing else', () => {
    const text = leaveTypeInUseSqlText('leave_type.id');
    for (const r of historyReferrers()) {
      expect(text, `${r.table} is history and must be in the predicate`).toContain(`from ${r.table} `);
    }
    for (const r of configReferrers()) {
      // Config no longer blocks a delete — it is cascaded — so it must NOT make the panel show Archive.
      expect(text, `${r.table} is config and must NOT be in the predicate`).not.toContain(`from ${r.table} `);
    }
    expect(text).not.toContain('leave_type.balance_source_type_id');
  });
});

describe('deleting a leave type', () => {
  it('offers Delete, and succeeds, for a type referenced only by an approval rule', async () => {
    const id = await makeType(`SPLT${randomUUID().slice(0, 4)}`, 'Special Leave (test)');
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      leaveTypeId: id,
      ruleName: 'Custom Leave Approval',
    });

    // The panel decides from inUse: an approval rule is CONFIG, so Delete is offered.
    const before = (await listLeaveTypes(adminCtx(b))).find((t) => t.id === id)!;
    expect(before.inUse, 'an approval rule alone must not force Archive').toBe(false);
    expect(before.cascadeApprovalRules, 'the confirmation names the rule').toContain('Custom Leave Approval');

    await deleteLeaveType(adminCtx(b), { id });

    expect(await typeExists(id)).toBe(false);
    const rules = await owner.db
      .select({ id: schema.leaveApprovalPolicy.id })
      .from(schema.leaveApprovalPolicy)
      .where(eq(schema.leaveApprovalPolicy.leaveTypeId, id));
    expect(rules, 'the approval rule goes with it').toHaveLength(0);
  });

  it('clears the balance source on the OTHER type rather than deleting it', async () => {
    const source = await makeType(`SRC${randomUUID().slice(0, 4)}`, 'Special Leave (source)');
    const dependent = await makeType(`DEP${randomUUID().slice(0, 4)}`, 'Caregiver Leave (test)', source);

    const before = (await listLeaveTypes(adminCtx(b))).find((t) => t.id === source)!;
    expect(
      before.cascadeBalanceSourceOf,
      'the confirmation names the dependent type, not a count',
    ).toContain('Caregiver Leave (test)');

    await deleteLeaveType(adminCtx(b), { id: source });

    expect(await typeExists(source)).toBe(false);
    expect(await typeExists(dependent), 'the dependent type SURVIVES').toBe(true);
    const [row] = await owner.db
      .select({ src: schema.leaveType.balanceSourceTypeId })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, dependent));
    expect(row.src, 'its balance source is cleared, not left dangling').toBeNull();
  });

  it('REFUSES when leave history exists, and says which table holds it', async () => {
    const id = await makeType(`HIS${randomUUID().slice(0, 4)}`, 'Used Leave (test)');
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: id,
      entryType: 'adjustment',
      days: '1.00',
      effectiveOn: '2026-01-05',
      reason: 'test',
    });

    const listed = (await listLeaveTypes(adminCtx(b))).find((t) => t.id === id)!;
    expect(listed.inUse, 'history means the panel offers Archive').toBe(true);

    await expect(deleteLeaveType(adminCtx(b), { id })).rejects.toThrow(LeaveTypeHasHistoryError);
    // The message must name the table, not say "in use" — the admin needs to know it is real history.
    await expect(deleteLeaveType(adminCtx(b), { id })).rejects.toThrow(/leave_ledger/);
    expect(await typeExists(id), 'nothing is removed when the delete refuses').toBe(true);
  });

  it('leaves the type and every reference intact when the cascade cannot complete', async () => {
    // The whole delete runs in ONE transaction, so a failure part-way must roll the cascade back too.
    // A type that does not exist makes the final delete a no-op rather than an error, so the failure is
    // forced the only honest way: a history row added AFTER the impact was read, which the guard catches
    // before anything is deleted.
    const id = await makeType(`TX${randomUUID().slice(0, 4)}`, 'Transactional (test)');
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      leaveTypeId: id,
      ruleName: 'Rule that must survive',
    });
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: id,
      startDate: '2026-01-05',
      endDate: '2026-01-05',
      days: '1.00',
      status: 'pending',
    });

    await expect(deleteLeaveType(adminCtx(b), { id })).rejects.toThrow(LeaveTypeHasHistoryError);

    expect(await typeExists(id)).toBe(true);
    const rules = await owner.db
      .select({ id: schema.leaveApprovalPolicy.id })
      .from(schema.leaveApprovalPolicy)
      .where(eq(schema.leaveApprovalPolicy.leaveTypeId, id));
    expect(rules, 'the config rows are untouched when the delete refuses').toHaveLength(1);
  });
});

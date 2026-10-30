/**
 * 1d58019a — "Movement Settings Enhancement", Step 1 (ADR-0165): the tenant's termination-reason catalogue
 * and the event-type description, against a real database.
 *
 * The properties this suite holds:
 *
 *  1. AN OVERLAY. A tenant that configured nothing sees the thirteen built-in reasons, all active, and
 *     nothing was written to produce them.
 *  2. ONE OWNER FOR THE CLASSIFICATION. A built-in reason keeps its shipped turnover classification however
 *     it is renamed; a custom reason derives it from its group; a group is never re-pointed.
 *  3. A CUSTOM REASON IS A REAL REASON. A termination recorded with it ends employment exactly as a built-in
 *     reason would, writing the group's classification to employment.termination_type.
 *  4. HISTORY KEEPS ITS CODE. A used reason cannot be deleted; switching it off leaves every record as it
 *     was, and only stops it being offered for a NEW termination.
 *  5. TENANT ISOLATION AND ADMIN-ONLY SETTINGS, in the service and in the table's RLS.
 *  6. EVERY SETTINGS WRITE IS AUDITED on domain_event.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, asc } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { createMovementEvent, movementHistory } from '../core/movement';
import { TERMINATION_REASONS } from '../core/termination-reason';
import {
  deleteTerminationReason,
  listTerminationReasons,
  saveTerminationReason,
  setTerminationReasonActive,
  terminationReasonCatalogue,
} from '../core/termination-reason-catalog';
import {
  getMovementEventTypeForSettings,
  listMovementEventTypes,
  listMovementEventTypesForSettings,
  saveMovementEventType,
  setMovementEventTypeActive,
} from '../core/movement-type';
import { todayInKualaLumpur } from '../lib/hr-date';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const email = () => `trc_${randomUUID().slice(0, 8)}@t.local`;
const employeeCtx = (base: Base): SessionContext => ({ tenantId: base.tenantId, userId: base.adminUserId, roles: ['employee'] });
const PAST = (() => {
  const t = todayInKualaLumpur();
  const d = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10))) - 30 * 86_400_000);
  return d.toISOString().slice(0, 10);
})();

async function hireOne(base: Base = b) {
  return hireEmployee(adminCtx(base), {
    person: { fullName: 'Reason Subject', primaryEmail: email() },
    companyId: base.companyId,
    departmentId: base.deptA,
    positionId: base.positionId,
    costCenterId: base.costCenterId,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
}

const terminate = (base: Base, employmentId: string, terminationReasonCode: string) =>
  createMovementEvent(adminCtx(base), {
    employmentId,
    kind: 'termination',
    effectiveDate: PAST,
    endDate: PAST,
    terminationReasonCode,
  });

const employmentRow = async (id: string) => {
  const [row] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, id));
  return row;
};

/** The refusal text through drizzle's error wrapper, so the assertion proves an RLS refusal specifically. */
function pgText(e: unknown): string {
  const parts: string[] = [];
  for (let cur = e as Record<string, unknown> | undefined, n = 0; cur && typeof cur === 'object' && n < 5; cur = cur.cause as never, n++) {
    for (const k of ['message', 'detail']) if (typeof cur[k] === 'string') parts.push(cur[k] as string);
  }
  return parts.join(' | ');
}
async function rlsRefused(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal').not.toBeNull();
  expect(pgText(err)).toMatch(/row-level security/i);
}

const auditEvents = (tenantId: string, eventType: string) =>
  owner.db
    .select()
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, tenantId), eq(schema.domainEvent.eventType, eventType)))
    .orderBy(asc(schema.domainEvent.sequence));

describe('1d58019a — the reason catalogue is an overlay on the built-in list', () => {
  it('a tenant that configured nothing sees the thirteen built-ins, in order, active, with nothing stored', async () => {
    const rows = await listTerminationReasons(adminCtx(b));
    expect(rows.map((r) => r.code)).toEqual(TERMINATION_REASONS.map((r) => r.code));
    expect(rows.every((r) => r.builtIn && r.active && r.label === null && r.createdAt === null)).toBe(true);
    // Every built-in keeps its shipped classification (retirement → retired, not "voluntary").
    expect(rows.map((r) => r.terminationType)).toEqual(TERMINATION_REASONS.map((r) => r.type));
    const stored = await withTenant(adminCtx(b), (tx) => tx.select().from(schema.terminationReason));
    expect(stored).toHaveLength(0);
  });

  it('renaming a built-in changes its label and NOTHING else — its classification stays the shipped one', async () => {
    await saveTerminationReason(adminCtx(b), { code: 'retirement', label: 'Normal Retirement' });
    const row = (await listTerminationReasons(adminCtx(b))).find((r) => r.code === 'retirement')!;
    expect(row.label).toBe('Normal Retirement');
    expect(row.category).toBe('voluntary');
    expect(row.terminationType, 'the finer shipped mapping survives a rename').toBe('retired');
    expect(row.builtIn).toBe(true);
    expect(row.createdAt, 'a renamed built-in still reports no creation date').toBeNull();
  });

  it('a custom reason joins its group and derives the group classification; the group cannot be re-pointed', async () => {
    const { code } = await saveTerminationReason(adminCtx(b), { label: 'Mutual Separation', category: 'involuntary' });
    expect(code).toBe('mutual_separation');
    const row = (await listTerminationReasons(adminCtx(b))).find((r) => r.code === code)!;
    expect(row).toMatchObject({ category: 'involuntary', terminationType: 'involuntary', builtIn: false, active: true });
    expect(row.createdAt).toBeInstanceOf(Date);

    await expect(
      saveTerminationReason(adminCtx(b), { code, label: 'Mutual Separation', category: 'voluntary' }),
    ).rejects.toThrow(/keeps the group/i);
    await expect(saveTerminationReason(adminCtx(b), { label: 'Sabbatical Exit', category: 'sabbatical' })).rejects.toThrow(
      /choose the group/i,
    );
    await expect(saveTerminationReason(adminCtx(b), { label: 'Redundancy', category: 'other' })).rejects.toThrow(
      /standard reason/i,
    );
    await expect(saveTerminationReason(adminCtx(b), { label: 'Mutual  Separation', category: 'other' })).rejects.toThrow(
      /already exists/i,
    );
  });

  it('every settings write appends an audit event', async () => {
    const { code } = await saveTerminationReason(adminCtx(b), { label: 'Visa Not Renewed', category: 'other' });
    await saveTerminationReason(adminCtx(b), { code, label: 'Work Pass Not Renewed' });
    await setTerminationReasonActive(adminCtx(b), { code, active: false });
    await deleteTerminationReason(adminCtx(b), code);
    const saved = await auditEvents(b.tenantId, 'termination-reason.saved');
    expect(saved.map((e) => (e.payload as { label: string }).label)).toEqual([
      'Visa Not Renewed',
      'Work Pass Not Renewed',
      'Work Pass Not Renewed',
    ]);
    expect((saved[2].payload as { isActive: boolean }).isActive).toBe(false);
    const deleted = await auditEvents(b.tenantId, 'termination-reason.deleted');
    expect(deleted.map((e) => (e.payload as { code: string }).code)).toEqual([code]);
    expect(deleted[0].actorId).toBe(b.adminUserId);
  });
});

describe('1d58019a — a custom reason is a real termination reason', () => {
  it('ends employment and writes the group classification and the code', async () => {
    const hire = await hireOne();
    const { code } = await saveTerminationReason(adminCtx(b), { label: 'Mutual Separation', category: 'involuntary' });
    await terminate(b, hire.employmentId, code);
    const emp = await employmentRow(hire.employmentId);
    expect(emp.terminatedOn).toBe(PAST);
    expect(emp.terminationReasonCode).toBe(code);
    expect(emp.terminationType, 'derived from the group, not left null').toBe('involuntary');
  });

  it('an unknown code is still refused — a forged form field cannot invent a reason', async () => {
    const hire = await hireOne();
    await expect(terminate(b, hire.employmentId, 'not_a_reason')).rejects.toThrow(/unknown termination reason/i);
  });
});

describe('1d58019a — history keeps the code it recorded', () => {
  it('a used reason cannot be deleted; switching it off leaves the record and refuses only NEW terminations', async () => {
    const first = await hireOne();
    const second = await hireOne();
    const { code } = await saveTerminationReason(adminCtx(b), { label: 'Contract Not Extended', category: 'involuntary' });
    await terminate(b, first.employmentId, code);
    expect((await listTerminationReasons(adminCtx(b))).find((r) => r.code === code)!.inUse).toBe(true);

    await expect(deleteTerminationReason(adminCtx(b), code)).rejects.toThrow(/switch it off/i);

    await setTerminationReasonActive(adminCtx(b), { code, active: false });
    // The record still carries exactly the code and classification it was written with…
    const emp = await employmentRow(first.employmentId);
    expect(emp.terminationReasonCode).toBe(code);
    expect(emp.terminationType).toBe('involuntary');
    // …the history still renders the termination…
    expect((await movementHistory(adminCtx(b), first.employmentId)).map((r) => r.kind)).toContain('termination');
    // …the catalogue still resolves it (flagged off) for display and correction…
    expect((await terminationReasonCatalogue(adminCtx(b))).find((r) => r.code === code)).toMatchObject({ active: false });
    // …and only a NEW termination is refused.
    await expect(terminate(b, second.employmentId, code)).rejects.toThrow(/switched off/i);
  });

  it('a switched-off BUILT-IN reason is refused for a new termination too, and switching it back on restores it', async () => {
    const hire = await hireOne();
    await setTerminationReasonActive(adminCtx(b), { code: 'redundancy', active: false });
    await expect(terminate(b, hire.employmentId, 'redundancy')).rejects.toThrow(/switched off/i);
    await setTerminationReasonActive(adminCtx(b), { code: 'redundancy', active: true });
    await terminate(b, hire.employmentId, 'redundancy');
    expect((await employmentRow(hire.employmentId)).terminationReasonCode).toBe('redundancy');
  });

  it('a built-in reason cannot be deleted; an unused custom one can', async () => {
    await expect(deleteTerminationReason(adminCtx(b), 'misconduct')).rejects.toThrow(/cannot be deleted/i);
    const { code } = await saveTerminationReason(adminCtx(b), { label: 'Unused Reason', category: 'other' });
    await deleteTerminationReason(adminCtx(b), code);
    expect((await listTerminationReasons(adminCtx(b))).some((r) => r.code === code)).toBe(false);
  });
});

describe('1d58019a — permissions and tenant isolation', () => {
  it('a non-admin can neither view the settings nor change them', async () => {
    const ctx = employeeCtx(b);
    await expect(listTerminationReasons(ctx)).rejects.toThrow(/only an admin/i);
    await expect(saveTerminationReason(ctx, { label: 'Sneaky', category: 'other' })).rejects.toThrow(/only an admin/i);
    await expect(setTerminationReasonActive(ctx, { code: 'redundancy', active: false })).rejects.toThrow(/only an admin/i);
    await expect(deleteTerminationReason(ctx, 'redundancy')).rejects.toThrow(/only an admin/i);
    await expect(listMovementEventTypesForSettings(ctx)).rejects.toThrow(/only an admin/i);
    await expect(getMovementEventTypeForSettings(ctx, 'transfer')).rejects.toThrow(/only an admin/i);
  });

  it('RLS refuses a non-admin write even outside the service', async () => {
    await rlsRefused(
      withTenant(employeeCtx(b), (tx) =>
        tx.insert(schema.terminationReason).values({ tenantId: b.tenantId, code: 'rls_probe', category: 'other' }),
      ),
    );
  });

  it('one tenant never sees, resolves or writes another tenant’s reasons', async () => {
    const other = await seedBase();
    const { code } = await saveTerminationReason(adminCtx(b), { label: 'Tenant A Only', category: 'voluntary' });
    await setTerminationReasonActive(adminCtx(b), { code: 'misconduct', active: false });

    const seenByOther = await listTerminationReasons(adminCtx(other));
    expect(seenByOther.some((r) => r.code === code)).toBe(false);
    expect(seenByOther.find((r) => r.code === 'misconduct')!.active, 'A’s switch-off does not leak to B').toBe(true);

    // B cannot record a termination with A's code…
    const hireB = await hireOne(other);
    await expect(terminate(other, hireB.employmentId, code)).rejects.toThrow(/unknown termination reason/i);
    // …and cannot write a row into A's tenant, even as an admin.
    await rlsRefused(
      withTenant(adminCtx(other), (tx) =>
        tx.insert(schema.terminationReason).values({ tenantId: b.tenantId, code: 'cross_tenant', category: 'other' }),
      ),
    );
  });
});

describe('1d58019a — event-type description', () => {
  it('is saved, listed for the New Event form, cleared by a blank, and audited', async () => {
    const { code } = await saveMovementEventType(adminCtx(b), {
      label: 'Redeployment',
      behaviourKind: 'transfer',
      description: '  Reassignment after a restructure.  ',
    });
    const row = (await listMovementEventTypes(adminCtx(b))).find((r) => r.code === code)!;
    expect(row.description).toBe('Reassignment after a restructure.');

    // A rename that does not post a description leaves it alone; switching off leaves it alone.
    await saveMovementEventType(adminCtx(b), { code, label: 'Redeployment (Ops)' });
    await setMovementEventTypeActive(adminCtx(b), { code, active: false });
    expect((await getMovementEventTypeForSettings(adminCtx(b), code))!.description).toBe('Reassignment after a restructure.');

    await saveMovementEventType(adminCtx(b), { code, label: 'Redeployment (Ops)', description: '   ' });
    expect((await getMovementEventTypeForSettings(adminCtx(b), code))!.description).toBeNull();

    // A built-in gets a description through its overlay row, and keeps its behaviour.
    await saveMovementEventType(adminCtx(b), { code: 'transfer', label: 'Transfer', description: 'Same company.' });
    expect((await getMovementEventTypeForSettings(adminCtx(b), 'transfer'))).toMatchObject({
      description: 'Same company.',
      behaviourKind: 'transfer',
      builtIn: true,
    });

    const saved = await auditEvents(b.tenantId, 'movement-event-type.saved');
    expect(saved.map((e) => (e.payload as { description: string | null }).description)).toContain(
      'Reassignment after a restructure.',
    );
  });

  it('refuses an over-long description and the reserved code `new`', async () => {
    await expect(
      saveMovementEventType(adminCtx(b), { label: 'Long One', behaviourKind: 'transfer', description: 'x'.repeat(1001) }),
    ).rejects.toThrow(/1000 characters/);
    await expect(saveMovementEventType(adminCtx(b), { label: 'New', behaviourKind: 'secondment' })).rejects.toThrow(
      /reserved/i,
    );
  });
});

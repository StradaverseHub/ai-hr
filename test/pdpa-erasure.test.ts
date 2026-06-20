/**
 * #159 — erasePersonPii (ADR-0030 §2). The retention guard withholds statutory-locked fields under the
 * ~7yr LHDN/EPF/SOCSO hold and only releases them once it lifts; contact PII erases freely; the vault is
 * crypto-shredded; and the pii.erased event carries no PII.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { erasePersonPii } from '../core/pdpa';
import { SubjectShreddedError, sealForSubject, unsealForSubject } from '../core/pii-vault';

let b: Base;

async function makeSubject(opts: { terminatedOn?: string | null } = {}) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({
      tenantId: b.tenantId,
      fullName: 'Subject',
      primaryEmail: `s_${randomUUID()}@t.local`,
      phone: '+60123456789',
      address: '12 Jalan Test',
      emergencyContactName: 'Next Of Kin',
      emergencyContactPhone: '+60198887777',
      dateOfBirth: '1990-05-05',
    })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2015-01-01', terminatedOn: opts.terminatedOn ?? null })
    .returning({ id: schema.employment.id });
  await owner.db.insert(schema.employeeStatutoryMy).values({
    tenantId: b.tenantId,
    personId: p.id,
    icNumber: randomUUID().replace(/[^0-9]/g, '').padEnd(12, '0').slice(0, 12),
    bankName: 'Maybank',
    bankAccountNo: '514122334455',
    epfNumber: 'EPF999',
    socsoNumber: 'SOC888',
    taxNumber: 'SG777',
  });
  return { personId: p.id, employmentId: e.id };
}

beforeAll(async () => {
  process.env.AI_CONFIG_SECRET = 'test-pii-master-passphrase-0123456789';
  await migrateTestDb();
});
afterAll(async () => {
  delete process.env.AI_CONFIG_SECRET;
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('erasePersonPii — PDPA retention guard (ADR-0030, #159)', () => {
  it('while employed: erases contact PII, withholds every statutory-locked field with a reason', async () => {
    const ctx = adminCtx(b);
    const { personId, employmentId } = await makeSubject({ terminatedOn: null });
    const r = await erasePersonPii(ctx, { subjectEmploymentId: employmentId, scope: 'all', reason: 'subject request', requestRef: 'DPO-1' });
    expect(r.erased.sort()).toEqual(['address', 'emergencyContactName', 'emergencyContactPhone', 'phone']);
    expect(r.withheld.map((w) => w.field).sort()).toEqual(['bankAccountNo', 'bankName', 'dateOfBirth', 'epfNumber', 'socsoNumber', 'taxNumber']);
    expect(r.withheld.every((w) => /retention/i.test(w.reason))).toBe(true);

    const [pp] = await owner.db.select().from(schema.person).where(eq(schema.person.id, personId));
    expect(pp.phone).toBeNull();
    expect(pp.address).toBeNull();
    expect(pp.dateOfBirth).not.toBeNull(); // statutory-locked → withheld
    const [st] = await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, personId));
    expect(st.bankAccountNo).toBe('514122334455'); // retained under hold
    expect(await eventTypesFor(b.tenantId, personId)).toContain('pii.erased');
  });

  it('after the 7-year hold lifts (terminated long ago): statutory fields become erasable', async () => {
    const ctx = adminCtx(b);
    const { personId, employmentId } = await makeSubject({ terminatedOn: '2015-06-30' });
    const r = await erasePersonPii(ctx, { subjectEmploymentId: employmentId, scope: 'financial', reason: 'r', requestRef: 'DPO-2' });
    expect(r.erased).toContain('bankAccountNo');
    expect(r.withheld).toHaveLength(0);
    const [st] = await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, personId));
    expect(st.bankAccountNo).toBeNull();
  });

  it('crypto-shreds the vault so previously sealed values become unrecoverable', async () => {
    const ctx = adminCtx(b);
    const { employmentId } = await makeSubject();
    const token = await sealForSubject(ctx, employmentId, 'sealed-nric');
    const r = await erasePersonPii(ctx, { subjectEmploymentId: employmentId, scope: 'all', reason: 'r', requestRef: 'DPO-3' });
    expect(r.shreddedKeys).toBe(1);
    await expect(unsealForSubject(ctx, employmentId, token)).rejects.toBeInstanceOf(SubjectShreddedError);
  });

  it('keeps PII out of the pii.erased event payload', async () => {
    const ctx = adminCtx(b);
    const { personId, employmentId } = await makeSubject();
    await erasePersonPii(ctx, { subjectEmploymentId: employmentId, scope: 'all', reason: 'r', requestRef: 'DPO-4' });
    const evs = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, personId));
    const blob = JSON.stringify(evs.map((e) => e.payload));
    expect(blob).not.toContain('+60123456789'); // phone
    expect(blob).not.toContain('514122334455'); // bank
    expect(blob).toContain('DPO-4'); // requestRef is fine
  });
});

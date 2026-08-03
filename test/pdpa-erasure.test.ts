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
      dateOfBirth: '1990-05-05',
    })
    .returning({ id: schema.person.id });
  // 23ad620e — the emergency contact is no longer two columns on `person` (migration 0322 dropped them);
  // it is a row in the register, and erasure must reach it there.
  await owner.db.insert(schema.personEmergencyContact).values({
    tenantId: b.tenantId,
    personId: p.id,
    fullName: 'Next Of Kin',
    mobilePhone: '+60198887777',
    priority: 'primary',
  });
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
    // b4682879 widened the PII registry: structured address + extra contact fields (contact scope), name
    // parts + s.40 demographics + the profile photo (identity scope) — all erasable immediately.
    expect(r.erased.sort()).toEqual([
      'address',
      'addressLine1',
      'addressLine2',
      'addressLine3',
      'city',
      'correspondenceAddressLine1',
      'correspondenceAddressLine2',
      'correspondenceAddressLine3',
      'correspondenceCity',
      'correspondenceCountry',
      // bf953339 — Home + Correspondence phone pair joins the contact scope (erasable immediately).
      'correspondenceHomePhone',
      'correspondenceMobilePhone',
      'correspondencePostcode',
      'correspondenceState',
      'country',
      // 23ad620e — the five emergencyContact* person columns are gone (migration 0322). The register they
      // became is erased WHOLESALE and reported once, under this one name.
      'emergencyContacts',
      'firstName',
      'homePhone',
      'lastName',
      'nationality',
      'permanentAddressLine1',
      'permanentAddressLine2',
      'permanentAddressLine3',
      'permanentCity',
      'permanentCountry',
      'permanentPostcode',
      'permanentState',
      'personalEmail',
      'phone',
      'postcode',
      'preferredName',
      'profilePhoto',
      'race',
      'religion',
      'state',
    ]);
    // d64d0df4 — `childReliefTable` joins the statutory-locked set. It records how many of an employee's
    // children fall into a DISABLED relief category: health data about people who are not the employee,
    // and a PCB input, so it is withheld while the LHDN retention hold stands and erased once it lifts —
    // the decision recorded beside PII_FIELDS in core/pdpa.ts. (The two disability BOOLEANS are NOT here:
    // they are NOT NULL columns and the erasure mechanism only ever writes NULL — also recorded there.)
    expect(r.withheld.map((w) => w.field).sort()).toEqual([
      'bankAccountNo',
      'bankName',
      'childReliefTable',
      'dateOfBirth',
      'epfNumber',
      'socsoNumber',
      'taxNumber',
    ]);
    expect(r.withheld.every((w) => /retention/i.test(w.reason))).toBe(true);

    const [pp] = await owner.db.select().from(schema.person).where(eq(schema.person.id, personId));
    expect(pp.phone).toBeNull();
    expect(pp.address).toBeNull();
    expect(pp.dateOfBirth).not.toBeNull(); // statutory-locked → withheld
    // The register is the ONLY home for the emergency contact now, so if erasure misses it the next-of-kin's
    // name and phone survive the erasure entirely — this assertion is what would notice.
    expect(
      await owner.db
        .select()
        .from(schema.personEmergencyContact)
        .where(eq(schema.personEmergencyContact.personId, personId)),
    ).toEqual([]);
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

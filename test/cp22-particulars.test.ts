/**
 * d3a9383c / 88076362 — `cp22Particulars`, the read behind the CP22 download.
 *
 * TWO REFUSALS AND ONE PROMISE. The refusals are the load-bearing part: an employment the caller may not
 * see reads as ABSENT (RLS returns nothing, the read returns null, the route answers 404 — the same 404 an
 * unknown id gets, so the URL cannot be used to find out who exists), and a company whose jurisdiction no
 * pack owns has no CP22 at all, because CP22 is an LHDN form and telling a non-Malaysian company it has a
 * Malaysian filing obligation is the exact harm ADR-0080 slice 6 fixed in the worklist beside this.
 *
 * The promise is that NOTHING IS EVER INVENTED. Every absent record travels as null to an empty, editable
 * box: no spouse, no Malaysian identity row, no salary row, no signatory. The one that would be easiest to
 * get wrong is the signatory — an admin who is not themselves an employee has no name to sign with, and
 * the company's name is NOT a person's name.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { addDependent } from '../core/dependents';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { cp22Particulars } from '../core/reporting';

describe('cp22Particulars — the CP22 read', () => {
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

  /** A Malaysian joiner with the full set of records the form draws on. */
  const seedJoiner = async () => {
    const a = adminCtx(base);
    await owner.db
      .update(schema.company)
      .set({
        addressLine1: 'No. 12, Jalan Damai 3',
        addressLine2: 'Taman Damai',
        postcode: '43000',
        city: 'Kajang',
        state: 'Selangor',
        phone: '03-87381234',
      })
      .where(eq(schema.company.id, base.companyId));
    await owner.db.insert(schema.companyStatutoryMy).values({
      tenantId: base.tenantId,
      companyId: base.companyId,
      lhdnEmployerNo: 'E 1234567890',
    });

    const e = await hireEmployee(a, {
      person: { fullName: 'Nur Aisyah binti Rahman', primaryEmail: 'aisyah@acme.test', nationality: 'Malaysian' },
      companyId: base.companyId,
      departmentId: base.deptA,
      positionId: base.positionId,
      employmentType: 'full_time',
      hiredOn: '2026-07-02',
    });
    await owner.db
      .update(schema.person)
      .set({
        phone: '012-3456789',
        personalEmail: 'aisyah.personal@example.test',
        dateOfBirth: '1990-01-01',
        gender: 'female',
        maritalStatus: 'married',
        permanentAddressLine1: 'No. 8, Jalan Melur 2/3',
        permanentPostcode: '68000',
        permanentCity: 'Ampang',
        permanentState: 'Selangor',
        correspondenceAddressLine1: 'PO Box 100',
        correspondencePostcode: '50450',
        correspondenceCity: 'Kuala Lumpur',
        correspondenceState: 'Wilayah Persekutuan',
      })
      .where(eq(schema.person.id, e.personId));
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101101234',
      taxNumber: 'SG12345678901',
      taxCategory: 2,
      numChildren: 0,
    });
    await owner.db
      .update(schema.employeeStatutoryMy)
      .set({ passportNumber: 'A12345678' })
      .where(eq(schema.employeeStatutoryMy.personId, e.personId));
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 6500,
      monthlyAllowance: 250,
      effectiveFrom: '2026-07-02',
    });
    return e;
  };

  it('fills the form from the records that exist, and only from those', async () => {
    const e = await seedJoiner();
    const p = (await cp22Particulars(adminCtx(base), { employmentId: e.employmentId, today: '2026-08-09' }))!;
    expect(p).not.toBeNull();

    expect(p.employer.name).toBe('Acme Sdn Bhd');
    expect(p.employer.eNumber).toBe('E 1234567890');
    expect(p.employer.phone).toBe('03-87381234');
    expect(p.employer.addressLines).toEqual(['No. 12, Jalan Damai 3', 'Taman Damai', '43000 Kajang, Selangor']);

    expect(p.employee.fullName).toBe('Nur Aisyah binti Rahman');
    // B15 Jawatan is the job title; B17 Jenis pekerjaan is the KIND of engagement. The 2020 page asked
    // only one of these and the title answered it; on the 2021 page they are two different boxes.
    expect(p.employee.designation).toBe('Executive'); // the current assignment's position title
    // …and the stored 'full_time' loses its underscore: a database separator on a government form
    // reads as a leak rather than an answer. The vocabulary itself is unchanged.
    expect(p.employee.natureOfEmployment).toBe('Full time');
    expect(p.employee.commencementDate).toBe('2026-07-02');
    expect(p.employee.expectedDuration).toBe('Permanent');
    // THE SPLIT. Street lines stay street lines; postcode, town and state travel separately to the three
    // boxes LHDN prints for them. A tail line like '68000 Ampang, Selangor' here would mean the 2020 fold
    // survived and those three printed boxes ship empty.
    expect(p.employee.residentialAddress).toEqual({
      lines: ['No. 8, Jalan Melur 2/3'],
      postcode: '68000',
      town: 'Ampang',
      state: 'Selangor',
    });
    expect(p.employee.correspondenceAddress).toEqual({
      lines: ['PO Box 100'],
      postcode: '50450',
      town: 'Kuala Lumpur',
      state: 'Wilayah Persekutuan',
    });
    // The EMPLOYER's address keeps the folded tail, because section A gives it three free rows and no
    // structured postcode/town/state boxes at all. The asymmetry is the artwork's, not an oversight.
    expect(p.employee.phone).toBe('012-3456789');
    // The PERSONAL address wins over the login address for a form that goes to LHDN.
    expect(p.employee.email).toBe('aisyah.personal@example.test');
    expect(p.employee.incomeTaxNo).toBe('SG12345678901');
    expect(p.employee.icNo).toBe('900101101234');
    expect(p.employee.passportNo).toBe('A12345678');
    expect(p.employee.gender).toBe('female');
    expect(p.employee.citizen).toBe('Malaysian');
    expect(p.employee.dateOfBirth).toBe('1990-01-01');
    expect(p.employee.maritalStatus).toBe('married');

    expect(p.pay.salaryAndOvertime).toBe(6500); // D1
    expect(p.pay.cashAllowances).toEqual([ // D4
      { label: 'Elaun tetap bulanan / Fixed monthly allowance', amount: 250 },
    ]);
    expect(p.today).toBe('2026-08-09');
  });

  it('reads the spouse from the family register, and reports none when there is none', async () => {
    const e = await seedJoiner();
    const a = adminCtx(base);

    const none = await cp22Particulars(a, { employmentId: e.employmentId });
    expect(none!.spouse).toBeNull();

    await addDependent(a, {
      personId: e.personId,
      fullName: 'Ahmad bin Ismail',
      relationship: 'spouse',
      icOrPassport: '880202105678',
      // C4 is NEW on the 2021 edition, and employeeDependent.phone already held it — no migration.
      phone: '019-8765432',
    });
    const withSpouse = await cp22Particulars(a, { employmentId: e.employmentId });
    expect(withSpouse!.spouse).toEqual({
      fullName: 'Ahmad bin Ismail',
      icOrPassport: '880202105678',
      phone: '019-8765432',
    });
  });

  /**
   * The spouse's income tax number and the "previous employer in Malaysia" have NO home in the schema, and
   * employeeDependent.companyName / employerAddress — which do exist — are the SPOUSE'S employer. The read
   * must not reach for them: they are a different fact that happens to have a similar name.
   */
  it('never fills "previous employer" from the spouse’s employer columns', async () => {
    const e = await seedJoiner();
    const a = adminCtx(base);
    await addDependent(a, {
      personId: e.personId,
      fullName: 'Ahmad bin Ismail',
      relationship: 'spouse',
      companyName: 'Spouse Employer Sdn Bhd',
      employerAddress: 'Somewhere Else',
    });
    const p = (await cp22Particulars(a, { employmentId: e.employmentId }))!;
    expect(JSON.stringify(p)).not.toContain('Spouse Employer Sdn Bhd');
    expect(JSON.stringify(p)).not.toContain('Somewhere Else');
  });

  it('leaves the identity boxes null when the employee has no Malaysian statutory row', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Newcomer', primaryEmail: 'newcomer@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-07-15',
    });
    const p = (await cp22Particulars(a, { employmentId: e.employmentId }))!;
    expect(p.employee.incomeTaxNo).toBeNull();
    expect(p.employee.icNo).toBeNull();
    expect(p.employee.passportNo).toBeNull();
    expect(p.pay.salaryAndOvertime).toBeNull();
    expect(p.pay.cashAllowances).toEqual([]);
    expect(p.employee.residentialAddress).toEqual({ lines: [], postcode: null, town: null, state: null });
  });

  /**
   * `SessionContext.personId` is documented null for an admin not tied to an employee. There is no honest
   * fallback for a signature block — the company's legal name is not a person — so both boxes stay blank
   * and the operator writes their own name in the downloaded file.
   */
  it('signs with the caller’s own name only when the caller is an employee with an assignment', async () => {
    const e = await seedJoiner();
    const a = adminCtx(base);

    const unsigned = (await cp22Particulars(a, { employmentId: e.employmentId }))!;
    expect(unsigned.declarant).toEqual({ name: null, designation: null, icOrPassport: null });
    expect(unsigned.declarant.name).not.toBe('Acme Sdn Bhd');

    const hr = await hireEmployee(a, {
      person: { fullName: 'Tan Wei Ming', primaryEmail: 'weiming@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      positionId: base.positionId,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    const hrUser = await createAppUser(base.tenantId, hr.personId, 'hr_admin');
    const hrCtx: SessionContext = { ...a, userId: hrUser, personId: hr.personId };
    const signed = (await cp22Particulars(hrCtx, { employmentId: e.employmentId }))!;
    // F2 asks for the DECLARANT'S own identification number — their record, on a form they sign. Null
    // here because this HR person has no Malaysian statutory row; the box stays empty and typeable.
    expect(signed.declarant).toEqual({ name: 'Tan Wei Ming', designation: 'Executive', icOrPassport: null });

    await setStatutoryProfileMY(a, {
      personId: hr.personId,
      icNumber: '850505145555',
      taxCategory: 1,
      numChildren: 0,
    });
    const withIc = (await cp22Particulars(hrCtx, { employmentId: e.employmentId }))!;
    expect(withIc.declarant.icOrPassport).toBe('850505145555');
  });

  /** employmentType is on ASSIGNMENT, not on employment — and it is what decides this box. */
  it('states the contract dates for a contract hire and Permanent for everyone else', async () => {
    const a = adminCtx(base);
    const c = await hireEmployee(a, {
      person: { fullName: 'Contract Hire', primaryEmail: 'contract@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'contract',
      hiredOn: '2026-07-01',
    });
    await owner.db
      .update(schema.employment)
      .set({ contractStartDate: '2026-07-01', contractEndDate: '2027-06-30' })
      .where(eq(schema.employment.id, c.employmentId));
    const contract = (await cp22Particulars(a, { employmentId: c.employmentId }))!;
    expect(contract.employee.expectedDuration).toBe('2026-07-01 - 2027-06-30');

    const perm = await seedJoiner();
    const permanent = (await cp22Particulars(a, { employmentId: perm.employmentId }))!;
    expect(permanent.employee.expectedDuration).toBe('Permanent');
  });

  it('returns null for an employment the caller may not see — the route’s 404', async () => {
    const e = await seedJoiner();
    const a = adminCtx(base);
    const peer = await hireEmployee(a, {
      person: { fullName: 'Peer B', primaryEmail: 'peer.b@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const peerUser = await createAppUser(base.tenantId, peer.personId, 'employee');
    const peerCtx: SessionContext = {
      tenantId: base.tenantId,
      userId: peerUser,
      personId: peer.personId,
      roles: ['employee'],
    };
    expect(await cp22Particulars(peerCtx, { employmentId: e.employmentId })).toBeNull();
    // …and their OWN employment is visible, so the null above is the RLS gate and not a broken query.
    expect(await cp22Particulars(a, { employmentId: peer.employmentId })).not.toBeNull();
  });

  it('returns null for a company no country pack owns — CP22 is an LHDN form', async () => {
    const a = adminCtx(base);
    const [foreign] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Overseas Plant', country: 'SG', currency: 'SGD' })
      .returning({ id: schema.company.id });
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: base.tenantId, fullName: 'Wei', primaryEmail: 'wei@overseas.test' })
      .returning({ id: schema.person.id });
    const [emp] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: base.tenantId, companyId: foreign.id, personId: p.id, hiredOn: '2026-07-10' })
      .returning({ id: schema.employment.id });

    expect(await cp22Particulars(a, { employmentId: emp.id })).toBeNull();
  });
});

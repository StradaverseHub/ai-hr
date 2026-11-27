/**
 * Board 2c1b2fba — WHAT THE DRAFT EMPLOYEE PAGE GAINED, SAVED, REOPENED AND ACTIVATED, against a real database.
 *
 * The draft now carries four registers (emergency contacts, qualifications, pay items, cost-centre allocation rows),
 * the eight organisation labels, the bank payee residency, the declared child-relief grid, a required Payment Method
 * and a photo (its own side table, migration 7610). A draft still creates no person and no employment: everything is
 * judged before the hire and written by its existing owner inside the ONE activation transaction.
 *
 * (a) save + reopen round trip for every new list and field (saveEmployeeDraft / getEmployeeDraft);
 * (b) one activation, as createEmployeeAction calls it (saveAndCompleteEmployeeDraft), landing every section through
 *     its owner, read back with independent expected values; then a one-cost-centre draft (assignment carries it);
 * (c) failure atomicity: an invalid item in any section refuses activation naming the right {tab, field}, creates no
 *     person or employment (nor any register row) and keeps the draft and its held Employee ID;
 * (d) legacy drafts (no new keys, a single employment.costCenterId, current_step 5, a stored monthly allowance) open
 *     and activate;
 * (e) cross-tenant: another tenant's draft cannot be read, saved, activated or given a photo.
 *
 * One beforeAll, one base tenant reused by every case (the 20-minute job limit). All names are invented.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  completeEmployeeDraft, createEmployeeDraftWithReservedCode, draftActivationValidation, getEmployeeDraft,
  saveAndCompleteEmployeeDraft, saveEmployeeDraft,
} from '../core/employee-draft';
import { DraftPhotoError, getEmployeeDraftPhoto, hasEmployeeDraftPhoto, setEmployeeDraftPhoto } from '../core/employee-draft-photo';
import { createConfig } from '../core/employee-id-config';
import { createProfileOption } from '../core/profile-options';
import { listPayComponents, seedPayComponentCatalog } from '../packs/payroll/service';
import {
  draftAssignmentCostCenter, draftCostAllocations, missingByTab, missingForCreation, openingTab, stepKey,
  type EmployeeDraftData,
} from '../lib/employee-draft-schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

/** Cases that activate several drafts. No CI duration measured yet (first run): 90 s is a generous first ceiling
 *  (docs/SCALE-AND-RELEASE-RULES.md rule 15), to be set to about 3× the measured duration after the run. */
const MULTI_ACTIVATION_TIMEOUT = 90_000;
const HIRED_ON = '2026-03-01';

let b: Base, a: SessionContext;
/** The base company's own cost centre (seedBase) and a second one usable by it; one usable only by another company. */
let cc1: string, cc2: string, ccForeign: string, otherCompanyId: string;
/** Ready pay items: ALLOWANCE and HOUSING for every company; COLA restricted to the other company. */
let allowanceId: string, housingId: string, colaId: string;

const LABELS = {
  orgDivision: 'Fictional North Division', orgBranch: 'Fictional Harbour Branch', orgRegion: 'Fictional Coastal Region',
  orgLine: 'Fictional Line Two', orgSection: 'Fictional Section Alpha', orgTeam: 'Fictional Team Kestrel',
  orgBase: 'Fictional Base Penang', employmentCategory: 'Fictional Category Permanent',
} as const;
const CATEGORY_OF: Record<keyof typeof LABELS, string> = {
  orgDivision: 'division', orgBranch: 'branch', orgRegion: 'region', orgLine: 'line', orgSection: 'section',
  orgTeam: 'team', orgBase: 'base', employmentCategory: 'category',
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(96, 5)]);

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
  // Payroll switched on (pay items are offered and written only where it is), BEFORE the context is built.
  await setModule(b.tenantId, 'payroll', 'active');
  a = adminCtx(b);
  await createConfig(a, { companyId: b.companyId, prefix: 'BRD', startNumber: 1, numberLength: 5, increment: 1, allowManualOverride: true });
  const [other] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Fictional Other Sdn Bhd' }).returning({ id: schema.company.id });
  otherCompanyId = other.id;
  cc1 = b.costCenterId;
  // Inserted with their company, so the Criteria trigger (0550 seed_label_company_criteria) makes each usable by it.
  [{ id: cc2 }] = await owner.db.insert(schema.costCenter).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'CC2', name: 'Fictional Branch Office' }).returning({ id: schema.costCenter.id });
  [{ id: ccForeign }] = await owner.db.insert(schema.costCenter).values({ tenantId: b.tenantId, companyId: otherCompanyId, code: 'CCX', name: 'Fictional Other Office' }).returning({ id: schema.costCenter.id });
  // The eight organisation catalogs, one active value each (an empty catalog would impose no constraint).
  for (const [field, value] of Object.entries(LABELS)) await createProfileOption(a, { category: CATEGORY_OF[field as keyof typeof LABELS], value });
  await seedPayComponentCatalog(a);
  const components = await listPayComponents(a, { readyOnly: true });
  allowanceId = components.find((c) => c.code === 'ALLOWANCE')!.id;
  housingId = components.find((c) => c.code === 'HOUSING')!.id;
  colaId = components.find((c) => c.code === 'COLA')!.id;
  expect([allowanceId, housingId, colaId].every(Boolean)).toBe(true);
  await owner.db.update(schema.payComponent).set({ appliedCompanyIds: [otherCompanyId] }).where(eq(schema.payComponent.id, colaId));
}, 120_000);
afterAll(closeAll);

/** A Draft with a HELD Employee ID, as the Create screen makes one. */
async function held(name: string) {
  const email = `draft.${randomUUID().slice(0, 8)}@fixture.test`;
  const created = await createEmployeeDraftWithReservedCode(a, { companyId: b.companyId, fullName: name, primaryEmail: email });
  return { ...created, name, email };
}
/** Everything Activate needs and nothing else (Payment Method is required on a draft since 2c1b2fba). */
function base(d: { name: string; email: string }): EmployeeDraftData {
  return {
    profile: { fullName: d.name, primaryEmail: d.email },
    employment: { companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: HIRED_ON },
    statutory: {},
    payroll: { basicSalary: '3000', paymentMethod: 'cash' },
  };
}
/** The new sections, each set to a distinct, recognisable value. */
function rich(d: { name: string; email: string }): EmployeeDraftData {
  const data = base(d);
  return {
    ...data,
    employment: { ...data.employment, ...LABELS },
    statutory: { bankPayeeResidency: 'non_resident' },
    payroll: { basicSalary: '4200', paymentMethod: 'cash' },
    emergencyContacts: [
      { key: 'c1', fullName: 'Fictional Kin Primary', relationship: 'Spouse', mobilePhone: '+60120000001', homePhone: '+6030000001', address: '1 Fictional Lane', remarks: 'Call first', priority: 'primary' },
      { key: 'c2', fullName: 'Fictional Kin Second', relationship: 'Parent', mobilePhone: '+60120000002', priority: 'secondary' },
    ],
    qualifications: [
      { key: 'q1', qualification: 'Bachelor', description: 'Fictional honours', fromYm: '2015-09', toYm: '2019-06', institute: 'Fictional University', major: 'Accounting', graduationDate: '2019-07-15', result: 'First class', isHighest: true },
      { key: 'q2', qualification: 'Diploma', fromYm: '2012-07', toYm: '2015-05', institute: 'Fictional College', isHighest: false },
    ],
    payItems: [
      { key: 'p1', componentId: allowanceId, amount: '250', prorate: false, effectiveFrom: HIRED_ON, remarks: 'Fictional phone' },
      { key: 'p2', componentId: housingId, amount: '1,800.50', currency: 'MYR', effectiveFrom: HIRED_ON, effectiveTo: '2026-12-31' },
    ],
    costAllocations: [
      { key: 'a1', costCenterId: cc1, percentage: '60' },
      { key: 'a2', costCenterId: cc2, percentage: '40' },
    ],
  };
}
async function tenantCounts() {
  const tables = ['person', 'employment', 'person_emergency_contact', 'employee_qualification', 'employment_pay_component',
    'employment_cost_allocation_set', 'person_photo', 'employee_statutory_my', 'compensation'] as const;
  const out: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await owner.client.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table} where tenant_id=$1`, [b.tenantId]);
    out[table] = row.n;
  }
  return out;
}
const draftRow = async (id: string) => (await owner.db.select({ id: schema.employeeDraft.id, reservedEmployeeCode: schema.employeeDraft.reservedEmployeeCode, data: schema.employeeDraft.data })
  .from(schema.employeeDraft).where(eq(schema.employeeDraft.id, id)))[0] ?? null;
const allocationOf = async (employmentId: string) => {
  const sets = await owner.db.select().from(schema.employmentCostAllocationSet)
    .where(and(eq(schema.employmentCostAllocationSet.employmentId, employmentId), isNull(schema.employmentCostAllocationSet.supersededAt)));
  const rows = sets.length ? await owner.db.select({ costCenterId: schema.employmentCostAllocationRow.costCenterId, hundredths: schema.employmentCostAllocationRow.hundredths })
    .from(schema.employmentCostAllocationRow).where(inArray(schema.employmentCostAllocationRow.setId, sets.map((s) => s.id))) : [];
  return { sets, rows: rows.sort((x, y) => y.hundredths - x.hundredths || x.costCenterId.localeCompare(y.costCenterId)) };
};
const assignmentCostCenter = async (employmentId: string) =>
  (await owner.db.select({ costCenterId: schema.assignment.costCenterId }).from(schema.assignment).where(eq(schema.assignment.employmentId, employmentId))).map((r) => r.costCenterId);

// ── (a) save and reopen ───────────────────────────────────────────────────────────────────────────────────────
describe('(a) every new list and field survives Save and reopen', () => {
  it('round-trips the four registers, the organisation labels, payee residency, the child-relief grid and Payment Method', async () => {
    const d = await held('Fictional Round Trip');
    const data: EmployeeDraftData = {
      ...rich(d),
      statutory: { bankPayeeResidency: 'resident', childReliefMode: 'auto_table', childReliefTable_under_18_full: '2', childReliefTable_study_tertiary_half: '1' },
      payroll: { basicSalary: '4200', paymentMethod: 'cheque' },
    };
    // The fixture is complete: nothing is outstanding on any tab.
    expect(missingForCreation(data)).toEqual([]);
    await saveEmployeeDraft(a, { id: d.id, data, currentStep: 7 });
    const reopened = await getEmployeeDraft(a, d.id);
    expect(reopened).not.toBeNull();
    expect(reopened!.currentStep).toBe(7);
    expect(stepKey(reopened!.currentStep)).toBe('qualification');
    expect(openingTab(null, reopened!.currentStep)).toBe('qualification');
    expect(reopened!.reservedEmployeeCode).toBe(d.employeeCode);
    const got = reopened!.data;
    expect(got.emergencyContacts).toEqual(data.emergencyContacts);
    expect(got.qualifications).toEqual(data.qualifications);
    expect(got.payItems).toEqual(data.payItems);
    expect(got.costAllocations).toEqual(data.costAllocations);
    expect(got.employment).toMatchObject({ ...LABELS, companyId: b.companyId, departmentId: b.deptA, hiredOn: HIRED_ON });
    expect(got.statutory).toMatchObject({ bankPayeeResidency: 'resident', childReliefMode: 'auto_table', childReliefTable_under_18_full: '2', childReliefTable_study_tertiary_half: '1' });
    expect(got.payroll).toMatchObject({ basicSalary: '4200', paymentMethod: 'cheque' });
    // The held Employee ID mirror stays pinned.
    expect(got.profile?.employeeCode).toBe(d.employeeCode);
    // The photo is NOT in the draft JSON: it waits in its own table and is reported separately.
    expect(JSON.stringify(got)).not.toMatch(/photo/i);
    expect(await hasEmployeeDraftPhoto(a, d.id)).toBe(false);
    await setEmployeeDraftPhoto(a, { draftId: d.id, content: PNG, fileName: 'round.png', mimeType: 'image/png', sizeBytes: PNG.byteLength });
    expect(await hasEmployeeDraftPhoto(a, d.id)).toBe(true);
    expect(Buffer.from((await getEmployeeDraftPhoto(a, d.id))!.content).equals(PNG)).toBe(true);
    // A second Save of the reopened data changes nothing in the lists (the screen saves what it was given).
    await saveEmployeeDraft(a, { id: d.id, data: got, currentStep: 7 });
    expect((await getEmployeeDraft(a, d.id))!.data).toEqual(got);
  });
});

// ── (b) activation ────────────────────────────────────────────────────────────────────────────────────────────
describe('(b) one activation lands every section through its owner, in one transaction', () => {
  it('creates contacts, photo, starting organisation labels, the allocation set, pay items, qualifications and payee residency', async () => {
    const d = await held('Fictional Rich Hire');
    await setEmployeeDraftPhoto(a, { draftId: d.id, content: PNG, fileName: 'rich.png', mimeType: 'image/png', sizeBytes: PNG.byteLength });
    const data = rich(d);
    // As createEmployeeAction calls it: Save what is on screen, then activate.
    const { employmentId } = await saveAndCompleteEmployeeDraft(a, { id: d.id, data, currentStep: 4 });
    const [emp] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId));
    expect(emp.employeeCode).toBe(d.employeeCode);
    expect(emp.paymentMethod).toBe('cash');
    // The eight organisation labels on the employment row …
    expect({ orgDivision: emp.orgDivision, orgBranch: emp.orgBranch, orgRegion: emp.orgRegion, orgLine: emp.orgLine, orgSection: emp.orgSection,
      orgTeam: emp.orgTeam, orgBase: emp.orgBase, employmentCategory: emp.employmentCategory }).toEqual(LABELS);
    // … as STARTING values in the hire event, never a later information-change event.
    const hired = await owner.db.select({ payload: schema.domainEvent.payload }).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, employmentId), eq(schema.domainEvent.eventType, 'employment.hired')));
    expect(hired).toHaveLength(1);
    expect((hired[0].payload as { employmentInformation: Record<string, unknown> }).employmentInformation).toMatchObject(LABELS);
    const infoUpdates = await owner.db.select({ payload: schema.domainEvent.payload }).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.subjectEmploymentId, employmentId), eq(schema.domainEvent.eventType, 'employment.info.updated')));
    for (const u of infoUpdates) expect((u.payload as { fields: string[] }).fields.filter((f) => f in LABELS)).toEqual([]);
    expect(JSON.stringify(infoUpdates)).not.toContain('Fictional North Division');

    // Emergency contacts on the person, the chosen Primary still Primary.
    const contacts = await owner.db.select().from(schema.personEmergencyContact)
      .where(and(eq(schema.personEmergencyContact.personId, emp.personId), isNull(schema.personEmergencyContact.archivedAt))).orderBy(asc(schema.personEmergencyContact.fullName));
    expect(contacts.map((c) => ({ fullName: c.fullName, relationship: c.relationship, mobilePhone: c.mobilePhone, homePhone: c.homePhone, address: c.address, remarks: c.remarks, priority: c.priority }))).toEqual([
      { fullName: 'Fictional Kin Primary', relationship: 'Spouse', mobilePhone: '+60120000001', homePhone: '+6030000001', address: '1 Fictional Lane', remarks: 'Call first', priority: 'primary' },
      { fullName: 'Fictional Kin Second', relationship: 'Parent', mobilePhone: '+60120000002', homePhone: null, address: null, remarks: null, priority: 'secondary' },
    ]);
    // The photo, moved onto the person; the draft's photo row gone with the draft.
    const [photo] = await owner.db.select().from(schema.personPhoto).where(eq(schema.personPhoto.personId, emp.personId));
    expect(photo).toMatchObject({ mimeType: 'image/png', sizeBytes: PNG.byteLength, fileName: 'rich.png' });
    expect(Buffer.from(photo.content as Uint8Array).equals(PNG)).toBe(true);
    expect(await owner.db.select().from(schema.employeeDraftPhoto).where(eq(schema.employeeDraftPhoto.draftId, d.id))).toEqual([]);
    expect(await draftRow(d.id)).toBeNull();
    // Cost Center Allocation: one set from the Group Join Date, HR's own source, 60/40 in hundredths; the
    // assignment carries no single cost centre because the split is two rows.
    const allocation = await allocationOf(employmentId);
    expect(allocation.sets.map((s) => ({ companyId: s.companyId, validFrom: s.validFrom, validTo: s.validTo, operation: s.operation, source: s.source })))
      .toEqual([{ companyId: b.companyId, validFrom: HIRED_ON, validTo: null, operation: 'replace', source: 'manual' }]);
    expect(allocation.rows).toEqual([{ costCenterId: cc1, hundredths: 6000 }, { costCenterId: cc2, hundredths: 4000 }]);
    expect(await assignmentCostCenter(employmentId)).toEqual([null]);
    // Pay items, as the writer stores them (typed ringgit, parsed once; a blank currency is MYR).
    const items = await owner.db.select().from(schema.employmentPayComponent)
      .where(and(eq(schema.employmentPayComponent.employmentId, employmentId), inArray(schema.employmentPayComponent.componentId, [allowanceId, housingId]), isNull(schema.employmentPayComponent.supersededAt)));
    expect(items.map((i) => ({ componentId: i.componentId, amount: i.amount, validFrom: i.validFrom, validTo: i.validTo, currency: i.currency, prorateOverride: i.prorateOverride, remarks: i.remarks }))
      .sort((x, y) => x.amount.localeCompare(y.amount))).toEqual([
      { componentId: housingId, amount: '1800.50', validFrom: HIRED_ON, validTo: '2026-12-31', currency: 'MYR', prorateOverride: null, remarks: null },
      { componentId: allowanceId, amount: '250.00', validFrom: HIRED_ON, validTo: null, currency: 'MYR', prorateOverride: false, remarks: 'Fictional phone' },
    ]);
    // Qualifications on the employment, one Highest.
    const quals = await owner.db.select().from(schema.employeeQualification)
      .where(and(eq(schema.employeeQualification.employmentId, employmentId), isNull(schema.employeeQualification.archivedAt))).orderBy(asc(schema.employeeQualification.qualification));
    expect(quals.map((q) => ({ qualification: q.qualification, description: q.description, fromYm: q.fromYm, toYm: q.toYm, institute: q.institute, major: q.major, graduationDate: q.graduationDate, result: q.result, isHighest: q.isHighest }))).toEqual([
      { qualification: 'Bachelor', description: 'Fictional honours', fromYm: '2015-09', toYm: '2019-06', institute: 'Fictional University', major: 'Accounting', graduationDate: '2019-07-15', result: 'First class', isHighest: true },
      { qualification: 'Diploma', description: null, fromYm: '2012-07', toYm: '2015-05', institute: 'Fictional College', major: null, graduationDate: null, result: null, isHighest: false },
    ]);
    // Bank payee residency, through the bank setter.
    const [statutory] = await owner.db.select({ bankPayeeResidency: schema.employeeStatutoryMy.bankPayeeResidency }).from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, emp.personId));
    expect(statutory.bankPayeeResidency).toBe('non_resident');
    // The salary, unchanged by any of it.
    const [comp] = await owner.db.select({ basicSalary: schema.compensation.basicSalary }).from(schema.compensation).where(eq(schema.compensation.employmentId, employmentId));
    expect(comp.basicSalary).toBe('4200.00');
  }, MULTI_ACTIVATION_TIMEOUT);

  it('a single cost centre at 100% is also the assignment cost centre, with a one-row allocation set', async () => {
    const d = await held('Fictional One Centre');
    const data: EmployeeDraftData = { ...base(d), costAllocations: [{ key: 'a1', costCenterId: cc2, percentage: '100' }] };
    expect(draftAssignmentCostCenter(data)).toBe(cc2);
    const { employmentId } = await saveAndCompleteEmployeeDraft(a, { id: d.id, data, currentStep: 2 });
    expect(await assignmentCostCenter(employmentId)).toEqual([cc2]);
    const allocation = await allocationOf(employmentId);
    expect(allocation.sets).toHaveLength(1);
    expect(allocation.sets[0]).toMatchObject({ validFrom: HIRED_ON, source: 'manual', operation: 'replace' });
    expect(allocation.rows).toEqual([{ costCenterId: cc2, hundredths: 10000 }]);
  }, MULTI_ACTIVATION_TIMEOUT);
});

// ── (c) failure atomicity ─────────────────────────────────────────────────────────────────────────────────────
describe('(c) an invalid item in any section refuses activation with nothing created and the held Employee ID kept', () => {
  const cases: { label: string; change: (data: EmployeeDraftData) => EmployeeDraftData; code: string; tab: string; field: string }[] = [
    { label: 'a nameless emergency contact (written past the screen)', code: 'required_fields', tab: 'profile', field: 'emergencyContacts',
      change: (data) => ({ ...data, emergencyContacts: [{ key: 'c1', fullName: '   ', relationship: 'Spouse', priority: 'primary' }] }) },
    { label: 'a qualification whose From is after its To', code: 'required_fields', tab: 'qualification', field: 'qualifications',
      change: (data) => ({ ...data, qualifications: [{ key: 'q1', qualification: 'Diploma', fromYm: '2020-09', toYm: '2019-06' }] }) },
    { label: 'a pay item for a component of another company', code: 'payroll_invalid', tab: 'payroll', field: 'payItems',
      change: (data) => ({ ...data, payItems: [{ key: 'p1', componentId: colaId, amount: '100', effectiveFrom: HIRED_ON }] }) },
    { label: 'a cost centre the company may not use', code: 'reference_invalid', tab: 'job', field: 'costAllocation',
      change: (data) => ({ ...data, costAllocations: [{ key: 'a1', costCenterId: cc1, percentage: '60' }, { key: 'a2', costCenterId: ccForeign, percentage: '40' }] }) },
    { label: 'an organisation label not in its active catalog', code: 'invalid_data', tab: 'job', field: 'orgBranch',
      change: (data) => ({ ...data, employment: { ...data.employment, orgBranch: 'Fictional Unknown Branch' } }) },
    { label: 'a blank Payment Method', code: 'required_fields', tab: 'payroll', field: 'paymentMethod',
      change: (data) => ({ ...data, payroll: { ...data.payroll, paymentMethod: '' } }) },
  ];

  it.each(cases)('$label → $code {$tab, $field}', async ({ change, code, tab, field }) => {
    const d = await held(`Fictional Refused ${randomUUID().slice(0, 4)}`);
    // A valid draft with a valid photo and a valid contact, so a refusal cannot be blamed on anything else …
    await saveEmployeeDraft(a, { id: d.id, data: base(d), currentStep: 1 });
    await setEmployeeDraftPhoto(a, { draftId: d.id, content: PNG, fileName: 'kept.png', mimeType: 'image/png', sizeBytes: PNG.byteLength });
    // … then the one bad section, written straight into the stored JSON as the storage owner (past the screen).
    const [stored] = await owner.db.select({ data: schema.employeeDraft.data }).from(schema.employeeDraft).where(eq(schema.employeeDraft.id, d.id));
    const bad = change(stored.data as EmployeeDraftData);
    await owner.db.update(schema.employeeDraft).set({ data: bad }).where(eq(schema.employeeDraft.id, d.id));
    const before = await tenantCounts();
    let failure: unknown;
    try { await completeEmployeeDraft(a, d.id); } catch (error) { failure = error; }
    expect(failure, 'activation refused').toBeDefined();
    const problem = draftActivationValidation(failure);
    expect(problem?.code).toBe(code);
    expect(problem?.fields).toContainEqual({ tab, field });
    // Nothing was created anywhere, and the draft, its data, its held ID and its photo are all still there.
    expect(await tenantCounts()).toEqual(before);
    const after = await draftRow(d.id);
    expect(after?.reservedEmployeeCode).toBe(d.employeeCode);
    expect(after?.data).toEqual(bad);
    expect(await hasEmployeeDraftPhoto(a, d.id)).toBe(true);
    expect(await owner.db.select({ id: schema.employment.id }).from(schema.employment).where(eq(schema.employment.employeeCode, d.employeeCode))).toEqual([]);
  }, MULTI_ACTIVATION_TIMEOUT);

  it('the same refusal through Save-and-Activate keeps the attempted draft saved, not activated', async () => {
    const d = await held('Fictional Saved Refusal');
    const before = await tenantCounts();
    const data: EmployeeDraftData = { ...base(d), payroll: { basicSalary: '3000' } };
    let failure: unknown;
    try { await saveAndCompleteEmployeeDraft(a, { id: d.id, data, currentStep: 4 }); } catch (error) { failure = error; }
    expect(draftActivationValidation(failure)).toEqual({ code: 'required_fields', fields: [{ tab: 'payroll', field: 'paymentMethod' }] });
    expect(await tenantCounts()).toEqual(before);
    const after = await draftRow(d.id);
    expect(after?.reservedEmployeeCode).toBe(d.employeeCode);
    expect((after?.data as EmployeeDraftData).payroll).toEqual({ basicSalary: '3000' });
  }, MULTI_ACTIVATION_TIMEOUT);
});

// ── (d) legacy drafts ─────────────────────────────────────────────────────────────────────────────────────────
describe('(d) drafts written before 2c1b2fba open and activate', () => {
  it('no new keys, a single employment.costCenterId and step 5: opens on Payroll, activates with the one centre at 100%', async () => {
    const d = await held('Fictional Legacy Centre');
    // Written as an older build wrote it: no lists, no cohort marker, a single cost centre, parked on retired step 5.
    const legacy: EmployeeDraftData = {
      profile: { fullName: d.name, primaryEmail: d.email, employeeCode: d.employeeCode },
      employment: { companyId: b.companyId, departmentId: b.deptA, costCenterId: cc1, employmentType: 'full_time', hiredOn: HIRED_ON },
      statutory: {},
      payroll: { basicSalary: '2800' },
    };
    await owner.db.update(schema.employeeDraft).set({ data: legacy, currentStep: 5 }).where(eq(schema.employeeDraft.id, d.id));
    const opened = await getEmployeeDraft(a, d.id);
    expect(opened!.currentStep).toBe(5);
    expect(stepKey(5)).toBe('payroll');
    expect(openingTab(undefined, opened!.currentStep)).toBe('payroll');
    for (const key of ['emergencyContacts', 'qualifications', 'payItems', 'costAllocations'] as const) expect(opened!.data[key]).toBeUndefined();
    // The legacy single cost centre reads as one row at 100% (not persisted until Save) and is the assignment's.
    expect(draftCostAllocations(opened!.data)).toEqual([{ key: 'legacy', costCenterId: cc1, percentage: '100' }]);
    expect(draftAssignmentCostCenter(opened!.data)).toBe(cc1);
    // Payment Method is now required: the legacy draft names it on Payroll, and only it.
    const missing = missingByTab(opened!.data);
    expect(missing.payroll).toEqual(['paymentMethod']);
    expect(missing.qualification).toEqual([]);
    expect(missingForCreation(opened!.data)).toEqual(['paymentMethod']);
    // HR picks one and activates.
    const data: EmployeeDraftData = { ...opened!.data, payroll: { ...opened!.data.payroll, paymentMethod: 'cheque' } };
    const { employmentId } = await saveAndCompleteEmployeeDraft(a, { id: d.id, data, currentStep: 5 });
    expect(await assignmentCostCenter(employmentId)).toEqual([cc1]);
    const allocation = await allocationOf(employmentId);
    expect(allocation.sets.map((s) => ({ validFrom: s.validFrom, source: s.source, operation: s.operation }))).toEqual([{ validFrom: HIRED_ON, source: 'manual', operation: 'replace' }]);
    expect(allocation.rows).toEqual([{ costCenterId: cc1, hundredths: 10000 }]);
    const [emp] = await owner.db.select({ paymentMethod: schema.employment.paymentMethod }).from(schema.employment).where(eq(schema.employment.id, employmentId));
    expect(emp.paymentMethod).toBe('cheque');
  }, MULTI_ACTIVATION_TIMEOUT);

  it('a stored legacy monthly allowance is still carried to compensation (the input is gone, the value is not)', async () => {
    const d = await held('Fictional Legacy Allowance');
    const data: EmployeeDraftData = { ...base(d), payroll: { basicSalary: '3100', monthlyAllowance: '150', paymentMethod: 'cash' } };
    const { employmentId } = await saveAndCompleteEmployeeDraft(a, { id: d.id, data, currentStep: 4 });
    const comps = await owner.db.select({ basicSalary: schema.compensation.basicSalary, monthlyAllowance: schema.compensation.monthlyAllowance })
      .from(schema.compensation).where(eq(schema.compensation.employmentId, employmentId));
    expect(comps).toEqual([{ basicSalary: '3100.00', monthlyAllowance: '150.00' }]);
    // A legacy draft with no allocation at all writes no allocation set and no assignment cost centre.
    expect((await allocationOf(employmentId)).sets).toEqual([]);
    expect(await assignmentCostCenter(employmentId)).toEqual([null]);
  }, MULTI_ACTIVATION_TIMEOUT);
});

// ── (e) cross-tenant ──────────────────────────────────────────────────────────────────────────────────────────
describe('(e) another tenant\'s draft is invisible and unwritable', () => {
  it('tenant A cannot read, save, activate or put a photo on tenant B\'s draft', async () => {
    const other = await seedBase();
    const ctxB = adminCtx(other);
    const { id: draftB } = await saveEmployeeDraft(ctxB, { data: { profile: { fullName: 'Fictional Tenant B' }, employment: { companyId: other.companyId } }, currentStep: 1 });
    // A positive control: tenant B's own administrator can give it a photo.
    await setEmployeeDraftPhoto(ctxB, { draftId: draftB, content: PNG, fileName: 'b.png', mimeType: 'image/png', sizeBytes: PNG.byteLength });
    expect(await hasEmployeeDraftPhoto(ctxB, draftB)).toBe(true);
    const [beforeB] = await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id, draftB));

    expect(await getEmployeeDraft(a, draftB)).toBeNull();
    expect(await getEmployeeDraftPhoto(a, draftB)).toBeNull();
    expect(await hasEmployeeDraftPhoto(a, draftB)).toBe(false);
    const other2 = Buffer.concat([PNG, Buffer.alloc(4, 9)]);
    await expect(setEmployeeDraftPhoto(a, { draftId: draftB, content: other2, fileName: 'a.png', mimeType: 'image/png', sizeBytes: other2.byteLength }))
      .rejects.toSatisfy((e: unknown) => e instanceof DraftPhotoError && e.reason === 'unavailable');
    let saveFailure: unknown;
    try { await saveEmployeeDraft(a, { id: draftB, data: { profile: { fullName: 'Hijacked' } }, currentStep: 1 }); } catch (error) { saveFailure = error; }
    expect(draftActivationValidation(saveFailure)?.code).toBe('draft_unavailable');
    let activateFailure: unknown;
    try { await completeEmployeeDraft(a, draftB); } catch (error) { activateFailure = error; }
    expect(draftActivationValidation(activateFailure)?.code).toBe('draft_unavailable');

    const [afterB] = await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id, draftB));
    expect(afterB).toEqual(beforeB);
    const photos = await owner.db.select().from(schema.employeeDraftPhoto).where(eq(schema.employeeDraftPhoto.draftId, draftB));
    expect(photos).toHaveLength(1);
    expect(photos[0].tenantId).toBe(other.tenantId);
    expect(Buffer.from(photos[0].content as Uint8Array).equals(PNG)).toBe(true);
    expect(await owner.db.select({ id: schema.employeeDraftPhoto.id }).from(schema.employeeDraftPhoto)
      .where(and(eq(schema.employeeDraftPhoto.tenantId, b.tenantId), eq(schema.employeeDraftPhoto.draftId, draftB)))).toEqual([]);
  });
});

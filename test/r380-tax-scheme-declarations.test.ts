/** Employer-period declarations: real app-role permissions and synthetic fixtures only. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { listTaxSchemeDeclarationsMY, saveTaxSchemeDeclarationMY, revokeTaxSchemeDeclarationMY,
  resolveTaxSchemeMY } from '../localization/my/tax-scheme-declarations';
import { adminCtx, closeAll, createAppUser, eventTypesFor, migrateTestDb, owner, resetDb,
  seedBase, type Base } from './harness';

let b: Base;
type Subject = Awaited<ReturnType<typeof hireEmployee>>;
let subject: Subject;
beforeAll(async () => { await migrateTestDb(); });
afterAll(async () => { await closeAll(); });
beforeEach(async () => {
  await resetDb(); b = await seedBase(); subject = await hire(b);
});
async function hire(base: Base) {
  const e = await hireEmployee(adminCtx(base), { person: {fullName: 'Synthetic tax subject',
    primaryEmail: `declaration_${randomUUID()}@example.test`}, companyId: base.companyId,
    departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
  await setStatutoryProfileMY(adminCtx(base), {personId: e.personId, icNumber: '900101015555'});
  return e;
}
const input = () => ({employmentId: subject.employmentId, expectedCompanyId: b.companyId,
  scheme: 'rep', validFrom: '2026-09', validTo: '2027-08', approvalReference: 'SYNTHETIC-APPROVAL',
  eligibilityConfirmed: true});
const resolve = (period: string, overrides: Partial<Parameters<typeof resolveTaxSchemeMY>[1]> = {}, ctx = adminCtx(b)) =>
  withTenant(ctx, tx => resolveTaxSchemeMY(tx, {tenantId: b.tenantId, employmentId: subject.employmentId,
    companyId: b.companyId, payPeriod: period, legacyScheme: 'rep', resident: false,
    epfCitizenship: 'non_citizen', ...overrides}));
async function profile(values: Partial<typeof schema.employeeStatutoryMy.$inferInsert>) {
  await owner.db.update(schema.employeeStatutoryMy).set(values)
    .where(and(eq(schema.employeeStatutoryMy.tenantId,b.tenantId),eq(schema.employeeStatutoryMy.personId,subject.personId)));
}

describe('r380 employer-period declaration lifecycle', () => {
  it('saves and lists an auditable declaration, revokes once, retains its immutable facts', async () => {
    const id = await saveTaxSchemeDeclarationMY(adminCtx(b), {...input(), approvalReference: '  SYNTHETIC-APPROVAL  '});
    const listed = await listTaxSchemeDeclarationsMY(adminCtx(b), subject.employmentId);
    expect(listed?.companyId).toBe(b.companyId);
    expect(listed?.rows).toHaveLength(1);
    expect(listed!.rows[0]).toMatchObject({id, scheme:'rep', validFrom:'2026-09', validTo:'2027-08',
      approvalReference:'SYNTHETIC-APPROVAL', archivedAt:null});
    const [stored] = await owner.db.select().from(schema.employmentTaxSchemeMy).where(eq(schema.employmentTaxSchemeMy.id,id));
    expect(stored.declaredByUserId).toBe(b.adminUserId);
    expect(stored.declaredAt).toBeInstanceOf(Date);
    expect(await eventTypesFor(b.tenantId,id)).toEqual(['employment.tax.scheme.declared']);
    await revokeTaxSchemeDeclarationMY(adminCtx(b), {employmentId:subject.employmentId,id});
    await revokeTaxSchemeDeclarationMY(adminCtx(b), {employmentId:subject.employmentId,id});
    const archived = (await listTaxSchemeDeclarationsMY(adminCtx(b),subject.employmentId))!.rows[0];
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(archived.approvalReference).toBe(stored.approvalReference);
    expect(await eventTypesFor(b.tenantId,id)).toEqual(['employment.tax.scheme.declared','employment.tax.scheme.revoked']);
    await expect(resolve('2026-10')).rejects.toMatchObject({code:'missing_declaration'});
    const replacement = await saveTaxSchemeDeclarationMY(adminCtx(b), input());
    expect(replacement).not.toBe(id);
    expect((await listTaxSchemeDeclarationsMY(adminCtx(b),subject.employmentId))!.rows).toHaveLength(2);
  });
  it('includes both boundary months, excludes adjacent months and accepts adjacent nonoverlapping approval', async () => {
    const id = await saveTaxSchemeDeclarationMY(adminCtx(b), input());
    for (const period of ['2026-09','2027-08']) expect(await resolve(period)).toEqual({scheme:'rep',declarationId:id});
    for (const period of ['2026-08','2027-09']) await expect(resolve(period)).rejects.toMatchObject({code:'missing_declaration'});
    await expect(saveTaxSchemeDeclarationMY(adminCtx(b), {...input(),scheme:'knowledge_worker',validFrom:'2027-08',validTo:'2027-09'}))
      .rejects.toMatchObject({code:'overlap'});
    const adjacent = await saveTaxSchemeDeclarationMY(adminCtx(b), {...input(),scheme:'knowledge_worker',validFrom:'2027-09',validTo:'2027-09'});
    expect(await resolve('2027-09')).toEqual({scheme:'knowledge_worker',declarationId:adjacent});
  });
  it.each(['0000-01','2026-00','2026-13','2026-9','2026-09-01','2026-09x'])('rejects malformed effective period %s', async period => {
    await expect(saveTaxSchemeDeclarationMY(adminCtx(b), {...input(),validFrom:period})).rejects.toMatchObject({code:'invalid_period'});
    await expect(resolve(period)).rejects.toMatchObject({code:'invalid_period'});
  });
  it('rejects reversed ranges, unsupported scheme, missing reference and stale company context', async () => {
    await expect(saveTaxSchemeDeclarationMY(adminCtx(b), {...input(),validTo:'2026-08'})).rejects.toMatchObject({code:'invalid_period'});
    await expect(saveTaxSchemeDeclarationMY(adminCtx(b), {...input(),scheme:'resident'})).rejects.toMatchObject({code:'invalid_scheme'});
    for (const reference of ['  ','x'.repeat(301)]) await expect(saveTaxSchemeDeclarationMY(adminCtx(b), {...input(),approvalReference:reference})).rejects.toMatchObject({code:'missing_reference'});
    await expect(saveTaxSchemeDeclarationMY(adminCtx(b), {...input(),expectedCompanyId:randomUUID()})).rejects.toMatchObject({code:'stale_context'});
    expect((await listTaxSchemeDeclarationsMY(adminCtx(b),subject.employmentId))!.rows).toHaveLength(0);
  });
  it('requires exact confirmation and a real actor', async () => {
    for (const value of [false, 'true', 1, undefined]) await expect(saveTaxSchemeDeclarationMY(adminCtx(b),
      {...input(), eligibilityConfirmed:value as boolean})).rejects.toMatchObject({code:'approval_required'});
    await expect(saveTaxSchemeDeclarationMY({...adminCtx(b),userId:undefined},input())).rejects.toMatchObject({code:'approval_required'});
    await expect(saveTaxSchemeDeclarationMY({...adminCtx(b),userId:randomUUID()},input())).rejects.toBeDefined();
    expect((await listTaxSchemeDeclarationsMY(adminCtx(b),subject.employmentId))!.rows).toHaveLength(0);
    expect(await saveTaxSchemeDeclarationMY(adminCtx(b),input())).toBeTruthy();
  });
  it.each(['rep','knowledge_worker'])('refuses missing and expired approval for legacy %s, retains ordinary paths', async scheme => {
    await expect(resolve('2026-10',{legacyScheme:scheme})).rejects.toMatchObject({code:'missing_declaration'});
    await saveTaxSchemeDeclarationMY(adminCtx(b), {...input(),scheme,validTo:'2026-09'});
    await expect(resolve('2026-10',{legacyScheme:scheme})).rejects.toMatchObject({code:'missing_declaration'});
    expect(await resolve('2026-10',{legacyScheme:'resident',resident:true})).toEqual({scheme:'resident'});
    expect(await resolve('2026-10',{legacyScheme:'non_resident',resident:false})).toEqual({scheme:'non_resident'});
    expect(await resolve('2026-10',{legacyScheme:'resident',resident:false})).toEqual({scheme:'non_resident'});
    expect(await resolve('2026-10',{legacyScheme:null,resident:false})).toEqual({scheme:'non_resident'});
  });
  it('requires resident foreign/PR classification for C-suite at entry and consumption', async () => {
    await expect(saveTaxSchemeDeclarationMY(adminCtx(b),{...input(),scheme:'c_suite'})).rejects.toMatchObject({code:'citizenship_unknown'});
    await profile({taxResidency:'resident',isResident:false,epfCitizenship:'non_citizen'});
    await expect(saveTaxSchemeDeclarationMY(adminCtx(b),{...input(),scheme:'c_suite'})).rejects.toMatchObject({code:'not_resident'});
    await profile({taxResidency:'non_resident',isResident:false,epfCitizenship:'non_citizen'});
    await expect(saveTaxSchemeDeclarationMY(adminCtx(b),{...input(),scheme:'c_suite'})).rejects.toMatchObject({code:'not_resident'});
    await profile({taxResidency:'resident',isResident:true,epfCitizenship:'pr'});
    const id = await saveTaxSchemeDeclarationMY(adminCtx(b),{...input(),scheme:'c_suite'});
    for (const citizenship of ['pr','non_citizen']) expect(await resolve('2026-10',{legacyScheme:'resident',resident:true,epfCitizenship:citizenship})).toEqual({scheme:'c_suite',declarationId:id});
    for (const citizenship of ['citizen',null,undefined]) await expect(resolve('2026-10',{legacyScheme:'resident',resident:true,epfCitizenship:citizenship})).rejects.toMatchObject({code:'citizenship_unknown'});
    await expect(resolve('2026-10',{legacyScheme:'non_resident'})).rejects.toMatchObject({code:'not_resident'});
  });
});

describe('r380 declaration scope and app-role immutability', () => {
  it('refuses ordinary employee read/write/revoke while the authorized control succeeds', async () => {
    const id = await saveTaxSchemeDeclarationMY(adminCtx(b),input());
    const userId = await createAppUser(b.tenantId,subject.personId,'employee');
    const employee: SessionContext = {tenantId:b.tenantId,userId,roles:['employee'],entitlements:adminCtx(b).entitlements};
    await expect(listTaxSchemeDeclarationsMY(employee,subject.employmentId)).rejects.toMatchObject({code:'not_found'});
    await expect(saveTaxSchemeDeclarationMY(employee,input())).rejects.toMatchObject({code:'not_found'});
    await expect(revokeTaxSchemeDeclarationMY(employee,{employmentId:subject.employmentId,id})).rejects.toMatchObject({code:'not_found'});
    const rows = await withTenant(employee,tx=>tx.select().from(schema.employmentTaxSchemeMy));
    expect(rows).toHaveLength(0);
    expect((await listTaxSchemeDeclarationsMY(adminCtx(b),subject.employmentId))!.rows[0].id).toBe(id);
  });
  it('fences other companies and tenants with visible permitted rows as controls', async () => {
    const id = await saveTaxSchemeDeclarationMY(adminCtx(b),input());
    const [otherCompany] = await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Synthetic other employer',country:'MY'}).returning({id:schema.company.id});
    const [otherDepartment] = await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:otherCompany.id,name:'Synthetic department'}).returning({id:schema.department.id});
    const otherEmployment = await hire({...b,companyId:otherCompany.id,deptA:otherDepartment.id});
    const permittedId = await saveTaxSchemeDeclarationMY(adminCtx(b),{...input(),employmentId:otherEmployment.employmentId,expectedCompanyId:otherCompany.id});
    const [user] = await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`scoped_${randomUUID()}`}).returning({id:schema.appUser.id});
    await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,companyId:otherCompany.id,role:'hr_admin'});
    const foreignCompany: SessionContext = {tenantId:b.tenantId,userId:user.id,grants:[{role:'hr_admin',companyId:otherCompany.id}],entitlements:adminCtx(b).entitlements};
    expect((await listTaxSchemeDeclarationsMY(foreignCompany,otherEmployment.employmentId))!.rows[0].id).toBe(permittedId);
    await expect(listTaxSchemeDeclarationsMY(foreignCompany,subject.employmentId)).rejects.toMatchObject({code:'not_found'});
    await expect(saveTaxSchemeDeclarationMY(foreignCompany,input())).rejects.toMatchObject({code:'not_found'});
    const otherBase = await seedBase(); const otherSubject = await hire(otherBase);
    const otherId = await saveTaxSchemeDeclarationMY(adminCtx(otherBase),{...input(),employmentId:otherSubject.employmentId,expectedCompanyId:otherBase.companyId});
    expect((await listTaxSchemeDeclarationsMY(adminCtx(otherBase),otherSubject.employmentId))!.rows[0].id).toBe(otherId);
    await expect(listTaxSchemeDeclarationsMY(adminCtx(otherBase),subject.employmentId)).rejects.toMatchObject({code:'not_found'});
    await expect(saveTaxSchemeDeclarationMY(adminCtx(otherBase),input())).rejects.toMatchObject({code:'not_found'});
    await expect(revokeTaxSchemeDeclarationMY(adminCtx(otherBase),{employmentId:subject.employmentId,id})).rejects.toMatchObject({code:'not_found'});
    expect(await withTenant(adminCtx(otherBase),tx=>tx.select({id:schema.employmentTaxSchemeMy.id}).from(schema.employmentTaxSchemeMy)))
      .toEqual([{id:otherId}]);
    expect((await listTaxSchemeDeclarationsMY(adminCtx(b),subject.employmentId))!.rows[0].id).toBe(id);
  });
  it('permits archival only: app role cannot rewrite approval facts, unarchive or delete', async () => {
    const id = await saveTaxSchemeDeclarationMY(adminCtx(b),input());
    for (const [column,value] of [['scheme','knowledge_worker'],['approval_reference','CHANGED'],['valid_from','2026-08'],['valid_to','2027-09'],['employment_id',randomUUID()],['company_id',randomUUID()],['declared_by_user_id',randomUUID()]] as const) {
      await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`UPDATE employment_tax_scheme_my SET ${sql.raw(column)}=${value} WHERE id=${id}::uuid`))).rejects.toBeDefined();
    }
    await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`DELETE FROM employment_tax_scheme_my WHERE id=${id}::uuid`))).rejects.toBeDefined();
    await withTenant(adminCtx(b),tx=>tx.update(schema.employmentTaxSchemeMy).set({archivedAt:sql`now()`}).where(eq(schema.employmentTaxSchemeMy.id,id)));
    const [archived] = await owner.db.select().from(schema.employmentTaxSchemeMy).where(eq(schema.employmentTaxSchemeMy.id,id));
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(archived).toMatchObject({scheme:'rep',approvalReference:'SYNTHETIC-APPROVAL',validFrom:'2026-09',validTo:'2027-08',declaredByUserId:b.adminUserId});
    await expect(withTenant(adminCtx(b),tx=>tx.update(schema.employmentTaxSchemeMy).set({archivedAt:null}).where(eq(schema.employmentTaxSchemeMy.id,id)))).rejects.toBeDefined();
    expect((await listTaxSchemeDeclarationsMY(adminCtx(b),subject.employmentId))!.rows).toHaveLength(1);
  });
  it('enforces actor and nonoverlap in direct app-role inserts, with an adjacent permitted control', async () => {
    await saveTaxSchemeDeclarationMY(adminCtx(b),input());
    const raw = (validFrom:string,validTo:string,declaredByUserId=b.adminUserId) => withTenant(adminCtx(b),tx=>
      tx.insert(schema.employmentTaxSchemeMy).values({tenantId:b.tenantId,employmentId:subject.employmentId,
        companyId:b.companyId,scheme:'knowledge_worker',validFrom,validTo,approvalReference:'SYNTHETIC-DIRECT',declaredByUserId})
        .returning({id:schema.employmentTaxSchemeMy.id}));
    await expect(raw('2027-08','2027-09')).rejects.toBeDefined();
    const forgedActor = await createAppUser(b.tenantId,subject.personId,'employee');
    await expect(raw('2027-09','2027-10',forgedActor)).rejects.toBeDefined();
    const [permitted] = await raw('2027-09','2027-10');
    expect(permitted.id).toBeTruthy();
    expect(await resolve('2027-09')).toEqual({scheme:'knowledge_worker',declarationId:permitted.id});
    expect((await listTaxSchemeDeclarationsMY(adminCtx(b),subject.employmentId))!.rows).toHaveLength(2);
  });
});

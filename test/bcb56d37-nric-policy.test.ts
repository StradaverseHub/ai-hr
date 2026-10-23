import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { getPeopleGeneral, savePeopleGeneral, canConfigurePeopleGeneral } from '../core/people-general';
import { setStatutoryProfileMY, setIcProfileMY, getStatutoryProfileMY } from '../localization/my/statutory';
import { completeEmployeeDraft, saveEmployeeDraft } from '../core/employee-draft';
import { validateEmployeeImport, commitEmployeeImport } from '../core/import';
import { validateSectionImport, commitSectionImport } from '../core/import-sections';
import { decideProfileChange } from '../core/profile';
import { validateClockingImport } from '../core/attendance-clocking-import';
import { BUILTIN_MAPPING_ID } from '../lib/clocking-file';
import { validateLeaveImport, commitLeaveImport } from '../core/leave-import';
import { pgSqlState } from '../lib/db-error';
import { publicErrorMessage } from '../lib/public-error';
import { NRIC_DUPLICATE_MESSAGE, NRIC_FILE_DUPLICATE_MESSAGE, NRIC_AMBIGUOUS_MESSAGE } from '../lib/nric-policy-message';
import { seedStoredLegacyProfileRequest, requestCurrentProfileChange } from './helpers/profile-requests';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let ctx: SessionContext;
const identity='900101011234'; // Fictional fixture, never a runtime/UI example.
const changedIdentity='900101011235';
beforeAll(async () => {
  await migrateTestDb();
  const [installed]=await owner.db.execute<{installed:boolean}>(sql`select to_regprocedure('app.people_general_read()') is not null as installed`);
  expect(installed.installed,'The integration journal must install migration0594').toBe(true);
});
afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});

async function policy(allowDuplicatedNric:boolean) {
  return savePeopleGeneral(ctx,{...await getPeopleGeneral(ctx),allowDuplicatedNric});
}
async function hire(code:string,companyId=b.companyId) {
  const departmentId=companyId===b.companyId?b.deptA:(await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId,name:'Fixture department'}).returning())[0].id;
  return hireEmployee(ctx,{companyId,departmentId,employeeCode:code,
    person:{fullName:`Fixture ${code}`,primaryEmail:`${randomUUID()}@nric-policy.test`},employmentType:'full_time',hiredOn:'2020-01-01'});
}
async function ic(personId:string) { return (await getStatutoryProfileMY(ctx,personId))?.icNumber??null; }
const fullRow=(code:string,icNumber=identity)=>({full_name:`Import ${code}`,email:`${code.toLowerCase()}@nric-policy.test`,department:'Finance',hired_on:'2020-01-01',employment_type:'full_time',employee_code:code,ic_number:icNumber,basic_salary:'4200'});
async function counts() {
  const [row]=await owner.db.execute<{people:number;employees:number}>(sql`select (select count(*)::int from person where tenant_id=${b.tenantId}::uuid) as people,(select count(*)::int from employment where tenant_id=${b.tenantId}::uuid) as employees`);
  return row;
}
async function occupants(key=identity) {
  const [row]=await owner.db.execute<{occupants:string}>(sql`select occupants from public.people_nric_admission where tenant_id=${b.tenantId}::uuid and normalized_nric=${key}`);
  return Number(row?.occupants??0);
}
async function refusal(promise:Promise<unknown>,code='PN001') {
  try { await promise; throw new Error('Expected admission refusal'); }
  catch(error) { expect(pgSqlState(error)).toBe(code);return error; }
}

describe('bcb56d37 tenant NRIC policy: actual app role and atomic admission',()=>{
  it('defaults OFF, persists ON/OFF, audits, and gives the app no private-table or trigger access',async()=>{
    const roles=await withTenant(ctx,tx=>tx.execute<{role:string}>(sql`select current_user as role`));
    expect(roles[0].role).toBe('ai_hr_app');
    expect(await getPeopleGeneral(ctx)).toEqual({allowDuplicatedNric:false,revision:null});
    expect(await canConfigurePeopleGeneral(ctx)).toBe(true);
    await policy(true);expect((await getPeopleGeneral(ctx)).allowDuplicatedNric).toBe(true);
    await policy(false);expect((await getPeopleGeneral(ctx)).allowDuplicatedNric).toBe(false);
    const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'people-general.changed'))).orderBy(schema.domainEvent.sequence);
    expect(events).toHaveLength(2);expect(events[0].payload).toMatchObject({before:{allowDuplicatedNric:false},after:{allowDuplicatedNric:true}});
    for(const query of [sql`select * from public.people_general_policy`,sql`select * from public.people_nric_admission`,sql`select app.guard_people_nric_admission()`])await refusal(withTenant(ctx,tx=>tx.execute(query)),'42501');
  });

  it('refuses actual scoped admins and a foreign principal despite forged group-admin session claims',async()=>{
    const target=await hire('AUTH');
    const userId=await createAppUser(b.tenantId,target.personId,'hr_admin');
    await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,userId));
    const forged={...ctx,userId,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]};
    expect(await canConfigurePeopleGeneral(forged)).toBe(false);
    await expect(savePeopleGeneral(forged,{allowDuplicatedNric:true,revision:null})).rejects.toMatchObject({reason:'forbidden'});
    const foreign=await seedBase();
    await expect(savePeopleGeneral({...ctx,userId:foreign.adminUserId},{allowDuplicatedNric:true,revision:null})).rejects.toMatchObject({reason:'forbidden'});
    expect((await getPeopleGeneral(ctx)).allowDuplicatedNric).toBe(false);
  });

  it('OFF normalizes distinct-person duplicate keys; ON permits them and preserves person/account boundaries',async()=>{
    const a=await hire('A'),c=await hire('B');
    await setIcProfileMY(ctx,{personId:a.personId,icNumber:identity});
    const error=await refusal(setIcProfileMY(ctx,{personId:c.personId,icNumber:'900101-01-1234'}));
    const safe=publicErrorMessage(error);expect(safe).toContain(NRIC_DUPLICATE_MESSAGE);expect(safe).not.toContain(identity);expect(safe).not.toContain(a.personId);
    await policy(true);await setIcProfileMY(ctx,{personId:c.personId,icNumber:'900101 01 1234'});
    expect(a.personId).not.toBe(c.personId);expect(await ic(a.personId)).toBe(identity);expect(await ic(c.personId)).toBe(identity);expect(await occupants()).toBe(2);
    const users=await owner.db.select().from(schema.appUser).where(eq(schema.appUser.personId,c.personId));expect(users).toHaveLength(0);
    await refusal(withTenant(ctx,tx=>tx.insert(schema.employment).values({tenantId:b.tenantId,personId:c.personId,companyId:b.companyId,employeeCode:'A',hiredOn:'2020-01-01'})),'23505');
  });

  it('keeps tenant admission independent and previews hidden-company conflicts without holder details',async()=>{
    const [hiddenCompany]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Hidden configuration fixture'}).returning();
    const holder=await hire('HIDDEN',hiddenCompany.id);await setIcProfileMY(ctx,{personId:holder.personId,icNumber:identity});
    // A scoped principal may maintain only the visible company; conflict probing reveals no holders.
    const scopedEmployee=await hire('SCOPED-ADMIN');const scopedId=await createAppUser(b.tenantId,scopedEmployee.personId,'hr_admin');
    await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,scopedId));
    const scoped={...ctx,userId:scopedId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
    const preview=await validateEmployeeImport(scoped,{companyId:b.companyId,records:[fullRow('VISIBLE')]});
    expect(preview.rows[0].errors).toContain(NRIC_DUPLICATE_MESSAGE);expect(JSON.stringify(preview.rows[0].errors)).not.toContain('HIDDEN');expect(JSON.stringify(preview.rows[0].errors)).not.toContain(identity);
    await refusal(withTenant(scoped,tx=>tx.execute(sql`select app.people_nric_conflicts(${hiddenCompany.id}::uuid,NULL,ARRAY[${identity}])`)),'42501');
    const foreign=await seedBase(),foreignCtx=adminCtx(foreign);
    const other=await hireEmployee(foreignCtx,{companyId:foreign.companyId,departmentId:foreign.deptA,employeeCode:'FOREIGN',person:{fullName:'Foreign fixture',primaryEmail:'foreign@nric-policy.test'},employmentType:'full_time',hiredOn:'2020-01-01'});
    await setIcProfileMY(foreignCtx,{personId:other.personId,icNumber:identity});
    expect((await getPeopleGeneral(foreignCtx)).allowDuplicatedNric).toBe(false);
    await refusal(withTenant(foreignCtx,tx=>tx.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId:other.personId,icNumber:changedIdentity})),'42501');
  });

  it('ON does not relax blank/format rules; OFF preserves unchanged duplicates and unrelated statutory saves',async()=>{
    const a=await hire('A'),c=await hire('B'),d=await hire('C');await policy(true);
    for(const e of [a,c])await setStatutoryProfileMY(ctx,{personId:e.personId,icNumber:identity});
    await setStatutoryProfileMY(ctx,{personId:d.personId,icNumber:'  '});expect(await ic(d.personId)).toBeNull();
    await expect(setStatutoryProfileMY(ctx,{personId:d.personId,icNumber:'123'})).rejects.toMatchObject({name:'InvalidICError'});
    await policy(false);
    await setStatutoryProfileMY(ctx,{personId:c.personId,icNumber:'900101-01-1234',epfNumber:'UPDATED'});
    expect((await getStatutoryProfileMY(ctx,c.personId))?.epfNumber).toBe('UPDATED');expect(await occupants()).toBe(2);
    await refusal(setIcProfileMY(ctx,{personId:d.personId,icNumber:identity}));
    await setIcProfileMY(ctx,{personId:c.personId,icNumber:changedIdentity});expect(await occupants()).toBe(1);
    await refusal(setIcProfileMY(ctx,{personId:c.personId,icNumber:identity}));
    // Multiple employments of one Person remain legal: no second identity admission occurs.
    await withTenant(ctx,tx=>tx.insert(schema.employment).values({tenantId:b.tenantId,personId:a.personId,companyId:b.companyId,employeeCode:'A-SECOND',hiredOn:'2021-01-01'}));
    expect(await occupants()).toBe(1);
  });

  it('two concurrent OFF writers cannot both succeed, including direct app-role SQL',async()=>{
    const employees=await Promise.all([hire('RACE1'),hire('RACE2')]);
    for(const e of employees)await setStatutoryProfileMY(ctx,{personId:e.personId,icNumber:null});
    const result=await Promise.allSettled(employees.map(e=>withTenant(ctx,tx=>tx.update(schema.employeeStatutoryMy).set({icNumber:identity}).where(eq(schema.employeeStatutoryMy.personId,e.personId)).returning({id:schema.employeeStatutoryMy.id}))));
    const succeeded=result.filter(r=>r.status==='fulfilled'),failed=result.filter(r=>r.status==='rejected');
    expect(succeeded).toHaveLength(1);expect(failed).toHaveLength(1);
    if(succeeded[0].status==='fulfilled')expect(succeeded[0].value).toHaveLength(1);
    if(failed[0].status==='rejected')expect(pgSqlState(failed[0].reason)).toBe('PN001');
    expect(await occupants()).toBe(1);
  });

  it('a committed OFF toggle precedes a waiting duplicate writer; a duplicate committed before OFF remains valid',async()=>{
    const a=await hire('T1'),c=await hire('T2');await policy(true);await setIcProfileMY(ctx,{personId:a.personId,icNumber:identity});
    let ready!:()=>void,release!:()=>void;const locked=new Promise<void>(resolve=>ready=resolve),continueWrite=new Promise<void>(resolve=>release=resolve);
    const revision=(await getPeopleGeneral(ctx)).revision;
    const toggler=withTenant(ctx,async tx=>{await tx.execute(sql`select app.people_general_set(false,${revision}::uuid)`);ready();await continueWrite;});
    await locked;
    const pending=setIcProfileMY(ctx,{personId:c.personId,icNumber:identity});release();await toggler;await refusal(pending);
    await policy(true);
    let admitted!:()=>void,commit!:()=>void;const written=new Promise<void>(resolve=>admitted=resolve),finish=new Promise<void>(resolve=>commit=resolve);
    const writer=withTenant(ctx,async tx=>{await setIcProfileMY(ctx,{personId:c.personId,icNumber:identity},tx);admitted();await finish;});
    await written;const off=policy(false);commit();await writer;await off;
    expect((await getPeopleGeneral(ctx)).allowDuplicatedNric).toBe(false);expect(await occupants()).toBe(2);
  });

  it('AFTER admission neither reserves ignored upserts nor leaks counts on an entire failed employee mutation',async()=>{
    const a=await hire('UPSERT');await setIcProfileMY(ctx,{personId:a.personId,icNumber:identity});
    await withTenant(ctx,tx=>tx.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId:a.personId,icNumber:changedIdentity}).onConflictDoNothing());
    expect(await occupants(changedIdentity)).toBe(0);expect(await occupants()).toBe(1);
    const before=await counts();
    await refusal(withTenant(ctx,async tx=>{
      const e=await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,employeeCode:'ROLLBACK',person:{fullName:'Must roll back',primaryEmail:'rollback@nric-policy.test'},employmentType:'full_time',hiredOn:'2020-01-01'},tx);
      await setIcProfileMY(ctx,{personId:e.personId,icNumber:identity},tx);
    }));
    expect(await counts()).toEqual(before);expect(await occupants()).toBe(1);
  });

  it('old unique-index behavior fails the newly permitted ON case; removing only that negative control restores success',async()=>{
    const a=await hire('OLD1'),c=await hire('OLD2');await policy(true);await setIcProfileMY(ctx,{personId:a.personId,icNumber:identity});
    await owner.db.execute(sql`create unique index b3_old_nric_negative_control on employee_statutory_my(tenant_id,ic_number) where ic_number is not null`);
    try{await refusal(setIcProfileMY(ctx,{personId:c.personId,icNumber:identity}),'23505');}finally{await owner.db.execute(sql`drop index b3_old_nric_negative_control`);}
    await setIcProfileMY(ctx,{personId:c.personId,icNumber:identity});expect(await occupants()).toBe(2);
  });
});

describe('bcb56d37 all employee entry paths use the current policy',()=>{
  it('manual draft activation rolls back OFF duplicates, then ON activates the same draft',async()=>{
    const a=await hire('DRAFT-HOLDER');await setIcProfileMY(ctx,{personId:a.personId,icNumber:identity});
    const draft=await saveEmployeeDraft(ctx,{data:{profile:{fullName:'Draft duplicate',primaryEmail:'draft@nric-policy.test',employeeCode:'DRAFT-DUP',icNumber:identity},employment:{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'},payroll:{basicSalary:'4200'}},currentStep:3});
    const before=await counts();await refusal(completeEmployeeDraft(ctx,draft.id));expect(await counts()).toEqual(before);
    await policy(true);const completed=await completeEmployeeDraft(ctx,draft.id);expect(completed.employmentId).toBeTruthy();expect(await occupants()).toBe(2);
  });

  it('full new-joiner import checks in-file and existing normalized duplicates, preserves Employee ID/email checks, and rechecks policy at commit',async()=>{
    const records=[fullRow('IMPORT1'),fullRow('IMPORT2','900101-01-1234')];
    const blocked=await validateEmployeeImport(ctx,{companyId:b.companyId,records});expect(blocked.rows[1].errors).toContain(NRIC_FILE_DUPLICATE_MESSAGE);
    await policy(true);const allowed=await validateEmployeeImport(ctx,{companyId:b.companyId,records});expect(allowed.validCount).toBe(2);
    const result=await commitEmployeeImport(ctx,{companyId:b.companyId,records});expect(result.imported).toBe(2);expect(result.failed).toEqual([]);
    const colliding=[fullRow('IMPORT1',changedIdentity),{...fullRow('IMPORT3',changedIdentity),email:records[0].email}];
    const unrelated=await validateEmployeeImport(ctx,{companyId:b.companyId,records:colliding});expect(unrelated.validCount).toBe(0);
    const sameCode=await validateEmployeeImport(ctx,{companyId:b.companyId,records:[fullRow('SAMECODE',changedIdentity),{...fullRow('SAMECODE',changedIdentity),email:'distinct@nric-policy.test'}]});expect(sameCode.rows[1].ok).toBe(false);
    await saveEmployeeDraft(ctx,{data:{profile:{fullName:'Reserved fixture',primaryEmail:'reserved@nric-policy.test',employeeCode:'RESERVED'},employment:{companyId:b.companyId,departmentId:b.deptA}},currentStep:0});
    expect((await validateEmployeeImport(ctx,{companyId:b.companyId,records:[fullRow('RESERVED',changedIdentity)]})).validCount).toBe(0);
    const next=[fullRow('IMPORT4')];expect((await validateEmployeeImport(ctx,{companyId:b.companyId,records:next})).validCount).toBe(1);
    await policy(false);const committed=await commitEmployeeImport(ctx,{companyId:b.companyId,records:next});expect(committed.imported).toBe(0);expect(await occupants()).toBe(2);
  });

  it('profile update import retains unchanged duplicate identities OFF; newly introduced conflicts block the whole employee row',async()=>{
    const a=await hire('PROFILE1'),c=await hire('PROFILE2');await policy(true);await setIcProfileMY(ctx,{personId:a.personId,icNumber:identity});
    const same=await commitSectionImport(ctx,{section:'profile',records:[{employee_code:'PROFILE2',ic_number:identity}]});expect(same.updated).toBe(1);
    await policy(false);
    const unchanged=await commitSectionImport(ctx,{section:'profile',records:[{employee_code:'PROFILE2',ic_number:'900101-01-1234',full_name:'Updated name'}]});expect(unchanged.updated).toBe(1);expect(await occupants()).toBe(2);
    const d=await hire('PROFILE3');const before=await owner.db.select().from(schema.person).where(eq(schema.person.id,d.personId));
    const conflict=await commitSectionImport(ctx,{section:'profile',records:[{employee_code:'PROFILE3',ic_number:identity,full_name:'Should not save'}]});expect(conflict.updated).toBe(0);
    const after=await owner.db.select().from(schema.person).where(eq(schema.person.id,d.personId));expect(after[0].fullName).toBe(before[0].fullName);
    const preview=await validateSectionImport(ctx,{section:'profile',records:[{employee_code:'PROFILE3',ic_number:identity}]});expect(preview.rows[0].errors).toContain(NRIC_DUPLICATE_MESSAGE);
  });

  it('different Employee IDs for the same Person are not distinct-person duplicates in an OFF identity update file',async()=>{
    const a=await hire('ONEPERSON1');
    await withTenant(ctx,tx=>tx.insert(schema.employment).values({tenantId:b.tenantId,personId:a.personId,companyId:b.companyId,employeeCode:'ONEPERSON2',hiredOn:'2021-01-01'}));
    const records=[{employee_code:'ONEPERSON1',ic_number:identity},{employee_code:'ONEPERSON2',ic_number:identity}];
    const preview=await validateSectionImport(ctx,{section:'profile',records});expect(preview.validCount).toBe(2);
    const result=await commitSectionImport(ctx,{section:'profile',records});expect(result.updated).toBe(2);expect(await occupants()).toBe(1);
  });

  it.each(['legacy','current'] as const)('%s ESS correction approval refuses OFF and succeeds ON through the canonical writer',async(version)=>{
    const a=await hire('ESS1'),c=await hire('ESS2');await setIcProfileMY(ctx,{personId:a.personId,icNumber:identity});await setIcProfileMY(ctx,{personId:c.personId,icNumber:changedIdentity});
    const userId=await createAppUser(b.tenantId,c.personId,'employee');const employee={...ctx,userId,personId:c.personId,roles:['employee']};
    const request=await (version==='legacy'?seedStoredLegacyProfileRequest:requestCurrentProfileChange)(employee,{employmentId:c.employmentId,proposed:{icNumber:identity}});
    await refusal(decideProfileChange(ctx,{requestId:request.requestId,decision:'approved'}));expect(await ic(c.personId)).toBe(changedIdentity);
    await policy(true);await decideProfileChange(ctx,{requestId:request.requestId,decision:'approved'});expect(await ic(c.personId)).toBe(identity);
  });

  it('ambiguous NRIC attendance/leave lookups refuse; explicit Employee IDs select the intended employment',async()=>{
    const a=await hire('LOOKUP1'),c=await hire('LOOKUP2');await policy(true);for(const e of [a,c])await setIcProfileMY(ctx,{personId:e.personId,icNumber:identity});
    const attendance=await validateClockingImport(ctx,{mappingId:BUILTIN_MAPPING_ID,text:`staff,time\n${identity},2020-02-01 08:00:00`});expect(attendance.errorRows).toHaveLength(1);expect(attendance.errorRows[0]).toMatchObject({result:'ambiguous_card',employmentId:null});
    const specific=await validateClockingImport(ctx,{mappingId:BUILTIN_MAPPING_ID,text:'staff,time\nLOOKUP2,2020-02-01 08:00:00'});expect(specific.errorRows).toHaveLength(0);expect(specific.validRows).toHaveLength(1);
    const record={employee_id:identity,leave_type:'ANNUAL',transaction_type:'adjustment',days:'1',effective_date:'2020-02-01'};
    const leave=await validateLeaveImport(ctx,{records:[record]});expect(leave.rows[0].errors).toContain(NRIC_AMBIGUOUS_MESSAGE);
    expect((await commitLeaveImport(ctx,{records:[record]})).imported).toBe(0);
    const byCode=await commitLeaveImport(ctx,{records:[{...record,employee_id:'LOOKUP2'}]});expect(byCode.imported).toBe(1);
  });
});

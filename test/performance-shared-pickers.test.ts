/** AP026: bounded shared panels preserve each native population, selected header and actual carrier. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {listEmployees,listManagerCandidates,employeePickerSubject} from '../core/read';
import {sharedEmployeePicker,sharedEmployeePickerPage} from '../core/shared-employee-picker';
import {draftManagerChoices} from '../core/draft-manager-choice';
import {attendanceApplicationFilterOptions,attendanceApplicationEmployeeChoices} from '../core/attendance-application-history';
import {EmployeeChoiceAccessError} from '../core/employee-choice';
import {WorkforceChoiceAccessError} from '../lib/workforce-choice';
import {isAdmin} from '../lib/authz-model';
import {organisationFilterChoices} from '../lib/organisation-choice-label';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
async function fixture(){
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const companies=[b.companyId,...(await owner.db.insert(s.company).values(Array.from({length:69},(_,i)=>({tenantId:b.tenantId,legalName:'Fictional picker company '+i}))).returning({id:s.company.id})).map(r=>r.id)];
 const departments=(await owner.db.insert(s.department).values(companies.map((companyId,i)=>({tenantId:b.tenantId,companyId,name:'Picker department '+i,label:'Readable department '+i}))).returning({id:s.department.id})).map(r=>r.id);
 const people=await owner.db.insert(s.person).values(Array.from({length:1000},(_,i)=>({tenantId:b.tenantId,fullName:i<6?['İnci','ΟΣ','Ος','Kelvin','Emoji 😀','Percent %_\\'][i]:'Fictional picker '+String(i).padStart(4,'0'),primaryEmail:randomUUID()+'@fixture.invalid'}))).returning({id:s.person.id});
 const employees=await owner.db.insert(s.employment).values(people.map((p,i)=>({tenantId:b.tenantId,personId:p.id,companyId:companies[i%70],employeeCode:'P-'+String(i).padStart(4,'0'),hiredOn:'2020-01-01',terminatedOn:i===999?'2099-01-01':i%17===0?'2025-01-01':null}))).returning({id:s.employment.id});
 await owner.db.insert(s.assignment).values(employees.map((e,i)=>({tenantId:b.tenantId,employmentId:e.id,companyId:companies[i%70],departmentId:departments[i%70],employmentType:'full_time' as const,validFrom:'2020-01-01'})));
 return {b,ctx,companies,departments,people,employees};
}
const pick=(row:Awaited<ReturnType<typeof listEmployees>>[number],labels:boolean)=>({employmentId:row.employmentId,name:row.name,employeeCode:row.employeeCode,company:row.company,companyId:row.companyId,
 department:labels?row.departmentLabel??row.department:row.department,departmentCode:labels?row.departmentCode:null,departmentId:row.departmentId,
 businessUnit:labels?row.businessUnitLabel??row.businessUnit:row.businessUnit,businessUnitCode:labels?row.businessUnitCode:null,businessUnitId:row.businessUnitId,status:row.terminatedOn?'ended':'active'});
const header=(row:Awaited<ReturnType<typeof listEmployees>>[number])=>Object.fromEntries(['employmentId','name','employeeCode','personId','companyId','company','department','position','hiredOn','terminatedOn'].map(key=>[key,row[key as keyof typeof row]]));
it('retains all-status and active-only populations, represented facets, deep selected headers and legacy role/scope guards',async()=>{
 const f=await fixture(),{b,ctx,companies,employees,people}=f,selectedId=employees[900].id;
 const old=await listEmployees(ctx,companies);expect(old).toHaveLength(1000);
 for(const purpose of ['scoped','active','loans'] as const){
  const scope=[b.companyId],oracle=(purpose==='loans'?old:old.filter(r=>r.companyId===b.companyId)).filter(r=>purpose!=='active'||!r.terminatedOn);
  const page=await sharedEmployeePicker(ctx,scope,purpose,{labelMode:'labels',selectedId});
  expect(page.choices.rows).toEqual(oracle.slice(0,25).map(r=>pick(r,true)));expect(page.choices.total).toBe(oracle.length);
  expect(page.subject).toEqual(oracle.some(r=>r.employmentId===selectedId)?header(oracle.find(r=>r.employmentId===selectedId)!):null);
  const tail=await sharedEmployeePickerPage(ctx,scope,purpose,{labelMode:'labels',offset:25,selectedId});expect(tail.rows).toEqual(oracle.slice(25,50).map(r=>pick(r,true)));
  expect(page.choices.departmentOptions).toEqual(organisationFilterChoices(oracle.map(r=>({id:r.departmentId,name:r.departmentLabel??r.department,code:r.departmentCode}))));
 }
 const selected=old.find(r=>r.employmentId===selectedId)!;
 const hiddenBySearch=await sharedEmployeePicker(ctx,companies,'scoped',{labelMode:'labels',query:'NO MATCH',status:'ended',selectedId});
 expect(hiddenBySearch.choices.total).toBe(0);expect(hiddenBySearch.subject).toEqual(header(selected));expect(hiddenBySearch.choices.selected?.employmentId).toBe(selectedId);
 expect((await sharedEmployeePicker(ctx,companies,'active',{selectedId:employees[999].id})).subject).toBeNull();
 expect((await sharedEmployeePicker(ctx,[],'loans',{selectedId:employees[999].id})).subject?.employmentId).toBe(employees[999].id);
 expect(JSON.stringify((await sharedEmployeePicker(ctx,companies,'scoped')).choices).length).toBeLessThan(JSON.stringify(old).length/10);
 for(const role of s.roleEnum.enumValues)for(const companyId of role==='super_admin'?[null]:[null,b.companyId]){
  const userId=await createAppUser(b.tenantId,people[1].id,'employee');await owner.db.update(s.roleAssignment).set({role,companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const who={...ctx,userId,personId:people[1].id,roles:[role],grants:[{role,companyId}]};
  for(const scope of [[],[b.companyId]]){
   const legacy=await listEmployees(who,scope),expected=legacy.find(r=>r.employmentId===employees[1].id);
   expect(await employeePickerSubject(who,employees[1].id,scope)).toEqual(expected?header(expected):null);
   if(isAdmin(who)){const packet=await sharedEmployeePicker(who,scope,'scoped',{selectedId:employees[1].id,labelMode:'labels'});expect(packet.choices.rows).toEqual(legacy.slice(0,25).map(r=>pick(r,true)));expect(packet.choices.total).toBe(legacy.length);}
   else await expect(sharedEmployeePicker(who,scope,'scoped')).rejects.toBeInstanceOf(EmployeeChoiceAccessError);
  }
 }
 for(const id of [selectedId.toUpperCase(),selectedId.replaceAll('-',''),'bad'])expect(await employeePickerSubject(ctx,id,companies)).toBeNull();
 const foreign=await seedBase();expect(await employeePickerSubject(adminCtx(foreign),selectedId)).toBeNull();
 const actual=database.withTenant,carriers:{ro:string;isolation:string;exclusive:boolean}[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(who:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(who,async tx=>{
  const result=await read(tx);const [mode]=await tx.execute<{ro:string;isolation:string;exclusive:boolean}>(sql`select current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation,coalesce(app.access_lock_mode_held(${who.tenantId}::uuid)='X',false) exclusive`);carriers.push(mode);return result;
 },options));
 try{await sharedEmployeePicker(ctx,companies,'scoped',{selectedId});expect(spy).toHaveBeenCalledTimes(1);expect(carriers).toEqual([{ro:'on',isolation:'repeatable read',exclusive:false}]);}finally{spy.mockRestore();}
 // Every-role70-company/1000-employment legacy comparisons need the same headroom as the other native picker suites.
},300000);
it('retains Attendance administered-company, dated Assignment and department Business Unit fallback semantics',async()=>{
 const {b,ctx,companies,departments,employees}=await fixture();
 const [unit]=await owner.db.insert(s.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,name:'Dated unit',code:'DATED'}).returning({id:s.businessUnit.id});
 await owner.db.update(s.department).set({businessUnitId:unit.id}).where(eq(s.department.id,departments[0]));
 await owner.db.update(s.assignment).set({validTo:'2030-01-01'}).where(eq(s.assignment.employmentId,employees[0].id));
 await owner.db.insert(s.assignment).values({tenantId:b.tenantId,employmentId:employees[0].id,companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',validFrom:'2030-01-01'});
 const old=await attendanceApplicationFilterOptions(ctx,companies),page=await attendanceApplicationEmployeeChoices(ctx,companies,{selectedId:employees[0].id});expect(old.employees).toHaveLength(1000);
 const expected=old.employees.map(r=>({employmentId:r.id,name:r.name,employeeCode:r.employeeCode,company:r.company,companyId:r.companyId,department:r.department,departmentId:r.departmentId,departmentCode:null,businessUnit:r.businessUnit,businessUnitId:r.businessUnitId,businessUnitCode:null,status:r.terminatedOn?'ended':'active'}));
 expect(page.rows).toEqual(expected.slice(0,25));expect(page.total).toBe(1000);expect(page.selected).toEqual(expected.find(r=>r.employmentId===employees[0].id));expect(page.selected?.departmentId).toBe(departments[0]);expect(page.selected?.businessUnitId).toBe(unit.id);
 const filtered=await attendanceApplicationEmployeeChoices(ctx,companies,{businessUnitId:unit.id,selectedId:employees[900].id});expect(filtered.rows).toEqual(expected.filter(r=>r.businessUnitId===unit.id).slice(0,25));expect(filtered.total).toBe(expected.filter(r=>r.businessUnitId===unit.id).length);expect(filtered.selected?.employmentId).toBe(employees[900].id);
 expect((await attendanceApplicationEmployeeChoices(ctx,[],{selectedId:employees[0].id}))).toMatchObject({rows:[],total:0,selected:null,companyOptions:[]});
 const withoutCatalogues=await attendanceApplicationFilterOptions(ctx,companies,[],{omitEmployees:true});expect(withoutCatalogues.employees).toEqual([]);expect('approverEmployees' in withoutCatalogues&&withoutCatalogues.approverEmployees).toEqual([]);expect(withoutCatalogues.companies).toEqual(old.companies);
 // Two full native option owners plus 70-company dated/fallback page queries are intentionally bounded to five minutes.
},300000);
it('keeps draft managers on employment/person RLS and exact legacy full-label Unicode search',async()=>{
 const {b,ctx,companies,employees}=await fixture();
 const [draft]=await owner.db.insert(s.employeeDraft).values({tenantId:b.tenantId,companyId:b.companyId,label:'Fictional manager picker',data:{}}).returning({id:s.employeeDraft.id});
 const legacy=await listManagerCandidates(ctx,{companyIds:companies});expect(legacy.length).toBeGreaterThan(900);
 const selectedId=employees[900].id,first=await draftManagerChoices(ctx,companies,{subjectId:draft.id,selectedIds:[selectedId]});expect(first.rows.map(r=>({employmentId:r.employmentId,name:r.name,employeeCode:r.employeeCode}))).toEqual(legacy.slice(0,25));expect(first.total).toBe(legacy.length);expect(first.selected.map(r=>r.employmentId)).toEqual([selectedId]);
 const tail=await draftManagerChoices(ctx,companies,{subjectId:draft.id,offset:900});expect(tail.rows.map(r=>r.employmentId)).toEqual(legacy.slice(900,925).map(r=>r.employmentId));
 for(const query of ['i','i\u0307','σ','ς','k','%','_','\\','\0','😀','\ud83d',legacy[0].employeeCode+' – '+legacy[0].name]){
  const q=query.trim().toLowerCase(),expected=legacy.filter(r=>(r.employeeCode?`${r.employeeCode} – ${r.name}`:r.name).toLowerCase().includes(q)||r.employmentId.includes(q));
  const page=await draftManagerChoices(ctx,companies,{subjectId:draft.id,query,selectedIds:[selectedId]});expect(page.total,query).toBe(expected.length);expect(page.rows.map(r=>r.employmentId),query).toEqual(expected.slice(0,25).map(r=>r.employmentId));expect(page.selected.map(r=>r.employmentId)).toEqual([selectedId]);
 }
 const all=await draftManagerChoices(ctx,[],{subjectId:draft.id});expect(all.total).toBe(legacy.length);
 await expect(draftManagerChoices(ctx,companies,{subjectId:randomUUID()})).rejects.toBeInstanceOf(WorkforceChoiceAccessError);
 const foreign=await seedBase();await expect(draftManagerChoices(adminCtx(foreign),[],{subjectId:draft.id})).rejects.toBeInstanceOf(WorkforceChoiceAccessError);
},300000);

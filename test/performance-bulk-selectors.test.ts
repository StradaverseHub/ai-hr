import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {listEmployees,listEmployeePickOptions,statutoryPickerEmployees} from '../core/read';
import {bulkEmployeePicker,resolveBulkEmployeeSelection} from '../core/bulk-employee-picker';
import {bulkEmployeePickerRequest} from '../core/bulk-employee-picker-request';
import {EmployeeChoiceAccessError,EmployeeChoiceInputError} from '../core/employee-choice';
import {isAdmin} from '../lib/authz-model';
import {matchesEmployeeSearch} from '../lib/employee-search';
import {resolveEmploymentSelection} from '../lib/employment-selection';
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
const identity=(row:Awaited<ReturnType<typeof listEmployees>>[number])=>({id:row.employmentId,name:row.name,employeeCode:row.employeeCode});
it('keeps complete all-status populations and exact folded searches across every role and company grant at 70/1000 scale',async()=>{
 const {b,ctx,companies,people,employees}=await fixture();
 for(const role of s.roleEnum.enumValues)for(const companyId of role==='super_admin'?[null]:[null,b.companyId]){
  const userId=await createAppUser(b.tenantId,people[1].id,'employee');await owner.db.update(s.roleAssignment).set({role,companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const who={...ctx,userId,personId:people[1].id,roles:[role],grants:[{role,companyId}]};
  const legacy=(await listEmployees(who)).map(identity);
  expect(await listEmployeePickOptions(who)).toEqual(legacy);
  if(!isAdmin(who)){await expect(bulkEmployeePicker(who,{query:'',offset:0})).rejects.toBeInstanceOf(EmployeeChoiceAccessError);continue;}
  for(const query of ['', 'p0008','İ','ος','😀','%_','NOT FOUND']){
   const expected=legacy.filter(row=>matchesEmployeeSearch(row,query));
   for(const offset of [0,25,975,1000]){const value=await bulkEmployeePicker(who,{query,offset});expect(value.rows).toEqual(expected.slice(offset,offset+25));expect(value.total).toBe(expected.length);expect(value.ids).toBeUndefined();}
   const all=await bulkEmployeePicker(who,{query,offset:0,all:true});expect(all.ids).toEqual(expected.map(row=>row.id));expect(all.rows.length).toBeLessThanOrEqual(25);
  }
 }
 const selected=[employees[999].id,employees[900].id,randomUUID(),'unknown'];
 const known=(await listEmployees(ctx)).map(identity);
 expect((await resolveBulkEmployeeSelection(ctx,selected,'p0008, BAD')).selection).toEqual(resolveEmploymentSelection(selected,'p0008, BAD',known));
 expect((await resolveBulkEmployeeSelection(ctx,known.map(row=>row.id),'')).selection.ids).toEqual(known.map(row=>row.id));
 expect((await resolveBulkEmployeeSelection(ctx,known.map(row=>row.id),'')).rows).toHaveLength(25);
 const empty=await resolveBulkEmployeeSelection(ctx,[],'');expect(empty).toEqual({selection:{ids:[],unmatched:[]},rows:[]});
 expect(await listEmployeePickOptions(ctx,[])).toEqual([]);
 expect(await listEmployeePickOptions(ctx,[employees[999].id,'BAD',employees[999].id.toUpperCase()])).toEqual(known.filter(row=>row.id===employees[999].id));
 const foreign=await seedBase();expect((await resolveBulkEmployeeSelection(adminCtx(foreign),selected,'p0008')).rows).toEqual([]);
 // Every-role 70-company/1000-employment native equivalence has the same 300s headroom as prior picker suites.
},300000);
it('preserves exact/folded code collision refusal, complete statutory lifecycle labels and RO/shared carriers',async()=>{
 const {b,ctx,companies,employees}=await fixture();
 await owner.db.update(s.employment).set({employeeCode:'P0008'}).where(eq(s.employment.id,employees[7].id));
 await owner.db.update(s.employment).set({blacklistedAt:new Date('2026-01-01')}).where(eq(s.employment.id,employees[0].id));
 const known=(await listEmployees(ctx)).map(identity);
 for(const raw of ['P-0008','P0008','P 0008','P.0008','P 0008,missing'])expect((await resolveBulkEmployeeSelection(ctx,[],raw)).selection).toEqual(resolveEmploymentSelection([],raw,known));
 for(const companyId of companies.slice(0,3)){
  const legacy=await listEmployees(ctx,[companyId]),ids=legacy.filter((_,index)=>index%2===0).map(row=>row.employmentId);
  const rows=await statutoryPickerEmployees(ctx,companyId,ids);
  const keys=['employmentId','name','employeeCode','department','terminatedOn','confirmationDate','finalConfirmationDate','probationEndDate','provisionalEndOn','resignationDate','lastWorkingDate','blacklistedAt'];
  expect(rows).toEqual(legacy.filter(row=>ids.includes(row.employmentId)).map(row=>Object.fromEntries(keys.map(key=>[key,row[key as keyof typeof row]]))));
  expect(await statutoryPickerEmployees(ctx,companyId,[])).toEqual([]);
 }
 const actual=database.withTenant,carriers:{ro:string;isolation:string;exclusive:boolean}[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(who:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(who,async tx=>{
  const result=await read(tx);const [mode]=await tx.execute<{ro:string;isolation:string;exclusive:boolean}>(sql`select current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation,coalesce(app.access_lock_mode_held(${who.tenantId}::uuid)='X',false) exclusive`);carriers.push(mode);return result;
 },options));
 try{await bulkEmployeePicker(ctx,{query:'',offset:0});await resolveBulkEmployeeSelection(ctx,[employees[999].id],'');await statutoryPickerEmployees(ctx,b.companyId,[employees[0].id]);expect(carriers).toEqual(Array.from({length:3},()=>({ro:'on',isolation:'repeatable read',exclusive:false})));}finally{spy.mockRestore();}
 const legacy=await listEmployees(ctx),page=await bulkEmployeePicker(ctx,{query:'',offset:0});
 expect(JSON.stringify(page).length).toBeLessThan(JSON.stringify(legacy).length/50);
 expect(Object.keys(page.rows[0]).sort()).toEqual(['employeeCode','id','name']);
},300000);
it('bounds private request bytes and refuses scope injection or malformed operations',async()=>{
 const request=(value:unknown)=>new Request('https://hr.example/api/bulk-employee-choices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
 expect(await bulkEmployeePickerRequest(request({operation:'page',query:'',offset:0}))).toEqual({operation:'page',query:'',offset:0});
 for(const input of [{operation:'page',query:'',offset:-1},{operation:'page',query:'',offset:0,companyIds:[]},{operation:'all',query:'',offset:0,roles:['super_admin']},{operation:'resolve',picked:[1],raw:''},{operation:'resolve',picked:[],raw:'x'.repeat(1048576)}])await expect(bulkEmployeePickerRequest(request(input))).rejects.toBeInstanceOf(EmployeeChoiceInputError);
});

/** AP026: exact legacy members, actual detail/PDF responses and read-only carriers at group scale. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {PDFDocument} from 'pdf-lib';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {employeePickerSubject,employeeListContains,listEmployees} from '../core/read';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
let scope:{s:SessionContext;scopeIds:string[]};
vi.mock('../lib/scope',()=>({scopedAdmin:async()=>scope,scopedSession:async()=>scope}));
vi.mock('../lib/authz',async original=>({...await original<typeof import('../lib/authz')>(),requireAdmin:async()=>scope.s}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NEXT_NOT_FOUND');},redirect:(url:string)=>{throw Error('NEXT_REDIRECT:'+url);}}));
vi.mock('next-intl/server',()=>({getLocale:async()=> 'en',getTranslations:async()=> (key:string)=>key}));
import Tp1New from '../app/payroll/transactions/tp1/new/page';
import Tp1Detail from '../app/payroll/transactions/tp1/[year]/[month]/page';
import ZakatEditor from '../app/payroll/transactions/zakat/election/page';
import AttendanceDay from '../app/attendance/individual/[date]/page';
import {GET as tp1Pdf} from '../app/payroll/transactions/tp1/[year]/[month]/pdf/route';
import {GET as tp3Pdf} from '../app/payroll/transactions/tp3/pdf/route';
beforeAll(migrateTestDb);afterAll(closeAll);
async function fixture(){
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const companies=[b.companyId,...(await owner.db.insert(s.company).values(Array.from({length:69},(_,i)=>({tenantId:b.tenantId,legalName:'Detail company '+i}))).returning({id:s.company.id})).map(r=>r.id)];
 const people=await owner.db.insert(s.person).values(Array.from({length:1000},(_,i)=>({tenantId:b.tenantId,fullName:'Detail employee '+String(i).padStart(4,'0'),primaryEmail:randomUUID()+'@fixture.invalid'}))).returning({id:s.person.id});
 const employees=await owner.db.insert(s.employment).values(people.map((p,i)=>({tenantId:b.tenantId,personId:p.id,companyId:companies[i%70],employeeCode:'DETAIL-'+i,hiredOn:'2020-01-01',terminatedOn:i===999?'2099-01-01':i%17===0?'2025-01-01':null}))).returning({id:s.employment.id});
 await owner.db.insert(s.assignment).values(employees.map((e,i)=>({tenantId:b.tenantId,employmentId:e.id,companyId:companies[i%70],employmentType:'full_time' as const,validFrom:'2020-01-01'})));
 scope={s:ctx,scopeIds:companies};return {b,ctx,companies,people,employees};
}
const header=(row:Awaited<ReturnType<typeof listEmployees>>[number])=>Object.fromEntries(['employmentId','name','employeeCode','personId','companyId','company','department','position','hiredOn','terminatedOn'].map(key=>[key,row[key as keyof typeof row]]));
it('matches legacy exact selections and membership in every native role/group/company scope without full-row hydration',async()=>{
 const {b,ctx,companies,people,employees}=await fixture();
 for(const role of s.roleEnum.enumValues)for(const companyId of role==='super_admin'?[null]:[null,b.companyId]){
  const userId=await createAppUser(b.tenantId,people[1].id,'employee');await owner.db.update(s.roleAssignment).set({role,companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const who={...ctx,userId,personId:people[1].id,roles:[role],grants:[{role,companyId}]};
  for(const ids of [companies,[b.companyId],[]]){
   const legacy=await listEmployees(who,ids);
   for(const index of [1,17,999]){
    const id=employees[index].id,expected=legacy.find(row=>row.employmentId===id);
    expect(await employeePickerSubject(who,id,ids)).toEqual(expected?header(expected):null);
    expect(await employeeListContains(who,id,ids)).toBe(Boolean(expected));
   }
  }
 }
 const id=employees[1].id;
 for(const value of [undefined,'bad',id.toUpperCase(),id.replaceAll('-',''),randomUUID()])expect(await employeePickerSubject(ctx,value,companies)).toBeNull();
 const foreign=await seedBase();expect(await employeePickerSubject(adminCtx(foreign),id)).toBeNull();expect(await employeePickerSubject(ctx,id,[foreign.companyId])).toBeNull();
 const legacy=await listEmployees(ctx,companies);expect(legacy).toHaveLength(1000);const bounded=await employeePickerSubject(ctx,id,companies);expect(JSON.stringify(bounded).length).toBeLessThan(JSON.stringify(legacy).length/100);
 const actual=database.withTenant,carriers:{ro:string;isolation:string;exclusive:boolean}[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(who:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(who,async tx=>{
  const result=await read(tx);const [mode]=await tx.execute<{ro:string;isolation:string;exclusive:boolean}>(sql`select current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation,coalesce(app.access_lock_mode_held(${who.tenantId}::uuid)='X',false) exclusive`);carriers.push(mode);return result;
 },options));
 try{await employeePickerSubject(ctx,id,companies);expect(carriers).toEqual([{ro:'on',isolation:'repeatable read',exclusive:false}]);}finally{spy.mockRestore();}
 // Every-role70-company/1000-employment native equivalence includes multiple exact identities per scope.
},300000);
it('keeps real detail/redirect/PDF identities, terminated cohorts and native refusal behavior',async()=>{
 const {b,ctx,companies,people,employees}=await fixture();
 const id=employees[1].id;
 await owner.db.insert(s.tp1Relief).values([1,17,999].map(i=>({tenantId:b.tenantId,personId:people[i].id,assessmentYear:2026,deductionMonth:7,tp1Amount:'123.45'})));
 await owner.db.insert(s.employeeTp3).values([1,17,999].map(i=>({tenantId:b.tenantId,personId:people[i].id,assessmentYear:2026,deductionMonth:7})));
 const params=Promise.resolve({year:'2026',month:'7'}),url=(value:string)=>'https://hr.example/pdf?year=2026&employmentId='+encodeURIComponent(value);
 expect(await Tp1New({searchParams:Promise.resolve({employmentId:id})})).toBeTruthy();
 await expect(Tp1New({searchParams:Promise.resolve({employmentId:id,year:'2026',month:'7'})})).rejects.toThrow('NEXT_REDIRECT:/payroll/transactions/tp1/2026/7?employmentId='+id);
 expect(await Tp1Detail({params,searchParams:Promise.resolve({employmentId:id})})).toBeTruthy();
 expect(await ZakatEditor({searchParams:Promise.resolve({employmentId:id})})).toBeTruthy();
 for(const index of [1,17,999]){
  for(const response of [await tp1Pdf(new Request(url(employees[index].id)),{params}),await tp3Pdf(new Request(url(employees[index].id)))]){
   expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('application/pdf');expect(response.headers.get('content-disposition')).toContain('Detail-employee-'+String(index).padStart(4,'0'));
   const bytes=new Uint8Array(await response.arrayBuffer());expect(new TextDecoder().decode(bytes.slice(0,5))).toBe('%PDF-');expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(0);
  }
 }
 for(const index of [17,999])await expect(ZakatEditor({searchParams:Promise.resolve({employmentId:employees[index].id})})).rejects.toThrow('NEXT_NOT_FOUND');
 for(const value of [randomUUID(),id.toUpperCase(),id.replaceAll('-',''),'bad']){
  await expect(Tp1New({searchParams:Promise.resolve({employmentId:value})})).rejects.toThrow('NEXT_NOT_FOUND');
  await expect(tp1Pdf(new Request(url(value)),{params})).rejects.toThrow('NEXT_NOT_FOUND');
  await expect(tp3Pdf(new Request(url(value)))).rejects.toThrow('NEXT_NOT_FOUND');
 }
 scope={s:ctx,scopeIds:[companies[0]]};
 await expect(Tp1Detail({params,searchParams:Promise.resolve({employmentId:id})})).rejects.toThrow('NEXT_NOT_FOUND');
 await expect(ZakatEditor({searchParams:Promise.resolve({employmentId:id})})).rejects.toThrow('NEXT_NOT_FOUND');
 await expect(tp1Pdf(new Request(url(id)),{params})).rejects.toThrow('NEXT_NOT_FOUND');await expect(tp3Pdf(new Request(url(id)))).rejects.toThrow('NEXT_NOT_FOUND');
 const day=await AttendanceDay({params:Promise.resolve({date:'2026-07-01'}),searchParams:Promise.resolve({emp:id})});expect(JSON.stringify(day)).toContain('dayNoRecord');expect(JSON.stringify(day)).not.toContain('Detail employee 0001');
 scope={s:ctx,scopeIds:[]};expect(await Tp1New({searchParams:Promise.resolve({employmentId:id})})).toBeTruthy();
 // Real native declaration reads and six generated PDF documents need hosted renderer headroom.
},300000);

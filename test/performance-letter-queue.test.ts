/** AP005: native Letters queue at group scale; no constraint or trigger bypass. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {decideLetterTemplate,saveLetterPermission,saveLetterTemplate} from '../core/letters';
import {listLetterRequestsForStaff,listLetterRequestsForStaffPage,saveLetterRequestOptions,type StaffLetterRequest} from '../core/letter-requests';
import {parsePageQuery} from '../lib/pagination';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.restoreAllMocks());
const ordered=(rows:readonly StaffLetterRequest[])=>[...rows].sort((a,b)=>a.createdAt.getTime()-b.createdAt.getTime()||a.id.localeCompare(b.id));
async function outcome<T>(work:()=>Promise<T>){try{return {value:await work()};}catch(error){return {error:(error as {code?:string}).code??'unknown'};}}
it('matches every role and scope, exact counts and ordered pages with one shared read-only transaction',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const rest=await owner.db.insert(s.company).values(Array.from({length:69},(_,i)=>({tenantId:b.tenantId,legalName:'Fictional queue company '+i}))).returning({id:s.company.id});
 const companies=[b.companyId,...rest.map(r=>r.id)];
 const members=Array.from({length:1000},(_,i)=>({personId:randomUUID(),employmentId:randomUUID(),userId:randomUUID(),companyId:companies[i%70]}));
 await owner.db.insert(s.person).values(members.map((m,i)=>({id:m.personId,tenantId:b.tenantId,fullName:'Fictional queue person '+i,primaryEmail:m.personId+'@fixture.invalid'})));
 await owner.db.insert(s.employment).values(members.map((m,i)=>({id:m.employmentId,tenantId:b.tenantId,personId:m.personId,companyId:m.companyId,employeeCode:'LQ-'+i,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(members.map(m=>({id:m.userId,tenantId:b.tenantId,personId:m.personId,workosUserId:'fixture_'+m.userId})));
 await owner.db.insert(s.roleAssignment).values(members.map(m=>({tenantId:b.tenantId,appUserId:m.userId,role:'employee' as const,companyId:m.companyId})));
 const reviewer={...ctx,userId:await createAppUser(b.tenantId,members[0].personId,'hr_admin'),personId:members[0].personId};
 const templates=new Map<string,string[]>();
 for(const companyId of companies){const ids:string[]=[];
  for(let i=0;i<3;i++){
   const made=await saveLetterTemplate(ctx,{companyId,code:'QUEUE'+i,name:'Fictional queue letter '+i,category:'confirmation',effectiveFrom:todayInKualaLumpur(),document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'Fictional queue letter'}]}]},fieldVersionIds:[]});
   await decideLetterTemplate(ctx,{versionId:made.versionId,expectedStatus:'draft',action:'submit'});
   await decideLetterTemplate(reviewer,{versionId:made.versionId,expectedStatus:'submitted',action:'approve'});ids.push(made.templateId);
  }
  await saveLetterRequestOptions(ctx,{companyId,changes:ids.map(templateId=>({templateId,requestable:true}))});templates.set(companyId,ids);
 }
 await owner.db.insert(s.letterRequest).values(members.flatMap(m=>templates.get(m.companyId)!.map(templateId=>({tenantId:b.tenantId,companyId:m.companyId,employmentId:m.employmentId,requestedBy:m.userId,templateId,letterTypeName:'Trigger owns name',purpose:'Fictional private purpose'}))));
 const native=database.withTenant,carriers:{readOnly:string;mode:string}[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(who:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(who,async tx=>{
  const result=await read(tx);const [mode]=await tx.execute<{readOnly:string;mode:string}>(sql`select current_setting('transaction_read_only') as "readOnly",app.access_lock_mode_held(${who.tenantId}::uuid) as mode`);carriers.push(mode);return result;
 },options));
 const legacy=ordered((await Promise.all(companies.map(companyId=>listLetterRequestsForStaff(ctx,{companyId})))).flat());
 expect(legacy).toHaveLength(3000);expect(spy).toHaveBeenCalledTimes(70);spy.mockClear();carriers.length=0;
 const first=await listLetterRequestsForStaffPage(ctx,{companyIds:companies,page:parsePageQuery()});
 expect(first.rows).toEqual(legacy.slice(0,25));expect(first.state).toMatchObject({total:3000,from:1,to:25,hasNext:true});expect(spy).toHaveBeenCalledTimes(1);expect(carriers).toEqual([{readOnly:'on',mode:'S'}]);
 for(const size of ['25','50','100','200','all']){
  const page=parsePageQuery({page:'2',size}),packet=await listLetterRequestsForStaffPage(ctx,{companyIds:companies,page});
  expect(packet.rows).toEqual(legacy.slice(page.offset,page.offset+page.limit));expect(packet.state.total).toBe(3000);expect(packet.state.truncated).toBe(size==='all');
 }
 expect((await listLetterRequestsForStaffPage(ctx,{companyIds:companies,page:parsePageQuery({page:'999'})})).state).toMatchObject({total:3000,from:0,to:0,hasPrev:true});
 expect((await listLetterRequestsForStaffPage(ctx,{companyIds:[],page:parsePageQuery()})).state.total).toBe(0);
 for(const role of s.roleEnum.enumValues)for(const scope of role==='super_admin'?[null]:[null,b.companyId]){
  const userId=await createAppUser(b.tenantId,members[0].personId,'employee');await owner.db.update(s.roleAssignment).set({role,companyId:scope}).where(eq(s.roleAssignment.appUserId,userId));
  const who={...ctx,userId,personId:members[0].personId,roles:[role],grants:[{role,companyId:scope}]} satisfies SessionContext;
  for(const companyIds of [companies,[b.companyId],[companies[1]]]){
   const old=await outcome(async()=>ordered((await Promise.all(companyIds.map(companyId=>listLetterRequestsForStaff(who,{companyId})))).flat()));
   const current=await outcome(()=>listLetterRequestsForStaffPage(who,{companyIds,page:parsePageQuery()}));
   if('error' in old)expect(current).toEqual(old);
   else {expect('value' in current).toBe(true);if('value' in current){expect(current.value!.rows).toEqual(old.value!.slice(0,25));expect(current.value!.state.total).toBe(old.value!.length);}}
  }
 }
 // Capability-granted generator has no broad workforce role; native subject/template owners still decide disclosure.
 await saveLetterPermission(ctx,{companyId:b.companyId,capability:'generate',role:'employee',allowed:true});
 const generator={...ctx,userId:members[0].userId,personId:members[0].personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]} satisfies SessionContext;
 const generatorOld=await listLetterRequestsForStaff(generator,{companyId:b.companyId});
 expect((await listLetterRequestsForStaffPage(generator,{companyIds:[b.companyId],page:parsePageQuery({size:'all'})})).rows).toEqual(generatorOld);
 expect(generatorOld.length).toBeGreaterThan(0);
 await expect(listLetterRequestsForStaffPage(generator,{companyIds:[b.companyId,companies[1]],page:parsePageQuery()})).rejects.toMatchObject({code:'permission'});
 const foreign=await seedBase();
 await expect(listLetterRequestsForStaffPage(adminCtx(foreign),{companyIds:[b.companyId],page:parsePageQuery()})).rejects.toMatchObject({code:'permission'});
 // Close a native template: the request stays readable but cannot start generation from an unpublished root.
 await owner.db.update(s.letterTemplate).set({deactivated:true}).where(eq(s.letterTemplate.id,templates.get(b.companyId)![0]));
 const unavailable=await listLetterRequestsForStaff(ctx,{companyId:b.companyId});
 expect(unavailable.filter(row=>row.templateId===templates.get(b.companyId)![0]).every(row=>row.publishedVersionId===null)).toBe(true);
 expect((await listLetterRequestsForStaffPage(ctx,{companyIds:[b.companyId],page:parsePageQuery({size:'all'})})).rows).toEqual(unavailable);
 // Exceed the previous50/company ceiling; derive continuation identities independently from inserted rows.
 const extra=await saveLetterTemplate(ctx,{companyId:b.companyId,code:'LATER',name:'Fictional later queue letter',category:'confirmation',effectiveFrom:todayInKualaLumpur(),document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'Fictional continuation'}]}]},fieldVersionIds:[]});
 await decideLetterTemplate(ctx,{versionId:extra.versionId,expectedStatus:'draft',action:'submit'});
 await decideLetterTemplate(reviewer,{versionId:extra.versionId,expectedStatus:'submitted',action:'approve'});
 await saveLetterRequestOptions(ctx,{companyId:b.companyId,changes:[{templateId:extra.templateId,requestable:true}]});
 const added=await owner.db.insert(s.letterRequest).values(members.filter(m=>m.companyId===b.companyId).slice(0,10).map(m=>({tenantId:b.tenantId,companyId:b.companyId,employmentId:m.employmentId,requestedBy:m.userId,templateId:extra.templateId,letterTypeName:'Trigger owns name'}))).returning({id:s.letterRequest.id,createdAt:s.letterRequest.createdAt});
 const expected=[...unavailable,...added].sort((a,b)=>a.createdAt.getTime()-b.createdAt.getTime()||a.id.localeCompare(b.id)).map(row=>row.id);
 expect(expected).toHaveLength(55);expect(await listLetterRequestsForStaff(ctx,{companyId:b.companyId})).toHaveLength(50);
 const later=await listLetterRequestsForStaffPage(ctx,{companyIds:[b.companyId],page:parsePageQuery({page:'2'})});
 expect(later.state.total).toBe(55);expect(later.rows.map(row=>row.id)).toEqual(expected.slice(50));
 await expect(listLetterRequestsForStaffPage(ctx,{companyIds:['invalid'],page:parsePageQuery()})).rejects.toMatchObject({code:'invalid'});
 await expect(listLetterRequestsForStaffPage(ctx,{companyIds:companies,statuses:[],page:parsePageQuery()})).rejects.toMatchObject({code:'invalid'});
 // 210 templates use their full native approval lifecycle; every-role group oracle needs headroom.
},600000);

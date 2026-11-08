/** Fictional native Allowances PAGE contracts, authored UNRUN. No provider or grant execution authority. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {previewBulkAssistantAccess,previewBulkAssistantAccessPage,previewBulkAssistantAccessPageTx,bulkAssistantDepartments,bulkAssistantDepartmentsPage,bulkAssistantDepartmentsPageTx,setAssistantPermission,type BulkAssistantScope} from '../core/ai-management';
import {setLabelCriteria} from '../core/system-labels';
import {pgSqlState} from '../lib/db-error';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {anthropicAdapter} from '../lib/ai/providers/anthropic';
import {googleAdapter} from '../lib/ai/providers/google';
import {gatewayAdapter} from '../lib/ai/providers/gateway';
import {openrouterAdapter} from '../lib/ai/providers/openrouter';
import type {AiAdapter} from '../lib/ai/types';
import {observeNativeRead} from './helpers/native-read-observer';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,group:SessionContext;
const egress=vi.fn();
beforeAll(migrateTestDb);
beforeEach(async()=>{
 egress.mockClear();const forbidden=async()=>{egress();throw new Error('No external transport belongs to an Allowances display.');};
 for(const adapter of [openaiAdapter,anthropicAdapter,googleAdapter,gatewayAdapter,openrouterAdapter] as AiAdapter[]){
  vi.spyOn(adapter,'generate').mockImplementation(forbidden);vi.spyOn(adapter,'validate').mockImplementation(forbidden);
  if(adapter.converse)vi.spyOn(adapter,'converse').mockImplementation(forbidden);if(adapter.readImage)vi.spyOn(adapter,'readImage').mockImplementation(forbidden);
 }
 vi.stubGlobal('fetch',forbidden);await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');group={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
});
afterEach(()=>{expect(egress).not.toHaveBeenCalled();vi.restoreAllMocks();vi.unstubAllGlobals();});afterAll(closeAll);

async function dates(){
 const [d]=await owner.client<{today:string;yesterday:string;tomorrow:string}[]>`select (now() at time zone 'Asia/Kuala_Lumpur')::date::text as today,((now() at time zone 'Asia/Kuala_Lumpur')::date-1)::text as yesterday,((now() at time zone 'Asia/Kuala_Lumpur')::date+1)::text as tomorrow`;
 for(const value of [d.today,d.yesterday,d.tomorrow])expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
 return d;
}
async function login(name:string,p:Readonly<{role?:'employee'|'manager';departmentId?:string;assignmentCompany?:string|null;validFrom?:string;validTo?:string|null;superseded?:boolean;archived?:boolean;terminatedOn?:string|null}>={}){
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:name,primaryEmail:randomUUID()+'@allowances.invalid'}).returning();
 const [employment]=await owner.db.insert(s.employment).values({tenantId:b.tenantId,personId:person.id,companyId:b.companyId,hiredOn:'2020-01-01',terminatedOn:p.terminatedOn??null}).returning();
 const [assignment]=await owner.db.insert(s.assignment).values({tenantId:b.tenantId,employmentId:employment.id,companyId:p.assignmentCompany===undefined?b.companyId:p.assignmentCompany,
  departmentId:p.departmentId??b.deptA,employmentType:'full_time',validFrom:p.validFrom??'2020-01-01',validTo:p.validTo??null,supersededAt:p.superseded?new Date():null}).returning();
 const userId=await createAppUser(b.tenantId,person.id,p.role??'employee');
 await owner.db.update(s.appUser).set({workosUserId:'allowance-'+randomUUID(),...(p.archived?{archivedAt:new Date()}:{})}).where(eq(s.appUser.id,userId));
 return {userId,personId:person.id,employmentId:employment.id,assignmentId:assignment.id};
}
async function roster(){
 const d=await dates(),[other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Zed Allowances Company'}).returning();
 await setLabelCriteria(group,{kind:'department',labelId:b.deptB,isGlobal:false,companyIds:[b.companyId,other.id]});
 const criteria=await owner.client<{isGlobal:boolean;companyIds:string[]}[]>`select d.is_global as "isGlobal",array(select lca.company_id::text from public.label_company_assignment lca where lca.tenant_id=d.tenant_id and lca.label_kind='department' and lca.label_id=d.id order by lca.company_id) as "companyIds" from public.department d where d.tenant_id=${b.tenantId}::uuid and d.id=${b.deptB}::uuid`;
 expect(criteria).toEqual([{isGlobal:false,companyIds:[b.companyId,other.id].sort()}]);
 const a=await login('Needle%token Needle_token Needle\\token 公司',{assignmentCompany:null,validTo:d.today});
 const m=await login('NeedleXtoken',{role:'manager'}),c=await login('Fictional other assignment company',{departmentId:b.deptB,assignmentCompany:other.id});
 const assigned=await owner.client<{companyId:string;departmentId:string}[]>`select coalesce(a.company_id,e.company_id)::text as "companyId",a.department_id::text as "departmentId" from public.assignment a join public.employment e on e.id=a.employment_id and e.tenant_id=a.tenant_id where a.tenant_id=${b.tenantId}::uuid and a.id=${c.assignmentId}::uuid and e.id=${c.employmentId}::uuid`;
 expect(assigned).toEqual([{companyId:other.id,departmentId:b.deptB}]);
 const expired=await login('Fictional expired assignment',{validTo:d.yesterday}),superseded=await login('Fictional superseded assignment',{superseded:true});
 const future=await login('Fictional future assignment',{validFrom:d.tomorrow}),archived=await login('Fictional archived login',{archived:true});
 const blocked=await login('Fictional login-blocked person',{terminatedOn:d.yesterday});
 // A second legal employment for one Person cannot multiply the outer app_user EXISTS result.
 const [second]=await owner.db.insert(s.employment).values({tenantId:b.tenantId,personId:m.personId,companyId:b.companyId,hiredOn:'2020-01-01'}).returning();
 await owner.db.insert(s.assignment).values({tenantId:b.tenantId,employmentId:second.id,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',validFrom:'2020-01-01'});
 await setAssistantPermission(group,a.userId,true);
 await owner.db.insert(s.assistantGrant).values({tenantId:b.tenantId,appUserId:m.userId,grantedByUserId:group.userId!,revokedAt:new Date()});
 return {a,m,c,expired,superseded,future,archived,blocked,other,d};
}
async function facts(){
 return {users:await owner.db.select().from(s.appUser).orderBy(s.appUser.id),grants:await owner.db.select().from(s.assistantGrant).orderBy(s.assistantGrant.id),events:await owner.db.select().from(s.domainEvent).orderBy(s.domainEvent.id)};
}

it('preserves all five scope rules, independent live-changing counts and legacy preview parity',async()=>{
 const r=await roster(),foreign=await seedBase();
 const scopes:[BulkAssistantScope,number,number][]=[
  [{kind:'company',companyId:b.companyId},2,1],
  [{kind:'company',companyId:r.other.id},1,1],
  [{kind:'department',departmentId:b.deptA},2,1],
  [{kind:'department',departmentId:b.deptB},1,1],
  [{kind:'role',role:'manager'},1,1],
  [{kind:'role',role:'employee'},5,4],
  [{kind:'users',userIds:[r.a.userId,r.a.userId,r.m.userId,r.c.userId,foreign.adminUserId]},3,2],
  [{kind:'search',q:'  公司  '},1,0],
 ];
 for(const [scope,matched,changing]of scopes){
  expect(await previewBulkAssistantAccessPage(group,scope,true)).toEqual({matched,changing});
  expect(await previewBulkAssistantAccessPage(group,scope,false)).toEqual({matched,changing:matched-changing});
  expect(await previewBulkAssistantAccessPage(group,scope,true)).toEqual(await previewBulkAssistantAccess(group,scope,true));
 }
 expect(await previewBulkAssistantAccessPage(group,{kind:'company',companyId:foreign.companyId},true)).toEqual({matched:0,changing:0});
 expect(await previewBulkAssistantAccessPage(group,{kind:'users',userIds:[r.archived.userId,r.blocked.userId]},true)).toEqual({matched:0,changing:0});
});

it('escapes literal Unicode, percent, underscore and backslash needles rather than treating them as wildcard syntax',async()=>{
 await roster();
 for(const q of ['Needle%token','Needle_token','Needle\\token','  公司  '])expect(await previewBulkAssistantAccessPage(group,{kind:'search',q},true)).toEqual({matched:1,changing:0});
 expect(await previewBulkAssistantAccessPage(group,{kind:'search',q:'Unmatched needle'},false)).toEqual({matched:0,changing:0});
 const bare=await createAppUser(b.tenantId,null,'employee');await owner.db.update(s.appUser).set({workosUserId:'登录%_\\登录'}).where(eq(s.appUser.id,bare));
 expect(await previewBulkAssistantAccessPage(group,{kind:'search',q:'登录%_\\登录'},true)).toEqual({matched:1,changing:1});
 const long='L'.repeat(100);await login(long+' suffix');expect(await previewBulkAssistantAccessPage(group,{kind:'search',q:'  '+long+'ignored suffix  '},true)).toEqual({matched:1,changing:1});
});

it('captures mutable principal and deduplicated scope before its first suspension',async()=>{
 const r=await roster(),ctx={...group,roles:group.roles?.slice(),grants:group.grants?.map(g=>({...g}))},scope={kind:'users',userIds:[r.a.userId,r.a.userId,r.m.userId]},probe=observeNativeRead();
 try{
  const pending=previewBulkAssistantAccessPage(ctx,scope,true);ctx.userId=randomUUID();ctx.roles?.splice(0,ctx.roles.length,'employee');ctx.grants?.splice(0,ctx.grants.length,{role:'employee',companyId:null});scope.userIds.splice(0,scope.userIds.length,randomUUID());
  expect(await pending).toEqual({matched:2,changing:1});
  const target=probe.queries.find(q=>q.sql.includes('select u.id,')&&q.sql.includes('order by u.id'))!;expect(target).toBeTruthy();expect(target.params.filter(v=>v===r.a.userId)).toHaveLength(1);
  await database.withTenant(group,async tx=>{
   const supplied={...group,roles:group.roles?.slice(),grants:group.grants?.map(g=>({...g}))},selection={kind:'users',userIds:[r.a.userId,r.a.userId,r.m.userId]};
   const borrowed=previewBulkAssistantAccessPageTx(tx,supplied,selection,true);supplied.roles?.splice(0,supplied.roles.length,'employee');supplied.grants?.splice(0,supplied.grants.length,{role:'employee',companyId:null});selection.userIds.length=0;
   expect(await borrowed).toEqual({matched:2,changing:1});
  },{readOnlySnapshot:true});
 }finally{probe.restore();}
});

it('keeps exact department labels, company grouping, UUID ties and foreign/archive exclusion',async()=>{
 await owner.db.update(s.department).set({label:'  Display Finance  '}).where(eq(s.department.id,b.deptA));await owner.db.update(s.department).set({label:'   '}).where(eq(s.department.id,b.deptB));
 const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Zed Allowances Company'}).returning();
 const ties=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'];
 await owner.db.insert(s.department).values(ties.slice().reverse().map(id=>({id,tenantId:b.tenantId,companyId:b.companyId,name:'Unused tie name',label:'A Same'})));
 const [z]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:other.id,name:'Alpha'}).returning();
 await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:b.companyId,name:'Archived',archivedAt:new Date()});await seedBase();
 const expected=[...ties.map(id=>({id,label:'A Same · Acme Sdn Bhd'})),{id:b.deptA,label:'Display Finance · Acme Sdn Bhd'},{id:b.deptB,label:'Operations · Acme Sdn Bhd'},{id:z.id,label:'Alpha · Zed Allowances Company'}];
 expect(await bulkAssistantDepartmentsPage(group)).toEqual(expected);expect(await bulkAssistantDepartments(group)).toEqual(expected);
});

it('retains the actual500 department ceiling with deterministic order and unchanged legacy choices',async()=>{
 const rows=Array.from({length:505},(_,i)=>({id:randomUUID(),tenantId:b.tenantId,companyId:b.companyId,name:'Dept '+String(i).padStart(3,'0')}));await owner.db.insert(s.department).values(rows);
 const expected=rows.slice(0,500).map(r=>({id:r.id,label:r.name+' · Acme Sdn Bhd'}));expect(await bulkAssistantDepartmentsPage(group)).toEqual(expected);expect(await bulkAssistantDepartments(group)).toEqual(expected);
});

it('owns real app RRRO reads without Assistant/module/provider gating, target DML or external transport',async()=>{
 const r=await roster();await setModule(b.tenantId,'assistant',null);const supplied={...group,entitlements:undefined,entitlementsError:'Fictional earlier module resolution failure'},before=await facts(),probe=observeNativeRead();
 try{
  expect(await previewBulkAssistantAccessPage(supplied,{kind:'users',userIds:[r.a.userId,r.m.userId]},true)).toEqual({matched:2,changing:1});expect(await bulkAssistantDepartmentsPage(supplied)).toHaveLength(2);
  expect(probe.properties).toHaveLength(2);for(const p of probe.properties)expect(p).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readOnly:true});expect(probe.state).toEqual({active:0,maxActive:1});
  for(const q of probe.queries)expect(q.sql).not.toMatch(/\b(insert|update|delete|ai_active_provider|ai_spend|ai_admit|assert_running)\b/i);
 }finally{probe.restore();}
 expect(await facts()).toEqual(before);expect(supplied.entitlementsError).toBe('Fictional earlier module resolution failure');
});

it.each([['read committed','read write'],['read committed','read only'],['repeatable read','read write']] as const)('refuses actual %s / %s native carriers before target facts',async(isolation,access)=>{
 for(const read of [(tx:Tx)=>previewBulkAssistantAccessPageTx(tx,group,{kind:'role',role:'employee'},true),(tx:Tx)=>bulkAssistantDepartmentsPageTx(tx,group)]){
  await expect(database.db.transaction(async tx=>{
   await tx.execute(sql`select set_config('app.tenant_id',${group.tenantId},true),set_config('app.user_id',${group.userId!},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify(group.grants)},true),set_config('app.agent_principal_id','',true)`);
   const [identity]=await tx.execute<{role:string}>(sql`select current_user as role`);expect(identity.role).toBe('ai_hr_app');return read(tx);
  },{isolationLevel:isolation,accessMode:access})).rejects.toThrow('Current AI calling authority');
 }
});

it('refuses company, employee, foreign, revoked, agent and synthetic principals without substituting session claims',async()=>{
 const companyUser=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,companyUser));
 const companyCtx:SessionContext={...group,userId:companyUser,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const [nativeGroup]=await database.withTenant(companyCtx,tx=>tx.execute<{allowed:boolean}>(sql`select app.is_group_admin() as allowed`),{readOnlySnapshot:true});expect(nativeGroup.allowed).toBe(false);
 const employee=await createAppUser(b.tenantId,null,'employee'),foreign=await seedBase();
 const refused:SessionContext[]=[companyCtx,{...group,userId:employee,roles:['employee'],grants:[{role:'employee',companyId:null}]},
  {...group,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]},{...group,personId:randomUUID()},
  {...group,agent:{principalId:randomUUID(),enablements:[]}},{...group,entitlementsExempt:'seeding'},
  {...group,statutoryOverride:'Fictional forbidden marker'}];
 for(const ctx of refused)for(const read of [()=>previewBulkAssistantAccessPage(ctx,{kind:'role',role:'employee'},true),()=>bulkAssistantDepartmentsPage(ctx)])await expect(read()).rejects.toThrow();
 for(const read of [(tx:Tx)=>previewBulkAssistantAccessPageTx(tx,adminCtx(foreign),{kind:'role',role:'employee'},true),(tx:Tx)=>bulkAssistantDepartmentsPageTx(tx,adminCtx(foreign))])await expect(database.withTenant(group,read,{readOnlySnapshot:true})).rejects.toThrow('Current AI calling authority');
 await createAppUser(b.tenantId,null,'hr_admin');await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,group.userId!));
 await expect(previewBulkAssistantAccessPage(group,{kind:'role',role:'employee'},true)).rejects.toThrow('Current AI calling authority');await expect(bulkAssistantDepartmentsPage(group)).rejects.toThrow('Current AI calling authority');
});

it('rejects malformed scopes/actions before opening the public snapshot',async()=>{
 const probe=observeNativeRead();try{
  for(const scope of [{kind:'role',role:'operator'},{kind:'company',companyId:'wrong'},{kind:'users',userIds:[]},{kind:'users',userIds:[randomUUID(),'wrong']},{kind:'search',q:'  '},{kind:'everyone'}])await expect(previewBulkAssistantAccessPage(group,scope,true)).rejects.toThrow('Choose who');
  await expect(previewBulkAssistantAccessPage(group,{kind:'role',role:'employee'},'yes' as unknown as boolean)).rejects.toThrow('Choose grant');expect(probe.properties).toEqual([]);
 }finally{probe.restore();}
});

it.each(['commit','rollback'] as const)('finishes both PAGE readers behind held Access revocation and respects its %s',async settlement=>{
 await roster();await createAppUser(b.tenantId,null,'hr_admin');const rollback=new Error('Fictional held Access rollback');let open=false;
 try{
  await owner.client.begin(async holder=>{
   await holder`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${group.userId!},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify(group.grants)},true),set_config('app.agent_principal_id','',true)`;
   await holder`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
   await holder`update role_assignment set company_id=${b.companyId}::uuid where app_user_id=${group.userId!}::uuid and role='hr_admin'`;
   const [h]=await holder<{pid:number}[]>`select pg_backend_pid() as pid`;open=true;
   const actual=database.withTenant,proofs:{readerAdvisory:number;holderAdvisory:number;blocked:number[]}[]=[];
   const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(ctx,async tx=>{
    await tx.execute(sql`set local lock_timeout='300ms'`);const result=await read(tx);
    const [p]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);
    const [state]=await owner.client<{readerAdvisory:number;holderAdvisory:number;blocked:number[]}[]>`select (select count(*)::int from pg_locks where pid=${p.pid} and locktype='advisory')as "readerAdvisory",(select count(*)::int from pg_locks where pid=${h.pid} and locktype='advisory' and granted)as "holderAdvisory",pg_blocking_pids(${p.pid}::int)as blocked`;
    expect(open).toBe(true);proofs.push(state);return result;
   },options));
   try{expect(await previewBulkAssistantAccessPage(group,{kind:'company',companyId:b.companyId},true)).toEqual({matched:2,changing:1});expect(await bulkAssistantDepartmentsPage(group)).toHaveLength(2);}
   finally{spy.mockRestore();open=false;}
   expect(proofs).toHaveLength(2);for(const p of proofs){expect(p.readerAdvisory).toBe(0);expect(p.holderAdvisory).toBeGreaterThan(0);expect(p.blocked).toEqual([]);}if(settlement==='rollback')throw rollback;
  });
 }catch(error){if(error!==rollback)throw error;}
 if(settlement==='commit'){await expect(previewBulkAssistantAccessPage(group,{kind:'company',companyId:b.companyId},true)).rejects.toThrow();await expect(bulkAssistantDepartmentsPage(group)).rejects.toThrow();}
 else{expect(await previewBulkAssistantAccessPage(group,{kind:'company',companyId:b.companyId},true)).toEqual({matched:2,changing:1});expect(await bulkAssistantDepartmentsPage(group)).toHaveLength(2);}
});

it('keeps its admitted snapshot after a committed revocation but refuses the next snapshot',async()=>{
 await createAppUser(b.tenantId,null,'hr_admin');
 await database.withTenant(group,async tx=>{
  expect(await previewBulkAssistantAccessPageTx(tx,group,{kind:'role',role:'employee'},true)).toEqual({matched:0,changing:0});
  await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,group.userId!));expect(await bulkAssistantDepartmentsPageTx(tx,group)).toHaveLength(2);
 },{readOnlySnapshot:true});
 await expect(bulkAssistantDepartmentsPage(group)).rejects.toThrow('Current AI calling authority');
});

it.each(['preview','departments'] as const)('propagates genuine %s source SQL lock failure and settles rollback before recovery',async purpose=>{
 let error:unknown;
 await owner.client.begin(async holder=>{
  if(purpose==='preview')await holder`lock table public.assistant_grant in access exclusive mode`;else await holder`lock table public.department in access exclusive mode`;
  error=await database.withTenant(group,async tx=>{await tx.execute(sql`set local lock_timeout='300ms'`);return purpose==='preview'?previewBulkAssistantAccessPageTx(tx,group,{kind:'role',role:'employee'},true):bulkAssistantDepartmentsPageTx(tx,group);},{readOnlySnapshot:true}).then(()=>null,(failure:unknown)=>failure);
  expect(pgSqlState(error)).toBe('55P03');
  expect((error as {query?:unknown}|null)?.query).toEqual(expect.stringContaining(purpose==='preview'?'select u.id,':'from public.department d'));
 });
 expect(await previewBulkAssistantAccessPage(group,{kind:'role',role:'employee'},true)).toEqual({matched:0,changing:0});expect(await bulkAssistantDepartmentsPage(group)).toHaveLength(2);
});

it('enforces native read-only mode and settles an actual cancellation before a new authorized PAGE read',async()=>{
 const before=await facts();
 const write=await database.withTenant(group,async tx=>{await bulkAssistantDepartmentsPageTx(tx,group);await tx.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,group.userId!));},{readOnlySnapshot:true}).then(()=>null,(e:unknown)=>e);expect(pgSqlState(write)).toBe('25006');
 const cancel=await database.withTenant(group,async tx=>{await previewBulkAssistantAccessPageTx(tx,group,{kind:'role',role:'employee'},true);await tx.execute(sql`set local statement_timeout='25ms'`);await tx.execute(sql`select pg_sleep(0.1)`);},{readOnlySnapshot:true}).then(()=>null,(e:unknown)=>e);expect(pgSqlState(cancel)).toBe('57014');
 expect(await bulkAssistantDepartmentsPage(group)).toHaveLength(2);expect(await facts()).toEqual(before);
});

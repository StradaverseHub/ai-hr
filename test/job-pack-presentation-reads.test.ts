/** Native pack presentation boundaries only. Architecture routes/workflows remain retired (2300).
 * No provider, schema, policy or effect authority is added by these display transactions. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {appUser,person,roleAssignment,company} from '../db/schema';
import {DEFAULT_FORM,attachJobDocument,configureJobForm,downloadJobAttachment,getJobDocumentPage,getJobForm,getJobMasters,listJobDocuments,readJobDocument,saveJobDraft,type JobInput} from '../packs/job-descriptions/service';
import {architecturePeople,architectureSeatList,architectureWorkspace,canViewJobArchitecture,approvedPositionArchitecture,architectureAdviceForDraft} from '../packs/job-architecture/service';

let b:Base,ctx:SessionContext,saved:{jobId:string;revisionId:string},attachmentId:string,seatId:string;
const input=():JobInput=>({companyId:b.companyId,jobCode:'SNAPSHOT-001',title:'Fictional snapshot analyst',owner:'Finance owner',org:{department:b.deptA,position:b.positionId},answers:{purpose:[{purpose:'Independently known display evidence'}]},effectiveOn:'2026-01-01',reviewOn:'2026-12-01',reason:'Fictional test fixture',reviewerIds:[],approverId:''});
async function principal(role:'hr_admin'|'employee'='hr_admin',companyId:string|null=null):Promise<SessionContext>{
 const[p]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Fictional pack reader',primaryEmail:randomUUID()+'@example.invalid'}).returning();
 const[u]=await owner.db.insert(appUser).values({tenantId:b.tenantId,personId:p.id,workosUserId:randomUUID()}).returning();
 await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,role,companyId});
 return{...adminCtx(b),userId:u.id,personId:p.id,roles:[role],grants:[{role,companyId}]};
}
/** Every admitted root, including the compatibility list alias, is exercised independently. */
const roots=(current=ctx)=>[
 ()=>getJobMasters(current),()=>getJobForm(current,b.companyId),()=>readJobDocument(current,saved.jobId),
 ()=>getJobDocumentPage(current,{q:'SNAPSHOT-',company:b.companyId}),()=>listJobDocuments(current,{company:b.companyId}),
 ()=>downloadJobAttachment(current,attachmentId),()=>architectureWorkspace(current,b.companyId),
 ()=>architecturePeople(current),()=>architectureSeatList(current),()=>canViewJobArchitecture(current),
];
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 // Match the existing document suite's explicit legacy Workforce fixture mode.
 await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in('workforce.view','workforce.maintain')`);
 ctx=await principal();saved=await saveJobDraft(ctx,input());
 const form=structuredClone(DEFAULT_FORM);form.version=2;form.sections[0].label='Snapshot fixture form';
 await configureJobForm(ctx,b.companyId,1,form);
 const attached=await attachJobDocument(ctx,{jobId:saved.jobId,revisionId:saved.revisionId,lockVersion:1,name:'snapshot.txt',type:'text/plain',bytes:Buffer.from('Known attachment bytes')});attachmentId=attached.id;
 const[seat]=await owner.client<{id:string}[]>`insert into job_architecture_seat(tenant_id,user_id,company_id,role,valid_from,created_by) values(${b.tenantId},${ctx.userId!},${b.companyId},'pbp','2020-01-01',${b.adminUserId}) returning id`;seatId=seat.id;
});

it('all admitted display roots finish against known records while a real exclusive Access writer and command overlap',async()=>{
 const before=await owner.client`select id from domain_event where tenant_id=${b.tenantId} order by id`;
 const actual=database.withTenant,modes:{isolation:string;readOnly:boolean}[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{
  if(options?.readOnlySnapshot){await tx.execute(sql`set local lock_timeout='400ms'`);await tx.execute(sql`set local statement_timeout='4s'`);}
  const result=await read(tx);
  if(options?.readOnlySnapshot){const[mode]=await tx.execute<{isolation:string;readOnly:boolean}>(sql`select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only')='on' as "readOnly"`);modes.push(mode);}
  return result;
 },options));
 let ready!:()=>void,release!:()=>void;
 const started=new Promise<void>(yes=>{ready=yes;}),held=new Promise<void>(yes=>{release=yes;});
 const writer=owner.client.begin(async tx=>{
  await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  // The native role writer also joins this barrier. Readers must see its precommit principal.
  await tx`delete from role_assignment where tenant_id=${b.tenantId} and app_user_id=${ctx.userId!}`;
  ready();await held;
 });void writer.catch(()=>{});
 let command:ReturnType<typeof saveJobDraft>|undefined,reads:Promise<unknown>[]=[],settled=false;
 const watchdog=setTimeout(release,10000);
 try{
  await Promise.race([started,writer.then(()=>{throw Error('Access writer ended before its ready signal');})]);
  command=saveJobDraft(ctx,{...input(),title:'Must not commit after role revocation'},{...saved,lockVersion:2});
  void command.then(()=>{settled=true;},()=>{settled=true;});
  const pending=roots().map(read=>read());reads=[...pending];
  const outcomes=await Promise.allSettled(pending);
  expect(outcomes.map(v=>v.status)).toEqual(Array(10).fill('fulfilled'));
  const values=outcomes.map(v=>{if(v.status!=='fulfilled')throw v.reason;return v.value;});
  expect(values[0]).toMatchObject({companies:[{value:b.companyId,label:'Acme Sdn Bhd'}]});
  expect(values[1]).toMatchObject({version:2,sections:[expect.objectContaining({label:'Snapshot fixture form'}),...DEFAULT_FORM.sections.slice(1)]});
  expect(values[2]).toMatchObject({job:{id:saved.jobId,job_code:'SNAPSHOT-001'},revision:{title:'Fictional snapshot analyst',answers:{purpose:[{purpose:'Independently known display evidence'}]}},attachments:[{id:attachmentId,filename:'snapshot.txt'}]});
  expect(values[3]).toMatchObject({total:1,page:1,pageSize:50,rows:[{id:saved.jobId}]});
  expect(values[4]).toMatchObject([{id:saved.jobId}]);
  expect(values[5]).toEqual({filename:'snapshot.txt',mimeType:'text/plain',bytes:Buffer.from('Known attachment bytes')});
  expect(values[6]).toMatchObject({companies:[{id:b.companyId,name:'Acme Sdn Bhd'}],positions:[{id:b.positionId,title:'Executive',companyId:b.companyId}]});
  expect(values[7]).toContainEqual({id:ctx.userId,name:'Fictional pack reader'});
  expect(values[8]).toMatchObject([{id:seatId,user_id:ctx.userId,company_id:b.companyId,role:'pbp'}]);expect(values[9]).toBe(true);
  expect(modes).toHaveLength(10);for(const mode of modes)expect(mode).toEqual({isolation:'repeatable read',readOnly:true});
  const[waiting]=await owner.client<{yes:boolean}[]>`select exists(select 1 from pg_locks l where l.locktype='advisory' and not l.granted and l.objsubid=1 and l.database=(select oid from pg_database where datname=current_database()) and ((l.classid::bigint<<32)|l.objid::bigint)=hashtextextended(${'access-configuration:'+b.tenantId},0)) as yes`;
  expect(waiting.yes).toBe(true);expect(settled).toBe(false);
  expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId} order by id`).toEqual(before);
 }finally{release();clearTimeout(watchdog);await Promise.allSettled([writer,...reads,...(command?[command]:[])]);spy.mockRestore();}
 await expect(command).rejects.toThrow(/not available/);
 expect((await readJobDocument(adminCtx(b),saved.jobId)).revision.title).toBe('Fictional snapshot analyst');
 for(const read of roots())await expect(read()).rejects.toThrow();
},20000);

it('every display root owns a database-enforced read-only transaction that rejects an actual write with SQLSTATE 25006',async()=>{
 const actual=database.withTenant;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{
  const result=await read(tx);
  // UPDATE privileges exist here and the WHERE matches a real row; failure must be native read-only.
  await tx.execute(sql`update job_document set updated_at=now() where id=${saved.jobId}::uuid`);return result;
 },options));
 try{for(const read of roots())expect(await read().then(()=>null,pgSqlState)).toBe('25006');}finally{spy.mockRestore();}
});

it('refuses forged roles, wrong login/person/tenant and synthetic effect contexts at every display root',async()=>{
 const forged:SessionContext[]=[
  {...ctx,userId:randomUUID()}, {...ctx,tenantId:randomUUID()}, {...ctx,personId:randomUUID()},
  {...ctx,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]},
  {...ctx,statutoryOverride:'Presentation may not borrow effect authority'},
 ];
 for(const current of forged)for(const read of roots(current))await expect(read()).rejects.toThrow();
 await owner.client`update app_user set archived_at=now() where id=${ctx.userId!}`;
 for(const read of roots())await expect(read()).rejects.toThrow();
});

it('retains company and current-seat boundaries without promoting login proof into module authority',async()=>{
 const[other]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Hidden fixture company'}).returning();
 const narrow=await principal('hr_admin',other.id);
 expect(await listJobDocuments(narrow)).toEqual([]);expect((await getJobDocumentPage(narrow)).total).toBe(0);
 expect((await getJobMasters(narrow)).companies.map(v=>v.value)).toEqual([other.id]);
 await expect(getJobForm(narrow,b.companyId)).rejects.toThrow();await expect(readJobDocument(narrow,saved.jobId)).rejects.toThrow();await expect(downloadJobAttachment(narrow,attachmentId)).rejects.toThrow();
 expect((await architectureWorkspace(narrow)).companies.map(v=>v.id)).toEqual([other.id]);
 expect((await architectureWorkspace(narrow,b.companyId)).positions).toEqual([]);await expect(architectureSeatList(narrow)).rejects.toThrow();
 const employee=await principal('employee',b.companyId);
 expect(await canViewJobArchitecture(employee)).toBe(false);await expect(architectureWorkspace(employee)).rejects.toThrow();await expect(architecturePeople(employee)).rejects.toThrow();
 await owner.client`insert into job_architecture_seat(tenant_id,user_id,company_id,role,valid_from,valid_to,created_by) values(${b.tenantId},${employee.userId!},${b.companyId},'pbp','2020-01-01',null,${b.adminUserId})`;
 expect(await canViewJobArchitecture(employee)).toBe(true);expect((await architectureWorkspace(employee)).companies.map(v=>v.id)).toEqual([b.companyId]);
 await expect(architectureSeatList(employee)).rejects.toThrow();
 await owner.client`update job_architecture_seat set valid_to='2020-01-02' where user_id=${employee.userId!}`;
 expect(await canViewJobArchitecture(employee)).toBe(false);await expect(architectureWorkspace(employee)).rejects.toThrow();await expect(architecturePeople(employee)).rejects.toThrow();
});

it('captures mutable session grants and list filters before waiting for native data access',async()=>{
 const supplied=structuredClone(ctx),filters={q:'SNAPSHOT-',company:b.companyId};
 const reading=getJobDocumentPage(supplied,filters);
 supplied.tenantId=randomUUID();supplied.userId=randomUUID();supplied.personId=randomUUID();supplied.roles!.push('super_admin');supplied.grants![0].companyId=randomUUID();filters.q='does not exist';filters.company=randomUUID();
 expect(await reading).toMatchObject({total:1,rows:[{id:saved.jobId}]});
 const architectureCtx=structuredClone(ctx),workspace=architectureWorkspace(architectureCtx,b.companyId);
 architectureCtx.tenantId=randomUUID();architectureCtx.grants![0].role='super_admin';
 expect(await workspace).toMatchObject({positions:[{id:b.positionId,title:'Executive'}]});
});

it('retains the Access barrier on the two borrowed command/source read contracts',async()=>{
 const actual=database.withTenant;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{await tx.execute(sql`set local lock_timeout='300ms'`);return read(tx);},options));
 try{await owner.client.begin(async tx=>{
  await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  expect(await approvedPositionArchitecture(ctx,{companyId:b.companyId,positionId:b.positionId}).then(()=>null,pgSqlState)).toBe('55P03');
  expect(await architectureAdviceForDraft(ctx,randomUUID()).then(()=>null,pgSqlState)).toBe('55P03');
 });}finally{spy.mockRestore();}
});

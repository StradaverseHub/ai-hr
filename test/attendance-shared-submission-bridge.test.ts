/** Native component/ownership proof. Final combined populated-prefix rehearsal is separate. */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type postgres from 'postgres';
import {and,eq,inArray,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {checkIn,checkOut,requestAttendanceCorrection} from '../core/attendance';
import {prepareAttendanceWorkflowSnapshotTx,saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../core/attendance-workflow';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const source=readFileSync('db/migrations/3101_attendance_shared_workflow.sql','utf8');
const predecessor=/CREATE OR REPLACE FUNCTION app\.attendance_workflow_links\(\) RETURNS trigger\s+LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS \$\$([\s\S]*?)\$\$;/.exec(source);
if(!predecessor)throw Error('Exact immutable shared-workflow predecessor required');
const definition=predecessor[0],body=predecessor[1];
const legacy=/CREATE OR REPLACE FUNCTION app\.attendance_workflow_links\(\) RETURNS trigger\s+LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS \$\$([\s\S]*?)\$\$;/.exec(readFileSync('db/migrations/0592_attendance_workflow_v4.sql','utf8'));
if(!legacy||createHash('md5').update(legacy[1]).digest('hex')!=='4d4757fe139a597cc028772f0effade9')throw Error('Exact archived nonshared predecessor required');
const expectedBody=body.replace('PERFORM pg_advisory_xact_lock(','PERFORM pg_advisory_xact_lock_shared(');
const bridge=readFileSync('db/migrations/3210_attendance_shared_workflow_submission_lock.sql','utf8');
const target='app.attendance_workflow_links()';
const helperNames=['attendance_workflow_companies','attendance_workflow_applies','attendance_workflow_all_companies_admin','attendance_selected_approver_eligible','attendance_workflow_v3_approver_options'];
type Native=Pick<typeof owner.client,'unsafe'>;
let functionIds:number[]=[];
const catalogue=async(connection:Native)=>{
 const [row]=await connection.unsafe<{value:unknown}[]>(`select jsonb_build_object(
  'functions',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_proc p where p.oid=any($1::oid[])),
  'bindings',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t where t.tgfoid='app.attendance_workflow_links()'::regprocedure),
  'request',(select jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'kind',c.relkind) from pg_class c where c.oid='public.attendance_workflow_request'::regclass)) as value`,[functionIds]);
 return row.value;
};
const quote=(name:string)=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw Error('Owned SQL identity required');return '"'+name+'"';};
const rollback=new Error('Rollback only this native bridge control');
async function rolledBack(work:(connection:postgres.TransactionSql)=>Promise<void>){
 await expect(owner.client.begin(async connection=>{await work(connection);throw rollback;})).rejects.toBe(rollback);
}
let b:Base,initialDefinition:string|undefined,initialCatalogue:unknown,componentInstalled=false;
beforeAll(async()=>{
 await migrateTestDb();
 expect(createHash('sha256').update(source).digest('hex')).toBe('f32d12965f2788dc673f0c09e128996a653341bbcf6933e47f211da021617169');
 expect(createHash('md5').update(body).digest('hex')).toBe('b383b0524878d7b82c58ec374146f75a');
 const identities=await owner.client.unsafe<{oid:number}[]>(`select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname=any($1::text[]) order by p.oid`,[['attendance_workflow_links',...helperNames]]);
 expect(identities).toHaveLength(6);functionIds=identities.map(row=>row.oid);
 const [current]=await owner.client.unsafe<{definition:string;body:string}[]>(`select pg_get_functiondef(oid) as definition,prosrc as body from pg_proc where oid=$1::regprocedure`,[target]);
 initialDefinition=current.definition;initialCatalogue=await catalogue(owner.client);
 if(current.body===body){await owner.client.unsafe(bridge);componentInstalled=true;}
 else expect(current.body).toBe(expectedBody); // Actual combined migration already installed: no duplicate installer.
});
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(async()=>{try{if(componentInstalled&&initialDefinition){await owner.client.unsafe(initialDefinition);expect(await catalogue(owner.client)).toEqual(initialCatalogue);}}finally{await closeAll();}});

it('changes only the complete native predecessor body and preserves every native catalogue field and binding',async()=>{
 await rolledBack(async connection=>{
  await connection.unsafe(definition);
  const before=await catalogue(connection);
  const [original]=await connection.unsafe<{metadata:Record<string,unknown>}[]>(`select to_jsonb(p)-'prosrc' as metadata from pg_proc p where oid=$1::regprocedure`,[target]);
  await connection.unsafe(bridge);
  const [after]=await connection.unsafe<{body:string;metadata:Record<string,unknown>}[]>(`select prosrc as body,to_jsonb(p)-'prosrc' as metadata from pg_proc p where oid=$1::regprocedure`,[target]);
  expect(after.body).toBe(expectedBody);expect(after.metadata).toEqual(original.metadata);
  const afterCatalogue=await catalogue(connection);expect(afterCatalogue).not.toEqual(before);
  await connection.unsafe(definition);expect(await catalogue(connection)).toEqual(before);
 });
});

const mutations=[
 ['archived nonshared predecessor',legacy[0]],
 ['unknown body',definition.replace('RETURN NEW;','RETURN NEW;\n -- Unreviewed trigger body change')],
 ['volatility','ALTER FUNCTION app.attendance_workflow_links() IMMUTABLE'],
 ['parallel','ALTER FUNCTION app.attendance_workflow_links() PARALLEL SAFE'],
 ['cost','ALTER FUNCTION app.attendance_workflow_links() COST 101'],
 ['configuration','ALTER FUNCTION app.attendance_workflow_links() SET row_security=off'],
 ['extra ACL','GRANT EXECUTE ON FUNCTION app.attendance_workflow_links() TO ai_hr_app'],
 ['unknown function owner','ALTER FUNCTION app.attendance_workflow_links() OWNER TO ai_hr_app'],
 ['disabled request trigger','ALTER TABLE public.attendance_workflow_request DISABLE TRIGGER attendance_workflow_request_links'],
 ['pre-3110 helper','ALTER FUNCTION app.attendance_workflow_applies(uuid,uuid) SET row_security=off'],
 ['changed helper body',`CREATE OR REPLACE FUNCTION app.attendance_workflow_applies(wanted uuid,wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$SELECT false$$`],
 ['missing helper','ALTER FUNCTION app.attendance_workflow_applies(uuid,uuid) RENAME TO attendance_bridge_missing_applies'],
]as const;
it.for(mutations)('refuses %s before changing any native function, relation or trigger catalogue',async([,change])=>{
 await rolledBack(async connection=>{
  await connection.unsafe(definition);await connection.unsafe(change);
  const before=await catalogue(connection);
  await connection.unsafe('SAVEPOINT bridge_attempt');
  let refusal:unknown;
  try{await connection.unsafe(bridge);}catch(error){refusal=error;}
  await connection.unsafe('ROLLBACK TO SAVEPOINT bridge_attempt');
  expect(refusal).toMatchObject({code:'55000'});expect(await catalogue(connection)).toEqual(before);
 });
});

async function fixture(){
 const root=adminCtx(b);
 async function actor(name:string){const hired=await hireEmployee(root,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});const userId=await createAppUser(b.tenantId,hired.personId,'employee');return{...hired,ctx:{...root,userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]}satisfies SessionContext};}
 const worker=await actor('Fictional shared submission'),reviewer=await actor('Fictional frozen reviewer');
 const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional second workflow company'}).returning();
 const template=await saveAttendanceWorkflow(root,{companyId:b.companyId,companyIds:[b.companyId,other.id],applicationType:'irregularity',routingVersion:4,code:'BRIDGE_SHARED',name:'Immutable shared route',priority:1,active:true,criteria:{employeeIds:[worker.employmentId]},stages:[{name:'Level 1',mode:'any_one',sources:[{kind:'specific_employee',employmentIds:[reviewer.employmentId]}],hrAlternative:false}],cc:[]});
 const ids:string[]=[];
 for(let index=0;index<2;index++){
  const date=new Date(todayInKualaLumpur()+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-index);const on=date.toISOString().slice(0,10);
  await checkIn(root,{employmentId:worker.employmentId,date:on,time:'08:00',manual:true});await checkOut(root,{employmentId:worker.employmentId,date:on,time:'17:00',manual:true});
  ids.push((await requestAttendanceCorrection(worker.ctx,{employmentId:worker.employmentId,date:on,checkIn:'09:00',checkOut:'18:00',reason:'Fictional native trigger proof'})).correctionId);
 }
 await setAttendanceWorkflowEnabled(root,b.companyId,'irregularity',true);
 const prepared=await withTenant(worker.ctx,tx=>prepareAttendanceWorkflowSnapshotTx(tx,worker.ctx,worker.employmentId,'irregularity'));
 if(!prepared)throw Error('Nonempty actual canonical workflow snapshot required');
 expect(prepared.selected.id).toBe(template.id);
 expect(await owner.db.select({id:s.attendanceWorkflowRequest.id}).from(s.attendanceWorkflowRequest).where(inArray(s.attendanceWorkflowRequest.correctionId,ids))).toEqual([]);
 const values=(id:string)=>({tenantId:b.tenantId,correctionId:id,employmentId:worker.employmentId,companyId:b.companyId,templateId:prepared.selected.id,templateCode:prepared.selected.code,templateName:prepared.selected.name,templateVersion:prepared.selected.version,applicationType:'irregularity' as const,routingVersion:prepared.validated.routingVersion,stages:prepared.stages,cc:prepared.cc});
 return{root,worker,reviewer,template,other,ids,values,key:b.tenantId+':attendance-workflow:'+b.companyId+':irregularity'};
}
const gate=()=>{let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve;});return{promise,open};};
async function within<T>(promise:Promise<T>,milliseconds:number){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Actual native lock proof deadline')),milliseconds);})]);}finally{clearTimeout(timer);}}

it('admits two overlapping native app submissions while the actual configuration writer waits for their shared barrier',async()=>{
 const f=await fixture(),release=gate(),entered=[gate(),gate()],pids:number[]=[];
 const submissions=f.ids.map((id,index)=>withTenant(f.worker.ctx,async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${f.key},0))`);
  const [who]=await tx.execute<{pid:number;session:string;current:string;super:boolean;bypass:boolean}>(sql`select pg_backend_pid() as pid,session_user as session,current_user as current,rolsuper as super,rolbypassrls as bypass from pg_roles where rolname=current_user`);
  expect(who).toMatchObject({session:'ai_hr_app',current:'ai_hr_app',super:false,bypass:false});pids[index]=who.pid;
  await tx.insert(s.attendanceWorkflowRequest).values(f.values(id));entered[index].open();await release.promise;
 }));
 const completed=Promise.allSettled(submissions);
 let writer:Promise<PromiseSettledResult<void>[]>|undefined;
 try{
  await within(Promise.all(entered.map(row=>row.promise)),3000);
  writer=Promise.allSettled([setAttendanceWorkflowEnabled(f.root,b.companyId,'irregularity',false)]);
  const until=Date.now()+2000;let observed=false;
  while(Date.now()<until){const [row]=await owner.client<{blocked:boolean}[]>`select exists(select 1 from pg_stat_activity a where a.datname=current_database() and a.wait_event_type='Lock' and pg_blocking_pids(a.pid)&&${pids}::int[]) as blocked`;if(row.blocked){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  expect(observed).toBe(true);
 }finally{release.open();const outcomes=[...await completed,...(writer?await writer:[])];for(const outcome of outcomes)if(outcome.status==='rejected')throw outcome.reason;}
 expect(await owner.db.select({id:s.attendanceWorkflowRequest.correctionId}).from(s.attendanceWorkflowRequest).where(inArray(s.attendanceWorkflowRequest.correctionId,f.ids)).orderBy(s.attendanceWorkflowRequest.correctionId)).toEqual(f.ids.slice().sort().map(id=>({id})));
 expect((await owner.db.select().from(s.attendanceWorkflowSetting).where(and(eq(s.attendanceWorkflowSetting.companyId,b.companyId),eq(s.attendanceWorkflowSetting.applicationType,'irregularity'))))[0].enabled).toBe(false);
},30000);

it('retains canonical subject, shared-company assignment, version and resolved-route refusals for the app LOGIN',async()=>{
 const f=await fixture(),value=f.values(f.ids[0]);
 for(const change of [{companyId:f.other.id},{templateVersion:value.templateVersion+1},{stages:[]}]){
  await expect(withTenant(f.worker.ctx,tx=>tx.insert(s.attendanceWorkflowRequest).values({...value,...change}))).rejects.toThrow();
 }
 await expect(withTenant({...f.worker.ctx,tenantId:randomUUID()},tx=>tx.insert(s.attendanceWorkflowRequest).values(value))).rejects.toThrow();
 expect(await owner.db.select({id:s.attendanceWorkflowRequest.id}).from(s.attendanceWorkflowRequest).where(inArray(s.attendanceWorkflowRequest.correctionId,f.ids))).toEqual([]);
 expect(await owner.client`select company_id from attendance_workflow_company where template_id=${f.template.id}::uuid order by company_id`).toEqual([b.companyId,f.other.id].sort().map(company_id=>({company_id})));
},30000);

it('executes the exact bridge as a real restricted owner and serves a distinct app LOGIN through unchanged forced RLS',async()=>{
 const f=await fixture(),role='bridge_owner_'+randomUUID().replaceAll('-','');
 const [parent]=await owner.client<{name:string}[]>`select pg_get_userbyid(relowner) as name from pg_class where oid='public.attendance_workflow_request'::regclass`;
 const functions=await owner.client<{signature:string;owner:string;facts:Record<string,unknown>}[]>`select p.oid::regprocedure::text as signature,pg_get_userbyid(p.proowner) as owner,to_jsonb(p) as facts from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.prosecdef and p.prokind='f' order by p.oid`;
 expect(functions.length).toBeGreaterThan(helperNames.length);
 const [forcedBefore]=await owner.client<{rows:unknown}[]>`select jsonb_agg(jsonb_build_object('oid',oid,'owner',relowner,'rls',relrowsecurity,'force',relforcerowsecurity) order by oid) as rows from pg_class where relnamespace='public'::regnamespace and relforcerowsecurity`;
 expect(forcedBefore.rows).not.toBeNull();
 const access=await owner.client<{name:string;rls:boolean;force:boolean}[]>`select relname as name,relrowsecurity as rls,relforcerowsecurity as force from pg_class where relnamespace='public'::regnamespace and relname in ('access_capability','access_configuration','access_group','access_group_grant','access_membership','access_user_override') order by relname`;
 expect(access).toEqual(['access_capability','access_configuration','access_group','access_group_grant','access_membership','access_user_override'].map(name=>({name,rls:true,force:true})));
 const [targetBefore]=await owner.client<{definition:string}[]>`select pg_get_functiondef('app.attendance_workflow_links()'::regprocedure) as definition`;
 const before=await catalogue(owner.client);let created=false;
 try{
  await owner.client.begin(async connection=>{
   await connection.unsafe(`CREATE ROLE ${quote(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT`);
   await connection.unsafe(`GRANT ${quote(parent.name)} TO ${quote(role)} WITH INHERIT TRUE, SET FALSE, ADMIN FALSE`);
   for(const fn of functions)await connection.unsafe(`ALTER FUNCTION ${fn.signature} OWNER TO ${quote(role)}`);
   await connection.unsafe(`ALTER TABLE public.attendance_workflow_request OWNER TO ${quote(role)}`);
   await connection.unsafe(definition);
  });created=true;
  await owner.client.begin(async connection=>{
   await connection.unsafe(`SET LOCAL ROLE ${quote(role)}`);
   const [identity]=await connection<{name:string;super:boolean;bypass:boolean;parentSet:boolean}[]>`select current_user as name,rolsuper as super,rolbypassrls as bypass,pg_has_role(current_user,${parent.name},'SET') as "parentSet" from pg_roles where rolname=current_user`;
   expect(identity).toEqual({name:role,super:false,bypass:false,parentSet:false});
   await connection.unsafe(bridge);
   const [actual]=await connection<{body:string}[]>`select prosrc as body from pg_proc where oid='app.attendance_workflow_links()'::regprocedure`;
   expect(actual.body).toBe(expectedBody);
  });
  await withTenant(f.root,async tx=>{
   const [identity]=await tx.execute<{session:string;current:string;super:boolean;bypass:boolean}>(sql`select session_user as session,current_user as current,rolsuper as super,rolbypassrls as bypass from pg_roles where rolname=current_user`);
   expect(identity).toEqual({session:'ai_hr_app',current:'ai_hr_app',super:false,bypass:false});
   const candidates=await tx.execute<{id:string}>(sql`select id from app.attendance_workflow_v3_approver_options(ARRAY[${b.companyId}::uuid,${f.other.id}::uuid])`);
   expect(candidates.map(row=>row.id)).toContain(f.reviewer.employmentId);
  });
  await withTenant(f.worker.ctx,async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${f.key},0))`);
   await tx.insert(s.attendanceWorkflowRequest).values(f.values(f.ids[0]));
  });
  const [forcedAfter]=await owner.client<{rows:unknown}[]>`select jsonb_agg(jsonb_build_object('oid',oid,'owner',relowner,'rls',relrowsecurity,'force',relforcerowsecurity) order by oid) as rows from pg_class where relnamespace='public'::regnamespace and relforcerowsecurity`;
  expect(forcedAfter).toEqual(forcedBefore);
 }finally{
  if(created){
   await owner.client.begin(async connection=>{
    await connection.unsafe(`ALTER TABLE public.attendance_workflow_request OWNER TO ${quote(parent.name)}`);
    for(const fn of functions)await connection.unsafe(`ALTER FUNCTION ${fn.signature} OWNER TO ${quote(fn.owner)}`);
    await connection.unsafe(targetBefore.definition);
    await connection.unsafe(`DROP ROLE ${quote(role)}`);
   });
   expect(await catalogue(owner.client)).toEqual(before);
   const restored=await owner.client<{facts:Record<string,unknown>}[]>`select to_jsonb(p) as facts from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.prosecdef and p.prokind='f' order by p.oid`;
   expect(restored.map(row=>row.facts)).toEqual(functions.map(row=>row.facts));
   expect(await owner.client`select rolname from pg_roles where rolname=${role}`).toEqual([]);
  }
 }
},90000);

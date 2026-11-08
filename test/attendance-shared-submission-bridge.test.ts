/** Native component/ownership proof. Final combined populated-prefix rehearsal is separate. */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type postgres from 'postgres';
import {and,eq,inArray,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,onTestFinished} from 'vitest';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {setAttendanceWorkflowEnabled} from '../core/attendance-workflow';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {AttendanceBridgeOwnedPhases} from './helpers/attendance-bridge-owned-phase';
import {attendanceBridgeFixture} from './helpers/attendance-bridge-fixture';
import {attendanceOwnerProcess} from './helpers/attendance-bridge-owner-process';
import {OWNER_MODES,type OwnerMode} from './helpers/attendance-bridge-owner-protocol';
import {workerDb} from './db-names';
import {admitSingletonTest} from './helpers/ci-singleton-admission';

// A lost owned child cannot lend this database to another file. Admission binds
// the complete proof/Python closure to one fresh, one-worker hosted job cluster.
admitSingletonTest('test/attendance-shared-submission-bridge.test.ts');
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
const catalogueExpression=`jsonb_build_object(
  'functions',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_proc p where p.oid=any($1::oid[])),
  'bindings',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t where t.tgfoid='app.attendance_workflow_links()'::regprocedure),
  'request',(select jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'kind',c.relkind) from pg_class c where c.oid='public.attendance_workflow_request'::regclass))`;
const catalogue=async(connection:Native)=>{
 const [row]=await connection.unsafe<{value:unknown}[]>(`select ${catalogueExpression} as value`,[functionIds]);
 return row.value;
};
const rollback=new Error('Rollback only this native bridge control');
const ownershipPhases=new AttendanceBridgeOwnedPhases();
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
beforeEach(async()=>{await ownershipPhases.drain();await resetDb();b=await seedBase();});
afterAll(async()=>{try{await ownershipPhases.drain();if(componentInstalled&&initialDefinition){await owner.client.unsafe(initialDefinition);expect(await catalogue(owner.client)).toEqual(initialCatalogue);}}finally{await closeAll();}});

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
 ['narrowed UPDATE OF setting trigger',`DROP TRIGGER attendance_workflow_setting_links ON public.attendance_workflow_setting; CREATE TRIGGER attendance_workflow_setting_links BEFORE INSERT OR UPDATE OF enabled ON public.attendance_workflow_setting FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_links()`],
 ['pre-3110 helper','ALTER FUNCTION app.attendance_workflow_applies(uuid,uuid) SET row_security=off'],
 ['changed helper body',`CREATE OR REPLACE FUNCTION app.attendance_workflow_applies(wanted uuid,wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$SELECT false$$`],
 ['missing helper','ALTER FUNCTION app.attendance_workflow_applies(uuid,uuid) RENAME TO attendance_bridge_missing_applies'],
]as const;
it.for(mutations)('refuses %s before changing any native function, relation or trigger catalogue',async([name,change])=>{
 await rolledBack(async connection=>{
  await connection.unsafe(definition);await connection.unsafe(change);
  if(name==='narrowed UPDATE OF setting trigger'){
   const [binding]=await connection<{kind:number;columns:string}[]>`select tgtype::integer as kind,tgattr::text as columns from pg_trigger where tgname='attendance_workflow_setting_links' and tgrelid='public.attendance_workflow_setting'::regclass`;
   expect(binding.kind).toBe(23);expect(binding.columns).not.toBe('');
  }
  const before=await catalogue(connection);
  await connection.unsafe('SAVEPOINT bridge_attempt');
  let refusal:unknown;
  try{await connection.unsafe(bridge);}catch(error){refusal=error;}
  await connection.unsafe('ROLLBACK TO SAVEPOINT bridge_attempt');
  expect(refusal).toMatchObject({code:'55000'});expect(await catalogue(connection)).toEqual(before);
 });
});

const fixture=()=>attendanceBridgeFixture(b);

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

async function isolatedOwner(mode:OwnerMode){
 const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;
 if(!pool||!/^\d+$/.test(pool))throw Error('Actual owned worker database identity required');
 const child=attendanceOwnerProcess({version:1,kind:'OWNED_ATTENDANCE_BRIDGE_COMPONENT',base:b,
  role:'bridge_owner_'+randomUUID().replaceAll('-',''),mode},process.env,workerDb(pool));
 let result:Awaited<ReturnType<typeof child.run>>|undefined;
 const phase=ownershipPhases.start(async step=>{result=await step(()=>child.run());},()=>child.stopAndDrain(),child.stop);
 onTestFinished(()=>phase.stopAndDrain());
 await phase.result;
 if(!result)throw Error('Owned Attendance component result missing');
 expect(result.complete).toBe(true);expect(result.allCatalogueRestored).toBe(true);expect(result.roleAbsent).toBe(true);
 return result;
}
it('executes the exact bridge as a real restricted owner and serves a distinct app LOGIN through unchanged forced RLS',async()=>{
 const result=await isolatedOwner('positive');
 expect(result).toMatchObject({kind:'ATTENDANCE_OWNER_POSITIVE',ownedOidCaptured:true,nonemptyApprover:true,canonicalRequestWritten:true,unchangedForcedRls:true,faultObserved:false});
 expect(result.appIdentity).toEqual({session:'ai_hr_app',current:'ai_hr_app',super:false,bypass:false});
 expect(result.restrictedIdentity).toMatchObject({super:false,bypass:false,parentSet:false,statementTimeout:'5s',lockTimeout:'300ms'});
},90000);
it.for(OWNER_MODES.filter(mode=>mode!=='positive'))('settles real owned child fault %s before any later reset or teardown SQL',async mode=>{
 const result=await isolatedOwner(mode);
 expect(result).toMatchObject({kind:'ATTENDANCE_OWNER_FAULT',faultObserved:true,allCatalogueRestored:true,roleAbsent:true});
 expect(result.ownedOidCaptured).toBe(mode==='rollback-before-commit'||mode==='lost-after-commit'||mode==='restore-guard-drift');
},90000);

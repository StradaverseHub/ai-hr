/** ADR 0181 employment visibility shadow (migration 7240): the fictional walkthrough on a real database
 * (core/visibility-walkthrough.ts). A small fictional tenant: WALK01 manages WALK02 and WALK03, WALK02 manages WALK04,
 * WALK05 manages WALK06; every employment has a current department. Users for WALK01 (manager and department head),
 * WALK05 (department head), WALK04 (no reports) and an archived user for WALK02, plus a manager in a second tenant.
 *
 * Proves: actor selection (current line managers with a login, never another tenant, never archived or report-less
 * users); in shadow, the reads as those users produce `reason=compared relationship=1` lines with no difference;
 * nothing is written (row counts unchanged, and a write inside the walkthrough's transaction is refused by the
 * server); in legacy, and when switched off, and without the demo tenant, nothing is read. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {
 WALKTHROUGH_READS,readAs,runVisibilityWalkthrough,walkthroughExitCode,walkthroughIdentity,walkthroughPreflight,walkthroughSettings,
 type WalkthroughSettings,
} from '../core/visibility-walkthrough';
import {todayInKualaLumpur} from '../lib/hr-date';

let a:Base,other:Base;
const users:Record<string,string>={};
const notices:string[]=[];
let app:postgres.Sql;
const ownerSql=()=>owner.client as unknown as postgres.Sql;
const hrDate=()=>todayInKualaLumpur();
const SHADOW_LINE=/^access_visible_employment shadow /;

async function employment(base:Base,code:string,department:string){
 const[p]=await owner.client<{id:string}[]>`insert into person(tenant_id,full_name,primary_email) values(${base.tenantId}::uuid,${'Fictional '+code},${code.toLowerCase()+'@walkthrough.example.test'}) returning id::text`;
 const[e]=await owner.client<{id:string}[]>`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) values(${base.tenantId}::uuid,${p.id}::uuid,${base.companyId}::uuid,${code},'2025-01-06') returning id::text`;
 await owner.client`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from) values(${base.tenantId}::uuid,${e.id}::uuid,${base.companyId}::uuid,${department}::uuid,'full_time','2025-01-06')`;
 return{person:p.id,employment:e.id};
}
async function line(base:Base,manager:string,subordinate:string){
 await owner.client`insert into reporting_line(tenant_id,manager_employment_id,subordinate_employment_id,line_type,valid_from) values(${base.tenantId}::uuid,${manager}::uuid,${subordinate}::uuid,'administrative','2025-01-06')`;
}
async function login(base:Base,person:string,archived=false){
 const[u]=await owner.client<{id:string}[]>`insert into app_user(tenant_id,workos_user_id,person_id,archived_at) values(${base.tenantId}::uuid,${'fixture_'+randomUUID()},${person}::uuid,${archived?new Date().toISOString():null}::timestamptz) returning id::text`;
 await owner.client`insert into role_assignment(tenant_id,app_user_id,role,company_id) values(${base.tenantId}::uuid,${u.id}::uuid,'employee',null)`;
 return u.id;
}
const setMode=(mode:string)=>owner.client`select app.access_visible_employment_set_mode(${mode})`;
const settingsFor=(tenantId:string,statementsPerRun:number):WalkthroughSettings=>({enabled:true,tenantId,statementsPerRun,pauseMs:100,actorsPerRun:6,notes:[]});
const noSleep=async()=>{};
/** Every row count the walkthrough could conceivably change, and the stored answer's version. */
const footprint=async()=>(await owner.client<{f:string}[]>`select concat_ws(',',
 (select count(*) from employment),(select count(*) from person),(select count(*) from assignment),(select count(*) from reporting_line),
 (select count(*) from app_user),(select count(*) from role_assignment),(select count(*) from leave_request),(select count(*) from domain_event),
 (select coalesce(sum(access_version),0) from access_employment_state),(select count(*) from access_reporting_reach)) as f`)[0].f;

beforeAll(async()=>{
 await migrateTestDb();await resetDb();
 a=await seedBase();other=await seedBase();
 const w:Record<string,{person:string;employment:string}>={};
 for(const[code,dept]of [['WALK01',a.deptA],['WALK02',a.deptA],['WALK03',a.deptA],['WALK04',a.deptA],['WALK05',a.deptB],['WALK06',a.deptB]] as const)w[code]=await employment(a,code,dept);
 await line(a,w.WALK01.employment,w.WALK02.employment);await line(a,w.WALK01.employment,w.WALK03.employment);
 await line(a,w.WALK02.employment,w.WALK04.employment);await line(a,w.WALK05.employment,w.WALK06.employment);
 users.manager=await login(a,w.WALK01.person);users.head=await login(a,w.WALK05.person);
 users.noReports=await login(a,w.WALK04.person);users.archived=await login(a,w.WALK02.person,true);
 const x1=await employment(other,'WALKX1',other.deptA),x2=await employment(other,'WALKX2',other.deptA);
 await line(other,x1.employment,x2.employment);users.otherTenant=await login(other,x1.person);
 for(const t of [a.tenantId,other.tenantId]){
  await owner.client`select app.access_effective_company_refresh(${t}::uuid,null)`;
  await owner.client`select app.access_visible_employment_refresh(${t}::uuid,null,true,null)`;
 }
 app=postgres(process.env.DATABASE_URL!,{max:1,onnotice:n=>notices.push(String(n.message)),connection:{client_min_messages:'log'}});
},300_000);
afterAll(async()=>{try{await setMode('legacy');await app?.end({timeout:5});}finally{await closeAll();}});

describe('the walkthrough on a fictional tenant',()=>{
 it('chooses only current line managers with a login in its own tenant, and marks department heads',async()=>{
  await setMode('shadow');
  const pre=await walkthroughPreflight(ownerSql(),a.tenantId,hrDate());
  expect(pre.tenantPresent).toBe(true);expect(pre.mode).toBe('shadow');
  expect(pre.pool.map(p=>p.userId).sort()).toEqual([users.manager,users.head].sort());
  expect(pre.pool.every(p=>p.departmentHead)).toBe(true);
  const elsewhere=await walkthroughPreflight(ownerSql(),other.tenantId,hrDate());
  expect(elsewhere.pool.map(p=>p.userId)).toEqual([users.otherTenant]);
  const identity=await walkthroughIdentity(app,a.tenantId,users.manager);
  expect(identity).toMatchObject({tenantId:a.tenantId,userId:users.manager,roles:'employee'});
  expect(await walkthroughIdentity(app,a.tenantId,users.otherTenant)).toBeNull();
 },120_000);

 it('in shadow, reads as them: compared lines with relationship=1 and no difference, and writes nothing',async()=>{
  await setMode('shadow');
  const before=await footprint();
  notices.length=0;
  const statements=2*WALKTHROUGH_READS.length;
  const run=await runVisibilityWalkthrough({owner:ownerSql(),app},settingsFor(a.tenantId,statements),{hrDate:hrDate(),rotation:0,sleep:noSleep});
  expect(run).toMatchObject({status:'ran',mode:'shadow',pool:2,departmentHeads:2,actors:2,identitiesMissing:0,statements,failed:0});
  expect(walkthroughExitCode(run)).toBe(0);
  const lines=notices.filter(n=>SHADOW_LINE.test(n));
  // Employment, person and assignment reads each evaluate the reader at least once per statement.
  expect(lines.length).toBeGreaterThanOrEqual(2*5);
  for(const l of lines)expect(l).toBe('access_visible_employment shadow missing=0 extra=0 relationship=1 reason=compared');
  console.log(`visibility-walkthrough-db: ${statements} statements produced ${lines.length} compared lines`);
  expect(await footprint()).toBe(before);
 },300_000);

 it('the server refuses a write inside the walkthrough transaction',async()=>{
  const identity=(await walkthroughIdentity(app,a.tenantId,users.manager))!;
  const write=readAs(app,identity,'',tx=>tx`insert into person(tenant_id,full_name,primary_email) values(${a.tenantId}::uuid,'Fictional intruder','intruder@walkthrough.example.test')`);
  await expect(write).rejects.toMatchObject({code:'25006'});
  const viaCatalogueShape=readAs(app,identity,"update person set full_name=full_name where false");
  await expect(viaCatalogueShape).rejects.toMatchObject({code:'25006'});
 },120_000);

 it('in legacy it stops before reading, switched off it opens nothing, and without the demo tenant it refuses',async()=>{
  await setMode('legacy');
  notices.length=0;
  const legacy=await runVisibilityWalkthrough({owner:ownerSql(),app},settingsFor(a.tenantId,10),{hrDate:hrDate(),rotation:0,sleep:noSleep});
  expect(legacy).toMatchObject({status:'not_shadow',mode:'legacy',message:expect.stringMatching(/ \(pool=2 department_heads=2\)$/)});expect(walkthroughExitCode(legacy)).toBe(0);
  expect(notices.filter(n=>SHADOW_LINE.test(n))).toEqual([]);
  const untouchable=new Proxy({},{get(){throw new Error('a database client was used while switched off');}}) as unknown as postgres.Sql;
  const off=await runVisibilityWalkthrough({owner:untouchable,app:untouchable},walkthroughSettings({}),{hrDate:hrDate(),rotation:0});
  expect(off.status).toBe('disabled');expect(walkthroughExitCode(off)).toBe(0);
  // The real settings always name the demo seed's tenant, which this database (like production) does not hold.
  await setMode('shadow');
  const real=walkthroughSettings({AIHR_VISIBILITY_WALKTHROUGH:'on'});
  const absent=await runVisibilityWalkthrough({owner:ownerSql(),app},real,{hrDate:hrDate(),rotation:0,sleep:noSleep});
  expect(absent).toMatchObject({status:'refused'});expect(walkthroughExitCode(absent)).toBe(2);
  await setMode('legacy');
 },120_000);
});

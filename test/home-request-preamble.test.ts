/** The Home request preamble (core/home-request-preamble.ts, docs/adr/2026-11-10-home-request-read-scope.md decision 12).
 *
 * Every owner statement it answers equals that statement sent by itself in the same snapshot. A carrier that reads it
 * answers its owners without sending those statements, and every owner returns its own result and its own refusal: the
 * same proofs, identity, role, company proof, configuration, layout and entitlements as with every owner reading its
 * own. Another employment, a refused principal and another identity inside the carrier read as before, and a value of
 * the wrong shape answers nothing. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {client,declareSharedReadPreamble,withIndependentTransactions,withOwnerPreambleReads,withSharedReadSnapshot,withTenant,type SessionContext} from '../db/client';
import type {SharedReadStats} from '../db/shared-read';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {homeRequestPreamble} from '../core/home-request-preamble';
import {readEmployeeHomeIdentity,requireOwnHomeSubject} from '../core/employee-home';
import {readOwnEmployeeHomeConfiguration} from '../core/employee-home-configuration';
import {isPrincipalSnapshotCurrentTx,isRepeatableReadOnlyTx} from '../core/read-only-snapshot';
import {assertAssignedWorkPrincipalTx} from '../core/approvals';
import {assertReadCompositionPrincipalTx} from '../core/read-composition-principal';
import {isCurrentOwnHomeEmploymentTx,isOwnProfileEditEmploymentTx} from '../core/read';
import {resolveEntitlementsTx} from '../core/entitlements';
import {getEmployeeHomeDisplayPreferences} from '../core/dashboard-prefs';
import {defaultEmployeeHomeConfiguration} from '../lib/employee-home-defaults';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let base:Base,employee:{ctx:SessionContext;employmentId:string},other:{ctx:SessionContext;employmentId:string};
const sessions:SharedReadStats[]=[];
const hooks=globalThis as {__aihrPerfSharedRead?:(stats:SharedReadStats)=>void};
async function hire(name:string){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 return {employmentId:hired.employmentId,ctx:{tenantId:base.tenantId,userId:await createAppUser(base.tenantId,hired.personId,'employee'),personId:hired.personId,roles:['employee']} as SessionContext};
}
beforeAll(async()=>{
 await migrateTestDb();await resetDb();base=await seedBase();
 employee=await hire('Fictional preamble employee');other=await hire('Fictional preamble colleague');
 await owner.db.insert(s.employeeHomeConfigurationRevision).values({tenantId:base.tenantId,companyId:base.companyId,audienceRole:'employee',ordinal:1,
  configuration:defaultEmployeeHomeConfiguration(),reason:'Fictional preamble revision',createdByUserId:base.adminUserId});
 await owner.client`update app_user set dashboard_layout=${JSON.stringify({homeDisplay:{version:1,timeZone:'Asia/Kuala_Lumpur',weekStartsOn:1}})}::jsonb where id=${employee.ctx.userId!}::uuid`;
 hooks.__aihrPerfSharedRead=stats=>{sessions.push(stats);};
});
afterEach(()=>{sessions.length=0;});
afterAll(async()=>{delete hooks.__aihrPerfSharedRead;await closeAll();});

/** Every owner this preamble answers, as each composition calls it. */
const owners=(ctx:SessionContext,employmentId:string)=>Promise.all([
 readOwnEmployeeHomeConfiguration(ctx,employmentId).then(value=>value,error=>({refused:(error as Error).name})),
 readEmployeeHomeIdentity(ctx,employmentId).then(value=>value,error=>({refused:(error as Error).name})),
 requireOwnHomeSubject(ctx,employmentId).then(value=>value,error=>({refused:(error as Error).name})),
 getEmployeeHomeDisplayPreferences(ctx),
 withTenant(ctx,tx=>Promise.all([isRepeatableReadOnlyTx(tx),isPrincipalSnapshotCurrentTx(tx),
  assertAssignedWorkPrincipalTx(tx,ctx).then(()=>'admitted',error=>(error as Error).name),
  assertReadCompositionPrincipalTx(tx,ctx).then(()=>'admitted',error=>(error as Error).name),
  isCurrentOwnHomeEmploymentTx(tx,ctx,employmentId),isOwnProfileEditEmploymentTx(tx,ctx,employmentId),resolveEntitlementsTx(tx,ctx.tenantId)]),{readOnlySnapshot:true}),
 // The account task statement's setting: JIT off for its own planning.
 withTenant(ctx,async tx=>{await tx.execute(sql`set local jit=off`);const [row]=await tx.execute(sql`select current_setting('jit') as jit`) as unknown as {jit:string}[];return row;}),
]);
async function traced<T>(work:()=>Promise<T>){
 const options=client.options as {debug?:unknown},sent:string[]=[],previous=options.debug;
 options.debug=(_connection:number,query:string)=>{sent.push(query);};
 try{return {value:await work(),sent:sent.filter(query=>!query.startsWith("select set_config('app.tenant_id'"))};}finally{options.debug=previous;}
}
const carrier=<T,>(ctx:SessionContext,preambleFor:string|undefined,work:()=>Promise<T>)=>withSharedReadSnapshot(ctx,()=>{declareSharedReadPreamble(homeRequestPreamble(preambleFor));return work();});

describe('Home request preamble',()=>{
 it('answers each owner statement exactly as that statement answers itself in the same snapshot',async()=>{
  for(const requested of [employee.employmentId,undefined]){
   const pairs=await withTenant(employee.ctx,async tx=>{
    const preamble=homeRequestPreamble(requested).build(employee.ctx,tx)!;
    const [row]=await tx.execute(sql`select (${preamble.sql}) as preamble`) as unknown as {preamble:unknown}[];
    const driver=(tx as unknown as {session:{client:{unsafe(query:string,params:unknown[]):PromiseLike<unknown[]>&{values():PromiseLike<unknown[]>}}}}).session.client;
    const out:{query:string;owner:unknown[];seeded:unknown[]}[]=[];
    for(const seed of preamble.decode(row.preamble)){
     const sent=driver.unsafe(seed.query,seed.params);
     out.push({query:seed.query,owner:[...await (seed.mode==='values'?sent.values():sent)],seeded:seed.rows});
    }
    return out;
   },{readOnlySnapshot:true});
   // Proofs, inventory, dated proof, role, both employment checks, the configuration revision, layout and entitlements.
   expect(pairs.length).toBeGreaterThanOrEqual(13);
   for(const pair of pairs)expect(pair.seeded,pair.query).toEqual(pair.owner);
   expect(pairs.some(pair=>pair.query.includes('employee_home_configuration_revision')&&pair.seeded.length===1)).toBe(true);
  }
 });

 it('answers the owners inside a carrier without their statements, with each owner\'s own result',async()=>{
  const own=await traced(()=>withOwnerPreambleReads(()=>withSharedReadSnapshot(employee.ctx,()=>owners(employee.ctx,employee.employmentId))));
  const [ownStats]=sessions.splice(0);
  const answered=await traced(()=>carrier(employee.ctx,employee.employmentId,()=>owners(employee.ctx,employee.employmentId)));
  const [stats]=sessions.splice(0);
  expect(answered.value).toEqual(own.value);
  expect(await withIndependentTransactions(()=>owners(employee.ctx,employee.employmentId))).toEqual(own.value);
  expect(ownStats.seeded).toBe(0);
  expect(stats.preambles).toBe(1);
  expect(stats.seeded).toBeGreaterThanOrEqual(13);
  for(const text of ['own_home_dashboard_role','employee_home_configuration_revision','dashboard_layout_get','FROM tenant_module tm','"employment"."id", "person"."id"',
   "current_setting('transaction_isolation')",'app.principal_snapshot_current() as current'])
   expect(answered.sent.filter(query=>query.includes(text)),text).toEqual([]);
  // The account task statement's JIT setting is held from the identity statement.
  expect(answered.sent.filter(query=>/set local jit/i.test(query))).toEqual([]);
  expect(answered.sent.length).toBeLessThan(own.sent.length);
 });

 it('reads another employment, a refused principal and another identity exactly as before',async()=>{
  const refused={...employee.ctx,roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:null}]};
  for(const [ctx,employmentId] of [[employee.ctx,other.employmentId],[refused,employee.employmentId],[{...employee.ctx,personId:other.ctx.personId},employee.employmentId]] as const){
   const expected=await withIndependentTransactions(()=>owners(ctx,employmentId));
   expect(await carrier(ctx,employmentId,()=>owners(ctx,employmentId))).toEqual(expected);
   expect(await carrier(ctx,employee.employmentId,()=>owners(ctx,employmentId))).toEqual(expected);
   expect(await carrier(ctx,undefined,()=>owners(ctx,employmentId))).toEqual(expected);
  }
  // Another login inside this login's carrier keeps its own transaction and its own answers.
  const guest=await withIndependentTransactions(()=>owners(other.ctx,other.employmentId));
  expect(await carrier(employee.ctx,employee.employmentId,async()=>{await owners(employee.ctx,employee.employmentId);return owners(other.ctx,other.employmentId);})).toEqual(guest);
 });

 it('answers nothing from a value of the wrong shape',async()=>{
  const preamble=await withTenant(employee.ctx,async tx=>homeRequestPreamble(employee.employmentId).build(employee.ctx,tx)!);
  for(const value of [null,[],{},{snapshot:'yes'}])expect(()=>preamble.decode(value)).toThrow();
 });
});

/** AI Centre navigation speed (4 November 2026): the Loops overview reads every loop's row in one batch of statements
 * (core/loops/views.ts rowsTx over core/agent-registry/controls.ts workerRunGatesTx) instead of seven statements per loop
 * one after another, and the loop cards read every loop's gate in one pass. Same rows, same viewer's row-level security.
 * On fictional data:
 *  1. every loop's row, written out from the fixture: the probation loop switched on, with its sponsor, its run and its
 *     one open card; the other five off, never run, nothing counted;
 *  2. loopDetail's row for each loop is the overview's row;
 *  3. the tenant stop switch: every loop stopped and not running, the probation switch still on with its sponsor;
 *  4. the work: the overview sends at most 10 statements for the six loops (it sent about 50: seven per loop plus two),
 *     and the loop cards (Today and the "Before payroll" checklist) read the switches and the stop switch once each
 *     (they read both once per loop).
 * Expected values are written out from the fixture, never re-derived from the owners. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {client,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {ensureAgentPrincipal} from '../core/agent-principal';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {setMandateStopSwitch} from '../core/mandates/mandates';
import {runLoop} from '../core/loops/run';
import {readLoopCards} from '../core/loops/cards';
import {loopDetail,loopsOverview} from '../core/loops/views';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

/** The HR day the run is for: Thursday 2 July 2026; the probationer's probation ends ten days later. */
const TODAY='2026-07-02',PROBATION_ENDS='2026-07-12';
/** The six loops in page order (core/loops/types.ts LOOP_IDS), written out. */
const LOOPS=['loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry','loop_salary_payroll'] as const;
let b:Base,principalId:string,group:SessionContext&{userId:string};

async function login(base:Base,name:string,role:'employee'|'hr_admin'){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:`${randomUUID()}@fixture.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);
 return {...await entitledCtx(base,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}],employmentId:hired.employmentId};
}
/** Statements the app pool sends while `run` runs (BEGIN, COMMIT and the like not counted), with their text. */
async function statements<T>(run:()=>Promise<T>):Promise<{value:T;sent:string[]}>{
 const pool=client as unknown as {options:{debug?:unknown}};const sent:string[]=[];
 pool.options.debug=(_connection:number,text:string)=>{if(!/^\s*(begin|commit|rollback|savepoint|release)/i.test(text))sent.push(text);};
 try{return {value:await run(),sent};}finally{pool.options.debug=undefined;}
}

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'attendance','active');
 group=await login(b,'Fictional Group Administrator','hr_admin');
 principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
 const probationer=await login(b,'Fictional Probationer','employee');
 await owner.db.update(schema.employment).set({probationEndDate:PROBATION_ENDS}).where(eq(schema.employment.id,probationer.employmentId));
 await setWorkerSwitch(group,{workerId:'loop_probation_ending',enabled:true});
 expect(await runLoop('loop_probation_ending',{tenantId:b.tenantId,principalId,entitlements:(await entitledCtx(b)).entitlements!,today:TODAY})).toMatchObject({status:'ran',companies:1});
});

const off=(id:string,proposesValue=false)=>({id,level:'prepare',on:false,stopped:false,running:false,sponsor:null,lastRun:null,prepared:0,confirmed:0,changed:0,
 correctionRate:null,proposesValue,openNow:0,waitingNow:0,pausedCompanies:0});

describe('the Loops overview, read in one batch',()=>{
 it('returns every loop\'s row as the fixture sets it, and loopDetail returns the same row',async()=>{
  const overview=await loopsOverview(group);
  expect(overview.rows.map(row=>row.id)).toEqual([...LOOPS]);
  expect(overview.rows).toEqual([
   {id:'loop_probation_ending',level:'prepare',on:true,stopped:false,running:true,sponsor:{userId:group.userId,name:'Fictional Group Administrator'},
    lastRun:{at:expect.any(Date),status:'ran',capped:false},prepared:1,confirmed:0,changed:0,correctionRate:null,proposesValue:false,openNow:1,waitingNow:0,pausedCompanies:0},
   off('loop_payroll_inputs'),off('loop_missing_employee_data'),off('loop_missed_clock_outs',true),off('loop_document_expiry'),off('loop_salary_payroll'),
  ]);
  for(const row of overview.rows)expect((await loopDetail(group,row.id)).row,row.id).toEqual(row);
 });

 it('honours the tenant stop switch on every row',async()=>{
  await setMandateStopSwitch(group,true);
  const rows=(await loopsOverview(group)).rows;
  expect(rows.map(row=>[row.id,row.on,row.stopped,row.running])).toEqual([
   ['loop_probation_ending',true,true,false],['loop_payroll_inputs',false,true,false],['loop_missing_employee_data',false,true,false],
   ['loop_missed_clock_outs',false,true,false],['loop_document_expiry',false,true,false],['loop_salary_payroll',false,true,false]]);
  expect(rows[0].sponsor).toEqual({userId:group.userId,name:'Fictional Group Administrator'});
  // The stopped loop shows no card.
  expect(await readLoopCards(group,{scopeIds:[b.companyId],admin:true,today:TODAY})).toEqual([]);
 });

 it('sends a fixed handful of statements, not seven per loop',async()=>{
  const {value,sent}=await statements(()=>loopsOverview(group));
  expect(value.rows).toHaveLength(6);
  expect(sent.length,sent.join('\n')).toBeLessThanOrEqual(10);
  // One switch read for all six loops and one stop-switch read (before: two of each per loop, plus one more stop read).
  expect(sent.filter(text=>/from "teras_worker_control"/.test(text))).toHaveLength(1);
  expect(sent.filter(text=>/from "teras_mandate_control"/.test(text))).toHaveLength(1);
 });

 it('reads the loop cards\' gates once, and still shows the running loop\'s card',async()=>{
  const {value,sent}=await statements(()=>readLoopCards(group,{scopeIds:[b.companyId],admin:true,today:TODAY}));
  expect(value.map(card=>card.kind==='probation'?[card.kind,card.name,card.endDate]:[card.kind])).toEqual([['probation','Fictional Probationer',PROBATION_ENDS]]);
  expect(sent.filter(text=>/from "teras_worker_control"/.test(text))).toHaveLength(1);
  expect(sent.filter(text=>/from "teras_mandate_control"/.test(text))).toHaveLength(1);
 });
});

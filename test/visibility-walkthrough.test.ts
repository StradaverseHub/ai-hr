/** ADR 0181 employment visibility shadow: the fictional walkthrough's switch, tenant pin, read-only catalogue and rate
 * bounds (core/visibility-walkthrough.ts), without a database. The database behaviour is in
 * test/visibility-walkthrough-db.test.ts. */
import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {DEMO_TENANT_ID} from '../db/seed-guard';
import {
 WALKTHROUGH_BOUNDS,WALKTHROUGH_READS,WALKTHROUGH_RUN_BUDGET_MS,WALKTHROUGH_SWITCH,walkPlan,walkthroughExitCode,walkthroughPlan,
 walkthroughSettings,walkthroughSummary,type WalkthroughActor,
} from '../core/visibility-walkthrough';

const actors=(k:number):WalkthroughActor[]=>Array.from({length:k},(_,i)=>({userId:`fictional-user-${i}`,departmentHead:i%2===0}));

describe('the enable switch',()=>{
 it('is off by default and for anything but exactly "on"',()=>{
  for(const value of [undefined,'','true','1','ON','on ','yes','enabled']){
   const s=walkthroughSettings({[WALKTHROUGH_SWITCH]:value});
   expect(s.enabled,String(value)).toBe(false);
   expect(s.refused,String(value)).toBeUndefined();
  }
  expect(walkthroughSettings({}).enabled).toBe(false);
 });
 it('when on, reads only the demo seed tenant, whatever else the environment says',()=>{
  const s=walkthroughSettings({[WALKTHROUGH_SWITCH]:'on',DEV_TENANT_ID:DEMO_TENANT_ID,TENANT_ID:'00000000-0000-0000-0000-000000000001',AIHR_VISIBILITY_WALKTHROUGH_TENANT:'x'});
  expect(s.enabled&&s.tenantId).toBe(DEMO_TENANT_ID);
  expect(walkthroughSettings({[WALKTHROUGH_SWITCH]:'on'}).enabled).toBe(true);
 });
 it('refuses (exit 2) when DEV_TENANT_ID names another tenant: not the demo installation',()=>{
  const s=walkthroughSettings({[WALKTHROUGH_SWITCH]:'on',DEV_TENANT_ID:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
  expect(s.enabled).toBe(false);expect(s.refused).toBe(true);
  expect(walkthroughExitCode({status:'refused',message:s.enabled?'':s.reason})).toBe(2);
  expect(walkthroughExitCode({status:'disabled',message:'off'})).toBe(0);
  expect(walkthroughExitCode({status:'not_shadow',mode:'legacy',message:'legacy'})).toBe(0);
 });
 it('the script exits before opening any connection when switched off',()=>{
  const script=readFileSync('scripts/visibility-walkthrough.ts','utf8');
  const disabledReturn=script.indexOf('if(!settings.enabled&&!settings.refused)');
  expect(disabledReturn).toBeGreaterThan(0);
  expect(disabledReturn).toBeLessThan(script.indexOf('postgres(ownerUrl'));
 });
});

describe('rate bounds',()=>{
 it('defaults, and clamps every setting into its bounds',()=>{
  const d=walkthroughSettings({[WALKTHROUGH_SWITCH]:'on'});
  expect(d.enabled&&[d.statementsPerRun,d.pauseMs,d.actorsPerRun]).toEqual([40,250,6]);
  const high=walkthroughSettings({[WALKTHROUGH_SWITCH]:'on',[WALKTHROUGH_BOUNDS.statementsPerRun.env]:'100000',[WALKTHROUGH_BOUNDS.pauseMs.env]:'0',[WALKTHROUGH_BOUNDS.actorsPerRun.env]:'500'});
  expect(high.enabled&&[high.statementsPerRun,high.pauseMs,high.actorsPerRun]).toEqual([120,100,12]);
  expect(high.enabled&&high.notes.length).toBe(3);
  const bad=walkthroughSettings({[WALKTHROUGH_SWITCH]:'on',[WALKTHROUGH_BOUNDS.statementsPerRun.env]:'lots',[WALKTHROUGH_BOUNDS.pauseMs.env]:'2.5'});
  expect(bad.enabled&&[bad.statementsPerRun,bad.pauseMs]).toEqual([40,250]);
 });
 it('plans exactly statementsPerRun reads over at most actorsPerRun actors, rotating through the pool',()=>{
  const pool=actors(10);
  const plan=walkthroughPlan(pool,{statementsPerRun:40,actorsPerRun:4},3);
  expect(plan).toHaveLength(40);
  expect(new Set(plan.map(p=>p.actor.userId))).toEqual(new Set(['fictional-user-3','fictional-user-4','fictional-user-5','fictional-user-6']));
  // Each actor walks the catalogue in order.
  expect(plan.filter(p=>p.actor.userId==='fictional-user-3').slice(0,WALKTHROUGH_READS.length).map(p=>p.read.screen)).toEqual(WALKTHROUGH_READS.map(r=>r.screen));
  expect(new Set(walkthroughPlan(pool,{statementsPerRun:4,actorsPerRun:4},9).map(p=>p.actor.userId))).toEqual(new Set(['fictional-user-9','fictional-user-0','fictional-user-1','fictional-user-2']));
  expect(walkthroughPlan(actors(2),{statementsPerRun:5,actorsPerRun:6},0).map(p=>p.actor.userId)).toEqual(['fictional-user-0','fictional-user-1','fictional-user-0','fictional-user-1','fictional-user-0']);
  expect(walkthroughPlan([],{statementsPerRun:40,actorsPerRun:6},0)).toEqual([]);
 });
 it('runs one statement at a time with the pause between them, never below the minimum pause',async()=>{
  let clock=0;const sleeps:number[]=[];const events:string[]=[];let inFlight=0,maxInFlight=0;
  const plan=walkthroughPlan(actors(3),{statementsPerRun:7,actorsPerRun:3},0);
  const out=await walkPlan(plan,{pauseMs:10,now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;events.push('sleep');},
   execute:async()=>{inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);events.push('read');clock+=5;inFlight--;}});
  expect(out).toMatchObject({statements:7,failed:0,stoppedByBudget:false});
  expect(maxInFlight).toBe(1);
  expect(sleeps).toEqual(Array(6).fill(WALKTHROUGH_BOUNDS.pauseMs.min));
  expect(events.join(',')).toBe(['read',...Array(6).fill('sleep,read')].join(','));
 });
 it('stops starting statements at the run budget, and never runs more than the hard maximum',async()=>{
  let clock=0;let reads=0;
  const plan=walkthroughPlan(actors(1),{statementsPerRun:1000,actorsPerRun:1},0);
  const out=await walkPlan(plan,{pauseMs:1000,now:()=>clock,sleep:async ms=>{clock+=ms;},execute:async()=>{reads++;clock+=59_000;}});
  expect(out.stoppedByBudget).toBe(true);
  expect(reads).toBe(Math.ceil(WALKTHROUGH_RUN_BUDGET_MS/60_000));
  let unbounded=0;
  const long=await walkPlan(plan,{pauseMs:100,now:()=>0,sleep:async()=>{},execute:async()=>{unbounded++;}});
  expect(long.statements).toBe(WALKTHROUGH_BOUNDS.statementsPerRun.max);expect(unbounded).toBe(WALKTHROUGH_BOUNDS.statementsPerRun.max);
 });
 it('counts a failed read without stopping, and a failed read makes the run exit 2',async()=>{
  const plan=walkthroughPlan(actors(1),{statementsPerRun:3,actorsPerRun:1},0);
  const failures:string[]=[];let i=0;
  const out=await walkPlan(plan,{pauseMs:100,now:()=>0,sleep:async()=>{},execute:async()=>{if(i++===1)throw Object.assign(new Error('x'),{code:'57014'});},onFailure:s=>failures.push(s.read.screen)});
  expect(out).toMatchObject({statements:3,failed:1});expect(failures).toHaveLength(1);
  const run={status:'ran' as const,mode:'shadow',pool:1,departmentHeads:1,actors:1,identitiesMissing:0,...out};
  expect(walkthroughExitCode(run)).toBe(2);
  expect(walkthroughExitCode({...run,failed:0})).toBe(0);
  expect(walkthroughExitCode({...run,failed:0,statements:0})).toBe(2);
  expect(walkthroughSummary(run)).toMatch(/^visibility-walkthrough mode=shadow pool=1 department_heads=1 actors=1 unresolved=0 statements=3 failed=1 /);
 });
});

describe('the read catalogue',()=>{
 it('is counts only: one select per read, no write, no lock, no setting, no function with effects',()=>{
  expect(WALKTHROUGH_READS.length).toBeGreaterThanOrEqual(5);
  for(const r of WALKTHROUGH_READS){
   expect(r.sql,r.screen).toMatch(/^select count\(\*\)::int as n from /);
   expect(r.sql,r.screen).not.toMatch(/;/);
   expect(r.sql.toLowerCase(),r.screen).not.toMatch(/\b(insert|update|delete|merge|truncate|copy|call|do|grant|revoke|alter|create|drop|lock|for update|for share|set_config|nextval|setval|pg_advisory|refresh|notify|perform|execute|vacuum|analyze)\b/);
   // Only plain tables and the reads' own aliases; no function is called besides count().
   const called=[...r.sql.replace(/count\(\*\)/g,'').matchAll(/([a-z_.]+)\s*\(/g)].map(m=>m[1]);
   expect(called.filter(name=>name!=='from'),r.screen).toEqual([]);
  }
 });
 it('reads the tables whose policies call visible_employment_ids, as a manager screen would',()=>{
  const tables=new Set(WALKTHROUGH_READS.flatMap(r=>[...r.sql.matchAll(/\b(?:from|join) ([a-z_]+)/g)].map(m=>m[1])));
  for(const t of ['employment','person','assignment','leave_request','leave_approval_step'])expect(tables.has(t),t).toBe(true);
 });
 it('every transaction is opened READ ONLY and checked before its statement',()=>{
  const source=readFileSync('core/visibility-walkthrough.ts','utf8');
  const begins=[...source.matchAll(/\.begin\(([^,]*),/g)].map(m=>m[1]);
  expect(begins.length).toBeGreaterThanOrEqual(3);
  for(const b of begins)expect(b).toBe("'read only'");
  expect(source).toContain("current_setting('transaction_read_only') as ro");
  expect(source).toMatch(/if\(s\.ro!=='on'\)throw/);
  // No statement in the module writes.
  expect(source.toLowerCase()).not.toMatch(/\b(insert into|update [a-z_.]+ set|delete from|truncate)\b/);
 });
});

import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {createSteadyRouteScheduler,firstGroupNavigationRoutes,modelSteadyRouteCapacity,navigationProtocol,navigationRoutesForIteration,planSteadyRouteCoverage} from '../scripts/performance/route-scheduling.mjs';
import {routePools} from '../scripts/performance/system-route-manifest.mjs';
const roles=['employee','manager','companyHR','groupHR']as const;
// Actual native fixture role allocation and actor positions, including Group HR0/250.
const users=Array.from({length:500},(_,index)=>{const i=index%250,company=Math.floor(i/50),position=i%50;return{index,role:position===0&&company===0?'groupHR':position<2?'companyHR':position<4?'manager':'employee'};});
const counts=new Map(roles.map(role=>[role,users.filter(u=>u.role===role).length]));
const scheduler=()=>createSteadyRouteScheduler({pools:routePools,roleCounts:counts,steadyStart:10000,steadyUntil:310000});
const slot=(extra:Record<string,unknown>={})=>({role:'groupHR',ordinal:0,actors:2,iteration:0,slot:0,startedMs:10000,...extra});
it('retains disjoint fallback lanes, three non-group reads and the explicit bounded seven-slot minimum',()=>{
 const pool=Array.from({length:14},(_,i)=>'/route/'+i);
 expect(navigationRoutesForIteration(pool,{role:'companyHR',ordinal:0,actors:2,iteration:0})).toEqual(pool.slice(0,3));
 expect(navigationRoutesForIteration(pool,{role:'companyHR',ordinal:1,actors:2,iteration:0})).toEqual(pool.slice(3,6));
 expect(navigationRoutesForIteration(pool,{role:'companyHR',ordinal:0,actors:2,iteration:1})).toEqual(pool.slice(6,9));
 expect(navigationRoutesForIteration(pool,{role:'groupHR',ordinal:0,actors:2,iteration:0})).toEqual(pool.slice(0,7));
 expect(navigationRoutesForIteration(pool,{role:'groupHR',ordinal:1,actors:2,iteration:0})).toEqual(pool.slice(7));
 expect(scheduler().slots('groupHR')).toBe(7);expect(scheduler().slots('groupHR',0,0)).toBe(10);for(const role of roles.slice(0,3))expect(scheduler().slots(role)).toBe(3);
});
it('preserves actual first-cycle Group HR priority routes during ramp without consuming steady obligations',()=>{
 const s=scheduler(),first=firstGroupNavigationRoutes(routePools,counts);
 for(let ordinal=0;ordinal<2;ordinal++)for(let i=0;i<first[ordinal].length;i++){
  const lease=s.reserve(slot({ordinal,slot:i,startedMs:ordinal*5000}));expect(lease.route).toBe(first[ordinal][i]);s.complete(lease,true);
 }
 expect(s.snapshot().every(row=>row.completed===0&&row.pending.length===row.required)).toBe(true);
 const firstSteady=s.reserve(slot());expect(first.flat()).toContain(firstSteady.route);s.complete(firstSteady,true);
 expect(s.snapshot().find(row=>row.role==='groupHR')!.completed).toBe(1);
});
it('shares pending work per actual role, reserves concurrent routes once and releases failed requests',()=>{
 const s=scheduler(),one=s.reserve(slot()),two=s.reserve(slot({ordinal:1}));expect(one.route).not.toBe(two.route);
 expect(s.snapshot().find(row=>row.role==='groupHR')!.inflight).toEqual([one.route,two.route]);
 s.complete(one,false);s.complete(two,true);
 const next=s.reserve(slot());expect(next.route).toBe(one.route);s.complete(next,true);
 const state=s.snapshot();expect(state.find(row=>row.role==='groupHR')!.completed).toBe(2);
 expect(state.filter(row=>row.role!=='groupHR').every(row=>row.completed===0)).toBe(true);
 expect(()=>s.complete(next,true)).toThrow(RangeError);
});
it('does not count warmup/post-window or failed work and admits at the inclusive start/exclusive end',()=>{
 const s=scheduler();for(const startedMs of [9999,310000]){const lease=s.reserve(slot({startedMs}));s.complete(lease,true);}
 expect(s.snapshot().every(row=>row.completed===0)).toBe(true);
 const failed=s.reserve(slot());s.complete(failed,false);expect(s.snapshot().every(row=>row.completed===0)).toBe(true);
 const lateFinish=s.reserve(slot({startedMs:309999}));s.complete(lateFinish,true);
 expect(s.snapshot().find(row=>row.role==='groupHR')!.completed).toBe(1);
});
it('does not stall or duplicate an obligation when all pending routes are in flight, and keeps traffic after coverage',()=>{
 const pools=Object.fromEntries(roles.map(role=>[role,['/one','/two']])),s=createSteadyRouteScheduler({pools,roleCounts:counts,steadyStart:10000,steadyUntil:310000});
 const one=s.reserve(slot()),two=s.reserve(slot({ordinal:1})),fallback=s.reserve(slot({slot:1}));
 expect(s.snapshot().find(row=>row.role==='groupHR')!.inflight).toHaveLength(2);
 s.complete(fallback,false);s.complete(one,true);s.complete(two,true);
 expect(s.snapshot().find(row=>row.role==='groupHR')!.pending).toEqual([]);
 const continued=s.reserve(slot({iteration:10}));expect(pools.groupHR).toContain(continued.route);s.complete(continued,true);
 expect(s.snapshot().find(row=>row.role==='groupHR')!.completed).toBe(2);
});
it.each([1000,5000])('models actual 500 actor offsets and first-cycle priorities at %sms with all per-role steady obligations and retained mutations',thinkTimeMs=>{
 expect(users.filter(u=>u.role==='groupHR').map(u=>u.index)).toEqual([0,250]);expect([...counts.values()]).toEqual([460,20,18,2]);
 for(const [getMs,postMs]of [[900,400],[1000,500]]){
  const plan=modelSteadyRouteCapacity({pools:routePools,users,thinkTimeMs,steadyHoldMs:300000,getMs,postMs});
  expect(plan.kind).toBe('PLANNING_ONLY');expect(plan.feasible,JSON.stringify(plan.rows)).toBe(true);
  for(const row of plan.rows){expect(row.completed).toBe(routePools[row.role as keyof typeof routePools].length);expect(row.pending).toEqual([]);expect(row.inflight).toEqual([]);}
  expect(plan.steps.payrollProcess).toBe(2);expect(plan.steps.payrollExport).toBe(2);
  expect(plan.steps.ordinaryMutations).toBeGreaterThan(0);expect(plan.steps.clockingActions).toBeGreaterThan(0);expect(plan.iterations.groupHR).toBeGreaterThan(2);
 }
 const bounded=planSteadyRouteCoverage({pools:routePools,users,thinkTimeMs,steadyHoldMs:300000});expect(bounded.protocol).toBe(navigationProtocol);expect(bounded.groupReadSlots).toBe(7);
});
it('handles future route cardinality through a bounded explicit revision or refuses, never drops required routes',()=>{
 // Group HR carries the 20 routes no other role reaches in the first cycle, at most 12 per actor: growth that fits the
 // remaining headroom is revised within the bound and the next route must refuse, so neither case can drop an obligation.
 const firstCycle=firstGroupNavigationRoutes(routePools,counts),headroom=12*firstCycle.length-firstCycle.flat().length;
 const grown=(routes:number)=>({...routePools,groupHR:[...routePools.groupHR,...Array.from({length:routes},(_,i)=>'/future/'+i)]});
 expect(headroom).toBeGreaterThan(0);
 const more=grown(headroom),plan=planSteadyRouteCoverage({pools:more,users,thinkTimeMs:5000,steadyHoldMs:300000});expect(plan.groupReadSlots).toBeGreaterThan(7);expect(plan.groupReadSlots).toBeLessThanOrEqual(12);
 expect(plan.rows.find(row=>row.role==='groupHR')!.completed).toBe(more.groupHR.length);
 expect(()=>planSteadyRouteCoverage({pools:grown(headroom+1),users,thinkTimeMs:5000,steadyHoldMs:300000})).toThrow(/capacity/);
 const impossible={...routePools,groupHR:[...routePools.groupHR,...Array.from({length:1000},(_,i)=>'/future/'+i)]};
 expect(()=>planSteadyRouteCoverage({pools:impossible,users,thinkTimeMs:5000,steadyHoldMs:300000})).toThrow(/capacity/);
 expect(()=>planSteadyRouteCoverage({pools:routePools,users,thinkTimeMs:5000,steadyHoldMs:30000})).toThrow(/capacity/);
});
it('uses the same slot scheduler in the real driver and preserves complete native mutation ownership',()=>{
 const driver=readFileSync(new URL('../scripts/performance/system-load-owner.mjs',import.meta.url),'utf8'),mixed=readFileSync(new URL('../scripts/performance/mixed-workflows.mjs',import.meta.url),'utf8');
 expect(driver).toContain('navigationScheduler?.reserve(');expect(driver).toContain('navigationScheduler.complete(lease,usable)');
 expect(driver).toContain('await mixedWorkflows.run(user,iteration)');expect(driver).toContain('await pause(i*20)');
 expect(driver).not.toContain('iteration===0&&user.role===\'groupHR\'?firstGroupRoutes');
 // Native business workflows are unchanged; the source guard supplements the event-time
 // scheduling tests, it cannot establish execution or native persistence on its own.
 for(const action of ['templates.payrollProcess','await exportPayroll(','templates.personnelCreate','templates.personnelEdit','templates.personnelDelete','templates.importValidate','templates.importCommit'])expect(mixed).toContain(action);
});
it('refuses invalid lane, budget, reservation and fixture declarations',()=>{
 for(const input of [{role:'employee',ordinal:0,actors:0,iteration:0},{role:'employee',ordinal:2,actors:2,iteration:0},{role:'unknown',ordinal:0,actors:1,iteration:0},{role:'employee',ordinal:0,actors:1,iteration:-1},{role:'groupHR',ordinal:0,actors:1,iteration:0,groupReadSlots:6},{role:'groupHR',ordinal:0,actors:1,iteration:0,groupReadSlots:13}])expect(()=>navigationRoutesForIteration(['/'],input)).toThrow(RangeError);
 expect(()=>navigationRoutesForIteration([],{role:'employee',ordinal:0,actors:1,iteration:0})).toThrow(RangeError);
 const s=scheduler();for(const extra of [{actors:3},{slot:12},{startedMs:NaN}])expect(()=>s.reserve(slot(extra))).toThrow(RangeError);
 expect(()=>s.complete({route:'/fake'},true)).toThrow(RangeError);
 expect(()=>modelSteadyRouteCapacity({pools:routePools,users:users.slice(1),thinkTimeMs:5000,steadyHoldMs:300000})).toThrow(RangeError);
});

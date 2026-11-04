import {expect,it} from 'vitest';
import {routeLatency} from '../scripts/performance/route-latency.mjs';
const read=(role:string,route:string,durationMs:number,startedMs=20)=>({role,route,durationMs,startedMs,method:'GET'});
const navigation=(role:string,route:string,durationMs:number,startedMs=20)=>({role,route,durationMs,startedMs});
const input=()=>({samples:[read('employee','/',100)],pageInteractions:[navigation('employee','/',150)],routePools:{employee:['/']},homeTemplates:[] as {role:string;requests:{path:string}[]}[],steadyStart:10,steadyUntil:100});
it('refuses a slow minority route even when the pooled role p95 is fast',()=>{
 const fixture=input();fixture.routePools.employee.push('/slow');
 fixture.samples=Array.from({length:100},()=>read('employee','/',100));fixture.samples.push(read('employee','/slow',1500));
 fixture.pageInteractions=Array.from({length:100},()=>navigation('employee','/',100));
 fixture.pageInteractions.push(navigation('employee','/slow',1600));
 expect(fixture.samples.map(row=>row.durationMs).sort((a,b)=>a-b)[95]).toBe(100);
 expect(fixture.pageInteractions.map(row=>row.durationMs).sort((a,b)=>a-b)[95]).toBe(100);
 const result=routeLatency(fixture);expect(result.targetMet).toBe(false);
 expect(result.slow.map(row=>[row.kind,row.route])).toEqual([['read','/slow'],['navigation','/slow']]);
});
it('keeps role, known query view and personal Home API measurements separate',()=>{
 const fixture=input();fixture.routePools={employee:['/assistant?view=jobs','/assistant?view=tools']};
 fixture.samples=[read('employee','/assistant?view=jobs',100),read('employee','/assistant?view=tools',1100),read('manager','/assistant?view=tools',10),read('employee','/api/home/tasks',1200)];
 fixture.pageInteractions=fixture.routePools.employee.map(route=>navigation('employee',route,100));
 fixture.homeTemplates=[{role:'employee',requests:[{path:'/api/home/tasks'}]}];
 const result=routeLatency(fixture);expect(result.targetMet).toBe(false);
 expect(result.slow.map(row=>row.route)).toEqual(['/assistant?view=tools','/api/home/tasks']);
});
it('refuses missing steady-window coverage and excludes warmup and post-hold samples',()=>{
 const fixture=input();fixture.samples=[read('employee','/',1,9),read('employee','/',1,100)];fixture.pageInteractions=[];
 const result=routeLatency(fixture);expect(result.targetMet).toBe(false);expect(result.missing).toHaveLength(2);
});
it('retains strict existing read/navigation and write ceilings and exposes sample counts',()=>{
 const fixture=input();fixture.samples.push({...read('employee','/claims',500),method:'POST'});
 let result=routeLatency(fixture);expect(result.targetMet).toBe(false);expect(result.slow[0]).toMatchObject({kind:'write',samples:1,p95Ms:500,targetMs:500});
 fixture.samples[1].durationMs=499;result=routeLatency(fixture);expect(result.targetMet).toBe(true);expect(result.sparse).toHaveLength(3);
 fixture.pageInteractions[0].durationMs=1000;expect(routeLatency(fixture).targetMet).toBe(false);
});
it('does not conceal an invalid measurement as a passing sample',()=>{
 const fixture=input();fixture.samples[0].durationMs=NaN;expect(()=>routeLatency(fixture)).toThrow(RangeError);
 fixture.steadyUntil=fixture.steadyStart;expect(()=>routeLatency(fixture)).toThrow(RangeError);
});

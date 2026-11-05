import {expect,it} from 'vitest';
import {firstGroupNavigationRoutes,navigationRoutesForIteration} from '../scripts/performance/route-scheduling.mjs';
import {routePools} from '../scripts/performance/system-route-manifest.mjs';
it('uses disjoint role lanes and preserves non-group navigation counts',()=>{
 const pool=Array.from({length:12},(_,i)=>'/route/'+i);
 expect(navigationRoutesForIteration(pool,{role:'companyHR',ordinal:0,actors:2,iteration:0})).toEqual(pool.slice(0,3));
 expect(navigationRoutesForIteration(pool,{role:'companyHR',ordinal:1,actors:2,iteration:0})).toEqual(pool.slice(3,6));
 expect(navigationRoutesForIteration(pool,{role:'companyHR',ordinal:0,actors:2,iteration:1})).toEqual(pool.slice(6,9));
 expect(navigationRoutesForIteration(pool,{role:'groupHR',ordinal:0,actors:2,iteration:0})).toEqual(pool.slice(0,6));
 expect(navigationRoutesForIteration(pool,{role:'groupHR',ordinal:1,actors:2,iteration:0})).toEqual(pool.slice(6));
});
it.each([1000,5000])('can cover every group-HR route during the steady hold at%sms without removing mutation steps',think=>{
 const visited=new Set<string>();
 // Same two actors (indices0/250),10s ramp and5m steady window. GET900ms/POST400ms
 // are deliberately close to the unchanged1000ms/500ms ceilings, not zero-cost requests.
 for(let ordinal=0;ordinal<2;ordinal++){
  let now=ordinal*5000,iteration=0;
  while(now<310000){
   for(const route of navigationRoutesForIteration(routePools.groupHR,{role:'groupHR',ordinal,actors:2,iteration})){
    if(now>=10000&&now<310000)visited.add(route);now+=900+think;
   }
   if(iteration===0){now+=400+think;now+=900+think;} // initial payroll process + export
   else for(let mutation=0;mutation<3;mutation++)now+=400+think; // full create/edit/delete
   iteration++;
  }
 }
 expect([...visited].sort()).toEqual([...routePools.groupHR].sort());
});
it('covers all authorized routes when each of the 500 fixture actors completes only one cycle',()=>{
 const counts=new Map([['employee',460],['manager',20],['companyHR',18],['groupHR',2]]);
 const visited=new Set<string>();
 for(const role of ['employee','manager','companyHR'] as const){
  const actors=counts.get(role)!;
  for(let ordinal=0;ordinal<actors;ordinal++)
   for(const route of navigationRoutesForIteration(routePools[role],{role,ordinal,actors,iteration:0}))visited.add(route);
 }
 const groupRoutes=firstGroupNavigationRoutes(routePools,counts);
 expect(groupRoutes.map(routes=>routes.length)).toEqual([6,7]);
 for(const routes of groupRoutes)for(const route of routes){
  expect(routePools.groupHR).toContain(route);
  visited.add(route);
 }
 expect([...visited].sort()).toEqual([...new Set(Object.values(routePools).flat())].sort());
});
it('refuses missing actors, invalid ordinals and unknown roles',()=>{
 for(const input of [{role:'employee',ordinal:0,actors:0,iteration:0},{role:'employee',ordinal:2,actors:2,iteration:0},{role:'unknown',ordinal:0,actors:1,iteration:0},{role:'employee',ordinal:0,actors:1,iteration:-1}])
  expect(()=>navigationRoutesForIteration(['/'],input)).toThrow(RangeError);
 expect(()=>navigationRoutesForIteration([],{role:'employee',ordinal:0,actors:1,iteration:0})).toThrow(RangeError);
});

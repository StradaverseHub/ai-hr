import {existsSync,readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {validateNavigationScenarioPlan,fixtureNavigationActor,type NavigationFixtureRole,type NavigationScenario} from '../scripts/performance/navigation-protocol';
import {CENTRE_TABS,CENTRE_SECTIONS} from '../lib/ai-centre/centre-nav';
import {readRouteForMeasurement,routePool,routePools,wholeSystemRouteCount,additionalBrowserRoutes} from '../scripts/performance/system-route-manifest.mjs';
it('counts the actual distinct route pools and binds every concrete path to an existing page',()=>{
 const unique=new Set(Object.values(routePools).flat());expect(wholeSystemRouteCount).toBe(unique.size);expect(unique.size).toBeGreaterThan(60);
 for(const [role,paths]of Object.entries(routePools)){
  expect(new Set(paths).size,role).toBe(paths.length);
  for(const path of paths){const url=new URL(path,'https://fixture.invalid');expect(url.origin).toBe('https://fixture.invalid');expect(url.pathname).toMatch(/^\/(?:[a-z0-9/-]*)$/);expect(existsSync(new URL('../app'+(url.pathname==='/'?'':url.pathname)+'/page.tsx',import.meta.url)),path).toBe(true);}
 }
 for(const [role,paths]of Object.entries(additionalBrowserRoutes))for(const path of paths)expect(routePools[role as keyof typeof routePools],role).toContain(path);
});

it('covers the installed AI Centre tabs and administrator sections without granting employees admin routes',()=>{
 for(const tab of CENTRE_TABS){expect(routePools.companyHR).toContain(tab.href);if(!tab.adminOnly)expect(routePools.employee).toContain(tab.href);else expect(routePools.employee).not.toContain(tab.href);}
 for(const section of Object.values(CENTRE_SECTIONS).flat()){
  expect(routePools.groupHR).toContain(section.href);
  if(section.groupAdmin)expect(routePools.companyHR).not.toContain(section.href);
  else expect(routePools.companyHR).toContain(section.href);
  expect(routePools.employee).not.toContain(section.href);
 }
 expect(routePools.companyHR).not.toContain('/control-tower/agents/spending');
 expect(routePools.groupHR).toContain('/control-tower/agents/spending');
 expect(routePools.companyHR).not.toContain('/control-tower/agents/provider');
 expect(routePools.groupHR).toContain('/control-tower/agents/provider');
});

it('includes the default Home in every role workload',()=>{
 for(const [role,paths] of Object.entries(routePools))expect(paths,role).toContain('/');
});

it('exercises the affected Analytics, Roster and Job Description reads for both HR scopes',()=>{
 for(const role of ['companyHR','groupHR'] as const){
  for(const path of ['/analytics','/roster','/admin/job-descriptions']){
   expect(routePools[role]).toContain(path);
   expect(additionalBrowserRoutes[role]).toContain(path);
  }
 }
});

it('includes the reviewed configuration and Leave inquiry destinations in both HR load pools',()=>{
 for(const path of ['/admin/claims','/admin/holidays/groups','/admin/settings/system-labels','/admin/settings/system-labels/profile-options','/leave/employee-balances','/leave/employee-records']){
  for(const role of ['companyHR','groupHR'] as const)expect(routePools[role]).toContain(path);
  for(const role of ['employee','manager'] as const)expect(routePools[role]).not.toContain(path);
 }
});

it('counts each known AI view separately without retaining arbitrary query values',()=>{
 for(const path of new Set(Object.values(routePools).flat()))expect(readRouteForMeasurement(path)).toBe(path);
 expect(readRouteForMeasurement('/assistant?view=insights')).not.toBe(readRouteForMeasurement('/assistant?view=tools'));
 expect(readRouteForMeasurement('/assistant?view=jobs')).toBe('/assistant');
 expect(readRouteForMeasurement('/assistant?question=PRIVATE_SENTINEL')).toBe('/assistant');
 expect(readRouteForMeasurement('/api/home/tasks?employmentId=PRIVATE_SENTINEL')).toBe('/api/home/tasks');
});

// Compare actual reviewed usable scenarios to each role's HTTP pool. A route in a
// different role's pool cannot mask missing load on the actor that used the screen.
const reviewedPlan=()=>validateNavigationScenarioPlan(JSON.parse(readFileSync(new URL('../scripts/performance/navigation-scenarios.json',import.meta.url),'utf8')));
function missingUsablePressure(scenarios:readonly NavigationScenario[],pools:Readonly<Record<NavigationFixtureRole,readonly string[]>>){
 return scenarios.filter(scenario=>scenario.outcome==='usable'&&!pools[scenario.role].includes(scenario.href)).map(({id,role,href})=>({id,role,href}));
}
it('pressures every reviewed usable native or direct-content scenario in its actual fixture role',()=>{
 const plan=reviewedPlan();
 expect(plan.scenarios.filter(scenario=>scenario.outcome==='usable').length).toBeGreaterThan(0);
 expect(missingUsablePressure(plan.scenarios,routePools)).toEqual([]);
 for(const role of ['employee','manager','companyHR','groupHR']as const)for(const href of ['/attendance','/attendance/daily']){
  expect(plan.scenarios.filter(scenario=>scenario.role===role&&scenario.href===href&&scenario.outcome==='usable')).toHaveLength(1);
  expect(routePools[role]).toContain(href);
 }
});
it.each(['employee','manager','companyHR','groupHR']as const)('detects a missing Attendance Daily pressure route for %s even when other roles retain it',role=>{
 const plan=reviewedPlan(),expected=plan.scenarios.find(scenario=>scenario.role===role&&scenario.href==='/attendance/daily'&&scenario.outcome==='usable');expect(expected).toBeDefined();
 const pools={...routePools,[role]:routePools[role].filter(path=>path!=='/attendance/daily')};
 expect(Object.entries(pools).filter(([key])=>key!==role).every(([,paths])=>paths.includes('/attendance/daily'))).toBe(true);
 expect(missingUsablePressure(plan.scenarios,pools)).toEqual([{id:expected!.id,role,href:'/attendance/daily'}]);
});
it('excludes intentionally denied administrator destinations from usable-route pressure obligations',()=>{
 const denied=reviewedPlan().scenarios.filter(scenario=>scenario.outcome==='denied');
 expect(denied.some(scenario=>scenario.role==='employee'&&scenario.href==='/admin/claims')).toBe(true);
 expect(denied.some(scenario=>scenario.role==='manager'&&scenario.href==='/admin/claims')).toBe(true);
 for(const scenario of denied)expect(routePools[scenario.role]).not.toContain(scenario.href);
 expect(missingUsablePressure(denied,routePools)).toEqual([]);
});


it('selects the complete benchmark role pool from explicit fixture metadata',()=>{
 const cases=[
  {role:'employee',index:4,count:30,required:'/me/payslip',excluded:'/admin/personnel'},
  {role:'manager',index:2,count:16,required:'/approvals/history',excluded:'/admin/personnel'},
  {role:'companyHR',index:1,count:69,required:'/analytics',excluded:'/control-tower/agents/spending'},
  {role:'groupHR',index:0,count:72,required:'/control-tower/agents/spending',excluded:'/me/payslip'},
 ]as const;
 for(const expected of cases){
  // Every real fixture cohort starts with an employee grant; it cannot redefine the workload role.
  const actor={...fixtureNavigationActor(expected.index),roles:['employee'],grants:[{role:'employee',companyId:'fixture-company'}]},selected=routePool(actor);
  expect(actor.role).toBe(expected.role);
  expect(selected).toBe(routePools[expected.role]);expect(selected).toHaveLength(expected.count);
  expect(selected).toContain(expected.required);expect(selected).not.toContain(expected.excluded);
 }
});
it('refuses absent and non-catalogue benchmark roles instead of selecting another cohort',()=>{
 for(const actor of [undefined,null,{},'employee',{role:null},{role:1}])expect(()=>routePool(actor)).toThrow(RangeError);
 for(const role of ['', 'unknown','__proto__','constructor','toString'])expect(()=>routePool({role})).toThrow(RangeError);
});

import {existsSync,readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {validateNavigationScenarioPlan,type NavigationFixtureRole,type NavigationScenario} from '../scripts/performance/navigation-protocol';
import {CENTRE_TABS,CENTRE_SECTIONS} from '../lib/ai-centre/centre-nav';
import {isNativeOwnPayslipPdfPath,requireNativePreflightFixtureDay} from '../scripts/performance/native-preflight-content';
import {readRouteForMeasurement,routePools,wholeSystemRouteCount,additionalBrowserRoutes,nativePreflightRoutePlan,
 nativePreflightRouteFor,nativePreflightReadiness,assertNativePreflightRedirect,assertNativeRenderedVisit,nativeRenderedVisitFailureRule,
 requireNativeRenderedUnion,readManifestRoute,builtPageCoverage,staticPageCensusPlan,STATIC_CENSUS_SHARDS,dynamicPageCensusMatcher,serverActionRegistry,serverActionCoverage} from '../scripts/performance/system-route-manifest.mjs';
it('counts the actual distinct route pools and binds every concrete path to its source route',()=>{
 const handlers=new Set(['/admin/claims/forms','/admin/locations','/admin/rewards','/admin/rewards/plans','/admin/rewards/shared']);
 const unique=new Set(Object.values(routePools).flat());expect(wholeSystemRouteCount).toBe(unique.size);expect(unique.size).toBeGreaterThan(60);
 for(const [role,paths]of Object.entries(routePools)){
  expect(new Set(paths).size,role).toBe(paths.length);
  for(const path of paths){const url=new URL(path,'https://fixture.invalid');expect(url.origin).toBe('https://fixture.invalid');expect(url.pathname).toMatch(/^\/(?:[a-z0-9/-]*)$/);const entry=handlers.has(url.pathname)?'/route.ts':'/page.tsx';expect(existsSync(new URL('../app'+(url.pathname==='/'?'':url.pathname)+entry,import.meta.url)),path).toBe(true);}
 }
 for(const [role,paths]of Object.entries(additionalBrowserRoutes))for(const path of paths)expect(routePools[role as keyof typeof routePools],role).toContain(path);
});

it('keeps the real build inventory distinct from authorized usable browser evidence',()=>{
 const appPathRoutes={
  '/(app)/page':'/','/(app)/reports/page':'/reports','/(app)/unplanned/page':'/unplanned',
  '/(other)/reports/page':'/reports','/(app)/profile/[id]/page':'/profile/[id]',
  '/(app)/approvals/page':'/approvals','/legacy/route':'/legacy','/_not-found/page':'/_not-found',
 };
 const plan=[
  {role:'employee',requested:'/',final:'/'},
  {role:'groupHR',requested:'/legacy',final:'/reports?view=all'},
  {role:'companyHR',requested:'/approvals',final:'/approvals'},
 ];
 const observations=[
  {role:'employee',route:'/',status:'observed',destination:'expected',readiness:'heading'},
  {role:'groupHR',route:'/legacy',status:'observed',destination:'expected',readiness:'usable-content'},
  {role:'companyHR',route:'/approvals',status:'observed',destination:'expected',readiness:'scope-denial'},
  {role:'employee',route:'/unplanned',status:'observed',destination:'expected',readiness:'usable-content'},
 ];
 expect(builtPageCoverage(appPathRoutes,plan,observations)).toEqual({
  pages:5,directStaticPages:4,plannedStaticPages:3,visitedStaticPages:3,usableStaticPages:1,
  staticPagesWithoutPlan:['/unplanned'],plannedStaticPagesWithoutUsableContent:['/','/approvals'],
  dynamicPageTemplates:['/profile/[id]'],
 });
});

it('assigns every compiled static page to one shard and leaves dynamic templates for fixture journeys',()=>{
 const staticPaths=['/','/reports','/admin/personnel','/payroll','/leave','/me','/login','/feedback'];
 const pages=Object.fromEntries(staticPaths.map(path=>[path+'/page',path]));
 const manifest={
  ...pages,'/(legacy)/reports/page':'/reports','/personnel/[id]/page':'/personnel/[id]',
  '/api/actions/route':'/api/actions','/_not-found/page':'/_not-found',
 };
 const shards=Array.from({length:STATIC_CENSUS_SHARDS},(_,shard)=>staticPageCensusPlan(manifest,shard));
 expect(shards.flatMap(plan=>plan.paths).sort()).toEqual([...staticPaths].sort());
 expect(shards.every(plan=>plan.staticPageCount===staticPaths.length&&plan.dynamicTemplateCount===1)).toBe(true);
 expect(()=>staticPageCensusPlan(manifest,STATIC_CENSUS_SHARDS)).toThrow('Invalid static browser census shard');
});

it('uses compiled template precedence and only observes concrete app pages',()=>{
 const appPaths={
  '/reports/new/page':'/reports/new','/reports/[id]/page':'/reports/[id]',
  '/reports/[...path]/page':'/reports/[...path]','/profile/[id]/page':'/profile/[id]',
  '/api/item/[id]/route':'/api/item/[id]',
 };
 const routes={dynamicRoutes:[
  {page:'/reports/[id]',regex:'^/reports/([^/]+?)(?:/)?$'},
  {page:'/reports/[...path]',regex:'^/reports/(.+?)(?:/)?$'},
  {page:'/api/item/[id]',regex:'^/api/item/([^/]+?)(?:/)?$'},
 ]};
 const census=dynamicPageCensusMatcher(appPaths,routes);
 expect(census.match('/reports/new')).toBeUndefined();
 expect(census.match('/reports/fixture-draft')).toBe('/reports/[id]');
 expect(census.match('/reports/archive/fixture-draft')).toBe('/reports/[...path]');
 expect(census.match('/api/item/fixture-id')).toBeUndefined();
 expect(census.missingMatchers).toEqual(['/profile/[id]']);
});

it('credits accepted actions to their actual compiled page worker',()=>{
 const pages={'/(secure)/reports/page':'/reports','/personnel/[id]/page':'/personnel/[id]'};
 const registry=serverActionRegistry(pages,{
  node:{shared:{workers:{'app/(secure)/reports/page':{},'app/personnel/[id]/page':{}}},
   missing:{workers:{'private/unbound.js':{}}}},
  edge:{shared:{workers:{'app/(secure)/reports/page':{}}},personnel:{workers:{'app/personnel/[id]/page':{}}}},
 });
 expect(serverActionCoverage(registry,new Map([['shared',new Set(['/reports'])],['unknown',new Set(['/reports'])]]))).toEqual({
  registered:3,acceptedInPassedJourneys:1,withoutPage:1,withMatchingPageEvidence:1,
  withoutMatchingPageEvidence:0,matchedPageRegistrations:1,pagesWithMatchingEvidence:1,
  byPageWorker:[
   {path:'/personnel/[id]',registrations:2,acceptedInPassedJourneys:0},
   {path:'/reports',registrations:1,acceptedInPassedJourneys:1},
  ],
 });
});

const nativeRenderedRows=()=>nativePreflightRoutePlan().map(row=>({...row,status:200,accountObserved:true,
 elapsedMs:100,failureCount:0,readiness:nativePreflightReadiness(row.witness)}));

it('requires the complete current native role union on exactly the four primary actors',()=>{
 const plan=nativePreflightRoutePlan(),byRole=[['employee',4,30],['manager',2,16],['companyHR',1,73],['groupHR',0,76]]as const;
 expect(plan).toHaveLength(195);expect(new Set(plan.map(row=>row.requested)).size).toBe(95);
 for(const [role,actor,count]of byRole){
  const rows=plan.filter(row=>row.role===role);expect(rows).toHaveLength(count);
  expect(rows.map(row=>row.requested)).toEqual(routePools[role]);expect(rows.every(row=>row.actorIndex===actor)).toBe(true);
 }
 const observed=nativeRenderedRows();expect(requireNativeRenderedUnion(observed)).toEqual({total:195,usable:17,scopedDenials:1,renderedOnly:177});
 expect(observed.filter(row=>row.view!==null)).toHaveLength(14);
 expect(observed.filter(row=>row.redirectStatus!==null)).toHaveLength(10);
 expect(()=>requireNativeRenderedUnion(observed.slice(1))).toThrow(/incomplete/);
 expect(()=>requireNativeRenderedUnion([...observed,observed[0]])).toThrow(/incomplete/);
 expect(()=>requireNativeRenderedUnion([observed[1],...observed.slice(1)])).toThrow(/Duplicate/);
 expect(()=>nativePreflightRouteFor('employee',254,'/assistant')).toThrow(/actor\/route/);
 expect(()=>nativePreflightRouteFor('companyHR',1,'/control-tower/agents/provider')).toThrow(/actor\/route/);
});

it('refuses route substitution, silent redirect and usability without an actual reviewed witness',()=>{
 const rows=nativeRenderedRows(),row=rows.find(item=>item.role==='employee'&&item.requested==='/assistant?view=tools')!;
 expect(assertNativeRenderedVisit(row)).toBe(nativePreflightRouteFor('employee',4,'/assistant?view=tools'));
 for(const delta of [{final:'/assistant'},{final:'/assistant?view=privacy'},{final:'https://example.invalid/assistant?view=tools'},
  {redirectStatus:308},{status:404},{actorIndex:254},{accountObserved:false},{failureCount:1},{elapsedMs:90001},
  {readiness:'usable-content'},{witness:'home-card-inventory'},{fixtureBypass:true}])expect(()=>assertNativeRenderedVisit({...row,...delta})).toThrow();
 for(const view of [null,'ask','privacy'])expect(()=>assertNativeRenderedVisit({...row,view})).toThrow(/selected Assistant view/);
 const roster=rows.find(item=>item.role==='groupHR'&&item.requested==='/roster')!;
 expect(()=>assertNativeRenderedVisit({...roster,witness:null,readiness:'rendered-only'})).toThrow(/witness/);
 expect(()=>assertNativeRenderedVisit({...roster,witness:'analytics-fixture-metrics'})).toThrow(/witness/);
});

it('classifies the exact rendered assertion without using its messages or route data',()=>{
 const row=nativeRenderedRows().find(item=>item.role==='employee'&&item.requested==='/assistant?view=tools')!;
 for(const [rule,delta] of [
  ['shape',{additional:true}],['scope',{actorIndex:254}],['route',{final:'/assistant'}],
  ['redirect',{redirectStatus:308}],['view',{view:'ask'}],['status',{status:500}],
  ['identity',{accountObserved:false}],['failures',{failureCount:1}],['deadline',{elapsedMs:90001}],
  ['witness',{witness:'home-card-inventory'}],['readiness',{readiness:'usable-content'}],
 ] as const){
  expect(()=>{
   try{assertNativeRenderedVisit({...row,...delta});}
   catch(error){expect(nativeRenderedVisitFailureRule(error)).toBe(rule);throw error;}
  }).toThrow();
 }
 expect(nativeRenderedVisitFailureRule(new Error('fixture private value'))).toBeNull();
});

it('binds cross-module content and the explicit AI scope denial to the existing exact role routes',()=>{
 const rows=nativeRenderedRows();
 const expected=[
  ['employee',4,'/me/payslip','own-released-payslip','usable-content'],
  ['employee',4,'/leave','own-annual-leave-controls','usable-content'],
  ['employee',4,'/attendance/individual','own-individual-attendance-picker','usable-content'],
  ['groupHR',0,'/control-tower/agents/runs','ai-runs-group-history-controls','usable-content'],
  ['companyHR',1,'/control-tower/agents/runs','ai-runs-company-scope','scope-denial'],
  ['groupHR',0,'/admin/rewards/review-plans','rewards-shared-company-scope','usable-content'],
  ['companyHR',1,'/admin/rewards/review-plans','rewards-shared-draft-grids','usable-content'],
  ['employee',4,'/me','own-profile-identity','usable-content'],
 ] as const;
 for(const [role,actorIndex,requested,witness,readiness]of expected){
  const matching=rows.filter(row=>row.witness===witness);
  expect(matching).toHaveLength(1);
  const [row]=matching;
  expect(row).toMatchObject({role,actorIndex,requested,final:requested,readiness});
  expect(assertNativeRenderedVisit(row)).toBe(nativePreflightRouteFor(role,actorIndex,requested));
  for(const delta of [{witness:null},{readiness:'rendered-only'},{actorIndex:254},{final:'/other'},{status:403},{failureCount:1}])
   expect(()=>assertNativeRenderedVisit({...row,...delta})).toThrow();
 }
 const company=rows.find(row=>row.witness==='ai-runs-company-scope')!;
 const group=rows.find(row=>row.witness==='ai-runs-group-history-controls')!;
 expect(()=>assertNativeRenderedVisit({...company,readiness:'usable-content'})).toThrow(/readiness/);
 expect(()=>assertNativeRenderedVisit({...group,readiness:'scope-denial'})).toThrow(/readiness/);
 expect(()=>assertNativeRenderedVisit({...company,witness:group.witness,readiness:group.readiness})).toThrow(/witness/);
});

it('requires the same sealed Kuala Lumpur day at both calendar observation boundaries',()=>{
 const fixtureDay='2026-11-09';
 const beforeMidnight=new Date('2026-11-09T15:59:59.999Z');
 const atMidnight=new Date('2026-11-09T16:00:00.000Z');
 for(const witness of ['own-annual-leave-controls','own-individual-attendance-picker']){
  expect(()=>requireNativePreflightFixtureDay(witness,fixtureDay,beforeMidnight)).not.toThrow();
  expect(()=>requireNativePreflightFixtureDay(witness,fixtureDay,atMidnight)).toThrow(/current Kuala Lumpur day/);
  expect(()=>requireNativePreflightFixtureDay(witness,'2026-11-10',atMidnight)).not.toThrow();
 }
 expect(()=>requireNativePreflightFixtureDay('own-released-payslip',fixtureDay,atMidnight)).not.toThrow();
});

it('accepts only a canonical own payslip PDF address with one exact UUID',()=>{
 const uuid='10000000-0000-4000-8000-000000000004';
 const href='/me/payslip/'+uuid+'/pdf';
 expect(isNativeOwnPayslipPdfPath(href)).toBe(true);
 for(const bad of [null,'/me/payslip/'+'-'.repeat(36)+'/pdf','/me/payslip/'+uuid.replace('-','a')+'/pdf',
  href+'?disposition=inline',href+'#pdf',href+'\n','https://localhost:3443'+href,'/payroll'+href]){
  expect(isNativeOwnPayslipPdfPath(bad)).toBe(false);
 }
});

it('retains the exact HR compatibility requests and their canonical destinations',()=>{
 const aliases=[['/admin/claims/forms',308,'/admin/claims'],['/admin/locations',307,'/admin/work-locations/clocking'],
  ['/admin/rewards',307,'/admin/rewards/review-plans'],['/admin/rewards/plans',307,'/admin/rewards/review-plans'],['/admin/rewards/shared',307,'/admin/rewards/review-plans']]as const;
 for(const [requested,status,final]of aliases){
  const rows=nativeRenderedRows().filter(row=>row.requested===requested);
  expect(rows.map(row=>[row.role,row.final,row.redirectStatus,row.readiness])).toEqual([
   ['companyHR',final,status,'rendered-only'],['groupHR',final,status,'rendered-only'],
  ]);
  for(const row of rows){expect(assertNativeRenderedVisit(row).final).toBe(final);
   expect(()=>assertNativeRenderedVisit({...row,redirectStatus:null})).toThrow(/redirect chain/);
   expect(()=>assertNativeRenderedVisit({...row,final:requested})).toThrow(/final route/);
  }
  expect(()=>assertNativePreflightRedirect(requested,status,final)).not.toThrow();
  expect(()=>assertNativePreflightRedirect(requested,status,'https://localhost:3443'+final)).not.toThrow();
  for(const wrongStatus of [200,303,status===308?307:308])expect(()=>assertNativePreflightRedirect(requested,wrongStatus,final)).toThrow(/status/);
  for(const wrongLocation of ['/claims',final+'?extra=1',final+'#extra','//localhost:3443'+final,'https://example.invalid'+final,undefined])
   expect(()=>assertNativePreflightRedirect(requested,status,wrongLocation)).toThrow(/location/);
 }
 expect(()=>assertNativePreflightRedirect('/admin/locations?focus=extra',307,'/admin/work-locations/clocking')).toThrow(/Unreviewed/);
});

it('reads each exact declared route once using its expected HTTP status without following redirects',async()=>{
 for(const [requested,status,location]of [
  ['/assistant?view=tools',200,undefined],
  ['/admin/claims/forms',308,'/admin/claims'],
  ['/admin/locations',307,'https://localhost:3443/admin/work-locations/clocking'],
  ['/admin/rewards',307,'/admin/rewards/review-plans'],
  ['/admin/rewards/plans',307,'/admin/rewards/review-plans'],
  ['/admin/rewards/shared',307,'/admin/rewards/review-plans'],
  ['/admin/rewards/review-plans',200,undefined],
  ['/admin/rewards/earlier-plans',200,undefined],
  ['/rewards/reviews',200,undefined],
 ]as const){
  const response={status,headers:{location}};
  const get=vi.fn(async()=>response);
  await expect(readManifestRoute(requested,get)).resolves.toBe(response);
  expect(get).toHaveBeenCalledExactlyOnceWith(requested,status);
 }
 for(const [role,actor]of [['companyHR',1],['groupHR',0]]as const){
  for(const route of ['/admin/rewards/review-plans','/admin/rewards/earlier-plans','/rewards/reviews']){
   expect(nativePreflightRouteFor(role,actor,route)).toMatchObject({requested:route,final:route,redirectStatus:null});
  }
 }
 for(const [role,actor]of [['employee',4],['manager',2]]as const){
  for(const route of ['/admin/rewards','/admin/rewards/plans','/admin/rewards/shared','/admin/rewards/review-plans','/admin/rewards/earlier-plans','/rewards/reviews']){
   expect(()=>nativePreflightRouteFor(role,actor,route)).toThrow(/actor\/route/);
  }
 }
});

it('refuses unknown reads before issuing a request and propagates read and redirect failures',async()=>{
 const never=vi.fn();
 for(const requested of ['/admin/locations?focus=extra','/admin/claims/forms/','/admin/rewards?year=2026','/assistant?view=unreviewed','/unreviewed']){
  await expect(readManifestRoute(requested,never)).rejects.toThrow(/Unreviewed concrete read route/);
 }
 expect(never).not.toHaveBeenCalled();
 const failure=Error('owned read failed');
 const refused=vi.fn(async()=>{throw failure;});
 await expect(readManifestRoute('/claims',refused)).rejects.toBe(failure);
 expect(refused).toHaveBeenCalledExactlyOnceWith('/claims',200);
 for(const [status,location,reason]of [
  [200,'/admin/rewards/review-plans',/status/],
  [307,'/rewards/reviews',/location/],
 ]as const){
  const get=vi.fn(async()=>({status,headers:{location}}));
  await expect(readManifestRoute('/admin/rewards',get)).rejects.toThrow(reason);
  expect(get).toHaveBeenCalledExactlyOnceWith('/admin/rewards',307);
 }
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

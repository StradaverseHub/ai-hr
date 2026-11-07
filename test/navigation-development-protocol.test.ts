import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {fixtureNavigationActor,localNavigationHref,navigationExpectedText,NAVIGATION_CAPTURE_VERSION,validateNavigationCapture,validateNavigationScenarioPlan,type NavigationScenarioPlan} from '../scripts/performance/navigation-protocol';
const readPlan=()=>JSON.parse(readFileSync(new URL('../scripts/performance/navigation-scenarios.json',import.meta.url),'utf8'));
const expected={candidateSha:'a'.repeat(40),controllerSha:'b'.repeat(40),runId:123,harnessSha256:'c'.repeat(64),scenarioSha256:'d'.repeat(64),phase:'baseline' as 'baseline'|'loaded'};
const indices={groupHR:0,companyHR:1,manager:2,employee:4};
function capture(plan:NavigationScenarioPlan,phase:'baseline'|'loaded'='baseline'){
 return {schemaVersion:1,protocol:NAVIGATION_CAPTURE_VERSION,releaseAuthorized:false,fixture:plan.fixture,engine:plan.engine,...expected,phase,runAttempt:1,complete:true,
  observations:plan.scenarios.map(s=>({scenarioId:s.id,destinationId:s.destinationId,role:s.role,actorIndex:indices[s.role],href:s.href,outcome:s.outcome,readiness:s.readiness,
   status:200,finalPath:s.outcome==='denied'?'/':s.href,internalSessionObserved:true,fixtureIdentityObserved:true,elapsedMs:120,
   checks:s.checks.map(c=>({id:c.id,passed:true,observedCount:c.kind==='count'?c.minimum:1})),failures:{busy:0,unavailable:0,alerts:0,http500:0,pageErrors:0},
   ...(phase==='loaded'?{startedWith:{active:500,inSteadyWindow:true},usableWith:{active:500,inSteadyWindow:true}}:{})}))};
}
describe('closed source-reviewed navigation development protocol (not authenticated execution)',()=>{
 it('models actual role allocation across both fictional tenant cohorts',()=>{
  expect([0,1,2,4,50,250,251,252,254].map(i=>fixtureNavigationActor(i).role)).toEqual(['groupHR','companyHR','manager','employee','companyHR','groupHR','companyHR','manager','employee']);
  expect(()=>fixtureNavigationActor(500)).toThrow();expect(()=>fixtureNavigationActor(-1)).toThrow();
  expect(navigationExpectedText('$fixture.firstCompanyPersonName',299)).toBe('PERF Person 0250');
  expect(()=>navigationExpectedText('$fixture.unreviewed',1)).toThrow();
 });
 it('admits only same-origin local navigation addresses',()=>{
  expect(localNavigationHref('/leave/employee-balances')).toBe(true);
  for(const href of ['https://evil.invalid','//evil.invalid','/x\\y','/x#private','/x\n'])expect(localNavigationHref(href)).toBe(false);
 });
 it('keeps source scenarios explicitly partial and includes positive and denied native roles',()=>{
  const plan=validateNavigationScenarioPlan(readPlan());expect(plan.scenarios).toHaveLength(24);
  expect(new Set(plan.scenarios.map(s=>s.destinationId)).size).toBe(6);
  for(const id of new Set(plan.scenarios.map(s=>s.destinationId)))expect(new Set(plan.scenarios.filter(s=>s.destinationId===id).map(s=>s.role)).size).toBe(4);
  expect(validateNavigationCapture(capture(plan),plan,expected).observations).toHaveLength(24);
  expect(validateNavigationCapture(capture(plan,'loaded'),plan,{...expected,phase:'loaded'}).phase).toBe('loaded');
 });
 it('rejects heading-only proof, URL query context not yet observed, unknown steps, and duplicate scenario IDs',()=>{
  for(const edit of [(p:any)=>p.scenarios[0].checks[0].selector='main h1',(p:any)=>p.scenarios[0].href+='?different=scope',
   (p:any)=>p.scenarios[0].steps[0].kind='submit',(p:any)=>p.scenarios.push(p.scenarios[0])]){
   const plan=readPlan();edit(plan);expect(()=>validateNavigationScenarioPlan(plan)).toThrow();
  }
 });
 it('refuses cross-source/role claims, missing checks, handled failures, and incomplete captures',()=>{
  const plan=validateNavigationScenarioPlan(readPlan());
  for(const edit of [(c:any)=>c.candidateSha='0'.repeat(40),(c:any)=>c.observations[0].actorIndex=4,(c:any)=>c.observations[0].checks.pop(),
   (c:any)=>c.observations[0].failures.busy=1,(c:any)=>delete c.observations[0].failures.pageErrors,(c:any)=>c.complete=false,
   (c:any)=>c.observations[0].checks[0].observedCount=0,(c:any)=>c.observations[0].fixtureIdentityObserved=false]){
   const value=capture(plan);edit(value);expect(()=>validateNavigationCapture(value,plan,expected)).toThrow();
  }
 });
 it('requires actual started and usable observations within steady 500-user traffic',()=>{
  const plan=validateNavigationScenarioPlan(readPlan());
  for(const edit of [(c:any)=>c.observations[0].startedWith.active=499,(c:any)=>c.observations[0].usableWith.inSteadyWindow=false,
   (c:any)=>delete c.observations[0].usableWith,(c:any)=>c.observations[0].usableWith.verified=true]){
   const value=capture(plan,'loaded');edit(value);expect(()=>validateNavigationCapture(value,plan,{...expected,phase:'loaded'})).toThrow();
  }
 });
});

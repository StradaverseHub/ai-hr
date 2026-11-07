/** Actual browser producer. This captures development observations, never release authority.
 * The existing system runner owns native fixture provisioning/session creation and traffic.
 * Call once per role in each phase, with its already authenticated Playwright Page. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Page,Response} from 'playwright';
import {fixtureNavigationActor,navigationExpectedText,NAVIGATION_CAPTURE_MEMBER,NAVIGATION_CAPTURE_VERSION,validateNavigationCapture,
 type NavigationCapture,type NavigationCaptureBundle,type NavigationObservation,type NavigationScenario,type NavigationFixtureTextBindings} from './navigation-protocol';
import {navigationCleanHead,navigationSourceIdentity} from './navigation-source';
import {readNavigationFixtureBindings} from './navigation-fixture-bindings';
import {navigationScenarioEntry} from './navigation-entry';
import {clickNativeShellDestination} from './navigation-shell-browser';
const BASE='https://localhost:3443';
const failuresSelector={busy:'main[data-personnel-busy],main[data-page-busy],main [data-personnel-busy],main [data-page-busy]',
 unavailable:'main [data-read-unavailable],main [data-today-unavailable]',alerts:'main [role="alert"]'} as const;
type LoadState={active:number;inSteadyWindow:boolean};
const instrumented=new WeakSet<Page>();
async function installFailureObserver(page:Page){
 if(instrumented.has(page))return;instrumented.add(page);
 await page.addInitScript((selectors)=>{
  const counts={busy:0,unavailable:0,alerts:0};
  Object.defineProperty(window,'__aihrNavigationFailureCaptureV1',{value:counts});
  const inspect=()=>{for(const key of ['busy','unavailable','alerts']as const)counts[key]=Math.max(counts[key],document.querySelectorAll(selectors[key]).length);};
  new MutationObserver(records=>{inspect();for(const record of records)for(const node of record.addedNodes)if(node instanceof Element){
   for(const key of ['busy','unavailable','alerts']as const)if(node.matches(selectors[key])||node.querySelector(selectors[key]))counts[key]++;
  }}).observe(document,{childList:true,subtree:true,attributes:true});inspect();
 },failuresSelector);
}
async function capturedFailures(page:Page){
 return page.evaluate(()=>{
  const counts=(window as unknown as {__aihrNavigationFailureCaptureV1?:{busy:number;unavailable:number;alerts:number}}).__aihrNavigationFailureCaptureV1;
  if(!counts)throw Error('Native failure-state observer missing');return {...counts};
 });
}
export type NavigationCaptureCollector=ReturnType<typeof createNavigationCaptureCollector>;
function fixtureRealm(){
 assert(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr','Hosted fictional navigation runner required');
 assert(process.env.AIHR_PERFORMANCE_ROLE_FIXTURE==='true','Fictional native-role fixture required');
 const database=new URL(process.env.DATABASE_URL??'');
 assert(database.hostname==='127.0.0.1'&&database.pathname==='/ai_hr_dev','Isolated fictional navigation database required');
}
export function createNavigationCaptureCollector({phase,sourceRoot=process.cwd()}:{phase:'baseline'|'loaded';sourceRoot?:string}){
 fixtureRealm();assert(phase==='baseline'||phase==='loaded','Unknown navigation phase');
 const candidateSha=navigationCleanHead(sourceRoot),controllerSha=process.env.AIHR_CI_CONTROL_HEAD??'';
 assert(candidateSha===process.env.AIHR_CI_HEAD&&/^[a-f0-9]{40}$/.test(controllerSha),'Exact navigation candidate/controller required');
 const runId=Number(process.env.GITHUB_RUN_ID);assert(Number.isSafeInteger(runId)&&runId>0&&process.env.GITHUB_RUN_ATTEMPT==='1','First hosted navigation attempt required');
 const identity=navigationSourceIdentity(sourceRoot,candidateSha),fixtureBindings=readNavigationFixtureBindings(),observations:NavigationObservation[]=[],seen=new Set<string>();
 let sealed=false;
 return {
  phase,
  async captureActor(page:Page,actorIndex:number,loadState?:()=>LoadState){
   assert(!sealed,'Navigation capture already sealed');fixtureRealm();
   const actor=fixtureNavigationActor(actorIndex),scenarios=identity.plan.scenarios.filter(row=>row.role===actor.role);
   assert(scenarios.length>0&&!scenarios.some(row=>seen.has(row.id)),'Navigation role missing or captured twice');
   assert(phase==='baseline'||typeof loadState==='function','Loaded navigation needs actual traffic state');
   for(const scenario of scenarios){
    const bindings=fixtureBindings.get(actorIndex);assert(bindings&&bindings.actorName===actor.name,'Native fictional actor binding missing');
    const observation=await captureScenario(page,actorIndex,scenario,phase,bindings,loadState);
    observations.push(observation);seen.add(scenario.id);
   }
  },
  finish():NavigationCapture{
   assert(!sealed,'Navigation capture already sealed');sealed=true;
   assert(navigationCleanHead(sourceRoot)===candidateSha,'Navigation source changed while executing');
   return validateNavigationCapture({schemaVersion:1,protocol:NAVIGATION_CAPTURE_VERSION,releaseAuthorized:false,fixture:identity.plan.fixture,engine:identity.plan.engine,
    candidateSha,controllerSha,runId,runAttempt:1,harnessSha256:identity.harnessSha256,scenarioSha256:identity.scenarioSha256,phase,complete:true,observations},identity.plan,
    {candidateSha,controllerSha,runId,harnessSha256:identity.harnessSha256,scenarioSha256:identity.scenarioSha256,phase});
  },
 };
}
async function captureScenario(page:Page,actorIndex:number,scenario:NavigationScenario,phase:'baseline'|'loaded',bindings:Readonly<NavigationFixtureTextBindings>,loadState?:()=>LoadState):Promise<NavigationObservation>{
 const actor=fixtureNavigationActor(actorIndex),entry=navigationScenarioEntry(scenario),started=performance.now(),deadline=started+90000;
 const remaining=()=>{const ms=Math.floor(deadline-performance.now());assert(ms>0,'Navigation scenario deadline exceeded');return ms;};
 const sample=()=>{const state=loadState?.();if(phase==='loaded')assert(state?.active===500&&state.inSteadyWindow===true,'Navigation must start and finish within steady 500-user load');return state?{active:state.active,inSteadyWindow:state.inSteadyWindow}:undefined;};
 const startedWith=sample(),failures={busy:0,unavailable:0,alerts:0,http500:0,pageErrors:0};
 const response=(r:Response)=>{if(new URL(r.url()).origin===BASE&&r.status()>=500)failures.http500++;};
 const pageError=()=>{failures.pageErrors++;};
 const consoleError=(message:{type():string})=>{if(message.type()==='error')failures.pageErrors++;};
 page.on('response',response);page.on('pageerror',pageError);page.on('console',consoleError);
 try{
  await installFailureObserver(page);
  const cookies=await page.context().cookies(BASE);
  assert(cookies.some(cookie=>cookie.name==='__Host-aihr_internal'&&cookie.value&&cookie.secure&&cookie.httpOnly&&cookie.path==='/'),'Native authenticated fixture session missing');
  const origin=await page.goto(BASE+(scenario.outcome==='denied'?scenario.href:scenario.originHref),{waitUntil:'domcontentloaded',timeout:remaining()});
  assert(origin?.status()===200,'Navigation origin did not finish successfully');
  const originFailures=await capturedFailures(page);for(const key of ['busy','unavailable','alerts']as const)failures[key]+=originFailures[key];
  if(scenario.outcome==='usable'&&entry.kind==='shell-menu')await clickNativeShellDestination(page,scenario.href,remaining);
  if(scenario.outcome==='usable'&&entry.selector){
   const anchor=page.locator(entry.selector);
   await anchor.first().waitFor({state:'visible',timeout:remaining()});
   assert(await anchor.count()===1,'Canonical native destination link missing or ambiguous');
   assert(await anchor.getAttribute('href')===scenario.href,'Native destination address differs from reviewed scenario');
   assert(await anchor.isVisible()&&await anchor.isEnabled(),'Native destination is not actionable');
   await anchor.click({timeout:remaining()});
  }
  const target=new URL(scenario.outcome==='denied'?'/':scenario.href,BASE);
  await page.waitForURL(url=>url.origin===BASE&&url.pathname===target.pathname&&url.search===target.search,{timeout:remaining()});
  await page.locator('main').waitFor({state:'visible',timeout:remaining()});
  // Workforce content can contain many actors' names. Only the unique native
  // signed-in account trigger can bind the session to this exact fixture actor.
  const account=page.locator('button[data-tour="account"]');
  await account.first().waitFor({state:'visible',timeout:remaining()});
  assert(await account.count()===1&&await account.isEnabled({timeout:remaining()}),'Native signed-in account control missing or ambiguous');
  const signedInName=account.getByText(actor.name,{exact:true});
  await signedInName.first().waitFor({state:'visible',timeout:remaining()});
  assert(await signedInName.count()===1&&await signedInName.innerText({timeout:remaining()})===actor.name,'Native signed-in fixture identity differs');
  if(scenario.outcome==='denied')assert(await page.locator('main [data-navigation-destination="'+scenario.destinationId+'"]').count()===0,'Denied private destination remained rendered');
  for(const step of scenario.steps){
   const details=page.locator(step.selector);
   await details.first().waitFor({state:'visible',timeout:remaining()});
   assert(await details.count()===1,'Native disclosure missing or ambiguous');
   assert(await details.evaluate(element=>element.tagName==='DETAILS'),'Only native read disclosure steps are permitted');
   if(await details.getAttribute('open',{timeout:remaining()})===null){
    const summary=details.locator(':scope > summary');
    await summary.first().waitFor({state:'visible',timeout:remaining()});
    assert(await summary.count()===1&&await summary.isEnabled({timeout:remaining()}),'Native disclosure trigger missing, ambiguous or unavailable');
    await summary.click({timeout:remaining()});
   }
  }
  const checks:NavigationObservation['checks']=[];
  for(const check of scenario.checks){
   const matches=page.locator(check.selector);await matches.first().waitFor({state:'visible',timeout:remaining()});
   const visible=[];for(const match of await matches.all())if(await match.isVisible())visible.push(match);
   assert(visible.length>0,'Reviewed usable-content selector has no visible result');
   if(check.kind==='count'||check.kind==='fixture-roster-rows')assert(visible.length>=check.minimum&&(check.maximum===undefined||visible.length<=check.maximum),'Usable-content count differs');
   if(check.kind==='fixture-roster-rows'){
    const ids=new Set<string>();
    for(const row of visible){
     const id=await row.getAttribute('data-roster-employment-id',{timeout:remaining()});
     assert(id&&!ids.has(id)&&Object.hasOwn(bindings.rosterScope,id),'Roster rendered an unknown, duplicate or out-of-scope native fixture employment');ids.add(id);
     const expected=bindings.rosterScope[id];if(expected!==null)assert((await row.innerText({timeout:remaining()})).includes(expected),'Roster omitted the independently seeded employee identity');
    }
   }else if(check.kind==='enabled'){
    assert(await visible[0].evaluate(element=>element.tagName.toLowerCase())===check.tag&&await visible[0].isEnabled(),'Reviewed native control is unavailable');
   }else if(check.kind==='text-exact')assert((await visible[0].innerText({timeout:remaining()})).trim()===navigationExpectedText(check.expected,actorIndex,bindings),'Expected exact native fixture content differs');
   else if(check.kind==='text')assert((await visible[0].innerText({timeout:remaining()})).includes(navigationExpectedText(check.expected,actorIndex,bindings)),'Expected independent fixture content missing');
   else if(check.kind==='value')assert(await visible[0].inputValue({timeout:remaining()})===navigationExpectedText(check.expected,actorIndex,bindings),'Expected native control value differs');
   else if(check.kind==='attribute')assert(await visible[0].getAttribute(check.name)===check.expected,'Reviewed native control attribute differs');
   checks.push({id:check.id,passed:true,observedCount:visible.length});
  }
  const observed=await capturedFailures(page);for(const key of ['busy','unavailable','alerts']as const)failures[key]+=observed[key];
  assert(Object.values(failures).every(count=>count===0),'Navigation rendered failure state or browser/server error');
  const usableWith=sample();remaining();
  return {entry:entry.kind,scenarioId:scenario.id,destinationId:scenario.destinationId,role:actor.role,actorIndex,href:scenario.href,outcome:scenario.outcome,readiness:scenario.readiness,
   status:200,finalPath:target.pathname,internalSessionObserved:true,fixtureIdentityObserved:true,elapsedMs:performance.now()-started,checks,failures,
   ...(startedWith?{startedWith}:{}),...(usableWith?{usableWith}:{})};
 }finally{page.off('response',response);page.off('pageerror',pageError);page.off('console',consoleError);}
}
/** The runner retains both phases in the same fixed artifact member. No credentials/content. */
export function writeNavigationCaptureBundle(outputDirectory:string,baseline:NavigationCapture,loaded?:NavigationCapture){
 assert(baseline.phase==='baseline'&&baseline.complete&&(!loaded||loaded.phase==='loaded'&&loaded.complete),'Complete navigation phases required');
 if(loaded)for(const field of ['candidateSha','controllerSha','runId','runAttempt','harnessSha256','scenarioSha256']as const)assert(loaded[field]===baseline[field],'Navigation phases have different source/run identities');
 const bundle:NavigationCaptureBundle={schemaVersion:1,protocol:NAVIGATION_CAPTURE_VERSION,releaseAuthorized:false,baseline,...(loaded?{loaded}:{})};
 writeFileSync(join(outputDirectory,NAVIGATION_CAPTURE_MEMBER),JSON.stringify(bundle,null,2)+'\n',{mode:0o600,flag:'wx'});
 return bundle;
}

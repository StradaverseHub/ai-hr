/** Closed development capture protocol. Validation alone never authenticates it. */
import {createHash} from 'node:crypto';
import {navigationScenarioEntry} from './navigation-entry';
export const NAVIGATION_CAPTURE_VERSION='aihr-navigation-development/v2' as const;
export const NAVIGATION_CAPTURE_ARTIFACT='system-http-browser-development-evidence';
export const NAVIGATION_CAPTURE_MEMBER='navigation-browser-capture.json';
export const NAVIGATION_SCENARIO_FILE='scripts/performance/navigation-scenarios.json';
export const NAVIGATION_HARNESS_ROOTS=['scripts/performance','lib/navigation','lib/navigation-workspaces.ts','lib/ai-centre/centre-nav.ts','lib/security-center-navigation.ts','packs/performance/onehr/tab-model.ts','deploy/admission','.github/workflows/alpha-focused-checks.yml','components/sidebar.tsx','components/nav-flyout.tsx','components/navigation-submenus.tsx','components/system-labels-tabs.tsx','components/claims-tabs.tsx','components/attendance-tabs.tsx','components/holiday-tabs.tsx','components/statutory-tabs.tsx','app/admin/rewards/admin-tabs.tsx','components/leave/leave-inquiry-nav.tsx'] as const;
export type NavigationFixtureRole='employee'|'manager'|'companyHR'|'groupHR';
export type NavigationCheck={id:string;selector:string}&(
 {kind:'enabled';tag:'a'|'button'|'input'|'select'|'textarea'}|
 {kind:'count'|'fixture-roster-rows';minimum:number;maximum?:number}|
 {kind:'text'|'text-exact';expected:string}|{kind:'value';expected:string}|
 {kind:'attribute';name:'href'|'aria-current'|'data-testid';expected:string}
);
export type NavigationEntry='canonical-link'|'ai-centre-tab'|'shell-menu'|'direct-route-content';
export type NavigationFixtureTextBindings={actorName:string;actorEmployeeCode:string;firstCompanyPersonName:string;activeHeadcount:string;historicalPayrollMonth:string;seedToday:string;seedMonth:string;firstSavedHistoryTitle?:string;rosterScope:Readonly<Record<string,string|null>>};
export type NavigationScenario={entry?:NavigationEntry;id:string;destinationId:string;role:NavigationFixtureRole;href:string;originHref:string;
 outcome:'usable'|'denied';readiness:'controls'|'populated';steps:{kind:'open-details';selector:string}[];checks:NavigationCheck[]};
export type NavigationScenarioPlan={schemaVersion:1;fixture:'system-load-v1';engine:'chromium';scope:string;scenarios:NavigationScenario[]};
export type NavigationObservation={entry:NavigationEntry;scenarioId:string;destinationId:string;role:NavigationFixtureRole;actorIndex:number;href:string;
 outcome:'usable'|'denied';readiness:'controls'|'populated';status:number;finalPath:string;internalSessionObserved:true;fixtureIdentityObserved:true;
 elapsedMs:number;checks:{id:string;passed:true;observedCount:number}[];failures:{busy:number;unavailable:number;alerts:number;http500:number;pageErrors:number};
 startedWith?:{active:number;inSteadyWindow:boolean};usableWith?:{active:number;inSteadyWindow:boolean}};
export type NavigationCapture={schemaVersion:1;protocol:typeof NAVIGATION_CAPTURE_VERSION;releaseAuthorized:false;fixture:'system-load-v1';engine:'chromium';
 candidateSha:string;controllerSha:string;runId:number;runAttempt:1;harnessSha256:string;scenarioSha256:string;phase:'baseline'|'loaded';
 complete:boolean;observations:NavigationObservation[]};
export type NavigationCaptureBundle={schemaVersion:1;protocol:typeof NAVIGATION_CAPTURE_VERSION;releaseAuthorized:false;baseline:NavigationCapture;loaded?:NavigationCapture};
const roles:readonly string[]=['employee','manager','companyHR','groupHR'];
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(v);
export function localNavigationHref(value:unknown):value is string{
 if(typeof value!=='string'||value.length>4096||!value.startsWith('/')||value.startsWith('//')||/[\u0000-\u001f\\]/.test(value))return false;
 const url=new URL(value,'https://localhost:3443');return url.origin==='https://localhost:3443'&&!url.hash;
}
const closed=(value:object,keys:readonly string[])=>Object.keys(value).every(key=>keys.includes(key));
/** A fixture role comes from the actual system-fixture allocation, not a claim in a capture. */
export function fixtureNavigationActor(index:number):{role:NavigationFixtureRole;name:string}{
 if(!Number.isSafeInteger(index)||index<0||index>=500)throw Error('Invalid fictional navigation actor');
 const local=index%250,company=Math.floor(local/50),position=local%50;
 return {role:position===0&&company===0?'groupHR':position<2?'companyHR':position<4?'manager':'employee',name:'PERF Person '+String(index).padStart(4,'0')};
}
export function navigationExpectedText(expected:string,actorIndex:number,bindings?:Readonly<NavigationFixtureTextBindings>):string{
 const nativeKeys=['actorName','actorEmployeeCode','activeHeadcount','historicalPayrollMonth','seedToday','seedMonth','firstSavedHistoryTitle']as const;
 for(const key of nativeKeys)if(expected==='$fixture.'+key){const value=bindings?.[key];if(typeof value!=='string'||!value)throw Error('Required native fictional fixture content is unseeded');return value;}
 if(expected==='$fixture.firstCompanyPersonName')return 'PERF Person '+String(Math.floor(actorIndex/50)*50).padStart(4,'0');
 if(expected.startsWith('$fixture.'))throw Error('Unknown navigation fixture binding');
 return expected;
}
export function validateNavigationScenarioPlan(value:unknown):NavigationScenarioPlan{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid navigation scenario plan');
 const plan=value as NavigationScenarioPlan;
 if(!closed(plan,['schemaVersion','fixture','engine','scope','scenarios'])||plan.schemaVersion!==1||plan.fixture!=='system-load-v1'||plan.engine!=='chromium'
  ||typeof plan.scope!=='string'||!plan.scope.trim()||!Array.isArray(plan.scenarios)||!plan.scenarios.length||plan.scenarios.length>1024)throw Error('Invalid navigation scenario plan');
 const seen=new Set<string>();
 for(const row of plan.scenarios){
  if(!row||typeof row!=='object'||!closed(row,['entry','id','destinationId','role','href','originHref','outcome','readiness','steps','checks'])||!id(row.id)||seen.has(row.id)||!id(row.destinationId)||!roles.includes(row.role)
   ||row.entry!==undefined&&!['canonical-link','ai-centre-tab','shell-menu','direct-route-content'].includes(row.entry)||!localNavigationHref(row.href)||!localNavigationHref(row.originHref)||row.href.includes('?')||row.originHref.includes('?')||!['usable','denied'].includes(row.outcome)||!['controls','populated'].includes(row.readiness)
   ||!Array.isArray(row.steps)||row.steps.length>8||!Array.isArray(row.checks)||row.checks.length>16||row.outcome==='usable'&&!row.checks.length)throw Error('Invalid navigation scenario');
  seen.add(row.id);navigationScenarioEntry(row);
  for(const step of row.steps)if(!step||!closed(step,['kind','selector'])||step.kind!=='open-details'||typeof step.selector!=='string'||step.selector.length>512||!step.selector.trim())throw Error('Invalid navigation disclosure step');
  const checks=new Set<string>();
  for(const check of row.checks){
   if(!check||typeof check!=='object'||!id(check.id)||checks.has(check.id)||typeof check.selector!=='string'||!check.selector.trim()||check.selector.length>512
    ||/\bh[1-6]\b|^\s*(?:body|main)\s*$/i.test(check.selector))throw Error('Heading/shell-only navigation checks are not usable-content evidence');
   checks.add(check.id);
   if(check.kind==='enabled'){
    if(!closed(check,['id','selector','kind','tag'])||!['a','button','input','select','textarea'].includes(check.tag))throw Error('Invalid navigation control check');
   }else if(check.kind==='count'||check.kind==='fixture-roster-rows'){
    if(!closed(check,['id','selector','kind','minimum','maximum'])||!Number.isSafeInteger(check.minimum)||check.minimum<1||check.maximum!==undefined&&(!Number.isSafeInteger(check.maximum)||check.maximum<check.minimum))throw Error('Invalid navigation count check');
   }else if(check.kind==='text'||check.kind==='text-exact'||check.kind==='value'){
    if(!closed(check,['id','selector','kind','expected'])||typeof check.expected!=='string'||check.expected.length>1024||check.kind!=='value'&&!check.expected.trim())throw Error('Invalid navigation value check');
   }else if(check.kind==='attribute'){
    if(!closed(check,['id','selector','kind','name','expected'])||!['href','aria-current','data-testid'].includes(check.name)||typeof check.expected!=='string'||!check.expected||check.expected.length>1024)throw Error('Invalid navigation attribute check');
   }else throw Error('Unknown navigation check');
  }
  if(row.readiness==='populated'&&!row.checks.some(check=>check.kind==='text'||check.kind==='text-exact'))throw Error('Populated navigation proof needs independent expected content');
 }
 return plan;
}
/** This only reconciles already authenticated bytes with independently read contracts. */
export function validateNavigationCapture(value:unknown,plan:NavigationScenarioPlan,expected:{candidateSha:string;controllerSha:string;runId:number;harnessSha256:string;scenarioSha256:string;phase:'baseline'|'loaded'}):NavigationCapture{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Missing navigation capture');
 const capture=value as NavigationCapture;
 if(!closed(capture,['schemaVersion','protocol','releaseAuthorized','fixture','engine','candidateSha','controllerSha','runId','runAttempt','harnessSha256','scenarioSha256','phase','complete','observations'])
  ||capture.schemaVersion!==1||capture.protocol!==NAVIGATION_CAPTURE_VERSION||capture.releaseAuthorized!==false||capture.fixture!==plan.fixture||capture.engine!==plan.engine||capture.runAttempt!==1||capture.complete!==true
  ||Object.entries(expected).some(([key,value])=>capture[key as keyof NavigationCapture]!==value)||!Array.isArray(capture.observations)||capture.observations.length!==plan.scenarios.length)throw Error('Navigation capture identity or completeness differs');
 const seen=new Set<string>();
 for(const row of capture.observations){
  const scenario=plan.scenarios.find(item=>item.id===row?.scenarioId);
  if(!scenario||seen.has(row.scenarioId)||!closed(row,['entry','scenarioId','destinationId','role','actorIndex','href','outcome','readiness','status','finalPath','internalSessionObserved','fixtureIdentityObserved','elapsedMs','checks','failures','startedWith','usableWith'])
   ||row.entry!==(scenario.entry??'canonical-link')||row.destinationId!==scenario.destinationId||row.role!==scenario.role||fixtureNavigationActor(row.actorIndex).role!==scenario.role||row.href!==scenario.href||row.outcome!==scenario.outcome||row.readiness!==scenario.readiness
   ||row.status!==200||row.finalPath!==(scenario.outcome==='denied'?'/':new URL(scenario.href,'https://localhost:3443').pathname)||row.internalSessionObserved!==true||row.fixtureIdentityObserved!==true
   ||!Number.isFinite(row.elapsedMs)||row.elapsedMs<0||row.elapsedMs>90000||!Array.isArray(row.checks)||row.checks.length!==scenario.checks.length
   ||!row.failures||!closed(row.failures,['busy','unavailable','alerts','http500','pageErrors'])||(['busy','unavailable','alerts','http500','pageErrors']as const).some(key=>row.failures[key]!==0))throw Error('Navigation scenario did not prove usable native content');
  seen.add(row.scenarioId);
  if(new Set(row.checks.map(check=>check.id)).size!==row.checks.length||scenario.checks.some(check=>!row.checks.some(result=>closed(result,['id','passed','observedCount'])&&result.id===check.id&&result.passed===true&&Number.isSafeInteger(result.observedCount)&&result.observedCount>=1
   &&(check.kind!=='count'&&check.kind!=='fixture-roster-rows'||result.observedCount>=check.minimum&&(check.maximum===undefined||result.observedCount<=check.maximum)))))throw Error('Navigation check coverage differs');
  if([row.startedWith,row.usableWith].some(state=>state!==undefined&&(!state||!closed(state,['active','inSteadyWindow'])||!Number.isSafeInteger(state.active)||state.active<0||typeof state.inSteadyWindow!=='boolean')))throw Error('Invalid navigation traffic state');
  if(capture.phase==='loaded'&&![row.startedWith,row.usableWith].every(state=>state?.active===500&&state.inSteadyWindow===true))throw Error('Navigation content was not usable during steady 500-user traffic');
 }
 return capture;
}

// Separate native-only observations. The v2 development contract above stays 48.
export const NATIVE_SHELL_BASELINE_VERSION='aihr-native-shell-baseline/v1' as const;
export const NATIVE_SHELL_LEGACY_SCENARIO_SHA256='6dae3cc787e5da49e8f00eb30e0d093f7669f8fff3f87aa5f966a00d9397ca7a';
const nativeShellCases=[
 {id:'shell.payrollProcess.employee.hidden-denied',destinationId:'shell.payrollProcess',role:'employee',href:'/payroll',actorIndex:4},
 {id:'shell.payrollProcess.manager.hidden-denied',destinationId:'shell.payrollProcess',role:'manager',href:'/payroll',actorIndex:2},
 {id:'shell.analytics.employee.hidden-denied',destinationId:'shell.analytics',role:'employee',href:'/analytics',actorIndex:4},
 {id:'shell.analytics.manager.hidden-denied',destinationId:'shell.analytics',role:'manager',href:'/analytics',actorIndex:2},
] as const;
export const NATIVE_HIDDEN_SHELL_CASES=Object.freeze(nativeShellCases.map(row=>Object.freeze({...row,
 entry:'shell-menu',shellVisibility:'hidden',originHref:'/',outcome:'denied',readiness:'controls',
 steps:Object.freeze([]),checks:Object.freeze([]),
} as const)));
export const nativeHiddenShellCasesSha256=()=>createHash('sha256').update(JSON.stringify(NATIVE_HIDDEN_SHELL_CASES)).digest('hex');
export type NativeHiddenShellCase=(typeof NATIVE_HIDDEN_SHELL_CASES)[number];
export type NativeHiddenShellObservation=Pick<NativeHiddenShellCase,'id'|'destinationId'|'role'|'actorIndex'|'entry'|'shellVisibility'|'originHref'|'href'|'outcome'>&{
 originStatus:200;redirectStatus:307;finalStatus:200;finalHref:'/';internalSessionObserved:true;fixtureIdentityObserved:true;
 privateDestinationAbsent:true;elapsedMs:number;
};
export type NativeShellIdentity=Pick<NavigationCapture,'candidateSha'|'controllerSha'|'runId'|'harnessSha256'|'scenarioSha256'>;
export type NativeShellBaseline=NativeShellIdentity&{
 schemaVersion:1;protocol:typeof NATIVE_SHELL_BASELINE_VERSION;releaseAuthorized:false;runAttempt:1;
 legacyCases:48;nativeCases:52;retiredDocuments:8;extensionSha256:string;complete:true;observations:NativeHiddenShellObservation[];
};
const exactKeys=(value:object,keys:readonly string[])=>Object.keys(value).length===keys.length&&closed(value,keys);

/** Reconciles a source-bound native observation. A matching record grants no authority. */
export function validateNativeShellBaseline(value:unknown,expected:NativeShellIdentity):NativeShellBaseline{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Native shell baseline missing');
 const capture=value as NativeShellBaseline;
 if(!exactKeys(capture,['schemaVersion','protocol','releaseAuthorized','candidateSha','controllerSha','runId','runAttempt','harnessSha256',
  'scenarioSha256','legacyCases','nativeCases','retiredDocuments','extensionSha256','complete','observations'])
  ||capture.schemaVersion!==1||capture.protocol!==NATIVE_SHELL_BASELINE_VERSION||capture.releaseAuthorized!==false||capture.runAttempt!==1
  ||capture.legacyCases!==48||capture.nativeCases!==52||capture.retiredDocuments!==8||capture.complete!==true
  ||capture.scenarioSha256!==NATIVE_SHELL_LEGACY_SCENARIO_SHA256||capture.extensionSha256!==nativeHiddenShellCasesSha256()
  ||![capture.candidateSha,capture.controllerSha].every(sha=>typeof sha==='string'&&/^[a-f0-9]{40}(?![\s\S])/.test(sha))
  ||typeof capture.harnessSha256!=='string'||!/^[a-f0-9]{64}(?![\s\S])/.test(capture.harnessSha256)
  ||!Number.isSafeInteger(capture.runId)||capture.runId<1
  ||(['candidateSha','controllerSha','runId','harnessSha256','scenarioSha256'] as const).some(key=>capture[key]!==expected[key])
  ||!Array.isArray(capture.observations)||capture.observations.length!==NATIVE_HIDDEN_SHELL_CASES.length)throw Error('Native shell baseline identity or completeness differs');
 for(const [index,scenario] of NATIVE_HIDDEN_SHELL_CASES.entries()){
  const row=capture.observations[index];
  const caseKeys=['id','destinationId','role','actorIndex','entry','shellVisibility','originHref','href','outcome'] as const;
  if(!row||typeof row!=='object'||Array.isArray(row)||!exactKeys(row,[...caseKeys,'originStatus','redirectStatus','finalStatus','finalHref',
   'internalSessionObserved','fixtureIdentityObserved','privateDestinationAbsent','elapsedMs'])
   ||caseKeys.some(key=>row[key]!==scenario[key])||fixtureNavigationActor(row.actorIndex).role!==row.role
   ||row.originStatus!==200||row.redirectStatus!==307||row.finalStatus!==200||row.finalHref!=='/'
   ||row.internalSessionObserved!==true||row.fixtureIdentityObserved!==true||row.privateDestinationAbsent!==true
   ||!Number.isFinite(row.elapsedMs)||row.elapsedMs<0||row.elapsedMs>90000)throw Error('Native hidden shell observation differs');
 }
 return capture;
}

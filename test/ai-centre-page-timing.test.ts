/** AI v2 R8 (where the seconds go): the server reads that run before AI Centre and Control Tower pages can paint, timed
 * one by one on fictional data. There is no browser lane in focused checks, so this times the page's own owners in the
 * page's own order with the page's own arguments (app/layout.tsx, app/assistant/page.tsx, app/assistant/centre/inbox.tsx,
 * app/control-tower/**), as the signed-in group administrator and as an employee. It does not time the session
 * resolution (getSession needs a request), React rendering, RSC serialisation or the network: those are named as not
 * measured in the findings.
 *
 * For each page it reports two totals from the same measurements:
 *  - `asWritten`: the page's current order, where each stage waits for the one before (a stage the page already runs with
 *    Promise.all counts once, as its slowest read);
 *  - `ifIndependentReadsOverlap`: the critical path when only true data dependencies wait (a read that needs the
 *    company scope waits for it; the bell's reads wait for the notification dispatch that writes them).
 * Nothing is changed or asserted about what the reads return beyond that they ran. Spans carry labels and counts only.
 * Output: ai-centre-page-timing.json in the evidence folder and one AIHR_AI_CENTRE_PAGE_TIMING line. */
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
// getScopeIds reads the company-scope cookie; outside a request there is none, which is the default "all allowed".
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>undefined}),headers:async()=>new Headers()}));
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee,setReportingLine} from '../core/org';
import {requestLeave} from '../packs/leave/service';
import {viewerIdentity} from '../lib/viewer';
import {canConfigureAccess} from '../core/access-configuration-editor';
import {workforceViewScope} from '../core/workforce-access';
import {listPrincipals} from '../lib/principals';
import {allowedCompanies,listApprovalHistory} from '../core/read';
import {getScopeIds} from '../lib/scope';
import {letterNavigation} from '../core/letter-navigation';
import {getOnboardingStatus} from '../core/onboarding';
import {dispatchNotifications,listNotifications,unreadNotificationCount} from '../core/notifications';
import {listPendingTasks} from '../core/approvals-inbox';
import {onboardingNavigation,onboardingNotices,onboardingTasks,onboardingUnreadNoticeCount} from '../packs/lifecycle/service';
import {assistantLauncherFor} from '../core/assistant-launcher';
import {mayUseAssistant} from '../core/assistant-grant';
import {canConfigureIdentityEmail} from '../lib/identity/email-settings';
import {isModuleEnabledOrFalse} from '../core/entitlements';
import {isAdmin} from '../lib/authz-model';
import {loadAiWorkspace} from '../core/ai-workspace';
import {assistantBrowserConversationScope} from '../app/assistant/conversation-scope';
import {listOwnAssistantChats} from '../core/assistant-threads';
import {allowedModuleActionEntries} from '../core/assistant-actions/module-action-entries';
import {digestPreview,latestDailyDigest} from '../core/digest/daily-digest';
import {openExceptionsAcrossRuns} from '../core/payroll-anomaly';
import {proposeActions} from '../core/agent-actions';
import {recordReadiness} from '../core/record-readiness';
import {workerRunGate} from '../core/agent-registry/controls';
import {RECOMMENDER_WORKER} from '../core/recommenders/leave-decision';
import {orchestrationQueue} from '../core/hr-orchestrator';
import {agreementView,controlTowerView} from '../core/control-tower';
import {aiManagementView} from '../core/ai-management';
import {aiInventoryView,aiManagementAlerts} from '../core/ai-inventory';
import {agentStatuses} from '../core/control-domains';
import {listWorkers} from '../core/agent-registry/views';
import {outcomeSummary} from '../core/agent-registry/export';
import {agentBuildList} from '../core/agent-build-list';
import {assistantOutcomes} from '../core/assistant-outcomes';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';

const RUNS=6,WARMUP=1;
/** One read of a page: `stage` is its position in the page as written (equal stages already run together); `deps` are
 * the reads whose results it really needs. `run` returns a value later reads may use. */
type Read=Readonly<{label:string;stage:number;deps?:readonly string[];run:(ctx:SessionContext,got:Map<string,unknown>)=>unknown}>;
type Page=Readonly<{id:string;persona:'admin'|'employee';firstPaint:boolean;reads:readonly Read[]}>;
const scopeOf=(got:Map<string,unknown>)=>got.get('scope') as string[];
const modules=(ctx:SessionContext)=>({attendance:isModuleEnabledOrFalse(ctx,'attendance'),claims:isModuleEnabledOrFalse(ctx,'claims'),performance:isModuleEnabledOrFalse(ctx,'performance'),rewards:isModuleEnabledOrFalse(ctx,'rewards')});
const canApprove=(ctx:SessionContext)=>isAdmin(ctx)||(ctx.roles??[]).includes('manager');
const on=(ctx:SessionContext,code:string)=>isModuleEnabledOrFalse(ctx,code);
const skip=async()=>undefined;

/** app/layout.tsx: every hard load (first open, reload) of any signed-in page. Soft navigation keeps it. */
const rootLayout=(persona:'admin'|'employee'):Page=>({id:'root-layout.'+persona,persona,firstPaint:true,reads:[
 {label:'listPrincipals',stage:0,run:()=>listPrincipals()},
 {label:'allowedCompanies',stage:1,run:ctx=>allowedCompanies(ctx)},
 {label:'scope',stage:2,deps:['allowedCompanies'],run:async(_ctx,got)=>getScopeIds((got.get('allowedCompanies') as {id:string}[]).map(row=>row.id))},
 {label:'viewerIdentity',stage:3,run:ctx=>viewerIdentity(ctx)},
 {label:'canConfigureAccess',stage:3,run:ctx=>canConfigureAccess(ctx)},
 {label:'workforceViewScope',stage:3,run:ctx=>isAdmin(ctx)?skip():workforceViewScope(ctx)},
 {label:'letterNavigation',stage:4,deps:['scope'],run:(ctx,got)=>on(ctx,'employees')?letterNavigation(ctx,scopeOf(got)):skip()},
 {label:'getOnboardingStatus',stage:5,run:ctx=>getOnboardingStatus(ctx)},
 {label:'dispatchNotifications',stage:6,run:ctx=>on(ctx,'notifications')&&isAdmin(ctx)?dispatchNotifications(ctx).catch(()=>undefined):skip()},
 {label:'listPendingTasks',stage:7,deps:['scope'],run:(ctx,got)=>listPendingTasks(ctx,scopeOf(got),modules(ctx))},
 {label:'onboardingNavigation',stage:8,run:ctx=>on(ctx,'lifecycle')?onboardingNavigation(ctx):skip()},
 {label:'onboardingTasks',stage:9,run:ctx=>on(ctx,'lifecycle')?onboardingTasks(ctx):skip()},
 {label:'onboardingNotices.unread',stage:10,run:ctx=>on(ctx,'lifecycle')?onboardingNotices(ctx):skip()},
 {label:'onboardingNotices.read',stage:10,run:ctx=>on(ctx,'lifecycle')?onboardingNotices(ctx,true):skip()},
 {label:'onboardingUnreadNoticeCount',stage:11,run:ctx=>on(ctx,'lifecycle')?onboardingUnreadNoticeCount(ctx):skip()},
 {label:'unreadNotificationCount.info',stage:12,deps:['dispatchNotifications'],run:ctx=>on(ctx,'notifications')?unreadNotificationCount(ctx,undefined,{action:false}):skip()},
 {label:'unreadNotificationCount.action',stage:13,deps:['dispatchNotifications'],run:ctx=>on(ctx,'notifications')?unreadNotificationCount(ctx,undefined,{action:true}):skip()},
 {label:'listNotifications.unread',stage:14,deps:['dispatchNotifications'],run:ctx=>on(ctx,'notifications')?listNotifications(ctx,undefined,{limit:12,read:false,action:false}):skip()},
 {label:'listNotifications.tasks',stage:15,deps:['dispatchNotifications'],run:ctx=>on(ctx,'notifications')?listNotifications(ctx,undefined,{limit:12,read:false,action:true}):skip()},
 {label:'listNotifications.read',stage:16,deps:['dispatchNotifications'],run:ctx=>on(ctx,'notifications')?listNotifications(ctx,undefined,{limit:12,read:true}):skip()},
 {label:'listApprovalHistory',stage:17,run:ctx=>canApprove(ctx)?listApprovalHistory(ctx,{from:new Date(Date.now()-90*86400000).toISOString(),limit:10}):skip()},
 {label:'assistantLauncherFor',stage:18,run:ctx=>assistantLauncherFor(ctx)},
 {label:'mayUseAssistant',stage:19,run:ctx=>mayUseAssistant(ctx).catch(()=>undefined)},
 {label:'canConfigureIdentityEmail',stage:20,run:ctx=>canConfigureIdentityEmail(ctx)},
]});
/** app/assistant/page.tsx, the Ask view for a person with the Assistant. The Inbox badge streams (Suspense), so it is
 * timed but not on the first-paint path. */
const ask=(persona:'admin'|'employee'):Page=>({id:'assistant.ask.'+persona,persona,firstPaint:true,reads:[
 {label:'loadAiWorkspace',stage:0,run:ctx=>loadAiWorkspace(ctx,{includeHistory:true,includeGovernance:false})},
 {label:'analysisScope',stage:1,run:ctx=>isAdmin(ctx)?allowedCompanies(ctx):skip()},
 {label:'conversationScope',stage:2,run:ctx=>assistantBrowserConversationScope(ctx)},
 {label:'listOwnAssistantChats',stage:3,deps:['conversationScope'],run:(ctx,got)=>listOwnAssistantChats(ctx,{},got.get('conversationScope') as string)},
 {label:'allowedModuleActionEntries',stage:4,deps:['loadAiWorkspace'],run:(ctx,got)=>allowedModuleActionEntries(ctx,(got.get('loadAiWorkspace') as Awaited<ReturnType<typeof loadAiWorkspace>>).jobModules)},
]});
/** app/assistant/centre/inbox.tsx AiCentreInbox (the Inbox tab), and the streamed badge every other tab shows. */
const inbox=(persona:'admin'|'employee'):Page=>({id:'assistant.inbox.'+persona,persona,firstPaint:true,reads:[
 {label:'allowedCompanies',stage:0,run:ctx=>allowedCompanies(ctx)},
 {label:'scope',stage:1,deps:['allowedCompanies'],run:async(_ctx,got)=>getScopeIds((got.get('allowedCompanies') as {id:string}[]).map(row=>row.id))},
 {label:'listPendingTasks',stage:2,deps:['scope'],run:(ctx,got)=>listPendingTasks(ctx,scopeOf(got),modules(ctx))},
 {label:'digestPreview',stage:3,deps:['listPendingTasks'],run:(ctx,got)=>digestPreview(ctx,{approvals:got.get('listPendingTasks') as Awaited<ReturnType<typeof listPendingTasks>>,companyIds:scopeOf(got)})},
 {label:'latestDailyDigest',stage:3,run:ctx=>latestDailyDigest(ctx)},
 {label:'openExceptionsAcrossRuns',stage:4,run:ctx=>isAdmin(ctx)&&on(ctx,'payroll')?openExceptionsAcrossRuns(ctx,{limit:100}):skip()},
 {label:'proposeActions',stage:4,run:ctx=>isAdmin(ctx)&&on(ctx,'payroll')?proposeActions(ctx):skip()},
 {label:'recordReadiness',stage:4,run:ctx=>isAdmin(ctx)?recordReadiness(ctx,{peopleLimit:0}):skip()},
 {label:'recommenderGate',stage:5,deps:['listPendingTasks'],run:(ctx,got)=>(got.get('listPendingTasks') as {kind:string}[]).some(task=>task.kind==='leave')?workerRunGate(ctx,RECOMMENDER_WORKER):skip()},
]});
const controlTower:readonly Page[]=[
 {id:'control-tower.overview',persona:'admin',firstPaint:true,reads:[
  {label:'orchestrationQueue',stage:0,run:ctx=>orchestrationQueue(ctx)},
  {label:'controlTowerView',stage:1,run:ctx=>on(ctx,'payroll')?controlTowerView(ctx):skip()},
  {label:'agreementView',stage:2,run:ctx=>agreementView(ctx)}]},
 {id:'control-tower.agents.features',persona:'admin',firstPaint:true,reads:[
  {label:'agentStatuses',stage:0,run:ctx=>agentStatuses(ctx).catch(()=>null)},
  {label:'listWorkers',stage:1,run:ctx=>listWorkers(ctx)},
  {label:'outcomeSummary',stage:1,run:ctx=>outcomeSummary(ctx).catch(()=>null)},
  {label:'aiManagementView',stage:2,run:ctx=>aiManagementView(ctx,'',{})},
  {label:'aiManagementAlerts',stage:3,deps:['aiManagementView'],run:(ctx,got)=>aiManagementAlerts(ctx,got.get('aiManagementView') as Awaited<ReturnType<typeof aiManagementView>>)}]},
 {id:'control-tower.agents.overview',persona:'admin',firstPaint:true,reads:[
  {label:'aiManagementView',stage:0,run:ctx=>aiManagementView(ctx,'',{})},
  {label:'aiManagementAlerts',stage:1,deps:['aiManagementView'],run:(ctx,got)=>aiManagementAlerts(ctx,got.get('aiManagementView') as Awaited<ReturnType<typeof aiManagementView>>)}]},
 {id:'control-tower.agents.inventory',persona:'admin',firstPaint:true,reads:[
  {label:'aiManagementView',stage:0,run:ctx=>aiManagementView(ctx,'',{})},
  {label:'aiInventoryView',stage:1,deps:['aiManagementView'],run:(ctx,got)=>aiInventoryView(ctx,got.get('aiManagementView') as Awaited<ReturnType<typeof aiManagementView>>)},
  {label:'aiManagementAlerts',stage:2,deps:['aiManagementView'],run:(ctx,got)=>aiManagementAlerts(ctx,got.get('aiManagementView') as Awaited<ReturnType<typeof aiManagementView>>)}]},
 {id:'control-tower.readiness',persona:'admin',firstPaint:true,reads:[{label:'recordReadiness',stage:0,run:ctx=>recordReadiness(ctx)}]},
 {id:'control-tower.actions',persona:'admin',firstPaint:true,reads:[{label:'proposeActions',stage:0,run:ctx=>proposeActions(ctx)}]},
 {id:'control-tower.exceptions',persona:'admin',firstPaint:true,reads:[{label:'openExceptionsAcrossRuns',stage:0,run:ctx=>openExceptionsAcrossRuns(ctx)}]},
 {id:'control-tower.opportunities',persona:'admin',firstPaint:true,reads:[
  {label:'agentBuildList',stage:0,run:ctx=>agentBuildList(ctx,90)},
  {label:'assistantOutcomes',stage:1,run:ctx=>assistantOutcomes(ctx,90)}]},
 {id:'control-tower.how-it-works',persona:'admin',firstPaint:true,reads:[{label:'agentStatuses',stage:0,run:ctx=>agentStatuses(ctx)}]},
];
const PAGES:readonly Page[]=[rootLayout('admin'),rootLayout('employee'),ask('admin'),ask('employee'),inbox('admin'),inbox('employee'),...controlTower];

let b:Base;const people={} as Record<'admin'|'employee',SessionContext>;
async function hire(base:Base,name:string,role:'employee'|'manager'|'hr_admin'){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);await grantAssistant(adminCtx(base),{appUserId:userId});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:hired.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'17.25',effectiveOn:todayInKualaLumpur()});
 return{ctx:{...await entitledCtx(base,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext,employmentId:hired.employmentId};
}

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-page-timing-passphrase-0123456789');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-page-timing-proposal-secret-0123456789abcdef');
 await resetDb();b=await seedBase();
 for(const code of ['assistant','claims','notifications','attendance','lifecycle'])await setModule(b.tenantId,code,'active');
 await seedEntitlement(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,annualDays:17.25,validFrom:'2020-01-01'});
 const admin=await hire(b,'Fictional Page Administrator','hr_admin');people.admin=admin.ctx;
 people.employee=(await hire(b,'Fictional Page Employee','employee')).ctx;
 // Two of the administrator's reports have pending leave, so the Inbox, the bell and the approval reads have rows.
 for(const name of ['Fictional Page Applicant One','Fictional Page Applicant Two']){
  const applicant=await hire(b,name,'employee');
  await setReportingLine(adminCtx(b),{subordinateEmploymentId:applicant.employmentId,managerEmploymentId:admin.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
  const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));
  await requestLeave(applicant.ctx,{employmentId:applicant.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:next.toISOString().slice(0,10),endDate:next.toISOString().slice(0,10),durationType:'full_day',reason:'Fictional page timing'});
 }
});

const median=(values:readonly number[])=>{if(!values.length)return 0;const sorted=[...values].sort((x,y)=>x-y),mid=(sorted.length-1)/2;return Math.round(((sorted[Math.floor(mid)]+sorted[Math.ceil(mid)])/2)*10)/10;};
/** Totals for one page from per-read medians: as written (stages in order, each its slowest read) and on the data-dependency
 * critical path. */
function totals(page:Page,ms:Readonly<Record<string,number>>){
 const stages=[...new Set(page.reads.map(read=>read.stage))].sort((x,y)=>x-y);
 const asWritten=stages.reduce((sum,stage)=>sum+Math.max(...page.reads.filter(read=>read.stage===stage).map(read=>ms[read.label]??0)),0);
 const finish=new Map<string,number>();
 for(const read of page.reads)finish.set(read.label,Math.max(0,...(read.deps??[]).map(dep=>finish.get(dep)??0))+(ms[read.label]??0));
 return{asWritten:Math.round(asWritten*10)/10,ifIndependentReadsOverlap:Math.round(Math.max(0,...finish.values())*10)/10};
}

describe('AI Centre and Control Tower server reads before first paint',()=>{
 it('times every read of each page in its own order, as an administrator and as an employee',async()=>{
  const samples:Record<string,Record<string,number[]>>={};
  for(let run=0;run<RUNS;run++)for(const page of PAGES){
   const got=new Map<string,unknown>(),ctx=people[page.persona];
   for(const read of page.reads){
    const started=performance.now();got.set(read.label,await read.run(ctx,got));const ms=performance.now()-started;
    if(run>=WARMUP)((samples[page.id]??={})[read.label]??=[]).push(Math.round(ms*100)/100);
   }
   // The reads ran and returned their owners' results (an undefined only where the page itself skips the read).
   expect(got.size,page.id).toBe(page.reads.length);
  }
  const report=Object.fromEntries(PAGES.map(page=>{const ms=Object.fromEntries(Object.entries(samples[page.id]).map(([label,values])=>[label,median(values)]));
   return[page.id,{persona:page.persona,reads:page.reads.length,medianMs:ms,...totals(page,ms)}];}));
  const dir=process.env.RUNNER_TEMP?join(process.env.RUNNER_TEMP,'aihr-focused'):join(process.cwd(),'.review-evidence');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'ai-centre-page-timing.json'),JSON.stringify({kind:'ai-centre.page-timing',version:1,runs:RUNS,warmup:WARMUP,
   note:'Server reads only, called in page order on the CI fixture; session resolution, rendering, serialisation and network are not included.',
   ...(process.env.GITHUB_RUN_ID?{runId:process.env.GITHUB_RUN_ID}:{}),report,samples},null,1));
  process.stdout.write('AIHR_AI_CENTRE_PAGE_TIMING '+JSON.stringify(Object.fromEntries(Object.entries(report).map(([id,row])=>[id,{asWritten:row.asWritten,overlap:row.ifIndependentReadsOverlap}])))+'\n');
  // The employee's Ask view and Inbox read the same owners as the administrator's, minus the administrator-only ones.
  expect(report['assistant.inbox.admin'].medianMs.listPendingTasks).toBeGreaterThan(0);
  for(const page of PAGES)expect(Object.keys(report[page.id].medianMs).length,page.id).toBe(page.reads.length);
 },240_000);
});

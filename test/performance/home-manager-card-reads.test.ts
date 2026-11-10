/** Hosted diagnostic: manager Home card and Today section reads at the fictional worker-comparison
 * fixture size. 500 fictional actors, 2,000 pending Claims each, 180 attendance days and one closed
 * historical payroll run per company, mirroring scripts/performance/system-fixture-owner.mjs.
 * It runs only when the hosted focused controller selects this file; every other Vitest run skips it.
 * It never changes an installation and supplies no release evidence. */
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {loadavg} from 'node:os';
import {join,relative} from 'node:path';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>{
 const file='test/performance/home-manager-card-reads.test.ts';
 let selected=false;
 try{selected=(JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]') as unknown[]).includes(file);}catch{selected=false;}
 const hostedFocused=selected&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'
  &&process.env.GITHUB_WORKFLOW==='alpha-focused-checks'&&Boolean(process.env.AIHR_FOCUSED_EVIDENCE_DIR);
 // The comparison's two-worker cell gives each application worker eight connections.
 if(hostedFocused)process.env.AIHR_DB_POOL_MAX='8';
 return {hostedFocused,session:undefined as unknown,run:null as string|null};
});
vi.mock('../../lib/session',()=>({getSession:async()=>state.session}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
import {and,eq,sql} from 'drizzle-orm';
import {client as applicationClient,withIndependentTransactions,withSharedReadSnapshot,withTenant,type SessionContext} from '../../db/client';
import type {SharedReadStats} from '../../db/shared-read';
import * as s from '../../db/schema';
import {hireEmployee} from '../../core/org';
import {createClaimType} from '../../packs/claims/service';
import {closeBatch,createBatch,generatePayslips} from '../../packs/payroll/service';
import {performanceFixtureCalendar} from '../../scripts/performance/fixture-workload.mjs';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../../core/attendance-workflow';
import {ensureStandardRule} from '../../core/attendance-rule';
import {MODULE_CATALOG} from '../../packs/catalog';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {OwnHomeConfigurationRead} from '../../core/employee-home-configuration';
import {readEmployeeHomeGreeting} from '../../core/employee-home-greeting';
import {readEmployeeHomeSummary} from '../../core/employee-home-summary';
import {readEmployeeHomeTasks} from '../../core/employee-home-tasks';
import {readEmployeeHomeToday} from '../../core/employee-home-today';
import {readEmployeeHomeCalendar} from '../../core/employee-home-calendar';
import {celebrationsResponse,noticesResponse,teamResponse,timeOffResponse} from '../../app/api/home/sharing-responses';
import {GET} from '../../app/api/home/sharing-initial/route';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from '../harness';
import {readOwnLeaveInputsTx} from '../../core/own-leave-inputs';
import {hasEligibleLeaveTypeForTx,hasEligibleLeaveTypeFrom,leaveBalancesTx,leaveEntitlementBreakdowns} from '../../core/read';
import {leaveTypeApplySummaries,myCurrentLeaveSnapshotCards,nextApprovedLeavePresenceTx} from '../../packs/leave/service';
import {employeeClockingLocationLabelsTx,ownClockTodayHomeTx,ownClockTodaySummaryTx,readOwnClockDayInputsTx,resolvedScheduleForTx} from '../../packs/attendance/service';
import {readEmployeeHomeTimeOff} from '../../core/employee-home-time-off';
import {stagedHomeSummary,stagedHomeTimeOff,stagedHomeToday} from '../helpers/home-staged-cards';
import type {Tx} from '../../db/client';
import {readCalendarWindowInputsTx,withStagedHomeReads,type CalendarWindowInputs} from '../../core/calendar-window-inputs';
import {holidayDatesFor,originalHolidayCalendarFor} from '../../core/holidays';
import {replacementHolidayCalendarProjectionsTx} from '../../core/holiday-replacement-read';
import {provenCompanyDatesTx} from '../../core/employment-company';
import {approvedLeavePresenceByEmploymentTx,leaveCalendarPresenceByEmploymentTx} from '../../packs/leave/service';
import {buildTemplateEntitlementResolver,type TemplateEntitlementResolver} from '../../core/entitlement-template';
import type {OwnLeaveInputs} from '../../core/own-leave-inputs';
import {homeCalendarMonth} from '../../lib/employee-home-calendar';

const CARDS=['summary','greeting','today','notices','tasks','timeOff','team','celebrations','calendar'] as const;
type Card=typeof CARDS[number];
const claimsPerEmployee=2000,attendanceDays=180,hiredOn='2025-01-01';
type Actor={index:number;tenant:number;company:number;role:string;employmentId:string;companyId:string;ctx:SessionContext};
const root=process.cwd();
const report:Record<string,unknown>={kind:'HOME_MANAGER_CARD_READS_DIAGNOSTIC',releaseEligible:false,fictional:true};
const evidence=()=>{
 const dir=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
 if(dir)writeFileSync(join(dir,'home-manager-card-reads.json'),JSON.stringify(report,null,1));
};
const print=(label:string,value:unknown)=>console.info('[home-card-diagnostic] '+label+' '+JSON.stringify(value));

// Closed observation hooks already present in the application. They receive no identity or values.
type Stage={run:string|null;stage:string;card?:string;at:number};
const stages:Stage[]=[];
function installObservers(){
 (globalThis as {__aihrPerfHomeStage?:(stage:string,card?:string)=>void}).__aihrPerfHomeStage=(stage,card)=>{
  stages.push({run:state.run,stage,card,at:performance.now()});
 };
 (globalThis as {__aihrPerfBeginTransaction?:(poolMax:number)=>{acquired:()=>void;finished:()=>void}}).__aihrPerfBeginTransaction=()=>{
  const startedAt=performance.now(),run=state.run,ownerFrames=transactionOwner();let acquiredAt:number|undefined,tripsAt=0;
  return {acquired(){acquiredAt=performance.now();tripsAt=tripCounter();},finished(){
   const now=performance.now();
   transactions.push({run,owner:ownerFrames,startedAt,waitMs:(acquiredAt??now)-startedAt,totalMs:now-startedAt,trips:tripCounter()-tripsAt});
  }};
 };
}
type Transaction={run:string|null;owner:string;startedAt:number;waitMs:number;totalMs:number;trips:number};
let tripCounter:()=>number=()=>0;
const transactions:Transaction[]=[];
function transactionOwner(){
 const limit=Error.stackTraceLimit;Error.stackTraceLimit=40;
 const stack=new Error().stack??'';Error.stackTraceLimit=limit;
 const frames=[];
 for(const line of stack.split('\n').slice(1)){
  const match=/at (?:async )?(?:(\S+) \()?(.+?):(\d+):\d+\)?$/.exec(line.trim());
  if(!match)continue;
  const file=relative(root,match[2].replace(/^file:\/\//,''));
  if(file.startsWith('..')||file.startsWith('node_modules')||file.startsWith('db/')||file.startsWith('test/')||file.includes('settle-read-group'))continue;
  frames.push((match[1]??'?')+'@'+file+':'+match[3]);
  if(frames.length===3)break;
 }
 return frames.join(' < ');
}

/** Each fixture tenant's seed base, for the Before payroll owner fixtures that act through the owners' own commands. */
const seededBases=new Map<number,Base>();
async function seedTenant(t:number,today:string){
 const b=await seedBase();seededBases.set(t,b);
 await owner.db.insert(s.tenantModule).values(MODULE_CATALOG.filter(m=>!m.isCore&&(m.packBacked||m.code==='system_testing'||m.code==='system_explorer'))
  .map(m=>({tenantId:b.tenantId,moduleCode:m.code,status:'active' as const}))).onConflictDoNothing();
 await setModule(b.tenantId,'notifications','active');
 await setModule(b.tenantId,'assistant','active');
 const ctx=await entitledCtx(b);
 const type=await createClaimType(ctx,{code:'PERF',name:'Performance claim',defaultTaxable:false,requiresReceipt:false});
 const companies:{companyId:string;departmentId:string}[]=[];
 for(let c=0;c<5;c++){
  let companyId=b.companyId,departmentId=b.deptA;
  if(c){
   const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:`PERF Company ${t}-${c}`,country:'MY'}).returning();companyId=company.id;
   const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId,name:'Performance department'}).returning();departmentId=department.id;
  }
  companies.push({companyId,departmentId});
 }
 const users:(Omit<Actor,'ctx'>&{userId:string;personId:string})[]=[];
 for(let i=0;i<250;i++){
  const index=t*250+i,c=Math.floor(i/50),position=i%50,company=companies[c];
  const role=position===0&&c===0?'groupHR':position<2?'companyHR':position<4?'manager':'employee';
  const hired=await hireEmployee(ctx,{person:{fullName:`PERF Person ${String(index).padStart(4,'0')}`,primaryEmail:`person${index}@example.invalid`},
   companyId:company.companyId,departmentId:company.departmentId,employmentType:'full_time',hiredOn,employeeCode:'PERF'+String(index).padStart(4,'0')});
  users.push({index,tenant:t,company:c,role,employmentId:hired.employmentId,companyId:company.companyId,userId:randomUUID(),personId:hired.personId});
 }
 const onboardedAt=new Date(hiredOn+'T00:00:00+08:00');
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.userId,tenantId:b.tenantId,personId:u.personId,workosUserId:'perf_'+u.userId,onboardedAt})));
 const grants=users.flatMap(u=>{
  const rows=[{tenantId:b.tenantId,appUserId:u.userId,role:'employee',companyId:u.companyId as string|null}];
  if(u.role==='manager')rows.push({tenantId:b.tenantId,appUserId:u.userId,role:'manager',companyId:u.companyId});
  if(u.role==='companyHR'||u.role==='groupHR')rows.push({tenantId:b.tenantId,appUserId:u.userId,role:'hr_admin',companyId:u.role==='groupHR'?null:u.companyId});
  if(u.role==='groupHR')for(const r of ['payroll_partner','performance_comp_partner'])rows.push({tenantId:b.tenantId,appUserId:u.userId,role:r,companyId:null});
  // One employee of company 0 manages in company 2 only: a grant that must never widen to its own company.
  if(u.index%250===6)rows.push({tenantId:b.tenantId,appUserId:u.userId,role:'manager',companyId:companies[2].companyId});
  return rows;
 });
 await owner.db.insert(s.roleAssignment).values(grants as typeof s.roleAssignment.$inferInsert[]);
 await owner.client`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
  select ${b.tenantId}::uuid,e.id,${type.id}::uuid,1,${today}::date,'pending',now()-n*interval '1 minute'
  from unnest(${users.map(u=>u.employmentId)}::uuid[]) e(id)cross join generate_series(1,${claimsPerEmployee}::integer)n`;
 await owner.client`insert into attendance(tenant_id,employment_id,attendance_date,check_in_at,check_out_at,status,worked_minutes,ot_minutes)
  select ${b.tenantId}::uuid,e.id,${today}::date-n,'09:00'::time,'17:00'::time,'present',480,0
  from unnest(${users.map(u=>u.employmentId)}::uuid[]) e(id)cross join generate_series(0,${attendanceDays-1}::integer)n
  order by e.id,n desc`;
 await owner.db.insert(s.compensation).values(users.map(u=>({tenantId:b.tenantId,employmentId:u.employmentId,basicSalary:'5000',validFrom:hiredOn})));
 // Same payroll state as the fixture: a current draft and a closed historical run per company.
 const {historicalMonth}=performanceFixtureCalendar(today);
 for(const company of companies){
  await createBatch(ctx,{companyId:company.companyId,payPeriod:today.slice(0,7)});
  const {batchId}=await createBatch(ctx,{companyId:company.companyId,payPeriod:historicalMonth});
  await generatePayslips(ctx,{batchId});await closeBatch(ctx,{batchId});
 }
 for(const company of companies){
  const approver=users.find(u=>u.companyId===company.companyId&&['companyHR','groupHR'].includes(u.role))!;
  await saveAttendanceWorkflow(ctx,{companyId:company.companyId,applicationType:'irregularity',routingVersion:4,code:'PERF',name:'Fictional performance approval',priority:100,active:true,
   criteria:{employeeIds:users.filter(u=>u.companyId===company.companyId&&u.role==='employee').map(u=>u.employmentId)},
   stages:[{name:'HR',mode:'any_one',sources:[{kind:'specific_employee',employmentIds:[approver.employmentId]}],hrAlternative:false}],cc:[]});
  await setAttendanceWorkflowEnabled(ctx,company.companyId,'irregularity',true);
 }
 // Same administrative lines as the fixture: managers at positions 2 and 3 each have ten reports.
 await owner.db.insert(s.reportingLine).values(users.filter(u=>u.role==='manager').flatMap(u=>users.filter(v=>v.company===u.company
  &&v.index%50>=4+(u.index%50-2)*10&&v.index%50<14+(u.index%50-2)*10).map(v=>({tenantId:b.tenantId,managerEmploymentId:u.employmentId,
   subordinateEmploymentId:v.employmentId,lineType:'administrative' as const,validFrom:hiredOn}))));
 const standard=await ensureStandardRule(ctx);expect(standard.created).toBe(true);
 // Dated facts every Home owner reads, so equivalence compares real rows: national, tentative and one company's
 // own holidays inside the Summary lookahead and the calendar grid, one replacement day, approved full and part
 // days, a pending request, leave balances, and one employment that ended yesterday.
 const day=(offset:number)=>new Date(Date.parse(today+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
 const [national]=await owner.db.insert(s.holiday).values({tenantId:b.tenantId,country:'MY',holidayDate:day(3),name:'Fictional national holiday'}).returning();
 await owner.db.insert(s.holiday).values([
  {tenantId:b.tenantId,country:'MY',holidayDate:day(2),name:'Fictional tentative holiday',tentative:true},
  {tenantId:b.tenantId,country:'MY',holidayDate:day(-2),name:'Fictional recent holiday'},
  {tenantId:b.tenantId,country:'MY',companyId:companies[1].companyId,holidayDate:day(5),name:'Fictional company holiday'},
 ]);
 const pick=(position:number)=>users.find(u=>u.index===t*250+position)!;
 const [policy]=await owner.db.insert(s.replacementHolidayPolicy).values({tenantId:b.tenantId,companyId:pick(4).companyId,effectiveFrom:today,regime:'MY_EA_60D',
  confirmed:true,restMode:'scheduled_rest',searchDays:30,reason:'Fictional replacement policy',createdBy:'fixture'}).returning();
 await owner.db.insert(s.replacementHoliday).values({tenantId:b.tenantId,employmentId:pick(4).employmentId,companyId:pick(4).companyId,sourceHolidayId:national.id,policyId:policy.id,
   sourceDate:day(3),sourceName:national.name,inputDigest:'fictional',status:'allocated',replacementDate:day(4),reason:'Fictional replacement'});
 await owner.db.insert(s.leaveRequest).values([
  {tenantId:b.tenantId,employmentId:pick(4).employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:day(1),endDate:day(2),days:'2',status:'approved' as const},
  {tenantId:b.tenantId,employmentId:pick(4).employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:day(6),endDate:day(6),days:'1',status:'pending' as const},
  {tenantId:b.tenantId,employmentId:pick(2).employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:today,endDate:today,days:'0.5',durationType:'half_day_am',status:'approved' as const},
  {tenantId:b.tenantId,employmentId:pick(54).employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:day(-1),endDate:day(8),days:'8',status:'approved' as const},
 ]);
 await owner.db.insert(s.leaveLedger).values([2,3,4,54].map(position=>({tenantId:b.tenantId,employmentId:pick(position).employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual' as const,days:'14',effectiveOn:hiredOn})));
 await owner.client`update employment set terminated_on=${day(-1)}::date where id=${pick(49).employmentId}::uuid`;
 const entitlements=(await entitledCtx(b)).entitlements;
 return users.map(u=>{
  const actorGrants=grants.filter(g=>g.appUserId===u.userId).map(g=>({role:g.role,companyId:g.companyId}));
  return {...u,ctx:{tenantId:b.tenantId,userId:u.userId,personId:u.personId,grants:actorGrants,roles:[...new Set(actorGrants.map(g=>g.role))],entitlements}};
 });
}

function readers(ctx:SessionContext,employmentId:string,month:string):Record<Card,()=>Promise<unknown>>{
 const signal=new AbortController().signal,configurationRead=new OwnHomeConfigurationRead(ctx,employmentId,signal);
 return {
  team:()=>teamResponse(ctx,employmentId,{},signal),
  celebrations:()=>celebrationsResponse(ctx,employmentId,{},signal),
  notices:()=>noticesResponse(ctx,employmentId,signal),
  timeOff:()=>timeOffResponse(ctx,employmentId,signal),
  greeting:()=>readEmployeeHomeGreeting(ctx,employmentId,'en',undefined,configurationRead),
  summary:()=>readEmployeeHomeSummary(ctx,employmentId,'en','replacement',configurationRead),
  tasks:()=>readEmployeeHomeTasks(ctx,employmentId,1,configurationRead),
  today:()=>readEmployeeHomeToday(ctx,employmentId,signal),
  calendar:()=>readEmployeeHomeCalendar(ctx,employmentId,month,undefined,signal),
 };
}

/** Complete values of every page owner besides the four sections, wrapped exactly as the page wraps them. */
async function fullPageOwners(ctx:SessionContext,scopeIds:string[]):Promise<Record<string,()=>Promise<unknown>>>{
 const database=await import('../../db/client'),requestScope=await import('../../lib/request-read-scope');
 const home=await import('../../core/employee-home'),performanceService=await import('../../packs/performance/service');
 const assistant=await import('../../core/assistant-grant'),inbox=await import('../../core/approvals-inbox');
 const loops=await import('../../core/loops/cards'),letters=await import('../../core/letter-requests'),reviews=await import('../../core/home-leave-review-presentation');
 const {isModuleEnabled}=await import('../../core/entitlements');
 const modules={attendance:isModuleEnabled(ctx,'attendance'),claims:isModuleEnabled(ctx,'claims'),performance:isModuleEnabled(ctx,'performance'),rewards:isModuleEnabled(ctx,'rewards')};
 const inPage=<T,>(read:()=>Promise<T>)=>()=>database.withSharedReadSnapshot(ctx,read,undefined,requestScope.requestReadScope());
 return {
  'page.identity':inPage(()=>home.readEmployeeHomeIdentity(ctx)),
  'page.greetingIdentity':inPage(()=>home.readEmployeeHomeGreetingIdentity(ctx)),
  'page.performanceBlock':inPage(()=>performanceService.getPerformanceHomeBlock(ctx,scopeIds)),
  'page.assignedPerformance':inPage(async()=>performanceService.hasAssignedPerformanceWork(ctx,scopeIds)),
  'page.assistant':inPage(()=>assistant.mayUseAssistant(ctx)),
  'page.layoutApprovals':()=>database.withBackgroundReadWork(ctx.tenantId,inPage(()=>inbox.pendingTaskSummary(ctx,scopeIds,modules,{deferClaimPreview:true}))),
  'needs.pendingTaskSummary':inPage(()=>inbox.pendingTaskSummary(ctx,scopeIds,modules)),
  'needs.loopCards':inPage(()=>loops.readLoopCards(ctx,{scopeIds,admin:false})),
  'needs.letterRequests':inPage(()=>letters.countWaitingLetterRequests(ctx,scopeIds)),
  'needs.ownLeaveReviews':inPage(()=>reviews.readHomeOwnLeaveReviewIndex(ctx)),
  'needs.cancellationReviews':inPage(()=>reviews.readHomeLeaveCancellationReviewIndex(ctx)),
  'needs.decisionReviews':inPage(()=>reviews.readHomeLeaveDecisionReviewIndex(ctx)),
 };
}

const errorFact=(error:unknown)=>({name:(error as Error)?.name??typeof error,code:(error as {code?:string})?.code??null,
 reason:(error as {reason?:string})?.reason??null,message:String((error as Error)?.message??error).slice(0,240)});

/** The owners the server-rendered Today page combines for a personal (employee or manager) layout. */
async function todayReaders(today:string){
 const reads=await import('../../components/today/reads');
 const {todayAudience}=await import('../../lib/today/audience');
 const {readMyPayrollReadiness}=await import('../../core/pre-salary/person-items');
 const {allowedCompanies}=await import('../../core/read');
 const {isModuleEnabled}=await import('../../core/entitlements');
 const inbox=await import('../../core/approvals-inbox');
 const loops=await import('../../core/loops/cards');
 const letters=await import('../../core/letter-requests');
 const reviews=await import('../../core/home-leave-review-presentation');
 const performanceService=await import('../../packs/performance/service');
 const home=await import('../../core/employee-home');
 const assistant=await import('../../core/assistant-grant');
 const database=await import('../../db/client');
 const requestScope=await import('../../lib/request-read-scope');
 // The page wraps these owners in its render's read scope exactly so (components/today/today-page.tsx, app/layout.tsx,
 // components/performance-home/performance-home.tsx, app/page.tsx).
 const inPage=<T,>(ctx:SessionContext,read:()=>Promise<T>)=>database.withSharedReadSnapshot(ctx,read,undefined,requestScope.requestReadScope());
 const readers=async(ctx:SessionContext):Promise<Record<string,()=>Promise<unknown>>>=>{
  const scopeIds=(await allowedCompanies(ctx)).map(company=>company.id),audience=todayAudience(ctx);
  const modules={attendance:isModuleEnabled(ctx,'attendance'),claims:isModuleEnabled(ctx,'claims'),performance:isModuleEnabled(ctx,'performance'),rewards:isModuleEnabled(ctx,'rewards')};
  return {
   needsYou:()=>reads.readNeedsYou(ctx,{scopeIds,audience,today,locale:'en'}).then(value=>({failed:value.failed,tasks:value.tasks.length,taskTotal:value.taskTotal,loops:value.loops.length})),
   doneForYou:()=>reads.readDoneForYou(ctx,{scopeIds,today}).then(value=>value.ok?{ok:true}:{ok:false,error:errorFact(value.error)}),
   atAGlance:()=>reads.readAtAGlance(ctx,{locale:'en',today}).then(value=>({failed:value.failed})),
   beforePayroll:()=>readMyPayrollReadiness(ctx,{scopeIds,locale:'en',today,includeApprovals:false}).then(value=>({present:value!==null,failed:value?.failed??null,items:value?.items.length??null})),
   'needs.pendingTaskSummary':()=>inbox.pendingTaskSummary(ctx,scopeIds,modules).then(value=>({items:value.items.length,total:value.total})),
   'needs.loopCards':()=>loops.readLoopCards(ctx,{scopeIds,admin:false}).then(value=>({cards:value.length})),
   'needs.letterRequests':()=>letters.countWaitingLetterRequests(ctx,scopeIds),
   'needs.ownLeaveReviews':()=>reviews.readHomeOwnLeaveReviewIndex(ctx).then(()=>'ok'),
   'needs.cancellationReviews':()=>reviews.readHomeLeaveCancellationReviewIndex(ctx).then(()=>'ok'),
   'needs.decisionReviews':()=>reviews.readHomeLeaveDecisionReviewIndex(ctx).then(()=>'ok'),
   'page.identity':()=>inPage(ctx,()=>home.readEmployeeHomeIdentity(ctx)).then(()=>'ok'),
   'page.greetingIdentity':()=>inPage(ctx,()=>home.readEmployeeHomeGreetingIdentity(ctx)).then(()=>'ok'),
   'page.performanceBlock':()=>inPage(ctx,()=>performanceService.getPerformanceHomeBlock(ctx,scopeIds)).then(value=>value===null?'none':'block'),
   'page.assignedPerformance':()=>inPage(ctx,async()=>performanceService.hasAssignedPerformanceWork(ctx,scopeIds)),
   'page.assistant':()=>inPage(ctx,()=>assistant.mayUseAssistant(ctx)).then(value=>value.allowed),
   'page.layoutApprovals':()=>database.withBackgroundReadWork(ctx.tenantId,()=>inPage(ctx,()=>inbox.pendingTaskSummary(ctx,scopeIds,modules,{deferClaimPreview:true}))).then(value=>({total:value.total})),
  };
 };
 /** One modelled page render: every section inside `work` shares one request scope; its carriers commit before return. */
 const pageRender=async<T,>(work:()=>Promise<T>):Promise<T>=>{
  const scope={};
  try{return await requestScope.withRequestReadScope(scope,work);}
  finally{for(const stats of await database.requestScopedReadStats(scope))(globalThis as {__aihrPerfSharedRead?:(stats:SharedReadStats)=>void}).__aihrPerfSharedRead?.(stats);}
 };
 return Object.assign(readers,{pageRender});
}

/** Every leave and clock calculator the Time Off and Today bundles answer, live and bundled, inside ONE read-only
 * snapshot, as outcome pairs. A refusal on one side must be the same refusal on the other. */
async function bundleCalculatorPairs(actor:Actor,today:string){
 const pairs:Record<string,[unknown,unknown]>={},id=actor.employmentId,ctx=actor.ctx;
 await withTenant(ctx,async tx=>{
  const pair=async(name:string,live:()=>Promise<unknown>,bundled:()=>Promise<unknown>)=>{pairs[name]=[await outcome(live),await outcome(bundled)];};
  const inputs=await readOwnLeaveInputsTx(tx,id,today),typeIds=inputs.types.map(type=>type.id);
  await pair('leaveBalances',()=>leaveBalancesTx(tx,ctx,id,'en',{includeArchived:false}),()=>leaveBalancesTx(tx,ctx,id,'en',{includeArchived:false},inputs));
  await pair('leaveBalances:all',()=>leaveBalancesTx(tx,ctx,id,'en',{includeHidden:true,includeIneligible:true,includeArchived:true}),
   ()=>leaveBalancesTx(tx,ctx,id,'en',{includeHidden:true,includeIneligible:true,includeArchived:true},inputs));
  const year=today.slice(0,4),items=typeIds.flatMap(leaveTypeId=>[today,year+'-12-31',(Number(year)-1)+'-12-31'].map(asOf=>({leaveTypeId,asOf})));
  await pair('breakdowns',()=>leaveEntitlementBreakdowns(ctx,id,items,'en',tx),()=>leaveEntitlementBreakdowns(ctx,id,items,'en',tx,inputs));
  await pair('applySummaries',async()=>[...await leaveTypeApplySummaries(ctx,id,typeIds,tx)],async()=>[...await leaveTypeApplySummaries(ctx,id,typeIds,tx,inputs)]);
  await pair('cards',()=>myCurrentLeaveSnapshotCards(ctx,id,{today,locale:'en'},tx),()=>myCurrentLeaveSnapshotCards(ctx,id,{today,locale:'en'},tx,inputs));
  await pair('eligible',()=>hasEligibleLeaveTypeForTx(tx,id),()=>hasEligibleLeaveTypeFrom(tx,id,inputs));
  await pair('nextApproved',()=>nextApprovedLeavePresenceTx(tx,id,today),async()=>inputs.nextApproved);
  await pair('clock',()=>ownClockTodaySummaryTx(tx,ctx,id),async()=>(await ownClockTodayHomeTx(tx,ctx,id)).clock);
  // The old card read the location names only after the own clock summary admitted the subject, so the bundled card
  // is compared with that composition; the function's location rows are compared with the labels owner directly.
  await pair('locations',async()=>{await ownClockTodaySummaryTx(tx,ctx,id);return employeeClockingLocationLabelsTx(tx,id);},
   async()=>(await ownClockTodayHomeTx(tx,ctx,id)).workLocations);
  const now=new Date(),pre=await readOwnClockDayInputsTx(tx,id,now);
  await pair('locations:rows',()=>employeeClockingLocationLabelsTx(tx,id),async()=>pre.locations);
  for(const date of [todayInKualaLumpur(new Date(now.getTime()-86400000)),todayInKualaLumpur(now)])
   await pair('schedule:'+(date===todayInKualaLumpur(now)?'today':'yesterday'),()=>resolvedScheduleForTx(tx,id,date),()=>resolvedScheduleForTx(tx,id,date,pre.memo(date)));
  await calendarWindowPairs(tx,actor,today,pair,inputs);
 },{readOnlySnapshot:true});
 return pairs;
}

// ── Before payroll as one statement (docs/adr/2026-11-10-home-request-read-scope.md decision 11,
// core/pre-salary/before-payroll-bundle.ts). Every own owner reading on its own against the one statement: the traces,
// the fixture rows that give each owner rows to compare (added after the traces), and the comparisons. ───────────────
type BeforePayrollTraceRow={before:number;after:number;afterOrdered:string[];shared:unknown;failure:unknown};
async function beforePayrollTraces(label:string,actor:Actor,today:string,trace:(before:()=>Promise<unknown>,after:()=>Promise<unknown>)=>Promise<BeforePayrollTraceRow>){
 const {readMyPayrollReadiness,readMyPayrollReadinessFromOwners}=await import('../../core/pre-salary/person-items');
 const {allowedCompanies}=await import('../../core/read');
 const scopeIds=(await allowedCompanies(actor.ctx)).map(company=>company.id);
 const summary=(value:{failed:boolean;items:readonly unknown[]}|null)=>({present:value!==null,failed:value?.failed??null,items:value?.items.length??null});
 const owners=()=>readMyPayrollReadinessFromOwners(actor.ctx,{scopeIds,locale:'en',today,includeApprovals:false}).then(summary);
 const bundled=()=>readMyPayrollReadiness(actor.ctx,{scopeIds,locale:'en',today,includeApprovals:false}).then(summary);
 const rows:Record<string,BeforePayrollTraceRow>={'section:beforePayroll:owners':await trace(owners,owners),'section:beforePayroll:bundled':await trace(bundled,bundled)};
 print('before-payroll-trips',{label,owners:[rows['section:beforePayroll:owners'].before,rows['section:beforePayroll:owners'].after],
  bundled:[rows['section:beforePayroll:bundled'].before,rows['section:beforePayroll:bundled'].after],bundledStatements:rows['section:beforePayroll:bundled'].afterOrdered});
 return rows;
}
/** Rows for every Before payroll owner on the compared subjects. Each insert is fictional and stands alone: one the
 * schema refuses is recorded and skipped, so the comparison still runs for the rest. */
async function seedBeforePayrollFixtures(actors:readonly Actor[],today:string){
 const day=(offset:number)=>new Date(Date.parse(today+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
 const year=Number(today.slice(0,4)),seeded:string[]=[],refused:Record<string,string>={};
 const step=async(name:string,work:()=>Promise<unknown>)=>{try{await work();seeded.push(name);}catch(error){refused[name]=String((error as Error)?.message??error).slice(0,200);}};
 const [employee,manager,onLeave]=[actors.find(a=>a.index%250===4)!,actors.find(a=>a.index%250===2)!,actors.find(a=>a.index%250===54)!];
 for(const actor of [employee,manager]){
  const tenantId=actor.ctx.tenantId,employmentId=actor.employmentId,personId=actor.ctx.personId!,userId=actor.ctx.userId!,tag=actor.index;
  // Attendance: an absent day, a missed clock-out, a pending correction and an OT plan, a rostered rest day and a day adjustment.
  await step('absent:'+tag,()=>owner.client`delete from attendance where employment_id=${employmentId}::uuid and attendance_date=${day(-3)}::date`);
  await step('missedClockOut:'+tag,()=>owner.client`update attendance set check_out_at=null where employment_id=${employmentId}::uuid and attendance_date=${day(-2)}::date`);
  await step('correction:'+tag,()=>owner.client`insert into attendance_correction(tenant_id,employment_id,attendance_date,proposed_check_in,proposed_check_out,reason,status,request_kind)
   values(${tenantId}::uuid,${employmentId}::uuid,${day(-4)}::date,'09:00','18:00','Fictional correction','pending','incomplete_entry')`);
  await step('overtimePlan:'+tag,()=>owner.client`insert into attendance_correction(tenant_id,employment_id,attendance_date,requested_ot_minutes,planned_start_time,planned_end_time,reason,status,request_kind)
   values(${tenantId}::uuid,${employmentId}::uuid,${day(-1)}::date,60,'18:00','19:00','Fictional overtime plan','pending','self_overtime')`);
  await step('roster:'+tag,()=>owner.client`insert into roster_assignment(tenant_id,employment_id,shift_date,is_rest_day) values(${tenantId}::uuid,${employmentId}::uuid,${day(-5)}::date,true)`);
  await step('dayAdjustment:'+tag,()=>owner.client`insert into attendance_day_adjustment(tenant_id,employment_id,attendance_date,day_kind,reason,updated_by)
   values(${tenantId}::uuid,${employmentId}::uuid,${day(-6)}::date,'rest_day','Fictional adjustment','fixture')`);
  // Claims: a draft with an attachment and one without, beside the pending claims.
  await step('claimAttachment:'+tag,async()=>{
   const [type]=await owner.client<{id:string}[]>`select id from claim_type where tenant_id=${tenantId}::uuid and code='PERF'`;
   await owner.client`update claim_type set requires_receipt=true where id=${type.id}::uuid`;
   const drafts=await owner.client<{id:string}[]>`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
    values(${tenantId}::uuid,${employmentId}::uuid,${type.id}::uuid,1,${day(-2)}::date,'draft',now()),(${tenantId}::uuid,${employmentId}::uuid,${type.id}::uuid,1,${day(-1)}::date,'draft',now()) returning id`;
   await owner.client`insert into claim_attachment(tenant_id,claim_request_id,employment_id,content,file_name,mime_type,size_bytes)
    values(${tenantId}::uuid,${drafts[0].id}::uuid,${employmentId}::uuid,decode('00','hex'),'fictional-receipt.pdf','application/pdf',1)`;
  });
  // Details: TP1 rows (a draft, one sent), a TP3 record and answer, and two children on the Family register.
  await step('tp1:'+tag,()=>owner.client`insert into tp1_relief(tenant_id,person_id,assessment_year,status,submitted_at,deduction_month)
   values(${tenantId}::uuid,${personId}::uuid,${year},'draft',null,1),(${tenantId}::uuid,${personId}::uuid,${year},'submitted',now(),2)`);
  await step('tp3:'+tag,()=>owner.client`insert into employee_tp3(tenant_id,person_id,assessment_year) values(${tenantId}::uuid,${personId}::uuid,${year-1})`);
  await step('tp3Answer:'+tag,()=>owner.client`insert into payroll_tp3_previous_employer_answer(tenant_id,person_id,employment_id,assessment_year,had_previous_employer,answered_by_user_id)
   values(${tenantId}::uuid,${personId}::uuid,${employmentId}::uuid,${year},true,${userId}::uuid)`);
  await step('dependants:'+tag,()=>owner.client`insert into employee_dependent(tenant_id,person_id,full_name,relationship,date_of_birth)
   values(${tenantId}::uuid,${personId}::uuid,'Fictional Child One','child','2015-03-01'),(${tenantId}::uuid,${personId}::uuid,'Fictional Child Two','child','1990-03-01')`);
  // Acknowledge: a notice requiring acknowledgement, a released submitted review, a handed-over onboarding case.
  await step('notice:'+tag,async()=>{
   const [row]=await owner.client<{id:string}[]>`insert into notice(tenant_id,title,body,requires_acknowledgement,content_version,start_on,end_on,published_at,published_by_user_id)
    values(${tenantId}::uuid,'Fictional notice '||${tag}::text,'Fictional body',true,1,${day(-10)}::date,${day(10)}::date,now(),${userId}::uuid) returning id`;
   await owner.client`insert into notice_recipient(tenant_id,notice_id,employment_id) values(${tenantId}::uuid,${row.id}::uuid,${employmentId}::uuid)`;
  });
  await step('review:'+tag,async()=>{
   const [cycle]=await owner.client<{id:string}[]>`insert into review_cycle(tenant_id,name,period_start,period_end,status,rating_scale,released_at)
    values(${tenantId}::uuid,'Fictional cycle '||${tag}::text,${(year-1)+'-01-01'}::date,${(year-1)+'-12-31'}::date,'closed','[{"value":1,"label":"One"}]'::jsonb,now()) returning id`;
   await owner.client`insert into performance_review(tenant_id,cycle_id,employment_id,status) values(${tenantId}::uuid,${cycle.id}::uuid,${employmentId}::uuid,'submitted')`;
  });
  // No onboarding case is seeded: a hand-built case would have to satisfy the whole onboarding interpreter, which every
  // assigned-task read on the tenant runs. The onboarding section is compared on the owner's own (empty) rows.
 }
 // Statutory facts: the manager's present (and more children declared than the register counts), the employee's missing.
 await step('statutory:present',()=>owner.client`insert into employee_statutory_my(tenant_id,person_id,tax_number,epf_number,socso_number,bank_name,bank_account_no,num_children)
  values(${manager.ctx.tenantId}::uuid,${manager.ctx.personId!}::uuid,'SG0000000001','00000001','000000000001','Fictional Bank','000000000001',3)`);
 await step('statutory:missing',()=>owner.client`delete from employee_statutory_my where person_id=${employee.ctx.personId!}::uuid`);
 // An approved and a pending own leave request already sit in the window for the employee; one on leave has another.
 await step('leave:onLeave',()=>owner.client`insert into leave_request(tenant_id,employment_id,leave_type_id,start_date,end_date,days,status)
  select ${onLeave.ctx.tenantId}::uuid,${onLeave.employmentId}::uuid,leave_type_id,${day(-4)}::date,${day(-4)}::date,1,'pending' from leave_request where employment_id=${onLeave.employmentId}::uuid limit 1`);
 return {seeded,refused};
}
/** Rows written through the owners' own commands, so the Leave Credit, letter, notice and onboarding sections compare
 * non-empty rows: Time Off In Lieu switched on for the first tenant (every actor's entitlements re-resolved, as a login
 * would on its next request) with a Leave Credit request pending for the employee and one approved for the manager; a
 * template, policy and batch of letters approved by a second administrator and issued to both; a published notice that
 * requires acknowledgement; and a new joiner hired through an employee draft whose onboarding case is submitted,
 * fulfilled and handed over, waiting for the joiner's own acknowledgement. Each command stands alone: one that refuses
 * is recorded and the rest still run. */
async function seedBeforePayrollOwnerFixtures(actors:Actor[],today:string){
 const b=seededBases.get(0)!,seeded:string[]=[],refused:Record<string,string>={};
 const step=async<T,>(name:string,work:()=>Promise<T>):Promise<T|null>=>{try{const value=await work();seeded.push(name);return value;}catch(error){refused[name]=String((error as Error)?.message??error).slice(0,300);return null;}};
 const day=(offset:number)=>new Date(Date.parse(today+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
 const own=actors.filter(a=>a.tenant===0),employee=own.find(a=>a.index===4)!,manager=own.find(a=>a.index===2)!,reviewer=own.find(a=>a.index===1)!,tech=own.find(a=>a.index===5)!;
 // Time Off In Lieu for the tenant, then every login's entitlements as they now resolve.
 await setModule(b.tenantId,'toil','active');
 let admin=await entitledCtx(b);
 for(const actor of own)actor.ctx.entitlements=admin.entitlements;
 const toil=await import('../../core/toil'),replacement=await import('../../core/replacement-request');
 await step('toil:policy',()=>toil.setToilPolicy(admin,{companyId:employee.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
  allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true}));
 // The most recent Saturday at least a week back: a rest day worked, claimed as one day.
 let worked=day(-7);while(new Date(worked+'T00:00:00Z').getUTCDay()!==6)worked=new Date(Date.parse(worked+'T00:00:00Z')-86400000).toISOString().slice(0,10);
 await step('toil:pending',()=>replacement.submitReplacementLeaveRequest(admin,{employmentId:employee.employmentId,unit:'day',lines:[{workedDate:worked,days:1}],today}));
 const approved=await step('toil:submitted',()=>replacement.submitReplacementLeaveRequest(admin,{employmentId:manager.employmentId,unit:'day',lines:[{workedDate:worked,days:1}],today}));
 if(approved)await step('toil:approved',()=>replacement.decideReplacementLeaveRequest(admin,{requestId:approved.requestId,decision:'approved'}));
 // Letters, through the letter owner's own field, template, policy, batch, decision and issue commands. Issuing needs a
 // public origin for the verification link, as the letter owner's own tests configure it.
 const letters=await import('../../core/letters');
 const signer={...reviewer.ctx,entitlements:admin.entitlements};
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NEXT_PUBLIC_WORKOS_REDIRECT_URI','https://letters.fixture.test/callback');
 try{
  const fields=await step('letter:fields',async()=>[await letters.saveLetterField(admin,{companyId:employee.companyId,definition:{key:'employeeName',label:'Employee name',description:'Canonical name',
    kind:'text',source:'employee.name',required:true,editable:false,sensitive:false},active:true}),
   await letters.saveLetterField(admin,{companyId:employee.companyId,definition:{key:'effectiveDate',label:'Effective date',description:'Date entered for this letter',kind:'date',
    source:'custom.date',required:true,editable:true,sensitive:false},active:true})]);
  const template=fields&&await step('letter:template',async()=>{
   const saved=await letters.saveLetterTemplate(admin,{companyId:employee.companyId,code:'BEFORE-PAYROLL',name:'Fictional acknowledgement letter',category:'confirmation',effectiveFrom:today,
    document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'To '},{type:'field',key:'employeeName'},{type:'text',text:' — effective '},{type:'field',key:'effectiveDate'}]}]},
    fieldVersionIds:fields.map(field=>field.id)});
   await letters.decideLetterTemplate(admin,{versionId:saved.versionId,expectedStatus:'draft',action:'submit'});
   await letters.decideLetterTemplate(signer,{versionId:saved.versionId,expectedStatus:'submitted',action:'approve'});
   return saved;
  });
  const policy=template&&await step('letter:policy',()=>letters.saveLetterPolicy(admin,{companyId:employee.companyId,category:'confirmation',enabled:true,policy:{version:1,
   stages:[{key:'signatory',label:'Authorised signatory',userIds:[signer.userId!],allowDelegation:false}],signatoryUserId:signer.userId!,signingMode:'authenticated',signatureAssetId:null,
   letterheadAssetId:null,referenceFormat:'BP/{YYYY}/{SEQ:6}',retentionDays:365,sensitiveLinkMinutes:15,acknowledgement:'acknowledge',approvalDueHours:48,acknowledgementDueDays:7,
   reminderHours:24,escalationUserId:null,portalNotifications:false,emailNotifications:false}}));
  if(template&&policy!==null)await step('letter:issued',async()=>{
   const ids=[employee.employmentId,manager.employmentId];
   const made=await letters.createLetterDraftBatch(admin,{companyId:employee.companyId,templateVersionId:template.versionId,employmentIds:ids,
    customValues:Object.fromEntries(ids.map(id=>[id,{effectiveDate:{kind:'date' as const,value:today}}])),operationKey:randomUUID()});
   await letters.submitLetterBatch(admin,made.batchId);
   for(const row of (await letters.getLetterGenerationBatch(admin,made.batchId))!.rows){
    await letters.decideLetter(signer,{letterId:row.record.id,expectedRevisionId:row.revision!.id,expectedLockVersion:row.record.lockVersion,
     decision:{action:'approve',comment:'Fictional review of the exact letter',confirmSignature:true}});
    await letters.issueLetter(admin,{letterId:row.record.id,expectedRevisionId:row.revision!.id,expectedLockVersion:row.record.lockVersion+1});
   }
  });
 }finally{vi.unstubAllEnvs();}
 // A notice requiring acknowledgement, published through the notice owner (which retains its audience snapshot).
 const notices=await import('../../core/notice');
 await step('notice:published',async()=>{
  const created=await notices.createNotice(admin,{title:'Fictional payroll notice',summary:'Fictional summary.',body:'Fictional body.',startOn:today,endOn:day(10),
   targetMode:'individual',employmentIds:[employee.employmentId,manager.employmentId],requiresAcknowledgement:true,notifyOnPublish:false});
  return notices.publishNotice(admin,created.id);
 });
 // A new joiner, through an employee draft and the onboarding owner's own commands, to the hand-over.
 const drafts=await import('../../core/employee-draft'),onboarding=await import('../../packs/lifecycle/service');
 const joiner=await step('onboarding:joiner',async()=>{
  await onboarding.onboardingSetup(admin);
  const context=await onboarding.onboardingContext(admin),config=structuredClone(context.config);
  for(const id of ['group-tech','people-gbs','tech-bp'])config.groups.find(group=>group.id===id)!.members=[tech.ctx.userId!];
  config.checklists[0]!.tasks=[{id:'welcome',name:'Prepare welcome pack',by:'group',group:'people-gbs',method:'rr',opens:null,due:1,gate:false}];
  config.catalogue=[{id:'m365',name:'M365',type:'system',active:true,rules:{},workflow:null,team:'group-tech',card:false}];
  await onboarding.onboardingSaveConfig(admin,context.revision,config);
  admin=await entitledCtx(b);
  const saved=await drafts.saveEmployeeDraft(admin,{data:{profile:{fullName:'PERF Fictional Joiner',employeeCode:'PERF-JOINER',primaryEmail:'perf-joiner@example.invalid'},
   employment:{companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:today},payroll:{basicSalary:'5000'}},currentStep:5});
  const active=await drafts.completeEmployeeDraft(admin,saved.id);
  const find=async()=>(await onboarding.onboardingList(admin)).find(row=>row.case.employmentId===active.employmentId)!;
  let row=await find();
  await onboarding.onboardingCommand(admin,row.case.id,row.revision,{type:'saveSubmit',patch:{hiring:'new_hire',local:{supervisor:'Manager'},selected:['m365']}});
  const [person]=await owner.db.select({personId:s.employment.personId}).from(s.employment).where(eq(s.employment.id,active.employmentId));
  const userId=await createAppUser(b.tenantId,person.personId,'employee');
  await onboarding.refreshOnboardingPersonnel(admin);
  const techCtx={...tech.ctx,entitlements:admin.entitlements};
  row=await find();
  await onboarding.onboardingCommand(techCtx,row.case.id,row.revision,{type:'fulfil',itemId:row.case.requisitions[0]!.items[0]!.id,status:'done'});
  row=await find();
  await onboarding.onboardingCommand(techCtx,row.case.id,row.revision,{type:'handover'});
  for(const actor of own)actor.ctx.entitlements=admin.entitlements;
  return {index:-1,tenant:0,company:0,role:'employee',employmentId:active.employmentId,companyId:b.companyId,
   ctx:{tenantId:b.tenantId,userId,personId:person.personId,roles:['employee'],grants:[{role:'employee',companyId:null}],entitlements:admin.entitlements}} as Actor;
 });
 return {seeded,refused,joiner};
}
const BEFORE_PAYROLL_OWN_LOOP_KINDS=new Set(['clockOut','record','passport','probation','payroll','passports']);
/** Before payroll's checklist and every section of its one statement against the owners it replaces, for one subject. */
async function beforePayrollEquivalence(subject:string,actor:Actor,today:string,compare:(subject:string,target:string,old:unknown,fresh:unknown)=>void){
 const items=await import('../../core/pre-salary/person-items'),{allowedCompanies,leaveRequestsFor,listEligibleLeaveTypesFor}=await import('../../core/read');
 const attendance=await import('../../packs/attendance/service'),claims=await import('../../packs/claims/service'),payroll=await import('../../packs/payroll/service');
 const leave=await import('../../packs/leave/service'),performanceService=await import('../../packs/performance/service'),lifecycle=await import('../../packs/lifecycle/service');
 const {readLoopCards}=await import('../../core/loops/cards'),{myReadinessActions}=await import('../../core/readiness-actions'),{myProfile}=await import('../../core/profile');
 const {listDependents}=await import('../../core/dependents'),{listMyLetters}=await import('../../core/letters'),{pendingNoticeAcknowledgementTasks}=await import('../../core/notice');
 const {myTp3PreviousEmployerAnswer}=await import('../../core/pre-salary/tp3-answer');
 const ctx=actor.ctx,scopeIds=(await allowedCompanies(ctx)).map(company=>company.id);
 for(const [name,p] of [['checklist',{includeApprovals:false as const}],['checklistWithApprovals',{approvalPreview:true}]] as const){
  const read=()=>items.readMyPayrollReadiness(ctx,{scopeIds,locale:'en',today,...p});
  compare(subject,'beforePayroll:'+name,await outcome(()=>items.readMyPayrollReadinessFromOwners(ctx,{scopeIds,locale:'en',today,...p})),await outcome(read));
  compare(subject,'beforePayroll:'+name+':independent',await outcome(()=>withIndependentTransactions(()=>items.readMyPayrollReadinessFromOwners(ctx,{scopeIds,locale:'en',today,...p}))),
   await outcome(()=>withIndependentTransactions(read)));
 }
 const proof=await items.beforePayrollBundleForProof(ctx,{locale:'en',today});
 if(!proof)return {subject,answered:[],deferred:['all: no own subject']};
 const {read,bundle}=proof,id=read.employmentId,year=read.assessmentYear,att=read.attendance;
 // The exact Attendance windows the checklist reads for the cut-off row the statement returned.
 const windows=read.cutOff===null?read.windowsFor(null):bundle?.cutOff?read.windowsFor(bundle.cutOff.value):null;
 const byId=<T extends {id?:string;reviewId?:string;caseId?:string}>(rows:readonly T[])=>[...rows].sort((a,b)=>String(a.id??a.reviewId??a.caseId).localeCompare(String(b.id??b.reviewId??b.caseId)));
 const owners:Record<string,()=>Promise<unknown>>={
  cutOff:async()=>[...await withTenant(ctx,tx=>tx.execute(sql`SELECT cut_off_day,attendance_cut_off_day,overtime_cut_off_day,claim_cut_off_day,unpaid_leave_cut_off_day
   FROM app.own_payroll_cut_off_day(${id}::uuid)`))],
  corrections:async()=>att?(await attendance.myAttendanceCorrections(ctx,id,att.corrections)).map(({id,attendanceDate,requestKind,status})=>({id,attendanceDate,requestKind,status})):null,
  overtimePlans:async()=>att&&windows?(await attendance.myOvertimePlans(ctx,id,{...att.overtime,from:windows.overtimeFrom})).map(({id,attendanceDate,status})=>({id,attendanceDate,status})):null,
  otCap:async()=>att&&windows?attendance.otMonthToDateMinutes(ctx,id,windows.capDate):null,
  loopCards:async()=>byId((await readLoopCards(ctx,{scopeIds:[],admin:false})).filter(card=>BEFORE_PAYROLL_OWN_LOOP_KINDS.has(card.kind)) as {caseId?:string}[]),
  days:async()=>att&&windows?.range?(await attendance.attendanceForEmploymentRange(ctx,id,windows.range.from,windows.range.to)).map(({formulaOvertime:_formula,...row})=>row):null,
  leaveRequests:async()=>byId((await leaveRequestsFor(ctx,id,'en')).map(({id,leaveTypeId,leaveType,startDate,endDate,days,status,hasDocument})=>({id,leaveTypeId,leaveType,startDate,endDate,days,status,hasDocument}))),
  leaveTypes:()=>listEligibleLeaveTypesFor(ctx,id,'en'),
  claims:async()=>(await claims.listOpenClaimsForEmployment(ctx,id)).map(row=>({id:row.id,claimTypeId:row.claimTypeId,typeName:row.typeName,incurredOn:row.incurredOn,status:row.status,attachmentCount:row.attachments.length})),
  claimRules:()=>claims.claimTypeReceiptRules(ctx),
  toil:async()=>(await leave.listReplacementLeaveRequests(ctx,id)).map(({id,status,submittedOn,dates})=>({id,status,submittedOn,dates:dates.map(({workedDate})=>({workedDate}))})),
  readiness:()=>myReadinessActions(ctx,id),
  tp3:async()=>({employments:await payroll.myTp3EmploymentsSnapshot(ctx),history:await payroll.myTp3HistorySnapshot(ctx)}),
  tp3Answer:()=>myTp3PreviousEmployerAnswer(ctx,year),
  tp1:()=>payroll.listMyTp1DeclarationsSnapshot(ctx,{assessmentYear:year}),
  profile:async()=>{const value=await myProfile(ctx);return value&&{statutory:value.statutory?{numChildren:value.statutory.numChildren}:null};},
  dependents:()=>listDependents(ctx,{personId:ctx.personId!}),
  letters:()=>listMyLetters(ctx,{limit:read.letterLimit}),
  notices:()=>pendingNoticeAcknowledgementTasks(ctx),
  reviews:async()=>byId((await performanceService.myReviews(ctx)).map(({reviewId,status,released,periodEnd})=>({reviewId,status,released,periodEnd}))),
  onboarding:()=>lifecycle.onboardingMyAcknowledgements(ctx),
 };
 // The range rows' stored overtime-formula record is the one field the statement does not read (decision 11).
 const ordered:Record<string,(value:unknown)=>unknown>={loopCards:value=>byId(value as {caseId?:string}[]),leaveRequests:value=>byId(value as {id:string}[]),reviews:value=>byId(value as {reviewId:string}[]),
  days:value=>(value as {formulaOvertime?:unknown}[]).map(({formulaOvertime:_formula,...row})=>row)};
 const answered:string[]=[],deferred:string[]=[],rows:Record<string,number|null>={};
 // How many rows each compared section held: an empty section proves less than a populated one.
 const size=(value:unknown):number|null=>Array.isArray(value)?value.length:value&&typeof value==='object'&&Array.isArray((value as {rows?:unknown}).rows)
  ?(value as {rows:unknown[]}).rows.length:value&&typeof value==='object'&&(value as {history?:{records:unknown[];drafts:unknown[]}}).history
  ?(value as {employments:unknown[];history:{records:unknown[];drafts:unknown[]}}).employments.length+(value as {history:{records:unknown[];drafts:unknown[]}}).history.records.length
   +(value as {history:{records:unknown[];drafts:unknown[]}}).history.drafts.length:value===null?0:null;
 for(const [name,owner] of Object.entries(owners)){
  const section=(bundle as Record<string,{value:unknown}|null>|null)?.[name];
  if(!section){deferred.push(name);continue;}
  answered.push(name);rows[name]=size(section.value);
  compare(subject,'beforePayroll:section:'+name,await outcome(()=>withIndependentTransactions(owner)),{ok:true,value:(ordered[name]??(value=>value))(section.value)});
 }
 // The readiness snapshot alone, owner against the section's own rows, so a difference names its stage.
 if(ctx.personId){
  const recordReadiness=await import('../../core/record-readiness');
  const scope={employmentIds:[id],personId:ctx.personId};
  compare(subject,'beforePayroll:section:readinessSnapshot',await outcome(()=>withIndependentTransactions(()=>withTenant(ctx,tx=>recordReadiness.readinessSnapshot(tx,Number.POSITIVE_INFINITY,false,scope)))),
   await outcome(()=>withIndependentTransactions(()=>withTenant(ctx,async tx=>{const [row]=await tx.execute<{rows:unknown}>(sql`select ${recordReadiness.readinessSnapshotBundleSql(scope)} as rows`);
    return recordReadiness.readinessSnapshotFromBundle(row.rows,Number.POSITIVE_INFINITY);},{readOnlySnapshot:true}))));
 }
 return {subject,answered,deferred,rows,windows};
}
// ── end Before payroll ───────────────────────────────────────────────────────────────────────────────────────────────
// ── Calendar window, shared own leave inputs and the preloaded entitlement resolver (core/calendar-window-inputs.ts,
// decision 9) ── every helper of this block is called from one line in the trace, fixture and equivalence steps.
const shiftDays=(date:string,days:number)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
/** The holiday, replacement, presence and dated company proof owners for one window, each with `pre` when given. */
const calendarOwners=(tx:Tx,id:string,from:string,to:string,pre?:CalendarWindowInputs)=>Promise.all([
 originalHolidayCalendarFor(tx,{employmentId:id,startDate:from,endDate:to},pre),
 holidayDatesFor(tx,{employmentId:id,startDate:from,endDate:to},pre).then(set=>[...set].sort()),
 replacementHolidayCalendarProjectionsTx(tx,{employmentIds:[id],startDate:from,endDate:to},pre),
 approvedLeavePresenceByEmploymentTx(tx,[id],from,to,pre).then(map=>[...map].map(([key,days])=>[key,[...days]])),
 leaveCalendarPresenceByEmploymentTx(tx,[id],from,to,pre).then(value=>({approved:[...value.approved].map(([key,days])=>[key,[...days]]),
  pending:[...value.pending].map(([key,days])=>[key,[...days]])})),
 provenCompanyDatesTx(tx,[from,to].map(date=>({employmentId:id,date})),pre).then(map=>[...map]),
]);
/** Live against the one calendar window statement, for a window of one day, Today's two days, the Summary lookahead, a
 * month grid and the stream's widest window, each asked for itself and for one day inside it; and the entitlement
 * resolver live against the bundled own leave inputs at each date the breakdowns ask. */
async function calendarWindowPairs(tx:Tx,actor:Actor,today:string,pair:(name:string,live:()=>Promise<unknown>,bundled:()=>Promise<unknown>)=>Promise<void>,inputs:OwnLeaveInputs){
 const id=actor.employmentId,month=homeCalendarMonth(today.slice(0,7));
 const windows:Record<string,{from:string;to:string}>={day:{from:today,to:today},today:{from:shiftDays(today,-1),to:today},
  summary:{from:today,to:shiftDays(today,7)},month:{from:shiftDays(month.from,-6),to:shiftDays(month.to,6)}};
 windows.stream={from:[windows.today.from,windows.month.from].sort()[0],to:[windows.summary.to,windows.month.to].sort()[1]};
 for(const [name,window] of Object.entries(windows)){
  const pre=await readCalendarWindowInputsTx(tx,id,window.from,window.to);
  for(const [part,from,to] of [['all',window.from,window.to],['first',window.from,window.from],['last',window.to,window.to]] as const)
   await pair('calendar:'+name+':'+part,()=>calendarOwners(tx,id,from,to),()=>calendarOwners(tx,id,from,to,pre));
 }
 const year=today.slice(0,4),typeIds=inputs.types.map(type=>type.id);
 const describe=(resolver:TemplateEntitlementResolver)=>({isEmpty:resolver.isEmpty,types:typeIds.map(type=>({type,has:resolver.hasTemplatesFor(type),
  winner:resolver.winnerFor(id,type),band:resolver.bandFor(id,type,5)}))});
 for(const asOf of [today,year+'-12-31',(Number(year)-1)+'-12-31'])
  await pair('resolver:'+asOf,async()=>describe(await buildTemplateEntitlementResolver(tx,{employmentIds:[id],leaveTypeIds:typeIds,asOf})),
   async()=>describe(await buildTemplateEntitlementResolver(tx,{employmentIds:[id],leaveTypeIds:typeIds,asOf},inputs)));
}
type TraceRow={before:number;after:number;afterOrdered:string[]};
/** The cards and the stream as they read before this block (withStagedHomeReads), traced like every other row. */
async function calendarWindowTraces(label:string,actor:Actor,month:string,rows:Record<string,TraceRow>,traceBoth:(before:()=>Promise<unknown>,after:()=>Promise<unknown>)=>Promise<TraceRow>){
 for(const card of ['summary','today','calendar','timeOff'] as const){
  const read=()=>withStagedHomeReads(()=>readers(actor.ctx,actor.employmentId,month)[card]());
  rows['card:'+card+':windowStaged']=await traceBoth(read,()=>withSharedReadSnapshot(actor.ctx,read));
 }
 const stream=()=>withStagedHomeReads(()=>streamHome(actor,month,null));
 rows['stream:windowStaged']=await traceBoth(stream,stream);
 const trips=(name:string)=>({staged:rows[name+':windowStaged'].after,bundled:rows[name].after});
 print('calendar-window-trips',{label,summary:trips('card:summary'),today:trips('card:today'),calendar:trips('card:calendar'),timeOff:trips('card:timeOff'),
  stream:trips('stream'),page:rows.page?.after??null,todayStatements:rows['card:today'].afterOrdered,summaryStatements:rows['card:summary'].afterOrdered});
}
/** Added after the traces: dated holiday calendars of every kind the window statement answers (a group inheriting an
 * extended parent, with extra and ticked days; a custom group; a work state; a dated calendar period) and entitlement
 * tables in force on the annual leave type with rules on a company, a dated assignment axis, a person axis and a service
 * band, so some subjects match a rule, some match none and the other tenant has no table. */
async function calendarWindowFixtures(actors:Actor[],today:string){
 const tenantId=actors[0].ctx.tenantId,at=(index:number)=>actors.find(a=>a.index===index)!;
 const day=(offset:number)=>shiftDays(today,offset),companies=[0,1,2].map(c=>actors.find(a=>a.company===c)!.companyId);
 const group=async(name:string,states:string[],archetype:'standard'|'extended'|'custom',parentGroupId:string|null=null)=>
  (await owner.db.insert(s.holidayGroup).values({tenantId,name,states,archetype,parentGroupId}).returning())[0].id;
 const parent=await group('Fictional extended parent',['Johor'],'extended');
 const child=await group('Fictional inheriting child',[],'standard',parent),custom=await group('Fictional custom calendar',[],'custom');
 const [ticked]=await owner.db.insert(s.holiday).values({tenantId,country:'MY',state:'Sabah',holidayDate:day(6),name:'Fictional Sabah day'}).returning();
 await owner.db.insert(s.holiday).values([{tenantId,country:'MY',state:'Johor',holidayDate:day(1),name:'Fictional Johor day'},
  {tenantId,country:'MY',holidayGroupId:parent,holidayDate:day(4),name:'Fictional parent extra'},{tenantId,country:'MY',holidayGroupId:child,holidayDate:day(7),name:'Fictional child extra'},
  {tenantId,country:'MY',holidayGroupId:custom,holidayDate:day(2),name:'Fictional custom extra'}]);
 await owner.db.insert(s.holidayGroupHoliday).values({tenantId,holidayGroupId:child,holidayId:ticked.id});
 await owner.db.update(s.employment).set({holidayGroupId:child}).where(eq(s.employment.id,at(4).employmentId));
 await owner.db.update(s.employment).set({holidayGroupId:custom}).where(eq(s.employment.id,at(3).employmentId));
 await owner.db.update(s.employment).set({workState:'Johor'}).where(eq(s.employment.id,at(2).employmentId));
 await owner.db.insert(s.employmentHolidayCalendar).values({tenantId,employmentId:at(6).employmentId,validFrom:day(-1),kind:'state',workState:'Sabah',
  recordedBy:actors.find(a=>a.role==='groupHR')!.ctx.userId!});
 const [{leaveTypeId}]=await owner.client<{leaveTypeId:string}[]>`select leave_type_id as "leaveTypeId" from leave_request where tenant_id=${tenantId}::uuid limit 1`;
 const table=async(name:string,days:number)=>{const id=randomUUID();
  await owner.db.insert(s.entitlementTemplate).values({id,tenantId,lineageId:id,leaveTypeId,name,serviceBands:[{fromYears:0,toYears:null,days}],validFrom:hiredOn});return id;};
 const [first,second]=[await table('Fictional company table',16),await table('Fictional part-time table',10)];
 await owner.db.insert(s.entitlementEligibilityRule).values([
  {tenantId,lineageId:randomUUID(),name:'Fictional company rule',templateLineageId:first,criteria:{companyIds:[companies[0]]},validFrom:hiredOn},
  {tenantId,lineageId:randomUUID(),name:'Fictional part-time rule',templateLineageId:second,criteria:{employmentTypes:['part_time']},validFrom:hiredOn},
  {tenantId,lineageId:randomUUID(),name:'Fictional person rule',templateLineageId:second,criteria:{genders:['female'],companyIds:[companies[1]]},validFrom:hiredOn},
  {tenantId,lineageId:randomUUID(),name:'Fictional service rule',templateLineageId:first,criteria:{minYearsOfService:0,companyIds:[companies[2]]},validFrom:hiredOn},
 ]);
}
/** The Summary, Today, Calendar and Time Off cards and the whole stream before this block (withStagedHomeReads) against
 * the shipped path, alone and inside one shared snapshot; and Time Off's trips with entitlement tables in force. */
async function calendarWindowEquivalence(subject:string,actor:Actor,month:string,compare:(subject:string,target:string,old:unknown,fresh:unknown)=>void){
 for(const card of ['summary','today','calendar','timeOff'] as const){
  const read=()=>readers(actor.ctx,actor.employmentId,month)[card]();
  compare(subject,'window:'+card,await outcome(()=>withStagedHomeReads(read)),await outcome(read));
  compare(subject,'window:'+card+':shared',await outcome(()=>withSharedReadSnapshot(actor.ctx,()=>withStagedHomeReads(read))),
   await outcome(()=>withSharedReadSnapshot(actor.ctx,read)));
 }
 compare(subject,'window:summary:stagedHelper',await outcome(()=>stagedHomeSummary(actor.ctx,actor.employmentId,'en','replacement')),
  await outcome(()=>readEmployeeHomeSummary(actor.ctx,actor.employmentId,'en','replacement')));
 const oldFrames:Record<string,unknown>={},newFrames:Record<string,unknown>={};
 await withStagedHomeReads(()=>streamHome(actor,month,null,GET,oldFrames));
 await streamHome(actor,month,null,GET,newFrames);
 const byCard=(frames:Record<string,unknown>)=>Object.fromEntries(Object.entries(frames).sort(([a],[b])=>a.localeCompare(b)));
 compare(subject,'window:stream',byCard(oldFrames),byCard(newFrames));
}
async function calendarWindowEntitlementTrips(subjects:[string,Actor][],month:string){
 const out:Record<string,unknown>={};
 for(const [label,actor] of subjects){
  const read=()=>withSharedReadSnapshot(actor.ctx,()=>readers(actor.ctx,actor.employmentId,month).timeOff());
  await read().catch(()=>undefined);
  const staged=await traceStatements(()=>withStagedHomeReads(read)),bundled=await traceStatements(read);
  out[label]={staged:staged.trace.trips,bundled:bundled.trace.trips,bundledStatements:bundled.trace.ordered};
 }
 report.entitlementTrips=out;print('entitlement-trips',out);
}
// ── end of the calendar window block ──
// ── Deferred task owners in the account task statement (core/account-task-bundle.ts, ADR decision 10) ────────────────
/** Candidates for every task owner the statement now decides, seeded after the traces so their counts stay comparable.
 * Tenant 0's two managers and HR get answered paths: copied cancellation chains with alternates, alternates sanitised
 * and tried in order, manager's-manager lines and subject heads of several rows that agree, a resignation, manager and
 * HR employment reviews, attendance applications (frozen workflow and legacy), a profile change request. The
 * cross-company manager (position 6) gets the documented deferrals: lines and heads that disagree and an alternate whose
 * named id the owner would trim. The other tenant's manager gets an unknown step kind and a named step naming nobody,
 * which the owner refuses with a non-refusal error (only that tenant's actors see them). A step that fails is recorded
 * instead of failing the run. */
async function seedTaskOwnerFixtures(tenants:Actor[][],today:string){
 const failures:{step:string;error:unknown;cause:unknown}[]=[];
 const step=async(name:string,work:()=>Promise<unknown>)=>{try{await work();}catch(error){const cause=(error as {cause?:{message?:string;code?:string}})?.cause;
  failures.push({step:name,error:errorFact(error),cause:cause?{code:cause.code??null,message:String(cause.message).slice(0,240)}:null});}};
 const day=(offset:number)=>new Date(Date.parse(today+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
 const on=day(12);
 for(const [t,actors] of tenants.entries()){
  const at=(position:number)=>actors.find(a=>a.index===t*250+position)!,tenantId=actors[0].ctx.tenantId;
  const [{leaveTypeId}]=await owner.client<{leaveTypeId:string}[]>`select leave_type_id as "leaveTypeId" from leave_request where tenant_id=${tenantId}::uuid limit 1`;
  const line=(subordinate:Actor,manager:Actor,validFrom='2025-01-01')=>owner.db.insert(s.reportingLine).values({tenantId,managerEmploymentId:manager.employmentId,
   subordinateEmploymentId:subordinate.employmentId,lineType:'administrative',validFrom});
  const leave=async(subject:Actor,steps:{kind:string;approver?:string|null;status?:'approved';alternates?:unknown}[],status:'pending'|'approved'='pending')=>{
   const [request]=await owner.db.insert(s.leaveRequest).values({tenantId,employmentId:subject.employmentId,leaveTypeId,startDate:on,endDate:on,days:'1',status}).returning();
   if(steps.length)await owner.db.insert(s.leaveApprovalStep).values(steps.map((step,stepIndex)=>({tenantId,leaveRequestId:request.id,subjectEmploymentId:subject.employmentId,
    stepIndex,approverKind:step.kind,approverEmploymentId:step.approver??null,approverAlternates:step.alternates??null,status:step.status??'pending' as const})));
   return request;
  };
  const cancellation=async(subject:Actor,steps:{kind:string;approver?:string|null;status?:'approved';alternates?:unknown}[])=>{
   const approved=await leave(subject,[],'approved');
   const [request]=await owner.db.insert(s.leaveCancellationRequest).values({tenantId,employmentId:subject.employmentId,leaveRequestId:approved.id,cancelDates:[on],requestedDays:'1'}).returning();
   if(steps.length)await owner.db.insert(s.leaveCancellationStep).values(steps.map((step,stepIndex)=>({tenantId,cancellationRequestId:request.id,subjectEmploymentId:subject.employmentId,
    stepIndex,approverKind:step.kind,approverEmploymentId:step.approver??null,approverAlternates:step.alternates??null,status:step.status??'pending' as const})));
  };
  // The subject's one current assignment (assignment_no_overlap admits no second) moved to a department headed by `head`.
  const headed=async(subject:Actor,head:Actor)=>{
   const [department]=await owner.db.insert(s.department).values({tenantId,companyId:subject.companyId,name:'Fictional headed department '+subject.index,label:'FHD'+subject.index,headEmploymentId:head.employmentId}).returning();
   await owner.client`update assignment set department_id=${department.id}::uuid where employment_id=${subject.employmentId}::uuid and valid_to is null and superseded_at is null`;
  };
  const manager=at(2),second=at(3);
  if(t===0){
   const cross=at(6);
   await step('lines',async()=>{
    await line(second,manager);await line(at(21),manager);await line(at(25),second);await line(at(25),second,day(-20));await line(at(27),second);
    for(const position of [32,33])await line(at(position),cross);
    // Company 1: one employee (position 54) manages 55-58 and 56 also manages 55 and 57, so a manager's-manager step on
    // 55 or 57 has two lines whose decisions disagree for 54. No other compared non-admin sees company 1's subjects.
    const lone=at(54);
    for(const position of [55,56,57,58])await line(at(position),lone);
    await line(at(55),at(56));await line(at(57),at(56));
   });
   await step('leaveChains',async()=>{
    await leave(at(17),[{kind:'hr_admin',alternates:[42,null,['direct_manager'],'mystery_kind',{kind:'specific_employee'},{kind:'specific_employee',employmentId:''},
     'specific_employee',{kind:'specific_employee',employmentId:second.employmentId.toUpperCase()}]}]);
    await leave(at(18),[{kind:'payroll',alternates:['manager_manager',{kind:'direct_manager',employmentId:'stray'}]}]);
    await leave(at(21),[{kind:'manager_manager',alternates:['direct_manager']}]);
    await leave(at(25),[{kind:'manager_manager'}]);
    // Alternate ids padded with JavaScript whitespace, trimmed exactly as sanitizeApprover trims them.
    await leave(at(33),[{kind:'custom_role',alternates:[{kind:'specific_employee',employmentId:' '+cross.employmentId+' '}]}]);
    await leave(at(19),[{kind:'custom_role',alternates:[{kind:'specific_employee',employmentId:'\u00a0'+second.employmentId+'\t\u3000'}]}]);
    // The documented fallbacks, for position 54 only: disagreeing manager's-manager lines, and an alternate id spelled
    // as PostgreSQL but not plain UUID text accepts it (braces). That employee's leave owner reads alone. (A subject head
    // cannot disagree: assignment_no_overlap leaves one current assignment.)
    await leave(at(55),[{kind:'manager_manager'}]);
    await leave(at(58),[{kind:'custom_role',alternates:[{kind:'specific_employee',employmentId:'{'+at(54).employmentId+'}'}]}]);
   });
   await step('departmentHeads',async()=>{
    await headed(at(27),manager);await leave(at(27),[{kind:'department_head'}]);
    await headed(at(32),cross);await leave(at(32),[{kind:'department_head'}]);
   });
   await step('cancellations',async()=>{
    await cancellation(at(5),[]);
    await cancellation(at(14),[{kind:'direct_manager',status:'approved'},{kind:'hr_admin',alternates:[{kind:'specific_employee',employmentId:second.employmentId}]}]);
    await cancellation(at(7),[{kind:'direct_manager',status:'approved'}]);
    await cancellation(at(57),[{kind:'manager_manager'}]);
   });
   await step('resignations',()=>owner.db.insert(s.resignationRequest).values([8,60].map(position=>({tenantId,employmentId:at(position).employmentId,personId:at(position).ctx.personId!,lastWorkingDay:day(30)}))));
   await step('reviews',()=>owner.db.insert(s.employmentReview).values([
    {tenantId,employmentId:at(9).employmentId,personId:at(9).ctx.personId!,managerEmploymentId:manager.employmentId,endDate:day(40),dueDate:day(10),reviewType:'contract' as const},
    {tenantId,employmentId:at(10).employmentId,personId:at(10).ctx.personId!,managerEmploymentId:manager.employmentId,endDate:day(40),dueDate:day(11),reviewType:'contract' as const,status:'pending_hr' as const},
    {tenantId,employmentId:at(61).employmentId,personId:at(61).ctx.personId!,managerEmploymentId:at(52).employmentId,endDate:day(40),dueDate:day(12),reviewType:'contract' as const,status:'pending_hr' as const},
   ]));
   const {requestAttendanceCorrection}=await import('../../core/attendance');
   await step('attendanceWorkflow',()=>requestAttendanceCorrection(at(35).ctx,{employmentId:at(35).employmentId,date:day(-5),checkIn:'09:00',checkOut:'18:00',reason:'Fictional workflow correction'}));
   // A pending correction outside every workflow (a manager is in no criteria): decided by the legacy authority.
   await step('attendanceLegacy',()=>owner.client`insert into attendance_correction(tenant_id,employment_id,attendance_date,proposed_check_in,proposed_check_out,reason)
    values(${tenantId}::uuid,${second.employmentId}::uuid,${day(-6)}::date,'09:00','18:00','Fictional legacy correction')`);
   await step('profile',()=>owner.db.insert(s.profileChangeRequest).values({tenantId,employmentId:at(11).employmentId,personId:at(11).ctx.personId!,proposed:{preferredName:'Fictional preferred name'}}));
   // A current OneHR cycle for company 0: the managers' review queue and assessment rows, a OneHR feedback panel for the
   // cross-company manager and a department calibration session naming the manager.
   await step('performance',async()=>{
    const perf=await import('../../packs/performance/service'),{defaultPolicy}=await import('../../packs/performance/onehr/model');
    const framework=(await import('../../packs/performance/onehr/framework.json')).default;
    const admin=at(0).ctx,companyId=at(0).companyId;
    const [grade]=await owner.db.insert(s.jobGrade).values({tenantId,code:'17',name:'Fictional performance grade'}).returning();
    await owner.client`update employment set grade_id=${grade.id}::uuid where tenant_id=${tenantId}::uuid and company_id=${companyId}::uuid`;
    const {cycleId}=await perf.createCycle(admin,{name:'Fictional current assessment',companyId,periodStart:day(-30),periodEnd:day(30)});
    await perf.configureOnehrCycle(admin,cycleId,null,defaultPolicy(framework));await perf.openCycle(admin,{cycleId});
    const reviewOf=async(subject:Actor)=>(await owner.db.select({id:s.performanceReview.id}).from(s.performanceReview)
     .where(and(eq(s.performanceReview.cycleId,cycleId),eq(s.performanceReview.employmentId,subject.employmentId))))[0].id;
    const reviewId=await reviewOf(at(5)),view=await perf.getOnehrReview(admin,reviewId);
    await perf.assignOnehrPanel(admin,reviewId,view!.revision,[{employmentId:at(6).employmentId,relationship:'peer'}]);
    // Calibration writes are the performance administrator's (as test/p1-wpa2-performance-home.test.ts seeds them).
    const entries=await Promise.all([5,7,8].map(async position=>({reviewId:await reviewOf(at(position)),employmentId:at(position).employmentId})));
    await withTenant(admin,async tx=>{
     const [session]=await tx.insert(s.onehrCalibration).values({tenantId,cycleId,companyId,name:'Fictional department calibration',tier:'hod',reviewerUserIds:[manager.ctx.userId!]}).returning();
     for(const entry of entries)await tx.insert(s.onehrCalibrationEntry).values({tenantId,sessionId:session.id,...entry});
    });
   });
  }else{
   // Only this tenant's manager (and its administrators, not compared) sees these: the owner throws a non-refusal error.
   await step('errorChains',async()=>{
    await leave(at(5),[{kind:'mystery_kind'}]);
    await leave(at(6),[{kind:'specific_employee',approver:null}]);
    await cancellation(at(7),[{kind:'mystery_kind'}]);
   });
  }
 }
 return failures;
}

/** The account task statement's own planning and execution time: the statement the bundle sends (captured from the
 * driver), explained under the subject's own session. Diagnostic only. */
async function explainTaskStatement(ctx:SessionContext,modules:import('../../core/account-task-bundle').AccountTaskModules){
 const {readAccountTaskBundle}=await import('../../core/account-task-bundle');
 const options=applicationClient.options as {debug?:unknown},previous=options.debug;let captured:{query:string;params:unknown[]}|undefined;
 options.debug=(_connection:number,query:string,params:unknown[])=>{if(query.includes(') as principal,'))captured={query,params:[...(params??[])]};};
 try{await withSharedReadSnapshot(ctx,()=>readAccountTaskBundle(ctx,modules));}finally{options.debug=previous;}
 const statement=captured;
 if(!statement)return {captured:false};
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`set local jit=off`);
  const client=(tx as unknown as {session:{client:{unsafe:(query:string,params:unknown[])=>Promise<Record<string,unknown>[]>}}}).session.client;
  const [row]=await client.unsafe('explain (analyze, summary, format json) '+statement.query,statement.params);
  type Node={'Node Type':string;'Subplan Name'?:string;'Relation Name'?:string;'Function Name'?:string;'Actual Total Time'?:number;'Actual Loops'?:number;Plans?:Node[]};
  const plan=(row['QUERY PLAN'] as {'Planning Time':number;'Execution Time':number;Plan:Node}[])[0];
  const nodes:{node:string;ms:number;loops:number}[]=[];
  const walk=(node:Node)=>{nodes.push({node:[node['Subplan Name'],node['Node Type'],node['Relation Name']??node['Function Name']].filter(Boolean).join(' '),
   ms:Math.round((node['Actual Total Time']??0)*(node['Actual Loops']??1)*10)/10,loops:node['Actual Loops']??0});for(const child of node.Plans??[])walk(child);};
  walk(plan.Plan);
  return {planningMs:Math.round(plan['Planning Time']),executionMs:Math.round(plan['Execution Time']),chars:statement.query.length,params:statement.params.length,
   top:nodes.filter(node=>node.node.startsWith('SubPlan')||node.node.startsWith('InitPlan')||node.node.startsWith('CTE')).sort((a,b)=>b.ms-a.ms).slice(0,12)};
 },{readOnlySnapshot:true});
}
// ── Request preamble (docs/adr/2026-11-10-home-request-read-scope.md decision 12, core/home-request-preamble.ts): every
// card, Today section, the stream and one page render with each carrier's preamble (shipped) and with every owner sending
// its own proofs, identity and configuration reads (withOwnerPreambleReads); each answered statement against the owner's
// own statement in one snapshot; foreign identities and employments inside a host carrier; and a login whose principal
// proof fails. ──────────────────────────────────────────────────────────────────────────────────────────────────────────
type PreambleTraceRow={before:number;after:number;beforeStatements:unknown;afterStatements:unknown;afterOrdered:string[];beforeOrdered:string[];
 shared:ReturnType<typeof sharedSummary>;seeded:number;preambles:number;failure:unknown};
type TodayTargets=Awaited<ReturnType<typeof todayReaders>>;
/** A card read as the stream reads it: inside one carrier whose request declared the stream's preamble. */
async function preambleCard(actor:Actor,employmentId:string,month:string,card:Card){
 const {declareSharedReadPreamble}=await import('../../db/client'),{homeRequestPreamble}=await import('../../core/home-request-preamble');
 return withSharedReadSnapshot(actor.ctx,()=>{declareSharedReadPreamble(homeRequestPreamble(employmentId));return readers(actor.ctx,employmentId,month)[card]();});
}
async function preambleTraces(label:string,actor:Actor,month:string,todayTargets:TodayTargets,pageSections:readonly string[]){
 const {withOwnerPreambleReads}=await import('../../db/client');
 const trace=async(work:()=>Promise<unknown>):Promise<PreambleTraceRow>=>{
  await work().catch(()=>undefined);
  sharedStats.length=0;const old=await traceStatements(()=>withOwnerPreambleReads(work));sharedStats.length=0;
  const fresh=await traceStatements(work),stats=sharedStats.splice(0);
  return {before:old.trace.trips,after:fresh.trace.trips,beforeStatements:old.trace.statements,afterStatements:fresh.trace.statements,afterOrdered:fresh.trace.ordered,
   beforeOrdered:old.trace.ordered,shared:sharedSummary(stats),seeded:stats.reduce((n,row)=>n+(row.seeded??0),0),preambles:stats.reduce((n,row)=>n+(row.preambles??0),0),
   failure:fresh.failure??old.failure};
 };
 const rows:Record<string,PreambleTraceRow>={},targets=await todayTargets(actor.ctx);
 for(const card of CARDS)rows['preamble:card:'+card]=await trace(()=>preambleCard(actor,actor.employmentId,month,card));
 for(const name of pageSections)rows['preamble:section:'+name]=await trace(()=>todayTargets.pageRender(()=>targets[name]()));
 rows['preamble:stream']=await trace(()=>streamHome(actor,month,null));
 rows['preamble:sections']=await trace(()=>todayTargets.pageRender(()=>Promise.all(pageSections.map(name=>targets[name]()))));
 rows['preamble:page']=await trace(()=>Promise.all([streamHome(actor,month,null),todayTargets.pageRender(()=>Promise.all(pageSections.map(name=>targets[name]())))]));
 const pair=(name:string)=>[rows[name].before,rows[name].after];
 print('preamble-trips',{label,stream:pair('preamble:stream'),sections:pair('preamble:sections'),page:pair('preamble:page'),
  seeded:{stream:rows['preamble:stream'].seeded,sections:rows['preamble:sections'].seeded,page:rows['preamble:page'].seeded},
  carriers:{stream:rows['preamble:stream'].preambles,sections:rows['preamble:sections'].preambles,page:rows['preamble:page'].preambles},
  cards:Object.fromEntries(CARDS.map(card=>[card,pair('preamble:card:'+card)])),eachSection:Object.fromEntries(pageSections.map(name=>[name,pair('preamble:section:'+name)])),
  failures:Object.fromEntries(Object.entries(rows).filter(([,row])=>row.failure).map(([name,row])=>[name,row.failure])),
  streamStatements:rows['preamble:stream'].afterOrdered,sectionStatements:rows['preamble:sections'].afterOrdered});
 return rows;
}
/** Each statement the preamble answers, against that owner statement sent by itself, in one read-only snapshot. */
async function preambleSeedsAgainstOwners(ctx:SessionContext,employmentId?:string){
 const {homeRequestPreamble}=await import('../../core/home-request-preamble');
 return withTenant(ctx,async tx=>{
  const preamble=homeRequestPreamble(employmentId).build(ctx,tx);
  if(!preamble)return {built:false,pairs:[]};
  const [row]=await tx.execute(sql`select (${preamble.sql}) as preamble`) as unknown as {preamble:unknown}[];
  const seeds=preamble.decode(row.preamble);
  type Sent=PromiseLike<unknown[]>&{values():PromiseLike<unknown[]>};
  const driver=(tx as unknown as {session:{client:{unsafe(query:string,params:unknown[]):Sent}}}).session.client;
  const pairs:{statement:string;mode:string;owner:unknown[];seeded:unknown[]}[]=[];
  for(const seed of seeds){
   const sent=driver.unsafe(seed.query,seed.params);
   pairs.push({statement:seed.query.replace(/\s+/g,' ').slice(0,70),mode:seed.mode,owner:[...await (seed.mode==='values'?sent.values():sent)],seeded:seed.rows});
  }
  return {built:true,pairs};
 },{readOnlySnapshot:true});
}
/** A second own employment for one person, a Home configuration revision and a stored dashboard layout, added after the
 * traces so their counts stay comparable. */
async function preambleFixtures(actors:Actor[]){
 const at=(index:number)=>actors.find(a=>a.index===index)!;
 const {defaultEmployeeHomeConfiguration}=await import('../../lib/employee-home-defaults');
 const {saveEmployeeHomeConfiguration}=await import('../../core/employee-home-configuration');
 // The configuration writer itself, as the group HR administrator (its guard trigger admits only an administrator).
 for(const [actor,role] of [[at(2),'manager'],[at(4),'employee'],[at(54),'employee']] as const)
  await saveEmployeeHomeConfiguration(at(0).ctx,{companyId:actor.companyId,audienceRole:role,expectedOrdinal:0,configuration:defaultEmployeeHomeConfiguration(),
   reason:'Fictional preamble fixture'}).catch(error=>print('preamble-fixture-configuration',errorFact(error)));
 await owner.client`update app_user set dashboard_layout=${JSON.stringify({homeDisplay:{version:1,timeZone:'Asia/Kuala_Lumpur',weekStartsOn:1},
  employee:{selected:['summary','greeting','tasks'],order:['tasks','summary','greeting']}})}::jsonb where id=${at(2).ctx.userId!}::uuid`;
 let second:string|null=null;
 try{
  const [row]=await owner.client<{id:string}[]>`insert into employment select (jsonb_populate_record(null::employment,to_jsonb(e)||jsonb_build_object('id',gen_random_uuid(),
   'employee_code','PERF2ND','company_id',${at(70).companyId}::uuid))).* from employment e where e.id=${at(20).employmentId}::uuid returning id::text as id`;
  second=row?.id??null;
 }catch(error){second=null;print('preamble-fixture-second-employment',errorFact(error));}
 return {second,twoEmployments:at(20)};
}
async function preambleEquivalence(subject:string,actor:Actor,month:string,compare:(subject:string,target:string,old:unknown,fresh:unknown)=>void,
 todayTargets:TodayTargets,employmentId:string=actor.employmentId){
 const {withOwnerPreambleReads}=await import('../../db/client');
 const own=<T,>(work:()=>Promise<T>)=>withOwnerPreambleReads(work);
 const byCard=(frames:Record<string,unknown>)=>Object.fromEntries(Object.entries(frames).sort(([a],[b])=>a.localeCompare(b)));
 const streamActor={...actor,employmentId};
 const oldFrames:Record<string,unknown>={},newFrames:Record<string,unknown>={};
 await own(()=>streamHome(streamActor,month,null,GET,oldFrames));
 await streamHome(streamActor,month,null,GET,newFrames);
 compare(subject,'preamble:stream',byCard(oldFrames),byCard(newFrames));
 for(const card of CARDS){
  const read=()=>preambleCard(actor,employmentId,month,card);
  compare(subject,'preamble:card:'+card,await outcome(()=>own(read)),await outcome(read));
 }
 // Every answered statement against the owner's statement itself, for the stream's employment and for a page render.
 let answered=0;
 for(const [mode,requested] of [['stream',employmentId],['page',undefined]] as const){
  const {built,pairs}=await preambleSeedsAgainstOwners(actor.ctx,requested);
  compare(subject,'preamble:built:'+mode,true,built);
  for(const [index,row] of pairs.entries()){answered++;compare(subject,'preamble:seed:'+mode+':'+index+':'+row.mode+':'+row.statement,row.owner,row.seeded);}
 }
 // A login whose company scope cannot be read renders no section: the same refusal both ways.
 const targets=await todayTargets(actor.ctx).catch(()=>null);
 if(!targets){compare(subject,'preamble:sections',await outcome(()=>own(()=>todayTargets(actor.ctx))),await outcome(()=>todayTargets(actor.ctx)));return answered;}
 for(const [name,read] of Object.entries(targets))
  compare(subject,'preamble:section:'+name,await outcome(()=>own(()=>todayTargets.pageRender(read))),await outcome(()=>todayTargets.pageRender(read)));
 // One page render of every complete section value and page owner at once.
 const sectionReads=await import('../../components/today/reads'),{todayAudience}=await import('../../lib/today/audience');
 const {readMyPayrollReadiness}=await import('../../core/pre-salary/person-items'),{allowedCompanies}=await import('../../core/read');
 const today=todayInKualaLumpur(),scopeIds=(await allowedCompanies(actor.ctx)).map(company=>company.id);
 const full:Record<string,()=>Promise<unknown>>={
  needsYou:()=>sectionReads.readNeedsYou(actor.ctx,{scopeIds,audience:todayAudience(actor.ctx),today,locale:'en',now:Date.parse(today+'T12:00:00+08:00')}),
  doneForYou:()=>sectionReads.readDoneForYou(actor.ctx,{scopeIds,today}),
  atAGlance:()=>sectionReads.readAtAGlance(actor.ctx,{locale:'en',today}),
  beforePayroll:()=>readMyPayrollReadiness(actor.ctx,{scopeIds,locale:'en',today,includeApprovals:false}),
  ...await fullPageOwners(actor.ctx,scopeIds),
 };
 const render=()=>todayTargets.pageRender(async()=>Object.fromEntries(await Promise.all(Object.entries(full).map(async([name,read])=>[name,await outcome(read)] as const))));
 const [offPage,onPage]=[await own(render),await render()];
 for(const name of Object.keys(full))compare(subject,'preamble:pageRender:'+name,offPage[name],onPage[name]);
 return answered;
}
/** A foreign identity or employment inside a host carrier that read the host's preamble never receives the host's answers. */
async function preambleIsolation(host:Actor,guest:Actor,month:string,compare:(subject:string,target:string,old:unknown,fresh:unknown)=>void){
 const {declareSharedReadPreamble}=await import('../../db/client'),{homeRequestPreamble}=await import('../../core/home-request-preamble');
 sharedStats.length=0;
 const inside=await withSharedReadSnapshot(host.ctx,async()=>{
  declareSharedReadPreamble(homeRequestPreamble(host.employmentId));
  await readers(host.ctx,host.employmentId,month).greeting().catch(()=>undefined);
  const out:Record<string,unknown>={};
  for(const card of CARDS){
   out['guest:'+card]=await outcome(()=>readers(guest.ctx,guest.employmentId,month)[card]());
   out['foreignEmployment:'+card]=await outcome(()=>readers(host.ctx,guest.employmentId,month)[card]());
  }
  return out;
 });
 const stats=sharedStats.splice(0);
 for(const card of CARDS){
  compare('guest:'+guest.index,'preamble:guestInsideHost:'+card,await outcome(()=>withIndependentTransactions(()=>readers(guest.ctx,guest.employmentId,month)[card]())),inside['guest:'+card]);
  compare('host:'+host.index,'preamble:foreignEmployment:'+card,await outcome(()=>withIndependentTransactions(()=>readers(host.ctx,guest.employmentId,month)[card]())),inside['foreignEmployment:'+card]);
 }
 return {seeded:stats.reduce((n,row)=>n+(row.seeded??0),0),joins:stats.reduce((n,row)=>n+row.joins,0),fallbacks:stats.reduce((n,row)=>n+row.fallbacks,0)};
}
// ── end of the request preamble block ──

// ── Decision 13: the greeting's own facts, the notices card, Needs you's statement, the assigned-performance check and At a
// glance's "Coming up" as single statements (core/home-owner-reads.ts, core/needs-you-bundle.ts). Traces (owners against
// the shipped path in the same shared snapshots), fixture rows added after the traces, and the comparisons; each helper is
// called from one line. ──────────────────────────────────────────────────────────────────────────────────────────────
type CardsSectionsRow={before:number;after:number;beforeStatements:unknown;afterStatements:unknown;afterOrdered:string[];beforeOrdered:string[];shared:SharedSummary;failure:unknown};
async function cardsSectionsTraces(label:string,actor:Actor,month:string,targets:Record<string,()=>Promise<unknown>>,pageRendered:()=>Promise<unknown>){
 const {withOwnerCardSectionReads}=await import('../../core/home-owner-reads');
 const trace=async(work:()=>Promise<unknown>):Promise<CardsSectionsRow>=>{
  await work().catch(()=>undefined);
  sharedStats.length=0;const old=await traceStatements(()=>withOwnerCardSectionReads(work));sharedStats.length=0;
  const fresh=await traceStatements(work);
  return {before:old.trace.trips,after:fresh.trace.trips,beforeStatements:old.trace.statements,afterStatements:fresh.trace.statements,
   afterOrdered:fresh.trace.ordered,beforeOrdered:old.trace.ordered,shared:sharedSummary(sharedStats.splice(0)),failure:fresh.failure??old.failure};
 };
 const read=(card:Card)=>()=>withSharedReadSnapshot(actor.ctx,()=>readers(actor.ctx,actor.employmentId,month)[card]());
 const rows:Record<string,CardsSectionsRow>={
  'cardsSections:card:greeting':await trace(read('greeting')),
  'cardsSections:card:notices':await trace(read('notices')),
  'cardsSections:section:needsYou':await trace(targets.needsYou),
  'cardsSections:section:atAGlance':await trace(targets.atAGlance),
  'cardsSections:section:page.assignedPerformance':await trace(targets['page.assignedPerformance']),
  'cardsSections:section:page.greetingIdentity':await trace(targets['page.greetingIdentity']),
  'cardsSections:stream':await trace(()=>streamHome(actor,month,null)),
  'cardsSections:page':await trace(pageRendered),
 };
 const trips=Object.fromEntries(Object.entries(rows).map(([name,row])=>[name.slice('cardsSections:'.length),[row.before,row.after]]));
 print('cards-sections-trips',{label,trips,greetingStatements:rows['cardsSections:card:greeting'].afterOrdered,noticeStatements:rows['cardsSections:card:notices'].afterOrdered,
  needsYouStatements:rows['cardsSections:section:needsYou'].afterOrdered,atAGlanceStatements:rows['cardsSections:section:atAGlance'].afterOrdered,
  assignedPerformanceStatements:rows['cardsSections:section:page.assignedPerformance'].afterOrdered});
 return rows;
}
/** Rows every decision-13 path reads, added after the traces. Each insert is fictional and stands alone: one the schema
 * or an owner refuses is recorded and skipped. Notices and letter requests go through their owners' own writers. */
async function cardsSectionsFixtures(actors:readonly Actor[],others:readonly Actor[],today:string){
 const seeded:string[]=[],refused:Record<string,string>={};
 const step=async(name:string,work:()=>Promise<unknown>)=>{try{await work();seeded.push(name);}catch(error){refused[name]=String((error as Error)?.message??error).slice(0,200);}};
 const day=(offset:number)=>shiftDays(today,offset),at=(index:number)=>actors.find(a=>a.index===index)!;
 const group=actors.find(a=>a.role==='groupHR')!,reviewer=actors.find(a=>a.role==='companyHR'&&a.company===0)!;
 const [manager,secondManager,employee,peer,onLeave]=[at(2),at(3),at(4),at(5),at(54)],tenantId=group.ctx.tenantId;
 const [{leaveTypeId}]=await owner.client<{leaveTypeId:string}[]>`select leave_type_id as "leaveTypeId" from leave_request where tenant_id=${tenantId}::uuid limit 1`;
 // Greeting: a recorded preferred name, two photos, a birthday today (28 years back keeps a 29 February) and an approved
 // full-day leave yesterday, so the return-from-leave lookback has a candidate and its workday checks run.
 await step('greeting:preferredName',()=>owner.db.update(s.person).set({preferredName:'Fictional Preferred'}).where(eq(s.person.id,employee.ctx.personId!)));
 await step('greeting:photos',()=>owner.db.insert(s.personPhoto).values([employee,manager].map(a=>({tenantId,personId:a.ctx.personId!,
  content:Buffer.from([137,80,78,71,13,10,26,10]),fileName:'fictional.png',mimeType:'image/png',sizeBytes:8}))));
 await step('greeting:birthday',()=>owner.db.update(s.person).set({dateOfBirth:String(Number(today.slice(0,4))-28)+today.slice(4)}).where(eq(s.person.id,manager.ctx.personId!)));
 await step('greeting:returnFromLeave',()=>owner.db.insert(s.leaveRequest).values({tenantId,employmentId:secondManager.employmentId,leaveTypeId,startDate:day(-1),endDate:day(-1),days:'1',status:'approved'}));
 // Notices through the owner's publish path: one requiring acknowledgement (acknowledged by the employee), one pinned
 // and one plain (read by the employee).
 await step('notices',async()=>{
  const {createNotice,publishNotice,markNoticeViewed,acknowledgeNotice}=await import('../../core/notice');
  const audience=[employee,manager,secondManager].map(a=>a.employmentId);
  const publish=async(title:string,extra:Record<string,unknown>)=>{
   const created=await createNotice(group.ctx,{title,summary:'Fictional summary',body:'Fictional untransported body',startOn:day(-1),endOn:day(5),targetMode:'individual',employmentIds:audience,...extra});
   await publishNotice(group.ctx,created.id);return created.id;
  };
  const required=await publish('Fictional acknowledgement notice',{requiresAcknowledgement:true,category:'Policy'});
  await publish('Fictional pinned notice',{pinned:true});
  const plain=await publish('Fictional plain notice',{});
  await markNoticeViewed(employee.ctx,plain,employee.employmentId);
  await acknowledgeNotice(employee.ctx,required,employee.employmentId,1);
  await markNoticeViewed(manager.ctx,required,manager.employmentId);
 });
 // Loops on (through the owner's switch), the recommender on, an active AI Centre generation here and a stopped one in
 // the other tenant.
 const {setWorkerSwitch}=await import('../../core/agent-registry/controls');
 for(const workerId of ['loop_missed_clock_outs','loop_missing_employee_data','loop_document_expiry','loop_probation_ending','loop_payroll_inputs','approver_recommendation'])
  await step('switch:'+workerId,()=>setWorkerSwitch(group.ctx,{workerId,enabled:true}));
 const teras=await import('../../db/teras-schema'),autonomy=await import('../../db/teras-autonomy-schema');
 // The mandate control's writers bind the tenant first (app.ai_centre_mandate_write_order).
 const control=(bound:string,stopped:boolean,version:number,userId:string)=>owner.client.begin(async tx=>{
  await tx`select set_config('app.tenant_id',${bound},true)`;
  await tx`insert into teras_mandate_control(tenant_id,stopped,version,changed_by_user_id) values(${bound}::uuid,${stopped},${version},${userId}::uuid)
   on conflict (tenant_id) do update set stopped=excluded.stopped,version=excluded.version`;
 });
 const otherGroup=others.find(a=>a.role==='groupHR')!;
 await step('aiCentre:running',()=>control(tenantId,false,4,group.ctx.userId!));
 await step('aiCentre:stopped',()=>control(otherGroup.ctx.tenantId,true,2,otherGroup.ctx.userId!));
 // Open cases of several kinds: own clock-outs, a record gap and a passport for the employee; two clock-outs for the
 // manager; two clock-outs whose order key ties for the second manager (the owner reads); HR cards; and own cases in a
 // company where one loop is paused and another at Watch.
 const run=randomUUID(),companyOne=actors.find(a=>a.company===1)!.companyId;
 // The case table's own key shape: kind, the employment, and for a dated case its date.
 const key=(a:Actor,kind:string,date?:string)=>kind+':'+a.employmentId+(date?':'+date:'');
 const kase=(a:Actor,workerId:string,subjectKey:string,recipient:'employee'|'hr',facts:Record<string,unknown>)=>({tenantId,workerId:workerId as 'loop_missed_clock_outs',companyId:a.companyId,
  employmentId:a.employmentId,subjectKey,recipient,state:'open' as const,facts:facts as typeof teras.terasLoopCase.$inferInsert['facts'],openedRunId:run,checkedRunId:run});
 let cases:{id:string;subjectKey:string;employmentId:string|null}[]=[];
 await step('loops:cases',async()=>{cases=await owner.db.insert(teras.terasLoopCase).values([
  kase(employee,'loop_missed_clock_outs',key(employee,'clockout',day(-2)),'employee',{date:day(-2),checkIn:'09:00',proposedCheckOut:'18:00'}),
  kase(employee,'loop_missing_employee_data',key(employee,'record'),'employee',{gaps:['bankAccount'],tabs:['bankStatutory']}),
  kase(employee,'loop_document_expiry',key(employee,'passport'),'employee',{expiresOn:day(40)}),
  kase(manager,'loop_missed_clock_outs',key(manager,'clockout',day(-3)),'employee',{date:day(-3),checkIn:'09:05',proposedCheckOut:'18:00'}),
  kase(manager,'loop_missed_clock_outs',key(manager,'clockout',day(-4)),'employee',{date:day(-4),checkIn:'09:05',proposedCheckOut:'17:30'}),
  // Two clock-out cards whose order key (the date in their facts) ties.
  kase(secondManager,'loop_missed_clock_outs',key(secondManager,'clockout',day(-2)),'employee',{date:day(-2),checkIn:'09:00',proposedCheckOut:'18:00'}),
  kase(secondManager,'loop_missed_clock_outs',key(secondManager,'clockout',day(-6)),'employee',{date:day(-2),checkIn:'10:00',proposedCheckOut:'19:00'}),
  kase(at(10),'loop_probation_ending',key(at(10),'probation'),'hr',{endDate:day(10),stage:'none'}),
  kase(at(11),'loop_document_expiry',key(at(11),'passport'),'hr',{expiresOn:day(20)}),
  kase(onLeave,'loop_document_expiry',key(onLeave,'passport'),'employee',{expiresOn:day(30)}),
  kase(onLeave,'loop_missing_employee_data',key(onLeave,'record'),'employee',{gaps:['bankAccount'],tabs:['bankStatutory']}),
 ]).returning({id:teras.terasLoopCase.id,subjectKey:teras.terasLoopCase.subjectKey,employmentId:teras.terasLoopCase.employmentId});});
 await step('loops:pause',()=>owner.db.insert(teras.terasLoopPause).values({tenantId,workerId:'loop_document_expiry',companyId:companyOne,paused:true,changedByUserId:group.ctx.userId!}));
 await step('loops:watch',()=>owner.db.insert(autonomy.terasLoopLevel).values({tenantId,workerId:'loop_missing_employee_data',companyId:companyOne,level:0,changedBy:'administrator',changedByUserId:group.ctx.userId!}));
 // Open undo windows on own days: one for the employee, one for the manager, and two created at the same instant for the
 // second manager (a tie on the owner's order key: the owner reads).
 const caseOf=(subjectKey:string)=>cases.find(row=>row.subjectKey===subjectKey)?.id;
 // An applied action names the owner's record it applied (owner_ref; the table requires it for 'applied'): the
 // approved attendance correction of that day, as test/teras-loop-autonomy.test.ts restores one.
 const action=(a:Actor,caseId:string|undefined,date:string,ownerRef:string,createdAt?:Date)=>({tenantId,workerId:'loop_missed_clock_outs' as const,companyId:a.companyId,caseId:caseId!,employmentId:a.employmentId,
  runId:run,level:2 as const,state:'applied' as const,ruleVersion:'loop_missed_clock_outs.act@v1',sponsorUserId:group.ctx.userId!,agentPrincipalId:randomUUID(),checks:[],
  facts:{date,checkIn:'09:00',checkOut:'18:00'},ownerRef,appliedAt:new Date(),undoUntil:new Date(Date.now()+86400000),...(createdAt?{createdAt}:{})});
 await step('loops:autonomy',async()=>{
  const tie=new Date(Date.now()-60000);
  const correction=async(a:Actor,date:string)=>(await owner.db.insert(s.attendanceCorrection).values({tenantId,employmentId:a.employmentId,attendanceDate:date,
   proposedCheckIn:'09:00',proposedCheckOut:'18:00',reason:'Fictional loop clock-out',status:'approved',decidedAt:new Date()}).returning({id:s.attendanceCorrection.id}))[0].id;
  await owner.db.insert(autonomy.terasLoopAction).values([
   action(employee,caseOf(key(employee,'clockout',day(-2))),day(-2),await correction(employee,day(-2))),
   action(manager,caseOf(key(manager,'clockout',day(-3))),day(-3),await correction(manager,day(-3))),
   action(secondManager,caseOf(key(secondManager,'clockout',day(-2))),day(-2),await correction(secondManager,day(-2)),tie),
   action(secondManager,caseOf(key(secondManager,'clockout',day(-6))),day(-2),await correction(secondManager,day(-6)),tie)]);
 });
 // Letter requests through the owners: a template approved by a second HR administrator, opened for requests, and two
 // employees' requests waiting in company 0.
 await step('letterRequests',async()=>{
  const letters=await import('../../core/letters'),requests=await import('../../core/letter-requests'),companyId=employee.companyId;
  const field=await letters.saveLetterField(group.ctx,{companyId,definition:{key:'employeeName',label:'Employee name',description:'Canonical name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false},active:true});
  const template=await letters.saveLetterTemplate(group.ctx,{companyId,code:'PERFCONF',name:'Fictional Employment Confirmation Letter',category:'confirmation',effectiveFrom:today,
   document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'This confirms that '},{type:'field',key:'employeeName'},{type:'text',text:' is employed.'}]}]},fieldVersionIds:[field.id]});
  await letters.decideLetterTemplate(group.ctx,{versionId:template.versionId,expectedStatus:'draft',action:'submit'});
  await letters.decideLetterTemplate(reviewer.ctx,{versionId:template.versionId,expectedStatus:'submitted',action:'approve'});
  await requests.saveLetterRequestOptions(group.ctx,{companyId,changes:[{templateId:template.templateId,requestable:true}]});
  for(const a of [employee,peer])await requests.submitLetterRequest(a.ctx,{templateId:template.templateId});
 });
 // Review index rows of all three kinds (terminal, so no reopen runs) for the employee and the manager.
 for(const a of [employee,manager])await step('reviewIndex:'+a.index,async()=>{
  const created=new Date(Date.now()-120000),expires=new Date(created.getTime()+600000);
  await owner.db.execute(sql`insert into app.assistant_own_leave_review(id,tenant_id,user_id,person_id,employment_id,company_id,intent_digest,reviewed_digest,state,created_at,expires_at)
   values(${randomUUID()}::uuid,${tenantId}::uuid,${a.ctx.userId!}::uuid,${a.ctx.personId!}::uuid,${a.employmentId}::uuid,${a.companyId}::uuid,NULL,NULL,'discarded',${created.toISOString()}::timestamptz,${expires.toISOString()}::timestamptz)`);
  await owner.db.execute(sql`insert into app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,state,created_at,expires_at,receipt_subject_kind,receipt_subject_id)
   values('leave.cancel',${randomUUID()}::uuid,${tenantId}::uuid,${a.ctx.userId!}::uuid,${a.ctx.personId!}::uuid,${a.employmentId}::uuid,${a.companyId}::uuid,'discarded',${created.toISOString()}::timestamptz,${expires.toISOString()}::timestamptz,'leave_request',${randomUUID()}::uuid)`);
  await owner.db.execute(sql`insert into app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,state,created_at,expires_at,decision_request_id,decision_subject_person_id)
   values('approvals.leave.decide',${randomUUID()}::uuid,${tenantId}::uuid,${a.ctx.userId!}::uuid,${a.ctx.personId!}::uuid,${a.employmentId}::uuid,${a.companyId}::uuid,'expired',${created.toISOString()}::timestamptz,${expires.toISOString()}::timestamptz,${randomUUID()}::uuid,${peer.ctx.personId!}::uuid)`);
 });
 return {seeded,refused};
}
/** Every decision-13 path against its owners for one subject: each read alone and inside one shared snapshot, each
 * Needs you section against its owner, the stream and the page render. */
async function cardsSectionsEquivalence(subject:string,actor:Actor,today:string,month:string,pageRender:<T>(work:()=>Promise<T>)=>Promise<T>,
 compare:(subject:string,target:string,old:unknown,fresh:unknown)=>void){
 const {withOwnerCardSectionReads}=await import('../../core/home-owner-reads');
 const reads=await import('../../components/today/reads'),{todayAudience}=await import('../../lib/today/audience'),{allowedCompanies,reportingLinesFor}=await import('../../core/read');
 const home=await import('../../core/employee-home'),homeNotices=await import('../../core/employee-home-notices'),performanceService=await import('../../packs/performance/service');
 const tasks=await import('../../packs/performance/onehr/tasks'),reviews=await import('../../core/home-leave-review-presentation'),needs=await import('../../core/needs-you-bundle');
 const loops=await import('../../core/loops/cards'),letters=await import('../../core/letter-requests'),controls=await import('../../core/agent-registry/controls');
 const {RECOMMENDER_WORKER}=await import('../../core/recommenders/leave-decision'),sharing=await import('../../core/employee-home-sharing');
 const {isModuleEnabled}=await import('../../core/entitlements'),{addHrDays}=await import('../../lib/today/audience');
 const ctx=actor.ctx,id=actor.employmentId,scopeIds=(await allowedCompanies(ctx)).map(company=>company.id),audience=todayAudience(ctx);
 const admin=audience.layout==='administrator',now=new Date(),noon=Date.parse(today+'T12:00:00+08:00');
 const both=async(name:string,read:()=>Promise<unknown>)=>{
  compare(subject,'cardsSections:'+name,await outcome(()=>withOwnerCardSectionReads(read)),await outcome(read));
  compare(subject,'cardsSections:'+name+':shared',await outcome(()=>withOwnerCardSectionReads(()=>withSharedReadSnapshot(ctx,read))),await outcome(()=>withSharedReadSnapshot(ctx,read)));
 };
 const full:Record<string,()=>Promise<unknown>>={
  greeting:()=>readEmployeeHomeGreeting(ctx,id,'en',now),
  greetingNoon:()=>readEmployeeHomeGreeting(ctx,id,'en',new Date(noon)),
  greetingIdentity:()=>home.readEmployeeHomeGreetingIdentity(ctx,id),
  greetingIdentityDefault:()=>home.readEmployeeHomeGreetingIdentity(ctx),
  notices:()=>homeNotices.readEmployeeHomeNotices(ctx,id),
  noticeBoard:()=>homeNotices.readOwnNoticeBoard(ctx,id,{page:1,pageSize:5}),
  noticeBoardWide:()=>homeNotices.readOwnNoticeBoard(ctx,id,{pageSize:20}),
  noticeBoardQuery:()=>homeNotices.readOwnNoticeBoard(ctx,id,{query:'Fictional'}),
  noticeBoardCategory:()=>homeNotices.readOwnNoticeBoard(ctx,id,{category:'Policy'}),
  noticeBoardSecondPage:()=>homeNotices.readOwnNoticeBoard(ctx,id,{page:2,pageSize:1}),
  needsYou:()=>reads.readNeedsYou(ctx,{scopeIds,audience,today,locale:'en',now:noon}),
  atAGlance:()=>reads.readAtAGlance(ctx,{locale:'en',today}),
  atAGlanceEmployment:()=>reads.readAtAGlance(ctx,{locale:'en',today,employmentId:id}),
  assignedPerformance:()=>performanceService.hasAssignedPerformanceWork(ctx,scopeIds),
  assignedPerformanceAccount:()=>performanceService.hasAssignedPerformanceWork(ctx,undefined),
  ownLeaveIndex:()=>reviews.readHomeOwnLeaveReviewIndex(ctx),
 };
 for(const [name,read] of Object.entries(full))await both(name,read);
 // Each Needs you section the statement answered against its owner reading alone.
 const bundle=await withSharedReadSnapshot(ctx,()=>needs.readNeedsYouBundle(ctx,{scopeIds,admin,leave:isModuleEnabled(ctx,'leave'),recommender:RECOMMENDER_WORKER}));
 const answered:string[]=[],deferred:string[]=[];
 const section=async(name:string,answer:{value:unknown}|{refused:true}|null|undefined,owner:()=>Promise<unknown>,view:(value:unknown)=>unknown=value=>value)=>{
  if(!answer){deferred.push(name);return;}
  answered.push(name+('refused' in answer?':refused':''));
  const fresh='refused' in answer?{ok:false,error:{name:'Error',code:null}}:{ok:true,value:view(answer.value)};
  const old=await outcome(async()=>view(await withIndependentTransactions(owner)));
  compare(subject,'cardsSections:needsYou:'+name,old,fresh);
 };
 await section('cancellations',bundle?.cancellations,()=>reviews.readHomeLeaveCancellationReviewIndex(ctx));
 await section('decisions',bundle?.decisions,()=>reviews.readHomeLeaveDecisionReviewIndex(ctx));
 await section('loops',bundle?.loops,()=>loops.readLoopCards(ctx,{scopeIds,admin}));
 await section('letterRequests',bundle?.letterRequests,()=>letters.countWaitingLetterRequests(ctx,scopeIds));
 // Needs you reads only whether the gate lets the recommender run.
 await section('recommender',bundle?.recommender,()=>controls.workerRunGate(ctx,RECOMMENDER_WORKER),value=>(value as {run:boolean}).run);
 // The performance projection's one statement against its owner, for the page's company scope and the whole account.
 for(const [name,ids] of [['performance',scopeIds],['performanceAccount',undefined]] as const){
  const value=await withSharedReadSnapshot(ctx,()=>tasks.pendingPerformanceTasksFromStatement(ctx,ids===undefined?undefined:[...ids]));
  if(value===null){deferred.push(name);continue;}
  answered.push(name);
  compare(subject,'cardsSections:'+name,await outcome(()=>withIndependentTransactions(()=>tasks.pendingPerformanceTasks(ctx,ids===undefined?undefined:[...ids]))),{ok:true,value});
 }
 // Coming up: the calendar and the managers' ids against the two owners.
 const to=addHrDays(today,13),sorted=(ids:string[])=>[...new Set(ids)].sort();
 const away=await outcome(async()=>{const value=await withSharedReadSnapshot(ctx,()=>sharing.readHomeTeamCalendarAndManagers(ctx,id,today,to));return value&&{calendar:value.calendar,managers:sorted(value.managerEmploymentIds)};});
 compare(subject,'cardsSections:comingUp',await outcome(()=>withIndependentTransactions(async()=>{const [lines,calendar]=await Promise.all([reportingLinesFor(ctx,id),sharing.readHomeTeamCalendar(ctx,id,today,to)]);
  return {calendar,managers:sorted(lines.managers.map(line=>line.employmentId))};})),away);
 // The stream's frames, and every page owner at once in one render's request scope.
 const oldFrames:Record<string,unknown>={},newFrames:Record<string,unknown>={};
 await withOwnerCardSectionReads(()=>streamHome(actor,month,null,GET,oldFrames));
 await streamHome(actor,month,null,GET,newFrames);
 const byCard=(frames:Record<string,unknown>)=>Object.fromEntries(Object.entries(frames).sort(([a],[b])=>a.localeCompare(b)));
 compare(subject,'cardsSections:stream',byCard(oldFrames),byCard(newFrames));
 const page=()=>pageRender(async()=>Object.fromEntries(await Promise.all(Object.entries(full).map(async([name,read])=>[name,await outcome(read)] as const))));
 compare(subject,'cardsSections:pageRender',await withOwnerCardSectionReads(page),await page());
 return {subject,answered,deferred};
}
// ── end of the decision 13 block ──

type Traced={trips:number;statements:{sql:string;count:number}[];ordered:string[]};
const sharedStats:SharedReadStats[]=[];
(globalThis as {__aihrPerfSharedRead?:(stats:SharedReadStats)=>void}).__aihrPerfSharedRead=stats=>{sharedStats.push(stats);};
type SharedSummary={sessions:number;joins:number;fallbacks:number;sharedStatements:number;memoHits:number;flights:number;carriers:number;refused:Record<string,number>};
const sharedSummary=(rows:SharedReadStats[]):SharedSummary=>({sessions:rows.length,joins:rows.reduce((n,row)=>n+row.joins,0),fallbacks:rows.reduce((n,row)=>n+row.fallbacks,0),
 sharedStatements:rows.reduce((n,row)=>n+row.statements,0),memoHits:rows.reduce((n,row)=>n+row.memoHits,0),
 // Idle-to-busy transitions of the carrier connection: the driver pipelines statements sent while others are outstanding.
 flights:rows.reduce((n,row)=>n+(row.flights??0),0),carriers:rows.reduce((n,row)=>n+row.carriers,0),
 refused:rows.reduce((all,row)=>{for(const [reason,count] of Object.entries(row.refused))all[reason]=(all[reason]??0)+count;return all;},{} as Record<string,number>)});
/** Results without the response clock, which differs between any two reads. */
const comparable=(value:unknown)=>JSON.stringify(value,(key,item)=>key==='serverNow'?undefined:item);
async function outcome(read:()=>Promise<unknown>){try{return {ok:true,value:await read()};}catch(error){return {ok:false,error:{name:(error as Error)?.name??null,code:(error as {code?:string})?.code??null}};}}
async function traceStatements<T>(work:()=>Promise<T>){
 const options=applicationClient.options as {debug?:unknown},ordered:string[]=[],previous=options.debug;
 options.debug=(_connection:number,query:string)=>{ordered.push(query.replace(/\s+/g,' ').trim().slice(0,420));};
 let result:T|null=null,failure:unknown=null;
 try{result=await work();}catch(error){failure=errorFact(error);}finally{options.debug=previous;}
 const counts=new Map<string,number>();
 for(const text of ordered)counts.set(text,(counts.get(text)??0)+1);
 const trace:Traced={trips:ordered.length,statements:[...counts].map(([text,count])=>({sql:text,count})).sort((a,b)=>b.count-a.count),ordered};
 return {result,failure,trace};
}

async function streamHome(actor:Actor,month:string,run:string|null,handler:typeof GET=GET,values?:Record<string,unknown>){
 state.session=actor.ctx;state.run=run;
 const query=new URLSearchParams({employmentId:actor.employmentId});
 for(const card of CARDS)query.append('card',card);
 query.set('month',month);
 const started=performance.now();
 const response=await handler(new Request('http://localhost/api/home/sharing-initial?'+query));
 expect(response.status).toBe(200);
 const reader=response.body!.getReader(),decoder=new TextDecoder();
 const frames:{card:string;status:number;ms:number;bytes:number;total:number|null}[]=[];
 let buffer='';
 for(;;){
  const {value,done}=await reader.read();
  if(done)break;
  buffer+=decoder.decode(value,{stream:true});
  for(let end=buffer.indexOf('\n');end!==-1;end=buffer.indexOf('\n')){
   const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
   const frame=JSON.parse(line) as {card:string;status:number;value?:{total?:number;page?:{totalPeople?:number;total?:number}}};
   if(values)values[frame.card]={status:frame.status,value:frame.value??null};
   frames.push({card:frame.card,status:frame.status,ms:Math.round(performance.now()-started),bytes:line.length+1,
    total:frame.value?.total??frame.value?.page?.totalPeople??frame.value?.page?.total??null});
  }
 }
 state.run=null;
 return {elapsedMs:Math.round(performance.now()-started),frames:frames.sort((a,b)=>a.card.localeCompare(b.card))};
}

function cardTransactions(run:string){
 const rows=transactions.filter(row=>row.run===run);
 const byOwner=new Map<string,{owner:string;count:number;maxTotalMs:number;sumTotalMs:number;maxWaitMs:number}>();
 for(const row of rows){
  const entry=byOwner.get(row.owner)??{owner:row.owner,count:0,maxTotalMs:0,sumTotalMs:0,maxWaitMs:0};
  entry.count++;entry.maxTotalMs=Math.max(entry.maxTotalMs,Math.round(row.totalMs));entry.sumTotalMs+=Math.round(row.totalMs);
  entry.maxWaitMs=Math.max(entry.maxWaitMs,Math.round(row.waitMs));byOwner.set(row.owner,entry);
 }
 return {transactions:rows.length,owners:[...byOwner.values()].sort((a,b)=>b.maxTotalMs-a.maxTotalMs).slice(0,25)};
}

async function sampleActivity<T>(work:()=>Promise<T>){
 const seen=new Map<string,{query:string;maxMs:number;samples:number;waits:string[]}>();
 let running=true;
 const sampler=(async()=>{
  while(running){
   const rows=await owner.client<{query:string;ms:number;wait:string|null}[]>`select left(regexp_replace(query,'\\s+',' ','g'),700) as query,
    (extract(epoch from clock_timestamp()-query_start)*1000)::int as ms,wait_event_type||':'||wait_event as wait
    from pg_stat_activity where datname=current_database() and usename='ai_hr_app' and state='active' and pid<>pg_backend_pid()`;
   for(const row of rows){
    const entry=seen.get(row.query)??{query:row.query,maxMs:0,samples:0,waits:[]};
    entry.maxMs=Math.max(entry.maxMs,row.ms);entry.samples++;
    if(row.wait&&!entry.waits.includes(row.wait)&&entry.waits.length<4)entry.waits.push(row.wait);
    seen.set(row.query,entry);
   }
   await new Promise(resolve=>setTimeout(resolve,15));
  }
 })();
 try{return {result:await work(),statements:()=>[...seen.values()].sort((a,b)=>b.maxMs-a.maxMs).slice(0,20)};}
 finally{running=false;await sampler;}
}

/** A new application worker: fresh modules, fresh per-process caches and fresh connections, with the
 * deployment's per-worker share of the fixed 16-connection budget (deploy/admission/next_profile.py). */
const applicationUrl=process.env.DATABASE_URL;
let workerGeneration=0;
async function coldWorker(workers:number){
 const url=new URL(applicationUrl!);url.searchParams.set('application_name','home-worker-'+workers+'-'+(++workerGeneration));
 Object.assign(process.env,{DATABASE_URL:url.href,AIHR_APP_WORKERS:String(workers),AIHR_DB_TOTAL_CONNECTIONS:'16',AIHR_DB_POOL_MAX:String(Math.floor(16/workers))});
 vi.resetModules();
 const [route,database]=await Promise.all([import('../../app/api/home/sharing-initial/route'),import('../../db/client')]);
 let trips=0;
 (database.client.options as {debug?:unknown}).debug=()=>{trips++;};
 tripCounter=()=>trips;
 return {GET:route.GET as typeof GET,trips:()=>trips,resetTrips(){trips=0;},close:()=>database.client.end({timeout:5}),
  independent:database.withIndependentTransactions as <T>(work:()=>Promise<T>)=>Promise<T>};
}
/** Compete for the four runner CPUs the way extra application workers and browser contexts do. */
function cpuPressure(count:number){
 const children=Array.from({length:count},()=>spawn(process.execPath,['-e','for(;;){}'],{stdio:'ignore'}));
 return ()=>{for(const child of children)child.kill('SIGKILL');};
}

describe.skipIf(!state.hostedFocused)('manager Home at the worker fixture size',()=>{
beforeAll(migrateTestDb,120_000);
afterAll(closeAll,120_000);
it('completes every manager Home card and Today section read without a handled failure',async()=>{
 installObservers();
 await resetDb();
 const today=todayInKualaLumpur(),month=today.slice(0,7);
 const seedStarted=performance.now();
 const tenants=await Promise.all([0,1].map(t=>seedTenant(t,today)));
 report.seedMs=Math.round(performance.now()-seedStarted);
 // The comparison builds for ~9 minutes after seeding, long enough for autovacuum to process the
 // bulk inserts. Reproduce that settled table state, then gather fresh planner statistics.
 try{await owner.client.unsafe('vacuum (analyze)');report.vacuum='vacuum-analyze';}
 catch(error){report.vacuum='analyze-only:'+String((error as Error)?.message).slice(0,120);await owner.client.unsafe('analyze');}
 const [counts]=await owner.client<{claims:number;attendance:number;lines:number}[]>`select (select count(*)::int from claim_request) as claims,
  (select count(*)::int from attendance) as attendance,(select count(*)::int from reporting_line) as lines`;
 expect(counts).toEqual({claims:500*claimsPerEmployee,attendance:500*attendanceDays,lines:2*10*10});
 const [{payslips}]=await owner.client<{payslips:number}[]>`select count(*)::int as payslips from payslip`;
 expect(payslips).toBe(500);
 report.counts=counts;
 const [settings]=await owner.client<{jit:string;version:string;shared_buffers:string;work_mem:string}[]>`select current_setting('jit') as jit,
  current_setting('server_version') as version,current_setting('shared_buffers') as shared_buffers,current_setting('work_mem') as work_mem`;
 report.settings=settings;print('settings',{...settings,counts,seedMs:report.seedMs});
 const actors=tenants[0];
 const manager=actors.find(a=>a.index===2)!,secondManager=actors.find(a=>a.index===3)!,employee=actors.find(a=>a.index===4)!;
 expect([manager.role,secondManager.role,employee.role]).toEqual(['manager','manager','employee']);

 // 1. The browser's single initial stream, sequential runs: first is cold.
 const streams:unknown[]=[];report.streams=streams;
 for(const [label,actor] of [['manager',manager],['employee',employee],['manager',manager],['secondManager',secondManager],['manager',manager],['employee',employee],['manager',manager]] as const){
  const run=label+':'+streams.length;
  const {result,statements}=await sampleActivity(()=>streamHome(actor,month,run));
  const row={run,elapsedMs:result.elapsedMs,frames:result.frames,cardTransactions:cardTransactions(run),slowStatements:statements().filter(row=>row.maxMs>=50)};
  streams.push(row);evidence();
  print('stream',{run,elapsedMs:result.elapsedMs,frames:result.frames.map(f=>[f.card,f.status,f.ms,f.total])});
  print('stream-transactions',{run,...row.cardTransactions,owners:row.cardTransactions.owners.slice(0,10)});
  print('stream-statements',{run,statements:row.slowStatements.slice(0,8)});
 }

 // 2. Each card owner alone, so pool queueing does not hide its intrinsic cost.
 const solo:Record<string,unknown>={};report.solo=solo;
 for(const [label,actor] of [['manager',manager],['employee',employee]] as const){
  const rows:Record<string,unknown>={};solo[label]=rows;
  for(const card of CARDS){
   const timesMs:number[]=[];let failure:unknown=null;
   for(let attempt=0;attempt<3;attempt++){
    const run='solo:'+label+':'+card+':'+attempt;state.run=run;const started=performance.now();
    try{await readers(actor.ctx,actor.employmentId,month)[card]();}
    catch(error){failure={name:(error as Error)?.name,code:(error as {code?:string})?.code??null,message:String((error as Error)?.message??error).slice(0,300)};}
    timesMs.push(Math.round(performance.now()-started));state.run=null;
   }
   rows[card]={timesMs,failure,transactions:cardTransactions('solo:'+label+':'+card+':2')};
  }
  print('solo',{label,cards:Object.fromEntries(Object.entries(rows).map(([card,row])=>[card,(row as {timesMs:number[];failure:unknown}).timesMs.concat((row as {failure:unknown}).failure?[-1]:[])]))});
  evidence();
 }

 // 3. Four concurrent Home streams on one eight-connection worker pool.
 const concurrent=await sampleActivity(()=>Promise.all([manager,secondManager,employee,actors.find(a=>a.index===5)!].map(actor=>streamHome(actor,month,null))));
 report.concurrent={streams:concurrent.result,statements:concurrent.statements()};
 print('concurrent',concurrent.result.map(row=>({elapsedMs:row.elapsedMs,frames:row.frames.map(f=>[f.card,f.status,f.ms])})));
 evidence();

 // 5. The server-rendered Today sections on the same page also count: their failure marker is
 // `data-today-unavailable` inside main. Measure each section and each owner they combine.
 const todayTargets=await todayReaders(today);
 const todaySolo:Record<string,unknown>={};report.todaySolo=todaySolo;
 for(const [label,actor] of [['manager',manager],['employee',employee],['secondManager',secondManager]] as const){
  const targets=await todayTargets(actor.ctx),rows:Record<string,unknown>={};todaySolo[label]=rows;
  for(const [name,read] of Object.entries(targets)){
   const timesMs:number[]=[];let result:unknown=null,failure:unknown=null;
   for(let attempt=0;attempt<3;attempt++){
    const run='today:'+label+':'+name+':'+attempt;state.run=run;const started=performance.now();
    try{result=await read();}catch(error){failure=errorFact(error);}
    timesMs.push(Math.round(performance.now()-started));state.run=null;
   }
   rows[name]={timesMs,result,failure,transactions:cardTransactions('today:'+label+':'+name+':2')};
  }
  print('today-solo',{label,sections:Object.fromEntries(Object.entries(rows).map(([name,row])=>{
   const value=row as {timesMs:number[];result:unknown;failure:unknown};return [name,{ms:value.timesMs,result:value.result,failure:value.failure}];
  }))});
  evidence();
 }
 // 5b. Exact statements each card and Today section issues, on the application client, before (every owner in
 // its own transaction) and after (one shared read-only snapshot per stream or section). Statement text only (bound
 // values never appear in it); BEGIN, SET TRANSACTION, set_config and COMMIT all count as trips.
 const statementTrace:Record<string,unknown>={};report.statementTrace=statementTrace;
 const pageSections=['needsYou','doneForYou','atAGlance','beforePayroll','page.identity','page.greetingIdentity','page.performanceBlock','page.assignedPerformance','page.layoutApprovals'];
 const traceBoth=async(before:()=>Promise<unknown>,after:()=>Promise<unknown>)=>{
  await after().catch(()=>undefined);
  const old=await traceStatements(()=>withIndependentTransactions(before));
  sharedStats.length=0;
  const fresh=await traceStatements(after);
  // Statement text identifies each remaining trip's owner: the driver sends pipelined statements from socket callbacks
  // and drizzle's thenables end the async stack, so a stack at send time names no application frame.
  return {before:old.trace.trips,after:fresh.trace.trips,beforeStatements:old.trace.statements,afterStatements:fresh.trace.statements,
   afterOrdered:fresh.trace.ordered,shared:sharedSummary(sharedStats.splice(0)),failure:fresh.failure};
 };
 for(const [label,actor] of [['manager',manager],['employee',employee]] as const){
  const targets=await todayTargets(actor.ctx),rows:Record<string,Awaited<ReturnType<typeof traceBoth>>>={};statementTrace[label]=rows;
  for(const card of CARDS){
   const read=()=>readers(actor.ctx,actor.employmentId,month)[card]();
   rows['card:'+card]=await traceBoth(read,()=>withSharedReadSnapshot(actor.ctx,read));
  }
  // The Time Off and Today owners as they read before their per-card bundles (test/helpers/home-staged-cards.ts),
  // traced the same way, so one run reports both sides of the bundle change.
  const stagedTimeOff=()=>stagedHomeTimeOff(actor.ctx,actor.employmentId,'en'),stagedToday=()=>stagedHomeToday(actor.ctx,actor.employmentId);
  rows['card:timeOff:staged']=await traceBoth(stagedTimeOff,()=>withSharedReadSnapshot(actor.ctx,stagedTimeOff));
  rows['card:today:staged']=await traceBoth(stagedToday,()=>withSharedReadSnapshot(actor.ctx,stagedToday));
  for(const [name,read] of Object.entries(targets))rows['section:'+name]=await traceBoth(read,read);
  const stream=()=>streamHome(actor,month,null);
  rows.stream=await traceBoth(stream,stream);
  const page=()=>Promise.all([streamHome(actor,month,null),...pageSections.map(name=>targets[name]())]);
  const pageRendered=()=>Promise.all([streamHome(actor,month,null),todayTargets.pageRender(()=>Promise.all(pageSections.map(name=>targets[name]())))]);
  rows.page=await traceBoth(page,pageRendered);
  // The page's sections alone: each in its own snapshot before, one render's request scope after.
  rows.sections=await traceBoth(()=>Promise.all(pageSections.map(name=>targets[name]())),()=>todayTargets.pageRender(()=>Promise.all(pageSections.map(name=>targets[name]()))));
  print('bundle-trips',{label,timeOff:{staged:rows['card:timeOff:staged'].after,bundled:rows['card:timeOff'].after},
   today:{staged:rows['card:today:staged'].after,bundled:rows['card:today'].after},stream:rows.stream.after,page:rows.page.after,
   timeOffStatements:rows['card:timeOff'].afterOrdered,todayStatements:rows['card:today'].afterOrdered});
  await calendarWindowTraces(label,actor,month,rows,traceBoth);
  // The same shared snapshots with every task owner reading on its own (before) and through the one account task
  // statement (after, core/account-task-bundle.ts): the Tasks and Summary cards, the stream and the whole page.
  const {withOwnerTaskReads}=await import('../../core/account-task-bundle');
  const traceOwnerReads=async(work:()=>Promise<unknown>)=>{
   await work().catch(()=>undefined);
   sharedStats.length=0;const old=await traceStatements(()=>withOwnerTaskReads(work));sharedStats.length=0;
   const fresh=await traceStatements(work);
   return {before:old.trace.trips,after:fresh.trace.trips,beforeStatements:old.trace.statements,afterStatements:fresh.trace.statements,
    afterOrdered:fresh.trace.ordered,shared:sharedSummary(sharedStats.splice(0)),failure:fresh.failure??old.failure};
  };
  for(const card of ['tasks','summary'] as const){
   const read=()=>readers(actor.ctx,actor.employmentId,month)[card]();
   rows['ownerReads:card:'+card]=await traceOwnerReads(()=>withSharedReadSnapshot(actor.ctx,read));
  }
  rows['ownerReads:stream']=await traceOwnerReads(stream);
  rows['ownerReads:page']=await traceOwnerReads(pageRendered);
  Object.assign(rows,await beforePayrollTraces(label,actor,today,traceBoth));
  Object.assign(rows,await preambleTraces(label,actor,month,todayTargets,pageSections));
  Object.assign(rows,await cardsSectionsTraces(label,actor,month,targets,pageRendered));
  print('statement-trace',{label,trips:Object.fromEntries(Object.entries(rows).map(([name,row])=>[name,[row.before,row.after]])),
   shared:Object.fromEntries(Object.entries(rows).filter(([,row])=>row.shared.sessions>0).map(([name,row])=>[name,row.shared])),
   failures:Object.fromEntries(Object.entries(rows).filter(([,row])=>row.failure).map(([name,row])=>[name,row.failure]))});
  evidence();
 }
 // 5c. Equivalence: every card, Today section and stream frame returns the same result through the shared snapshot
 // as through independent transactions, for each role and both tenants. Another identity's read inside a session
 // never joins it and returns that identity's own independent result, including under concurrency.
 const equivalence:{subject:string;target:string;equal:boolean;old?:string;fresh?:string}[]=[];report.equivalence=equivalence;
 const others=tenants[1];
 const subjects=[['manager',manager],['employee',employee],['secondManager',secondManager],['groupHR',actors.find(a=>a.role==='groupHR')!],
  ['companyHR',actors.find(a=>a.role==='companyHR'&&a.company===1)!],['otherTenantManager',others.find(a=>a.role==='manager')!],
  ['otherTenantEmployee',others.find(a=>a.role==='employee'&&a.company===2)!],['terminated',actors.find(a=>a.index===49)!],
  ['crossCompanyManager',actors.find(a=>a.index===6)!],['companyOneOnLeave',actors.find(a=>a.index===54)!]] as const;
 const compare=(subject:string,target:string,old:unknown,fresh:unknown)=>{
  const [a,b]=[comparable(old),comparable(fresh)];
  equivalence.push(a===b?{subject,target,equal:true}:{subject,target,equal:false,old:a.slice(0,1500),fresh:b.slice(0,1500)});
 };
 // Give one subject decided history and drafts beside its pending claims, so the open-claims read has rows to leave out.
 {
  const subject=subjects.find(([name])=>name==='otherTenantEmployee')![1];
  const [type]=await owner.client<{id:string}[]>`select id from claim_type where tenant_id=${subject.ctx.tenantId}::uuid and code='PERF'`;
  await owner.client`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
   select ${subject.ctx.tenantId}::uuid,${subject.employmentId}::uuid,${type.id}::uuid,1,${today}::date-n::integer,s,now()-n::integer*interval '1 second'
   from unnest(array['draft','draft','approved','approved','rejected','rejected']::claim_status[]) with ordinality as statuses(s,n)`;
 }
 // Pending Leave with an approval chain of every step kind the account task statement decides, a decided step before
 // the current one, a chain with no pending step and an alternate it leaves to the owner (core/leave.ts
 // leaveApproverDecisionSql), on subjects of both managers. Added after the traces, so their counts stay comparable.
 {
  const tenantId=manager.ctx.tenantId,on=new Date(Date.parse(today+'T00:00:00Z')+10*86400000).toISOString().slice(0,10);
  const [{leaveTypeId}]=await owner.client<{leaveTypeId:string}[]>`select leave_type_id as "leaveTypeId" from leave_request where tenant_id=${tenantId}::uuid limit 1`;
  const chains:[number,{kind:string;approver?:string;status?:'approved';alternates?:unknown}[]][]=[
   [5,[{kind:'direct_manager'}]],[7,[{kind:'hr_admin'}]],[8,[{kind:'payroll'}]],[9,[{kind:'specific_employee',approver:secondManager.employmentId}]],
   [10,[{kind:'manager_manager'}]],[11,[{kind:'department_head'}]],[12,[{kind:'business_unit_head'}]],
   [13,[{kind:'direct_manager',status:'approved'},{kind:'custom_role'}]],[14,[{kind:'direct_manager',status:'approved'}]],
   [15,[{kind:'direct_manager',alternates:['hr_admin']}]],[16,[{kind:'specific_employee',approver:manager.employmentId}]],
  ];
  for(const [position,steps] of chains){
   const subject=actors.find(a=>a.index===position)!;
   const [request]=await owner.db.insert(s.leaveRequest).values({tenantId,employmentId:subject.employmentId,leaveTypeId,startDate:on,endDate:on,days:'1',status:'pending'}).returning();
   await owner.db.insert(s.leaveApprovalStep).values(steps.map((step,stepIndex)=>({tenantId,leaveRequestId:request.id,subjectEmploymentId:subject.employmentId,
    stepIndex,approverKind:step.kind,approverEmploymentId:step.approver??null,approverAlternates:step.alternates??null,status:step.status??'pending' as const})));
  }
 }
 await calendarWindowFixtures(actors,today);
 const preambleSubjects=await preambleFixtures(actors);let preambleAnswered=0;
 await calendarWindowEntitlementTrips([['manager',manager],['employee',employee],['companyHR',actors.find(a=>a.role==='companyHR'&&a.company===1)!]],month);
 // Before payroll's owners get rows of their own, after the traces (decision 11).
 report.beforePayrollFixtures=await seedBeforePayrollFixtures([...tenants[0],...tenants[1]],today);
 report.cardsSectionsFixtures=await cardsSectionsFixtures(actors,others,today);
 print('cards-sections-fixtures',report.cardsSectionsFixtures);
 const cardsSectionsAnswers:unknown[]=[];report.cardsSections=cardsSectionsAnswers;
 print('before-payroll-fixtures',report.beforePayrollFixtures);
 const beforePayrollOwners=await seedBeforePayrollOwnerFixtures(tenants[0],today);
 report.beforePayrollOwnerFixtures={seeded:beforePayrollOwners.seeded,refused:beforePayrollOwners.refused,joiner:beforePayrollOwners.joiner!==null};
 print('before-payroll-owner-fixtures',report.beforePayrollOwnerFixtures);
 const beforePayrollSections:unknown[]=[];report.beforePayrollSections=beforePayrollSections;
 // Deferred task owners (core/account-task-bundle.ts, ADR decision 10): their candidates, then the Tasks and Summary
 // cards and the stream with every task owner reading alone (before) and through the account task statement (after).
 {
  const failures=await seedTaskOwnerFixtures(tenants,today);report.taskOwnerFixtureFailures=failures;print('task-owner-fixtures',{failures});
  const {withOwnerTaskReads}=await import('../../core/account-task-bundle'),trips:Record<string,[number,number]>={};
  for(const [label,actor] of [['manager',manager],['secondManager',secondManager],['groupHR',actors.find(a=>a.role==='groupHR')!],
   ['crossCompanyManager',actors.find(a=>a.index===6)!],['employee',employee]] as const){
   const reads:Record<string,()=>Promise<unknown>>={
    tasks:()=>withSharedReadSnapshot(actor.ctx,()=>readers(actor.ctx,actor.employmentId,month).tasks()),
    summary:()=>withSharedReadSnapshot(actor.ctx,()=>readers(actor.ctx,actor.employmentId,month).summary()),
    stream:()=>streamHome(actor,month,null),
   };
   for(const [name,read] of Object.entries(reads)){
    await read().catch(()=>undefined);
    const old=await traceStatements(()=>withOwnerTaskReads(read)),fresh=await traceStatements(read);
    trips[label+':'+name]=[old.trace.trips,fresh.trace.trips];
   }
  }
  report.taskOwnerTrips=trips;print('task-owner-trips',trips);evidence();
  // Every leave and cancellation candidate the statement leaves to its owner, for the non-admin subjects: only the
  // documented fallback fixtures (position 54's disagreeing lines and brace-spelled alternate id) may appear.
  {
   const bundles=await import('../../core/account-task-bundle'),leaveService=await import('../../packs/leave/service'),decisions:Record<string,unknown>={};
   for(const [label,actor] of [['manager',manager],['secondManager',secondManager],['crossCompanyManager',actors.find(a=>a.index===6)!],['companyOneOnLeave',actors.find(a=>a.index===54)!]] as const){
    decisions[label]=await withTenant(actor.ctx,async tx=>[...await tx.execute(sql`with ${bundles.accountTaskCallerSql(actor.ctx)}
      select decision_candidate.section,decision_candidate.approver_kind as kind,(select users.index from (values ${sql.join(actors.map(a=>sql`(${a.employmentId}::uuid,${a.index}::int)`),sql`,`)}) users(id,index)
       where users.id=decision_candidate.employment_id) as subject,decided.decision
      ${leaveService.pendingLeaveDecisionCandidatesSql(tx,actor.ctx,undefined,sql`cast((select task_caller.own_ids from task_caller) as uuid[])`)}
      where decided.decision in ('defer','error') order by 1,3,2`)],{readOnlySnapshot:true}).catch(error=>errorFact(error));
   }
   print('task-owner-leave-decisions',decisions);
  }
  const {isModuleEnabled}=await import('../../core/entitlements'),explains:Record<string,unknown>={};
  for(const [label,actor] of [['manager',manager],['employee',employee],['groupHR',actors.find(a=>a.role==='groupHR')!]] as const){
   const flags={attendance:isModuleEnabled(actor.ctx,'attendance'),claims:isModuleEnabled(actor.ctx,'claims'),performance:isModuleEnabled(actor.ctx,'performance'),
    rewards:isModuleEnabled(actor.ctx,'rewards'),lifecycle:isModuleEnabled(actor.ctx,'lifecycle')};
   for(const [variant,modules] of [['modules',flags],['core',{attendance:false,claims:false,performance:false,rewards:false,lifecycle:false}]] as const){
    const runs=[];for(let attempt=0;attempt<1;attempt++)runs.push(await explainTaskStatement(actor.ctx,modules).catch(error=>errorFact(error)));
    explains[label+':'+variant]=runs;
   }
  }
  report.taskStatementExplain=explains;print('task-statement-explain',explains);evidence();
 }
 const bundleSections:unknown[]=[];report.bundleSections=bundleSections;
 const failurePrecedence:unknown[]=[];report.taskFailurePrecedence=failurePrecedence;
 const {listClaimsForEmployment,listOpenClaimsForEmployment}=await import('../../packs/claims/service');
 for(const [subject,actor] of subjects){
  const targets=await todayTargets(actor.ctx);
  compare(subject,'claims:open',await outcome(async()=>(await listClaimsForEmployment(actor.ctx,actor.employmentId)).filter(row=>row.status==='pending'||row.status==='draft')),
   await outcome(()=>listOpenClaimsForEmployment(actor.ctx,actor.employmentId)));
  for(const card of CARDS){
   const read=()=>readers(actor.ctx,actor.employmentId,month)[card]();
   compare(subject,'card:'+card,await outcome(()=>withIndependentTransactions(read)),await outcome(()=>withSharedReadSnapshot(actor.ctx,read)));
  }
  for(const [name,read] of Object.entries(targets))compare(subject,'section:'+name,await outcome(()=>withIndependentTransactions(read)),await outcome(read));
  // The complete section values, not only their summaries above.
  const sectionReads=await import('../../components/today/reads'),{todayAudience}=await import('../../lib/today/audience');
  const {readMyPayrollReadiness}=await import('../../core/pre-salary/person-items'),{allowedCompanies}=await import('../../core/read');
  const scopeIds=(await allowedCompanies(actor.ctx)).map(company=>company.id);
  const full:Record<string,()=>Promise<unknown>>={
   needsYou:()=>sectionReads.readNeedsYou(actor.ctx,{scopeIds,audience:todayAudience(actor.ctx),today,locale:'en',now:Date.parse(today+'T12:00:00+08:00')}),
   doneForYou:()=>sectionReads.readDoneForYou(actor.ctx,{scopeIds,today}),
   atAGlance:()=>sectionReads.readAtAGlance(actor.ctx,{locale:'en',today}),
   watching:()=>sectionReads.readWatching(actor.ctx,{scopeIds,today}),
   beforePayroll:()=>readMyPayrollReadiness(actor.ctx,{scopeIds,locale:'en',today,includeApprovals:false}),
   beforePayrollWithApprovals:()=>readMyPayrollReadiness(actor.ctx,{scopeIds,locale:'en',today,approvalPreview:true}),
   // The remaining page owners, as the page composes them, with their complete values.
   ...await fullPageOwners(actor.ctx,scopeIds),
  };
  for(const [name,read] of Object.entries(full))compare(subject,'full:'+name,await outcome(()=>withIndependentTransactions(read)),await outcome(read));
  // One page render: every section and page owner at once inside one request scope, against each alone.
  const independentValues=Object.fromEntries(await Promise.all(Object.entries(full).map(async([name,read])=>[name,await outcome(()=>withIndependentTransactions(read))] as const)));
  const pageValues=await todayTargets.pageRender(async()=>Object.fromEntries(await Promise.all(Object.entries(full).map(async([name,read])=>[name,await outcome(read)] as const))));
  for(const name of Object.keys(full))compare(subject,'pageRender:'+name,independentValues[name],pageValues[name]);
  // One request's own payroll read (Summary, Today, Calendar) against each card's own payroll reader.
  const {OwnHomePayrollRead,readOwnPayrollHomeMetadata}=await import('../../packs/payroll/service');
  const payrollCards=(shared?:InstanceType<typeof OwnHomePayrollRead>)=>Promise.all([
   readEmployeeHomeToday(actor.ctx,actor.employmentId,undefined,shared),
   readEmployeeHomeCalendar(actor.ctx,actor.employmentId,month,undefined,undefined,shared),
   readEmployeeHomeSummary(actor.ctx,actor.employmentId,'en','replacement',undefined,undefined,shared)]);
  compare(subject,'payrollRead',await outcome(()=>payrollCards()),await outcome(()=>payrollCards(new OwnHomePayrollRead(actor.ctx,actor.employmentId))));
  // A carrier bound to another login or employment never answers for this one: it reruns this card's own reader.
  const foreignCarrier=new OwnHomePayrollRead(manager.ctx,manager.employmentId);
  compare(subject,'payrollRead:foreignCarrier',await outcome(()=>readOwnPayrollHomeMetadata(actor.ctx,actor.employmentId)),
   await outcome(()=>foreignCarrier.homeMetadata(actor.ctx,actor.employmentId)));
  // The per-card bundles: each shipped card against its staged owners, and each calculator inside one snapshot.
  compare(subject,'bundle:timeOff',await outcome(()=>stagedHomeTimeOff(actor.ctx,actor.employmentId,'en')),await outcome(()=>readEmployeeHomeTimeOff(actor.ctx,actor.employmentId,'en')));
  compare(subject,'bundle:today',await outcome(()=>stagedHomeToday(actor.ctx,actor.employmentId)),await outcome(()=>readEmployeeHomeToday(actor.ctx,actor.employmentId)));
  for(const [name,[live,bundled]] of Object.entries(await bundleCalculatorPairs(actor,today)))compare(subject,'bundle:'+name,live,bundled);
  await calendarWindowEquivalence(subject,actor,month,compare);
  const oldFrames:Record<string,unknown>={},newFrames:Record<string,unknown>={};
  await withIndependentTransactions(()=>streamHome(actor,month,null,GET,oldFrames));
  await streamHome(actor,month,null,GET,newFrames);
  const byCard=(frames:Record<string,unknown>)=>Object.fromEntries(Object.entries(frames).sort(([a],[b])=>a.localeCompare(b)));
  compare(subject,'stream',byCard(oldFrames),byCard(newFrames));
  // The account task statement (core/account-task-bundle.ts) against every owner it answers, section by section, then
  // the results it composes: the account preview and exact count, the Tasks card and the whole stream (Summary count
  // included), every owner reading on its own against the statement.
  {
   const bundles=await import('../../core/account-task-bundle'),inbox=await import('../../core/approvals-inbox');
   const {isModuleEnabled}=await import('../../core/entitlements');
   const leaveService=await import('../../packs/leave/service'),claimsService=await import('../../packs/claims/service');
   const attendanceService=await import('../../packs/attendance/service'),performanceService=await import('../../packs/performance/service');
   const rewardsService=await import('../../packs/rewards/service'),lifecycleService=await import('../../packs/lifecycle/service');
   const {pendingProfileTaskMetadata,pendingProfileTasksFromCandidates}=await import('../../core/profile'),{pendingNoticeAcknowledgementTasks}=await import('../../core/notice');
   const {pendingResignationTaskMetadata}=await import('../../core/offboarding'),{pendingReviewTaskMetadata}=await import('../../core/employment-review');
   const ctx=actor.ctx,inboxModules={attendance:isModuleEnabled(ctx,'attendance'),claims:isModuleEnabled(ctx,'claims'),performance:isModuleEnabled(ctx,'performance'),rewards:isModuleEnabled(ctx,'rewards')};
   const modules={...inboxModules,lifecycle:isModuleEnabled(ctx,'lifecycle')};
   const bundle=await withSharedReadSnapshot(ctx,()=>bundles.readAccountTaskBundle(ctx,modules));
   // The statement answers exactly when the owners' own assigned-work principal proof holds (a login that is no
   // longer this person's, such as an ended employment's, leaves every owner to refuse on its own).
   const [proof]=await withTenant(ctx,tx=>tx.execute<{ok:boolean}>(sql`SELECT (app.principal_snapshot_current()
    AND (${ctx.personId??null}::uuid IS NULL OR app.is_self_person(${ctx.personId??null}::uuid))) AS ok`));
   compare(subject,'bundle:answered',proof?.ok===true,bundle!==null);
   const owners:Record<string,()=>Promise<unknown>>={
    leave:()=>leaveService.pendingLeaveTaskMetadata(ctx),
    cancellations:()=>leaveService.pendingLeaveCancellationTaskMetadata(ctx),
    resignations:()=>pendingResignationTaskMetadata(ctx),
    managerReviews:()=>pendingReviewTaskMetadata(ctx,'manager'),
    hrReviews:()=>pendingReviewTaskMetadata(ctx,'hr'),
    replacement:()=>leaveService.listPendingReplacementLeaveTasks(ctx,{}),
    attendance:async()=>modules.attendance?attendanceService.pendingAttendanceTaskMetadata(ctx):[],
    profile:()=>pendingProfileTaskMetadata(ctx),
    notices:()=>pendingNoticeAcknowledgementTasks(ctx),
    performance:async()=>modules.performance?performanceService.pendingPerformanceTasks(ctx,undefined):[],
    rewards:async()=>modules.rewards?rewardsService.pendingRewardTasks(ctx,undefined):[],
    claims:async()=>modules.claims?claimsService.pendingClaimTaskSummary(ctx,undefined,bundles.ACCOUNT_TASK_CLAIM_PREVIEW):{items:[],total:0},
    standardFeedback:async()=>modules.performance?performanceService.pendingStandardFeedbackTaskMetadata(ctx):[],
    onehrFeedback:async()=>modules.performance?performanceService.pendingOnehrFeedbackTaskMetadata(ctx):[],
    onboarding:async()=>modules.lifecycle?lifecycleService.onboardingAssignedTaskMetadata(ctx):[],
   };
   const deferred:string[]=[],answered:Record<string,number>={};
   // Each owner alone, independently: its result, and the failure it raises for this subject (if any).
   const ownerOutcomes:Record<string,Awaited<ReturnType<typeof outcome>>>={};
   for(const [name,read] of Object.entries(owners))ownerOutcomes[name]=await outcome(()=>withIndependentTransactions(read));
   const failureKey=(failure:unknown)=>JSON.stringify((failure as {error?:unknown})?.error??null);
   const ownerFailures=new Set(Object.values(ownerOutcomes).filter(row=>!row.ok).map(failureKey));
   for(const name of Object.keys(owners)){
    const value=(bundle as Record<string,unknown>|null)?.[name];
    if(value===null||value===undefined){deferred.push(name);continue;}
    answered[name]=Array.isArray(value)?value.length:(value as {total?:number}).total??-1;
    compare(subject,'bundle:'+name,ownerOutcomes[name],{ok:true,value});
   }
   // The same sections under this subject's company filter (the scoped previews' statement), against each owner so filtered.
   const scopedRead={companyIds:scopeIds,personal:false,notices:true},scopedModules={...modules,lifecycle:false};
   const scopedBundle=await withSharedReadSnapshot(ctx,()=>bundles.readAccountTaskBundle(ctx,scopedModules,scopedRead));
   const scopedOwners:Record<string,()=>Promise<unknown>>={
    leave:()=>leaveService.pendingLeaveTaskMetadata(ctx,scopeIds),cancellations:()=>leaveService.pendingLeaveCancellationTaskMetadata(ctx,scopeIds),
    resignations:()=>pendingResignationTaskMetadata(ctx,scopeIds),managerReviews:()=>pendingReviewTaskMetadata(ctx,'manager',scopeIds),
    hrReviews:()=>pendingReviewTaskMetadata(ctx,'hr',scopeIds),attendance:async()=>modules.attendance?attendanceService.pendingAttendanceTaskMetadata(ctx,scopeIds):[],
    profile:()=>pendingProfileTaskMetadata(ctx,scopeIds),
    performance:async()=>modules.performance?performanceService.pendingPerformanceTasks(ctx,scopeIds):[],
    rewards:async()=>modules.rewards?rewardsService.pendingRewardTasks(ctx,scopeIds):[],
   };
   const scopedDeferred:string[]=[];
   for(const [name,read] of Object.entries(scopedOwners)){
    const value=(scopedBundle as Record<string,unknown>|null)?.[name];
    if(value===null||value===undefined){scopedDeferred.push(name);continue;}
    compare(subject,'bundle:scoped:'+name,await outcome(()=>withIndependentTransactions(read)),{ok:true,value});
   }
   // Profile candidates read by the statement, through the owner's own locked decision transaction.
   for(const [name,read,candidates] of [['profileCandidates',()=>pendingProfileTaskMetadata(ctx),bundle?.profileCandidates],
    ['scoped:profileCandidates',()=>pendingProfileTaskMetadata(ctx,scopeIds),scopedBundle?.profileCandidates]] as const){
    if(!candidates?.length)continue;
    answered[name]=candidates.length;
    compare(subject,'bundle:'+name,await outcome(()=>withIndependentTransactions(read)),await outcome(()=>withIndependentTransactions(()=>pendingProfileTasksFromCandidates(ctx,candidates))));
   }
   bundleSections.push({subject,deferred,answered,scopedDeferred});
   const ownersOnly=<T,>(work:()=>Promise<T>)=>withIndependentTransactions(()=>bundles.withOwnerTaskReads(work));
   const withBundle=<T,>(work:(read:ReturnType<typeof bundles.readAccountTaskBundle>)=>Promise<T>)=>
    withSharedReadSnapshot(ctx,()=>work(bundles.readAccountTaskBundle(ctx,modules)));
   compare(subject,'bundle:accountPreview',await outcome(()=>ownersOnly(()=>inbox.pendingTaskSummary(ctx,undefined,inboxModules))),
    await outcome(()=>withBundle(read=>inbox.createAccountTaskPreviewRead(ctx,inboxModules,read).summary())));
   compare(subject,'bundle:accountCount',await outcome(()=>ownersOnly(()=>inbox.countPendingTasks(ctx,undefined,inboxModules))),
    await outcome(()=>withBundle(read=>inbox.createAccountTaskPreviewRead(ctx,inboxModules,read).count())));
   const card=()=>readEmployeeHomeTasks(ctx,actor.employmentId,1,new OwnHomeConfigurationRead(ctx,actor.employmentId,new AbortController().signal));
   compare(subject,'bundle:card:tasks',await outcome(()=>ownersOnly(card)),await outcome(()=>withSharedReadSnapshot(ctx,card)));
   const summary=()=>readEmployeeHomeSummary(ctx,actor.employmentId,'en','replacement',new OwnHomeConfigurationRead(ctx,actor.employmentId,new AbortController().signal));
   compare(subject,'bundle:card:summary',await outcome(()=>ownersOnly(summary)),await outcome(()=>withSharedReadSnapshot(ctx,summary)));
   const {countEmployeeHomeTasks}=await import('../../core/employee-home-tasks');
   compare(subject,'bundle:homeCount',await outcome(()=>ownersOnly(()=>countEmployeeHomeTasks(ctx))),await outcome(()=>withSharedReadSnapshot(ctx,()=>countEmployeeHomeTasks(ctx))));
   // Which failure a composed read surfaces when several of its owners refuse: lib/settle-read-group.ts keeps the FIRST
   // OBSERVED failure (by time, not array order). Each read repeated: owners alone in independent transactions (the
   // comparisons' reference), owners alone in one shared snapshot (the bundled read's scope) and through the statement.
   if(ownerFailures.size>1){
    const runs=async(read:()=>Promise<unknown>)=>{const seen=new Map<string,number>();
     for(let attempt=0;attempt<6;attempt++){const key=failureKey(await outcome(read));seen.set(key,(seen.get(key)??0)+1);}return Object.fromEntries(seen);};
    failurePrecedence.push({subject,ownerFailures:[...ownerFailures],
     ownersIndependent:await runs(()=>ownersOnly(()=>countEmployeeHomeTasks(ctx))),
     ownersShared:await runs(()=>withSharedReadSnapshot(ctx,()=>bundles.withOwnerTaskReads(()=>countEmployeeHomeTasks(ctx)))),
     bundledShared:await runs(()=>withSharedReadSnapshot(ctx,()=>countEmployeeHomeTasks(ctx)))});
   }
   const ownerFrames:Record<string,unknown>={},bundleFrames:Record<string,unknown>={};
   await ownersOnly(()=>streamHome(actor,month,null,GET,ownerFrames));
   await streamHome(actor,month,null,GET,bundleFrames);
   compare(subject,'bundle:stream',byCard(ownerFrames),byCard(bundleFrames));
   // The company-scoped previews through the same statement: Needs you, the shell badge (count-only Claims), Before
   // payroll's approvals (no Notices, no packs) and an empty company selection.
   const approvalsOnly={...inboxModules,performance:false,rewards:false};
   for(const [name,ids,listModules,options] of [['scoped',scopeIds,inboxModules,{}],['scopedBadge',scopeIds,inboxModules,{deferClaimPreview:true}],
    ['scopedApprovals',scopeIds,approvalsOnly,{noticeAcknowledgements:false}],['scopedEmpty',[],inboxModules,{}]] as const){
    const read=()=>inbox.pendingTaskSummary(ctx,[...ids],listModules,options);
    compare(subject,'bundle:'+name,await outcome(()=>ownersOnly(read)),await outcome(()=>withSharedReadSnapshot(ctx,read)));
   }
  }
  // Before payroll's narrowed reads against the owners they replace: TP1 and TP3 without the payroll-history barrier
  // (one read-only snapshot each), and each claim type's receipt rule without its limits and balances.
  {
   const payrollService=await import('../../packs/payroll/service'),claimsService=await import('../../packs/claims/service');
   const ctx=actor.ctx,year=Number(today.slice(0,4));
   compare(subject,'beforePayroll:tp1',await outcome(()=>withIndependentTransactions(()=>payrollService.listMyTp1Declarations(ctx,{assessmentYear:year}))),
    await outcome(()=>withSharedReadSnapshot(ctx,()=>payrollService.listMyTp1DeclarationsSnapshot(ctx,{assessmentYear:year}))));
   compare(subject,'beforePayroll:tp3Employments',await outcome(()=>withIndependentTransactions(()=>payrollService.myTp3Employments(ctx))),
    await outcome(()=>withSharedReadSnapshot(ctx,()=>payrollService.myTp3EmploymentsSnapshot(ctx))));
   compare(subject,'beforePayroll:tp3History',await outcome(()=>withIndependentTransactions(()=>payrollService.myTp3History(ctx))),
    await outcome(()=>withSharedReadSnapshot(ctx,()=>payrollService.myTp3HistorySnapshot(ctx))));
   compare(subject,'beforePayroll:claimRules',await outcome(async()=>(await withIndependentTransactions(()=>claimsService.getEmployeeClaimTypes(ctx,actor.employmentId)))
     .map(type=>({id:type.id,requiresReceipt:type.requiresReceipt,maxReceiptAgeDays:type.maxReceiptAgeDays}))),
    await outcome(()=>withSharedReadSnapshot(ctx,()=>claimsService.claimTypeReceiptRules(ctx))));
  }
  beforePayrollSections.push(await beforePayrollEquivalence(subject,actor,today,compare));
  preambleAnswered+=await preambleEquivalence(subject,actor,month,compare,todayTargets);
  cardsSectionsAnswers.push(await cardsSectionsEquivalence(subject,actor,today,month,todayTargets.pageRender,compare));
 }
 // The request preamble for two own employments (each requested by the stream; a page render has no sole employment), a
 // login whose principal proof fails (a claimed grant it does not hold) and a login carrying another person's id.
 {
  const twice=preambleSubjects.twoEmployments,extra:[string,Actor,string][]=[['twoEmployments:first',twice,twice.employmentId]];
  if(preambleSubjects.second)extra.push(['twoEmployments:second',twice,preambleSubjects.second]);
  const refused={...employee,ctx:{...employee.ctx,roles:[...(employee.ctx.roles??[]),'hr_admin'],grants:[...(employee.ctx.grants??[]),{role:'hr_admin',companyId:null}]}};
  const substituted={...employee,ctx:{...employee.ctx,personId:manager.ctx.personId}};
  extra.push(['principalRefused',refused,refused.employmentId],['personSubstituted',substituted,substituted.employmentId]);
  for(const [subject,actor,employmentId] of extra)preambleAnswered+=await preambleEquivalence(subject,actor,month,compare,todayTargets,employmentId);
 }
 // Isolation: a foreign identity inside a session, and two identities' sessions at once across tenants.
 const isolation:Record<string,unknown>={};report.isolation=isolation;
 for(const [host,guest] of [[manager,employee],[manager,others.find(a=>a.role==='employee')!]] as const){
  const read=(actor:Actor,card:Card)=>readers(actor.ctx,actor.employmentId,month)[card]();
  sharedStats.length=0;
  const inside=await withSharedReadSnapshot(host.ctx,async()=>{const out:Record<string,unknown>={};for(const card of CARDS)out[card]=await outcome(()=>read(guest,card));return out;});
  const hostStats=sharedSummary(sharedStats.splice(0));
  const [hostShared,guestShared]=await Promise.all([host,guest].map(actor=>withSharedReadSnapshot(actor.ctx,async()=>{
   const out:Record<string,unknown>={};await Promise.all(CARDS.map(async card=>{out[card]=await outcome(()=>read(actor,card));}));return out;})));
  for(const card of CARDS){
   const guestOld=await outcome(()=>withIndependentTransactions(()=>read(guest,card)));
   compare('guest:'+guest.index,'insideHostSession:'+card,guestOld,(inside as Record<string,unknown>)[card]);
   compare('guest:'+guest.index,'concurrentSessions:'+card,guestOld,(guestShared as Record<string,unknown>)[card]);
   compare('host:'+host.index,'concurrentSessions:'+card,await outcome(()=>withIndependentTransactions(()=>read(host,card))),(hostShared as Record<string,unknown>)[card]);
  }
  isolation[host.index+'>'+guest.index]={hostSessionJoins:hostStats.joins,hostSessionStatements:hostStats.sharedStatements};
 }
 // Two identities rendered in one request scope (never expected in production, where a render has one session) keep
 // separate sessions, each with its own owners' results.
 {
  const [host,guest]=[manager,others.find(a=>a.role==='employee')!];
  const scope={},requestScope=await import('../../lib/request-read-scope'),database=await import('../../db/client');
  const reads=async(actor:Actor)=>{const scopeIds=(await (await import('../../core/read')).allowedCompanies(actor.ctx)).map(company=>company.id);return fullPageOwners(actor.ctx,scopeIds);};
  const [hostReads,guestReads]=await Promise.all([reads(host),reads(guest)]);
  const together=await requestScope.withRequestReadScope(scope,()=>Promise.all([host,guest].map(async(actor,index)=>Object.fromEntries(await Promise.all(Object.entries(index?guestReads:hostReads).map(async([name,read])=>[name,await outcome(read)] as const))))));
  const sessions=await database.requestScopedReadStats(scope);
  for(const [index,actor] of [host,guest].entries())for(const [name,read] of Object.entries(index?guestReads:hostReads))
   compare((index?'guest:':'host:')+actor.index,'sharedRequestScope:'+name,await outcome(()=>withIndependentTransactions(read)),together[index][name]);
  report.requestScopeIsolation={sessions:sessions.length,joins:sessions.map(row=>row.joins)};
  expect(sessions).toHaveLength(2);
 }
 // The onboarding joiner is a subject of its own: the only login with a case waiting for its acknowledgement.
 if(beforePayrollOwners.joiner)beforePayrollSections.push(await beforePayrollEquivalence('onboardingJoiner',beforePayrollOwners.joiner,today,compare));
 const preambleIsolationRows:Record<string,unknown>={};report.preambleIsolation=preambleIsolationRows;
 for(const [host,guest] of [[manager,employee],[manager,others.find(a=>a.role==='employee')!]] as const)
  preambleIsolationRows[host.index+'>'+guest.index]=await preambleIsolation(host,guest,month,compare);
 print('preamble-equivalence',{answered:preambleAnswered,second:preambleSubjects.second!==null,isolation:preambleIsolationRows});
 const mismatches=equivalence.filter(row=>!row.equal);
 print('bundle-sections',bundleSections);
 print('before-payroll-sections',beforePayrollSections);
 print('task-failure-precedence',failurePrecedence);
 print('cards-sections',cardsSectionsAnswers);
 print('equivalence',{compared:equivalence.length,mismatches:mismatches.length,isolation,first:mismatches.slice(0,6)});
 evidence();
 // The browser renders Today sections and starts the card stream on the same worker pool.
 const pageRuns:unknown[]=[];report.pageRuns=pageRuns;
 for(const [label,actor] of [['manager',manager],['employee',employee],['manager',manager]] as const){
  const targets=await todayTargets(actor.ctx),started=performance.now(),sectionMs:Record<string,unknown>={};
  const {result,statements}=await sampleActivity(()=>Promise.all([
   ...['needsYou','doneForYou','atAGlance','beforePayroll','page.identity','page.performanceBlock','page.assignedPerformance','page.assistant'].map(name=>
    targets[name]().then(value=>{sectionMs[name]={ms:Math.round(performance.now()-started),value};},error=>{sectionMs[name]={ms:Math.round(performance.now()-started),failure:errorFact(error)};})),
   streamHome(actor,month,null),
  ]));
  const stream=result.at(-1) as Awaited<ReturnType<typeof streamHome>>;
  const row={label,elapsedMs:Math.round(performance.now()-started),sections:sectionMs,frames:stream.frames.map(f=>[f.card,f.status,f.ms]),statements:statements().filter(s=>s.maxMs>=50).slice(0,10)};
  pageRuns.push(row);print('page',row);evidence();
 }
 // Three Home pages at once, as the baseline sweep's employee, manager and other-tenant employee lanes do.
 const triple=await sampleActivity(()=>Promise.all([manager,employee,secondManager].map(async actor=>{
  const targets=await todayTargets(actor.ctx),started=performance.now(),sectionMs:Record<string,unknown>={};
  const [stream]=await Promise.all([streamHome(actor,month,null),...['needsYou','doneForYou','atAGlance','beforePayroll'].map(name=>targets[name]().then(
   value=>{sectionMs[name]={ms:Math.round(performance.now()-started),value};},error=>{sectionMs[name]={ms:Math.round(performance.now()-started),failure:errorFact(error)};}))]);
  return {role:actor.role,index:actor.index,elapsedMs:Math.round(performance.now()-started),sections:sectionMs,frames:stream.frames.map(f=>[f.card,f.status,f.ms])};
 })));
 report.triplePages={pages:triple.result,statements:triple.statements()};print('triple-pages',triple.result);evidence();

 // 4. Plans of statements above 100 ms, nested inside functions, for the manager stream.
 const [{db}]=await owner.client<{db:string}[]>`select current_database() as db`;
 const notices:{durationMs:number;plan:string}[]=[];
 const log=console.log;
 const spy=vi.spyOn(console,'log').mockImplementation((...args:unknown[])=>{
  const notice=args[0] as {severity?:string;message?:string}|undefined;
  if(notice&&typeof notice==='object'&&typeof notice.message==='string'&&notice.message.startsWith('duration:')){
   notices.push({durationMs:Number(/^duration: ([0-9.]+) ms/.exec(notice.message)?.[1]??0),plan:notice.message.slice(0,12000)});
   return;
  }
  log(...args);
 });
 try{
  await owner.client.unsafe(`alter role ai_hr_app in database "${db}" set session_preload_libraries='auto_explain'`);
  for(const [key,value] of [['log_min_duration','100'],['log_analyze','on'],['log_buffers','on'],['log_nested_statements','on'],['log_level','notice'],['log_timing','on'],['log_format','text']])
   await owner.client.unsafe(`alter role ai_hr_app in database "${db}" set auto_explain.${key}='${value}'`);
  await owner.client`select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and usename='ai_hr_app' and pid<>pg_backend_pid()`;
  await new Promise(resolve=>setTimeout(resolve,200));
  for(let attempt=0;attempt<5;attempt++){
   try{await withTenant(manager.ctx,tx=>tx.execute(sql`select 1`));break;}catch{await new Promise(resolve=>setTimeout(resolve,200));}
  }
  const [loaded]=await withTenant(manager.ctx,tx=>tx.execute<{explain:string}>(sql`select current_setting('auto_explain.log_min_duration',true) as explain`));
  report.autoExplain=loaded?.explain??null;
  for(let attempt=0;attempt<2;attempt++){
   const result=await streamHome(manager,month,'explain:'+attempt);
   print('explain-stream',{attempt,elapsedMs:result.elapsedMs,frames:result.frames.map(f=>[f.card,f.status,f.ms])});
  }
  const targets=await todayTargets(manager.ctx);
  for(const name of ['needsYou','doneForYou','atAGlance','beforePayroll','page.performanceBlock','page.assignedPerformance']){
   const started=performance.now();let failure:unknown=null;
   try{await targets[name]();}catch(error){failure=errorFact(error);}
   print('explain-today',{name,ms:Math.round(performance.now()-started),failure});
  }
 }finally{
  spy.mockRestore();
  await owner.client.unsafe(`alter role ai_hr_app in database "${db}" reset all`);
  await owner.client`select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and usename='ai_hr_app' and pid<>pg_backend_pid()`;
 }
 notices.sort((a,b)=>b.durationMs-a.durationMs);
 report.plans=notices.slice(0,30);evidence();
 for(const notice of notices.slice(0,14))console.info('[home-card-diagnostic] plan '+notice.durationMs+'ms\n'+notice.plan.slice(0,7000));

 // 6. Each deployed worker count, cold and warm, with and without CPU competition.
 const workerModel:unknown[]=[];report.workerModel=workerModel;
 const deadlineMs=2800;
 for(const workers of [2,4,8])for(const pressure of [0,8]){
  const stop=cpuPressure(pressure),worker=await coldWorker(workers);
  try{
   await new Promise(resolve=>setTimeout(resolve,pressure?1500:0));
   const measure=async(label:string,actor:Actor)=>{
    const run='model:'+workers+':'+pressure+':'+label;worker.resetTrips();
    const result=await streamHome(actor,month,run,worker.GET),trace=transactions.filter(row=>row.run===run);
    return {label,elapsedMs:result.elapsedMs,trips:worker.trips(),transactions:trace.length,
     holdMs:Math.round(trace.reduce((sum,row)=>sum+row.totalMs-row.waitMs,0)),maxWaitMs:Math.round(Math.max(0,...trace.map(row=>row.waitMs))),
     overDeadline:result.frames.filter(frame=>frame.ms>deadlineMs).map(frame=>frame.card),
     cards:Object.fromEntries(result.frames.map(frame=>[frame.card,frame.status===200?frame.ms:'status-'+frame.status]))};
   };
   const rows=[await measure('cold-manager',manager),await measure('warm-manager-1',manager),await measure('warm-manager-2',manager),await measure('warm-employee',employee)];
   worker.resetTrips();
   const startedOverlap=performance.now();
   const overlap=await Promise.all([manager,employee,secondManager].map(actor=>streamHome(actor,month,null,worker.GET)));
   const row={workers,poolPerWorker:Math.floor(16/workers),cpuPressure:pressure,load1:loadavg()[0],rows,
    overlappedMs:Math.round(performance.now()-startedOverlap),overlappedOver:overlap.flatMap(result=>result.frames.filter(frame=>frame.ms>deadlineMs).map(frame=>frame.card)),
    overlappedSlowest:overlap.map(result=>[...result.frames].sort((a,b)=>b.ms-a.ms).slice(0,3).map(frame=>[frame.card,frame.status,frame.ms]))};
   workerModel.push(row);print('worker-model',row);evidence();
  }finally{stop();await worker.close().catch(()=>undefined);}
 }
 // 7. Round trips each owner spends, on one connection so per-transaction deltas are exact.
 {
  const worker=await coldWorker(16);
  try{
   for(const [label,actor] of [['manager',manager],['employee',employee]] as const){
    await streamHome(actor,month,null,worker.GET);
    const run='trips:'+label;worker.resetTrips();
    const cpuBefore=process.cpuUsage();await streamHome(actor,month,run,worker.GET);const cpu=process.cpuUsage(cpuBefore);
    const owners=new Map<string,{owner:string;tx:number;trips:number}>();
    for(const row of transactions.filter(row=>row.run===run)){
     const entry=owners.get(row.owner)??{owner:row.owner.split(' < ').slice(0,2).join(' < '),tx:0,trips:0};
     entry.tx++;entry.trips+=row.trips;owners.set(row.owner,entry);
    }
    const trace={label,totalTrips:worker.trips(),nodeCpuMs:Math.round((cpu.user+cpu.system)/1000),owners:[...owners.values()].sort((a,b)=>b.trips-a.trips)};
    (report.tripsByOwner??=[] as unknown[]);(report.tripsByOwner as unknown[]).push(trace);print('trips-by-owner',trace);
   }
  }finally{await worker.close().catch(()=>undefined);}
  evidence();
 }
 // 8 and 9, both transaction scopes on the same runner: 'off' (every owner its own transaction, the old path)
 // and 'stream' (one shared snapshot per Home stream and per Today section, the shipped path). A per-card scope was
 // measured and rejected: cards awaiting a carrier read held in another card's snapshot stalled at two connections.
 const scopes=['off','stream'] as const;
 const ramp:unknown[]=[];report.cpuRamp=ramp;
 for(const [workers,pressure] of [[2,16],[8,16],[4,32]] as const)for(const scope of scopes){
  const stop=cpuPressure(pressure),worker=await coldWorker(workers);
  try{
   await new Promise(resolve=>setTimeout(resolve,1500));
   const scoped=<T,>(work:()=>Promise<T>)=>scope==='off'?worker.independent(work):work();
   const once=async(actor:Actor)=>{const result=await scoped(()=>streamHome(actor,month,null,worker.GET));return {elapsedMs:result.elapsedMs,over:result.frames.filter(frame=>frame.ms>deadlineMs).map(frame=>frame.card)};};
   const cold=await once(manager),warm=[await once(manager),await once(manager)];
   worker.resetTrips();const counted=await once(manager);const trips=worker.trips();
   const overlapped=await Promise.all([manager,employee,secondManager].map(once));
   const row={scope,workers,poolPerWorker:Math.floor(16/workers),cpuPressure:pressure,cold,warm,counted:{...counted,trips},overlapped};
   ramp.push(row);print('cpu-ramp',row);evidence();
  }finally{stop();await worker.close().catch(()=>undefined);}
 }
 // The first browser sweep: six simultaneous whole Home pages, shared round-robin across the workers.
 // 'page' additionally renders each page's sections in one request scope (lib/request-read-scope.ts), as the page now does.
 const burst:unknown[]=[];report.pageBurst=burst;
 for(const [workers,pressure] of [[2,16],[4,16],[8,16]] as const)for(const scope of [...scopes,'page'] as const){
  const stop=cpuPressure(pressure),worker=await coldWorker(workers);
  try{
   await new Promise(resolve=>setTimeout(resolve,1500));
   const targets=await todayReaders(today),pagesPerWorker=Math.ceil(6/workers);
   const lane=[manager,employee,secondManager].slice(0,Math.min(3,pagesPerWorker));
   while(lane.length<pagesPerWorker)lane.push(actors.find(a=>a.index===5+lane.length)!);
   const section=<T,>(read:()=>Promise<T>)=>scope==='off'?worker.independent(read):read();
   for(const attempt of ['cold','warm']){
    worker.resetTrips();
    const pages=await Promise.all(lane.map(async actor=>{
     const owners=await targets(actor.ctx),started=performance.now(),sections:Record<string,unknown>={};
     const render=<T,>(work:()=>Promise<T>)=>scope==='page'?targets.pageRender(work):work();
     const [stream]=await Promise.all([section(()=>streamHome(actor,month,null,worker.GET)),render(()=>Promise.all(['needsYou','doneForYou','atAGlance','beforePayroll','page.identity','page.greetingIdentity','page.performanceBlock','page.assignedPerformance','page.layoutApprovals'].map(name=>
      section(owners[name]).then(()=>{sections[name]=Math.round(performance.now()-started);},error=>{sections[name]=errorFact(error);}))))]);
     return {role:actor.role,elapsedMs:stream.elapsedMs,over:stream.frames.filter(frame=>frame.ms>deadlineMs).map(frame=>frame.card),
      failed:stream.frames.filter(frame=>frame.status!==200).map(frame=>frame.card),
      slowest:[...stream.frames].sort((a,b)=>b.ms-a.ms).slice(0,4).map(frame=>[frame.card,frame.status,frame.ms]),sections};
    }));
    const row={scope,workers,poolPerWorker:Math.floor(16/workers),cpuPressure:pressure,pagesPerWorker,attempt,trips:worker.trips(),pages};
    burst.push(row);print('page-burst',row);evidence();
   }
  }finally{stop();await worker.close().catch(()=>undefined);}
 }
 Object.assign(process.env,{DATABASE_URL:applicationUrl});delete process.env.AIHR_APP_WORKERS;delete process.env.AIHR_DB_TOTAL_CONNECTIONS;
 // Every stream frame, Today section and page owner completed. Timings stay diagnostic evidence.
 const failedFrames=(streams as {run:string;frames:{card:string;status:number}[]}[]).flatMap(row=>row.frames.filter(frame=>frame.status!==200).map(frame=>row.run+':'+frame.card));
 expect(failedFrames).toEqual([]);
 const failedSections=Object.entries(todaySolo).flatMap(([label,rows])=>Object.entries(rows as Record<string,{failure:unknown;result:unknown}>)
  .filter(([,row])=>row.failure!==null||(row.result as {failed?:unknown}|null)?.failed===true||(row.result as {ok?:unknown}|null)?.ok===false).map(([name])=>label+':'+name));
 expect(failedSections).toEqual([]);
 const overlapped=[...pageRuns as {frames:[string,number,number][];sections:Record<string,{failure?:unknown;value?:unknown}>}[],
  ...triple.result as unknown as {frames:[string,number,number][];sections:Record<string,{failure?:unknown;value?:unknown}>}[]];
 expect(overlapped.flatMap(row=>[...row.frames.filter(([,status])=>status!==200).map(([card])=>card),
  ...Object.entries(row.sections).filter(([,section])=>section.failure!==undefined||(section.value as {failed?:unknown}|null)?.failed===true).map(([name])=>name)])).toEqual([]);
 // Old and new reads are identical, and no foreign identity ever joined a host session.
 expect(mismatches).toEqual([]);
 expect(Object.values(isolation).map(row=>(row as {hostSessionJoins:number}).hostSessionJoins)).toEqual([0,0]);
},1_400_000);
});

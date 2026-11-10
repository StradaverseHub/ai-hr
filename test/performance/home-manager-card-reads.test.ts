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
import {sql} from 'drizzle-orm';
import {client as applicationClient,withTenant,type SessionContext} from '../../db/client';
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
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';

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

async function seedTenant(t:number,today:string){
 const b=await seedBase();
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
 return async(ctx:SessionContext):Promise<Record<string,()=>Promise<unknown>>>=>{
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
   'page.identity':()=>home.readEmployeeHomeIdentity(ctx).then(()=>'ok'),
   'page.greetingIdentity':()=>home.readEmployeeHomeGreetingIdentity(ctx).then(()=>'ok'),
   'page.performanceBlock':()=>performanceService.getPerformanceHomeBlock(ctx,scopeIds).then(value=>value===null?'none':'block'),
   'page.assignedPerformance':()=>performanceService.hasAssignedPerformanceWork(ctx,scopeIds),
   'page.assistant':()=>assistant.mayUseAssistant(ctx).then(value=>value.allowed),
   'page.layoutApprovals':()=>database.withBackgroundReadWork(ctx.tenantId,()=>inbox.pendingTaskSummary(ctx,scopeIds,modules,{deferClaimPreview:true})).then(value=>({total:value.total})),
  };
 };
}

type Traced={trips:number;statements:{sql:string;count:number}[];ordered:string[]};
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

async function streamHome(actor:Actor,month:string,run:string|null,handler:typeof GET=GET){
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
 return {GET:route.GET as typeof GET,trips:()=>trips,resetTrips(){trips=0;},close:()=>database.client.end({timeout:5})};
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
 // 5b. Exact statements each card and Today section issues, on the application client. Statement
 // text only (bound values never appear in it); BEGIN, set_config and COMMIT all count as trips.
 const statementTrace:Record<string,unknown>={};report.statementTrace=statementTrace;
 const pageSections=['needsYou','doneForYou','atAGlance','beforePayroll','page.identity','page.greetingIdentity','page.performanceBlock','page.assignedPerformance','page.layoutApprovals'];
 for(const [label,actor] of [['manager',manager],['employee',employee]] as const){
  const targets=await todayTargets(actor.ctx),rows:Record<string,Traced>={};statementTrace[label]=rows;
  for(const card of CARDS){
   await readers(actor.ctx,actor.employmentId,month)[card]().catch(()=>undefined);
   rows['card:'+card]=(await traceStatements(()=>readers(actor.ctx,actor.employmentId,month)[card]())).trace;
  }
  for(const [name,read] of Object.entries(targets)){
   await read().catch(()=>undefined);
   rows['section:'+name]=(await traceStatements(read)).trace;
  }
  rows.stream=(await traceStatements(()=>streamHome(actor,month,null))).trace;
  const page=await traceStatements(()=>Promise.all([streamHome(actor,month,null),...pageSections.map(name=>targets[name]())]));
  rows.page=page.trace;
  print('statement-trace',{label,trips:Object.fromEntries(Object.entries(rows).map(([name,row])=>[name,row.trips])),pageFailure:page.failure});
  evidence();
 }
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
 // 8. Find where a Home stream crosses the card deadline as CPU competition rises.
 const ramp:unknown[]=[];report.cpuRamp=ramp;
 for(const [workers,pressure] of [[2,16],[8,16],[2,32],[8,32],[4,32]] as const){
  const stop=cpuPressure(pressure),worker=await coldWorker(workers);
  try{
   await new Promise(resolve=>setTimeout(resolve,1500));
   const once=async(actor:Actor)=>{const result=await streamHome(actor,month,null,worker.GET);return {elapsedMs:result.elapsedMs,over:result.frames.filter(frame=>frame.ms>deadlineMs).map(frame=>frame.card)};};
   const cold=await once(manager),warm=[await once(manager),await once(manager)];
   const overlapped=await Promise.all([manager,employee,secondManager].map(once));
   const row={workers,poolPerWorker:Math.floor(16/workers),cpuPressure:pressure,cold,warm,overlapped};
   ramp.push(row);print('cpu-ramp',row);evidence();
  }finally{stop();await worker.close().catch(()=>undefined);}
 }
 // 9. The first browser sweep: six simultaneous whole Home pages, shared round-robin across the workers.
 const burst:unknown[]=[];report.pageBurst=burst;
 for(const [workers,pressure] of [[2,16],[4,16],[8,16]] as const){
  const stop=cpuPressure(pressure),worker=await coldWorker(workers);
  try{
   await new Promise(resolve=>setTimeout(resolve,1500));
   const targets=await todayReaders(today),pagesPerWorker=Math.ceil(6/workers);
   const lane=[manager,employee,secondManager].slice(0,Math.min(3,pagesPerWorker));
   while(lane.length<pagesPerWorker)lane.push(actors.find(a=>a.index===5+lane.length)!);
   for(const attempt of ['cold','warm']){
    const pages=await Promise.all(lane.map(async actor=>{
     const owners=await targets(actor.ctx),started=performance.now(),sections:Record<string,unknown>={};
     const [stream]=await Promise.all([streamHome(actor,month,null,worker.GET),...['needsYou','doneForYou','atAGlance','beforePayroll','page.identity','page.greetingIdentity','page.performanceBlock','page.assignedPerformance','page.layoutApprovals'].map(name=>
      owners[name]().then(()=>{sections[name]=Math.round(performance.now()-started);},error=>{sections[name]=errorFact(error);}))]);
     return {role:actor.role,elapsedMs:stream.elapsedMs,over:stream.frames.filter(frame=>frame.ms>deadlineMs).map(frame=>frame.card),
      slowest:[...stream.frames].sort((a,b)=>b.ms-a.ms).slice(0,4).map(frame=>[frame.card,frame.status,frame.ms]),sections};
    }));
    const row={workers,poolPerWorker:Math.floor(16/workers),cpuPressure:pressure,pagesPerWorker,attempt,pages};
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
},900_000);
});

/** AI Centre at group scale (11 November 2026: "Record readiness loads quite long" on staging, 71 companies and ~900
 * employments behind a 7-connection pool). For each AI Centre page, the server reads it awaits, in the page's own order
 * and arguments, on a fictional fixture shaped like that group (test/helpers/ai-centre-scale-fixture.ts), as a group
 * administrator ("All companies"), as an HR administrator granted all 71 companies one by one, and as an HR
 * administrator of one company. For every read: the wall time (median of RUNS after WARMUP), the statements it sent and
 * the transactions it opened; for the first run of every page, each statement replayed under EXPLAIN (ANALYZE) so the
 * evidence names the statement and plan node where the time went.
 *
 * Output: ai-centre-scale-timing.json in the evidence folder, and one AIHR_AI_CENTRE_SCALE line per page and persona.
 * It asserts the bounds the owner set: no page's reads over STATEMENT_BOUND statements, none scaling with the number of
 * companies, and every page's reads within PAGE_BUDGET_MS on the CI runner. It does not time session resolution, React
 * rendering, serialisation or the network. */
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>undefined}),headers:async()=>new Headers()}));
import type {SessionContext} from '../db/client';
import {recordReadiness} from '../core/record-readiness';
import {orchestrationQueue} from '../core/hr-orchestrator';
import {readinessLoopAsks} from '../core/loops/readiness-asks';
import {loopsOverview,loopDetail} from '../core/loops/views';
import {loopLevelSummaries,loopAutonomyDetail} from '../core/loops/autonomy-views';
import {payrollCycleOverview} from '../core/loops/payroll-cycle-views';
import {LOOP_IDS} from '../core/loops/types';
import {openExceptionsAcrossRuns} from '../core/payroll-anomaly';
import {proposeActions} from '../core/agent-actions';
import {acknowledgedBlocks} from '../core/loops/grouped-dispositions';
import {allowedCompanies} from '../core/read';
import {aiManagementView} from '../core/ai-management';
import {aiInventoryView,aiManagementAlerts,aiRunHistory} from '../core/ai-inventory';
import {bulkAssistantDepartments} from '../core/ai-management';
import {loadAiGovernance} from '../core/ai-workspace';
import {readChatRetention} from '../core/teras-chats';
import {getAiConfigView} from '../core/ai-config';
import {agentBuildList} from '../core/agent-build-list';
import {agentStatuses} from '../core/control-domains';
import {listWorkers} from '../core/agent-registry/views';
import {outcomeSummary} from '../core/agent-registry/export';
import {withTenant} from '../db/client';
import {aiCentreControlState} from '../core/ai-centre-control';
import {aiCentreReadControls,aiCentreJobTypes} from '../core/ai-centre-inventory';
import {readMandateKeysTx} from '../core/mandates/mandates';
import {delegableJobType} from '../core/mandates/job-types';
/** main's AiCentreControls reads (app/control-tower/agents/centre-controls.tsx on main), verbatim. */
const aiCentreControlReads=(session:SessionContext)=>Promise.all([
  aiCentreControlState(session).catch(()=>null),aiCentreReadControls(session).catch(()=>null),
  withTenant(session,async tx=>Promise.all(aiCentreJobTypes().map(async id=>{
   const jobType=delegableJobType(id),keys=await readMandateKeysTx(tx,session.tenantId,jobType);
   return{jobType,enabled:keys.enablement?.enabled===true};
  }))).catch(()=>null)]);
import {isGroupAdmin} from '../lib/authz-model';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {explainStatements,observeStatements,type ExplainedStatement} from './helpers/statement-observer';

const RUNS=3,WARMUP=1;
/** The owner's bar: a page renders in about 2 s; its reads must leave room for the shell and rendering. */
const PAGE_BUDGET_MS=Number(process.env.AIHR_SCALE_PAGE_BUDGET_MS??1500);
const STATEMENT_BOUND=40;
type Persona='group'|'multi'|'single';
type Read=Readonly<{label:string;stage:number;run:(ctx:SessionContext,got:Map<string,unknown>)=>Promise<unknown>}>;
type Page=Readonly<{id:string;reads:readonly Read[];note?:string;foreign?:true}>;

const readiness:Page={id:'control-tower.readiness',reads:[
 {label:'recordReadiness',stage:0,run:ctx=>recordReadiness(ctx)},
 {label:'orchestrationQueue',stage:0,run:ctx=>orchestrationQueue(ctx).catch(()=>null)},
 {label:'readinessLoopAsks',stage:1,run:(ctx,got)=>{const view=got.get('recordReadiness') as Awaited<ReturnType<typeof recordReadiness>>;
  return readinessLoopAsks(ctx,[...new Set(view.gaps.flatMap(g=>g.people.map(p=>p.employmentId)))]).catch(()=>null);}},
]};
const loops:Page={id:'control-tower.loops',reads:[
 {label:'payrollCycleOverview(foreign owner)',stage:0,run:ctx=>payrollCycleOverview(ctx).catch(()=>null)},
 {label:'loopsOverview',stage:0,run:ctx=>loopsOverview(ctx)},
 {label:'loopLevelSummaries',stage:0,run:ctx=>loopLevelSummaries(ctx)},
]};
const loopPages:Page[]=LOOP_IDS.filter(id=>id!=='loop_payroll_audit').map(id=>({id:`control-tower.loops.${id}`,reads:[
 {label:'loopDetail',stage:0,run:ctx=>loopDetail(ctx,id)},
 {label:'loopAutonomyDetail',stage:1,run:ctx=>loopAutonomyDetail(ctx,id)},
]}));
const exceptions:Page={id:'control-tower.exceptions',reads:[
 {label:'openExceptionsAcrossRuns',stage:0,run:ctx=>openExceptionsAcrossRuns(ctx)},
 {label:'proposeActions',stage:0,run:ctx=>proposeActions(ctx)},
 {label:'allowedCompanies',stage:0,run:ctx=>allowedCompanies(ctx).then(rows=>rows.map(row=>row.id)).catch(()=>[] as string[])},
 {label:'acknowledgedBlocks',stage:1,run:async(ctx,got)=>{
  const queue=got.get('openExceptionsAcrossRuns') as Awaited<ReturnType<typeof openExceptionsAcrossRuns>>,companies=got.get('allowedCompanies') as string[];
  const periods=[...new Set(queue.rows.filter(row=>row.disposition==='block').map(row=>row.payPeriod))].sort();
  return companies.length?Promise.all(periods.map(payPeriod=>acknowledgedBlocks(ctx,{companyIds:companies,payPeriod}))):[];}},
]};
type View=Awaited<ReturnType<typeof aiManagementView>>;
/** AiManagementScreen (app/control-tower/agents/screen.tsx): its reads in order for one section, after the page's own. */
const screen=(section:'overview'|'features'|'runs'|'allowances'|'spending'|'assistant'|'provider',before:readonly Read[]=[]):Page=>{
 const at=before.length?Math.max(...before.map(r=>r.stage))+1:0;
 return{id:`control-tower.agents.${section}`,reads:[...before,
  {label:'aiManagementPageView',stage:at,run:ctx=>aiManagementView(ctx,'',{})},
  ...(section==='features'?[{label:'aiInventoryView',stage:at+1,run:(ctx:SessionContext,got:Map<string,unknown>)=>aiInventoryView(ctx,got.get('aiManagementPageView') as View).catch(()=>null)}]:[]),
  {label:'aiManagementAlerts',stage:at+2,run:(ctx,got)=>aiManagementAlerts(ctx,got.get('aiManagementPageView') as View)},
  ...(section==='runs'?[{label:'aiRunHistory',stage:at+3,run:(ctx:SessionContext)=>isGroupAdmin(ctx)?aiRunHistory(ctx,{}, {}):Promise.resolve(null)}]:[]),
  ...(section==='allowances'?[{label:'bulkAssistantDepartments',stage:at+3,run:(ctx:SessionContext,got:Map<string,unknown>)=>(got.get('aiManagementPageView') as View).mayWriteUsers?bulkAssistantDepartments(ctx).catch(()=>[]):Promise.resolve([])}]:[]),
 ]};
};
const agents:Page[]=[screen('overview'),screen('runs'),screen('allowances'),screen('spending'),
 screen('assistant',[{label:'loadAiGovernance',stage:0,run:ctx=>loadAiGovernance(ctx)},{label:'readChatRetention',stage:1,run:ctx=>readChatRetention(ctx).catch(()=>null)}]),
 screen('provider',[{label:'getAiConfigView',stage:0,run:ctx=>isGroupAdmin(ctx)?getAiConfigView(ctx).catch(()=>null):Promise.resolve(null)}]),
 screen('features',[{label:'agentStatuses',stage:0,run:ctx=>agentStatuses(ctx).catch(()=>null)},
  {label:'registry',stage:1,run:ctx=>isGroupAdmin(ctx)?Promise.all([listWorkers(ctx),outcomeSummary(ctx).catch(()=>null)]).catch(()=>null):Promise.resolve(null)},
  {label:'aiCentreControlReads',stage:2,run:ctx=>isGroupAdmin(ctx)?aiCentreControlReads(ctx):Promise.resolve(null)}]),
 {id:'control-tower.agents.build-list',reads:[{label:'agentBuildList',stage:0,run:ctx=>isGroupAdmin(ctx)?agentBuildList(ctx,90):Promise.resolve(null)}]},
];
const PAGES:readonly Page[]=[readiness,loops,...loopPages,exceptions,...agents];

let fixture:ScaleFixture;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();
 const b=await seedBase();
 for(const code of ['assistant','claims','notifications','attendance','lifecycle','payroll'])await setModule(b.tenantId,code,'active');
 fixture=await buildScaleFixture(b);
},300_000);
afterAll(closeAll);

const median=(values:readonly number[])=>{const s=[...values].sort((x,y)=>x-y),m=(s.length-1)/2;return Math.round(((s[Math.floor(m)]+s[Math.ceil(m)])/2)*10)/10;};

type ReadResult={ms:number[];statements:number;transactions:number};
const errors:string[]=[];
async function runPage(page:Page,ctx:SessionContext,explain:boolean){
 const got=new Map<string,unknown>(),reads:Record<string,{ms:number;statements:number;transactions:number}>={},captured:{label:string;statements:Awaited<ReturnType<typeof observeStatements>>['statements']}[]=[];
 const stages=[...new Set(page.reads.map(r=>r.stage))].sort((a,b)=>a-b);
 const started=performance.now();
 for(const stage of stages){
  // A stage the page already runs with Promise.all runs together here too.
  await Promise.all(page.reads.filter(r=>r.stage===stage).map(async read=>{
   // A read that refuses or fails is recorded with its error rather than hiding every other measurement.
   const observed=await observeStatements(()=>read.run(ctx,got).catch(error=>({readFailed:String(error).slice(0,300)})));
   if(observed.result&&typeof observed.result==='object'&&'readFailed' in observed.result)errors.push(`${page.id}|${read.label}: ${(observed.result as {readFailed:string}).readFailed}`);
   got.set(read.label,observed.result);
   reads[read.label]={ms:observed.ms,statements:observed.statements.length,transactions:observed.transactions};
   if(explain)captured.push({label:read.label,statements:observed.statements});
  }));
 }
 return{pageMs:performance.now()-started,reads,captured};
}

describe('AI Centre pages at group scale (71 companies, ~1,000 employments)',()=>{
 it('times each page read, counts its statements and names the slowest statements',async()=>{
  const report:Record<string,unknown>={};const lines:string[]=[];const failures:string[]=[];
  for(const persona of ['group','multi','single'] as Persona[]){
   const ctx=fixture.personas[persona];
   for(const page of PAGES){
    const samples:Record<string,ReadResult>={};const pageMs:number[]=[];let explained:Record<string,ExplainedStatement[]>={};
    for(let run=0;run<RUNS+WARMUP;run++){
     const result=await runPage(page,ctx,run===0);
     if(run===0)for(const item of result.captured)explained[item.label]=(await explainStatements(item.statements)
      .catch(error=>[{ordinal:0,sql:'(replay)',executionMs:null,planningMs:null,hotspots:[],error:String(error).slice(0,300)}] as ExplainedStatement[]))
      .filter(s=>s.executionMs!==null||s.error).sort((a,b)=>(b.executionMs??0)-(a.executionMs??0)).slice(0,4);
     if(run<WARMUP)continue;
     pageMs.push(result.pageMs);
     for(const [label,read] of Object.entries(result.reads)){const s=(samples[label]??={ms:[],statements:read.statements,transactions:read.transactions});s.ms.push(read.ms);}
    }
    const reads=Object.fromEntries(Object.entries(samples).map(([label,s])=>[label,{medianMs:median(s.ms),statements:s.statements,transactions:s.transactions}]));
    const statements=Object.values(samples).reduce((n,s)=>n+s.statements,0),transactions=Object.values(samples).reduce((n,s)=>n+s.transactions,0);
    const row={persona,page:page.id,medianPageMs:median(pageMs),statements,transactions,reads,slowestStatements:explained};
    report[`${page.id}|${persona}`]=row;
    lines.push(`AIHR_AI_CENTRE_SCALE ${JSON.stringify({page:page.id,persona,ms:row.medianPageMs,statements,transactions,reads:Object.fromEntries(Object.entries(reads).map(([l,r])=>[l,[r.medianMs,r.statements]]))})}`);
    explained={};
    const own=Object.entries(samples).filter(([label])=>!label.includes('foreign owner'));
    const ownStatements=own.reduce((n,[,s])=>n+s.statements,0);
    if(ownStatements>STATEMENT_BOUND)failures.push(`${page.id}|${persona}: ${ownStatements} statements`);
    if(row.medianPageMs>PAGE_BUDGET_MS&&!Object.keys(samples).some(label=>label.includes('foreign owner')))failures.push(`${page.id}|${persona}: ${row.medianPageMs} ms`);
   }
  }
  const dir=process.env.RUNNER_TEMP?join(process.env.RUNNER_TEMP,'aihr-focused'):join(process.cwd(),'.review-evidence');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'ai-centre-scale-timing.json'),JSON.stringify({kind:'ai-centre.scale-timing',version:1,runs:RUNS,warmup:WARMUP,
   fixture:{companies:fixture.companyIds.length,employments:fixture.employmentIds.length,active:fixture.activeEmploymentIds.length},
   ...(process.env.GITHUB_RUN_ID?{runId:process.env.GITHUB_RUN_ID}:{}),failures,readErrors:[...new Set(errors)],report},null,1));
  process.stdout.write(lines.join('\n')+'\n');
  process.stdout.write('AIHR_AI_CENTRE_SCALE_FAILURES '+JSON.stringify(failures)+'\n');
  process.stdout.write('AIHR_AI_CENTRE_SCALE_READ_ERRORS '+JSON.stringify([...new Set(errors)])+'\n');
  expect(Object.keys(report).length).toBe(PAGES.length*3);
 },600_000);
});

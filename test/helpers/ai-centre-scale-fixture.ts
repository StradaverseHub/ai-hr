/** Fictional fixture shaped like the staging group that reported a slow AI Centre (11 November 2026): 71 companies in a
 * three-level tree (one group company, 6 regional holding companies, 64 operating companies), about 1,000 employments
 * spread unevenly over 60 of them (a few large, many small, 11 empty), varied record gaps, the HR engine's readiness
 * cases, the missing-employee-data loop's cases and a domain-event history of ~30,000 rows. Every name, code and number
 * is invented. Written as the owner in bulk, so it builds in seconds; it is a READ fixture for the AI Centre pages.
 *
 * Personas (all hold a login and an employment of their own, so self-exclusion rules are exercised):
 *  - group:  hr_admin, group-wide (companyId null) — the staging owner's "All companies" view;
 *  - multi:  hr_admin granted company by company on all 71 companies — "All companies" for a company HR administrator;
 *  - single: hr_admin of one operating company — a single-company view. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import * as schema from '../../db/schema';
import {terasLoopCase,terasLoopRun} from '../../db/teras-schema';
import {payrollCheckAcknowledgement} from '../../db/teras-payroll-cycle-schema';
import type {SessionContext} from '../../db/client';
import {entitledCtx,owner,type Base} from '../harness';

export type ScaleFixture=Readonly<{companyIds:readonly string[];operatingCompanyIds:readonly string[];employmentIds:readonly string[];
 activeEmploymentIds:readonly string[];personas:Readonly<{group:SessionContext;multi:SessionContext;single:SessionContext}>;singleCompanyId:string}>;

const DAY=86_400_000;
const chunk=<T>(rows:readonly T[],size:number)=>Array.from({length:Math.ceil(rows.length/size)},(_,i)=>rows.slice(i*size,i*size+size));
/** Deterministic pseudo-random in [0,1) from an integer, so the fixture is the same on every run. */
const rand=(n:number)=>{const x=Math.sin(n*12.9898+78.233)*43758.5453;return x-Math.floor(x);};

export async function buildScaleFixture(b:Base,opts:Readonly<{employments?:number;events?:number}>={}):Promise<ScaleFixture>{
 const total=opts.employments??1000,eventCount=opts.events??30_000;
 // Companies: the base company is the group root; 6 regional holding companies under it; 64 operating companies.
 const regions=await owner.db.insert(schema.company).values(Array.from({length:6},(_,i)=>({tenantId:b.tenantId,legalName:`Fictional Region ${String.fromCharCode(65+i)} Holdings Sdn Bhd`,parentCompanyId:b.companyId})))
  .returning({id:schema.company.id});
 const operating=await owner.db.insert(schema.company).values(Array.from({length:64},(_,i)=>({tenantId:b.tenantId,legalName:`Fictional Operating ${String(i+1).padStart(2,'0')} Sdn Bhd`,
  parentCompanyId:regions[i%6].id}))).returning({id:schema.company.id});
 const companyIds=[b.companyId,...regions.map(r=>r.id),...operating.map(o=>o.id)];
 // Employments on 60 companies, unevenly: weights fall away so a few companies are large and many are small.
 const staffed=companyIds.slice(0,60),weights=staffed.map((_,i)=>1/(1+i*0.35)),sum=weights.reduce((a,w)=>a+w,0);
 const companyOf:string[]=[];
 staffed.forEach((id,i)=>{const n=Math.max(1,Math.round(total*weights[i]/sum));for(let k=0;k<n;k++)companyOf.push(id);});
 companyOf.length=Math.min(companyOf.length,total);while(companyOf.length<total)companyOf.push(staffed[0]);
 const people=[];
 for(const part of chunk(companyOf.map((_,i)=>({tenantId:b.tenantId,fullName:`Fictional Person ${String(i).padStart(4,'0')} ${['Tan','Lim','Wong','Raj','Aziz','Lee','Ng','Chong'][i%8]}`,
  primaryEmail:`scale-${i}-${randomUUID().slice(0,8)}@fixture.test`})),500))
  people.push(...await owner.db.insert(schema.person).values(part).returning({id:schema.person.id}));
 const employments:{id:string;personId:string;companyId:string;terminated:boolean}[]=[];
 const employmentRows=companyOf.map((companyId,i)=>({tenantId:b.tenantId,personId:people[i].id,companyId,employeeCode:`FX-${String(i).padStart(4,'0')}`,hiredOn:'2022-01-01',
  terminatedOn:i%50===7?'2026-06-30':null,
  paymentMethod:(i%13===0?'cash':i%11===0?'bank_transfer':i%29===0?'cheque':null) as 'cash'|'bank_transfer'|'cheque'|null}));
 for(const part of chunk(employmentRows,500)){
  const rows=await owner.db.insert(schema.employment).values(part).returning({id:schema.employment.id,personId:schema.employment.personId,companyId:schema.employment.companyId,terminatedOn:schema.employment.terminatedOn});
  employments.push(...rows.map(r=>({id:r.id,personId:r.personId,companyId:r.companyId,terminated:r.terminatedOn!=null})));
 }
 // Statutory rows for ~62%, with every field blank somewhere; some EPF exemptions and SOCSO/EIS exemptions.
 const statutory=employments.flatMap((e,i)=>rand(i)<0.62?[{tenantId:b.tenantId,personId:e.personId,
  icNumber:i%9===0?null:i%17===0?'  ':`900101${String(100000+i)}`,passportNumber:i%9===0&&i%2===0?`A${String(5000000+i)}`:null,
  taxNumber:i%5===0?null:`SG${String(1000000+i)}`,epfNumber:i%7===0?null:`EPF${String(i)}`,socsoNumber:i%6===0?null:`SOC${String(i)}`,
  bankAccountNo:i%4===0?null:`5140${String(100000+i)}`,epfMode:(i%21===0?'exempt':'auto') as 'exempt'|'auto',
  subjectToSocso:i%33!==0,eisEligible:i%33!==0}]:[]);
 for(const part of chunk(statutory,500))await owner.db.insert(schema.employeeStatutoryMy).values(part);
 // Compensation for ~55%, some with a salary history of two rows.
 const comp=employments.flatMap((e,i)=>rand(i+7)<0.55?[{tenantId:b.tenantId,employmentId:e.id,basicSalary:String(2500+(i%40)*100),validFrom:'2024-01-01',...(i%3===0?{validTo:'2025-01-01'}:{})},
  ...(i%3===0?[{tenantId:b.tenantId,employmentId:e.id,basicSalary:String(2600+(i%40)*100),validFrom:'2025-01-01'}]:[])]:[]);
 for(const part of chunk(comp,500))await owner.db.insert(schema.compensation).values(part);
 const active=employments.filter(e=>!e.terminated);
 // The HR engine's cases, as of an earlier check: 260 rows over the first active people, mixed states.
 const now=Date.now();
 const caseRows=active.slice(0,130).flatMap((e,i)=>(['no_tax_number','no_bank_account'] as const).map((gap,g)=>({tenantId:b.tenantId,employmentId:e.id,gap,
  state:(i%9===0?'verified':g===1&&i%3===0?'needs_review':'needs_input') as 'verified'|'needs_review'|'needs_input',audience:(g===1&&i%3===0?'hr':'employee') as 'hr'|'employee',
  harnessVersion:'fictional-scale',openedAt:new Date(now-((i*7+g)%90)*DAY),observedAt:new Date(now-DAY),reopenCount:i%23===0?1:0,
  ...(i%9===0?{verifiedAt:new Date(now-2*DAY)}:{})})));
 await owner.db.insert(schema.hrOrchestrationCase).values(caseRows);
 // The missing-employee-data loop's cases for ~450 employments: open, waiting and closed.
 const runId=randomUUID();
 const loopRows=active.slice(40,490).map((e,i)=>({tenantId:b.tenantId,workerId:'loop_missing_employee_data' as const,companyId:e.companyId,employmentId:e.id,
  subjectKey:`record:${e.id}`,recipient:'employee' as const,state:(i%5===0?'closed':i%3===0?'waiting':'open') as 'open'|'waiting'|'closed',
  ...(i%5===0?{closeReason:'done' as const,resolution:'completed' as const,closedAt:new Date(now-3*DAY)}:{}),
  facts:{gaps:['no_tax_number',...(i%2?['no_socso_number']:[])]},openedAt:new Date(now-((i%40)+1)*DAY),checkedAt:new Date(now-DAY),openedRunId:runId,checkedRunId:runId}));
 for(const part of chunk(loopRows,500))await owner.db.insert(terasLoopCase).values(part);
 await owner.db.insert(terasLoopRun).values(staffed.slice(0,20).map((companyId,i)=>({tenantId:b.tenantId,runId:randomUUID(),workerId:'loop_missing_employee_data' as const,companyId,
  status:'ran' as const,loopVersion:'loop_missing_employee_data@v1',startedAt:new Date(now-(i+1)*3_600_000),finishedAt:new Date(now-(i+1)*3_600_000+5000),checks:[],reads:[]})));
 // A few pending self-service corrections.
 await owner.db.insert(schema.profileChangeRequest).values(active.slice(0,6).map((e,i)=>({tenantId:b.tenantId,personId:e.personId,employmentId:e.id,status:'pending' as const,
  proposed:{taxNumber:`SG${9000000+i}`}})));
 // Payroll exceptions as staging holds them: ten months of processed runs in six companies, ~140 live unresolved
 // verdicts (40 blocking across all ten months, 100 for review), ~600 superseded ones, one finding each, and one
 // standing acknowledgement of a blocking check, so Exceptions reads every month's acknowledged blocks.
 const periods=Array.from({length:10},(_,i)=>`2026-${String(i+1).padStart(2,'0')}`),payrollCompanies=staffed.slice(0,6);
 const batches:{id:string;companyId:string;period:string}[]=[];
 for(const companyId of payrollCompanies)for(const period of periods){
  const [pp]=await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId,period,status:'open'} as never).returning({id:schema.payPeriod.id});
  const [batch]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId,payPeriodId:pp.id,payPeriod:period,batchDate:`${period}-28`,status:'processed',employeeCount:10} as never)
   .returning({id:schema.payrollBatch.id});
  batches.push({id:batch.id,companyId,period});
 }
 const staffOf=new Map<string,string[]>();for(const e of active)(staffOf.get(e.companyId)??staffOf.set(e.companyId,[]).get(e.companyId)!).push(e.id);
 const verdicts=Array.from({length:740},(_,i)=>{const batch=batches[i%batches.length],staff=staffOf.get(batch.companyId)!;
  return {tenantId:b.tenantId,batchId:batch.id,employmentId:staff[i%staff.length],disposition:i<40?'block':i<140?'review':i%3?'review':'block',
   detectorsRun:['missing-bank-profile','net-swing'],detectorsSkipped:[],computedAt:new Date(now-(i%90)*DAY),...(i>=140?{supersededAt:new Date(now-DAY)}:{})};});
 const verdictIds:string[]=[];
 for(const part of chunk(verdicts,500))verdictIds.push(...(await owner.db.insert(schema.payrollAnomalyVerdict).values(part as never).returning({id:schema.payrollAnomalyVerdict.id})).map(r=>r.id));
 for(const part of chunk(verdictIds.map((verdictId,i)=>({tenantId:b.tenantId,verdictId,detectorId:i<40||(i>=140&&i%3===0)?'missing-bank-profile':'net-swing',
  severity:i<40||(i>=140&&i%3===0)?'block':'review',facts:{},sourceEventIds:[],suggestedAction:'anomaly.action.missingBankProfile'})),500))
  await owner.db.insert(schema.payrollAnomalyFinding).values(part as never);
 await owner.db.insert(payrollCheckAcknowledgement).values({tenantId:b.tenantId,companyId:payrollCompanies[0],checkId:'anomaly:missing-bank-profile',scope:'company',
  reason:'Fictional: paid by cheque this year',createdByUserId:b.adminUserId});
 // The domain-event history: orchestrator receipts among ~30k unrelated events (payroll, feedback, hires, holidays).
 const kinds=[['payroll','payroll.anomaly.flagged'],['feedback','feedback.release.recorded'],['payroll','payroll.anomaly.evaluated'],['holiday','holiday.replacement.reconciled'],
  ['feedback','feedback.plan.drafted'],['employment','employment.hired'],['employee','employee.tax-scheme.selected']] as const;
 const events=Array.from({length:eventCount},(_,i)=>{const [aggregateType,eventType]=kinds[i%kinds.length],subject=aggregateType==='employment'||aggregateType==='employee'?employments[i%employments.length].id:null;
  return {tenantId:b.tenantId,aggregateType,aggregateId:subject??randomUUID(),eventType,actorType:'system' as const,subjectEmploymentId:subject,payload:{n:i},occurredAt:new Date(now-(eventCount-i)*60_000)};});
 for(let i=0;i<33;i++)events.push({tenantId:b.tenantId,aggregateType:'hr_orchestrator',aggregateId:b.tenantId,eventType:'orchestrator.readiness-checked',actorType:'system' as const,
  subjectEmploymentId:null,payload:{scheduled:false,scopeDigest:'fictional-other-scope'} as never,occurredAt:new Date(now-(33-i)*3*3_600_000)});
 for(const part of chunk(events,2000))await owner.db.insert(schema.domainEvent).values(part as never);
 await owner.db.execute(sql`analyze public.employment, public.person, public.company, public.employee_statutory_my, public.compensation, public.hr_orchestration_case,
  public.teras_loop_case, public.domain_event, public.payroll_batch, public.payroll_anomaly_verdict, public.payroll_anomaly_finding`);
 // Personas, each with their own person and employment in the group company.
 const persona=async(name:string,grants:{role:string;companyId:string|null}[]):Promise<SessionContext>=>{
  const [p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:name,primaryEmail:`${randomUUID()}@fixture.test`}).returning({id:schema.person.id});
  await owner.db.insert(schema.employment).values({tenantId:b.tenantId,personId:p.id,companyId:b.companyId,employeeCode:`FX-${name.slice(-4)}`,hiredOn:'2020-01-01'});
  const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId:p.id}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values(grants.map(g=>({tenantId:b.tenantId,appUserId:u.id,companyId:g.companyId,role:g.role as 'hr_admin'})));
  const base=await entitledCtx(b,['hr_admin']);
  return {...base,userId:u.id,personId:p.id,roles:['hr_admin'],grants};
 };
 const singleCompanyId=operating[3].id;
 const personas={group:await persona('Fictional Group Administrator GRP1',[{role:'hr_admin',companyId:null}]),
  multi:await persona('Fictional Multi Company Administrator MLT1',companyIds.map(companyId=>({role:'hr_admin',companyId}))),
  single:await persona('Fictional Single Company Administrator SGL1',[{role:'hr_admin',companyId:singleCompanyId}])};
 return Object.freeze({companyIds,operatingCompanyIds:operating.map(o=>o.id),employmentIds:employments.map(e=>e.id),activeEmploymentIds:active.map(e=>e.id),personas,singleCompanyId});
}

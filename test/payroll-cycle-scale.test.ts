/** Payroll cycle page at group scale (staging, 11 Nov 2026: the page "loads super long" and never opens).
 *
 * AI Centre › Operations › Loops › Payroll cycle reads the group pipeline (core/loops/payroll-cycle-views.ts
 * payrollCycleOverview) and the Audit loop's column (core/payroll-audit/status.ts auditLoopSummary) for every company the
 * viewer administers. On staging a group administrator administers 71 companies. The Audit loop's read sent about fifteen
 * statements per company, one company after another, in one transaction (three of them scan the tenant's audit log), and
 * the pipeline's history opened a nested transaction per processed run while its own held a pooled connection. Each open
 * of the page ran for many minutes; repeated opens filled the two-CPU database host and the pooled server connections.
 *
 * Pinned here on fictional data:
 *  - the reads send the same statements and transactions for a group of 3 companies as for one of 30, and never hold two
 *    transactions open at once;
 *  - a 72-company group with a staging-sized audit log (36,000 events) reads within the page's two-second budget;
 *  - the values, written out from the fixture: each company's Audit status (runs, payslips released and opened, statutory
 *    files, findings open, carried, disposed and acknowledged, repeat issues, captures, settings), the history's issues
 *    caught (live anomaly verdicts to review or block) and the Audit loop page's findings and acknowledgements. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {payrollAuditDisposition,payrollAuditFinding} from '../db/payroll-audit-schema';
import {payrollCheckAcknowledgement} from '../db/teras-payroll-cycle-schema';
import {client,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {closeBatch,createBatch,generatePayslips} from '../core/payroll';
import {payrollCycleOverview} from '../core/loops/payroll-cycle-views';
import {auditLoopDetail} from '../core/payroll-audit/status';
import {PAYROLL_ACCESS_EVENT,PAYSLIP_OPENED_EVENT} from '../core/payroll-audit/types';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const PERIOD='2026-01',PREVIOUS='2025-12',TODAY='2026-01-20';
let b:Base;
let hr:SessionContext;
let paid:string,second:string;
const ids={carried:'',current:'',acknowledged:'',disposed:''};

type Trace={statements:number;begins:number;maxOpen:number};
/** Every statement the application's pool sends while `run` runs, and the most transactions open at once. */
async function traced<T>(run:()=>Promise<T>):Promise<{value:T;trace:Trace;ms:number}>{
 const options=client.options as {debug?:unknown};
 const previous=options.debug;
 const trace:Trace={statements:0,begins:0,maxOpen:0};
 let open=0;
 options.debug=(_connection:number,text:string)=>{
  const statement=text.trim().toLowerCase();
  trace.statements++;
  if(statement.startsWith('begin')){trace.begins++;open++;trace.maxOpen=Math.max(trace.maxOpen,open);}
  else if(statement==='commit'||statement==='rollback')open--;
 };
 const started=performance.now();
 try{const value=await run();return {value,trace,ms:performance.now()-started};}
 finally{options.debug=previous;}
}

let added=0;
async function addCompanies(count:number){
 const rows=Array.from({length:count},()=>({tenantId:b.tenantId,legalName:`Fictional Scale ${String(added++).padStart(3,'0')} Sdn Bhd`}));
 if(rows.length)await owner.db.insert(schema.company).values(rows);
}
const read=()=>payrollCycleOverview(hr,{period:PERIOD,today:TODAY});
async function finding(companyId:string,payPeriod:string,controlId:'shared_bank_account'|'preparer_closed_run',employmentId:string|null){
 const [row]=await owner.db.insert(payrollAuditFinding).values({tenantId:b.tenantId,companyId,payPeriod,controlId,employmentId,subjectKey:`fixture:${randomUUID()}`,
  evidence:{fixture:true},evidenceHash:'f'.repeat(64),detectedAt:new Date(`${payPeriod}-15T02:00:00Z`),writer:'user',writerId:b.adminUserId}).returning({id:payrollAuditFinding.id});
 return row!.id;
}

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 await setModule(b.tenantId,'payroll','active');
 hr={...await entitledCtx(b),roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 paid=b.companyId;
 // The paid company: two people, a December and a January run, each processed and closed.
 const people:{employmentId:string;personId:string}[]=[];
 for(const [i,salary] of [5000,4000].entries()){
  const hired=await hireEmployee(hr,{person:{fullName:`Scale Fictional ${i}`,primaryEmail:`${randomUUID()}@fixture.test`},companyId:paid,departmentId:b.deptA,
   employmentType:'full_time',hiredOn:'2025-01-01'});
  await setCompensation(hr,{employmentId:hired.employmentId,basicSalary:salary,effectiveFrom:'2025-01-01'});
  await setStatutoryProfileMY(hr,{personId:hired.personId,icNumber:`9001010155${60+i}`,taxCategory:1,numChildren:0});
  people.push(hired);
 }
 const batches:Record<string,string>={};
 for(const period of [PREVIOUS,PERIOD]){
  const {batchId}=await createBatch(hr,{companyId:paid,payPeriod:period});
  await generatePayslips(hr,{batchId});
  await closeBatch(hr,{batchId});
  batches[period]=batchId;
 }
 // December's anomaly verdicts: one live to review (an issue caught), one superseded block and one live auto-clear (neither).
 await owner.db.delete(schema.payrollAnomalyVerdict).where(sql`${schema.payrollAnomalyVerdict.batchId}=${batches[PREVIOUS]}::uuid`);
 await owner.db.insert(schema.payrollAnomalyVerdict).values([
  {tenantId:b.tenantId,batchId:batches[PREVIOUS]!,employmentId:people[0]!.employmentId,disposition:'review'},
  {tenantId:b.tenantId,batchId:batches[PREVIOUS]!,employmentId:people[1]!.employmentId,disposition:'block',supersededAt:new Date('2026-01-02T00:00:00Z')},
  {tenantId:b.tenantId,batchId:batches[PREVIOUS]!,employmentId:people[1]!.employmentId,disposition:'auto_clear'},
 ]);
 // The tenant's audit log at staging's size (36,348 events on 11 Nov 2026), of event types the Audit loop does not read,
 // plus January's one payslip opened and one EPF file exported for the paid company.
 await owner.db.execute(sql`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,subject_employment_id,payload,occurred_at)
  select ${b.tenantId}::uuid,'fixture',gen_random_uuid(),(array['payroll.anomaly.flagged','feedback.release.recorded','payroll.anomaly.evaluated','holiday.replacement.reconciled',
   'employment.hired','app-user.logged-in'])[1+i%6],'system',case when i%3=0 then ${people[0]!.employmentId}::uuid end,
   jsonb_build_object('companyId',${paid}::text,'payPeriod',${PERIOD}::text,'n',i),now()-make_interval(mins=>i) from generate_series(1,36000) i`);
 await owner.db.execute(sql`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,subject_employment_id,payload,occurred_at) values
  (${b.tenantId}::uuid,'payslip',gen_random_uuid(),${PAYSLIP_OPENED_EVENT},'user',${people[1]!.employmentId}::uuid,jsonb_build_object('companyId',${paid}::text,'payPeriod',${PERIOD}::text),
   '2026-01-28T03:00:00Z'),
  (${b.tenantId}::uuid,'payroll-access',gen_random_uuid(),${PAYROLL_ACCESS_EVENT},'user',null,jsonb_build_object('companyId',${paid}::text,'payPeriod',${PERIOD}::text,
   'surface','statutory_file','detail','my.epf'),'2026-02-03T02:00:00Z')`);
 // Findings. The paid company: January's shared account (open), December's shared account not disposed of (carried into
 // January, open) and December's other one disposed of (not carried). A second company: January's preparer-and-closer
 // finding, covered by a standing company-wide acknowledgement of that check.
 ids.current=await finding(paid,PERIOD,'shared_bank_account',people[0]!.employmentId);
 ids.carried=await finding(paid,PREVIOUS,'shared_bank_account',people[1]!.employmentId);
 ids.disposed=await finding(paid,PREVIOUS,'shared_bank_account',people[0]!.employmentId);
 await owner.db.insert(payrollAuditDisposition).values({tenantId:b.tenantId,findingId:ids.disposed,companyId:paid,disposition:'expected',note:'Fixture: a joint account.',
  disposedByUserId:b.adminUserId});
 const [co]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Second Sdn Bhd'}).returning({id:schema.company.id});
 second=co!.id;
 ids.acknowledged=await finding(second,PERIOD,'preparer_closed_run',null);
 await owner.db.insert(payrollCheckAcknowledgement).values({tenantId:b.tenantId,companyId:second,checkId:'audit:preparer_closed_run',scope:'company',
  reason:'Fixture: one payroll officer.',createdByUserId:b.adminUserId});
},180_000);
afterAll(closeAll);

describe('payroll cycle page reads at group scale', ()=>{
 it('sends the same statements for 3 companies as for 30, one transaction at a time', async()=>{
  await addCompanies(1);
  const small=await traced(read);
  expect(small.value.companies).toHaveLength(3);
  await addCompanies(27);
  const large=await traced(read);
  expect(large.value.companies).toHaveLength(30);
  expect(small.trace.statements).toBeGreaterThan(0);
  expect(large.trace.statements).toBe(small.trace.statements);
  expect(large.trace.begins).toBe(small.trace.begins);
  expect(small.trace.maxOpen).toBe(1);
  expect(large.trace.maxOpen).toBe(1);
  // The Audit loop's own page reads the same way.
  const detail=await traced(()=>auditLoopDetail(hr,{payPeriod:PERIOD}));
  await addCompanies(5);
  const wider=await traced(()=>auditLoopDetail(hr,{payPeriod:PERIOD}));
  expect(wider.value.companies).toHaveLength(35);
  expect(wider.trace.statements).toBe(detail.trace.statements);
  expect(wider.trace.maxOpen).toBe(1);
 },120_000);

 it('keeps every value: Audit status per company, issues caught and the Audit loop page', async()=>{
  const view=await read();
  expect(view.history.map(row=>[row.period,row.issuesCaught,row.runs,row.allClosed])).toEqual([[PREVIOUS,1,1,true],['2025-11',null,0,false],['2025-10',null,0,false]]);
  const byId=new Map(view.audit!.companies.map(c=>[c.companyId,c]));
  const p=byId.get(paid)!;
  expect(p.runs.map(run=>[run.runType,run.runSeq,run.status,run.releasedAt!==null])).toEqual([['regular',1,'closed',true]]);
  expect(p.payslips).toEqual({total:2,released:2,opened:1});
  expect(p.statutory.map(f=>[f.form,f.required,f.prepared,f.preparedOn,f.filed])).toEqual([
   ['epf',true,true,'2026-02-03',false],['socso_eis',true,false,null,false],['pcb_cp39',true,false,null,false],['hrd',false,false,null,false]]);
  expect(p.bank).toEqual({files:0,byBank:[]});
  expect(p.corrections).toEqual({count:0,withoutRootCause:0});
  expect(p.findings).toEqual({open:2,disposed:0,acknowledged:0});
  expect(p.repeatIssues).toEqual(['shared_bank_account']);
  expect(p.captures.count).toBe(1);
  expect(p.captures.head).toMatch(/^[0-9a-f]{64}$/);
  expect(p.settings).toEqual({bankChangeDays:7,adjustmentThreshold:1000,preparerClosedMode:'info',version:null});
  expect(p.done).toBe(false);
  const s=byId.get(second)!;
  expect(s.findings).toEqual({open:0,disposed:0,acknowledged:1});
  expect(s.repeatIssues).toEqual([]);
  expect(s.runs).toEqual([]);
  expect(s.payslips).toEqual({total:0,released:0,opened:0});
  // A company with nothing this month.
  const bare=view.audit!.companies.find(c=>c.companyName.startsWith('Fictional Scale'))!;
  expect(bare.statutory.map(f=>[f.form,f.required,f.prepared])).toEqual([['epf',true,false],['socso_eis',true,false],['pcb_cp39',false,false],['hrd',false,false]]);
  expect(bare.findings).toEqual({open:0,disposed:0,acknowledged:0});
  expect(bare.captures).toEqual({count:0,lastAt:null,head:null});
  expect(view.audit!.totals.openFindings).toBe(2);
  expect(view.audit!.totals.payslips).toBe(2);
  // The Audit loop page: January's own findings and December's carried one, each with its acknowledgement.
  const detail=await auditLoopDetail(hr,{payPeriod:PERIOD});
  expect(detail.findings.map(f=>f.id).sort()).toEqual([ids.acknowledged,ids.carried,ids.current].sort());
  expect(detail.findings.find(f=>f.id===ids.acknowledged)!.acknowledgement).toMatchObject({scope:'company',reason:'Fixture: one payroll officer.'});
  expect(detail.findings.filter(f=>f.id!==ids.acknowledged).map(f=>f.acknowledgement)).toEqual([null,null]);
  expect(detail.corrections).toEqual([]);
 },120_000);

 it('reads a 72-company group with a staging-sized audit log within the page budget', async()=>{
  await addCompanies(72-35);
  await read();
  const timed=await traced(read);
  expect(timed.value.companies).toHaveLength(72);
  expect(timed.value.audit!.companies).toHaveLength(72);
  expect(timed.ms).toBeLessThan(2_000);
 },120_000);
});

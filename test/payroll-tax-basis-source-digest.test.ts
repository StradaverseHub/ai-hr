/** Migration 7170: the locked recalculation opening reads its source-row digest through
 * app.payroll_tax_basis_source_digest instead of under the reader's row security, which on production held the
 * payroll-history and Access locks for 18-37 s per company (the payslip policy stack ran once per tax-basis revision).
 * The function must return exactly the digest the row-security query returned for an authorized recalculation reader,
 * including while a history replacement is staged (its rows hidden), and must refuse anyone else. */
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {requestPayrollHistoryConfirm,payrollHistoryJobHandler} from '../core/payroll-history-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {previewTaxBasisRecalculation,confirmTaxBasisRecalculation,continueTaxBasisBatch,getTaxBasisBatch} from '../core/payroll-tax-basis';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
vi.hoisted(()=>{vi.stubEnv('AIHR_DB_PROCESS_ROLE','worker');vi.stubEnv('AIHR_DB_POOL_MAX','2');});
beforeAll(()=>vi.unstubAllEnvs());
afterAll(closeAll);

const EMPLOYEES=Number(process.env.AIHR_TAX_BASIS_DIGEST_EMPLOYEES??60),MONTHS=9;
/** The row-security query 7170 replaced (core/payroll-tax-basis.ts before 24 November 2026), verbatim. */
const rowSecurityDigest=(companyId:string,year:number)=>{const like=year+'-%';return sql`select md5(coalesce(string_agg(x,',' order by x),'')) as d from (
   select 'p:'||p.id||':'||p.xmin||':'||b.id||':'||b.xmin as x from payslip p join payroll_batch b on b.id=p.batch_id where b.company_id=${companyId}::uuid and b.pay_period like ${like}
   union all select 'r:'||r.id||':'||r.xmin from payroll_tax_basis_revision r where r.company_id=${companyId}::uuid and r.period like ${like}
   union all select 's:'||s.id from payroll_history_import_snapshot s join payroll_history_import_record h on h.id=s.record_id where h.company_id=${companyId}::uuid and h.period like ${like}
   union all select 'v:'||v.id from payroll_history_import_revision v join payroll_history_import_record h on h.id=v.record_id where h.company_id=${companyId}::uuid and h.period like ${like}) q`;};
const definerDigest=(companyId:string,year:number)=>sql`select app.payroll_tax_basis_source_digest(${companyId}::uuid,${year}::integer) as d`;

async function timed(ctx:SessionContext,query:ReturnType<typeof sql>){
 const started=performance.now();const [row]=await withTenant(ctx,tx=>tx.execute<{d:string}>(query));
 return {d:row.d,ms:Math.round(performance.now()-started)};
}
/** The database refusal under the driver's "Failed query" wrapper. */
async function refusal(work:Promise<unknown>){
 try{await work;}catch(error){const cause=(error as {cause?:{code?:string;message?:string}}).cause;return {code:cause?.code,message:cause?.message};}
 throw new Error('Expected a refusal');
}
async function both(ctx:SessionContext,companyId:string,year=2026){
 const before=await timed(ctx,rowSecurityDigest(companyId,year)),after=await timed(ctx,definerDigest(companyId,year));
 return {rowSecurity:before,definer:after};
}

describe('app.payroll_tax_basis_source_digest',()=>{
 let b:Base,ctx:SessionContext,codes:string[]=[];
 const lines=(amount:string,subset=codes)=>subset.flatMap(code=>Array.from({length:MONTHS},(_,m)=>`2026-${String(m+1).padStart(2,'0')}`).flatMap(period=>[
  [code,period,'ME','BASIC','TAXCO','5000'],[code,period,'ME','TRV','TAXCO',amount],[code,period,'ME','EEEPF','TAXCO','0'],
  [code,period,'ME','EESOCSO','TAXCO','0'],[code,period,'ME','EEEIS','TAXCO','0'],[code,period,'ME','PCB','TAXCO','0']]));
 const csv=(rows:string[][])=>Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows]));

 it('returns the row-security digest at scale, while a replacement is staged and after it commits, and refuses others',async()=>{
  await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');ctx=await entitledCtx(b);
  await owner.db.update(schema.company).set({companyLabel:'TAXCO'}).where(eq(schema.company.id,b.companyId));await seedPayrollCycleCatalog(ctx,b.companyId);
  const [travel]=await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'TRV',name:'Travel allowance',kind:'allowance',displayCategory:'allowance',includedInPcb:false,pcbRemunerationType:'normal',pcbExemptionCode:'PCB_TAXABLE'}).returning({id:schema.payComponent.id});
  codes=[];for(let i=0;i<EMPLOYEES;i++){const code=String(1000+i);codes.push(code);
   await hireEmployee(ctx,{person:{fullName:`Fictional Digest ${i}`,primaryEmail:`digest${i}@example.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:code,hiredOn:'2025-01-01'});}
  // Empty company-year: both read nothing.
  const empty=await both(ctx,b.companyId);expect(empty.definer.d).toBe(empty.rowSecurity.d);
  const draft=await previewPayrollHistoryUpload(ctx,{name:'digest.csv',operationKey:randomUUID(),content:csv(lines('500'))});
  expect(draft.plan.counts.invalid).toBe(0);
  await confirmPayrollHistoryUpload(ctx,{attemptId:draft.attemptId,previewHash:draft.plan.previewHash,confirmReplacement:true});
  await owner.db.update(schema.payComponent).set({includedInPcb:true}).where(eq(schema.payComponent.id,travel.id));
  const preview=await previewTaxBasisRecalculation(ctx,{companyId:b.companyId,year:2026,upToMonth:MONTHS,employmentIds:null});
  expect(preview.eligibleCount).toBe(EMPLOYEES);
  const opened=await confirmTaxBasisRecalculation(ctx,{previewId:preview.previewId,previewHash:preview.previewHash});
  for(let i=0;i<500&&(await getTaxBasisBatch(ctx,opened.id))?.status!=='completed';i++)await continueTaxBasisBatch(ctx,opened.id);
  expect((await getTaxBasisBatch(ctx,opened.id))?.status).toBe('completed');

  const [counts]=await owner.client<{payslips:number;revisions:number;snapshots:number}[]>`select
   (select count(*)::int from payslip p join payroll_batch b on b.id=p.batch_id where b.company_id=${b.companyId}::uuid) as payslips,
   (select count(*)::int from payroll_tax_basis_revision where company_id=${b.companyId}::uuid) as revisions,
   (select count(*)::int from payroll_history_import_snapshot s join payroll_history_import_record h on h.id=s.record_id where h.company_id=${b.companyId}::uuid) as snapshots`;
  expect(counts.payslips).toBe(EMPLOYEES*MONTHS);expect(counts.revisions).toBeGreaterThanOrEqual(EMPLOYEES*MONTHS);expect(counts.snapshots).toBeGreaterThanOrEqual(EMPLOYEES*MONTHS);
  const settled=await both(ctx,b.companyId);
  console.error(`tax-basis source digest ${JSON.stringify({counts,rowSecurityMs:settled.rowSecurity.ms,definerMs:settled.definer.ms})}`);
  expect(settled.definer.d).toBe(settled.rowSecurity.d);expect(settled.definer.d).not.toBe(empty.definer.d);
  // Another year reads nothing in both.
  const otherYear=await both(ctx,b.companyId,2025);expect(otherYear.definer.d).toBe(otherYear.rowSecurity.d);expect(otherYear.definer.d).toBe(empty.definer.d);

  // A replacement for some employees, staged by its background job and hidden from everyone else until it commits.
  const replacement=await previewPayrollHistoryUpload(ctx,{name:'replacement.csv',operationKey:randomUUID(),content:csv(lines('650',codes.slice(0,5)))});
  const request=await requestPayrollHistoryConfirm(ctx,{attemptId:replacement.attemptId,previewHash:replacement.plan.previewHash,confirmReplacement:true,acknowledgeWarnings:true});
  if(!('jobId' in request))throw new Error('Expected a staged history job');
  let staged=0;
  for(let tick=0;tick<100&&!staged;tick++){await runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});
   [{n:staged}]=await owner.client<{n:number}[]>`select count(*)::int as n from app.payroll_history_staged_row where stage_id=${request.jobId}::uuid`;}
  expect(staged).toBeGreaterThan(0);
  const whileStaged=await both(ctx,b.companyId);
  expect(whileStaged.definer.d).toBe(whileStaged.rowSecurity.d);expect(whileStaged.definer.d).toBe(settled.definer.d);
  let state='';
  for(let tick=0;tick<300&&state!=='completed';tick++){await runBulkJobTick(owner.client,{handlers:[payrollHistoryJobHandler]});
   [{state}]=await owner.client<{state:string}[]>`select state from bulk_job where id=${request.jobId}::uuid`;if(state==='failed')throw new Error('History job failed');}
  expect(state).toBe('completed');
  const committed=await both(ctx,b.companyId);
  expect(committed.definer.d).toBe(committed.rowSecurity.d);expect(committed.definer.d).not.toBe(settled.definer.d);

  // Refusals: an unknown company, and a signed-in employee without payroll administration.
  expect(await refusal(withTenant(ctx,tx=>tx.execute(definerDigest(randomUUID(),2026))))).toEqual({code:'42501',message:'Income-tax recalculation access is unavailable for this company.'});
  const employeeUser=await createAppUser(b.tenantId,null,'employee');
  const employeeCtx:SessionContext={...ctx,userId:employeeUser,roles:['employee']};
  expect(await refusal(withTenant(employeeCtx,tx=>tx.execute(definerDigest(b.companyId,2026))))).toEqual({code:'42501',message:'Income-tax recalculation access is unavailable for this company.'});
 },1_100_000);
});

/** Diagnostic (24 Nov 2026): profile the locked tax-basis opening's source-row digest under the reader's row security
 * on a fictional company shaped like production (about 1,400 payslips, history records and revisions in one year).
 * Production: the digest took 18–37 s under row security and 20 ms without it. */
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {previewTaxBasisRecalculation,confirmTaxBasisRecalculation,continueTaxBasisBatch,getTaxBasisBatch} from '../core/payroll-tax-basis';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
vi.hoisted(()=>{vi.stubEnv('AIHR_DB_PROCESS_ROLE','worker');vi.stubEnv('AIHR_DB_POOL_MAX','2');});
beforeAll(()=>vi.unstubAllEnvs());
afterAll(closeAll);

const EMPLOYEES=Number(process.env.AIHR_TAX_BASIS_PROFILE_EMPLOYEES??150),MONTHS=9;
const digestSql=(companyId:string)=>sql`select md5(coalesce(string_agg(x,',' order by x),'')) as d from (
   select 'p:'||p.id||':'||p.xmin||':'||b.id||':'||b.xmin as x from payslip p join payroll_batch b on b.id=p.batch_id where b.company_id=${companyId}::uuid and b.pay_period like '2026-%'
   union all select 'r:'||r.id||':'||r.xmin from payroll_tax_basis_revision r where r.company_id=${companyId}::uuid and r.period like '2026-%'
   union all select 's:'||s.id from payroll_history_import_snapshot s join payroll_history_import_record h on h.id=s.record_id where h.company_id=${companyId}::uuid and h.period like '2026-%'
   union all select 'v:'||v.id from payroll_history_import_revision v join payroll_history_import_record h on h.id=v.record_id where h.company_id=${companyId}::uuid and h.period like '2026-%') q`;
const branches=(companyId:string)=>({
 payslips:sql`select count(*)::int n from payslip p join payroll_batch b on b.id=p.batch_id where b.company_id=${companyId}::uuid and b.pay_period like '2026-%'`,
 taxBasisRevisions:sql`select count(*)::int n from payroll_tax_basis_revision r where r.company_id=${companyId}::uuid and r.period like '2026-%'`,
 snapshots:sql`select count(*)::int n from payroll_history_import_snapshot s join payroll_history_import_record h on h.id=s.record_id where h.company_id=${companyId}::uuid and h.period like '2026-%'`,
 historyRevisions:sql`select count(*)::int n from payroll_history_import_revision v join payroll_history_import_record h on h.id=v.record_id where h.company_id=${companyId}::uuid and h.period like '2026-%'`,
});

describe('tax-basis opening digest profile',()=>{
 it('reports where the row-security time goes',async()=>{
  const b:Base=await (async()=>{await resetDb();return seedBase();})();
  await setModule(b.tenantId,'payroll','active');const ctx:SessionContext=await entitledCtx(b);
  await owner.db.update(schema.company).set({companyLabel:'TAXCO'}).where(eq(schema.company.id,b.companyId));await seedPayrollCycleCatalog(ctx,b.companyId);
  const [travel]=await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'TRV',name:'Travel allowance',kind:'allowance',displayCategory:'allowance',includedInPcb:false,pcbRemunerationType:'normal',pcbExemptionCode:'PCB_TAXABLE'}).returning({id:schema.payComponent.id});
  const codes:string[]=[];
  for(let i=0;i<EMPLOYEES;i++){
   const code=String(1000+i);codes.push(code);
   await hireEmployee(ctx,{person:{fullName:`Fictional Profile ${i}`,primaryEmail:`profile${i}@example.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:code,hiredOn:'2025-01-01'});
  }
  const lines=codes.flatMap(code=>Array.from({length:MONTHS},(_,m)=>`2026-${String(m+1).padStart(2,'0')}`).flatMap(period=>[
   [code,period,'ME','BASIC','TAXCO','5000'],[code,period,'ME','TRV','TAXCO','500'],[code,period,'ME','EEEPF','TAXCO','0'],
   [code,period,'ME','EESOCSO','TAXCO','0'],[code,period,'ME','EEEIS','TAXCO','0'],[code,period,'ME','PCB','TAXCO','0']]));
  const draft=await previewPayrollHistoryUpload(ctx,{name:'profile.csv',operationKey:randomUUID(),content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...lines]))});
  expect(draft.plan.counts.invalid).toBe(0);
  await confirmPayrollHistoryUpload(ctx,{attemptId:draft.attemptId,previewHash:draft.plan.previewHash,confirmReplacement:true});
  await owner.db.update(schema.payComponent).set({includedInPcb:true}).where(eq(schema.payComponent.id,travel.id));
  const preview=await previewTaxBasisRecalculation(ctx,{companyId:b.companyId,year:2026,upToMonth:MONTHS,employmentIds:null});
  expect(preview.eligibleCount).toBe(EMPLOYEES);
  const opened=await confirmTaxBasisRecalculation(ctx,{previewId:preview.previewId,previewHash:preview.previewHash});
  for(let i=0;i<200&&(await getTaxBasisBatch(ctx,opened.id))?.status!=='completed';i++)await continueTaxBasisBatch(ctx,opened.id);

  const counts:Record<string,number>={};
  for(const [name,query] of Object.entries(branches(b.companyId)))counts[name]=(await owner.db.execute<{n:number}>(query))[0].n;
  console.error(`PROFILE counts ${JSON.stringify(counts)}`);
  const timed:Record<string,number>={};
  for(const [name,query] of Object.entries(branches(b.companyId))){
   const started=performance.now();await withTenant(ctx,tx=>tx.execute(query));timed[name]=Math.round(performance.now()-started);
  }
  const started=performance.now();await withTenant(ctx,tx=>tx.execute(digestSql(b.companyId)));timed.digest=Math.round(performance.now()-started);
  const ownerStarted=performance.now();await owner.db.execute(digestSql(b.companyId));timed.digestOwner=Math.round(performance.now()-ownerStarted);
  console.error(`PROFILE ms ${JSON.stringify(timed)}`);
  const plan=await withTenant(ctx,tx=>tx.execute<{'QUERY PLAN':string}>(sql`explain (analyze, buffers, verbose) ${digestSql(b.companyId)}`));
  console.error('PROFILE plan\n'+plan.map(row=>row['QUERY PLAN']).join('\n'));
 },1_100_000);
});

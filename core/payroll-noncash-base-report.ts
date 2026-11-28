/**
 * Board d9ded29c — PRE-RELEASE AFFECTED-EMPLOYEE REPORT (report-first, ADR-0167: "Any existing-data correction remains
 * report-first and separately authorized").
 *
 * Before this change, a month read through a saved Income Tax Correction revision or an accepted imported-history
 * projection gave later payroll a PCB base of cash only: its taxable BIK/VOLA, saved beside the base in `pcbNonCash`,
 * never reached the year-to-date Y. The read-time correction in core/payroll-tax-basis-read.ts (and migration 7590 for the
 * group-company opening) now counts them. Payroll that runs after the release therefore deducts more PCB for the people
 * listed here, catching up through the normal monthly formula. This report lists them so payroll can warn them first.
 *
 * WHAT IT READS. Per tenant, in one READ ONLY transaction: the effective payslips of the assessment year (processed or
 * closed runs, under the payroll history barrier), and for each the basis later payroll reads instead of a native stamp
 * (the latest Income Tax Correction revision not superseded by a reprocess replacement; otherwise a ready imported
 * projection that still matches its saved base). A month is listed when that basis owns taxable BIK or VOLA: that owned
 * amount is exactly what the old read left out of Y. Group-company months are these same rows at the person's other
 * company; the report names the company that owns the month.
 *
 * WHAT IT PRINTS. Company, employee code, months, and the missing taxable BIK and VOLA amounts, plus whether the person
 * has a processed payroll after the first affected month in the same year (the run that under-deducted). No name, IC,
 * address, salary, tax number or any other payslip figure. Read only; it writes nothing and changes no payslip,
 * revision, import or setting. One statement per tenant (an operator script, not a request path).
 */
import type postgres from 'postgres';

export type NoncashBaseGapRow={tenantId:string;companyId:string;companyName:string;employmentId:string;employeeCode:string|null;
 period:string;source:'reviewed'|'imported';bik:number;vola:number;laterPayroll:boolean};
export type NoncashBaseGapEmployee={tenantId:string;companyId:string;companyName:string;employmentId:string;employeeCode:string|null;
 periods:string[];sources:('reviewed'|'imported')[];bik:number;vola:number;missing:number;laterPayroll:boolean};
export type NoncashBaseGapCompany={tenantId:string;companyId:string;companyName:string;employees:number;months:number;bik:number;vola:number;missing:number};

const round=(n:number)=>Math.round(n*100)/100;
const num=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?round(n):0;};

/** The affected months of one tenant and assessment year. Caller supplies an OWNER transaction that is READ ONLY; the
 * tenant context is set transaction-locally so the canonical history-barrier function answers for that tenant. */
export async function noncashBaseGapRowsTx(tx:postgres.TransactionSql,tenantId:string,year:number):Promise<NoncashBaseGapRow[]>{
 if(!/^[0-9a-f-]{36}$/i.test(tenantId)||!Number.isInteger(year)||year<2000||year>2999)throw new Error('A tenant id and an assessment year are required.');
 const [mode]=await tx<{readOnly:string}[]>`select current_setting('transaction_read_only') as "readOnly"`;
 if(mode?.readOnly!=='on')throw new Error('The affected-employee report runs only in a READ ONLY transaction.');
 await tx`select set_config('app.tenant_id',${tenantId},true)`;
 const rows=await tx<{companyId:string;companyName:string;employmentId:string;employeeCode:string|null;period:string;source:'reviewed'|'imported';bik:string;vola:string;laterPayroll:boolean}[]>`
  with slip as materialized(
   select p.id,p.employment_id,b.company_id,b.pay_period,p.statutory from public.payslip p
   join public.payroll_batch b on b.id=p.batch_id and b.tenant_id=p.tenant_id
   where p.tenant_id=${tenantId}::uuid and b.pay_period like ${String(year)+'-%'} and b.status in ('processed','closed')
  ),effective as materialized(
   select s.* from slip s where s.id in(select e.id from app.payroll_history_effective_ids(array(select s2.id from slip s2)) e(id))
  ),revision as materialized(
   select distinct on(r.payslip_id) r.id,r.payslip_id,r.basis from public.payroll_tax_basis_revision r
   where r.tenant_id=${tenantId}::uuid and r.payslip_id in(select id from effective) order by r.payslip_id,r.ordinal desc
  ),based as(
   select e.*,case
     when rv.id is not null and not exists(select 1 from public.payroll_tax_basis_replacement x where x.tenant_id=${tenantId}::uuid and x.correction_id=rv.id) then 'reviewed'
     when rv.id is null and e.statutory->'importedTaxBasis'->>'state'='ready' and jsonb_typeof(e.statutory->'importedTaxBasis'->'basis'->'pcb')='number'
      and e.statutory->'bases'->'pcb'=e.statutory->'importedTaxBasis'->'basis'->'pcb' then 'imported' end as source,
    case when rv.id is not null then rv.basis else e.statutory->'importedTaxBasis'->'basis' end as basis
   from effective e left join revision rv on rv.payslip_id=e.id
  ),gap as(
   select b.company_id,b.employment_id,b.pay_period,b.source,
    case when jsonb_typeof(b.basis->'pcbNonCash'->'owned'->'bik')='number' then (b.basis->'pcbNonCash'->'owned'->>'bik')::numeric else 0 end as bik,
    case when jsonb_typeof(b.basis->'pcbNonCash'->'owned'->'vola')='number' then (b.basis->'pcbNonCash'->'owned'->>'vola')::numeric else 0 end as vola
   from based b where b.source is not null and coalesce(b.basis->>'version','')='1'
  )
  select g.company_id::text as "companyId",co.legal_name as "companyName",g.employment_id::text as "employmentId",em.employee_code as "employeeCode",
   g.pay_period as period,g.source,round(sum(g.bik),2)::text as bik,round(sum(g.vola),2)::text as vola,
   exists(select 1 from public.payslip lp join public.payroll_batch lb on lb.id=lp.batch_id and lb.tenant_id=lp.tenant_id
    join public.employment le on le.id=lp.employment_id and le.tenant_id=lp.tenant_id
    where lp.tenant_id=${tenantId}::uuid and le.person_id=em.person_id and lb.pay_period>g.pay_period and lb.pay_period like ${String(year)+'-%'}
     and lb.status in ('processed','closed') and lb.history_import_attempt_id is null) as "laterPayroll"
  from gap g join public.company co on co.id=g.company_id and co.tenant_id=${tenantId}::uuid
  join public.employment em on em.id=g.employment_id and em.tenant_id=${tenantId}::uuid
  where g.bik+g.vola>0
  group by g.company_id,co.legal_name,g.employment_id,em.employee_code,em.person_id,g.pay_period,g.source
  order by co.legal_name,em.employee_code nulls last,g.employment_id,g.pay_period`;
 return rows.map(r=>({tenantId,companyId:r.companyId,companyName:r.companyName,employmentId:r.employmentId,employeeCode:r.employeeCode,period:r.period,source:r.source,bik:num(r.bik),vola:num(r.vola),laterPayroll:r.laterPayroll===true}));
}

/** Per employee (company + employment) and per company. Pure. */
export function summarizeNoncashBaseGaps(rows:readonly NoncashBaseGapRow[]):{employees:NoncashBaseGapEmployee[];companies:NoncashBaseGapCompany[]}{
 const employees=new Map<string,NoncashBaseGapEmployee>();
 for(const r of rows){
  const key=r.tenantId+':'+r.companyId+':'+r.employmentId;
  const e=employees.get(key)??{tenantId:r.tenantId,companyId:r.companyId,companyName:r.companyName,employmentId:r.employmentId,employeeCode:r.employeeCode,periods:[],sources:[],bik:0,vola:0,missing:0,laterPayroll:false};
  if(!e.periods.includes(r.period))e.periods.push(r.period);
  if(!e.sources.includes(r.source))e.sources.push(r.source);
  e.bik=round(e.bik+r.bik);e.vola=round(e.vola+r.vola);e.missing=round(e.bik+e.vola);e.laterPayroll=e.laterPayroll||r.laterPayroll;
  employees.set(key,e);
 }
 const list=[...employees.values()].map(e=>({...e,periods:[...e.periods].sort(),sources:[...e.sources].sort()}));
 const companies=new Map<string,NoncashBaseGapCompany>();
 for(const e of list){
  const key=e.tenantId+':'+e.companyId;
  const c=companies.get(key)??{tenantId:e.tenantId,companyId:e.companyId,companyName:e.companyName,employees:0,months:0,bik:0,vola:0,missing:0};
  c.employees+=1;c.months+=e.periods.length;c.bik=round(c.bik+e.bik);c.vola=round(c.vola+e.vola);c.missing=round(c.bik+c.vola);
  companies.set(key,c);
 }
 return {employees:list,companies:[...companies.values()]};
}

const csv=(v:string|number|boolean|null)=>{const s=v===null?'':String(v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
/** Tab-free CSV lines for the operator: per-company totals, then one line per affected employee. Pure. */
export function formatNoncashBaseGapReport(year:number,rows:readonly NoncashBaseGapRow[]):string[]{
 const {employees,companies}=summarizeNoncashBaseGaps(rows);
 const out=[`# Taxable BIK/VOLA left out of year-to-date PCB income, assessment year ${year} (board d9ded29c). Read only.`,
  'section,tenant_id,company,employee_code,employment_id,months,source,missing_bik,missing_vola,missing_total,later_payroll_processed'];
 for(const c of companies)out.push(['company',c.tenantId,c.companyName,'','',c.months,`${c.employees} employees`,c.bik.toFixed(2),c.vola.toFixed(2),c.missing.toFixed(2),''].map(csv).join(','));
 for(const e of employees)out.push(['employee',e.tenantId,e.companyName,e.employeeCode,e.employmentId,e.periods.join(' '),e.sources.join(' '),e.bik.toFixed(2),e.vola.toFixed(2),e.missing.toFixed(2),e.laterPayroll?'yes':'no'].map(csv).join(','));
 out.push(`# ${employees.length} employees, ${companies.length} companies.`);
 return out;
}

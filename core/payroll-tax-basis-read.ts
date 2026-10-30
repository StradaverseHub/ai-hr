/** Narrow read seam for audited tax-input corrections. Does not import payroll or the country registry. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {PayrollTaxBasisError,type TaxBasisValue} from '../lib/payroll-tax-basis';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const canonical=(v:unknown):string=>JSON.stringify(v,(_key,item)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export type TaxBasisCorrectionRef={id:string;batchId:string;sourceHash:string;basisVersion:1};
type Source={id:string;employmentId:string;companyId:string;period:string;source:Record<string,unknown>;batch:Record<string,unknown>;importRevision:string|null};
async function sourceRows(tx:Tx,ids:string[]):Promise<Source[]>{
 if(!ids.length)return [];
 return await tx.execute<Source>(sql`select p.id,p.employment_id as "employmentId",b.company_id as "companyId",b.pay_period as period,
   to_jsonb(p) as source,jsonb_build_object('id',b.id,'company_id',b.company_id,'pay_period',b.pay_period,'run_seq',b.run_seq,'run_type',b.run_type) as batch,
   (select r.id::text from payroll_history_import_revision r join payroll_history_import_snapshot s on s.record_id=r.record_id where s.id=p.id order by r.ordinal desc limit 1) as "importRevision"
  from payslip p join payroll_batch b on b.id=p.batch_id where p.id=any(${ids}::uuid[]) order by p.id`);
}
const hashSource=(row:Source)=>createHash('sha256').update(canonical({source:row.source,batch:row.batch,importRevision:row.importRevision})).digest('hex');
/** Caller must own the history barrier while computing/validating this identity. */
export async function taxBasisSourceHashTx(tx:Tx,payslipId:string):Promise<string>{
 const rows=await sourceRows(tx,[payslipId]);if(rows.length!==1)throw new PayrollTaxBasisError('Original payroll source is unavailable.');return hashSource(rows[0]);
}
export function validatedTaxBasis(value:unknown):TaxBasisValue{
 const money=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&Number.isSafeInteger(Math.round(v*100))&&Math.abs(v*100-Math.round(v*100))<1e-6;
 if(!object(value)||value.version!==1||!money(value.pcb)||!money(value.normal)||!money(value.additional)||!money(value.exempt)||typeof value.period!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(value.period)||!object(value.exemptionUsed)||!Array.isArray(value.items)||typeof value.rulesHash!=='string'||!value.rulesHash||value.lp!==undefined&&!money(value.lp))throw new PayrollTaxBasisError('A saved income-tax correction is malformed.');
 for(const [code,amount]of Object.entries(value.exemptionUsed))if(!/^(PCB_|LP_)/.test(code)||!money(amount))throw new PayrollTaxBasisError('A saved income-tax exemption correction is malformed.');
 for(const item of value.items)if(!object(item)||typeof item.code!=='string'||!item.code||typeof item.name!=='string'||!money(item.amount)||!money(item.taxable)||!money(item.exempt)||Math.round((Number(item.taxable)+Number(item.exempt))*100)>Math.round(Number(item.amount)*100)||typeof item.latestTreatment!=='string'||!(item.previousTreatment===null||typeof item.previousTreatment==='string'))throw new PayrollTaxBasisError('Saved Pay Item tax evidence is malformed.');
 if(Math.round((Number(value.normal)+Number(value.additional))*100)!==Math.round(Number(value.pcb)*100))throw new PayrollTaxBasisError('The corrected remuneration totals do not reconcile.');
 return value as TaxBasisValue;
}
export type EffectiveTaxBasis={statutory:Record<string,unknown>;correction:TaxBasisCorrectionRef;basis:TaxBasisValue};
/** Exact current source only. Returned statutory objects are copies; no payslip row is ever modified. */
export async function readEffectiveTaxBasesTx(tx:Tx,ctx:SessionContext,payslipIds:string[]):Promise<Map<string,EffectiveTaxBasis>>{
 const out=new Map<string,EffectiveTaxBasis>();if(!payslipIds.length)return out;
 const sources=await sourceRows(tx,[...new Set(payslipIds)]);if(!sources.length)return out;
 const keys=sources.map(s=>({companyId:s.companyId,employmentId:s.employmentId,period:s.period}));
 const corrections=await tx.execute<{id:string;batchId:string;payslipId:string;sourceHash:string;basis:unknown}>(sql`
  select r.id,r.batch_id as "batchId",r.payslip_id as "payslipId",r.source_hash as "sourceHash",r.basis
  from payroll_tax_basis_revision r join jsonb_to_recordset(${JSON.stringify(keys)}::jsonb) as k("companyId" uuid,"employmentId" uuid,period text)
   on r.company_id=k."companyId" and r.employment_id=k."employmentId" and r.period=k.period
  where r.tenant_id=${ctx.tenantId}::uuid order by r.payslip_id,r.ordinal desc`);
 const superseded=new Set<string>();for(const row of corrections)if(object(row.basis)&&Array.isArray(row.basis.supersedes))for(const id of row.basis.supersedes)if(typeof id==='string')superseded.add(id);
 // A consumer may request one cycle of a corrected multi-cycle month. Other current sources in
 // that exact employer/month context must be validated, not mistaken for vanished source rows.
 const requested=new Set(payslipIds),known=new Set(sources.map(s=>s.id));
 const contextSources=await sourceRows(tx,[...new Set(corrections.map(row=>row.payslipId))].filter(id=>!known.has(id)));
 const byId=new Map([...sources,...contextSources].map(s=>[s.id,s])),visited=new Set<string>();
 for(const row of corrections){
  if(visited.has(row.payslipId))continue;visited.add(row.payslipId);
  if(superseded.has(row.id))continue;
  const source=byId.get(row.payslipId);
  if(!source||hashSource(source)!==row.sourceHash)throw new PayrollTaxBasisError('Saved payroll changed after an income-tax correction. Review and recalculate the affected employee before continuing.');
  const basis=validatedTaxBasis(row.basis),original=source.source.statutory;
  if(basis.period!==source.period)throw new PayrollTaxBasisError('The corrected tax period does not match its original source.');
  if(!object(original))throw new PayrollTaxBasisError('The original statutory source is unavailable.');
  const correction:TaxBasisCorrectionRef={id:row.id,batchId:row.batchId,sourceHash:row.sourceHash,basisVersion:1};
  const statutory={...original,bases:{...(object(original.bases)?original.bases:{}),pcb:basis.pcb},exemptionUsed:{...basis.exemptionUsed},...(basis.lp!==undefined?{lp:basis.lp}:{}),taxBasisCorrection:correction};
  if(requested.has(row.payslipId))out.set(row.payslipId,{statutory,correction,basis});
 }
 return out;
}

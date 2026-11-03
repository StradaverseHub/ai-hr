/** Narrow read seam for audited tax-input corrections. Does not import payroll or the country registry. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {PayrollTaxBasisError,type TaxBasisValue} from '../lib/payroll-tax-basis';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const canonical=(v:unknown):string=>JSON.stringify(v,(_key,item)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export type TaxBasisCorrectionRef={id:string;batchId:string;sourceHash:string;basisVersion:1};
export type TaxBasisSource={id:string;employmentId:string;companyId:string;period:string;source:Record<string,unknown>;batch:Record<string,unknown>;importRevision:string|null};
export async function taxBasisSourceRowsTx(tx:Tx,ids:string[]):Promise<TaxBasisSource[]>{
 if(!ids.length)return [];
 return await tx.execute<TaxBasisSource>(sql`select p.id,p.employment_id as "employmentId",b.company_id as "companyId",b.pay_period as period,
   to_jsonb(p) as source,jsonb_build_object('id',b.id,'company_id',b.company_id,'pay_period',b.pay_period,'run_seq',b.run_seq,'run_type',b.run_type,'cycle_id',b.payroll_cycle_id,'batch_date',b.batch_date) as batch,
   (select r.id::text from payroll_history_import_revision r join payroll_history_import_snapshot s on s.record_id=r.record_id where s.id=p.id order by r.ordinal desc limit 1) as "importRevision"
  from payslip p join payroll_batch b on b.id=p.batch_id where p.id=any(array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) order by p.id`);
}
export const hashTaxBasisSource=(row:TaxBasisSource)=>createHash('sha256').update(canonical({source:row.source,batch:row.batch,importRevision:row.importRevision})).digest('hex');
/** Caller must own the history barrier while computing/validating this identity. */
export async function taxBasisSourceHashTx(tx:Tx,payslipId:string):Promise<string>{
 const rows=await taxBasisSourceRowsTx(tx,[payslipId]);if(rows.length!==1)throw new PayrollTaxBasisError('Original payroll source is unavailable.');return hashTaxBasisSource(rows[0]);
}
export function validatedTaxBasis(value:unknown):TaxBasisValue{
 const money=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&Number.isSafeInteger(Math.round(v*100))&&Math.abs(v*100-Math.round(v*100))<1e-6;
 if(!object(value)||value.version!==1||!money(value.pcb)||!money(value.normal)||!money(value.additional)||!money(value.exempt)||typeof value.period!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(value.period)||!object(value.exemptionUsed)||!Array.isArray(value.items)||typeof value.rulesHash!=='string'||!value.rulesHash||value.lp!==undefined&&!money(value.lp))throw new PayrollTaxBasisError('A saved income-tax correction is malformed.');
 for(const [code,amount]of Object.entries(value.exemptionUsed))if(!/^(PCB_|LP_)/.test(code)||!money(amount))throw new PayrollTaxBasisError('A saved income-tax exemption correction is malformed.');
 for(const item of value.items)if(!object(item)||typeof item.code!=='string'||!item.code||typeof item.name!=='string'||!money(item.amount)||!money(item.taxable)||!money(item.exempt)||Math.round((Number(item.taxable)+Number(item.exempt))*100)>Math.round(Number(item.amount)*100)||typeof item.latestTreatment!=='string'||!(item.previousTreatment===null||typeof item.previousTreatment==='string'))throw new PayrollTaxBasisError('Saved Pay Item tax evidence is malformed.');
 if(Math.round((Number(value.normal)+Number(value.additional))*100)!==Math.round(Number(value.pcb)*100))throw new PayrollTaxBasisError('The corrected remuneration totals do not reconcile.');
 return value as TaxBasisValue;
}
type Replacement={id:string;correctionId:string;beforeHash:string;afterHash:string;beforeSource:TaxBasisSource;afterSource:TaxBasisSource};
async function replacementsTx(tx:Tx,ctx:SessionContext,ids:string[]):Promise<Replacement[]>{
 if(!ids.length)return [];
 return tx.execute<Replacement>(sql`select id,correction_id as "correctionId",before_hash as "beforeHash",after_hash as "afterHash",before_source as "beforeSource",after_source as "afterSource" from payroll_tax_basis_replacement
  where tenant_id=${ctx.tenantId}::uuid and correction_id=any(array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) order by created_at,id`);
}
/** A replacement consumes the OLD correction, never re-hashes it onto unrelated source bytes.
 * Every immutable link binds the same slip/employment/employer/period and one native version step. */
export function taxBasisReplacementMatches(source:TaxBasisSource,rootHash:string,links:readonly Replacement[]):boolean{
 if(!links.length)return false;
 let expected=rootHash;
 for(const link of links){
  const before=link.beforeSource,after=link.afterSource;
  if(!object(before)||!object(after)||!object(before.source)||!object(after.source)||!object(before.batch)||!object(after.batch)
   ||before.id!==source.id||after.id!==source.id||before.employmentId!==source.employmentId||after.employmentId!==source.employmentId
   ||before.companyId!==source.companyId||after.companyId!==source.companyId||before.period!==source.period||after.period!==source.period
   ||before.importRevision!==null||after.importRevision!==null||canonical(before.batch)!==canonical(after.batch)
   ||link.beforeHash!==expected||hashTaxBasisSource(before)!==link.beforeHash||hashTaxBasisSource(after)!==link.afterHash
   ||!Number.isInteger(before.source.version)||Number(after.source.version)!==Number(before.source.version)+1)return false;
  expected=link.afterHash;
 }
 return hashTaxBasisSource(source)===expected;
}
export type TaxBasisReplacementPreparation={sources:TaxBasisSource[];corrections:{id:string;payslipId:string;sourceHash:string;basis:TaxBasisValue}[]};
/** Validate current sources before a native reprocess changes anything, including its own corrected slip. */
export async function prepareTaxBasisReplacementTx(tx:Tx,ctx:SessionContext,ids:string[]):Promise<TaxBasisReplacementPreparation>{
 const sources=await taxBasisSourceRowsTx(tx,ids);await readEffectiveTaxBasesTx(tx,ctx,ids);
 const corrections=ids.length?await tx.execute<{id:string;payslipId:string;sourceHash:string;basis:TaxBasisValue}>(sql`select distinct on(payslip_id) id,payslip_id as "payslipId",source_hash as "sourceHash",basis from payroll_tax_basis_revision where tenant_id=${ctx.tenantId}::uuid and payslip_id=any(array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) order by payslip_id,ordinal desc`):[];
 return{sources,corrections};
}
export async function recordTaxBasisReplacementTx(tx:Tx,ctx:SessionContext,prepared:TaxBasisReplacementPreparation,historyByEmployment:Record<string,string>){
 const after=await taxBasisSourceRowsTx(tx,prepared.sources.map(s=>s.id));
 for(const correction of prepared.corrections){
  const before=prepared.sources.find(s=>s.id===correction.payslipId),next=after.find(s=>s.id===correction.payslipId);
  if(!before||!next||!historyByEmployment[next.employmentId])throw new PayrollTaxBasisError('The corrected payroll replacement is incomplete.');
  // Correction custody covers the reviewed cash source only. A new earning or changed input
  // requires a fresh reviewed correction; it cannot inherit the previous source's annual allocation.
  const cash=(row:TaxBasisSource)=>{
   const st=row.source.statutory;if(!object(st)||!Array.isArray(st.componentLines))throw new PayrollTaxBasisError('Saved payroll changed after an income-tax correction. Review and recalculate the affected employee before continuing.');
   return {basic:row.source.basic_salary,gross:row.source.gross_pay,deductions:row.source.other_deductions,
    lines:st.componentLines.map(line=>{if(!object(line)||typeof line.code!=='string'||typeof line.amount!=='number')throw new PayrollTaxBasisError('Saved payroll cash evidence is unavailable.');return{code:line.code,amount:line.amount};}).sort((a,b)=>a.code.localeCompare(b.code)||a.amount-b.amount)};
  };
  const basis=validatedTaxBasis(correction.basis),stat=next.source.statutory;
  if(canonical(cash(before))!==canonical(cash(next))||!object(stat)||!object(stat.bases)||stat.bases.pcb!==basis.pcb||canonical(stat.exemptionUsed??{})!==canonical(basis.exemptionUsed)||Number(stat.lp??0)!==Number(basis.lp??0))throw new PayrollTaxBasisError('Saved payroll changed after an income-tax correction. Review and recalculate the affected employee before continuing.');
  await tx.execute(sql`insert into payroll_tax_basis_replacement(tenant_id,company_id,employment_id,payslip_id,correction_id,history_id,before_hash,after_hash,before_source,after_source,created_by)
   values(${ctx.tenantId}::uuid,${next.companyId}::uuid,${next.employmentId}::uuid,${next.id}::uuid,${correction.id}::uuid,${historyByEmployment[next.employmentId]}::uuid,${hashTaxBasisSource(before)},${hashTaxBasisSource(next)},${JSON.stringify(before)}::jsonb,${JSON.stringify(next)}::jsonb,${ctx.userId??null}::uuid)`);
 }
}
export type EffectiveTaxBasis={statutory:Record<string,unknown>;correction:TaxBasisCorrectionRef;basis:TaxBasisValue};
/** Exact current source only. Returned statutory objects are copies; no payslip row is ever modified. */
export async function readEffectiveTaxBasesTx(tx:Tx,ctx:SessionContext,payslipIds:string[]):Promise<Map<string,EffectiveTaxBasis>>{
 const out=new Map<string,EffectiveTaxBasis>();if(!payslipIds.length)return out;
 const sources=await taxBasisSourceRowsTx(tx,[...new Set(payslipIds)]);if(!sources.length)return out;
 const keys=sources.map(s=>({companyId:s.companyId,employmentId:s.employmentId,period:s.period}));
 const corrections=await tx.execute<{id:string;batchId:string;payslipId:string;sourceHash:string;basis:unknown}>(sql`
  select r.id,r.batch_id as "batchId",r.payslip_id as "payslipId",r.source_hash as "sourceHash",r.basis
  from payroll_tax_basis_revision r join jsonb_to_recordset(${JSON.stringify(keys)}::jsonb) as k("companyId" uuid,"employmentId" uuid,period text)
   on r.company_id=k."companyId" and r.employment_id=k."employmentId" and r.period=k.period
  where r.tenant_id=${ctx.tenantId}::uuid order by r.payslip_id,r.ordinal desc`);
 const replacements=await replacementsTx(tx,ctx,corrections.map(r=>r.id));
 const superseded=new Set<string>();for(const row of corrections)if(object(row.basis)&&Array.isArray(row.basis.supersedes))for(const id of row.basis.supersedes)if(typeof id==='string')superseded.add(id);
 // A consumer may request one cycle of a corrected multi-cycle month. Other current sources in
 // that exact employer/month context must be validated, not mistaken for vanished source rows.
 const requested=new Set(payslipIds),known=new Set(sources.map(s=>s.id));
 const contextSources=await taxBasisSourceRowsTx(tx,[...new Set(corrections.map(row=>row.payslipId))].filter(id=>!known.has(id)));
 const byId=new Map([...sources,...contextSources].map(s=>[s.id,s])),visited=new Set<string>();
 for(const row of corrections){
  if(visited.has(row.payslipId))continue;visited.add(row.payslipId);
  if(superseded.has(row.id))continue;
  const source=byId.get(row.payslipId);
  const links=replacements.filter(r=>r.correctionId===row.id);
  if(source&&links.length&&taxBasisReplacementMatches(source,row.sourceHash,links))continue;
  if(!source||links.length||hashTaxBasisSource(source)!==row.sourceHash)throw new PayrollTaxBasisError('Saved payroll changed after an income-tax correction. Review and recalculate the affected employee before continuing.');
  const basis=validatedTaxBasis(row.basis),original=source.source.statutory;
  if(basis.period!==source.period)throw new PayrollTaxBasisError('The corrected tax period does not match its original source.');
  if(!object(original))throw new PayrollTaxBasisError('The original statutory source is unavailable.');
  const correction:TaxBasisCorrectionRef={id:row.id,batchId:row.batchId,sourceHash:row.sourceHash,basisVersion:1};
  const statutory={...original,bases:{...(object(original.bases)?original.bases:{}),pcb:basis.pcb},exemptionUsed:{...basis.exemptionUsed},...(basis.lp!==undefined?{lp:basis.lp}:{}),taxBasisCorrection:correction};
  if(requested.has(row.payslipId))out.set(row.payslipId,{statutory,correction,basis});
 }
 return out;
}

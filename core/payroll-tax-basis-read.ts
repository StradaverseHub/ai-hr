/** Narrow read seam for audited tax-input corrections. Does not import payroll or the country registry. */
import {importedTaxSettingsTx,importedTaxRulesStatesTx,importedTaxSettingEvidence} from './payroll-import-tax-source';
import {createNonCashOwnershipReplay,readPcbNonCash} from '../localization/noncash-benefits';
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {PayrollTaxBasisError,type TaxBasisValue} from '../lib/payroll-tax-basis';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const canonical=(v:unknown):string=>JSON.stringify(v,(_key,item)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export type TaxBasisCorrectionRef={id:string;batchId:string;sourceHash:string;basisVersion:1};
export type TaxBasisSource={id:string;employmentId:string;companyId:string;period:string;source:Record<string,unknown>;batch:Record<string,unknown>;importRevision:string|null;historyAttemptId?:string|null};
export async function taxBasisSourceRowsTx(tx:Tx,ids:string[]):Promise<TaxBasisSource[]>{
 if(!ids.length)return [];
 return await tx.execute<TaxBasisSource>(sql`select p.id,p.employment_id as "employmentId",b.company_id as "companyId",b.pay_period as period,b.history_import_attempt_id as "historyAttemptId",
   to_jsonb(p) as source,jsonb_build_object('id',b.id,'company_id',b.company_id,'pay_period',b.pay_period,'run_seq',b.run_seq,'run_type',b.run_type,'cycle_id',b.payroll_cycle_id,'batch_date',b.batch_date) as batch,
   app.payroll_tax_import_source_revision(p.id)::text as "importRevision"
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
export type EffectiveTaxBasis={statutory:Record<string,unknown>;correction:TaxBasisCorrectionRef|null;basis:TaxBasisValue};
/** Exact current source only. Returned statutory objects are copies; no payslip row is ever modified. */
export async function readEffectiveTaxBasesTx(tx:Tx,ctx:SessionContext,payslipIds:string[],options:{includeImported?:boolean;sameMonth?:boolean}={}):Promise<Map<string,EffectiveTaxBasis>>{
 const out=new Map<string,EffectiveTaxBasis>();if(!payslipIds.length)return out;
 const sources=await taxBasisSourceRowsTx(tx,[...new Set(payslipIds)]);if(!sources.length)return out;
 const keys=sources.map(s=>({companyId:s.companyId,employmentId:s.employmentId,period:s.period}));
 const corrections=await tx.execute<{id:string;batchId:string;payslipId:string;sourceHash:string;basis:unknown}>(sql`
  select r.id,r.batch_id as "batchId",r.payslip_id as "payslipId",r.source_hash as "sourceHash",r.basis
  from payroll_tax_basis_revision r join jsonb_to_recordset(${JSON.stringify(keys)}::jsonb) as k("companyId" uuid,"employmentId" uuid,period text)
   on r.company_id=k."companyId" and r.employment_id=k."employmentId" and r.period=k.period
  where r.tenant_id=${ctx.tenantId}::uuid order by r.payslip_id,r.ordinal desc`);
 const replacements=await replacementsTx(tx,ctx,corrections.map(r=>r.id));
 // A newly accepted imported snapshot owns fresh inputs. It may supersede only corrections on
 // an older snapshot of the very same immutable import record, never another cycle or employer.
 const currentImported=sources.filter(source=>object(source.source.statutory)&&object(source.source.statutory.importedTaxBasis)).map(source=>source.id);
 const replaced=currentImported.length?await tx.execute<{id:string}>(sql`select r.id from payroll_tax_basis_revision r join payroll_history_import_snapshot previous on previous.id=r.payslip_id join payroll_history_import_record record on record.id=previous.record_id join lateral(select v.snapshot_id from payroll_history_import_revision v where v.record_id=record.id order by v.ordinal desc limit 1) latest on true join payroll_history_import_snapshot current on current.id=latest.snapshot_id and current.record_id=record.id where r.tenant_id=${ctx.tenantId}::uuid and current.id=any(array[${sql.join(currentImported.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) and previous.id<>current.id and r.company_id=record.company_id and r.employment_id=record.employment_id and r.period=record.period`):[];
 const superseded=new Set<string>(replaced.map(row=>row.id));for(const row of corrections)if(object(row.basis)&&Array.isArray(row.basis.supersedes))for(const id of row.basis.supersedes)if(typeof id==='string')superseded.add(id);
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
  const statutory={...original,...(basis.pcbNonCash?{pcbNonCash:basis.pcbNonCash}:{}),bases:{...(object(original.bases)?original.bases:{}),pcb:basis.pcb},exemptionUsed:{...basis.exemptionUsed},...(basis.lp!==undefined?{lp:basis.lp}:{}),taxBasisCorrection:correction};
  if(requested.has(row.payslipId))out.set(row.payslipId,{statutory,correction,basis});
 }
 // New imported inputs are never silently replaced by the legacy gross-pay fallback. A reviewed
 // exact-source revision wins; otherwise the accepted import's explicit projection must still match.
 const imported=options.includeImported?sources.filter(source=>!!source.historyAttemptId||object(source.source.statutory)&&object(source.source.statutory.importedTaxBasis)):[];
 const current=imported.length?await importedTaxSettingsTx(tx):[];
 const rulesStates=await importedTaxRulesStatesTx(tx,[...new Set(imported.map(source=>source.period))]);
 for(const source of imported){
  const statutory=(object(source.source.statutory)?source.source.statutory:{}) as Record<string,unknown>,stamp=(object(statutory.importedTaxBasis)?statutory.importedTaxBasis:{}) as Record<string,unknown>,reviewed=out.get(source.id);
  const receiptSettings=reviewed?reviewed.basis.appliedSettings:stamp.settings,receiptRules=reviewed?reviewed.basis.rulesState:stamp.rulesState;
  const unavailable=()=>{throw new PayrollTaxBasisError(`Imported wage inputs require review for ${source.period}. Preview the historical tax inputs and resolve the named missing evidence.`);};
  if((!reviewed&&(stamp.version!==1||stamp.year!==Number(source.period.slice(0,4))||stamp.state!=='ready'))||canonical(receiptRules)!==canonical(rulesStates.get(source.period))||!Array.isArray(receiptSettings))unavailable();
  const settings=receiptSettings as Record<string,unknown>[];
  for(const saved of settings){
   if(saved.id==='system-basic-salary'){if(current.some(setting=>setting.code.toUpperCase()==='BASIC'))unavailable();continue;}
   const live=current.find(setting=>setting.id===saved.id);
   if(!live||canonical(importedTaxSettingEvidence([live]))!==canonical(importedTaxSettingEvidence([saved])))unavailable();
  }
  if(options.sameMonth){
   const basis=reviewed?.basis??validatedTaxBasis(stamp.basis),evidence=reviewed?.basis.rulesEvidence??stamp.rulesEvidence;
   const noncash=readPcbNonCash(basis.pcbNonCash);
   if(noncash?.ownedEaEntries.some(entry=>entry.entered>0))throw new PayrollTaxBasisError(`Imported monthly noncash source ownership is unavailable for ${source.period}. The original recurring/one-off and regular-run baseline evidence is required before a later cycle can be calculated.`);
   const exemptions=object(evidence)&&object(evidence.pcbExemptions)?evidence.pcbExemptions:null;
   if(!exemptions)unavailable();
   const cashCap=basis.items.some(item=>settings.some(setting=>setting.code===item.code&&setting.includedInPcb===true&&setting.isNonPayable!==true&&(setting.epfBonus2012===true||setting.pcbRemunerationType==='normal'||setting.pcbRemunerationType==='additional')&&typeof setting.pcbExemptionCode==='string'&&object(exemptions!.pcb)&&Number(exemptions!.pcb[setting.pcbExemptionCode])>0&&item.exempt>0));
   const optionalCap=Object.entries(basis.exemptionUsed).some(([code,amount])=>code.startsWith('LP_')&&amount>0&&object(exemptions!.lp)&&Number(exemptions!.lp[code])>0);
   if(cashCap||optionalCap)throw new PayrollTaxBasisError(`Imported monthly exemption source ownership is unavailable for ${source.period}. The original recurring/one-off or optional-deduction evidence is required before a later cycle can be calculated.`);
  }
  if(reviewed)continue;
  const basis=validatedTaxBasis(stamp.basis);
  if(!object(statutory.bases)||statutory.bases.pcb!==basis.pcb)unavailable();
  out.set(source.id,{correction:null,basis,statutory:{...statutory,bases:{...(object(statutory.bases)?statutory.bases:{}),pcb:basis.pcb},exemptionUsed:{...basis.exemptionUsed},...(basis.lp!==undefined?{lp:basis.lp}:{}),...(basis.pcbNonCash?{pcbNonCash:basis.pcbNonCash}:{})}});
 }
 if(options.includeImported){
  // Eligible consumers ask for their saved prefix. Recompose cumulative noncash snapshots from
  // owned sources across cycles; never treat each imported cycle as an entire monthly baseline.
  const builders=new Map<string,ReturnType<typeof createNonCashOwnershipReplay>>();
  const ordered=[...sources].sort((a,b)=>a.companyId.localeCompare(b.companyId)||a.employmentId.localeCompare(b.employmentId)||a.period.localeCompare(b.period)||String(a.batch.batch_date??'').localeCompare(String(b.batch.batch_date??''))||String(a.batch.cycle_id??'').localeCompare(String(b.batch.cycle_id??''))||Number(a.batch.run_seq??0)-Number(b.batch.run_seq??0)||String(a.batch.id).localeCompare(String(b.batch.id))||a.id.localeCompare(b.id));
  for(const source of ordered){
   const effective=out.get(source.id),stat=effective?.statutory??source.source.statutory;if(!object(stat))throw new PayrollTaxBasisError('The original statutory source is unavailable.');
   const saved=readPcbNonCash(stat.pcbNonCash);if(stat.pcbNonCash!==undefined&&!saved)throw new PayrollTaxBasisError('Original month noncash ownership is malformed.');
   const key=source.companyId+':'+source.employmentId+':'+source.period.slice(0,4),builder=builders.get(key)??createNonCashOwnershipReplay(false);builders.set(key,builder);
   let rebuilt:ReturnType<typeof builder>;
   try{rebuilt=builder({period:source.period,cashNormal:typeof effective?.basis.normal==='number'?effective.basis.normal:saved?.cashNormal??0,owned:saved?.ownedEntries??[],ownedEa:saved?.ownedEaEntries??[],original:saved,completeSource:saved!==null||object(stat.importedTaxBasis)});}catch{throw new PayrollTaxBasisError('Original month noncash source ownership is incomplete or duplicated. Review the complete month prefix.');}
   if(effective&&(saved||rebuilt.eaEntries.length))out.set(source.id,{...effective,basis:{...effective.basis,pcbNonCash:rebuilt},statutory:{...effective.statutory,pcbNonCash:rebuilt}});
  }
 }
 return out;
}

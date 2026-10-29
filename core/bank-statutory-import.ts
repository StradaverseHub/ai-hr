/**
 * 0db97f14 — Bank & Statutory import: the MERGED statutory writer, the file-level history wrapper and the
 * revert handler (ADR-0155 kind `bank_statutory`).
 *
 * THE OVERWRITE HAZARD THIS FILE EXISTS TO CLOSE. The country pack's statutory setters rewrite whole blocks
 * of `employee_statutory_my` from their arguments (`set` the EPF/SOCSO/EIS row including bank, TP3 and
 * zakat; `setTax` every tax column; `setBank` the bank block). A narrow file must never pass "only what it
 * supplied" to them. So every write here:
 *   1. reads the statutory row under the row transaction's lock (the caller holds it FOR UPDATE),
 *   2. overlays ONLY the supplied cells onto the tab's own view of that row (`bankStatutoryStateFrom`),
 *   3. validates the merged result with the tab's rules (EPF election, tax circumstance/residency), and
 *   4. calls the pack's setters with the whole merged row, re-reading between setters so an earlier write
 *      in the same row (bank, registration numbers) is carried, not reverted.
 * A blank cell is never in the patch, so it never clears anything. Revert uses the same writer with the
 * recorded "before" values, where "" does mean "put the empty value back".
 */
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {company,employment} from '../db/schema';
import {requirePackFor,type CountryPack} from '../localization/registry';
import {clientPackFor} from '../localization/registry.client';
import {mapEpfUiMode,retainLegacyTotalTopup} from '../lib/epf-mode-map';
import {applyPersonnelOperationalValuesTx} from './personnel-import-operations';
import {setEmploymentPaymentMethod} from './org';
import {isPaymentMethod} from '../lib/payment-methods';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {
 BANK_COLUMNS,BANK_STATUTORY_STATE_COLUMNS,MERGED_STATUTORY_COLUMNS,OTHERS_COLUMNS,REGISTRATION_COLUMNS,STATUTORY_ROW_COLUMNS,
 bankStatutoryColumnLabel,bankStatutoryStateFrom,childReliefTableFrom,isTaxColumn,parseBankStatutoryCell,
 type BankStatutoryItemState,type BankStatutoryState,
} from '../lib/bank-statutory-import';
import {ImportHistoryError,type ImportRevertHandler} from './import-history';

/** A refusal whose message is safe to show (names a column and a reason, never a stored value). */
export class BankStatutoryImportError extends Error{constructor(message:string){super(message);this.name='BankStatutoryImportError';}}
const refuse=(message:string):never=>{throw new BankStatutoryImportError(message);};
export type BankStatutorySubject={employmentId:string;personId:string;pack:CountryPack;country:string};
export type BankStatutoryPatch=Record<string,string|null>;

const TAX_SELECTION_TEXT:Record<string,string>={
 confirmation_required:'the employer-scoped income tax selection needs confirmation on the Personnel record first',
 invalid_scheme:'this residency cannot be combined with the Tax Category (use None with None)',
 citizenship_unknown:'C-Suite needs EPF citizenship PR or non-citizen',
 not_resident:'this residency is not available for a non-resident',
 stale_context:'the employee\'s company or tax selection changed; check the employee and try again',
 not_found:'you cannot change the income tax selection of this employee',
};
/** Known owner refusals become row errors; anything else stays a generic "database refused". */
export function bankStatutoryRefusal(error:unknown):string|null{
 if(error instanceof BankStatutoryImportError)return error.message;
 const e=error as {name?:string;code?:unknown;message?:string};
 if(e?.name==='TaxSelectionError')return `${bankStatutoryColumnLabel('tax_residency')}: ${TAX_SELECTION_TEXT[String(e.code)]??'the income tax selection was refused'}`;
 if(e?.name==='InvalidEpfElectionError')return `${bankStatutoryColumnLabel('epf_category')}: ${e.message}`;
 if(e?.name==='IncompleteCustomHolderError')return `${bankStatutoryColumnLabel('custom_holder_name')}: ${e.message}`;
 return null;
}

/** Income tax residency exactly as the tab shows it: the resolved employer-scoped scheme, else "". */
export async function readTaxResidencyTx(tx:Tx,ctx:SessionContext,subject:BankStatutorySubject,row:{taxCircumstance?:string|null}|null){
 if(!row)return'';
 if(row.taxCircumstance==='none')return'none';
 if(!subject.pack.statutory.getTaxSelection)return'';
 try{
  const selection=await subject.pack.statutory.getTaxSelection(ctx,subject.employmentId,undefined,{tx,readOnly:true});
  return selection.transitionState==='resolved'&&selection.scheme&&selection.scheme!=='none'?String(selection.scheme):'';
 }catch{return'';}
}
/** The employee's Bank & Statutory values as the tab presents them, read inside the caller's transaction. */
export async function readBankStatutoryStateTx(tx:Tx,ctx:SessionContext,subject:BankStatutorySubject,options:{lock?:boolean}={}):Promise<{state:BankStatutoryState;row:Awaited<ReturnType<CountryPack['statutory']['get']>>}>{
 const row=await subject.pack.statutory.get(ctx,subject.personId,tx,{forUpdate:options.lock});
 const[e]=await tx.select({paymentMethod:employment.paymentMethod}).from(employment).where(eq(employment.id,subject.employmentId));
 return{row,state:bankStatutoryStateFrom(row as unknown as Record<string,unknown>|null,{taxResidency:await readTaxResidencyTx(tx,ctx,subject,row),paymentMethod:e?.paymentMethod??null})};
}
export async function bankStatutorySubjectTx(tx:Tx,employmentId:string):Promise<BankStatutorySubject|null>{
 const[row]=await tx.select({employmentId:employment.id,personId:employment.personId,country:company.country}).from(employment).innerJoin(company,eq(company.id,employment.companyId)).where(eq(employment.id,employmentId));
 return row?{employmentId:row.employmentId,personId:row.personId,country:row.country,pack:requirePackFor(row.country)}:null;
}

const circumstanceCategory=(country:string,value:string)=>clientPackFor(country)?.payroll.taxCircumstanceOptions?.find(option=>option.value===value)?.category??null;
const label=bankStatutoryColumnLabel;
/**
 * Cross-field rules of the tab, on the MERGED values (stored overlaid by supplied). Used by the dry run and
 * again by the writer under lock. Returns row errors naming the column.
 */
export function bankStatutoryMergedErrors(subject:Pick<BankStatutorySubject,'pack'|'country'>,stored:BankStatutoryState,patch:BankStatutoryPatch):string[]{
 const errors:string[]=[];const has=(c:string)=>c in patch;
 const merged:BankStatutoryState={...stored};for(const[c,v]of Object.entries(patch))merged[c]=v??'';
 // EPF election: the same mapper and pack rule as the EPF card. A figure the chosen category would drop is
 // refused rather than silently discarded, so the preview never promises a change that does not persist.
 if(['epf_category','epf_employee_rate','epf_employer_rate','epf_employee_amount','epf_employer_amount','epf_manual_reason'].some(has)){
  const fields=mapEpfUiMode(merged.epf_category||'auto',merged.epf_employee_rate||null,merged.epf_employer_rate||null,merged.epf_employee_amount||null,merged.epf_employer_amount||null,merged.epf_manual_reason||null);
  const kept:Record<string,unknown>={epf_employee_rate:fields.epfEmployeeRate,epf_employer_rate:fields.epfEmployerRate,epf_employee_amount:fields.epfEmployeeAmount,epf_employer_amount:fields.epfEmployerAmount,epf_manual_reason:fields.epfManualReason};
  for(const c of Object.keys(kept))if(has(c)&&patch[c]&&kept[c]==null)errors.push(`${label(c)}: not used by EPF Category "${merged.epf_category||'auto'}" — leave it blank or choose a category that uses it`);
  // b6dbadc5 — an election re-posted exactly as stored is not re-judged here: an unconverted legacy total-rate
  // Top-up row carries TOTAL rates that the additive rule would misread. The writer keeps such a row as it is
  // (`retainLegacyTotalTopup`) and the pack's setter still validates whatever it writes.
  const epfColumns=['epf_category','epf_employee_rate','epf_employer_rate','epf_employee_amount','epf_employer_amount','epf_manual_reason'];
  if(!epfColumns.every(c=>(merged[c]??'')===(stored[c]??''))){
   try{subject.pack.statutory.validateEpfElection(fields);}catch(error){errors.push(`${label('epf_category')}: ${(error as Error).message}`);}
  }
 }
 if(has('tax_circumstance')&&has('tax_category')&&merged.tax_circumstance&&merged.tax_circumstance!=='none'){
  const category=circumstanceCategory(subject.country,merged.tax_circumstance);
  if(category!==null&&String(category)!==merged.tax_category)errors.push(`${label('tax_category')}: ${merged.tax_category} does not match ${label('tax_circumstance')} "${merged.tax_circumstance}" (category ${category})`);
 }
 if(merged.tax_circumstance==='none'&&has('tax_residency')&&patch.tax_residency)errors.push(`${label('tax_residency')}: leave it blank when ${label('tax_circumstance')} is none`);
 const leavingNone=has('tax_circumstance')&&stored.tax_circumstance==='none'&&merged.tax_circumstance!=='none';
 if(leavingNone&&!merged.tax_residency||leavingNone&&merged.tax_residency==='none')errors.push(`${label('tax_residency')}: required when ${label('tax_circumstance')} changes from none`);
 if((has('tax_residency')||has('epf_citizenship'))&&merged.tax_residency&&merged.tax_residency!=='none'){
  const gap=clientPackFor(subject.country)?.statutory.draftTaxResidencyGap?.(merged.tax_residency,merged.epf_citizenship);
  if(gap)errors.push(`${label('tax_residency')}: ${merged.tax_residency==='c_suite'?'C-Suite needs EPF citizenship PR or non-citizen':'this residency is not available'}`);
 }
 return errors;
}

/**
 * Dry-run builder for the merged columns of one row: canonical values for the supplied cells, the legacy
 * adapters, and errors that name the column. `stored` is the tab's view; `changes` lists differing columns.
 */
export function buildBankStatutoryPatch(cell:(c:string)=>string|undefined,subject:Pick<BankStatutorySubject,'pack'|'country'>,stored:BankStatutoryState){
 const patch:Record<string,string>={},errors:string[]=[];
 for(const c of MERGED_STATUTORY_COLUMNS){const raw=cell(c);if(raw===undefined)continue;const parsed=parseBankStatutoryCell(c,raw);if(parsed.error!==undefined)errors.push(parsed.error);else patch[c]=parsed.value;}
 // Bounded legacy adapters (the full template's old yes/no columns), never a second source of truth.
 const eis=cell('eis_eligible'),resident=cell('is_resident');
 if(eis!==undefined){const parsed=parseBankStatutoryCell('eis_eligible',eis);if(parsed.error!==undefined)errors.push(parsed.error);else{
  const category=parsed.value==='no'?'none':stored.eis_category==='none'?'auto':stored.eis_category||'auto';
  if(patch.eis_category!==undefined&&patch.eis_category!==category)errors.push(`${label('eis_eligible')}: disagrees with ${label('eis_category')}; keep one of the two columns`);else patch.eis_category=category;}}
 if(resident!==undefined){const parsed=parseBankStatutoryCell('is_resident',resident);if(parsed.error!==undefined)errors.push(parsed.error);else{
  const scheme=parsed.value==='no'?'non_resident':!stored.tax_residency||stored.tax_residency==='non_resident'?'resident':stored.tax_residency;
  if(patch.tax_residency!==undefined&&patch.tax_residency!==scheme)errors.push(`${label('is_resident')}: disagrees with ${label('tax_residency')}; keep one of the two columns`);
  else if(stored.tax_residency!=='none')patch.tax_residency=scheme;}}
 if(!errors.length)errors.push(...bankStatutoryMergedErrors(subject,stored,patch));
 const changes=Object.keys(patch).filter(c=>patch[c]!==stored[c]);
 return{patch,errors,changes};
}

const yes=(v:string)=>v==='yes';
const nullable=(v:string)=>v===''?null:v;
/**
 * THE MERGED WRITER. `patch` holds only the columns to change; everything else is carried from the row as
 * it stands under the caller's lock. Group order: bank → registration numbers → EPF/SOCSO/EIS row → tax →
 * Others Statutory → payment method (bank before payment method so Bank Transfer always has a bank).
 */
export async function applyBankStatutoryPatchTx(tx:Tx,ctx:SessionContext,subject:BankStatutorySubject,patch:BankStatutoryPatch){
 const has=(cols:readonly string[])=>cols.some(c=>c in patch);
 const statutory=subject.pack.statutory,personId=subject.personId;
 const merged=async()=>{const read=await readBankStatutoryStateTx(tx,ctx,subject,{lock:true});const m:BankStatutoryState={...read.state};for(const[c,v]of Object.entries(patch))m[c]=v??'';return{...read,stored:read.state,m};};
 let current=await merged();
 if(!current.row)refuse('This employee has no statutory record yet — save their identity number on their Personnel record first, then re-run this file');
 const errors=bankStatutoryMergedErrors(subject,current.stored,patch);if(errors.length)refuse(errors.join('; '));
 if(has(BANK_COLUMNS)){
  const m=current.m;
  await statutory.setBank(ctx,{personId,bankName:nullable(m.bank_name),bankAccountNo:nullable(m.bank_account_no),enableCustomHolderName:yes(m.enable_custom_holder_name),customHolderName:nullable(m.custom_holder_name),enableCustomHolderId:yes(m.enable_custom_holder_id),customHolderId:nullable(m.custom_holder_id)},tx);
 }
 if(has(REGISTRATION_COLUMNS)){
  if(!statutory.setRegistrationNumbers)refuse('Registration-number updates are unavailable for this country pack.');
  await statutory.setRegistrationNumbers!(ctx,{personId,...('epf_number' in patch?{epfNumber:patch.epf_number??null}:{}),...('socso_number' in patch?{socsoNumber:patch.socso_number??null}:{})},tx);
 }
 if(has(STATUTORY_ROW_COLUMNS)){
  current=await merged();const row=current.row!,m=current.m;
  const money=(v:unknown)=>v!=null?Number(v):null;
  await statutory.set(ctx,{
   personId,icNumber:row.icNumber,epfNumber:row.epfNumber??undefined,socsoNumber:row.socsoNumber??undefined,
   // The full-row setter also writes these; carried from the locked row exactly as the EPF card does.
   taxNumber:row.taxNumber??undefined,taxCategory:row.taxCategory??1,numChildren:row.numChildren??0,isResident:row.isResident??true,
   socsoCategory:m.socso_category||'auto',eisCategory:m.eis_category==='none'?'none':'auto',
   subjectToSkbbk:yes(m.subject_to_skbbk),employerBearsSocso:yes(m.employer_bears_socso),employerBearsEis:yes(m.employer_bears_eis),employerBearsSkbbk:yes(m.employer_bears_skbbk),employerBearsEpf:yes(m.employer_bears_epf),
   epfCitizenship:(['citizen','pr','non_citizen'].includes(m.epf_citizenship)?m.epf_citizenship:'citizen') as 'citizen'|'pr'|'non_citizen',
   ...retainLegacyTotalTopup(mapEpfUiMode(m.epf_category||'auto',m.epf_employee_rate||null,m.epf_employer_rate||null,m.epf_employee_amount||null,m.epf_employer_amount||null,m.epf_manual_reason||null),row),
   bankName:row.bankName??undefined,bankAccountNo:row.bankAccountNo??undefined,
   tp3Year:row.tp3Year??null,tp3NetRemuneration:money(row.tp3NetRemuneration),tp3EpfClaimed:money(row.tp3EpfClaimed),tp3PcbPaid:money(row.tp3PcbPaid),tp3ZakatPaid:money(row.tp3ZakatPaid),
   zakatActive:row.zakatActive??false,zakatState:row.zakatState??null,zakatMethod:row.zakatMethod??null,zakatPercent:money(row.zakatPercent),zakatFixed:money(row.zakatFixed),zakatEffectiveFrom:row.zakatEffectiveFrom??null,zakatEffectiveTo:row.zakatEffectiveTo??null,
  },tx);
 }
 if(Object.keys(patch).some(isTaxColumn)){
  current=await merged();const row=current.row!,m=current.m,stored=current.stored;
  const circumstanceSupplied='tax_circumstance' in patch;
  const crossesNone=circumstanceSupplied&&(stored.tax_circumstance==='none')!==(m.tax_circumstance==='none');
  const scoped='tax_residency' in patch||crossesNone;
  const base={personId,taxNumber:nullable(m.tax_number),taxCategory:Number(m.tax_category)||1,numChildren:Number(m.num_children)||0,childReliefMode:m.child_relief_mode||'manual',
   employerBearsTax:yes(m.employer_bears_tax),disabledIndividual:yes(m.disabled_individual),disabledSpouse:yes(m.disabled_spouse),childReliefTable:childReliefTableFrom(m),
   ...(circumstanceSupplied?{taxCircumstance:nullable(m.tax_circumstance)}:{})};
  if(scoped){
   const[e]=await tx.select({companyId:employment.companyId}).from(employment).where(and(eq(employment.id,subject.employmentId),eq(employment.tenantId,ctx.tenantId)));
   const scheme=m.tax_circumstance==='none'?'none':m.tax_residency;
   if(!scheme)refuse(`${label('tax_residency')}: required to change this employee's income tax selection`);
   await statutory.setTax(ctx,{...base,employmentId:subject.employmentId,expectedCompanyId:e?.companyId??'',expectedApplicabilityEpoch:row.taxApplicabilityEpoch??0,taxResidency:scheme},tx);
  }else await statutory.setTax(ctx,{...base,taxResidency:row.taxResidency??null},tx);
 }
 if(has(OTHERS_COLUMNS)){const v=patch.subject_to_hrdf;await statutory.setOthersStatutory(ctx,{personId,subjectToHrdf:v==='yes'?true:v==='no'?false:null},tx);}
 if('payment_method' in patch){
  // 524303d9 — "" is the tab's own "Not set" choice (the Payroll tab's select offers it and the owner
  // accepts null), so a revert restores it. An import never reaches here with "": a blank cell is never patched.
  const v=patch.payment_method??'';
  if(v==='')await setEmploymentPaymentMethod(ctx,{employmentId:subject.employmentId,paymentMethod:null},tx);
  else{if(!isPaymentMethod(v))refuse(`${label('payment_method')}: use one of the listed payment methods`);
   await applyPersonnelOperationalValuesTx(tx,ctx,subject.employmentId,{paymentMethod:v as Parameters<typeof applyPersonnelOperationalValuesTx>[3]['paymentMethod']});}
 }
}

/** Field-level before/after of one employee: only the columns whose value differs. */
export function bankStatutoryDiff(before:BankStatutoryState,after:BankStatutoryState){
 const changed=BANK_STATUTORY_STATE_COLUMNS.filter(c=>(before[c]??'')!==(after[c]??''));
 return{changed,before:Object.fromEntries(changed.map(c=>[c,before[c]??''])),after:Object.fromEntries(changed.map(c=>[c,after[c]??'']))};
}

// ─── Revert ───────────────────────────────────────────────────────────────────────────────────────────────
const itemState=(value:unknown)=>(value??{fields:{}}) as BankStatutoryItemState;
const shown=(v:string)=>v===''?'(blank)':v;
/** Same writer locks as the import's row transactions, always before the attempt row lock. */
async function lockBankStatutoryWritersTx(tx:Tx,ctx:SessionContext){await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);}
/**
 * Eligible only while every field the import changed still holds exactly the value it set. Restores the
 * recorded "before" values through the merged writer, newest import row first. Nothing the import did not
 * change is touched, so a later edit of another field never blocks or is undone.
 */
export const bankStatutoryRevertHandler:ImportRevertHandler={
 kind:'bank_statutory',
 lock:(tx,ctx)=>lockBankStatutoryWritersTx(tx,ctx),
 async inspect(tx,ctx,items){
  const out:{itemId:string;blockers:string[];restore:unknown}[]=[],fingerprint:Record<string,BankStatutoryState>={};
  for(const i of items){
   const before=itemState(i.before).fields,after=itemState(i.after).fields,blockers:string[]=[];
   const subject=i.employmentId?await bankStatutorySubjectTx(tx,i.employmentId):null;
   const[access]=subject?await tx.execute<{ok:boolean}>(sql`select app.access_workforce_employment(${subject.employmentId}::uuid,'workforce.maintain') as ok`):[];
   if(!subject||!access?.ok)blockers.push('You no longer have permission to maintain this employee.');
   else{
    const{state}=await readBankStatutoryStateTx(tx,ctx,subject);
    fingerprint[i.id]=Object.fromEntries(Object.keys(after).map(c=>[c,state[c]??'']));
    for(const c of Object.keys(after)){
     if((state[c]??'')!==after[c])blockers.push(`${label(c)} has been changed since this import (now ${shown(state[c]??'')}, the import set ${shown(after[c])}).`);
     // 524303d9 — an empty value is restored wherever the tab itself can hold it (payment method "Not set",
     // blank bank, numbers, tax circumstance…). The ONE exception is income tax residency: "" there means the
     // employer-scoped selection is awaiting confirmation, a state only the selection's transition produces —
     // the tab cannot choose it and no owner writes it, so it still blocks.
     else if(before[c]===''&&c==='tax_residency')blockers.push(`${label(c)} was awaiting confirmation before this import. That state cannot be restored; change the residency on the employee's profile instead.`);
    }
    // b6dbadc5 — a Top-up rate recorded as a FULL rate (before additive top-ups, or read from an unconverted
    // legacy row) would be restored as an increment of the same size. Refuse rather than re-price EPF.
    const restored={...state,...before};
    if(restored.epf_category==='voluntary_percentage'&&['epf_category','epf_employee_rate','epf_employer_rate'].some(c=>c in before)&&(restored.epf_employee_rate||restored.epf_employer_rate)&&itemState(i.before).epfTopupBasis!=='additive')
     blockers.push(`${label('epf_category')}: this import was recorded while Top-up rates were full rates, and Top-up rates are now added to the normal EPF rate. Set the EPF election on the employee's record instead.`);
   }
   out.push({itemId:i.id,blockers,restore:{fields:Object.keys(before).map(c=>({field:label(c),value:shown(before[c])}))}});
  }
  return{items:out,fingerprint};
 },
 async apply(tx,ctx,items){
  let fields=0;
  for(const i of [...items].sort((a,b)=>b.ordinal-a.ordinal||b.createdAt.getTime()-a.createdAt.getTime())){
   const subject=await bankStatutorySubjectTx(tx,i.employmentId!);if(!subject)throw new ImportHistoryError('An employee in this import is no longer available.');
   const before=itemState(i.before).fields;
   try{await applyBankStatutoryPatchTx(tx,ctx,subject,before);}
   catch(error){const message=bankStatutoryRefusal(error);if(message)throw new ImportHistoryError(`${i.label}: ${message}`);throw error;}
   fields+=Object.keys(before).length;
  }
  return{employees:items.length,fields};
 },
};

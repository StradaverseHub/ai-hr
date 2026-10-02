/** The Income Tax Resident field owns the scoped scheme; legacy approvals are conversion evidence only. */
import {and,eq,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {assignment,company,employment,employeeStatutoryMy,employmentTaxSchemeMy,employmentTaxSelectionMy,payrollBatch} from '../../db/schema';
import {employedByCompanyDuring} from '../../core/employment-company';
import type {PcbCalculationScheme} from './payroll';
export const TAX_SELECTION_SCHEMES=['resident','non_resident','rep','knowledge_worker','c_suite'] as const;
export type TaxSelectionCode='confirmation_required'|'invalid_scheme'|'citizenship_unknown'|'not_resident'|'not_found'|'invalid_period'|'stale_context';
export class TaxSelectionError extends Error {
 constructor(public readonly code:TaxSelectionCode,public readonly details?:{configuredScheme:PcbCalculationScheme;effectiveScheme?:PcbCalculationScheme}){super(`PCB selected category: ${code}`);this.name='TaxSelectionError';}
}
const idOk=(s:string)=>/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(s);
const periodOk=(s:string)=>/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const selectedSchemeOk=(s:unknown):s is PcbCalculationScheme=>typeof s==='string'&&(TAX_SELECTION_SCHEMES as readonly string[]).includes(s);
function legacyOf(value:string|null|undefined,resident:boolean|null|undefined){return value==='resident'&&resident===false?'non_resident':value??(resident===false?'non_resident':'resident');}
async function lock(tx:Tx,tenantId:string,employmentId:string){await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId+employmentId+'tax-scheme'},0))`);}
export async function taxSelectionContextMY(tx:Tx,ctx:SessionContext,employmentId:string,write=false,payrollBatchId?:string){
 if(!idOk(employmentId)||payrollBatchId!==undefined&&!idOk(payrollBatchId))throw new TaxSelectionError('not_found');
 let batch:{companyId:string;payPeriod:string}|undefined;
 if(payrollBatchId){const [b]=await tx.select({companyId:payrollBatch.companyId,payPeriod:payrollBatch.payPeriod}).from(payrollBatch).where(and(eq(payrollBatch.id,payrollBatchId),eq(payrollBatch.tenantId,ctx.tenantId))).limit(1).for('share');if(!b||!periodOk(b.payPeriod))throw new TaxSelectionError('not_found');batch=b;}
 const [e]=await tx.select({employmentId:employment.id,personId:employment.personId,employeeCode:employment.employeeCode,currentCompanyId:employment.companyId}).from(employment).where(and(eq(employment.id,employmentId),eq(employment.tenantId,ctx.tenantId))).limit(1).for(write?'update':'share');
 if(!e)throw new TaxSelectionError('not_found');
 const companyId=batch?.companyId??e.currentCompanyId;
 const allowed=await tx.execute(sql`SELECT ${write?sql`app.is_admin_for(${companyId}::uuid) AND app.is_admin_for(${e.currentCompanyId}::uuid)`:sql`app.can_admin_payroll_for(${companyId}::uuid) AND app.can_admin_payroll_for(${e.currentCompanyId}::uuid)`} AS ok`);
 if(allowed[0]?.ok!==true)throw new TaxSelectionError('not_found');
 const [c]=await tx.select({companyName:company.legalName}).from(company).where(and(eq(company.id,companyId),eq(company.tenantId,ctx.tenantId),eq(company.country,'MY'))).limit(1);if(!c)throw new TaxSelectionError('not_found');
 if(batch){const [y,m]=batch.payPeriod.split('-').map(Number);const [member]=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.id,e.employmentId),employedByCompanyDuring(companyId,`${batch.payPeriod}-01`,`${batch.payPeriod}-${new Date(Date.UTC(y,m,0)).getUTCDate()}`))).limit(1);if(!member)throw new TaxSelectionError('not_found');}
 return {...e,...c,companyId,payPeriod:batch?.payPeriod,payrollBatchId};
}
/** Same deterministic initialization for an authorized HR view; bulk conversion runs in migration0505. */
async function initialize(tx:Tx,ctx:SessionContext,e:{employmentId:string;personId:string;companyId:string;currentCompanyId:string}){
 const [old]=await tx.select().from(employmentTaxSelectionMy).where(and(eq(employmentTaxSelectionMy.tenantId,ctx.tenantId),eq(employmentTaxSelectionMy.employmentId,e.employmentId),eq(employmentTaxSelectionMy.companyId,e.companyId))).limit(1);if(old)return old;
 const [profile]=await tx.select().from(employeeStatutoryMy).where(and(eq(employeeStatutoryMy.tenantId,ctx.tenantId),eq(employeeStatutoryMy.personId,e.personId))).limit(1).for('share');
 const legacy=legacyOf(profile?.taxResidency,profile?.isResident);
 const current=await tx.select({companyId:employment.companyId}).from(employment).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.personId,e.personId),isNull(employment.terminatedOn)));
 const assignments=await tx.select({companyId:assignment.companyId}).from(assignment).where(and(eq(assignment.tenantId,ctx.tenantId),eq(assignment.employmentId,e.employmentId),isNull(assignment.supersededAt)));
 const declarations=await tx.select({id:employmentTaxSchemeMy.id,scheme:employmentTaxSchemeMy.scheme,validFrom:employmentTaxSchemeMy.validFrom,validTo:employmentTaxSchemeMy.validTo}).from(employmentTaxSchemeMy).where(and(eq(employmentTaxSchemeMy.tenantId,ctx.tenantId),eq(employmentTaxSchemeMy.employmentId,e.employmentId),eq(employmentTaxSchemeMy.companyId,e.companyId),isNull(employmentTaxSchemeMy.archivedAt),sql`(EXISTS (SELECT 1 FROM assignment a WHERE a.employment_id=${e.employmentId}::uuid AND a.tenant_id=${ctx.tenantId}::uuid AND a.company_id=${e.companyId}::uuid AND a.superseded_at IS NULL AND a.valid_from <= (to_date(${employmentTaxSchemeMy.validTo}||'-01','YYYY-MM-DD')+interval '1 month'-interval '1 day')::date AND (a.valid_to IS NULL OR a.valid_to > to_date(${employmentTaxSchemeMy.validFrom}||'-01','YYYY-MM-DD'))) OR EXISTS (SELECT 1 FROM employment e WHERE e.id=${e.employmentId}::uuid AND e.tenant_id=${ctx.tenantId}::uuid AND e.company_id=${e.companyId}::uuid AND e.hired_on <= (to_date(${employmentTaxSchemeMy.validTo}||'-01','YYYY-MM-DD')+interval '1 month'-interval '1 day')::date AND (e.terminated_on IS NULL OR e.terminated_on>=to_date(${employmentTaxSchemeMy.validFrom}||'-01','YYYY-MM-DD'))))`));
 const overlapping=declarations.some((d,i)=>declarations.slice(i+1).some(other=>d.validFrom<=other.validTo&&other.validFrom<=d.validTo));
 const needs=legacy==='resident'||legacy==='non_resident'?declarations.length>0:!['rep','knowledge_worker'].includes(legacy)||e.companyId!==e.currentCompanyId||new Set(current.map(x=>x.companyId)).size!==1||new Set(assignments.map(x=>x.companyId)).size>1||declarations.some(d=>d.scheme!==legacy)||overlapping;
 const [row]=await tx.insert(employmentTaxSelectionMy).values({tenantId:ctx.tenantId,employmentId:e.employmentId,companyId:e.companyId,scheme:selectedSchemeOk(legacy)?legacy:null,transitionState:needs?'confirmation_required':'resolved',legacyScheme:legacy,source:'legacy_conversion',provenance:{reason:needs?'legacy_context_ambiguous':'legacy_unambiguous',declarationIds:declarations.map(d=>d.id).sort()},updatedByUserId:ctx.userId}).onConflictDoNothing().returning();
 if(row)return row;
 const [existing]=await tx.select().from(employmentTaxSelectionMy).where(and(eq(employmentTaxSelectionMy.tenantId,ctx.tenantId),eq(employmentTaxSelectionMy.employmentId,e.employmentId),eq(employmentTaxSelectionMy.companyId,e.companyId))).limit(1);return existing;
}
export async function getTaxSelectionMY(ctx:SessionContext,employmentId:string,payrollBatchId?:string){
 return withTenant(ctx,async tx=>{const e=await taxSelectionContextMY(tx,ctx,employmentId,false,payrollBatchId);await lock(tx,ctx.tenantId,e.employmentId);
 let [selection]=await tx.select().from(employmentTaxSelectionMy).where(and(eq(employmentTaxSelectionMy.tenantId,ctx.tenantId),eq(employmentTaxSelectionMy.employmentId,e.employmentId),eq(employmentTaxSelectionMy.companyId,e.companyId))).limit(1);
 if(!selection){const permission=await tx.execute(sql`SELECT app.is_admin_for(${e.companyId}::uuid) AND app.is_admin_for(${e.currentCompanyId}::uuid) AS ok`);if(permission[0]?.ok===true)selection=await initialize(tx,ctx,e);}
 return {...e,scheme:selection?.scheme??null,transitionState:selection?.transitionState??'confirmation_required',version:selection?.version??0};});
}
export async function saveTaxSelectionMYTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;personId?:string;scheme:string;expectedCompanyId:string;expectedVersion?:number;payrollBatchId?:string;expectedPayPeriod?:string}){
 if(!selectedSchemeOk(p.scheme))throw new TaxSelectionError('invalid_scheme');
 const e=await taxSelectionContextMY(tx,ctx,p.employmentId,true,p.payrollBatchId);
 if(p.personId&&p.personId!==e.personId)throw new TaxSelectionError('not_found');
 if(e.companyId!==p.expectedCompanyId||p.payrollBatchId&&e.payPeriod!==p.expectedPayPeriod)throw new TaxSelectionError('stale_context');
 await lock(tx,ctx.tenantId,e.employmentId);
 const [profile]=await tx.select({citizenship:employeeStatutoryMy.epfCitizenship}).from(employeeStatutoryMy).where(and(eq(employeeStatutoryMy.personId,e.personId),eq(employeeStatutoryMy.tenantId,ctx.tenantId))).limit(1).for('share');
 if(p.scheme==='c_suite'&&!['pr','non_citizen'].includes(profile?.citizenship??''))throw new TaxSelectionError('citizenship_unknown',{configuredScheme:p.scheme});
 const before=await initialize(tx,ctx,e);
 if(p.expectedVersion!==undefined&&p.expectedVersion!==before.version)throw new TaxSelectionError('stale_context');
 const [after]=await tx.update(employmentTaxSelectionMy).set({scheme:p.scheme,transitionState:'resolved',version:before.version+1,updatedAt:sql`now()`,updatedByUserId:ctx.userId}).where(eq(employmentTaxSelectionMy.id,before.id)).returning();
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment-tax-selection',aggregateId:after.id,eventType:'employee.tax-scheme.selected',actor:actorOf(ctx),subjectEmploymentId:e.employmentId,payload:{employmentId:e.employmentId,companyId:e.companyId,selectionId:after.id,before:{scheme:before.scheme,transitionState:before.transitionState,version:before.version},after:{scheme:after.scheme,transitionState:after.transitionState,version:after.version},eligibilityDecision:'income_tax_resident_selection'}});
 return after;
}
export async function saveTaxSelectionMY(ctx:SessionContext,p:Parameters<typeof saveTaxSelectionMYTx>[2]){return withTenant(ctx,tx=>saveTaxSelectionMYTx(tx,ctx,p));}
export async function resolveTaxSelectionMY(tx:Tx,p:{tenantId:string;employmentId:string;companyId:string;payPeriod:string;legacyScheme?:string|null;resident?:boolean;epfCitizenship?:string|null}):Promise<{scheme:PcbCalculationScheme;declarationId?:string;selectionId:string;selectionVersion:number;selectionSource:'income_tax_resident'}>{
 if(!periodOk(p.payPeriod))throw new TaxSelectionError('invalid_period');
 await lock(tx,p.tenantId,p.employmentId);
 const [row]=await tx.select().from(employmentTaxSelectionMy).where(and(eq(employmentTaxSelectionMy.tenantId,p.tenantId),eq(employmentTaxSelectionMy.employmentId,p.employmentId),eq(employmentTaxSelectionMy.companyId,p.companyId))).limit(1);
 const configured=row?.scheme??legacyOf(p.legacyScheme,p.resident);const details=selectedSchemeOk(configured)?{configuredScheme:configured}:undefined;
 if(!row||row.transitionState!=='resolved')throw new TaxSelectionError('confirmation_required',details);
 if(!selectedSchemeOk(row.scheme))throw new TaxSelectionError('invalid_scheme',details);
 if(row.scheme==='c_suite'){
  const [identity]=await tx.select({personId:employment.personId}).from(employment).where(and(eq(employment.id,p.employmentId),eq(employment.tenantId,p.tenantId))).limit(1);
  if(!identity)throw new TaxSelectionError('not_found');
  const [profile]=await tx.select({citizenship:employeeStatutoryMy.epfCitizenship}).from(employeeStatutoryMy).where(and(eq(employeeStatutoryMy.personId,identity.personId),eq(employeeStatutoryMy.tenantId,p.tenantId))).limit(1).for('share');
  if(!['pr','non_citizen'].includes(profile?.citizenship??''))throw new TaxSelectionError('citizenship_unknown',{configuredScheme:row.scheme});
 }
 return {scheme:row.scheme,selectionId:row.id,selectionVersion:row.version,selectionSource:'income_tax_resident'};
}
/** Hiring supplies explicit initial normal/nonresident intent in the SAME employment transaction. */
export async function initializeHiredTaxSelectionMYTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;companyId:string;scheme:'resident'|'non_resident'}){
 const e=await taxSelectionContextMY(tx,ctx,p.employmentId,true);
 if(e.companyId!==p.companyId)throw new TaxSelectionError('stale_context');
 await lock(tx,ctx.tenantId,e.employmentId);
 const [row]=await tx.insert(employmentTaxSelectionMy).values({tenantId:ctx.tenantId,employmentId:e.employmentId,companyId:e.companyId,scheme:p.scheme,transitionState:'resolved',source:'explicit',provenance:{reason:'initial_hire_selection',declarationIds:[]},updatedByUserId:ctx.userId}).returning();
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment-tax-selection',aggregateId:row.id,eventType:'employee.tax-scheme.selected',actor:actorOf(ctx),subjectEmploymentId:e.employmentId,payload:{employmentId:e.employmentId,companyId:e.companyId,selectionId:row.id,before:null,after:{scheme:row.scheme,transitionState:row.transitionState,version:row.version},eligibilityDecision:'initial_hire_selection'}});
 return row;
}

/** Canonical company writers supply their locked before-company after writing the new dated relation. */
export async function initializeTransferredTaxSelectionMYTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;fromCompanyId:string;companyId:string}){
 const e=await taxSelectionContextMY(tx,ctx,p.employmentId,true);
 if(e.companyId!==p.companyId||p.fromCompanyId===p.companyId||!idOk(p.fromCompanyId))throw new TaxSelectionError('stale_context');
 const permitted=await tx.execute(sql`SELECT app.is_admin_for(${p.fromCompanyId}::uuid) AND app.is_admin_for(${p.companyId}::uuid) AS ok`);
 if(permitted[0]?.ok!==true)throw new TaxSelectionError('not_found');
 const [from]=await tx.select({country:company.country}).from(company).where(and(eq(company.id,p.fromCompanyId),eq(company.tenantId,ctx.tenantId))).limit(1);
 if(!from)throw new TaxSelectionError('not_found');
 const [membership]=await tx.select({id:assignment.id}).from(assignment).where(and(eq(assignment.tenantId,ctx.tenantId),eq(assignment.employmentId,e.employmentId),eq(assignment.companyId,p.companyId),isNull(assignment.supersededAt),isNull(assignment.validTo))).limit(1);
 if(!membership)throw new TaxSelectionError('not_found');
 await lock(tx,ctx.tenantId,e.employmentId);
 const [existing]=await tx.select().from(employmentTaxSelectionMy).where(and(eq(employmentTaxSelectionMy.tenantId,ctx.tenantId),eq(employmentTaxSelectionMy.employmentId,e.employmentId),eq(employmentTaxSelectionMy.companyId,p.companyId))).limit(1);
 if(existing)return existing;
 let scheme:'resident'|'non_resident'='resident';
 let sourceSelectionId:string|undefined;
 if(from.country==='MY'){
  // Conversion is only for a genuinely missing pre-cutover source context, never a live competing flag.
  const source=await initialize(tx,ctx,{...e,companyId:p.fromCompanyId});
  if(source.transitionState!=='resolved')throw new TaxSelectionError('confirmation_required',selectedSchemeOk(source.scheme)?{configuredScheme:source.scheme}:undefined);
  if(!selectedSchemeOk(source.scheme))throw new TaxSelectionError('invalid_scheme');
  scheme=source.scheme==='non_resident'?'non_resident':'resident';
  sourceSelectionId=source.id;
 }
 const provenance={reason:'ordinary_new_employer_default',declarationIds:[] as string[],fromCompanyId:p.fromCompanyId,...(sourceSelectionId?{sourceSelectionId}:{})};
 const [created]=await tx.insert(employmentTaxSelectionMy).values({tenantId:ctx.tenantId,employmentId:e.employmentId,companyId:p.companyId,scheme,transitionState:'resolved',source:'explicit',provenance,updatedByUserId:ctx.userId}).onConflictDoNothing().returning();
 if(!created){const [winner]=await tx.select().from(employmentTaxSelectionMy).where(and(eq(employmentTaxSelectionMy.tenantId,ctx.tenantId),eq(employmentTaxSelectionMy.employmentId,e.employmentId),eq(employmentTaxSelectionMy.companyId,p.companyId))).limit(1);return winner;}
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment-tax-selection',aggregateId:created.id,eventType:'employee.tax-scheme.selected',actor:actorOf(ctx),subjectEmploymentId:e.employmentId,payload:{employmentId:e.employmentId,companyId:p.companyId,selectionId:created.id,before:null,after:{scheme:created.scheme,transitionState:created.transitionState,version:created.version},eligibilityDecision:'ordinary_new_employer_default',fromCompanyId:p.fromCompanyId}});
 return created;
}

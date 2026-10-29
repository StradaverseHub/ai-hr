/** Human-reviewed human Personnel EPF/SOCSO section source. No country import, model arithmetic,
 * default-country routing, direct Identity/Tax/Bank/TP3/Zakat edits, or automatic payroll calculation. */
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {company,employment} from '../../db/schema';
import type {SessionContext,Tx} from '../../db/client';
import {requirePackFor} from '../../localization/registry';
import {withAgentActionGuard} from './agent-action-guard';
import {assertModuleEnabled} from '../entitlements';
import {masterReportFieldsTx,MasterReportAccessError} from '../employee-master-access';
import {lockLeaveDependenciesTx,lockLeaveDependencyConfigurationTx} from '../leave-dependency-lock';
import {REVIEWED_COUNTRY_STATUTORY_ACTION as action,ReviewedCountryStatutoryHumanContent as Human,ReviewedCountryStatutoryConfirmation as Confirmation,ReviewedCountryStatutoryPreparedSource as Prepared,ReviewedCountryStatutorySourceReceipt as Receipt} from '../../lib/assistant-actions/reviewed-country-statutory-contract';
export class ReviewedCountryStatutoryUnavailable extends Error{constructor(){super('That statutory update needs a fresh look. Please reopen the Personnel record.');this.name='ReviewedCountryStatutoryUnavailable';}}
const fail=():never=>{throw new ReviewedCountryStatutoryUnavailable();},capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))}),hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function assertReviewedCountryStatutoryActorTx(tx:Tx,ctx:SessionContext){ctx=capture(ctx);await tx.execute(sql`select app.access_workforce_write_lock()`);const fresh=await withAgentActionGuard(tx,ctx,action,'approve');assertModuleEnabled(fresh,'payroll');return fresh;}
/** Source selection carries no private field values. Actual shared-person native tuple ownership is
 * acquired by the country pack before statutory facts; this prefix supplies no role or row grant. */
async function source(tx:Tx,ctx:SessionContext,id:string){
 await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
 const [row]=await tx.select({employmentId:employment.id,personId:employment.personId,companyId:company.id,country:company.country}).from(employment).innerJoin(company,and(eq(company.id,employment.companyId),eq(company.tenantId,ctx.tenantId))).where(and(eq(employment.id,id),eq(employment.tenantId,ctx.tenantId),sql`app.is_admin() and app.can_see_person(${employment.personId}) and app.is_admin_for(${company.id}) and app.can_admin_payroll_employment(${employment.id}) and app.access_workforce_employment(${employment.id},'workforce.maintain')`));
 if(!row)return fail();await lockLeaveDependenciesTx(tx,ctx.tenantId,[row.employmentId]);
 // Sensitive full-set categories use the existing company-scoped granular resolver, not a union of
 // role names across companies. Read the private full snapshot only after each category is permitted.
 const fields=await masterReportFieldsTx(tx,ctx,[row.companyId]);for(const sensitivity of ['identity','bank','statutory','payroll'] as const)if(!fields.some(field=>field.sensitivity===sensitivity))return fail();
 const pack=requirePackFor(row.country);if(pack.country!=='MY'||!pack.statutory.reviewed)return fail();return {row,owner:pack.statutory.reviewed};
}
function packet(binding:{employmentId:string;personId:string;companyId:string;country:string},native:Awaited<ReturnType<NonNullable<ReturnType<typeof requirePackFor>['statutory']['reviewed']>['prepare']>>,content:z.infer<typeof Human>){
 if(native.input.personId!==binding.personId)return fail();return Prepared.parse({kind:'prepared_source',content,review:{...native.review,...binding,country:'MY'},reviewedDigest:hash([1,action,binding,native.reviewedDigest,content]),consequence:'person_statutory_profile_saved_not_payroll_recalculated_or_paid'});
}
export async function prepareReviewedCountryStatutorySourceTx(tx:Tx,supplied:SessionContext,value:unknown){const ctx=capture(supplied);try{const content=Human.parse(structuredClone(value)),fresh=await assertReviewedCountryStatutoryActorTx(tx,ctx),{row,owner}=await source(tx,fresh,content.employmentId);if(typeof content.input.personId!=='string'||content.input.personId.toLowerCase()!==row.personId)return fail();const native=await owner.prepare(tx,fresh,content.input);return packet(row,native,content);}catch{return fail();}}
/** Entire enclosing top-level transaction must roll back on any refusal or storage failure. */
export async function confirmReviewedCountryStatutorySourceTx(tx:Tx,supplied:SessionContext,value:unknown,confirmationValue:unknown){const ctx=capture(supplied);try{const content=Human.parse(structuredClone(value)),expected=Confirmation.parse(structuredClone(confirmationValue)),fresh=await assertReviewedCountryStatutoryActorTx(tx,ctx),{row,owner}=await source(tx,fresh,content.employmentId);if(typeof content.input.personId!=='string'||content.input.personId.toLowerCase()!==row.personId)return fail();const native=await owner.prepare(tx,fresh,content.input);if(packet(row,native,content).reviewedDigest!==expected.reviewedDigest)return fail();const done=await owner.confirm(tx,fresh,content.input,native.reviewedDigest),current=await owner.readReference(tx,fresh,{personId:done.personId,statutoryId:done.statutoryId,eventId:done.eventId});return Receipt.parse({kind:'saved',...row,country:'MY',...current,scope:'shared_person_across_employments',semantics:'profile_saved_not_payroll_recalculated_or_paid',replayed:false});}catch{return fail();}}
export async function reconcileReviewedCountryStatutorySourceTx(tx:Tx,supplied:SessionContext,value:unknown){const ctx=capture(supplied);try{const p=Receipt.pick({employmentId:true,personId:true,statutoryId:true,eventId:true}).strict().parse(structuredClone(value)),fresh=await assertReviewedCountryStatutoryActorTx(tx,ctx),{row,owner}=await source(tx,fresh,p.employmentId);if(row.personId!==p.personId.toLowerCase())return fail();const current=await owner.readReference(tx,fresh,{personId:p.personId,statutoryId:p.statutoryId,eventId:p.eventId});return Receipt.parse({kind:'saved',...row,country:'MY',...current,scope:'shared_person_across_employments',semantics:'profile_saved_not_payroll_recalculated_or_paid',replayed:true});}catch{return fail();}}

/** True current native field/company/person/profile ownership precedes any custody row or body.
 * This nomination contains no preserved statutory values or source revisions. */
export async function withReviewedCountryStatutoryIntervalTx<T>(tx:Tx,supplied:SessionContext,employmentId:string,work:(fresh:SessionContext,binding:{employmentId:string;personId:string;companyId:string;country:'MY';statutoryId:string})=>Promise<T>):Promise<T>{
 const ctx=capture(supplied),id=z.guid().parse(employmentId),fresh=await assertReviewedCountryStatutoryActorTx(tx,ctx),{row,owner}=await source(tx,fresh,id),native=await owner.lockSubject(tx,fresh,row.personId);if(native.personId!==row.personId)return fail();return work(fresh,{...row,country:'MY',statutoryId:native.statutoryId});
}

/** Metadata-only bounded human picker; no profile/salary snapshot or plaintext before field scope. */
export async function reviewedCountryStatutoryChoiceMetadataTx(tx:Tx,supplied:SessionContext){
 const ctx=capture(supplied),fresh=await assertReviewedCountryStatutoryActorTx(tx,ctx);await lockLeaveDependencyConfigurationTx(tx,fresh.tenantId);
 const companies=await tx.select({id:company.id,country:company.country}).from(company).where(and(eq(company.tenantId,fresh.tenantId),eq(company.country,'MY'),sql`app.is_admin_for(${company.id}) and app.can_admin_payroll_for(${company.id}) and app.access_workforce_company(${company.id},'workforce.maintain')`)).orderBy(company.id).limit(101);if(companies.length>100)return fail();
 const allowed:string[]=[];let owner:NonNullable<ReturnType<typeof requirePackFor>['statutory']['reviewed']>|undefined;
 for(const candidate of companies){let fields;try{fields=await masterReportFieldsTx(tx,fresh,[candidate.id]);}catch(error){if(error instanceof MasterReportAccessError)continue;throw error;}if(!(['identity','bank','statutory','payroll'] as const).every(sensitivity=>fields.some(field=>field.sensitivity===sensitivity)))continue;const pack=requirePackFor(candidate.country);if(pack.country!=='MY'||!pack.statutory.reviewed)continue;owner=pack.statutory.reviewed;allowed.push(candidate.id);}
 if(!owner)return{items:[],truncated:false};const rows=await owner.choices(tx,fresh,allowed,21);return {items:rows.slice(0,20).map(({employmentId,employeeCode,name,companyName})=>({employmentId,employeeCode,name,companyName})),truncated:rows.length>20};
}
export async function readReviewedCountryStatutoryEditableTx(tx:Tx,supplied:SessionContext,employmentId:string){const ctx=capture(supplied),id=z.guid().parse(employmentId);return withReviewedCountryStatutoryIntervalTx(tx,ctx,id,async(fresh,binding)=>{const owner=requirePackFor(binding.country).statutory.reviewed;if(!owner)return fail();const native=await owner.readEditable(tx,fresh,binding.personId),labels=await owner.labels(tx,fresh,binding.employmentId,binding.personId);if(native.personId!==binding.personId||native.statutoryId!==binding.statutoryId)return fail();return{kind:'country_statutory_editable' as const,employmentId:binding.employmentId,personId:binding.personId,country:binding.country,fields:native.fields,labels};});}
export async function readReviewedCountryStatutoryLabelsTx(tx:Tx,supplied:SessionContext,employmentId:string,personId:string){const ctx=capture(supplied),id=z.guid().parse(employmentId),person=z.guid().parse(personId).toLowerCase();return withReviewedCountryStatutoryIntervalTx(tx,ctx,id,async(fresh,binding)=>{if(binding.personId!==person)return fail();const owner=requirePackFor(binding.country).statutory.reviewed;if(!owner)return fail();return owner.labels(tx,fresh,binding.employmentId,binding.personId);});}

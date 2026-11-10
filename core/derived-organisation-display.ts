import {organisationManagedTx} from './organisation-write-policy';
/** Read-only, purpose-authorized organisation metadata for forms and import review. */
import {and,eq,sql} from 'drizzle-orm';
import {businessUnit} from '../db/schema';
import {visibleLabelIdsCondition} from './system-labels';
import type {SessionContext,Tx} from '../db/client';
import {withPersonnelRead} from './personnel-read-bounds';
import {isCalendarDate} from '../lib/calendar-date';
import {todayInKualaLumpur} from '../lib/hr-date';
import {WorkforceAccessError,workforceEmploymentPredicate} from './workforce-access';
import {deriveCompanyOrganisationBatchTx,deriveCompanyOrganisationTx,employmentOrganisationTagsTx,type CompanyOrganisationReference,type CompanyOrganisationTags} from './company-organisation';
export type DerivedOrganisationDisplay=CompanyOrganisationTags&{managed:boolean;businessUnitName:string|null;parentCompanyName:string|null;businessGroupName:string|null;asOf:string};
async function organisationNamesTx(tx:Tx,ctx:SessionContext,tags:CompanyOrganisationTags){
 const [bu]=tags.businessUnitId?await tx.select({name:sql<string>`coalesce(nullif(trim(${businessUnit.label}),''),nullif(trim(${businessUnit.code}),''),${businessUnit.name})`}).from(businessUnit).where(and(eq(businessUnit.id,tags.businessUnitId),eq(businessUnit.tenantId,ctx.tenantId),visibleLabelIdsCondition(businessUnit,'business_unit',[tags.companyId]))):[];
 const [row]=await tx.execute<{parentCompanyName:string|null;businessGroupName:string|null}>(sql`select
 (select c.legal_name from company c where c.id=${tags.parentCompanyId}::uuid and c.tenant_id=${ctx.tenantId}::uuid and app.access_workforce_company(c.id,'workforce.view')) as "parentCompanyName",
 (select c.legal_name from company c where c.id=${tags.businessGroupId}::uuid and c.tenant_id=${ctx.tenantId}::uuid and app.access_workforce_company(c.id,'workforce.view')) as "businessGroupName"`);
 return {...row,businessUnitName:bu?.name??null};
}
export async function organisationDisplayTx(tx:Tx,ctx:SessionContext,tags:CompanyOrganisationTags,asOf:string):Promise<DerivedOrganisationDisplay>{
 const {businessUnitName,...companyNames}=await organisationNamesTx(tx,ctx,tags);
 return {...tags,...companyNames,managed:await organisationManagedTx(tx),businessUnitName,asOf};
}
export function derivedOrganisationForForm(ctx:SessionContext,p:{companyId?:string;employmentId?:string;asOf?:string}){
 const {companyId,employmentId,asOf:requestedOn}=p;
 const targetId=employmentId||companyId;
 return withPersonnelRead(ctx,async tx=>{
  let asOf=requestedOn??todayInKualaLumpur();
  if(!isCalendarDate(asOf))throw new Error('Select a valid organisation reference date.');
  if(!targetId)throw new Error('Select an available company.');

  // The form requires the same native maintenance capability as before. The display
  // reads that permission and the dated facts from one database-enforced snapshot.
  const allowed=employmentId
   ? workforceEmploymentPredicate(sql`${employmentId}::uuid`,'maintain')
   : sql`app.access_workforce_company(${targetId}::uuid,'workforce.maintain')`;
  const [scope]=await tx.execute<{allowed:boolean}>(sql`select ${allowed} as allowed`);
  if(!scope?.allowed)throw new WorkforceAccessError();

  if(employmentId){
   if(!requestedOn){
    const [row]=await tx.execute<{hiredOn:string}>(sql`select hired_on::text as "hiredOn" from employment where id=${employmentId}::uuid and tenant_id=${ctx.tenantId}::uuid`);
    if(!row)throw new Error('Employment is unavailable.');
    asOf=row.hiredOn;
   }
   const tags=await employmentOrganisationTagsTx(tx,ctx,{employmentId,asOf});
   return organisationDisplayTx(tx,ctx,tags,asOf);
  }
  const tags=await deriveCompanyOrganisationTx(tx,ctx,{companyId:targetId,asOf});
  return organisationDisplayTx(tx,ctx,tags,asOf);
 });
}
type OrganisationImportReference=CompanyOrganisationReference&{businessUnit?:string;parentCompany?:string};
type OrganisationNames=Awaited<ReturnType<typeof organisationNamesTx>>;
function importWarnings(p:OrganisationImportReference,tags:CompanyOrganisationTags,managed:boolean,display:OrganisationNames|null){
 const warnings:string[]=[];
 if(!display){
  if(managed)warnings.push('No reviewed mapping applies on '+p.asOf+'; manual organisation values are ignored and no historical Business Unit is invented.');
  if(p.parentCompany?.trim())warnings.push('parent_company: imported value ignored; parent company changes require the Group structure owner (legacy configuration, '+p.asOf+').');
  return {tags,managed,warnings};
 }
 const version=tags.mappingVersionId??'pending';
 warnings.push(`Group structure reference: version ${version}; effective date ${p.asOf}; Business Unit ${display.businessUnitName??'unassigned'}; parent ${display.parentCompanyName??(tags.parentCompanyId?'restricted company':'top-level company')}; group ${display.businessGroupName??'unavailable'}.`);
 if(p.businessUnit?.trim())warnings.push(`business_unit: imported value ignored; set from Group structure to ${display.businessUnitName??(tags.businessUnitId?'Assigned Business Unit':'Company not in Group structure')} (version ${version}, ${p.asOf}).`);
 if(p.parentCompany?.trim())warnings.push(`parent_company: imported value ignored; set from Group structure to ${display.parentCompanyName??tags.parentCompanyId??(tags.status==='ready'?'Top-level company — no parent':'Company not in Group structure')} (version ${version}, ${p.asOf}).`);
 if(tags.status==='pending')warnings.push(`Company not in Group structure; organisation tagging is pending and Rewards/payroll grouping is blocked (version ${version}, ${p.asOf}).`);
 return {tags,managed,warnings};
}
export async function organisationImportWarningsTx(tx:Tx,ctx:SessionContext,p:OrganisationImportReference){
 const tags=await deriveCompanyOrganisationTx(tx,ctx,p),managed=await organisationManagedTx(tx);
 const display=tags.status==='legacy'?null:await organisationNamesTx(tx,ctx,tags);
 return importWarnings(p,tags,managed,display);
}
/** Share dated facts only inside this analysis and format warnings independently for each row. */
export async function organisationImportWarningsBatchTx(tx:Tx,ctx:SessionContext,inputs:readonly OrganisationImportReference[]){
 const distinct:CompanyOrganisationReference[]=[];
 const slots=new Map<string,number>();
 const inputSlots=inputs.map(({companyId,asOf})=>{
  const key=`${companyId}:${asOf}`;
  const existing=slots.get(key);
  if(existing!==undefined)return existing;
  const slot=distinct.length;
  slots.set(key,slot);
  distinct.push({companyId,asOf});
  return slot;
 });
 const facts=await deriveCompanyOrganisationBatchTx(tx,distinct);
 const displays:(OrganisationNames|null)[]=[];
 for(const {tags} of facts)displays.push(tags.status==='legacy'?null:await organisationNamesTx(tx,ctx,tags));
 return inputs.map((input,index)=>{
  const slot=inputSlots[index],{tags,managed}=facts[slot];
  return importWarnings(input,tags,managed,displays[slot]);
 });
}

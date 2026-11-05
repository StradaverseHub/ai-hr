import {organisationManagedTx} from './organisation-write-policy';
/** Read-only, purpose-authorized organisation metadata for forms and import review. */
import {and,eq,sql} from 'drizzle-orm';
import {businessUnit} from '../db/schema';
import {visibleLabelIdsCondition} from './system-labels';
import type {SessionContext,Tx} from '../db/client';
import {withTenant} from '../db/client';
import {isCalendarDate} from '../lib/calendar-date';
import {todayInKualaLumpur} from '../lib/hr-date';
import {assertWorkforceCompanyTx,assertWorkforceEmploymentTx} from './workforce-access';
import {deriveCompanyOrganisationTx,employmentOrganisationTagsTx,type CompanyOrganisationTags} from './company-organisation';
export type DerivedOrganisationDisplay=CompanyOrganisationTags&{managed:boolean;businessUnitName:string|null;parentCompanyName:string|null;businessGroupName:string|null;asOf:string};
export async function organisationDisplayTx(tx:Tx,ctx:SessionContext,tags:CompanyOrganisationTags,asOf:string):Promise<DerivedOrganisationDisplay>{
 const [bu]=tags.businessUnitId?await tx.select({name:sql<string>`coalesce(nullif(trim(${businessUnit.label}),''),nullif(trim(${businessUnit.code}),''),${businessUnit.name})`}).from(businessUnit).where(and(eq(businessUnit.id,tags.businessUnitId),eq(businessUnit.tenantId,ctx.tenantId),visibleLabelIdsCondition(businessUnit,'business_unit',[tags.companyId]))):[];
 const [row]=await tx.execute<{parentCompanyName:string|null;businessGroupName:string|null}>(sql`select
 (select c.legal_name from company c where c.id=${tags.parentCompanyId}::uuid and c.tenant_id=${ctx.tenantId}::uuid and app.access_workforce_company(c.id,'workforce.view')) as "parentCompanyName",
 (select c.legal_name from company c where c.id=${tags.businessGroupId}::uuid and c.tenant_id=${ctx.tenantId}::uuid and app.access_workforce_company(c.id,'workforce.view')) as "businessGroupName"`);
 return {...tags,...row,managed:await organisationManagedTx(tx),businessUnitName:bu?.name??null,asOf};
}
export function derivedOrganisationForForm(ctx:SessionContext,p:{companyId?:string;employmentId?:string;asOf?:string}){return withTenant(ctx,async tx=>{
 let asOf=p.asOf??todayInKualaLumpur();if(!isCalendarDate(asOf))throw new Error('Select a valid organisation reference date.');
 if(p.employmentId){await assertWorkforceEmploymentTx(tx,ctx,p.employmentId,'maintain');if(!p.asOf){const [row]=await tx.execute<{hiredOn:string}>(sql`select hired_on::text as "hiredOn" from employment where id=${p.employmentId}::uuid and tenant_id=${ctx.tenantId}::uuid`);if(!row)throw new Error('Employment is unavailable.');asOf=row.hiredOn;}return organisationDisplayTx(tx,ctx,await employmentOrganisationTagsTx(tx,ctx,{employmentId:p.employmentId,asOf}),asOf);}
 if(!p.companyId)throw new Error('Select an available company.');await assertWorkforceCompanyTx(tx,ctx,p.companyId,'maintain');
 return organisationDisplayTx(tx,ctx,await deriveCompanyOrganisationTx(tx,ctx,{companyId:p.companyId,asOf}),asOf);
});}
export async function organisationImportWarningsTx(tx:Tx,ctx:SessionContext,p:{companyId:string;asOf:string;businessUnit?:string;parentCompany?:string}){
 const tags=await deriveCompanyOrganisationTx(tx,ctx,p),managed=await organisationManagedTx(tx),warnings:string[]=[];if(tags.status==='legacy'){if(managed)warnings.push('No reviewed mapping applies on '+p.asOf+'; manual organisation values are ignored and no historical Business Unit is invented.');if(p.parentCompany?.trim())warnings.push('parent_company: imported value ignored; parent company changes require the Group structure owner (legacy configuration, '+p.asOf+').');return {tags,managed,warnings};}
 const display=await organisationDisplayTx(tx,ctx,tags,p.asOf),version=tags.mappingVersionId??'pending';
 warnings.push(`Group structure reference: version ${version}; effective date ${p.asOf}; Business Unit ${display.businessUnitName??'unassigned'}; parent ${display.parentCompanyName??(tags.parentCompanyId?'restricted company':'top-level company')}; group ${display.businessGroupName??'unavailable'}.`);
 if(p.businessUnit?.trim())warnings.push(`business_unit: imported value ignored; set from Group structure to ${display.businessUnitName??(tags.businessUnitId?'Assigned Business Unit':'Company not in Group structure')} (version ${version}, ${p.asOf}).`);
 if(p.parentCompany?.trim())warnings.push(`parent_company: imported value ignored; set from Group structure to ${display.parentCompanyName??tags.parentCompanyId??(tags.status==='ready'?'Top-level company — no parent':'Company not in Group structure')} (version ${version}, ${p.asOf}).`);
 if(tags.status==='pending')warnings.push(`Company not in Group structure; organisation tagging is pending and Rewards/payroll grouping is blocked (version ${version}, ${p.asOf}).`);
 return {tags,managed,warnings};
}

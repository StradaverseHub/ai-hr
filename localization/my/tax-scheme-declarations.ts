/** Employer-period incentive approval declarations. HR owns eligibility; payroll consumes the record. */
import {and,desc,eq,gte,isNull,lte,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {company,employment,employeeStatutoryMy,employmentTaxSchemeMy,payrollBatch} from '../../db/schema';
import {employedByCompanyDuring} from '../../core/employment-company';
import {resolvePcbCalculationScheme,type PcbCalculationScheme} from './payroll';

export type IncentiveScheme = 'rep'|'knowledge_worker'|'c_suite';
export type TaxSchemeReadinessCode = 'missing_declaration'|'declaration_revoked'|'declaration_outside_period'|'not_resident'|'citizenship_unknown'|'overlap';
export type TaxSchemeReadinessDetails = {configuredScheme:PcbCalculationScheme;effectiveScheme?:PcbCalculationScheme};
export class TaxSchemeDeclarationError extends Error {
  constructor(public readonly code:string,public readonly details?:TaxSchemeReadinessDetails){super(`PCB tax scheme declaration: ${code}`);this.name='TaxSchemeDeclarationError';}
}
const validPeriod=(p:string)=>/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(p);
const validId=(s:string)=>/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(s);
const schemeOk=(s:string):s is IncentiveScheme=>['rep','knowledge_worker','c_suite'].includes(s);
// Older full-profile writers set only isResident; a default resident label must not erase their
// non-resident 30% election. REP/KW remain explicit resident incentives despite their old false flag.
const legacySchemeOf=(scheme:string|null|undefined,resident:boolean)=>resolvePcbCalculationScheme(
  scheme==='resident'&&!resident?'non_resident':scheme??undefined,resident);


async function scope(tx:Tx,ctx:SessionContext,employmentId:string,write=false,payrollBatchId?:string){
  if(!validId(employmentId))throw new TaxSchemeDeclarationError('not_found');
  // Match payroll's batch-before-employment lock order for contextual writes.
  let payrollContext:{companyId:string;payPeriod:string;companyName:string;country:string}|undefined;
  if(payrollBatchId!==undefined){
    if(!validId(payrollBatchId))throw new TaxSchemeDeclarationError('not_found');
    const [batch]=await tx.select({companyId:payrollBatch.companyId,payPeriod:payrollBatch.payPeriod,companyName:company.legalName,country:company.country})
      .from(payrollBatch).innerJoin(company,and(eq(company.id,payrollBatch.companyId),eq(company.tenantId,payrollBatch.tenantId)))
      .where(and(eq(payrollBatch.id,payrollBatchId),eq(payrollBatch.tenantId,ctx.tenantId))).limit(1).for('share',{of:payrollBatch});
    if(!batch||!validPeriod(batch.payPeriod))throw new TaxSchemeDeclarationError('not_found');
    payrollContext=batch;
  }
  const [e]=await tx.select({employmentId:employment.id,personId:employment.personId,employeeCode:employment.employeeCode,companyId:employment.companyId,companyName:company.legalName,country:company.country})
    .from(employment).innerJoin(company,and(eq(company.id,employment.companyId),eq(company.tenantId,employment.tenantId)))
    .where(and(eq(employment.id,employmentId),eq(employment.tenantId,ctx.tenantId))).limit(1).for(write?'update':'share',{of:employment});
  if(!e)throw new TaxSchemeDeclarationError('not_found');
  if(payrollContext){
    const batch=payrollContext;
    const allowed=await tx.execute(sql`SELECT ${write?sql`app.is_admin_for(${batch.companyId}::uuid) AND app.is_admin_for(${e.companyId}::uuid)`:sql`app.can_admin_payroll_for(${batch.companyId}::uuid) AND app.can_admin_payroll_for(${e.companyId}::uuid)`} AS ok`);
    if(allowed[0]?.ok!==true)throw new TaxSchemeDeclarationError('not_found');
    const [year,month]=batch.payPeriod.split('-').map(Number);
    const lastDay=new Date(Date.UTC(year,month,0)).getUTCDate();
    const [member]=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.id,e.employmentId),eq(employment.tenantId,ctx.tenantId),employedByCompanyDuring(batch.companyId,`${batch.payPeriod}-01`,`${batch.payPeriod}-${lastDay}`))).limit(1);
    if(!member)throw new TaxSchemeDeclarationError('not_found');
    return {...e,...batch,payrollBatchId};
  }
  const allowed=await tx.execute(sql`SELECT ${write?sql`app.is_admin_for(${e.companyId}::uuid)`:sql`app.can_admin_payroll_for(${e.companyId}::uuid)`} AS ok`);
  if(allowed[0]?.ok!==true)throw new TaxSchemeDeclarationError('not_found');
  return e;
}
export async function listTaxSchemeDeclarationsMY(ctx:SessionContext,employmentId:string,payrollBatchId?:string){
  return withTenant(ctx,async tx=>{
    const e=await scope(tx,ctx,employmentId,false,payrollBatchId);
    if(e.country!=='MY')return null;
    const rows=await tx.select({id:employmentTaxSchemeMy.id,scheme:employmentTaxSchemeMy.scheme,validFrom:employmentTaxSchemeMy.validFrom,validTo:employmentTaxSchemeMy.validTo,approvalReference:employmentTaxSchemeMy.approvalReference,declaredAt:employmentTaxSchemeMy.declaredAt,archivedAt:employmentTaxSchemeMy.archivedAt})
      .from(employmentTaxSchemeMy).where(and(eq(employmentTaxSchemeMy.tenantId,ctx.tenantId),eq(employmentTaxSchemeMy.employmentId,e.employmentId),eq(employmentTaxSchemeMy.companyId,e.companyId)))
      .orderBy(desc(employmentTaxSchemeMy.validFrom),desc(employmentTaxSchemeMy.declaredAt),desc(employmentTaxSchemeMy.id));
    const [profile]=await tx.select({taxResidency:employeeStatutoryMy.taxResidency,isResident:employeeStatutoryMy.isResident,epfCitizenship:employeeStatutoryMy.epfCitizenship}).from(employeeStatutoryMy).where(and(eq(employeeStatutoryMy.personId,e.personId),eq(employeeStatutoryMy.tenantId,ctx.tenantId))).limit(1);
    const configuredScheme=legacySchemeOf(profile?.taxResidency,profile?.isResident??true);
    const payPeriod='payPeriod' in e?e.payPeriod:undefined;
    let effectiveScheme:PcbCalculationScheme|undefined;
    let readinessCode:TaxSchemeReadinessCode|undefined;
    if(payPeriod){
      try{effectiveScheme=(await resolveTaxSchemeMY(tx,{tenantId:ctx.tenantId,employmentId:e.employmentId,companyId:e.companyId,payPeriod,legacyScheme:configuredScheme,resident:profile?.isResident??true,epfCitizenship:profile?.epfCitizenship})).scheme;}
      catch(error){if(error instanceof TaxSchemeDeclarationError&&['missing_declaration','declaration_revoked','declaration_outside_period','not_resident','citizenship_unknown','overlap'].includes(error.code))readinessCode=error.code as TaxSchemeReadinessCode;else throw error;}
    }
    return {companyId:e.companyId,companyName:e.companyName,employeeCode:e.employeeCode,payrollBatchId,payPeriod,configuredScheme,effectiveScheme,readinessCode,rows};
  });
}
export async function saveTaxSchemeDeclarationMY(ctx:SessionContext,p:{employmentId:string;expectedCompanyId:string;scheme:string;validFrom:string;validTo:string;approvalReference:string;eligibilityConfirmed:boolean;payrollBatchId?:string;expectedPayPeriod?:string}){
  if(!schemeOk(p.scheme))throw new TaxSchemeDeclarationError('invalid_scheme');
  if(!validPeriod(p.validFrom)||!validPeriod(p.validTo)||p.validFrom>p.validTo)throw new TaxSchemeDeclarationError('invalid_period');
  const actorUserId = ctx.userId;
  if(p.eligibilityConfirmed!==true||!actorUserId)throw new TaxSchemeDeclarationError('approval_required');
  const reference=p.approvalReference.trim();
  if(!reference||reference.length>300)throw new TaxSchemeDeclarationError('missing_reference');
  return withTenant(ctx,async tx=>{
    const e=await scope(tx,ctx,p.employmentId,true,p.payrollBatchId);
    if(p.expectedCompanyId!==e.companyId)throw new TaxSchemeDeclarationError('stale_context');
    if(p.payrollBatchId&&(!('payPeriod' in e)||p.expectedPayPeriod!==e.payPeriod))throw new TaxSchemeDeclarationError('stale_context');
    if(p.payrollBatchId&&'payPeriod' in e&&(p.validFrom>e.payPeriod||p.validTo<e.payPeriod))throw new TaxSchemeDeclarationError('invalid_period');
    if(e.country!=='MY')throw new TaxSchemeDeclarationError('not_found');
    const [profile]=await tx.select({taxResidency:employeeStatutoryMy.taxResidency,isResident:employeeStatutoryMy.isResident,epfCitizenship:employeeStatutoryMy.epfCitizenship}).from(employeeStatutoryMy)
      .where(and(eq(employeeStatutoryMy.personId,e.personId),eq(employeeStatutoryMy.tenantId,ctx.tenantId))).limit(1);
    if(!profile||legacySchemeOf(profile.taxResidency,profile.isResident)==='non_resident')throw new TaxSchemeDeclarationError('not_resident');
    if(p.scheme==='c_suite'&&!['pr','non_citizen'].includes(profile.epfCitizenship))throw new TaxSchemeDeclarationError('citizenship_unknown');
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+e.employmentId+'tax-scheme'},0))`);
    const [overlap]=await tx.select({id:employmentTaxSchemeMy.id}).from(employmentTaxSchemeMy).where(and(eq(employmentTaxSchemeMy.tenantId,ctx.tenantId),eq(employmentTaxSchemeMy.employmentId,e.employmentId),eq(employmentTaxSchemeMy.companyId,e.companyId),isNull(employmentTaxSchemeMy.archivedAt),lte(employmentTaxSchemeMy.validFrom,p.validTo),gte(employmentTaxSchemeMy.validTo,p.validFrom))).limit(1);
    if(overlap)throw new TaxSchemeDeclarationError('overlap');
    const [row]=await tx.insert(employmentTaxSchemeMy).values({tenantId:ctx.tenantId,employmentId:e.employmentId,companyId:e.companyId,scheme:p.scheme as IncentiveScheme,validFrom:p.validFrom,validTo:p.validTo,approvalReference:reference,declaredByUserId:actorUserId}).returning({id:employmentTaxSchemeMy.id});
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment-tax-scheme',aggregateId:row.id,eventType:'employment.tax.scheme.declared',actor:actorOf(ctx),subjectEmploymentId:e.employmentId,payload:{companyId:e.companyId,scheme:p.scheme,validFrom:p.validFrom,validTo:p.validTo,eligibilityConfirmed:true}});
    return row.id;
  });
}
export async function revokeTaxSchemeDeclarationMY(ctx:SessionContext,p:{employmentId:string;id:string;payrollBatchId?:string;expectedCompanyId?:string;expectedPayPeriod?:string}){
  if(!validId(p.id))throw new TaxSchemeDeclarationError('not_found');
  return withTenant(ctx,async tx=>{
    const e=await scope(tx,ctx,p.employmentId,true,p.payrollBatchId);
    if(p.payrollBatchId&&(p.expectedCompanyId!==e.companyId||!('payPeriod' in e)||p.expectedPayPeriod!==e.payPeriod))throw new TaxSchemeDeclarationError('stale_context');
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+e.employmentId+'tax-scheme'},0))`);
    const [row]=await tx.select().from(employmentTaxSchemeMy).where(and(eq(employmentTaxSchemeMy.id,p.id),eq(employmentTaxSchemeMy.tenantId,ctx.tenantId),eq(employmentTaxSchemeMy.employmentId,e.employmentId),eq(employmentTaxSchemeMy.companyId,e.companyId))).limit(1);
    if(!row)throw new TaxSchemeDeclarationError('not_found');
    if(row.archivedAt)return;
    await tx.update(employmentTaxSchemeMy).set({archivedAt:sql`now()`}).where(and(eq(employmentTaxSchemeMy.id,row.id),isNull(employmentTaxSchemeMy.archivedAt)));
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment-tax-scheme',aggregateId:row.id,eventType:'employment.tax.scheme.revoked',actor:actorOf(ctx),subjectEmploymentId:e.employmentId,payload:{companyId:e.companyId,scheme:row.scheme,validFrom:row.validFrom,validTo:row.validTo}});
  });
}
/** The caller's existing authorized payroll transaction supplies employer and period; no live inference. */
export async function resolveTaxSchemeMY(tx:Tx,p:{tenantId:string;employmentId:string;companyId:string;payPeriod:string;legacyScheme?:string|null;resident?:boolean;epfCitizenship?:string|null}) : Promise<{scheme:PcbCalculationScheme;declarationId?:string}> {
  if(!validPeriod(p.payPeriod))throw new TaxSchemeDeclarationError('invalid_period');
  // Payroll holds the same declaration lock through commit; revoke cannot cross its decision.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${p.tenantId+p.employmentId+'tax-scheme'},0))`);
  const rows=await tx.select({id:employmentTaxSchemeMy.id,scheme:employmentTaxSchemeMy.scheme}).from(employmentTaxSchemeMy)
    .where(and(eq(employmentTaxSchemeMy.tenantId,p.tenantId),eq(employmentTaxSchemeMy.employmentId,p.employmentId),eq(employmentTaxSchemeMy.companyId,p.companyId),isNull(employmentTaxSchemeMy.archivedAt),lte(employmentTaxSchemeMy.validFrom,p.payPeriod),gte(employmentTaxSchemeMy.validTo,p.payPeriod))).limit(2);
  const legacy=legacySchemeOf(p.legacyScheme,p.resident??true);
  if(rows.length>1)throw new TaxSchemeDeclarationError('overlap',{configuredScheme:legacy});
  const row=rows[0];
  if(row){
    if(legacy==='non_resident')throw new TaxSchemeDeclarationError('not_resident',{configuredScheme:legacy,effectiveScheme:row.scheme});
    if(row.scheme==='c_suite'&&!['pr','non_citizen'].includes(p.epfCitizenship??''))throw new TaxSchemeDeclarationError('citizenship_unknown',{configuredScheme:legacy,effectiveScheme:row.scheme});
    return {scheme:row.scheme,declarationId:row.id};
  }
  if(schemeOk(legacy)){
    // Diagnostics stay within this exact employer/employment and never retrieve approval references.
    // A configured legacy label recognises intent but cannot establish approved eligibility.
    const history=await tx.select({archivedAt:employmentTaxSchemeMy.archivedAt,validFrom:employmentTaxSchemeMy.validFrom,validTo:employmentTaxSchemeMy.validTo}).from(employmentTaxSchemeMy)
      .where(and(eq(employmentTaxSchemeMy.tenantId,p.tenantId),eq(employmentTaxSchemeMy.employmentId,p.employmentId),eq(employmentTaxSchemeMy.companyId,p.companyId),eq(employmentTaxSchemeMy.scheme,legacy)))
      .orderBy(desc(employmentTaxSchemeMy.validFrom),desc(employmentTaxSchemeMy.declaredAt),desc(employmentTaxSchemeMy.id));
    const revoked=history.some(x=>x.archivedAt!==null&&x.validFrom<=p.payPeriod&&x.validTo>=p.payPeriod);
    const outside=history.some(x=>x.archivedAt===null);
    throw new TaxSchemeDeclarationError(revoked?'declaration_revoked':outside?'declaration_outside_period':'missing_declaration',{configuredScheme:legacy});
  }
  return {scheme:legacy};
}

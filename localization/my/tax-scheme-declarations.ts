/** Employer-period incentive approval declarations. HR owns eligibility; payroll consumes the record. */
import {and,desc,eq,gte,isNull,lte,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {company,employment,employeeStatutoryMy,employmentTaxSchemeMy} from '../../db/schema';
import {resolvePcbCalculationScheme,type PcbCalculationScheme} from './payroll';

export type IncentiveScheme = 'rep'|'knowledge_worker'|'c_suite';
export class TaxSchemeDeclarationError extends Error {
  constructor(public readonly code:string){super(code);this.name='TaxSchemeDeclarationError';}
}
const validPeriod=(p:string)=>/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(p);
const validId=(s:string)=>/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(s);
const schemeOk=(s:string):s is IncentiveScheme=>['rep','knowledge_worker','c_suite'].includes(s);

async function scope(tx:Tx,ctx:SessionContext,employmentId:string,write=false){
  if(!validId(employmentId))throw new TaxSchemeDeclarationError('not_found');
  const [e]=await tx.select({employmentId:employment.id,personId:employment.personId,companyId:employment.companyId,companyName:company.legalName,country:company.country})
    .from(employment).innerJoin(company,and(eq(company.id,employment.companyId),eq(company.tenantId,employment.tenantId)))
    .where(and(eq(employment.id,employmentId),eq(employment.tenantId,ctx.tenantId))).limit(1).for(write?'update':'share',{of:employment});
  if(!e)throw new TaxSchemeDeclarationError('not_found');
  const allowed=await tx.execute(sql`SELECT ${write?sql`app.is_admin_for(${e.companyId}::uuid)`:sql`app.can_admin_payroll_for(${e.companyId}::uuid)`} AS ok`);
  if(allowed[0]?.ok!==true)throw new TaxSchemeDeclarationError('not_found');
  return e;
}
export async function listTaxSchemeDeclarationsMY(ctx:SessionContext,employmentId:string){
  return withTenant(ctx,async tx=>{
    const e=await scope(tx,ctx,employmentId);
    if(e.country!=='MY')return null;
    const rows=await tx.select({id:employmentTaxSchemeMy.id,scheme:employmentTaxSchemeMy.scheme,validFrom:employmentTaxSchemeMy.validFrom,validTo:employmentTaxSchemeMy.validTo,approvalReference:employmentTaxSchemeMy.approvalReference,declaredAt:employmentTaxSchemeMy.declaredAt,archivedAt:employmentTaxSchemeMy.archivedAt})
      .from(employmentTaxSchemeMy).where(and(eq(employmentTaxSchemeMy.tenantId,ctx.tenantId),eq(employmentTaxSchemeMy.employmentId,e.employmentId),eq(employmentTaxSchemeMy.companyId,e.companyId)))
      .orderBy(desc(employmentTaxSchemeMy.validFrom),desc(employmentTaxSchemeMy.declaredAt),desc(employmentTaxSchemeMy.id));
    return {companyId:e.companyId,companyName:e.companyName,rows};
  });
}
export async function saveTaxSchemeDeclarationMY(ctx:SessionContext,p:{employmentId:string;expectedCompanyId:string;scheme:string;validFrom:string;validTo:string;approvalReference:string;eligibilityConfirmed:boolean}){
  if(!schemeOk(p.scheme))throw new TaxSchemeDeclarationError('invalid_scheme');
  if(!validPeriod(p.validFrom)||!validPeriod(p.validTo)||p.validFrom>p.validTo)throw new TaxSchemeDeclarationError('invalid_period');
  if(p.eligibilityConfirmed!==true||!ctx.userId)throw new TaxSchemeDeclarationError('approval_required');
  const reference=p.approvalReference.trim();
  if(!reference||reference.length>300)throw new TaxSchemeDeclarationError('missing_reference');
  return withTenant(ctx,async tx=>{
    const e=await scope(tx,ctx,p.employmentId,true);
    if(p.expectedCompanyId!==e.companyId)throw new TaxSchemeDeclarationError('stale_context');
    if(e.country!=='MY')throw new TaxSchemeDeclarationError('not_found');
    const [profile]=await tx.select({taxResidency:employeeStatutoryMy.taxResidency,isResident:employeeStatutoryMy.isResident,epfCitizenship:employeeStatutoryMy.epfCitizenship}).from(employeeStatutoryMy)
      .where(and(eq(employeeStatutoryMy.personId,e.personId),eq(employeeStatutoryMy.tenantId,ctx.tenantId))).limit(1);
    if(!profile||resolvePcbCalculationScheme(profile.taxResidency,profile.isResident)==='non_resident')throw new TaxSchemeDeclarationError('not_resident');
    if(p.scheme==='c_suite'&&!['pr','non_citizen'].includes(profile.epfCitizenship))throw new TaxSchemeDeclarationError('citizenship_unknown');
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+e.employmentId+'tax-scheme'},0))`);
    const [overlap]=await tx.select({id:employmentTaxSchemeMy.id}).from(employmentTaxSchemeMy).where(and(eq(employmentTaxSchemeMy.tenantId,ctx.tenantId),eq(employmentTaxSchemeMy.employmentId,e.employmentId),eq(employmentTaxSchemeMy.companyId,e.companyId),isNull(employmentTaxSchemeMy.archivedAt),lte(employmentTaxSchemeMy.validFrom,p.validTo),gte(employmentTaxSchemeMy.validTo,p.validFrom))).limit(1);
    if(overlap)throw new TaxSchemeDeclarationError('overlap');
    const [row]=await tx.insert(employmentTaxSchemeMy).values({tenantId:ctx.tenantId,employmentId:e.employmentId,companyId:e.companyId,scheme:p.scheme as IncentiveScheme,validFrom:p.validFrom,validTo:p.validTo,approvalReference:reference,declaredByUserId:ctx.userId}).returning({id:employmentTaxSchemeMy.id});
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment-tax-scheme',aggregateId:row.id,eventType:'employment.tax.scheme.declared',actor:actorOf(ctx),subjectEmploymentId:e.employmentId,payload:{companyId:e.companyId,scheme:p.scheme,validFrom:p.validFrom,validTo:p.validTo,eligibilityConfirmed:true}});
    return row.id;
  });
}
export async function revokeTaxSchemeDeclarationMY(ctx:SessionContext,p:{employmentId:string;id:string}){
  if(!validId(p.id))throw new TaxSchemeDeclarationError('not_found');
  return withTenant(ctx,async tx=>{
    const e=await scope(tx,ctx,p.employmentId,true);
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
  if(rows.length>1)throw new TaxSchemeDeclarationError('overlap');
  const row=rows[0];
  const legacy=resolvePcbCalculationScheme(p.legacyScheme,p.resident??true);
  if(row){
    if(legacy==='non_resident')throw new TaxSchemeDeclarationError('not_resident');
    if(row.scheme==='c_suite'&&!['pr','non_citizen'].includes(p.epfCitizenship??''))throw new TaxSchemeDeclarationError('citizenship_unknown');
    return {scheme:row.scheme,declarationId:row.id};
  }
  if(['rep','knowledge_worker','c_suite'].includes(legacy))throw new TaxSchemeDeclarationError('missing_declaration');
  return {scheme:legacy};
}

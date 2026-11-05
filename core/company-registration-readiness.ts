import 'server-only';
import {and,eq,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext} from '../db/client';
import {company,employment} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {listCompanies,listEmployeesForPayrollRun} from './read';
import {employmentStatusSql} from './employment-status-sql';
import {todayInKualaLumpur} from '../lib/hr-date';
import {packFor} from '../localization/registry';
import {companyRegistrationResult,type CompanyRegistrationClassification} from '../lib/company-registration-readiness';
export async function companyRegistrationOverview(ctx:SessionContext){
 const companies=await listCompanies(ctx,{includeArchived:true,adminOnly:true});if(!companies.length)return[];
 const countries=[...new Set(companies.map(c=>c.country))],rowsByCompany=new Map<string,Awaited<ReturnType<NonNullable<ReturnType<typeof packFor>>['companyStatutory']['list']>>[number]>();
 for(const country of countries){const pack=packFor(country);if(pack)for(const row of await pack.companyStatutory.list(ctx))rowsByCompany.set(row.companyId,row);}
 const {classifications,headcounts}=await withTenant(ctx,async tx=>{
  const classifications=await tx.execute<{company_id:string;entity_kind:'legal_entity'|'grouping_node';is_test_entity:boolean;revision:number}>(sql`select company_id,entity_kind,is_test_entity,revision from company_registration_classification where tenant_id=${ctx.tenantId}::uuid`);
  const headcounts=await tx.select({companyId:employment.companyId,count:sql<number>`count(distinct ${employment.id})::int`}).from(employment).where(and(eq(employment.tenantId,ctx.tenantId),inArray(employment.companyId,companies.map(c=>c.id)),sql`app.is_admin_for(${employment.companyId})`,sql`app.access_workforce_employment(${employment.id},'workforce.view')`,sql`${employment.hiredOn}<=${todayInKualaLumpur()}::date`,sql`${employmentStatusSql()} in ('active','probation','active_serving_notice')`)).groupBy(employment.companyId);
  return{classifications,headcounts};
 });
 const classificationBy=new Map(classifications.map(c=>[c.company_id,{entityKind:c.entity_kind,isTestEntity:c.is_test_entity,revision:c.revision} satisfies CompanyRegistrationClassification]));
 const countBy=new Map(headcounts.map(c=>[c.companyId,c.count]));
 return companies.map(c=>{const pack=packFor(c.country),readiness=pack?.companyStatutory.readiness?.(rowsByCompany.get(c.id));return{company:c,...companyRegistrationResult({id:c.id,archived:!!c.archivedAt,classification:classificationBy.get(c.id)??{entityKind:'legal_entity',isTestEntity:false,revision:0},activeEmployees:countBy.get(c.id)??0,readiness:readiness??{missing:['countryPack'],levyUnavailable:false}})};});
}
export async function changeCompanyRegistrationClassification(ctx:SessionContext,raw:unknown){
 const p=z.object({companyId:z.uuid(),entityKind:z.enum(['legal_entity','grouping_node']),isTestEntity:z.boolean(),expectedRevision:z.number().int().nonnegative()}).strict().parse(raw);
 if(!ctx.userId)throw Error('Sign in to continue.');
 return withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,ctx.tenantId);const[c]=await tx.select({id:company.id}).from(company).where(and(eq(company.id,p.companyId),eq(company.tenantId,ctx.tenantId),sql`app.is_admin_for(${company.id})`)).for('update');if(!c)throw Error('Company not available.');
  const[before]=await tx.execute<{entity_kind:string;is_test_entity:boolean;revision:number}>(sql`select entity_kind,is_test_entity,revision from company_registration_classification where company_id=${p.companyId}::uuid and tenant_id=${ctx.tenantId}::uuid for update`);
  if((before?.revision??0)!==p.expectedRevision)throw Error('Company classification changed. Reopen the company.');
  await tx.execute(sql`insert into company_registration_classification(company_id,tenant_id,entity_kind,is_test_entity,changed_by) values(${p.companyId}::uuid,${ctx.tenantId}::uuid,${p.entityKind},${p.isTestEntity},${ctx.userId}::uuid) on conflict(company_id) do update set entity_kind=excluded.entity_kind,is_test_entity=excluded.is_test_entity,changed_by=excluded.changed_by,revision=company_registration_classification.revision+1,updated_at=now()`);
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'company',aggregateId:p.companyId,eventType:'company.registration-classification.changed',actor:actorOf(ctx),payload:{before:before?{entityKind:before.entity_kind,isTestEntity:before.is_test_entity}:null,after:{entityKind:p.entityKind,isTestEntity:p.isTestEntity}}});
 });
}
/** Uses the actual authorized run selection; no independent estimate of levy amounts or payroll eligibility. */
export async function companyRegistrationPayrollWarning(ctx:SessionContext,input:{companyIds:string[];payPeriod:string;employmentIds?:string[];payrollCycleId?:string}){
 const p=z.object({companyIds:z.array(z.uuid()).max(500),payPeriod:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),employmentIds:z.array(z.uuid()).max(20000).optional(),payrollCycleId:z.uuid().optional()}).strict().parse(input);
 if(!p.companyIds.length)return{employees:0,companies:0,href:'/admin/organization?statutory=missing'};
 const readiness=await companyRegistrationOverview(ctx),missing=new Set(readiness.filter(r=>r.counted&&r.status==='missing'&&r.levyUnavailable&&p.companyIds.includes(r.id)).map(r=>r.id));
 if(!missing.size)return{employees:0,companies:0,href:'/admin/organization?statutory=missing'};
 const selected=await listEmployeesForPayrollRun(ctx,[...missing],p.payPeriod,p.payrollCycleId),wanted=p.employmentIds?new Set(p.employmentIds):null;
 const employees=new Set(selected.filter(e=>!wanted||wanted.has(e.employmentId)).map(e=>e.employmentId));
 return{employees:employees.size,companies:missing.size,href:'/admin/organization?statutory=missing'};
}

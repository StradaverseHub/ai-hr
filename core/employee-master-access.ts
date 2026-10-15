/** Company-aware report category access. Reuses the granular grants owner without a broad admin OR. */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx, type Grant } from '../db/client';
import { PERSONNEL_FIELDS, type PersonnelFieldDescriptor, type PersonnelFieldSensitivity } from '../lib/personnel-field-registry';
import { resolvePayrollPermission } from '../packs/payroll/service';
import { isModuleEnabled } from './entitlements';

export const MASTER_REPORT_CATEGORIES=['personnel','compensation','identity','bank','statutory','confidential_hr'] as const;
export type MasterReportCategory=typeof MASTER_REPORT_CATEGORIES[number];
const CATEGORY:Record<PersonnelFieldSensitivity,MasterReportCategory>={personnel:'personnel',identity:'identity',bank:'bank',payroll:'compensation',statutory:'statutory',restricted:'confidential_hr',attendance:'personnel',leave:'personnel',documents:'confidential_hr'};
const MODULE:Partial<Record<PersonnelFieldSensitivity,string>>={payroll:'payroll',statutory:'payroll',attendance:'attendance',leave:'leave'};
export class MasterReportAccessError extends Error {constructor(){super('Report access or selected company/field is unavailable.');this.name='MasterReportAccessError';}}
export async function masterReportFieldsTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[]):Promise<PersonnelFieldDescriptor[]>{
  if(!ctx.userId||!companyIds.length)return [];
  const [principal]=await tx.execute(sql`select p.tenant_id,p.person_id,p.grants,u.archived_at,app.login_blocked(u.id) as blocked from app.principal(${ctx.userId}::uuid) p join app_user u on u.id=${ctx.userId}::uuid`) as unknown as {tenant_id:string;person_id:string|null;grants:Grant[];archived_at:Date|null;blocked:boolean}[];
  const normalized=(grants:readonly Grant[])=>JSON.stringify(grants.map(grant=>[grant.role,grant.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  if(!principal||principal.tenant_id!==ctx.tenantId||principal.person_id!==(ctx.personId??null)||principal.archived_at||principal.blocked||normalized(principal.grants)!==normalized(ctx.grants??[]))throw new MasterReportAccessError();
  const access=new Map<string,Set<MasterReportCategory>>();
  for(const companyId of companyIds){
    const [scope]=await tx.execute(sql`select exists(select 1 from company where id=${companyId}::uuid and tenant_id=app.current_tenant_id()) as allowed`) as unknown as {allowed:boolean}[];
    if(!scope?.allowed)throw new MasterReportAccessError();
    // The existing granular resolver accepts role names. Strip grants that do not cover THIS company
    // before passing them; a role in another company must not satisfy this company's report category.
    const rows=await tx.execute(sql`select role from unnest(app.current_roles()) as role where app.has_role_for(role,${companyId}::uuid)`) as unknown as {role:string}[];
    const roles=rows.map(row=>row.role), scopedContext={...ctx,roles,grants:ctx.grants?.filter(grant=>roles.includes(grant.role))};
    const allowed=new Set<MasterReportCategory>();
    for(const category of MASTER_REPORT_CATEGORIES)if(await resolvePayrollPermission(tx,scopedContext,`report.read.${category}`,companyId))allowed.add(category);
    if(!allowed.has('personnel'))throw new MasterReportAccessError();
    access.set(companyId,allowed);
  }
  return PERSONNEL_FIELDS.filter(field=>companyIds.every(companyId=>{
    if(!access.get(companyId)?.has(CATEGORY[field.sensitivity]))return false;
    // Employment history is confidential HR; its monetary cells require compensation as well.
    if(['movement','movementComparison','hireCorrection'].includes(field.owner)&&['basicSalary','originalValue','correctedValue'].includes(field.ownerField)&&!access.get(companyId)?.has('compensation'))return false;
    const module=MODULE[field.sensitivity];return !module||isModuleEnabled(ctx,module,companyId);
  }));
}
export function masterReportCatalogue(ctx:SessionContext,companyIds:readonly string[]){return withTenant(ctx,tx=>masterReportFieldsTx(tx,ctx,companyIds));}

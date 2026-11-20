/** Company-aware report category access. Reuses the granular grants owner without a broad admin OR. */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx, type Grant } from '../db/client';
import { PERSONNEL_FIELDS, type PersonnelFieldDescriptor, type PersonnelFieldSensitivity } from '../lib/personnel-field-registry';
import { companyPayrollPermissionsTx } from './pay-formula-personnel-permissions';
import { isModuleEnabled } from './entitlements';

export const MASTER_REPORT_CATEGORIES=['personnel','compensation','identity','bank','statutory','confidential_hr'] as const;
export type MasterReportCategory=typeof MASTER_REPORT_CATEGORIES[number];
const CATEGORY:Record<PersonnelFieldSensitivity,MasterReportCategory>={personnel:'personnel',identity:'identity',bank:'bank',payroll:'compensation',statutory:'statutory',restricted:'confidential_hr',attendance:'personnel',leave:'personnel',documents:'confidential_hr'};
const MODULE:Partial<Record<PersonnelFieldSensitivity,string>>={payroll:'payroll',statutory:'payroll',attendance:'attendance',leave:'leave'};
export class MasterReportAccessError extends Error {constructor(){super('Report access or selected company/field is unavailable.');this.name='MasterReportAccessError';}}
/** Current principal proof shared by financial report reads and definition access. */
export async function assertReportPrincipalTx(tx:Tx,ctx:SessionContext):Promise<void>{
  if(!ctx.userId)throw new MasterReportAccessError();
  const [principal]=await tx.execute(sql`select p.tenant_id,p.person_id,p.grants,u.archived_at,app.login_blocked(u.id) as blocked from app.principal(${ctx.userId}::uuid) p join app_user u on u.id=${ctx.userId}::uuid`) as unknown as {tenant_id:string;person_id:string|null;grants:Grant[];archived_at:Date|null;blocked:boolean}[];
  const normalized=(grants:readonly Grant[])=>JSON.stringify(grants.map(grant=>[grant.role,grant.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  if(!principal||principal.tenant_id!==ctx.tenantId||principal.person_id!==(ctx.personId??null)||principal.archived_at||principal.blocked||normalized(principal.grants)!==normalized(ctx.grants??[]))throw new MasterReportAccessError();
}
export async function masterReportFieldsTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[]):Promise<PersonnelFieldDescriptor[]>{
  if(!ctx.userId||!companyIds.length)return [];
  await assertReportPrincipalTx(tx,ctx);
  const keys=MASTER_REPORT_CATEGORIES.map(category=>`report.read.${category}` as const);
  // The explicit current session role intersection is part of the report's carrier.
  const access=await companyPayrollPermissionsTx(tx,ctx,companyIds,keys,{requireSessionRoles:true});
  if(companyIds.some(companyId=>!access.get('report.read.personnel')?.has(companyId)))throw new MasterReportAccessError();
  return PERSONNEL_FIELDS.filter(field=>companyIds.every(companyId=>{
    if(!access.get(`report.read.${CATEGORY[field.sensitivity]}`)?.has(companyId))return false;
    // Employment history is confidential HR; its monetary cells require compensation as well.
    if(['movement','movementComparison','hireCorrection'].includes(field.owner)&&['basicSalary','originalValue','correctedValue'].includes(field.ownerField)&&!access.get('report.read.compensation')?.has(companyId))return false;
    const module=MODULE[field.sensitivity];return !module||isModuleEnabled(ctx,module,companyId);
  }));
}
export function masterReportCatalogue(ctx:SessionContext,companyIds:readonly string[]){return withTenant(ctx,tx=>masterReportFieldsTx(tx,ctx,companyIds));}

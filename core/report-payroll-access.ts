/** Financial-report authority is company-specific and fresh; saved sharing never grants salary access. */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import type { CustomReportSpec, ReportPermissionVerb } from '../db/schema';
import { resolvePayrollPermission } from '../packs/payroll/service';
import { assertReportPrincipalTx, MasterReportAccessError } from './employee-master-access';
import { isModuleEnabled } from './entitlements';
import { reportVerbAllowed } from './report-registry';
import { validatePayrollComparisonDefinition } from '../lib/payroll-period-comparison';

/** Returns the exact authorized scope, or refuses the whole request without exposing partial metadata. */
export async function payrollComparisonAccessTx(tx: Tx, ctx: SessionContext, spec: CustomReportSpec,
  verb: ReportPermissionVerb, requested?: readonly string[]): Promise<string[]> {
  await assertReportPrincipalTx(tx, ctx);
  const grantedRoles=new Set((ctx.grants??[]).map(grant=>grant.role));
  if(ctx.roles?.some(role=>!grantedRoles.has(role)))throw new MasterReportAccessError();
  const definition = validatePayrollComparisonDefinition(spec.payrollComparison);
  const companies = await tx.execute(sql`select id from company where tenant_id=app.current_tenant_id()
    and (app.has_role_for('hr_admin',id) or app.has_role_for('super_admin',id)) order by id limit 101`) as unknown as {id:string}[];
  const available = companies.map(row => row.id);
  if (available.length > 100) throw new MasterReportAccessError();
  const ids = requested ? [...new Set(requested)] : available;
  if (!ids.length || ids.length > 100 || ids.some(id => !available.includes(id))) throw new MasterReportAccessError();
  for (const companyId of ids) {
    const rows = await tx.execute(sql`select role from unnest(app.current_roles()) as role
      where app.has_role_for(role,${companyId}::uuid) order by role`) as unknown as {role:string}[];
    const roles = rows.map(row => row.role);
    if (!definition.roles.some(role => roles.includes(role)) ||
      !reportVerbAllowed(spec.layout?.permissions,roles,[verb]) || !isModuleEnabled(ctx,'payroll',companyId) ||
      !await resolvePayrollPermission(tx,{...ctx,roles},'report.read.compensation',companyId)) throw new MasterReportAccessError();
  }
  return ids;
}

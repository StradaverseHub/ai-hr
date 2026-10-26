/** Minimal identity/catalogue projection shared by reviewed run scope and its human selector.
 * No payroll kernel/read.ts dependency: importing this from the native CREATE preflight creates
 * no core/payroll→core/read→core/payroll cycle. No compensation/contact/bank fields are queried. */
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {employment,person,department} from '../db/schema';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {assertWorkforceCompanyTx,workforceEmploymentPredicate} from './workforce-access';
import {visibleLabelIdsCondition} from './system-labels';
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
export class ReviewedPayrollSelectionUnavailable extends Error{constructor(){super('Payroll selection unavailable. Reopen Payroll Process.');this.name='ReviewedPayrollSelectionUnavailable';}}
/** Exact native company Payroll + filed-truth readability permission. This is not a role union,
 * posted company authority or claim that the month is unfiled; periodFiledTx still decides that. */
export async function assertReviewedPayrollScopeCompanyTx(tx:Tx,supplied:SessionContext,companyId:string){
 const ctx=capture(supplied),id=companyId,grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null})),roles=ctx.roles??[...new Set(grants.map(g=>g.role))];await lockAccessConfigurationTx(tx,ctx.tenantId);
 const [row]=await tx.execute<{allowed:boolean}>(sql`select exists(select 1 from public.app_user u join public.company c on c.id=${id}::uuid and c.tenant_id=u.tenant_id
 where u.id=${ctx.userId??null}::uuid and u.id=app.current_user_id() and u.tenant_id=${ctx.tenantId}::uuid and u.tenant_id=app.current_tenant_id() and u.archived_at is null and not app.login_blocked(u.id) and u.person_id is not distinct from ${ctx.personId??null}::uuid
 and app.principal_snapshot_current() and current_setting('transaction_isolation')='read committed' and current_setting('app.roles',true)=${roles.join(',')} and current_setting('app.grants',true)::jsonb=${JSON.stringify(grants)}::jsonb
 and app.can_admin_payroll_for(c.id) and app.is_admin_for(c.id)) as allowed`);if(row?.allowed!==true)throw new ReviewedPayrollSelectionUnavailable();
}
export type ReviewedPayrollScopeSelection={companyId:string;scope:{departmentIds?:readonly string[];employmentIds?:readonly string[]}|null};
/** Exact captured IDs, current company and Workforce purpose/record visibility. Missing/hidden/changed bindings refuse
 * the WHOLE projection: never invent a name, omit a selected person or retarget the human's scope.
 * The effect owner must already own its actual config/period and filed-month preflight interval. */
export async function readReviewedPayrollRunScopeLabelsTx(tx:Tx,supplied:SessionContext,input:ReviewedPayrollScopeSelection){
 const ctx=capture(supplied),p=structuredClone(input),employeeIds=[...(p.scope?.employmentIds??[])],departmentIds=[...(p.scope?.departmentIds??[])];
 if(employeeIds.length>256||departmentIds.length>256||new Set(employeeIds.map(id=>id.toLowerCase())).size!==employeeIds.length||new Set(departmentIds.map(id=>id.toLowerCase())).size!==departmentIds.length)throw new ReviewedPayrollSelectionUnavailable();
 await assertReviewedPayrollScopeCompanyTx(tx,ctx,p.companyId);
 if(employeeIds.length||departmentIds.length)await assertWorkforceCompanyTx(tx,ctx,p.companyId,'view');
 const employees=employeeIds.length?await tx.select({employmentId:employment.id,employeeCode:employment.employeeCode,fullName:person.fullName}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(and(inArray(employment.id,employeeIds),eq(employment.companyId,p.companyId),workforceEmploymentPredicate(sql`${employment.id}`,'view',[p.companyId]))).orderBy(employment.id):[];
 const departments=departmentIds.length?await tx.select({departmentId:department.id,name:sql<string>`coalesce(nullif(trim(${department.label}),''),nullif(trim(${department.description}),''),${department.name})`}).from(department).where(and(inArray(department.id,departmentIds),isNull(department.archivedAt),visibleLabelIdsCondition(department,'department',[p.companyId]))).orderBy(department.id):[];
 if(employees.length!==employeeIds.length||departments.length!==departmentIds.length||employees.some(row=>!row.fullName?.trim()&&!row.employeeCode?.trim())||departments.some(row=>!row.name?.trim()))throw new ReviewedPayrollSelectionUnavailable();
 return{employees,departments};
}

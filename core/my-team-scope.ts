/** Shared spine authority for My Team reads and in-transaction workflow decisions. */
import {and,eq,inArray,isNull,lte,or,sql} from 'drizzle-orm';
import {type SessionContext,type Tx,withTenant} from '../db/client';
import {appUser,assignment,company,department,employment,person,position,reportingLine} from '../db/schema';
import {hasTeamAccess} from '../lib/authz';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {MyTeamQuery} from '../lib/my-team-types';
import {assertModuleEnabled} from './entitlements';

export class MyTeamAuthorizationError extends Error {constructor(){super('MY_TEAM_NOT_AUTHORIZED');this.name='MyTeamAuthorizationError';}}
export function assertMyTeamAccess(ctx:SessionContext){
  if(!ctx.userId||!hasTeamAccess(ctx))throw new MyTeamAuthorizationError();
  assertModuleEnabled(ctx,'leave');
}
export async function resolveMyTeamScopeTx(tx:Tx,ctx:SessionContext,query:MyTeamQuery){
  assertMyTeamAccess(ctx);
  const today=todayInKualaLumpur();
  const [principal]=await tx.select({personId:appUser.personId}).from(appUser)
    .where(and(eq(appUser.id,ctx.userId!),eq(appUser.tenantId,ctx.tenantId),isNull(appUser.archivedAt))).limit(1);
  if(!principal)throw new MyTeamAuthorizationError();
  const [capability]=await tx.execute(sql`SELECT app.has_role('manager') OR app.has_role('hr_admin') OR app.has_role('super_admin') AS allowed,
    app.has_role('hr_admin') OR app.has_role('super_admin') AS admin`) as unknown as {allowed:boolean;admin:boolean}[];
  if(!capability?.allowed||query.scope==='department'&&!capability.admin)throw new MyTeamAuthorizationError();
  const companies=await tx.select({id:company.id,name:company.legalName,admin:sql<boolean>`app.is_admin_for(${company.id})`}).from(company)
    .where(query.scope==='department' ? sql`app.is_admin_for(${company.id})` : sql`app.is_admin_for(${company.id}) OR app.has_role_for('manager',${company.id})`).orderBy(company.legalName);
  const selected=new Set(query.companyIds===undefined ? companies.map(c=>c.id) : query.companyIds);
  const authorizedCompanies=companies.filter(c=>selected.has(c.id));
  const companyIds=authorizedCompanies.map(c=>c.id);
  const canEditRoster=authorizedCompanies.length>0&&authorizedCompanies.every(c=>c.admin);
  const departments=companyIds.length ? await tx.select({id:department.id,companyId:department.companyId,name:department.name})
    .from(department).where(inArray(department.companyId,companyIds)).orderBy(department.name) : [];
  if(!companyIds.length)return {employees:[],companies:authorizedCompanies,departments,principal,canEditRoster,canChooseDepartment:capability.admin};
  const direct=sql`EXISTS(SELECT 1 FROM reporting_line r JOIN employment m ON m.id=r.manager_employment_id
    JOIN app_user u ON u.person_id=m.person_id AND u.tenant_id=m.tenant_id
    WHERE u.id=app.current_user_id() AND u.archived_at IS NULL AND r.subordinate_employment_id=${employment.id}
    AND r.tenant_id=app.current_tenant_id() AND r.line_type='administrative' AND r.superseded_at IS NULL
    AND r.valid_from<=${today}::date AND (r.valid_to IS NULL OR r.valid_to>${today}::date)
    AND m.hired_on<=${today}::date AND (m.terminated_on IS NULL OR m.terminated_on>${today}::date)
    AND m.person_id<>${employment.personId})`;
  const mode=query.scope==='department' ? sql`app.is_admin_for(${employment.companyId})` :
    query.scope==='direct' ? direct : sql`${employment.id} IN (SELECT app.my_team_report_ids())`;
  const employees=await tx.select({employmentId:employment.id,personId:employment.personId,employeeCode:employment.employeeCode,
    name:person.fullName,companyId:employment.companyId,departmentId:assignment.departmentId,occupation:position.title,
    defaultShiftId:employment.defaultShiftId}).from(employment).innerJoin(person,eq(person.id,employment.personId))
    .leftJoin(assignment,and(eq(assignment.employmentId,employment.id),isNull(assignment.supersededAt),lte(assignment.validFrom,today),
      or(isNull(assignment.validTo),sql`${assignment.validTo}>${today}::date`)))
    .leftJoin(position,eq(position.id,assignment.positionId))
    .where(and(inArray(employment.companyId,companyIds),sql`app.my_team_subject_authorized(${employment.id})`,mode,
      query.departmentId ? eq(assignment.departmentId,query.departmentId) : undefined,
      query.employmentId ? eq(employment.id,query.employmentId) : undefined)).orderBy(person.fullName,employment.id);
  return {employees:[...new Map(employees.map(e=>[e.employmentId,e])).values()],companies:authorizedCompanies,departments,
    principal,canEditRoster,canChooseDepartment:capability.admin};
}
export function resolveMyTeamScope(ctx:SessionContext,query:MyTeamQuery){return withTenant(ctx,tx=>resolveMyTeamScopeTx(tx,ctx,query));}
/** Hold the membership facts through commit. FK inserts referencing these employments also wait. */
export async function assertMyTeamSubjectTx(tx:Tx,ctx:SessionContext,query:MyTeamQuery|undefined,employmentId:string){
  assertMyTeamAccess(ctx);
  await tx.select({id:employment.id}).from(employment).where(eq(employment.tenantId,ctx.tenantId)).orderBy(employment.id).for('update');
  await tx.select({id:reportingLine.id}).from(reportingLine).where(eq(reportingLine.tenantId,ctx.tenantId)).orderBy(reportingLine.id).for('share');
  await tx.select({id:assignment.id}).from(assignment).where(eq(assignment.employmentId,employmentId)).orderBy(assignment.id).for('share');
  if(query){
    const scope=await resolveMyTeamScopeTx(tx,ctx,query);
    if(!scope.employees.some(e=>e.employmentId===employmentId))throw new MyTeamAuthorizationError();
    return {...ctx,personId:scope.principal.personId};
  }
  const [subject]=await tx.select({id:employment.id}).from(employment)
    .where(and(eq(employment.id,employmentId),sql`app.my_team_subject_authorized(${employment.id})`));
  if(!subject)throw new MyTeamAuthorizationError();
  const [principal]=await tx.select({personId:appUser.personId}).from(appUser)
    .where(and(eq(appUser.id,ctx.userId!),eq(appUser.tenantId,ctx.tenantId),isNull(appUser.archivedAt)));
  if(!principal)throw new MyTeamAuthorizationError();
  return {...ctx,personId:principal.personId};
}

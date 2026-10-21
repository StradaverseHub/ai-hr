/** Company/role Home presentation policy. Immutable versions never own attendance, money, leave,
 * approvals or identity facts; module readers remain responsible for every fact used in a sentence. */
import {and,asc,desc,eq,isNull,lt,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {company,employeeHomeConfigurationRevision} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {DASHBOARD_LAYOUT_ROLES,type DashboardLayoutRole} from '../lib/dashboard-layout';
import {validateEmployeeHomeConfiguration,type EmployeeHomeConfiguration} from '../lib/employee-home';
import {defaultEmployeeHomeConfiguration} from '../lib/employee-home-defaults';
import {readEmployeeHomeIdentity,HomeAccessError} from './employee-home';
import {myOwnEmploymentSubjects} from './read';

export class HomeConfigurationAccessError extends Error{
 constructor(){super('This employee Home configuration is outside your company scope.');this.name='HomeConfigurationAccessError';}
}
export class HomeConfigurationChangedError extends Error{
 constructor(){super('Home configuration changed. Reload before saving.');this.name='HomeConfigurationChangedError';}
}
export type EmployeeHomeConfigurationView={version:1;companyId:string;audienceRole:DashboardLayoutRole;
 revisionId:string|null;ordinal:number;configuration:EmployeeHomeConfiguration};
const uuid=(value:string)=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function role(value:string):DashboardLayoutRole{
 if(!DASHBOARD_LAYOUT_ROLES.some(item=>item===value))throw new HomeConfigurationAccessError();
 return value as DashboardLayoutRole;
}
async function assertAdminCompany(tx:Tx,ctx:SessionContext,companyId:string){
 if(!ctx.userId||!uuid(companyId))throw new HomeConfigurationAccessError();
 const [row]=await tx.select({allowed:sql<boolean>`app.principal_snapshot_current() AND app.is_admin_for(${company.id})`})
  .from(company).where(and(eq(company.id,companyId),eq(company.tenantId,ctx.tenantId),isNull(company.archivedAt))).limit(1);
 if(!row?.allowed)throw new HomeConfigurationAccessError();
}
async function currentTx(tx:Tx,ctx:SessionContext,companyId:string,audienceRole:DashboardLayoutRole):Promise<EmployeeHomeConfigurationView>{
 const [row]=await tx.select({id:employeeHomeConfigurationRevision.id,ordinal:employeeHomeConfigurationRevision.ordinal,configuration:employeeHomeConfigurationRevision.configuration})
  .from(employeeHomeConfigurationRevision).where(and(eq(employeeHomeConfigurationRevision.tenantId,ctx.tenantId),eq(employeeHomeConfigurationRevision.companyId,companyId),eq(employeeHomeConfigurationRevision.audienceRole,audienceRole)))
  .orderBy(desc(employeeHomeConfigurationRevision.ordinal)).limit(1);
 return {version:1,companyId,audienceRole,revisionId:row?.id??null,ordinal:row?.ordinal??0,
  configuration:row?validateEmployeeHomeConfiguration(row.configuration):defaultEmployeeHomeConfiguration()};
}
export function employeeHomeConfigurationCompanies(ctx:SessionContext){
 return withTenant(ctx,tx=>tx.select({id:company.id,name:company.legalName}).from(company)
  .where(and(eq(company.tenantId,ctx.tenantId),isNull(company.archivedAt),sql`app.principal_snapshot_current() AND app.is_admin_for(${company.id})`))
  .orderBy(asc(company.legalName),asc(company.id)));
}
export function readEmployeeHomeConfigurationEditor(ctx:SessionContext,p:{companyId:string;audienceRole:string}):Promise<EmployeeHomeConfigurationView>{
 const audienceRole=role(p.audienceRole);
 return withTenant(ctx,async tx=>{await assertAdminCompany(tx,ctx,p.companyId);return currentTx(tx,ctx,p.companyId,audienceRole);});
}
/** A caller cannot choose a different company or role. Both come from current own active employment
 * and the same deterministic dashboard-role resolver used by the shell. No salary projection is read. */
export async function readOwnEmployeeHomeConfiguration(ctx:SessionContext,requestedEmploymentId?:string){
 const identity=await readEmployeeHomeIdentity(ctx,requestedEmploymentId);
 if(identity.employmentState!=='selected')throw new HomeAccessError(identity.employmentState==='choose'?'chooseEmployment':'employmentUnavailable');
 const own=await myOwnEmploymentSubjects(ctx,{profileEdit:true}),subject=own.find(row=>row.employmentId===identity.selectedEmploymentId);
 if(!subject?.companyProof.companyId)throw new HomeAccessError('employmentUnavailable');
 return withTenant(ctx,async tx=>{
  const [proof]=await tx.execute(sql`SELECT app.principal_snapshot_current() AS allowed`) as unknown as {allowed:boolean}[];
  if(!proof?.allowed)throw new HomeConfigurationAccessError();
  const view=await currentTx(tx,ctx,subject.companyProof.companyId!,identity.role);
  return {...view,employmentId:subject.employmentId};
 });
}
export async function saveEmployeeHomeConfiguration(ctx:SessionContext,p:{companyId:string;audienceRole:string;expectedOrdinal:number;configuration:unknown;reason:string}){
 const audienceRole=role(p.audienceRole),configuration=validateEmployeeHomeConfiguration(p.configuration);
 if(!Number.isSafeInteger(p.expectedOrdinal)||p.expectedOrdinal<0||typeof p.reason!=='string'||!p.reason.trim()||p.reason.trim().length>500)throw Error('Provide the saved version and a reason of at most 500 characters.');
 const reason=p.reason.trim();
 return withTenant(ctx,async tx=>{
  await assertAdminCompany(tx,ctx,p.companyId);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`home-config:${ctx.tenantId}:${p.companyId}:${audienceRole}`},0))`);
  const previous=await currentTx(tx,ctx,p.companyId,audienceRole);
  if(previous.ordinal!==p.expectedOrdinal)throw new HomeConfigurationChangedError();
  const [saved]=await tx.insert(employeeHomeConfigurationRevision).values({tenantId:ctx.tenantId,companyId:p.companyId,audienceRole,
   ordinal:previous.ordinal+1,configuration,reason,createdByUserId:ctx.userId!})
   .returning({id:employeeHomeConfigurationRevision.id,ordinal:employeeHomeConfigurationRevision.ordinal});
  // Bodies/reasons stay behind the scoped version table. The shared event contains identifiers only.
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employee-home-configuration',aggregateId:p.companyId,
   eventType:'employee-home.configuration.updated',actor:actorOf(ctx),payload:{versionId:saved.id,companyId:p.companyId,audienceRole,previousOrdinal:previous.ordinal,ordinal:saved.ordinal}});
  return saved;
 });
}
export function employeeHomeConfigurationHistory(ctx:SessionContext,p:{companyId:string;audienceRole:string;beforeOrdinal?:number}){
 const audienceRole=role(p.audienceRole);
 if(p.beforeOrdinal!==undefined&&(!Number.isSafeInteger(p.beforeOrdinal)||p.beforeOrdinal<1))throw Error('Choose a valid configuration history page.');
 return withTenant(ctx,async tx=>{
  await assertAdminCompany(tx,ctx,p.companyId);
  const rows=await tx.select().from(employeeHomeConfigurationRevision).where(and(eq(employeeHomeConfigurationRevision.tenantId,ctx.tenantId),
   eq(employeeHomeConfigurationRevision.companyId,p.companyId),eq(employeeHomeConfigurationRevision.audienceRole,audienceRole),
   p.beforeOrdinal===undefined?undefined:lt(employeeHomeConfigurationRevision.ordinal,p.beforeOrdinal)))
   .orderBy(desc(employeeHomeConfigurationRevision.ordinal)).limit(51);
  const items=rows.slice(0,50).map(row=>({...row,configuration:validateEmployeeHomeConfiguration(row.configuration),createdAt:row.createdAt.toISOString()}));
  return {items,nextBeforeOrdinal:rows.length>50?items.at(-1)!.ordinal:null};
 });
}

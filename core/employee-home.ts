/** Salary-free self identity for employee Home. This is a read projection, not another personnel owner. */
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';
import {isAiPrincipalCurrentTx} from './ai-principal';
import {person} from '../db/schema';
import {isCurrentOwnHomeEmploymentTx,isOwnProfileEditEmploymentTx,myOwnEmploymentSubjectsTx,type OwnEmploymentSubject} from './read';
import {hasPersonPhoto} from './person-photo';
import {isAdmin} from '../lib/authz-model';
import {resolveDashboardRole} from '../lib/dashboard-cards';
import {employeeHomeGreetingName} from '../lib/employee-home';
import type {EmployeeHomeIdentity,EmployeeHomeGreetingIdentity} from '../lib/employee-home-read-model';
import {readOwnPayrollHomeMetadata} from '../packs/payroll/service';
import {ownClockToday} from '../packs/attendance/service';

export class HomeAccessError extends Error{
 constructor(readonly code:'authentication'|'employmentUnavailable'|'chooseEmployment'){
  super('This employee Home context is unavailable.');this.name='HomeAccessError';
 }
}
type OwnSelection=
 |{state:'none'|'choose';subjects:OwnEmploymentSubject[];subject:null}
 |{state:'selected';subjects:OwnEmploymentSubject[];subject:OwnEmploymentSubject};

/** A role, company filter, posted employee ID or historical selection never expands the own-subject set.
 * Multiple own employments require an explicit choice; a foreign/stale selector never falls back.
 */
export async function ownHomeSubjectSelection(ctx:SessionContext,requestedEmploymentId?:string):Promise<OwnSelection>{
 return withTenant(ctx,tx=>ownHomeSubjectSelectionTx(tx,ctx,requestedEmploymentId),{readOnlySnapshot:true});
}
async function ownHomeSubjectSelectionTx(tx:Tx,ctx:SessionContext,requestedEmploymentId?:string):Promise<OwnSelection>{
 if(!ctx.userId)throw new HomeAccessError('authentication');
 // The role/scope snapshot does not attest a caller's personId. Bind it independently through the
 // canonical actual-login predicate before an HR principal can query the own-subject inventory.
 const [principal]=await tx.execute<{ok:boolean}>(sql`SELECT (app.principal_snapshot_current()
   AND (${ctx.personId??null}::uuid IS NULL OR app.is_self_person(${ctx.personId??null}::uuid))) AS ok`);
 if(!principal?.ok)throw new HomeAccessError('employmentUnavailable');
 const subjects=await myOwnEmploymentSubjectsTx(tx,ctx);
 if(requestedEmploymentId!==undefined){
  const subject=subjects.find(row=>row.employmentId===requestedEmploymentId);
  if(!subject)throw new HomeAccessError('employmentUnavailable');
  return {state:'selected',subjects,subject};
 }
 if(subjects.length===0)return {state:'none',subjects,subject:null};
 if(subjects.length!==1)return {state:'choose',subjects,subject:null};
 return {state:'selected',subjects,subject:subjects[0]};
}

/** Card readers call this before loading employment facts. Their canonical module/field/date guards
 * still apply; this own-only check is deliberately narrower than an administrator's Personnel reach.
 */
export async function requireOwnHomeSubject(ctx:SessionContext,employmentId?:string):Promise<OwnEmploymentSubject>{
 return selectedHomeSubject(await ownHomeSubjectSelection(ctx,employmentId));
}
/** A card with an explicit selection can prove ownership without projecting the whole inventory. */
export async function requireSelectedOwnHomeEmploymentId(ctx:SessionContext,employmentId:string):Promise<string>{
 if(!ctx.userId)throw new HomeAccessError('authentication');
 const allowed=await withTenant(ctx,tx=>isCurrentOwnHomeEmploymentTx(tx,ctx,employmentId),{readOnlySnapshot:true});
 if(!allowed)throw new HomeAccessError('employmentUnavailable');
 return employmentId;
}
async function assertReadOnlyHomePrincipalTx(tx:Tx,ctx:SessionContext):Promise<void>{
 const [snapshot]=await tx.execute<{safe:boolean}>(sql`select current_setting('transaction_isolation')='read committed'
  and current_setting('transaction_read_only')='on' as safe`);
 if(snapshot?.safe!==true)throw new HomeAccessError('employmentUnavailable');
 if(!ctx.userId)throw new HomeAccessError('authentication');
 if(await isAiPrincipalCurrentTx(tx,ctx)!==true)throw new HomeAccessError('employmentUnavailable');
}
/** Only complete read-only compositions can reuse the native own-subject proof in their carrier. */
export async function requireOwnHomeSubjectTx(tx:Tx,ctx:SessionContext,employmentId?:string):Promise<OwnEmploymentSubject>{
 await assertReadOnlyHomePrincipalTx(tx,ctx);
 return selectedHomeSubject(await ownHomeSubjectSelectionTx(tx,ctx,employmentId));
}

/** Use the exact active-employment predicate for a selected card that only needs its subject ID. */
export async function requireActiveOwnHomeEmploymentIdTx(tx:Tx,ctx:SessionContext,employmentId?:string):Promise<string>{
 await assertReadOnlyHomePrincipalTx(tx,ctx);
 const id=employmentId===undefined
  ? selectedHomeSubject(await ownHomeSubjectSelectionTx(tx,ctx)).employmentId
  : employmentId;
 if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
  ||!await isOwnProfileEditEmploymentTx(tx,ctx,id))throw new HomeAccessError('employmentUnavailable');
 return id;
}

function selectedHomeSubject(selection:OwnSelection):OwnEmploymentSubject{
 if(selection.state!=='selected')throw new HomeAccessError(selection.state==='choose'?'chooseEmployment':'employmentUnavailable');
 return selection.subject;
}

export async function readEmployeeHomeIdentity(ctx:SessionContext,requestedEmploymentId?:string):Promise<EmployeeHomeIdentity>{
 return withTenant(ctx,tx=>readEmployeeHomeIdentityTx(tx,ctx,requestedEmploymentId),{readOnlySnapshot:true});
}
/** Compose only inside a complete read-only snapshot; never carry this identity across requests.
 * All subject, actual-login, role and dated-company owners remain inside the same transaction. */
export async function readEmployeeHomeIdentityTx(tx:Tx,ctx:SessionContext,requestedEmploymentId?:string):Promise<EmployeeHomeIdentity>{
 return (await readEmployeeHomeIdentityContextTx(tx,ctx,requestedEmploymentId)).identity;
}

/** Keep the dated company proof inside the authorized Home read for configuration callers. */
export async function readEmployeeHomeIdentityContextTx(tx:Tx,ctx:SessionContext,requestedEmploymentId?:string):Promise<{
 identity:EmployeeHomeIdentity;companyId:string|null;
}>{
 const [snapshot]=await tx.execute<{safe:boolean}>(sql`select current_setting('transaction_isolation')='repeatable read'
  and current_setting('transaction_read_only')='on' as safe`);
 if(snapshot?.safe!==true)throw new HomeAccessError('employmentUnavailable');
 // This barrier belongs to the composed read. Ordinary subject preflight is also used by
 // greeting commands, whose canonical native command must retain its original first lock.
 await lockAccessConfigurationReadTx(tx,ctx.tenantId);
 const selection=await ownHomeSubjectSelectionTx(tx,ctx,requestedEmploymentId);
 // Flattened roles discard their company scope. For a selected employment use the canonical SQL
 // grant/subtree predicates so a manager or HR grant elsewhere cannot choose this company's policy.
 let role=resolveDashboardRole({admin:isAdmin(ctx),managerRole:(ctx.roles??[]).includes('manager'),hasDirectReports:false});
 if(selection.subject){
  const [proof]=await tx.execute(sql`SELECT app.own_home_dashboard_role(${selection.subject.employmentId}::uuid) AS role`) as unknown as {role:EmployeeHomeIdentity['role']|null}[];
  if(!proof?.role||!['employee','manager','hr_admin'].includes(proof.role))throw new HomeAccessError('employmentUnavailable');
  role=proof.role;
 }
 const companyId=selection.subject?.companyProof.companyId??null;
 return {companyId,identity:{version:1,
  role,
  employmentState:selection.state,selectedEmploymentId:selection.subject?.employmentId??null,
  companyEstablished:Boolean(companyId),
  employments:selection.subjects.map(row=>({employmentId:row.employmentId,employeeCode:row.employeeCode,company:row.company}))}};
}

/** A failure in greeting presentation belongs to that card, not to the selection/role context. The
 * independent reader still repeats the own-employment proof before retrieving any presentation fact.
 * Null means no recorded name/photo, never a swallowed read failure or a guessed fallback value.
 */
export async function readEmployeeHomeGreetingIdentity(ctx:SessionContext,requestedEmploymentId?:string):Promise<EmployeeHomeGreetingIdentity>{
 const subject=await requireOwnHomeSubject(ctx,requestedEmploymentId);
 const personId=ctx.personId;
 const [name,photo]=await Promise.all([
  personId?withTenant(ctx,async tx=>{
   const [row]=await tx.select({preferredName:person.preferredName,firstName:person.firstName,fullName:person.fullName})
    .from(person).where(and(eq(person.tenantId,ctx.tenantId),eq(person.id,personId))).limit(1);
   return row?employeeHomeGreetingName(row):null;
  }):Promise.resolve(null),
  personId?hasPersonPhoto(ctx,personId):Promise.resolve(false),
 ]);
 return {version:1,employmentId:subject.employmentId,name,photoHref:photo&&personId?`/personnel/photo/${encodeURIComponent(personId)}`:null};
}

/** Independent pay hint reader. Payroll repeats own-active/login and publication enforcement and
 * selects metadata only; Home never loads a monetary payslip and then removes its amounts. */
export async function readEmployeeHomePayHints(ctx:SessionContext,requestedEmploymentId?:string){
 const subject=await requireOwnHomeSubject(ctx,requestedEmploymentId);
 return readOwnPayrollHomeMetadata(ctx,subject.employmentId);
}

/** Canonical clock evidence and prerequisites. Commands still belong to the existing capture flow;
 * displaying this state never clocks a person in or supplies location/photo evidence. */
export async function readEmployeeHomeClock(ctx:SessionContext,requestedEmploymentId?:string){
 const subject=await requireOwnHomeSubject(ctx,requestedEmploymentId);
 return ownClockToday(ctx,undefined,subject.employmentId);
}

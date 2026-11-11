/** Salary-free self identity for employee Home. This is a read projection, not another personnel owner. */
import {and,eq,sql,type SQL} from 'drizzle-orm';
import {settleReadGroup} from '../lib/settle-read-group';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {isAiPrincipalCurrentTx,isAiPresentationPrincipalCurrentTx} from './ai-principal';
import {person} from '../db/schema';
import {isRepeatableReadOnlyTx} from './read-only-snapshot';
import {isCurrentOwnHomeEmploymentTx,isOwnProfileEditEmploymentTx,myOwnEmploymentSubjectsTx,type OwnEmploymentSubject} from './read';
import {hasPersonPhotoTx,hasPersonPhotoSnapshotTx,personPhotoSnapshotExistsSql} from './person-photo';
import {ownerCardSectionReads} from './home-owner-reads';
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
 const [principal]=await tx.execute<{ok:boolean}>(ownHomeSubjectPrincipalSql(ctx));
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

/** The own-subject selection's principal statement (a request preamble answers it ahead, decision 12). */
export function ownHomeSubjectPrincipalSql(ctx:SessionContext){
 return sql`SELECT (app.principal_snapshot_current()
   AND (${ctx.personId??null}::uuid IS NULL OR app.is_self_person(${ctx.personId??null}::uuid))) AS ok`;
}
/** The dashboard role statement of a selected own employment (a request preamble answers it ahead, decision 12). */
export function ownHomeDashboardRoleSql(employmentId:string|SQL){
 return sql`SELECT app.own_home_dashboard_role(${employmentId}::uuid) AS role`;
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
 return withTenant(ctx,tx=>requireSelectedOwnHomeEmploymentIdTx(tx,ctx,employmentId),{readOnlySnapshot:true});
}
export async function requireSelectedOwnHomeEmploymentIdTx(tx:Tx,ctx:SessionContext,employmentId:string):Promise<string>{
 if(!ctx.userId)throw new HomeAccessError('authentication');
 if(!await isCurrentOwnHomeEmploymentTx(tx,ctx,employmentId))throw new HomeAccessError('employmentUnavailable');
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
 return activeOwnHomeEmploymentIdTx(tx,ctx,employmentId);
}
/** The same active-subject predicate, admitted through an enforced presentation snapshot. */
export async function requireActiveOwnHomeSnapshotEmploymentIdTx(tx:Tx,ctx:SessionContext,employmentId?:string):Promise<string>{
 if(!ctx.userId)throw new HomeAccessError('authentication');
 if(!await isAiPresentationPrincipalCurrentTx(tx,ctx))throw new HomeAccessError('employmentUnavailable');
 return activeOwnHomeEmploymentIdTx(tx,ctx,employmentId);
}
async function activeOwnHomeEmploymentIdTx(tx:Tx,ctx:SessionContext,employmentId?:string):Promise<string>{
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
 identity:EmployeeHomeIdentity;companyId:string|null;hiredOn:string|null;
}>{
 if(!await isRepeatableReadOnlyTx(tx))throw new HomeAccessError('employmentUnavailable');
 // The repeatable read snapshot admits this presentation once. Its login, role,
 // subject and dated-company facts use the same committed view. Writers retain their barriers.
 const selection=await ownHomeSubjectSelectionTx(tx,ctx,requestedEmploymentId);
 // Flattened roles discard their company scope. For a selected employment use the canonical SQL
 // grant/subtree predicates so a manager or HR grant elsewhere cannot choose this company's policy.
 let role=resolveDashboardRole({admin:isAdmin(ctx),managerRole:(ctx.roles??[]).includes('manager'),hasDirectReports:false});
 if(selection.subject){
  const [proof]=await tx.execute(ownHomeDashboardRoleSql(selection.subject.employmentId)) as unknown as {role:EmployeeHomeIdentity['role']|null}[];
  if(!proof?.role||!['employee','manager','hr_admin'].includes(proof.role))throw new HomeAccessError('employmentUnavailable');
  role=proof.role;
 }
 const companyId=selection.subject?.companyProof.companyId??null;
 return {companyId,hiredOn:selection.subject?.hiredOn??null,identity:{version:1,
  role,
  employmentState:selection.state,selectedEmploymentId:selection.subject?.employmentId??null,
  companyEstablished:Boolean(companyId),
  employments:selection.subjects.map(row=>({employmentId:row.employmentId,employeeCode:row.employeeCode,company:row.company}))}};
}

/** A failure in greeting presentation belongs to that card, not to the selection/role context. The
 * independent reader still repeats the own-employment proof before retrieving any presentation fact.
 * Null means no recorded name/photo, never a swallowed read failure or a guessed fallback value.
 */
export function readEmployeeHomeGreetingIdentity(ctx:SessionContext,requestedEmploymentId?:string):Promise<EmployeeHomeGreetingIdentity>{
 return withTenant(ctx,tx=>readEmployeeHomeGreetingSnapshotIdentityTx(tx,ctx,requestedEmploymentId),{readOnlySnapshot:true});
}

/** Call before presentation queries so the photo policy retains its read-committed read-only transaction. */
export async function readEmployeeHomeGreetingIdentityTx(tx:Tx,ctx:SessionContext,requestedEmploymentId?:string):Promise<EmployeeHomeGreetingIdentity>{
 await tx.execute(sql`SET TRANSACTION READ ONLY`);
 return greetingIdentityInputsTx(tx,ctx,requestedEmploymentId);
}
export async function readEmployeeHomeGreetingSnapshotIdentityTx(tx:Tx,ctx:SessionContext,requestedEmploymentId?:string):Promise<EmployeeHomeGreetingIdentity>{
 if(!ctx.userId)throw new HomeAccessError('authentication');
 if(!await isAiPresentationPrincipalCurrentTx(tx,ctx))throw new HomeAccessError('employmentUnavailable');
 return greetingIdentityInputsTx(tx,ctx,requestedEmploymentId,{presentationSnapshot:true});
}
async function greetingIdentityInputsTx(tx:Tx,ctx:SessionContext,requestedEmploymentId?:string,options?:{presentationSnapshot:true}):Promise<EmployeeHomeGreetingIdentity>{
 const employmentId=requestedEmploymentId===undefined
  ? selectedHomeSubject(await ownHomeSubjectSelectionTx(tx,ctx)).employmentId
  : await requireSelectedOwnHomeEmploymentIdTx(tx,ctx,requestedEmploymentId);
 const personId=ctx.personId;
 if(!personId)return {version:1,employmentId,name:null,photoHref:null};
 if(options?.presentationSnapshot&&!ownerCardSectionReads()){
  const facts=await greetingFactsSnapshotTx(tx,ctx,personId);
  return {version:1,employmentId,name:facts.name,photoHref:facts.photo?`/personnel/photo/${encodeURIComponent(personId)}`:null};
 }
 const [rows,photo]=await settleReadGroup([
  ()=>tx.select({preferredName:person.preferredName,firstName:person.firstName,fullName:person.fullName})
   .from(person).where(and(eq(person.tenantId,ctx.tenantId),eq(person.id,personId))).limit(1),
  ()=>(options?.presentationSnapshot?hasPersonPhotoSnapshotTx:hasPersonPhotoTx)(tx,ctx,personId),
 ]);
 return {version:1,employmentId,name:rows[0]?employeeHomeGreetingName(rows[0]):null,
  photoHref:photo?`/personnel/photo/${encodeURIComponent(personId)}`:null};
}

/** The greeting's own facts in ONE statement (docs/adr/2026-11-10-home-request-read-scope.md decision 13). The photo
 * owner's admission proof and visibility policy are read first, exactly as hasPersonPhotoSnapshotTx reads them; `more`
 * then reads whatever the caller needs before its own facts (the greeting card's display preferences) and names further
 * sub-selects of the same statement. The statement carries the recorded names (the select greetingIdentityInputsTx sends),
 * whether a photo the caller may see exists (that owner's existence predicate) and each of `more`'s values. */
async function greetingFactsSnapshotTx(tx:Tx,ctx:SessionContext,personId:string,more?:()=>Promise<Readonly<Record<string,SQL>>>){
 const photo=await personPhotoSnapshotExistsSql(tx,ctx,personId);
 const extra=Object.entries(more?await more():{});
 const names=sql`(select jsonb_build_object('preferredName',${person.preferredName},'firstName',${person.firstName},'fullName',${person.fullName})
  from ${person} where ${and(eq(person.tenantId,ctx.tenantId),eq(person.id,personId))} limit 1)`;
 const [row]=await tx.execute<Record<string,unknown>>(sql`select ${names} as names,${photo} as photo${sql.join(extra.map(([key,value])=>sql`,${value} as ${sql.identifier(key)}`))}`);
 if(!row||typeof row.photo!=='boolean')throw new Error('Own greeting facts unavailable');
 const recorded=row.names as {preferredName:string|null;firstName:string|null;fullName:string|null}|null;
 return {name:recorded?employeeHomeGreetingName(recorded):null,photo:row.photo,
  more:Object.fromEntries(extra.map(([key])=>[key,row[key]])) as Record<string,unknown>};
}
/** The greeting card's own facts in one statement (decision 13): readEmployeeHomeGreetingSnapshotIdentityTx's login,
 * principal and selection checks in the same order, then greetingFactsSnapshotTx with the card's own `more`. Null where
 * the card reads as before: under withOwnerCardSectionReads, or for a login without a person. */
export async function readEmployeeHomeGreetingCardFactsTx(tx:Tx,ctx:SessionContext,requestedEmploymentId:string,more:()=>Promise<Readonly<Record<string,SQL>>>):Promise<{
 identity:EmployeeHomeGreetingIdentity;more:Record<string,unknown>;
}|null>{
 if(ownerCardSectionReads()||!ctx.personId)return null;
 if(!ctx.userId)throw new HomeAccessError('authentication');
 if(!await isAiPresentationPrincipalCurrentTx(tx,ctx))throw new HomeAccessError('employmentUnavailable');
 const employmentId=await requireSelectedOwnHomeEmploymentIdTx(tx,ctx,requestedEmploymentId),personId=ctx.personId;
 const facts=await greetingFactsSnapshotTx(tx,ctx,personId,more);
 return {identity:{version:1,employmentId,name:facts.name,photoHref:facts.photo?`/personnel/photo/${encodeURIComponent(personId)}`:null},more:facts.more};
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

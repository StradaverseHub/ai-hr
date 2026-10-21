/** Salary-free self identity for employee Home. This is a read projection, not another personnel owner. */
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {person} from '../db/schema';
import {myOwnEmploymentSubjects,reportingLinesFor,type OwnEmploymentSubject} from './read';
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
 if(!ctx.userId)throw new HomeAccessError('authentication');
 const subjects=await myOwnEmploymentSubjects(ctx);
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
 const selection=await ownHomeSubjectSelection(ctx,employmentId);
 if(selection.state!=='selected')throw new HomeAccessError(selection.state==='choose'?'chooseEmployment':'employmentUnavailable');
 return selection.subject;
}

export async function readEmployeeHomeIdentity(ctx:SessionContext,requestedEmploymentId?:string):Promise<EmployeeHomeIdentity>{
 const selection=await ownHomeSubjectSelection(ctx,requestedEmploymentId);
 const lines=selection.subject?await reportingLinesFor(ctx,selection.subject.employmentId):null;
 return {version:1,
  role:resolveDashboardRole({admin:isAdmin(ctx),managerRole:(ctx.roles??[]).includes('manager'),hasDirectReports:(lines?.reports.length??0)>0}),
  employmentState:selection.state,selectedEmploymentId:selection.subject?.employmentId??null,
  companyEstablished:Boolean(selection.subject?.companyProof.companyId),
  employments:selection.subjects.map(row=>({employmentId:row.employmentId,employeeCode:row.employeeCode,company:row.company}))};
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

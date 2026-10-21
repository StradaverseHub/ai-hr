/** Salary-free self identity for employee Home. This is a read projection, not another personnel owner. */
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {person} from '../db/schema';
import {myOwnEmploymentSubjects,reportingLinesFor,type OwnEmploymentSubject} from './read';
import {hasPersonPhoto} from './person-photo';
import {isAdmin} from '../lib/authz-model';
import {resolveDashboardRole} from '../lib/dashboard-cards';
import {employeeHomeGreetingName} from '../lib/employee-home';
import type {EmployeeHomeIdentity} from '../lib/employee-home-read-model';

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
 const personId=ctx.personId;
 const [name,photo,lines]=await Promise.all([
  personId?withTenant(ctx,async tx=>{
   const [row]=await tx.select({preferredName:person.preferredName,firstName:person.firstName,fullName:person.fullName})
    .from(person).where(and(eq(person.tenantId,ctx.tenantId),eq(person.id,personId))).limit(1);
   return row?employeeHomeGreetingName(row):null;
  }):Promise.resolve(null),
  personId?hasPersonPhoto(ctx,personId):Promise.resolve(false),
  selection.subject?reportingLinesFor(ctx,selection.subject.employmentId):Promise.resolve(null),
 ]);
 return {version:1,name,photoHref:photo&&personId?`/personnel/photo/${encodeURIComponent(personId)}`:null,
  role:resolveDashboardRole({admin:isAdmin(ctx),managerRole:(ctx.roles??[]).includes('manager'),hasDirectReports:(lines?.reports.length??0)>0}),
  employmentState:selection.state,selectedEmploymentId:selection.subject?.employmentId??null,
  companyEstablished:Boolean(selection.subject?.companyProof.companyId),
  employments:selection.subjects.map(row=>({employmentId:row.employmentId,employeeCode:row.employeeCode,company:row.company}))};
}

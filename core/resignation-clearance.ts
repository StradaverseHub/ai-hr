/** Offboarding posting composition. Personnel owns approved movements; journey and clearance only propose them. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {createPersonnelPostingTx,PersonnelPostingError,personnelPostingTx} from './personnel-posting';
import type {PersonnelPostingValues} from '../lib/personnel-posting';

export type RetentionPostingInput={
 journeyId:string;employmentId:string;companyId?:string;
 offer:{position:string;jobGrade:string;basicSalary:string;effectiveDate:string};
 approverGroupId:string;eventKey:string;dueOn?:string|null;
 eventType?:'promotion'|'transfer'|'increment'|'confirmation'|'salaryAdjustment'|'employmentTypeChange';
 fields?:readonly ('position'|'jobGrade'|'basicSalary')[];
};
/** Resolve the accepted labels to scoped, current Personnel identifiers. Never create master data from an offer. */
export async function createResignationRetentionPostingTx(tx:Tx,_ctx:SessionContext,input:RetentionPostingInput):Promise<{id:string;number:number}>{
 const [resolved]=await tx.execute<{terms:{companyId:string;positions:{id:string;title:string}[];grades:{id:string;code:string}[]}}>(sql`select app.offboarding_posting_terms(${input.journeyId}::uuid) as terms`);
 if(!resolved?.terms)throw new PersonnelPostingError('forbidden','The accepted offer is unavailable.');
 const fields=input.fields??['position','jobGrade','basicSalary'];
 const proposed:PersonnelPostingValues={effectiveDate:input.offer.effectiveDate};
 if(fields.includes('position')){
  const positions=resolved.terms.positions;
  if(positions.length!==1)throw new PersonnelPostingError('invalid','Choose one unambiguous Position from Personnel Management before retrying the offer posting.');
  proposed.positionId=positions[0].id;proposed.position=positions[0].title;
 }
 if(fields.includes('jobGrade')){
  const grades=resolved.terms.grades;
  if(grades.length!==1)throw new PersonnelPostingError('invalid','Choose one unambiguous Job Grade from Personnel Management before retrying the offer posting.');
  proposed.gradeId=grades[0].id;proposed.jobGrade=grades[0].code;
 }
 if(fields.includes('basicSalary'))proposed.basicSalary=input.offer.basicSalary;
 return createPersonnelPostingTx(tx,{source:'offboarding',sourceRef:input.journeyId,employmentId:input.employmentId,eventType:input.eventType??'promotion',proposed,approverGroupId:input.approverGroupId,idempotencyKey:input.eventKey,dueOn:input.dueOn});
}

/** Called after the V9 cleared revision is stored, in the same transaction. Unmanaged/legacy cases are untouched. */
export async function raiseResignationClearancePostingTx(tx:Tx,ctx:SessionContext,input:{caseId:string;employmentId:string;lastWorkingDay:string;exitReason?:string}):Promise<{id:string;number:number}|null>{
 const [managed]=await tx.execute<{id:string;submittedOn:string;groupId:string|null;employmentId:string;companyId:string;nativeCompanyId:string|null;nativeEmploymentId:string|null;module:string|null;state:string|null;source:string|null;exitReason:string|null;lastDay:string|null}>(sql`
  select j.id,j.submitted_on::text as "submittedOn",j.employment_id as "employmentId",j.company_id as "companyId",
   n.company_id as "nativeCompanyId",n.employment_id as "nativeEmploymentId",n.module,n.data->>'state' as state,n.data->>'resignationSourceCaseId' as source,n.data->'facts'->>'caseType' as "exitReason",n.data->'facts'->>'lastDay' as "lastDay",
   CASE WHEN c.data->'offboarding' ? 'postingApproverGroupId' THEN c.data->'offboarding'->>'postingApproverGroupId' ELSE c.data->>'peopleOpsGroup' END as "groupId"
  from resignation_journey j join lc_v9_config c on c.tenant_id=j.tenant_id
  left join lc_v9_case n on n.tenant_id=j.tenant_id and n.id=j.offboarding_case_id
  where j.tenant_id=app.current_tenant_id() and j.offboarding_case_id=${input.caseId}::uuid`);
 if(!managed)return null;
 // The case owns its exit classification. Caller labels must never replace that native fact.
 if(managed.employmentId!==input.employmentId||managed.nativeEmploymentId!==managed.employmentId||managed.nativeCompanyId!==managed.companyId||managed.module!=='off'||managed.state!=='cleared'||managed.source!==managed.id||managed.lastDay!==input.lastWorkingDay||!managed.exitReason||!['Resignation','Termination','Contract end','Retirement','Non-confirmation'].includes(managed.exitReason))throw new PersonnelPostingError('invalid','Clearance posting requires the matching completed Offboarding case and its exit reason.');
 if(!managed.groupId)throw new PersonnelPostingError('invalid','Choose who approves Offboarding Personnel postings before clearance.');
 return createPersonnelPostingTx(tx,{source:'offboarding',sourceRef:managed.id,employmentId:input.employmentId,eventType:'termination',proposed:{effectiveDate:input.lastWorkingDay,resignationDate:managed.submittedOn,exitReason:managed.exitReason},approverGroupId:managed.groupId,idempotencyKey:'clearance:'+input.caseId});
}

/** Current pending assignments move atomically with the config save; empty groups deliberately leave them in place. */
export async function reassignOffboardingPostingsTx(tx:Tx,_ctx:SessionContext,previousGroupId:string|null,nextGroupId:string|null):Promise<number>{
 if(previousGroupId===nextGroupId||!nextGroupId)return 0;
 const [row]=await tx.execute<{count:number}>(sql`select app.offboarding_posting_reassign(${previousGroupId},${nextGroupId}) as count`);
 return row?.count??0;
}

export async function rejectOffboardingPostingTx(tx:Tx,ctx:SessionContext,input:{id:string;revision:number;reason:string}):Promise<void>{
 const posting=await personnelPostingTx(tx,input.id);
 if(!posting||posting.source!=='offboarding')throw new PersonnelPostingError('not_found','Posting not found.');
 await tx.execute(sql`select app.offboarding_posting_reject(${input.id}::uuid,${input.revision},${input.reason})`);
 const {resumeResignationPostingTx}=await import('./resignation-journey');
 await resumeResignationPostingTx(tx,ctx,posting.sourceRef,posting.id,'rejected',input.reason);
}

export async function offboardingPostingChoices(ctx:SessionContext,id:string,search=''):Promise<{positions:{id:string;name:string}[];grades:{id:string;code:string;name:string}[]}>{
 const {withTenant}=await import('../db/client');
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{choices:{positions:{id:string;name:string}[];grades:{id:string;code:string;name:string}[]}}>(sql`select app.offboarding_posting_choices(${id}::uuid,${search.slice(0,120)}) as choices`);
  if(!row?.choices)throw new PersonnelPostingError('not_found','Posting not found.');
  return row.choices;
 });
}
export async function rejectOffboardingPosting(ctx:SessionContext,input:{id:string;revision:number;reason:string}):Promise<void>{
 const {withTenant}=await import('../db/client');return withTenant(ctx,tx=>rejectOffboardingPostingTx(tx,ctx,input));
}
/** Navigation fact only; every row and mutation repeats its native authority. */
export async function offboardingPostingAccess(ctx:SessionContext):Promise<boolean>{
 const {withScopedLifecycleTenant}=await import('./module-gate');
 return withScopedLifecycleTenant(ctx,async tx=>{const [row]=await tx.execute<{ok:boolean}>(sql`select app.offboarding_posting_queue_access() as ok`);return !!row?.ok;});
}

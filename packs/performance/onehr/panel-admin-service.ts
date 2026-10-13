import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../../db/client';
import { assessmentRelease, company, employment, jobGrade, onehrPanel, onehrResult, onehrReview, performanceReview, person } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import { loadAssessmentAdminCycleTx, auditAssessmentAdminTx } from './admin-context';
import { additivePanelPlan, buildPanelCandidates, panelImportRows, type PanelPerson, type PanelRelationship } from './panel-build-model';
import { assignOnehrPanelTx, changeAssessmentPanelStateTx } from './service';

async function applyOrValidate(tx:Tx,apply:boolean,write:(tx:Tx)=>Promise<void>){
 if(apply){await write(tx);return;}
 const previewRollback=new Error('Panel preview rollback');
 try{await tx.transaction(async check=>{await write(check);throw previewRollback;});}catch(error){if(error!==previewRollback)throw error;}
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function population(tx:Tx,cycleId:string){
 const today=todayInKualaLumpur();
 const rows=await tx.select({id:employment.id,personId:employment.personId,code:employment.employeeCode,name:person.fullName,companyId:employment.companyId,groupId:sql<string>`coalesce(${company.parentCompanyId},${company.id})`,grade:jobGrade.code,joinedOn:employment.hiredOn,
  department:sql<string>`coalesce((select d.name from assignment a join department d on d.id=a.department_id and d.tenant_id=a.tenant_id where a.employment_id=${employment.id} and a.superseded_at is null and a.valid_from<=${today}::date and (a.valid_to is null or a.valid_to>${today}::date) order by a.valid_from desc,a.id limit 1),'')`,
  managerId:sql<string|null>`coalesce((select pr.reviewer_employment_id from performance_review pr where pr.employment_id=${employment.id} and pr.cycle_id=${cycleId}::uuid),(select l.manager_employment_id from reporting_line l where l.subordinate_employment_id=${employment.id} and l.line_type='administrative' and l.superseded_at is null and l.valid_from<=${today}::date and (l.valid_to is null or l.valid_to>${today}::date) order by l.valid_from desc,l.id limit 1))`,
  participates:sql<boolean>`exists(select 1 from performance_onehr_review r where r.employment_id=${employment.id} and r.cycle_id=${cycleId}::uuid and app.assessment_review_participates(r.review_id))`,
  canAssess:sql<boolean>`exists(select 1 from app_user u where u.tenant_id=${employment.tenantId} and u.person_id=${employment.personId} and u.archived_at is null and not app.login_blocked(u.id))`,
 }).from(employment).innerJoin(person,eq(person.id,employment.personId)).innerJoin(company,eq(company.id,employment.companyId)).leftJoin(jobGrade,eq(jobGrade.id,employment.gradeId)).where(sql`(${employment.terminatedOn} is null or ${employment.terminatedOn}>${today}::date)`).orderBy(asc(employment.employeeCode),asc(employment.id));
 return rows.map(r=>({...r,grade:/^\d+$/.test((r.grade??'').replace(/^JG\s*/i,''))?Number(r.grade!.replace(/^JG\s*/i,'')):null,service:Math.max(0,(Date.parse(today)-Date.parse(r.joinedOn))/(365.25*86400000))})) satisfies PanelPerson[];
}
async function state(tx:Tx,cycleId:string){
 const reviews=await tx.select({id:onehrReview.reviewId,employmentId:onehrReview.employmentId,revision:onehrReview.revision,grade:onehrReview.grade,finalized:sql<boolean>`${performanceReview.closedAt} is not null or ${onehrResult.id} is not null`,released:sql<boolean>`case when ${assessmentRelease.reviewId} is not null then ${assessmentRelease.feedbackReleasedAt} is not null else ${onehrResult.feedbackReleasedAt} is not null end`,self:sql<boolean>`app.is_self_person(${employment.personId})`})
  .from(onehrReview).innerJoin(performanceReview,eq(performanceReview.id,onehrReview.reviewId)).innerJoin(employment,eq(employment.id,onehrReview.employmentId)).leftJoin(onehrResult,eq(onehrResult.reviewId,onehrReview.reviewId)).leftJoin(assessmentRelease,eq(assessmentRelease.reviewId,onehrReview.reviewId))
  .where(and(eq(onehrReview.cycleId,cycleId),sql`app.onehr_admin(${onehrReview.companyId}) and app.onehr_admin(${employment.companyId})`)).orderBy(asc(onehrReview.reviewId)).for('update',{of:onehrReview});
 const panels=await tx.select({requestId:onehrPanel.requestId,reviewId:onehrPanel.reviewId,employmentId:onehrPanel.peerEmploymentId,personId:employment.personId,relationship:onehrPanel.relationship,archivedAt:onehrPanel.archivedAt,submittedAt:onehrPanel.submittedAt}).from(onehrPanel).innerJoin(onehrReview,eq(onehrReview.reviewId,onehrPanel.reviewId)).innerJoin(employment,eq(employment.id,onehrPanel.peerEmploymentId)).where(eq(onehrReview.cycleId,cycleId)).orderBy(asc(onehrPanel.requestId));
 return {reviews,panels};
}
export async function buildAssessmentPanels(ctx:SessionContext,cycleId:string,mode:'missing'|'topup',token?:string){
 z.enum(['missing','topup']).parse(mode);
 return withPerformanceTenant(ctx,async tx=>{
  const cycle=await loadAssessmentAdminCycleTx(tx,cycleId);if(!cycle.policy.modules.tm)throw Error('Talent assessment is disabled.');if(cycle.cycle.status==='draft')throw Error('Open the cycle before building panels.');
  const people=await population(tx,cycleId),current=await state(tx,cycleId),byId=new Map(people.map(p=>[p.id,p]));
  const [loads]=await tx.execute<{value:Record<string,number>}>(sql`select app.assessment_peer_load(${cycleId}::uuid) as value`);
  const candidates=buildPanelCandidates(people,cycle.policy.panelTarget,loads.value);
  const rows=current.reviews.filter(r=>!r.self).flatMap(r=>{
   const candidate=candidates.find(p=>p.subjectId===r.employmentId),subject=byId.get(r.employmentId);if(!candidate||!subject)return [];
   const existing=current.panels.filter(p=>p.reviewId===r.id).map(p=>({...p,archived:!!p.archivedAt,submitted:!!p.submittedAt}));
   const target=subject.grade==null?1:cycle.policy.panelTarget,plan=additivePanelPlan(candidate,existing,mode,target,r.released,r.finalized);
   return [{reviewId:r.id,revision:r.revision,code:subject.code,name:subject.name,target,managerStatus:candidate.managerStatus,...plan,members:[...existing.filter(p=>!p.archived).map(p=>({employmentId:p.employmentId,relationship:p.relationship as PanelRelationship})),...plan.add.map(p=>({employmentId:p.employmentId,relationship:p.relationship}))]}];
  });
  const currentToken=digest({revision:cycle.config.revision,mode,people,current,rows});if(token&&token!==currentToken)throw Error('People, panels or cycle rules changed. Preview the build again.');
  await applyOrValidate(tx,!!token,async write=>{for(const row of rows)if(row.add.length)await assignOnehrPanelTx(write,ctx,row.reviewId,row.revision,row.members);});
  if(token)await auditAssessmentAdminTx(tx,ctx,cycleId,'panels-built',{mode,subjects:rows.filter(r=>r.add.length).length,assignments:rows.reduce((n,r)=>n+r.add.length,0)});
  return {token:currentToken,applied:!!token,rows:rows.map(({members,revision,...row})=>({...row,add:row.add.map(m=>({...m,name:byId.get(m.employmentId)?.name??m.employmentId}))}))};
 });
}
export async function importAssessmentPanels(ctx:SessionContext,cycleId:string,csv:string,mode:'add'|'replace',token?:string){
 z.enum(['add','replace']).parse(mode);const parsed=panelImportRows(csv);
 return withPerformanceTenant(ctx,async tx=>{
  const cycle=await loadAssessmentAdminCycleTx(tx,cycleId);if(!cycle.policy.modules.tm)throw Error('Talent assessment is disabled.');
  if(cycle.cycle.status==='draft')throw Error('Open the cycle before assigning panels.');
  const people=await population(tx,cycleId),current=await state(tx,cycleId);
  const resolve=(key:string)=>{const exact=people.find(p=>p.code===key);if(exact)return exact;const named=people.filter(p=>p.name===key);if(named.length!==1)throw Error(`Employee ${key} is unavailable or ambiguous in your scope. Use the exact Employee ID.`);return named[0];};
  const incoming=new Map<string,Map<string,PanelRelationship>>();
  for(const row of parsed){
   const subject=resolve(row.subject),assessor=resolve(row.assessor),review=current.reviews.find(r=>r.employmentId===subject.id);
   if(!review||!subject.participates||review.self||review.finalized)throw Error(`Row ${row.row}: the subject is unavailable, finalized or outside your administration scope.`);
   if(subject.personId===assessor.personId||assessor.grade==null)throw Error(`Row ${row.row}: choose a different active assessor with a numeric job grade.`);
   if(row.relationship==='line_manager'&&assessor.id!==subject.managerId||row.relationship==='direct_report'&&assessor.managerId!==subject.id)throw Error(`Row ${row.row}: the relationship disagrees with the current review or organization.`);
   const selected=incoming.get(review.id)??new Map<string,PanelRelationship>();if(selected.has(assessor.id))throw Error(`Row ${row.row}: this subject/assessor pair appears twice.`);selected.set(assessor.id,row.relationship);incoming.set(review.id,selected);
  }
  const plans=[...incoming].map(([reviewId,selected])=>{
   const review=current.reviews.find(r=>r.id===reviewId)!,subject=people.find(p=>p.id===review.employmentId)!,prior=current.panels.filter(p=>p.reviewId===reviewId);
   const members=new Map<string,PanelRelationship>(mode==='add'?prior.filter(p=>!p.archivedAt).map(p=>[p.employmentId,p.relationship as PanelRelationship]):[]);
   const newManager=[...selected].find(([,rel])=>rel==='line_manager')?.[0];
   if(newManager)for(const [id,rel] of members)if(rel==='line_manager'&&id!==newManager)members.set(id,'matrix_manager');
   for(const [id,rel] of selected)members.set(id,rel);
   if(prior.some(p=>!p.archivedAt&&p.submittedAt&&!members.has(p.employmentId)))throw Error(`Keep every submitted assessor for ${subject.name}, or archive their feedback explicitly first.`);
   const target=subject.grade==null?1:cycle.policy.panelTarget;
   if(members.size>target||new Set([...members.keys()].map(id=>people.find(p=>p.id===id)?.personId??id)).size!==members.size)throw Error(`The panel for ${subject.name} exceeds its limit or contains the same person twice.`);
   const restore=prior.filter(p=>p.archivedAt&&p.submittedAt&&members.has(p.employmentId));
   const archive=prior.filter(p=>!p.archivedAt&&!members.has(p.employmentId));
   return {reviewId,revision:review.revision,code:subject.code,name:subject.name,members:[...members].map(([employmentId,relationship])=>({employmentId,relationship})),restore,archive,created:[...members.keys()].filter(id=>!prior.some(p=>p.employmentId===id)).length,updated:[...members].filter(([id,rel])=>prior.some(p=>p.employmentId===id&&(p.archivedAt||p.relationship!==rel))).length};
  });
  const currentToken=digest({revision:cycle.config.revision,mode,parsed,people,current,plans});if(token&&token!==currentToken)throw Error('People or panels changed. Preview the import again.');
  await applyOrValidate(tx,!!token,async write=>{for(const plan of plans){let revision=plan.revision;for(const p of plan.archive){await changeAssessmentPanelStateTx(write,ctx,plan.reviewId,revision++,p.requestId,'archive','Panel import replace');}for(const p of plan.restore){await changeAssessmentPanelStateTx(write,ctx,plan.reviewId,revision++,p.requestId,'restore','Panel import restore');}await assignOnehrPanelTx(write,ctx,plan.reviewId,revision,plan.members);}});
  if(token){
   await auditAssessmentAdminTx(tx,ctx,cycleId,'panels-imported',{mode,subjects:plans.length,created:plans.reduce((n,p)=>n+p.created,0),restored:plans.reduce((n,p)=>n+p.restore.length,0),archived:plans.reduce((n,p)=>n+p.archive.length,0)});
  }
  return {token:currentToken,applied:!!token,rows:plans.map(p=>({reviewId:p.reviewId,code:p.code,name:p.name,count:p.members.length,created:p.created,updated:p.updated,restored:p.restore.length,archived:p.archive.length}))};
 });
}

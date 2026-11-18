import {withCanonicalAiReadTx} from '../../../core/ai-read-transaction';
import { and,asc,eq,isNull,sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext,Tx } from '../../../db/client';
import { withPerformanceTenant } from '../../../core/module-gate';
import { company,onehrCalibration,onehrCalibrationEntry,onehrCycle,onehrPanel,onehrPlan,onehrReview,person,reviewCycle } from '../../../db/schema';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import { auditAssessmentAdminTx } from './admin-context';
import { toCsv } from '../../../lib/csv';
import { kpiSchema,policySchema } from './model';
import { assessmentProgress,progressModules,type ProgressModule,type ProgressState } from './progress-model';
import { onehrLabel } from './person-labels';
import { onehrEmployment } from './employment-projection';

async function cycleFor(tx:Tx,cycleId:string){
 const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.onehr_cycle_admin(${cycleId}::uuid) as ok`);if(!allowed?.ok)throw Error('Performance administrator access is required.');
 const [config]=await tx.select({policy:onehrCycle.policy,cycle:reviewCycle}).from(onehrCycle).innerJoin(reviewCycle,eq(reviewCycle.id,onehrCycle.cycleId)).where(eq(onehrCycle.cycleId,cycleId));if(!config)throw Error('Assessment cycle not found.');return config;
}
const filterSchema=z.object({companyId:z.uuid().optional(),department:z.string().max(300).optional(),businessGroup:z.string().max(300).optional(),q:z.string().max(200).optional(),module:z.enum(progressModules).default('pm'),state:z.enum(['all','pending','active','done']).default('all')});
/** HR gets completion metadata only. Private drafts, answers, conversations and anonymous feedback never cross this DTO.
 * Employment and assignment come through the OneHR projection views (VF-07); HR reads its own rows, unchanged. */
export async function getAssessmentProgress(ctx:SessionContext,cycleId:string,raw:unknown={},existingTx?:Tx){
 z.uuid().parse(cycleId);const filter=filterSchema.parse(raw);
 return withCanonicalAiReadTx(ctx,existingTx,'performance',withPerformanceTenant,async tx=>{
  const config=await cycleFor(tx,cycleId);
  const policy=policySchema.parse(config.policy),today=todayInKualaLumpur(),year=Number(config.cycle.periodEnd.slice(0,4))+(policy.kind==='year_end'?1:0);
  const population=await tx.select({review:onehrReview,name:onehrLabel.labelOrPerson(person.fullName,onehrEmployment.id),code:onehrEmployment.employeeCode,company:company.legalName,companyId:onehrReview.companyId,group:sql<string>`coalesce((select c.legal_name from company c where c.id=${company.parentCompanyId} and c.tenant_id=${company.tenantId}),'')`,department:sql<string>`coalesce((select d.name from app.onehr_assignment a join department d on d.id=a.department_id and d.tenant_id=a.tenant_id where a.employment_id=${onehrReview.employmentId} and a.tenant_id=${onehrReview.tenantId} and a.superseded_at is null and a.valid_from<=${today}::date and (a.valid_to is null or a.valid_to>${today}::date) order by a.valid_from desc,a.id limit 1),'')`}).from(onehrReview).innerJoin(onehrEmployment,eq(onehrEmployment.id,onehrReview.employmentId)).leftJoin(person,eq(person.id,onehrEmployment.personId)).innerJoin(company,eq(company.id,onehrReview.companyId)).where(and(eq(onehrReview.cycleId,cycleId),filter.companyId?eq(onehrReview.companyId,filter.companyId):undefined,sql`app.onehr_admin(${onehrReview.companyId}) and app.assessment_review_participates(${onehrReview.reviewId}) and (${person.id} is not null or ${onehrLabel.visible(onehrEmployment.id)})`)).orderBy(asc(onehrLabel.labelOrPerson(person.fullName,onehrEmployment.id)),asc(onehrReview.reviewId)).limit(20001);
  if(population.length>20000)throw Error('Narrow the company filter to view at most 20,000 assessments.');
  const panels=await tx.select({reviewId:onehrPanel.reviewId,submittedAt:onehrPanel.submittedAt}).from(onehrPanel).innerJoin(onehrReview,eq(onehrReview.reviewId,onehrPanel.reviewId)).where(and(eq(onehrReview.cycleId,cycleId),isNull(onehrPanel.archivedAt)));
  const plans=await tx.select({employmentId:onehrPlan.employmentId,status:onehrPlan.status}).from(onehrPlan).where(eq(onehrPlan.planYear,year));
  const calibration=await tx.select({reviewId:onehrCalibrationEntry.reviewId,band:onehrCalibrationEntry.potential,locked:sql<boolean>`app.assessment_calibration_axis_confirmed(${onehrCalibration.tier},${onehrCalibrationEntry.potentialLockedAt},${onehrCalibration.potentialLockedAt})`}).from(onehrCalibrationEntry).innerJoin(onehrCalibration,eq(onehrCalibration.id,onehrCalibrationEntry.sessionId)).where(eq(onehrCalibration.cycleId,cycleId));
  const panelCounts=new Map<string,{total:number;submitted:number}>();for(const p of panels){const count=panelCounts.get(p.reviewId)??{total:0,submitted:0};count.total++;if(p.submittedAt)count.submitted++;panelCounts.set(p.reviewId,count);}
  const planStates=new Map(plans.map(p=>[p.employmentId,p.status])),calibrationStates=new Map<string,'none'|'draft'|'locked'>();
  for(const d of calibration){const previous=calibrationStates.get(d.reviewId)??'none';calibrationStates.set(d.reviewId,d.locked?'locked':previous==='locked'?previous:d.band?'draft':previous);}
  const rows=population.map(({review:r,...p})=>{
   const panelCount=panelCounts.get(r.reviewId)??{total:0,submitted:0};
   const cells=assessmentProgress({kpis:kpiSchema.array().parse(r.kpis),performanceConfirmed:!!r.managerPerformance,resultsSubmitted:!!r.resultsSubmittedAt,competencyStatus:r.competencyStatus,competencyCount:Array.isArray(r.competencies)?r.competencies.length:0,panelCount:panelCount.total,panelSubmitted:panelCount.submitted,calibration:calibrationStates.get(r.reviewId)??'none',planStatus:planStates.get(r.employmentId)??null,policy});
   return {...p,reviewId:r.reviewId,grade:r.grade,cells};
  }).filter(r=>(!filter.department||r.department===filter.department)&&(!filter.businessGroup||r.group===filter.businessGroup)&&(!filter.q||[r.name,r.code,r.company,r.department].some(s=>s?.toLocaleLowerCase().includes(filter.q!.toLocaleLowerCase()))));
  const availableModules=progressModules.filter(m=>rows.some(r=>r.cells[m]));if(!availableModules.includes(filter.module)&&availableModules[0])filter.module=availableModules[0];
  const counts=Object.fromEntries(progressModules.map(module=>[module,Object.fromEntries((['pending','active','done'] as const).map(state=>[state,rows.filter(r=>r.cells[module]?.state===state).length]))])) as Record<ProgressModule,Record<ProgressState,number>>;
  return {availableModules,cycle:{id:cycleId,name:config.cycle.name,status:config.cycle.status},filter,counts,rows:rows.filter(r=>r.cells[filter.module]&&(filter.state==='all'||r.cells[filter.module]?.state===filter.state))};
 });
}
export async function exportAssessmentProgress(ctx:SessionContext,cycleId:string,raw:unknown={}){
 const data=await getAssessmentProgress(ctx,cycleId,raw),module=data.filter.module;await withPerformanceTenant(ctx,tx=>auditAssessmentAdminTx(tx,ctx,cycleId,'progress-exported',{people:data.rows.length,filters:data.filter}));
 return toCsv([['Employee ID','Employee Name','Business Group','Company','Department','Job Grade','Module','State','Status','Completed','Total'],...data.rows.map(r=>[r.code,r.name,r.group,r.company,r.department,r.grade,module,r.cells[module]!.state,r.cells[module]!.label,r.cells[module]!.completed,r.cells[module]!.count])]);
}

export async function getAssessmentAssessorProgress(ctx:SessionContext,cycleId:string){
 z.uuid().parse(cycleId);
 return withPerformanceTenant(ctx,async tx=>{
  await cycleFor(tx,cycleId);const today=todayInKualaLumpur();
  const panels=await tx.select({requestId:onehrPanel.requestId,employmentId:onehrPanel.peerEmploymentId,name:onehrLabel.labelOrPerson(person.fullName,onehrEmployment.id),code:onehrEmployment.employeeCode,email:person.primaryEmail,company:company.legalName,group:sql<string>`coalesce((select c.legal_name from company c where c.id=${company.parentCompanyId} and c.tenant_id=${company.tenantId}),'')`,department:sql<string>`coalesce((select d.name from app.onehr_assignment a join department d on d.id=a.department_id and d.tenant_id=a.tenant_id where a.employment_id=${onehrEmployment.id} and a.tenant_id=${onehrEmployment.tenantId} and a.superseded_at is null and a.valid_from<=${today}::date and (a.valid_to is null or a.valid_to>${today}::date) order by a.valid_from desc,a.id limit 1),'')`,submitted:onehrPanel.submittedAt,lastLogin:sql<string|null>`(select max(ev.occurred_at)::text from app_user u join domain_event ev on ev.aggregate_id=u.id and ev.tenant_id=u.tenant_id and ev.event_type='app-user.logged-in' where u.person_id=${onehrEmployment.personId} and u.tenant_id=${onehrEmployment.tenantId})`}).from(onehrPanel).innerJoin(onehrReview,eq(onehrReview.reviewId,onehrPanel.reviewId)).innerJoin(onehrEmployment,eq(onehrEmployment.id,onehrPanel.peerEmploymentId)).leftJoin(person,eq(person.id,onehrEmployment.personId)).innerJoin(company,eq(company.id,onehrEmployment.companyId)).where(and(eq(onehrReview.cycleId,cycleId),isNull(onehrPanel.archivedAt),sql`app.onehr_admin(${onehrEmployment.companyId}) and app.onehr_admin(${onehrReview.companyId}) and (${person.id} is not null or ${onehrLabel.visible(onehrEmployment.id)})`)).orderBy(asc(onehrLabel.labelOrPerson(person.fullName,onehrEmployment.id)),asc(onehrPanel.peerEmploymentId),asc(onehrPanel.requestId)).limit(100001);
  if(panels.length>100000)throw Error('This assessor report exceeds 100,000 assignments.');
  const byPerson=new Map<string,{employmentId:string;name:string;code:string|null;email:string|null;company:string;group:string;department:string;lastLogin:string|null;assigned:number;done:number}>();
  for(const p of panels){const row=byPerson.get(p.employmentId)??{employmentId:p.employmentId,name:p.name,code:p.code,email:p.email,company:p.company,group:p.group,department:p.department,lastLogin:p.lastLogin?new Date(p.lastLogin).toISOString():null,assigned:0,done:0};row.assigned++;if(p.submitted)row.done++;byPerson.set(p.employmentId,row);}
  return [...byPerson.values()].map(p=>({...p,remaining:p.assigned-p.done,state:p.done===p.assigned?'done' as const:p.done?'active' as const:'pending' as const}));
 });
}
export async function exportAssessmentAssessorProgress(ctx:SessionContext,cycleId:string,raw:unknown={}){
 const f=z.object({q:z.string().max(200).default(''),company:z.string().max(300).default(''),businessGroup:z.string().max(300).default(''),department:z.string().max(300).default(''),state:z.enum(['all','pending','active','done']).default('all')}).parse(raw),rows=await getAssessmentAssessorProgress(ctx,cycleId);
 await withPerformanceTenant(ctx,tx=>auditAssessmentAdminTx(tx,ctx,cycleId,'assessor-progress-exported',{assessors:rows.length,filters:f}));
 return toCsv([['Employee ID','Name','Email','Business Group','Company','Department','Assigned','Done','Remaining','Status','Last login (MYT)'],...rows.filter(r=>(f.state==='all'||r.state===f.state)&&(!f.company||r.company===f.company)&&(!f.businessGroup||r.group===f.businessGroup)&&(!f.department||r.department===f.department)&&(!f.q||[r.name,r.code,r.department].some(s=>s?.toLocaleLowerCase().includes(f.q.toLocaleLowerCase())))).map(r=>[r.code,r.name,r.email,r.group,r.company,r.department,r.assigned,r.done,r.remaining,r.state==='done'?'Done':r.state==='active'?'In progress':'Not started',r.lastLogin?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',dateStyle:'short',timeStyle:'medium',hour12:false}).format(new Date(r.lastLogin)):'No recorded login'])]);
}

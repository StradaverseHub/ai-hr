import {and,asc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../../db/client';
import {withPerformanceTenant} from '../../../core/module-gate';
import {company,onehrCycle,reviewCycle} from '../../../db/schema';
import {todayInKualaLumpur} from '../../../lib/hr-date';
import {toCsv} from '../../../lib/csv';
import {policySchema} from './model';
import {assessmentParticipantsTx} from './participation-service';
import {profitAchievementsTx} from './profit-service';
import {profitCurveFor} from './calibration-curve-model';
import {getAssessmentProgress,getAssessmentAssessorProgress} from './progress-service';
import {onehrEmployment} from './employment-projection';
import {auditAssessmentAdminTx} from './admin-context';
import {adminReportParams,buildAdminReport,type AdminReportParams,type AdminReportData} from './admin-report-model';
/** Read-only cycle authorization also works for archived cycles; never acquire the editing lock. */
export async function assessmentAdminReadCycleTx(tx:Tx,cycleId:string){
 z.uuid().parse(cycleId);const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.onehr_cycle_admin(${cycleId}::uuid) as ok`);
 if(!allowed?.ok)throw Error('Performance administrator access is required.');
 const [row]=await tx.select({cycle:reviewCycle,policy:onehrCycle.policy}).from(onehrCycle).innerJoin(reviewCycle,eq(reviewCycle.id,onehrCycle.cycleId)).where(eq(onehrCycle.cycleId,cycleId));
 if(!row)throw Error('Assessment cycle not found.');return {cycle:row.cycle,policy:policySchema.parse(row.policy)};
}
export async function assessmentAdminCompaniesTx(tx:Tx,cycleId:string){
 const {cycle}=await assessmentAdminReadCycleTx(tx,cycleId);
 return tx.select({id:company.id,name:company.legalName,parent:company.parentCompanyId,group:sql<string>`coalesce((select c.legal_name from company c where c.id=company.parent_company_id and c.tenant_id=company.tenant_id),'')`}).from(company)
 .where(and(isNull(company.archivedAt),sql`app.onehr_admin(${company.id})`,cycle.companyId?eq(company.id,cycle.companyId):undefined)).orderBy(asc(company.legalName),asc(company.id));
}
export function assessmentAdminReportLinks(cycleId:string,params:AdminReportParams){
 const query=new URLSearchParams(Object.entries(adminReportParams.parse(params)).filter((v):v is [string,string]=>typeof v[1]==='string'&&!!v[1]));
 const base=`/performance/${cycleId}/reports`;return {page:`${base}?${query}`,csv:`${base}/export?${query}&format=csv`,xlsx:`${base}/export?${query}&format=xlsx`};
}
/** The same authorized canonical owners supply UI reports, links and exports on every request. */
export async function getAssessmentAdminReport(ctx:SessionContext,cycleId:string,raw:unknown){
 const p=adminReportParams.parse(raw),base=await withPerformanceTenant(ctx,async tx=>{
  const c=await assessmentAdminReadCycleTx(tx,cycleId),companies=await assessmentAdminCompaniesTx(tx,cycleId);return {...c,companies};
 });
 if(p.businessGroup){const groups=[...new Set(base.companies.map(c=>c.group).filter(Boolean))],value=p.businessGroup.toLowerCase();const exact=groups.find(g=>g.toLowerCase()===value),partial=groups.filter(g=>g.toLowerCase().includes(value));const group=exact??(partial.length===1?partial[0]:null);if(!group)throw Error('Choose a business group within your current access.');p.businessGroup=group;}
 const data:AdminReportData={};
 if(p.kind==='progress'){
  const module=p.module!;
  if(module==='f360'){
   if(!base.policy.modules.tm)throw Error('360 feedback is switched off for this cycle.');data.assessors=await getAssessmentAssessorProgress(ctx,cycleId);
  }else{
   const progress=await getAssessmentProgress(ctx,cycleId,{module});
   // The progress screen may choose a different available tab. A named report must never relabel it.
   data.progress=progress.filter.module===module?progress.rows.flatMap(r=>r.cells[module]?[{...r,cell:r.cells[module]!}]:[]):[];
  }
 }else if(p.kind==='pbt'){
  const figures=await withPerformanceTenant(ctx,async tx=>{await assessmentAdminReadCycleTx(tx,cycleId);return profitAchievementsTx(tx,cycleId);});
  data.profit=base.companies.map(c=>{const figure=profitCurveFor(c.id,c.parent,figures);return {group:c.group,company:c.name,achievementPct:figure.achievementPct,inherited:figure.source==='bg'};});
 }else{
  const people=await withPerformanceTenant(ctx,async tx=>{
   await assessmentAdminReadCycleTx(tx,cycleId);const participants=await assessmentParticipantsTx(tx,cycleId),ids=participants.map(p=>p.employmentId),today=todayInKualaLumpur();
   if(!ids.length)return [];
   // VF-07: employment and assignment through the OneHR projection views (HR: its own rows, unchanged).
   const metadata=await tx.select({id:onehrEmployment.id,code:onehrEmployment.employeeCode,department:sql<string>`coalesce((select d.name from app.onehr_assignment a join department d on d.id=a.department_id and d.tenant_id=a.tenant_id where a.employment_id=onehr_employment.id and a.tenant_id=onehr_employment.tenant_id and a.superseded_at is null and a.valid_from<=${today}::date and (a.valid_to is null or a.valid_to>${today}::date) order by a.valid_from desc,a.id limit 1),'')`}).from(onehrEmployment).where(inArray(onehrEmployment.id,ids));
   const byId=new Map(metadata.map(r=>[r.id,r]));return participants.flatMap(p=>{const c=base.companies.find(c=>c.id===p.companyId),m=byId.get(p.employmentId);return c&&m?[{...p,code:m.code,department:m.department,company:c.name,group:c.group}]:[];});
  });
  if(p.kind==='participants')data.participants=people;
  else {const grouped=new Map<string,{group:string;mechanism:string;people:number}>();for(const c of base.companies){const b=base.policy.bBands.find(b=>b.companyId===c.id),mechanism=b?b.variant==='excellence'?'MBO with hard cap':'MBO with multiplier':'5-point rating',key=JSON.stringify([c.group,mechanism]),r=grouped.get(key)??{group:c.group,mechanism,people:0};r.people+=people.filter(p=>p.companyId===c.id).length;grouped.set(key,r);}data.scoring=[...grouped.values()];}
 }
 // Authorization is checked again after the dependent reads, including exports opened from old links.
 const latest=await withPerformanceTenant(ctx,async tx=>({...await assessmentAdminReadCycleTx(tx,cycleId),companies:await assessmentAdminCompaniesTx(tx,cycleId)}));
 if(JSON.stringify(latest)!==JSON.stringify(base))throw Error('The cycle or your access changed. Reopen the report.');
 return buildAdminReport(p,base.cycle.name,data);
}
export async function buildAssessmentAdminReport(ctx:SessionContext,cycleId:string,raw:unknown){
 const report=await getAssessmentAdminReport(ctx,cycleId,raw);
 await withPerformanceTenant(ctx,async tx=>{await assessmentAdminReadCycleTx(tx,cycleId);await auditAssessmentAdminTx(tx,ctx,cycleId,'admin-report-built',{params:report.params});});
 return {...report,...assessmentAdminReportLinks(cycleId,report.params)};
}
export async function getAssessmentAdminReportHistory(ctx:SessionContext,cycleId:string){
 return withPerformanceTenant(ctx,async tx=>{
  await assessmentAdminReadCycleTx(tx,cycleId);
  const rows=await tx.execute<{params:unknown;at:string}>(sql`select * from app.assessment_admin_report_history(${cycleId}::uuid)`),seen=new Set<string>();
  return rows.flatMap(row=>{const parsed=adminReportParams.safeParse(row.params);if(!parsed.success)return [];const links=assessmentAdminReportLinks(cycleId,parsed.data);if(seen.has(links.page))return [];seen.add(links.page);return [{params:parsed.data,at:row.at,...links}];}).slice(0,10);
 });
}
export async function exportAssessmentAdminReport(ctx:SessionContext,cycleId:string,raw:unknown){
 const report=await getAssessmentAdminReport(ctx,cycleId,raw);await withPerformanceTenant(ctx,async tx=>{await assessmentAdminReadCycleTx(tx,cycleId);await auditAssessmentAdminTx(tx,ctx,cycleId,'admin-report-exported',{params:report.params,rows:report.rows.length});});return report;
}
export function assessmentAdminReportCsv(report:ReturnType<typeof buildAdminReport>){return toCsv([[report.title],[],report.columns,...report.rows]);}

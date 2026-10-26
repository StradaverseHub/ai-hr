import {sql} from 'drizzle-orm';
import type {SessionContext} from '../../../db/client';
import {withPerformanceTenant} from '../../../core/module-gate';
import {todayInKualaLumpur} from '../../../lib/hr-date';
import {adminHomeTx,getAssessmentAdminReadiness} from './admin-agent-service';
import {assessmentAdminReadCycleTx} from './admin-report-service';
import {buildAssessmentOverview,type OverviewCounts} from './overview-model';
/** Completion metadata only. One grouped query; no scoring, provider or per-person database calls. */
export async function getAssessmentOverview(ctx:SessionContext,cycleId?:string){
 const result=await withPerformanceTenant(ctx,async tx=>{
  const home=await adminHomeTx(tx),id=cycleId??home.active?.id;
  if(!id)return null;
  const {cycle,policy}=await assessmentAdminReadCycleTx(tx,id),year=Number(cycle.periodEnd.slice(0,4))+(policy.kind==='year_end'?1:0);
  const groups=await tx.execute<OverviewCounts>(sql`
   with visible as materialized (
    select r.*,coalesce(c.parent_company_id,c.id) as group_id,coalesce(bg.legal_name,c.legal_name) as group_name,
     coalesce(bg.legal_name,'') as business_group,c.legal_name as company_name,
     jsonb_array_length(r.kpis)>0 as has_kpis,
     (r.results_submitted_at is not null or jsonb_array_length(r.kpis)>0 and not exists(select 1 from jsonb_array_elements(r.kpis) k where coalesce((k->>'hrOwned')::boolean,false)=false or coalesce((k->>'locked')::boolean,false)=false)) as submitted,
     jsonb_array_length(r.kpis)>0 and not exists(select 1 from jsonb_array_elements(r.kpis) k where k->'checkIn' is null or k->'checkIn'='null'::jsonb) as checked_in
    from performance_onehr_review r join app.onehr_employment e on e.id=r.employment_id and e.tenant_id=r.tenant_id
    join company c on c.id=r.company_id and c.tenant_id=r.tenant_id left join company bg on bg.id=c.parent_company_id and bg.tenant_id=c.tenant_id
    where r.cycle_id=${id}::uuid and r.tenant_id=app.current_tenant_id() and app.onehr_admin(r.company_id) and app.onehr_admin(e.company_id)
     and app.assessment_review_participates(r.review_id) and (e.terminated_on is null or e.terminated_on>${todayInKualaLumpur()}::date)
   ), panels as (
    select v.group_id,count(*)::int as total,count(*) filter(where p.submitted_at is not null)::int as done from visible v
    join performance_onehr_panel p on p.review_id=v.review_id and p.tenant_id=v.tenant_id where p.archived_at is null group by v.group_id
   ), units as (
    select distinct group_id,company_id from visible where has_kpis
   ), locks as (
    select u.group_id,count(*)::int as total,count(*) filter(where exists(
     select 1 from visible v join performance_onehr_calibration_entry ce on ce.review_id=v.review_id and ce.tenant_id=v.tenant_id
      join performance_onehr_calibration s on s.id=ce.session_id and s.tenant_id=ce.tenant_id
     where v.company_id=u.company_id and s.cycle_id=${id}::uuid and s.tier='bg'
    ) and not exists(
     select 1 from visible v join performance_onehr_calibration_entry ce on ce.review_id=v.review_id and ce.tenant_id=v.tenant_id
      join performance_onehr_calibration s on s.id=ce.session_id and s.tenant_id=ce.tenant_id
     where v.company_id=u.company_id and s.cycle_id=${id}::uuid and s.tier='bg' and ce.locked_at is null and s.locked_at is null
    ))::int as done from units u group by u.group_id
   )
   select v.group_id::text as id,v.group_name as name,v.business_group as "businessGroup",case when v.business_group='' then min(v.company_name) else '' end as company,count(*)::int as people,
    jsonb_build_object(
     'pm',jsonb_build_object('total',count(*) filter(where v.has_kpis),'done',count(*) filter(where v.has_kpis and case when ${policy.kind}='quarterly' then v.checked_in else v.submitted end)),
     'f360',jsonb_build_object('total',coalesce(max(p.total),0),'done',coalesce(max(p.done),0)),
     'competency',jsonb_build_object('total',count(*) filter(where jsonb_array_length(v.competencies)>0),'done',count(*) filter(where jsonb_array_length(v.competencies)>0 and v.competency_status in ('submitted','reviewed'))),
     'calibration',jsonb_build_object('total',coalesce(max(l.total),0),'done',coalesce(max(l.done),0)),
     'idp',jsonb_build_object('total',count(*),'done',count(*) filter(where plan.status in ('shared','closed')))
    ) as counts
   from visible v left join panels p on p.group_id=v.group_id left join locks l on l.group_id=v.group_id
    left join performance_onehr_plan plan on plan.employment_id=v.employment_id and plan.tenant_id=v.tenant_id and plan.plan_year=${year}
   group by v.group_id,v.group_name,v.business_group order by v.group_name,v.group_id
  `);
  return {cycle:{id:cycle.id,name:cycle.name,status:cycle.status},kind:policy.kind,...buildAssessmentOverview(policy,id,groups)};
 });
 return {overview:result,readiness:await getAssessmentAdminReadiness(ctx,result?.cycle.id)};
}

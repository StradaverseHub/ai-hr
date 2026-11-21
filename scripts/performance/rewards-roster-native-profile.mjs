import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

export async function profileRewardsRosterNativeReads({ctx,target,withRewardsTenant,sql,employedByCompanyDuring,
 personnelGroupingReadinessTx,onehrRewardResultTx,onehrRewardResultsTx}){
 const {companyId,businessUnitId,unitId,snapshotDate:date,year}=target;
 const overlap=employedByCompanyDuring(companyId,date,date);
 const inWorkforce=sql`${overlap} and employment.hired_on<=${date}::date
   and (employment.terminated_on is null or employment.terminated_on>${date}::date)`;
 const activeAssignment=sql`assignment.valid_from<=${date}::date
   and (assignment.valid_to is null or assignment.valid_to>${date}::date)
   and assignment.superseded_at is null`;
 const expected=[...target.expectedEmploymentIds].sort();
 return withRewardsTenant(ctx,async tx=>{
  const roster=Array.from(await tx.execute(sql`select employment_id from reward_entry
   where tenant_id=app.current_tenant_id() and unit_id=${unitId}::uuid order by employment_id`));
  assert.deepEqual(roster.map(row=>row.employment_id),expected);
  const companyRows=Array.from(await tx.execute(sql`select employment.id from employment
   join person on person.id=employment.person_id
   where ${inWorkforce}`));
  const companyIds=companyRows.map(row=>row.id).sort();
  assert.deepEqual(companyIds,expected);
  const readiness=()=>personnelGroupingReadinessTx(tx,ctx,{employmentIds:companyIds,asOf:date});
  const organizationFilter=async()=>Array.from(await tx.execute(sql`
   select employment.id,assignment.id as assignment_id from employment
   join person on person.id=employment.person_id
   join assignment on assignment.employment_id=employment.id
   left join job_grade on job_grade.id=employment.grade_id
   where ${inWorkforce} and ${activeAssignment}
    and (case when app.employment_organisation_tags(employment.id,${date}::date)->>'status'='legacy'
     then assignment.business_unit_id
     else (app.employment_organisation_tags(employment.id,${date}::date)->>'businessUnitId')::uuid end)=${businessUnitId}::uuid
   order by employment.employee_code,employment.id`));
  const organizationOnce=async()=>Array.from(await tx.execute(sql`
   with workforce as materialized (
    select employment.id,employment.employee_code,
      app.employment_organisation_tags(employment.id,${date}::date) as tags
    from employment join person on person.id=employment.person_id
    where ${inWorkforce}
   )
   select workforce.id,assignment.id as assignment_id from workforce
   join assignment on assignment.employment_id=workforce.id
   where ${activeAssignment}
    and (case when workforce.tags->>'status'='legacy' then assignment.business_unit_id
     else (workforce.tags->>'businessUnitId')::uuid end)=${businessUnitId}::uuid
   order by workforce.employee_code,workforce.id`));
  const onehrSingle=async()=>{
   const values=new Map();
   for(const id of expected)values.set(id,await onehrRewardResultTx(tx,id,year,unitId));
   return values;
  };
  const onehrBatch=()=>onehrRewardResultsTx(tx,expected,year,unitId);
  const phases={readiness,organizationFilter,organizationOnce,onehrSingle,onehrBatch};
  const labels=Object.keys(phases),observations=[];
  let onehrPopulated=0;
  for(let pass=0;pass<6;pass++){
   const output={};
   for(const name of [...labels.slice(pass%labels.length),...labels.slice(0,pass%labels.length)]){
    const start=performance.now();
    output[name]=await phases[name]();
    observations.push({phase:name,pass,elapsedMs:Math.round((performance.now()-start)*100)/100});
   }
   assert.deepEqual(output.readiness.map(row=>row.employmentId).sort(),expected);
   assert(output.readiness.every(row=>row.ready&&row.companyId===companyId&&row.reason===null));
   assert.deepEqual(output.organizationFilter.map(row=>row.id).sort(),expected);
   assert.deepEqual(output.organizationOnce,output.organizationFilter);
   assert.deepEqual(output.onehrBatch,output.onehrSingle);
   assert.deepEqual([...output.onehrBatch.keys()].sort(),expected);
   onehrPopulated=[...output.onehrBatch.values()].filter(Boolean).length;
  }
  return {employees:expected.length,onehrPopulated,observations};
 });
}

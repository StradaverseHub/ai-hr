import {sql} from 'drizzle-orm';
import {owner} from '../harness';

/** Fictional fixture evidence only. Never projects salary, remarks, document bodies or personal data. */
export async function contractPostingTemporalDiagnostics(tenantId:string,employmentId:string){
 const [assignments,compensation,events,classifications]=await Promise.all([
  owner.db.execute(sql`select id,valid_from::text,valid_to::text,superseded_at is not null as superseded,
   company_id,department_id,business_unit_id,employment_type from public.assignment
   where tenant_id=${tenantId}::uuid and employment_id=${employmentId}::uuid order by recorded_at,id`),
  owner.db.execute(sql`select id,valid_from::text,valid_to::text,superseded_at is not null as superseded
   from public.compensation where tenant_id=${tenantId}::uuid and employment_id=${employmentId}::uuid order by recorded_at,id`),
  owner.db.execute(sql`select id,sequence::text,event_type,aggregate_id,
   payload->'movement'->>'type' as movement_type,payload->'movement'->>'effectiveDate' as movement_day,
   payload->'movement'->>'groupId' as movement_group,payload->'movement'->>'secondary' as secondary,
   payload->>'effectiveDate' as effective_day,payload->>'effectiveFrom' as effective_from,
   payload->>'payrollEffectiveFrom' as payroll_effective_from,payload->>'effectiveOn' as effective_on,
   (select coalesce(jsonb_agg(name order by name),'[]'::jsonb) from (
    select value#>>'{}' as name from jsonb_array_elements(case when jsonb_typeof(payload->'fields')='array' then payload->'fields' else '[]'::jsonb end)
     where jsonb_typeof(value)='string'
    union select jsonb_object_keys(case when jsonb_typeof(payload->'fields')='object' then payload->'fields' else '{}'::jsonb end)
   ) names where name~'^[A-Za-z][A-Za-z0-9_]{0,79}$') as field_names,payload->>'replayOf' as replay_of
   from public.domain_event where tenant_id=${tenantId}::uuid and subject_employment_id=${employmentId}::uuid order by sequence`),
  owner.db.execute(sql`select id,effective_on::text,trigger,tags->>'status' as status,
   tags->>'businessUnitId' as business_unit_id from public.employment_organisation_classification
   where tenant_id=${tenantId}::uuid and employment_id=${employmentId}::uuid order by effective_on,created_at,id`),
 ]);
 return {assignments:Array.from(assignments),compensation:Array.from(compensation),events:Array.from(events),classifications:Array.from(classifications)};
}

/** Diagnostics are supplemental: failure must never mask the assertion or stop it from running. */
export async function reportContractPostingTemporalDiagnostics(label:string,tenantId:string,employmentId:string,context:Record<string,unknown>={}){
 try{
  console.error(label+' '+JSON.stringify({...context,timeline:await contractPostingTemporalDiagnostics(tenantId,employmentId)}));
 }catch{
  console.error(label+' diagnostic query failed; the original assertion is retained.');
 }
}

-- Board 42f2b8a9: remove the On/Off Boarding routing owner and case override.
-- Existing definitions and frozen runs are not rewritten. The owner explicitly permitted the five
-- fictional staging definitions to retain PBP, knowing their emails will be held. The two canonical
-- SQL lookups remain unchanged for Contract Management/Probation compatibility.
-- Keep an empty key during rollout so an older pod can still call config.bpRules.filter().
WITH candidates AS MATERIALIZED (
 SELECT tenant_id,revision,data,
   CASE WHEN jsonb_typeof(data#>'{caseForms,off}')='array' THEN
     jsonb_set(data,'{caseForms,off}',coalesce((SELECT jsonb_agg(field ORDER BY position)
       FROM jsonb_array_elements(data#>'{caseForms,off}') WITH ORDINALITY AS form(field,position)
       WHERE field->>'key' IS DISTINCT FROM 'pbp'),'[]'::jsonb)) ELSE data END AS next_data
 FROM lc_v9_config
 WHERE data->'bpRules' IS DISTINCT FROM '[]'::jsonb OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(coalesce(data#>'{caseForms,off}','[]'::jsonb)) field WHERE field->>'key'='pbp')
 FOR UPDATE
), history AS (
 INSERT INTO lc_v9_config_revision(tenant_id,revision,data,actor_user_id)
 SELECT tenant_id,revision,data,NULL FROM candidates
), changed AS (
 UPDATE lc_v9_config v SET revision=c.revision+1,
   data=jsonb_set(jsonb_set(c.next_data,'{bpRules}','[]'::jsonb),'{revision}',to_jsonb(c.revision+1)),updated_at=now()
 FROM candidates c WHERE v.tenant_id=c.tenant_id RETURNING v.tenant_id,v.revision
)
INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
SELECT tenant_id,'lifecycle-v9-config',tenant_id,'lifecycle-v9.pbp-routing-removed','system',NULL,
 jsonb_build_object('revision',revision,'migration','6103_lifecycle_pbp_removal') FROM changed;
--> statement-breakpoint
WITH candidates AS MATERIALIZED (
 SELECT id,tenant_id,company_id,employment_id,revision,data FROM lc_v9_case
 WHERE module='off' AND nullif(trim(data->'facts'->>'pbpUserId'),'') IS NOT NULL FOR UPDATE
), history AS (
 INSERT INTO lc_v9_case_revision(tenant_id,case_id,company_id,revision,data,actor_user_id)
 SELECT tenant_id,id,company_id,revision,data,NULL FROM candidates
), changed AS (
 UPDATE lc_v9_case v SET revision=c.revision+1,updated_at=now(),
   data=jsonb_set(jsonb_set(jsonb_set(c.data,'{facts,pbpUserId}','null'::jsonb),'{revision}',to_jsonb(c.revision+1)),
     '{log}',coalesce(c.data->'log','[]'::jsonb)||jsonb_build_array(jsonb_build_object(
       'id',gen_random_uuid()::text,'at',clock_timestamp(),'actor',jsonb_build_object('id','system','name','System'),
       'action','case.pbpCleared','detail','PBP override cleared because PBP routing was removed.')))
 FROM candidates c WHERE v.id=c.id RETURNING v.id,v.tenant_id,v.employment_id,v.revision
)
INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
SELECT tenant_id,'lifecycle-v9-case',id,'lifecycle-v9.case.pbpCleared','system',NULL,employment_id,
 jsonb_build_object('caseId',id,'revision',revision,'migration','6103_lifecycle_pbp_removal') FROM changed;

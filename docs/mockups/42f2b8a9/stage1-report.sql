-- 42f2b8a9 Stage 1 report. READ-ONLY. Run with PGOPTIONS='-c default_transaction_read_only=on'.
-- Staging was run 2026-11-11 via roq.sh; production is run by the release operator with production permission.
-- Step 1: On/Off Boarding email default CC and workflow steps naming PBP
select t.name tenant, e->>'module' module, e->>'name' email_template, e->'cc' default_cc from lc_v9_config v join tenant t on t.id=v.tenant_id cross join lateral jsonb_array_elements(v.data->'emails') e where e->'cc' ? 'pbp';
select t.name tenant, w->>'id' wf_id, w->>'module' module, w->>'name' workflow, w->>'status' status, s->>'type' step, s->'to' to_, s->'cc' cc from lc_v9_config v join tenant t on t.id=v.tenant_id cross join lateral jsonb_array_elements(v.data->'workflows') w cross join lateral jsonb_array_elements(coalesce(w->'steps','[]')) s where (jsonb_typeof(s->'to')='array' and s->'to' ? 'pbp') or s->>'to'='pbp' or s->'cc' ? 'pbp';
-- Step 5: Contract Management and Probation records (every contract_ and probation_ table) and background jobs
-- (generate: one count(*) per table in pg_class where relname like 'contract%' or 'probation%'; see q-counts.sql)
select 'bulk_job' src, kind, state, count(*) from bulk_job where kind ilike '%contract%' or kind ilike '%probation%' group by 1,2,3;
select 'letter_job' src, kind, status, count(*) from letter_job where kind ilike '%contract%' or kind ilike '%probation%' group by 1,2,3;
select 'job_run' src, job_key, count(*) from job_run where job_key ilike '%contract%' or job_key ilike '%probation%' group by 1,2;
-- Step 6: offboarding cases with a saved PBP override
select t.name tenant, c.data->>'state' state, count(*) cases, count(*) filter (where nullif(c.data->'facts'->>'pbpUserId','') is not null) with_pbp_override from lc_v9_case c join tenant t on t.id=c.tenant_id where c.module='off' group by 1,2;
-- Step 7: PBP merge values typed into email templates, document templates, workflow messages, letters
select 'lc_v9_config' src, t.name, m[1] token, count(*) from lc_v9_config v join tenant t on t.id=v.tenant_id cross join lateral regexp_matches(v.data::text, '(\{[^{}"]*(pbp|partner)[^{}"]*\})', 'gi') m group by 1,2,3;
select 'lc_onboarding_config' src, m[1], count(*) from lc_onboarding_config v cross join lateral regexp_matches(v.data::text, '(\{[^{}"]*(pbp|partner)[^{}"]*\})', 'gi') m group by 1,2;
select 'letter_template_version' src, count(*) filter (where document::text ~* 'pbp|business ?partner') hits, count(*) from letter_template_version;
select 'letter_merge_field_version' src, count(*) filter (where key ~* 'pbp|partner' or definition::text ~* 'pbp|business ?partner') hits, count(*) from letter_merge_field_version;
-- Offboarding case form still holding the PBP field
select t.name, (select f from jsonb_array_elements(v.data->'caseForms'->'off') f where f->>'key'='pbp') pbp_field from lc_v9_config v join tenant t on t.id=v.tenant_id;
-- Step 8: export of current PBP routing rules
select t.name tenant, ord rule_no, coalesce(r->'rules'->'businessGroup','[]') business_group_ids, coalesce(r->'rules'->'company','[]') company_ids, coalesce(r->'rules'->'department','[]') department_ids, r->>'userId' user_id, coalesce(p.full_name,'(no person)') person, u.archived_at is not null archived
from lc_v9_config v join tenant t on t.id=v.tenant_id cross join lateral jsonb_array_elements(coalesce(v.data->'bpRules','[]')) with ordinality x(r,ord)
left join app_user u on u.id::text=r->>'userId' and u.tenant_id=v.tenant_id left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id order by 1,2;
-- (resolve the id arrays to names via business_unit.name, company.legal_name, department.name for the attached table)

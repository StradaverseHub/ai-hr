-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5086_personnel_search_set_mapping, idx 4486, when 1793330004786.
-- Personnel search and the Personnel list read the dated company organisation once per statement.
--
-- Staging (11 Nov 2026, 75 companies) refused People > Personnel search at the 20 s Personnel statement limit
-- inside app.company_org_mapping_at. Every reader below resolved organisation tags with one
-- app.company_org_tags_unchecked call per company; each call read the whole tenant mapping twice, and each mapping
-- read joined every mapping row to every run once per company. The search then shipped every authorised row to
-- Node only to keep a handful. This migration keeps every result, refusal, owner and grant and changes how often
-- the same values are computed:
--   * app.company_org_mapping_at returns the identical document from one pass over the mappings (latest dated
--     mapping per company) instead of one sorted lookup per company;
--   * app._personnel_company_tags is app.company_org_tags_unchecked for a set of companies, from one mapping read;
--   * the set-wise employment resolver, the typed overview facts and filter fields, and the company choices use it,
--     and the resolver reads the retained classifications as one set instead of one scan per subject;
--   * the private column filters' list rows read the Workforce maintain permission and each manager company's
--     projection once per company instead of once per field of every row;
--   * the private search bind trigger checks a large membership as set differences, not entry by entry;
--   * app.personnel_search_candidates is app.personnel_search_rows plus the bounded population count and a
--     candidate filter that is exact for ASCII text and keeps every non-ASCII value for the caller's own check
--     (core/personnel-private-search.ts still decides every match with the shared JavaScript rule).
-- Functions only: no table, column, index, constraint, trigger or row changes, so no lock on an application table
-- and no backfill. Running readers keep their snapshot of the previous bodies.
DO $personnel_search_predecessors$
DECLARE previous record;
BEGIN
 FOR previous IN SELECT x.signature,x.digest,x.definer,x.config,p.oid,p.prosrc,p.prosecdef,p.proowner,p.proconfig
   FROM (VALUES
     ('app.company_org_mapping_at(date)','dc4382976c3eec1dce402dc2145398c2',true,'search_path=pg_catalog, public, pg_temp'),
     ('app.company_org_tags_unchecked(uuid,date)','5fb3228d470bc95baeff88a19d2f32e9',true,'search_path=pg_catalog, public, pg_temp'),
     ('app.company_org_resolve(uuid,jsonb,boolean)','9e10ccec56ef79c42e1b15c7054df1ce',false,'search_path=pg_catalog, public, pg_temp'),
     ('app._personnel_employment_tags(uuid[],date)','0f9f35c483c174b6bd3fda5223d6aa56',true,'search_path=pg_catalog, public, app'),
     ('app.personnel_search_rows(uuid[])','1d29536f96ed83fdecc43e3241a8d2d3',true,'search_path=pg_catalog, public, app'),
     ('app.personnel_filter_companies(uuid[],date)','7fc71e2d48517cabb7a2143e60d02dc4',true,'search_path=pg_catalog, public, app'),
     ('app.personnel_overview_filter_fields(date,uuid[])','25fa8aacafdd0f9751b03eafba3c2819',true,'search_path=pg_catalog, public, app|enable_nestloop=off'),
     ('app.personnel_overview_facts(date,uuid[])','5d195940a967b04b24270820d47c21d3',true,'search_path=pg_catalog, public, app|enable_nestloop=off'),
     ('app.personnel_list_rows(date,uuid[])','c6d6b2e18d6beb6730932ad13e7bbcae',true,'search_path=pg_catalog, public, app'),
     ('app.personnel_list_rows_for_ids(date,uuid[],uuid[])','0de9e7ea3615ff320921510a81d2ef13',true,'search_path=pg_catalog, public, app'),
     ('app.access_workforce_company(uuid,text)','553170b575b843a2cc2aae888eeeec2d',true,'search_path=pg_catalog, public, pg_temp'),
     ('app.access_workforce_projection_company(uuid)','0c28417bc1aa5361e76e3cb4efa3c0ce',true,'search_path=pg_catalog, public, pg_temp'),
     ('app.personnel_private_search_bind()','78204d88bb05143d49a7285cc6baafab',true,'search_path=pg_catalog, public, app')
   ) AS x(signature,digest,definer,config)
   LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(x.signature)
 LOOP
  IF previous.oid IS NULL OR pg_catalog.md5(previous.prosrc) IS DISTINCT FROM previous.digest
     OR previous.prosecdef IS DISTINCT FROM previous.definer OR pg_catalog.pg_get_userbyid(previous.proowner)<>current_user
     OR previous.proconfig IS DISTINCT FROM pg_catalog.string_to_array(previous.config,'|')
  THEN
   RAISE EXCEPTION 'Unexpected Personnel search predecessor %',previous.signature USING ERRCODE='55000';
  END IF;
 END LOOP;
 IF NOT pg_catalog.has_function_privilege('app.company_org_scope_run(uuid)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege('app.company_org_scope_mappings()','EXECUTE') THEN
  RAISE EXCEPTION 'Personnel search requires the organisation source readers' USING ERRCODE='55000';
 END IF;
 IF pg_catalog.to_regprocedure('app._personnel_company_tags(uuid[],date)') IS NOT NULL
    OR pg_catalog.to_regprocedure('app.personnel_search_candidates(uuid[],boolean,boolean,text,text,text,text,text[])') IS NOT NULL THEN
  RAISE EXCEPTION 'Personnel search set mapping is already installed' USING ERRCODE='55000';
 END IF;
END;
$personnel_search_predecessors$;
--> statement-breakpoint
-- Same signature, owner, grants and value: the latest dated mapping of each company (effective on or before the
-- day, published or leased by this transaction; latest effective date, then latest publication with unpublished
-- first, then highest run id: the same total order the per-company lookup took its first row from, since a run
-- maps a company at most once), read in one pass through the same organisation source readers.
CREATE OR REPLACE FUNCTION app.company_org_mapping_at(p_day date) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH latest AS MATERIALIZED (
  SELECT DISTINCT ON (m.company_id) m.company_id,m.business_unit_id,m.parent_company_id,m.run_id
  FROM app.company_org_scope_mappings() m JOIN app.company_org_scope_run(NULL::uuid) r ON r.id=m.run_id AND r.tenant_id=m.tenant_id
  WHERE m.tenant_id=app.current_tenant_id() AND (r.state='published' OR EXISTS(SELECT 1 FROM company_organisation_publish_lease l WHERE l.run_id=r.id AND l.tenant_id=r.tenant_id AND l.xact_id=pg_current_xact_id())) AND r.effective_on<=p_day
  ORDER BY m.company_id,r.effective_on DESC,r.published_at DESC,r.id DESC
 )
 SELECT coalesce(jsonb_object_agg(c.id::text,jsonb_build_object('companyId',c.id,'businessUnitId',m.business_unit_id,'parentCompanyId',CASE WHEN m.company_id IS NOT NULL THEN m.parent_company_id ELSE c.parent_company_id END,'mappingVersionId',m.run_id)),'{}')
 FROM company c LEFT JOIN latest m ON m.company_id=c.id WHERE c.tenant_id=app.current_tenant_id();
$$;
--> statement-breakpoint
-- app.company_org_tags_unchecked(company,day) for each distinct requested company: the same expression, with the
-- mapping document, the activation test and the fallback version read once for the whole set instead of per
-- company. Same owner as app.company_org_tags_unchecked (checked above), so the run reads see the same rows.
CREATE FUNCTION app._personnel_company_tags(p_companies uuid[],p_day date) RETURNS TABLE(company_id uuid,tags jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH requested AS MATERIALIZED (
   SELECT DISTINCT r.id FROM unnest(p_companies) AS r(id) WHERE r.id IS NOT NULL
 ),
 source AS MATERIALIZED (
   SELECT app.company_org_mapping_at(p_day) AS mapping,
     EXISTS(SELECT 1 FROM public.company_organisation_run r WHERE r.tenant_id=app.current_tenant_id() AND (r.state='published' OR EXISTS(SELECT 1 FROM public.company_organisation_publish_lease l WHERE l.run_id=r.id AND l.tenant_id=r.tenant_id AND l.xact_id=pg_current_xact_id())) AND r.kind<>'retag' AND r.effective_on<=p_day) AS activated,
     (SELECT to_jsonb(r.id) FROM public.company_organisation_run r WHERE r.tenant_id=app.current_tenant_id() AND (r.state='published' OR EXISTS(SELECT 1 FROM public.company_organisation_publish_lease l WHERE l.run_id=r.id AND l.tenant_id=r.tenant_id AND l.xact_id=pg_current_xact_id())) AND r.kind<>'retag' AND r.effective_on<=p_day ORDER BY r.effective_on DESC,r.published_at DESC NULLS FIRST,r.id DESC LIMIT 1) AS version
   WHERE EXISTS (SELECT 1 FROM requested)
 )
 SELECT q.id,app.company_org_resolve(q.id,s.mapping,s.activated)||jsonb_build_object('mappingVersionId',coalesce(nullif(s.mapping->q.id::text->'mappingVersionId','null'::jsonb),s.version))
 FROM requested q CROSS JOIN source s
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._personnel_company_tags(uuid[],date) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Same signature, owner and grants: app._personnel_employment_tags (5020). The subjects, values and refusal paths
-- are unchanged; the shortcut companies' tags come from one organisation read, and the dated company and retained
-- classification of every subject are joined sets (hashed, as in app.personnel_overview_facts) instead of one indexed
-- lookup and one scan of the classifications per subject. The configuration now also turns nested loops off, and
-- with them JIT compilation (a disabled join's cost would otherwise compile this short statement on every call).
CREATE OR REPLACE FUNCTION app._personnel_employment_tags(p_employments uuid[],p_day date) RETURNS TABLE(employment_id uuid,tags jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET enable_nestloop=off SET jit=off AS $$
 -- A join, not id = ANY(array): a runtime array parameter is not hashed, and a per-row scan of a
 -- whole-tenant subject array is quadratic.
 WITH subjects AS MATERIALIZED (
   SELECT DISTINCT e.id,e.tenant_id,e.company_id FROM unnest(p_employments) AS requested(id)
   JOIN public.employment e ON e.id=requested.id
   WHERE e.tenant_id=app.current_tenant_id()
 ),
 future_correction_presence AS MATERIALIZED (
   SELECT EXISTS (
     SELECT 1 FROM public.domain_event ev
     WHERE ev.tenant_id=app.current_tenant_id() AND ev.event_type='employment.information.corrected'
       AND ev.payload->>'effectiveOn'>p_day::text
   ) AS present
 ),
 -- app.company_org_employment_company, row for row, as sets: each subject's first future correction by sequence
 -- (its "before" company is read from that event only), else its dated assignment (latest start, then lowest id;
 -- the reviewed exclusion constraint leaves at most one), else its employment company.
 corrections AS MATERIALIZED (
   SELECT f.employment_id,nullif(f.before_company,'')::uuid AS previous_company FROM (
     SELECT DISTINCT ON (ev.subject_employment_id) ev.subject_employment_id AS employment_id,
       ev.payload->'before'->>'companyId' AS before_company
     FROM public.domain_event ev JOIN subjects s ON s.id=ev.subject_employment_id AND s.tenant_id=ev.tenant_id
     WHERE (SELECT present FROM future_correction_presence)
       AND ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>p_day::text
     ORDER BY ev.subject_employment_id,ev.sequence
   ) f
 ),
 assignments AS MATERIALIZED (
   SELECT DISTINCT ON (x.employment_id) x.employment_id,x.company_id,x.business_unit_id
   FROM public.assignment x JOIN subjects s ON s.id=x.employment_id AND s.tenant_id=x.tenant_id
   WHERE x.superseded_at IS NULL AND x.valid_from<=p_day AND (x.valid_to IS NULL OR x.valid_to>p_day)
   ORDER BY x.employment_id,x.valid_from DESC,x.id
 ),
 dated AS MATERIALIZED (
   SELECT s.id,s.tenant_id,a.business_unit_id,coalesce(c.previous_company,a.company_id,s.company_id) AS co
   FROM subjects s
   LEFT JOIN corrections c ON c.employment_id=s.id
   LEFT JOIN assignments a ON a.employment_id=s.id
 ),
 shortcut_companies AS MATERIALIZED (
   SELECT c.id
   FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND c.id IN (SELECT co FROM dated)
     AND p_day IS NOT NULL AND isfinite(p_day) AND app.principal_snapshot_current()
     AND app.access_workforce_projection_company(c.id)
 ),
 -- A retained classification yields to a published mapping of its company dated after it and on or before the day:
 -- the per-subject NOT EXISTS, as the latest such mapping date per shortcut company (none newer than the
 -- classification exactly when that latest date is not after it).
 superseding AS MATERIALIZED (
   SELECT m.company_id,max(newer.effective_on) AS effective_on
   FROM public.company_organisation_mapping m
   JOIN public.company_organisation_run newer ON newer.id=m.run_id AND newer.tenant_id=m.tenant_id
   WHERE m.tenant_id=app.current_tenant_id() AND newer.state='published' AND newer.effective_on<=p_day
     AND m.company_id IN (SELECT id FROM shortcut_companies)
   GROUP BY m.company_id
 ),
 shortcut AS MATERIALIZED (
   SELECT t.company_id AS id,t.tags,t.tags->>'status' IS DISTINCT FROM 'legacy' AS classified,n.effective_on AS superseded_on
   FROM app._personnel_company_tags(ARRAY(SELECT id FROM shortcut_companies),p_day) t
   LEFT JOIN superseding n ON n.company_id=t.company_id
 ),
 -- The retained classification of every shortcut subject at its dated company: the row the per-subject lookup took
 -- (latest effective date, then latest creation, then highest id).
 recorded AS MATERIALIZED (
   SELECT DISTINCT ON (c.employment_id) c.employment_id,c.tags
   FROM public.employment_organisation_classification c
   JOIN public.company_organisation_run r ON r.id=c.mapping_version_id AND r.tenant_id=c.tenant_id
   JOIN dated d ON d.id=c.employment_id AND d.co=c.company_id
   JOIN shortcut k ON k.id=d.co AND k.classified
   WHERE c.tenant_id=app.current_tenant_id() AND c.effective_on<=p_day AND r.state='published'
     AND (k.superseded_on IS NULL OR k.superseded_on<=c.effective_on)
   ORDER BY c.employment_id,c.effective_on DESC,c.created_at DESC,c.id DESC
 )
 SELECT d.id,
   CASE WHEN k.id IS NULL THEN app.employment_organisation_tags(d.id,p_day)
     WHEN k.tags->>'status'='legacy' THEN k.tags||jsonb_build_object('businessUnitId',d.business_unit_id)
     ELSE coalesce(recorded.tags,k.tags) END
 FROM dated d
 LEFT JOIN shortcut k ON k.id=d.co
 LEFT JOIN recorded ON recorded.employment_id=d.id
$$;
--> statement-breakpoint
-- Same signature, owner and grants: app.personnel_overview_facts (5020), with the company tags read once.
CREATE OR REPLACE FUNCTION app.personnel_overview_facts(p_as_of date,p_scope uuid[]) RETURNS TABLE (
 "employmentId" uuid,name text,email text,"employeeCode" text,
 "finalConfirmationDate" date,"confirmationDate" date,"probationEndDate" date,"provisionalEndOn" date,
 "resignationDate" date,"lastWorkingDate" date,"terminatedOn" date,"blacklistedAt" date,
 "companyId" uuid,company text,"departmentId" uuid,department text,"employmentType" text,
 "businessUnitId" uuid,"businessUnit" text,"positionId" uuid,"position" text,
 "parentCompanyId" uuid,"businessGroupId" uuid,"jobGrade" text,"jobGradeCode" text,
 "hiredOn" date,"joinDate" date,"costCenter" text,"workLocation" text,"reportingTo" text,
 "confirmationState" text,"qualityMissingBusinessUnit" boolean,"qualityMissingJobGrade" boolean,
 "qualityMissingDirectSuperior" boolean,"qualityCompanyNotInStructure" boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET enable_nestloop=off AS $$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 ),
 permitted AS MATERIALIZED (
   SELECT coalesce(array_agg(pc.id),'{}'::uuid[]) AS ids FROM permitted_companies pc
 ),
 candidates AS MATERIALIZED (
   SELECT p.full_name AS name,p.primary_email AS email,e.employee_code,
      e.probation_end_date,e.provisional_end_on,e.resignation_date,e.last_working_date,e.terminated_on,e.blacklisted_at,
      e.id,e.tenant_id,e.company_id,e.hired_on,e.join_date,e.grade_id,e.confirmation_date,e.final_confirmation_date
   FROM public.employment e
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND app.import_marker_visible(e.import_pending_attempt_id)
     AND e.company_id=ANY(p_scope) AND e.company_id=ANY((SELECT ids FROM permitted)::uuid[])
 ),
 future_correction_presence AS MATERIALIZED (
   SELECT EXISTS (
     SELECT 1 FROM public.domain_event ev
     WHERE ev.tenant_id=app.current_tenant_id() AND ev.event_type='employment.information.corrected'
       AND ev.payload->>'effectiveOn'>p_as_of::text
   ) AS present
 ),
 -- Each candidate's first future correction (by sequence), read only when one exists at all.
 corrections AS MATERIALIZED (
   SELECT f.employment_id,nullif(f.before_company,'')::uuid AS previous_company FROM (
     SELECT DISTINCT ON (ev.subject_employment_id) ev.subject_employment_id AS employment_id,
       ev.payload->'before'->>'companyId' AS before_company
     FROM public.domain_event ev
     WHERE (SELECT present FROM future_correction_presence) AND ev.tenant_id=app.current_tenant_id()
       AND ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>p_as_of::text
       AND ev.subject_employment_id IN (SELECT c.id FROM candidates c)
     ORDER BY ev.subject_employment_id,ev.sequence
   ) f
 ),
 dated AS MATERIALIZED (
   SELECT b.*,a.business_unit_id AS legacy_business_unit_id,a.department_id,a.position_id,a.employment_type,
          a.cost_center_id,a.location_id,
          coalesce(c.previous_company,a.company_id,b.company_id) AS dated_company
   FROM candidates b
   LEFT JOIN corrections c ON c.employment_id=b.id
   LEFT JOIN public.assignment a ON a.tenant_id=b.tenant_id AND a.employment_id=b.id
     AND a.superseded_at IS NULL AND a.valid_from<=p_as_of AND (a.valid_to IS NULL OR a.valid_to>p_as_of)
 ),
 current_principal AS MATERIALIZED (
   SELECT app.principal_snapshot_current() AS allowed
 ),
 -- The same companies' tags from one organisation read (app._personnel_company_tags), instead of one
 -- app.company_org_tags_unchecked call, which reads the whole tenant mapping twice, per company.
 company_tags AS MATERIALIZED (
   SELECT t.company_id AS id,t.tags FROM app._personnel_company_tags(ARRAY(
     SELECT pc.id FROM permitted_companies pc
     WHERE p_as_of IS NOT NULL AND isfinite(p_as_of)
       AND (SELECT allowed FROM current_principal)
       AND EXISTS (SELECT 1 FROM dated d WHERE d.dated_company=pc.id)),p_as_of) t
 ),
 -- The retained classification of each candidate at its dated company: the same row the per-row
 -- lookup took (latest effective, then created, then id), for every candidate at once.
 recorded AS MATERIALIZED (
   SELECT DISTINCT ON (c.employment_id,c.company_id) c.employment_id,c.company_id,c.tags
   FROM public.employment_organisation_classification c
   JOIN public.company_organisation_run r ON r.id=c.mapping_version_id AND r.tenant_id=c.tenant_id
   JOIN dated d ON d.id=c.employment_id AND d.dated_company=c.company_id
   WHERE c.tenant_id=app.current_tenant_id() AND c.effective_on<=p_as_of AND r.state='published' AND NOT EXISTS (
       SELECT 1 FROM public.company_organisation_mapping m
       JOIN public.company_organisation_run newer ON newer.id=m.run_id AND newer.tenant_id=m.tenant_id
       WHERE m.tenant_id=c.tenant_id AND m.company_id=c.company_id AND newer.state='published'
         AND newer.effective_on>c.effective_on AND newer.effective_on<=p_as_of
     )
   ORDER BY c.employment_id,c.company_id,c.effective_on DESC,c.created_at DESC,c.id DESC
 ),
 -- Fence the scoped candidates before the raising resolver; evaluate it once per row (OFFSET 0 keeps
 -- the tag expression from being repeated for each field read from it).
 tagged AS MATERIALIZED (
   SELECT d.*,x.tags->>'companyId' AS tag_company,x.tags->>'status' AS tag_status,
     x.tags->>'businessUnitId' AS tag_business_unit,x.tags->>'parentCompanyId' AS tag_parent,
     x.tags->>'businessGroupId' AS tag_group
   FROM dated d
   LEFT JOIN company_tags t ON t.id=d.dated_company
   LEFT JOIN recorded ON recorded.employment_id=d.id AND recorded.company_id=d.dated_company
   CROSS JOIN LATERAL (
     SELECT CASE
       WHEN t.tags->>'companyId' IS DISTINCT FROM d.dated_company::text OR t.tags IS NULL
         THEN app.employment_organisation_tags(d.id,p_as_of)
       WHEN t.tags->>'status'='legacy' THEN t.tags
       ELSE coalesce(recorded.tags,t.tags)
     END AS tags
     OFFSET 0
   ) x
 ),
 visible AS (
   SELECT b.*,COALESCE(b.tag_company::uuid,b.company_id) AS dated_company_id,
          CASE WHEN b.tag_status IN ('ready','pending') THEN b.tag_business_unit::uuid
            ELSE b.legacy_business_unit_id END AS dated_bu_id
   FROM tagged b
   WHERE COALESCE(b.tag_company::uuid,b.company_id)=ANY((SELECT ids FROM permitted)::uuid[])
 ),
 -- The dated administrative lines of the candidates, once.
 current_lines AS MATERIALIZED (
   SELECT r.id,r.subordinate_employment_id,r.manager_employment_id,r.valid_from
   FROM public.reporting_line r
   WHERE r.tenant_id=app.current_tenant_id() AND r.line_type='administrative'
     AND r.superseded_at IS NULL AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)
     AND r.subordinate_employment_id IN (SELECT c.id FROM candidates c)
 ),
 -- The JSON owner's reportingTo: the first such line (latest valid_from, then id) whose manager is a
 -- current employment of a permitted company.
 superiors AS MATERIALIZED (
   SELECT DISTINCT ON (l.subordinate_employment_id) l.subordinate_employment_id AS employment_id,mp.full_name
   FROM current_lines l
   JOIN public.employment me ON me.id=l.manager_employment_id AND me.tenant_id=app.current_tenant_id() AND me.voided_at IS NULL AND app.import_marker_visible(me.import_pending_attempt_id)
   JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id
   WHERE me.company_id=ANY((SELECT ids FROM permitted)::uuid[])
   ORDER BY l.subordinate_employment_id,l.valid_from DESC,l.id
 ),
 -- app.employment_organisation_quality_flags' direct-superior test: any dated administrative line, or
 -- a dated org-chart root (both hashed once below).
 rooted AS MATERIALIZED (
   SELECT r.employment_id FROM public.org_chart_root r
   WHERE r.tenant_id=app.current_tenant_id()
     AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)
 )
 SELECT v.id,v.name,v.email,v.employee_code,
   v.final_confirmation_date,v.confirmation_date,v.probation_end_date,v.provisional_end_on,
   v.resignation_date,v.last_working_date,v.terminated_on,v.blacklisted_at,
   v.dated_company_id,co.legal_name,v.department_id,COALESCE(NULLIF(btrim(d.label),''),d.name),v.employment_type::text,
   v.dated_bu_id,bu.name,v.position_id,COALESCE(NULLIF(btrim(pos.label),''),pos.title),
   CASE WHEN v.tag_parent::uuid=ANY((SELECT ids FROM permitted)::uuid[]) THEN v.tag_parent::uuid END,
   CASE WHEN v.tag_group::uuid=ANY((SELECT ids FROM permitted)::uuid[]) THEN v.tag_group::uuid END,
   g.name,g.code,v.hired_on,v.join_date,cc.name,loc.name,m.full_name,
   CASE WHEN COALESCE(v.final_confirmation_date,v.confirmation_date)<=p_as_of THEN 'confirmed' ELSE 'unconfirmed' END,
   CASE WHEN v.tag_company IS NOT NULL THEN v.hired_on<=p_as_of AND v.dated_bu_id IS NULL END,
   CASE WHEN v.tag_company IS NOT NULL THEN v.hired_on<=p_as_of AND v.grade_id IS NULL END,
   CASE WHEN v.tag_company IS NOT NULL THEN v.hired_on<=p_as_of
     AND NOT (v.id IN (SELECT l.subordinate_employment_id FROM current_lines l))
     AND NOT (v.id IN (SELECT r.employment_id FROM rooted r)) END,
   CASE WHEN v.tag_company IS NOT NULL THEN v.tag_status='pending' END
 FROM visible v
 JOIN public.company co ON co.id=v.dated_company_id AND co.tenant_id=v.tenant_id
 LEFT JOIN public.department d ON d.id=v.department_id AND d.tenant_id=v.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=v.dated_bu_id AND bu.tenant_id=v.tenant_id
 LEFT JOIN public.position pos ON pos.id=v.position_id AND pos.tenant_id=v.tenant_id
 LEFT JOIN public.job_grade g ON g.id=v.grade_id AND g.tenant_id=v.tenant_id
 LEFT JOIN public.cost_center cc ON cc.id=v.cost_center_id AND cc.tenant_id=v.tenant_id
 LEFT JOIN public.location loc ON loc.id=v.location_id AND loc.tenant_id=v.tenant_id
 LEFT JOIN superiors m ON m.employment_id=v.id
$$;
--> statement-breakpoint
-- Same signature, owner and grants: app.personnel_overview_filter_fields (5020), with the company tags read once.
CREATE OR REPLACE FUNCTION app.personnel_overview_filter_fields(p_as_of date,p_scope uuid[]) RETURNS TABLE (
 "employmentId" uuid,name text,email text,"employeeCode" text,
 "finalConfirmationDate" date,"confirmationDate" date,"probationEndDate" date,"provisionalEndOn" date,
 "resignationDate" date,"lastWorkingDate" date,"terminatedOn" date,"blacklistedAt" date,
 "companyId" uuid,company text,"departmentId" uuid,"employmentType" text,
 "businessUnitId" uuid,"businessUnit" text,"positionId" uuid,"position" text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET enable_nestloop=off AS $$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 ),
 permitted AS MATERIALIZED (
   SELECT coalesce(array_agg(pc.id),'{}'::uuid[]) AS ids FROM permitted_companies pc
 ),
 -- Caller-selected companies constrain the starting rows only. Permissions for the dated
 -- company, hierarchy and manager are checked against the entire tenant's allowed set.
 candidates AS MATERIALIZED (
   SELECT p.full_name AS name,p.primary_email AS email,e.employee_code,
      e.probation_end_date,e.provisional_end_on,e.resignation_date,e.last_working_date,e.terminated_on,e.blacklisted_at,
      e.id,e.tenant_id,e.company_id,e.hired_on,e.grade_id,e.confirmation_date,e.final_confirmation_date
   FROM public.employment e
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND app.import_marker_visible(e.import_pending_attempt_id)
     AND e.company_id=ANY(p_scope) AND e.company_id=ANY((SELECT ids FROM permitted)::uuid[])
 ),
 future_correction_presence AS MATERIALIZED (
   SELECT EXISTS (
     SELECT 1 FROM public.domain_event ev
     WHERE ev.tenant_id=app.current_tenant_id() AND ev.event_type='employment.information.corrected'
       AND ev.payload->>'effectiveOn'>p_as_of::text
   ) AS present
 ),
 corrections AS MATERIALIZED (
   SELECT f.employment_id,nullif(f.before_company,'')::uuid AS previous_company FROM (
     SELECT DISTINCT ON (ev.subject_employment_id) ev.subject_employment_id AS employment_id,
       ev.payload->'before'->>'companyId' AS before_company
     FROM public.domain_event ev
     WHERE (SELECT present FROM future_correction_presence) AND ev.tenant_id=app.current_tenant_id()
       AND ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>p_as_of::text
       AND ev.subject_employment_id IN (SELECT c.id FROM candidates c)
     ORDER BY ev.subject_employment_id,ev.sequence
   ) f
 ),
 dated AS MATERIALIZED (
   SELECT b.*,a.business_unit_id AS legacy_business_unit_id,a.department_id,a.position_id,a.employment_type,
          coalesce(c.previous_company,a.company_id,b.company_id) AS dated_company
   FROM candidates b
   LEFT JOIN corrections c ON c.employment_id=b.id
   LEFT JOIN public.assignment a ON a.tenant_id=b.tenant_id AND a.employment_id=b.id
     AND a.superseded_at IS NULL AND a.valid_from<=p_as_of AND (a.valid_to IS NULL OR a.valid_to>p_as_of)
 ),
 current_principal AS MATERIALIZED (
   SELECT app.principal_snapshot_current() AS allowed
 ),
 -- The same companies' tags from one organisation read (app._personnel_company_tags), instead of one
 -- app.company_org_tags_unchecked call, which reads the whole tenant mapping twice, per company.
 company_tags AS MATERIALIZED (
   SELECT t.company_id AS id,t.tags FROM app._personnel_company_tags(ARRAY(
     SELECT pc.id FROM permitted_companies pc
     WHERE p_as_of IS NOT NULL AND isfinite(p_as_of)
       AND (SELECT allowed FROM current_principal)
       AND EXISTS (SELECT 1 FROM dated d WHERE d.dated_company=pc.id)),p_as_of) t
 ),
 recorded AS MATERIALIZED (
   SELECT DISTINCT ON (c.employment_id,c.company_id) c.employment_id,c.company_id,c.tags
   FROM public.employment_organisation_classification c
   JOIN public.company_organisation_run r ON r.id=c.mapping_version_id AND r.tenant_id=c.tenant_id
   JOIN dated d ON d.id=c.employment_id AND d.dated_company=c.company_id
   WHERE c.tenant_id=app.current_tenant_id() AND c.effective_on<=p_as_of AND r.state='published' AND NOT EXISTS (
       SELECT 1 FROM public.company_organisation_mapping m
       JOIN public.company_organisation_run newer ON newer.id=m.run_id AND newer.tenant_id=m.tenant_id
       WHERE m.tenant_id=c.tenant_id AND m.company_id=c.company_id AND newer.state='published'
         AND newer.effective_on>c.effective_on AND newer.effective_on<=p_as_of
     )
   ORDER BY c.employment_id,c.company_id,c.effective_on DESC,c.created_at DESC,c.id DESC
 ),
 -- Fence the scoped candidates before the raising resolver, then retain its result once per row.
 -- The legacy BU is selected from legacy_business_unit_id below; no output uses a legacy tag BU.
 tagged AS MATERIALIZED (
   SELECT d.*,x.tags->>'companyId' AS tag_company,x.tags->>'status' AS tag_status,
     x.tags->>'businessUnitId' AS tag_business_unit
   FROM dated d
   LEFT JOIN company_tags t ON t.id=d.dated_company
   LEFT JOIN recorded ON recorded.employment_id=d.id AND recorded.company_id=d.dated_company
   CROSS JOIN LATERAL (
     SELECT CASE
       WHEN t.tags->>'companyId' IS DISTINCT FROM d.dated_company::text OR t.tags IS NULL
         THEN app.employment_organisation_tags(d.id,p_as_of)
       WHEN t.tags->>'status'='legacy' THEN t.tags
       ELSE coalesce(recorded.tags,t.tags)
     END AS tags
     OFFSET 0
   ) x
 ),
 visible AS (
   SELECT b.*,COALESCE(b.tag_company::uuid,b.company_id) AS dated_company_id,
          CASE WHEN b.tag_status IN ('ready','pending') THEN b.tag_business_unit::uuid
            ELSE b.legacy_business_unit_id END AS dated_bu_id
   FROM tagged b
   WHERE COALESCE(b.tag_company::uuid,b.company_id)=ANY((SELECT ids FROM permitted)::uuid[])
 )
 SELECT v.id,v.name,v.email,v.employee_code,
   v.final_confirmation_date,v.confirmation_date,v.probation_end_date,v.provisional_end_on,
   v.resignation_date,v.last_working_date,v.terminated_on,v.blacklisted_at,
   v.dated_company_id,co.legal_name,v.department_id,v.employment_type::text,
   v.dated_bu_id,bu.name,v.position_id,COALESCE(NULLIF(btrim(pos.label),''),pos.title)
 FROM visible v
 JOIN public.company co ON co.id=v.dated_company_id AND co.tenant_id=v.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=v.dated_bu_id AND bu.tenant_id=v.tenant_id
 LEFT JOIN public.position pos ON pos.id=v.position_id AND pos.tenant_id=v.tenant_id
$$;
--> statement-breakpoint
-- Same signature, owner and grants: app.personnel_filter_companies (5020), with the company tags read once.
CREATE OR REPLACE FUNCTION app.personnel_filter_companies(p_scope uuid[],p_as_of date)
RETURNS TABLE(id uuid,name text,"parentCompanyId" uuid,"parentCompany" text,"businessGroupId" uuid,"businessGroup" text,"businessUnitId" uuid,"businessUnit" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH admitted AS MATERIALIZED (
   SELECT c.id,c.tenant_id,c.legal_name
   FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND c.id=ANY(p_scope)
     AND app.access_workforce_projection_company(c.id)
 ),
 -- A missing day keeps the checked owner's refusal; otherwise every admitted company's tags come from
 -- one organisation read instead of one app.company_org_tags_unchecked call per company.
 tagged AS MATERIALIZED (
   SELECT c.*,CASE WHEN p_as_of IS NULL THEN app.company_organisation_tags(c.id,p_as_of) ELSE t.tags END AS tags
   FROM admitted c
   LEFT JOIN app._personnel_company_tags(
     CASE WHEN p_as_of IS NULL THEN '{}'::uuid[] ELSE ARRAY(SELECT a.id FROM admitted a) END,p_as_of) t ON t.company_id=c.id
 ),
 related_ids AS MATERIALIZED (
   SELECT (tags->>'parentCompanyId')::uuid AS id FROM tagged
   UNION
   SELECT (tags->>'businessGroupId')::uuid AS id FROM tagged
 ),
 visible_labels AS MATERIALIZED (
   SELECT id,legal_name FROM admitted
   UNION ALL
   SELECT c.id,c.legal_name
   FROM related_ids r JOIN public.company c ON c.id=r.id
   WHERE c.tenant_id=app.current_tenant_id()
     AND NOT EXISTS (SELECT 1 FROM admitted a WHERE a.id=c.id)
     AND app.access_workforce_projection_company(c.id)
 )
 SELECT c.id,c.legal_name,pc.id,pc.legal_name,bg.id,bg.legal_name,bu.id,bu.name
 FROM tagged c
 LEFT JOIN visible_labels pc ON pc.id=(c.tags->>'parentCompanyId')::uuid
 LEFT JOIN visible_labels bg ON bg.id=(c.tags->>'businessGroupId')::uuid
 LEFT JOIN public.business_unit bu ON bu.id=(c.tags->>'businessUnitId')::uuid AND bu.tenant_id=c.tenant_id
 ORDER BY c.legal_name,c.id
$$;
--> statement-breakpoint
-- Same signature, owner and grants: app.personnel_list_rows (4001), the private column filters' rows, with the two
-- permissions read once per company. Values, keys and fingerprints are unchanged.
CREATE OR REPLACE FUNCTION app.personnel_list_rows(p_as_of date,p_scope uuid[] DEFAULT NULL) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH admitted AS MATERIALIZED (SELECT value FROM app.personnel_filter_rows(p_as_of,p_scope) a(value)),
 -- The Workforce maintain permission once per dated company (every row already evaluated it for its
 -- employmentFieldsPermitted key; the row's companyId is its admitted dated company, never NULL) and the
 -- projection of each current manager's company once, instead of once per field and per row.
 maintain AS MATERIALIZED (
   SELECT x.company_id,app.access_workforce_company(x.company_id,'workforce.maintain') AS permitted
   FROM (SELECT DISTINCT (value->>'companyId')::uuid AS company_id FROM admitted) x
 ),
 manager_companies AS MATERIALIZED (
   SELECT x.company_id,app.access_workforce_projection_company(x.company_id) AS projected
   FROM (SELECT DISTINCT me.company_id FROM public.reporting_line r
     JOIN public.employment me ON me.id=r.manager_employment_id AND me.tenant_id=r.tenant_id
     WHERE r.tenant_id=app.current_tenant_id() AND r.line_type='administrative'
       AND r.subordinate_employment_id IN (SELECT (value->>'employmentId')::uuid FROM admitted)
       AND r.superseded_at IS NULL AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)) x
 ),
 extended AS MATERIALIZED (
 SELECT a.value||jsonb_build_object(
 'directSuperiorFullName',a.value->'reportingTo',
 'directSuperiorEmployeeCode',(SELECT me.employee_code FROM public.reporting_line r
 JOIN public.employment me ON me.id=r.manager_employment_id AND me.tenant_id=r.tenant_id AND me.voided_at IS NULL
 WHERE r.tenant_id=e.tenant_id AND r.subordinate_employment_id=e.id AND r.line_type='administrative'
 AND r.superseded_at IS NULL AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)
 AND me.company_id IN (SELECT m.company_id FROM manager_companies m WHERE m.projected) ORDER BY r.valid_from DESC,r.id LIMIT 1),
 'employmentFieldsPermitted',mp.permitted,'orgDivision',CASE WHEN a.value ? 'orgDivision' THEN a.value->'orgDivision' WHEN mp.permitted THEN to_jsonb(e.org_division) ELSE NULL::jsonb END,'orgBranch',CASE WHEN a.value ? 'orgBranch' THEN a.value->'orgBranch' WHEN mp.permitted THEN to_jsonb(e.org_branch) ELSE NULL::jsonb END,'orgRegion',CASE WHEN a.value ? 'orgRegion' THEN a.value->'orgRegion' WHEN mp.permitted THEN to_jsonb(e.org_region) ELSE NULL::jsonb END,'orgLine',CASE WHEN a.value ? 'orgLine' THEN a.value->'orgLine' WHEN mp.permitted THEN to_jsonb(e.org_line) ELSE NULL::jsonb END,'orgSection',CASE WHEN a.value ? 'orgSection' THEN a.value->'orgSection' WHEN mp.permitted THEN to_jsonb(e.org_section) ELSE NULL::jsonb END,'orgTeam',CASE WHEN a.value ? 'orgTeam' THEN a.value->'orgTeam' WHEN mp.permitted THEN to_jsonb(e.org_team) ELSE NULL::jsonb END,'orgBase',CASE WHEN a.value ? 'orgBase' THEN a.value->'orgBase' WHEN mp.permitted THEN to_jsonb(e.org_base) ELSE NULL::jsonb END,'employmentCategory',CASE WHEN a.value ? 'employmentCategory' THEN a.value->'employmentCategory' WHEN mp.permitted THEN to_jsonb(e.employment_category) ELSE NULL::jsonb END,'hiredOn',CASE WHEN a.value ? 'hiredOn' THEN a.value->'hiredOn' WHEN mp.permitted THEN to_jsonb(e.hired_on) ELSE NULL::jsonb END,'joinDate',CASE WHEN a.value ? 'joinDate' THEN a.value->'joinDate' WHEN mp.permitted THEN to_jsonb(e.join_date) ELSE NULL::jsonb END,'probationValue',CASE WHEN a.value ? 'probationValue' THEN a.value->'probationValue' WHEN mp.permitted THEN to_jsonb(e.probation_value) ELSE NULL::jsonb END,'probationUnit',CASE WHEN a.value ? 'probationUnit' THEN a.value->'probationUnit' WHEN mp.permitted THEN to_jsonb(e.probation_unit) ELSE NULL::jsonb END,'extendedProbationValue',CASE WHEN a.value ? 'extendedProbationValue' THEN a.value->'extendedProbationValue' WHEN mp.permitted THEN to_jsonb(e.extended_probation_value) ELSE NULL::jsonb END,'extendedProbationUnit',CASE WHEN a.value ? 'extendedProbationUnit' THEN a.value->'extendedProbationUnit' WHEN mp.permitted THEN to_jsonb(e.extended_probation_unit) ELSE NULL::jsonb END,'finalConfirmationDate',CASE WHEN a.value ? 'finalConfirmationDate' THEN a.value->'finalConfirmationDate' WHEN mp.permitted THEN to_jsonb(e.final_confirmation_date) ELSE NULL::jsonb END,'contractStartDate',CASE WHEN a.value ? 'contractStartDate' THEN a.value->'contractStartDate' WHEN mp.permitted THEN to_jsonb(e.contract_start_date) ELSE NULL::jsonb END,'contractEndDate',CASE WHEN a.value ? 'contractEndDate' THEN a.value->'contractEndDate' WHEN mp.permitted THEN to_jsonb(e.contract_end_date) ELSE NULL::jsonb END,'contractRemark',CASE WHEN a.value ? 'contractRemark' THEN a.value->'contractRemark' WHEN mp.permitted THEN to_jsonb(e.contract_remark) ELSE NULL::jsonb END,'noticeBeforeConfirmationValue',CASE WHEN a.value ? 'noticeBeforeConfirmationValue' THEN a.value->'noticeBeforeConfirmationValue' WHEN mp.permitted THEN to_jsonb(e.notice_before_confirmation_value) ELSE NULL::jsonb END,'noticeBeforeConfirmationUnit',CASE WHEN a.value ? 'noticeBeforeConfirmationUnit' THEN a.value->'noticeBeforeConfirmationUnit' WHEN mp.permitted THEN to_jsonb(e.notice_before_confirmation_unit) ELSE NULL::jsonb END,'noticeAfterConfirmationValue',CASE WHEN a.value ? 'noticeAfterConfirmationValue' THEN a.value->'noticeAfterConfirmationValue' WHEN mp.permitted THEN to_jsonb(e.notice_after_confirmation_value) ELSE NULL::jsonb END,'noticeAfterConfirmationUnit',CASE WHEN a.value ? 'noticeAfterConfirmationUnit' THEN a.value->'noticeAfterConfirmationUnit' WHEN mp.permitted THEN to_jsonb(e.notice_after_confirmation_unit) ELSE NULL::jsonb END,'tenderResignationDate',CASE WHEN a.value ? 'tenderResignationDate' THEN a.value->'tenderResignationDate' WHEN mp.permitted THEN to_jsonb(e.tender_resignation_date) ELSE NULL::jsonb END,'resignationDate',CASE WHEN a.value ? 'resignationDate' THEN a.value->'resignationDate' WHEN mp.permitted THEN to_jsonb(e.resignation_date) ELSE NULL::jsonb END,'lastWorkingDate',CASE WHEN a.value ? 'lastWorkingDate' THEN a.value->'lastWorkingDate' WHEN mp.permitted THEN to_jsonb(e.last_working_date) ELSE NULL::jsonb END,'confirmationDate',CASE WHEN a.value ? 'confirmationDate' THEN a.value->'confirmationDate' WHEN mp.permitted THEN to_jsonb(e.confirmation_date) ELSE NULL::jsonb END) value
 FROM admitted a JOIN maintain mp ON mp.company_id=(a.value->>'companyId')::uuid JOIN public.employment e ON e.id=(a.value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
 ) SELECT value||jsonb_build_object('filterRevision',md5(value::text)) FROM extended
$$;
--> statement-breakpoint
-- Same signature, owner and grants: app.personnel_list_rows_for_ids (5020), likewise.
CREATE OR REPLACE FUNCTION app.personnel_list_rows_for_ids(p_as_of date,p_scope uuid[],p_subjects uuid[]) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH admitted AS MATERIALIZED (SELECT value FROM app.personnel_overview_page_rows_typed(p_as_of,p_scope,p_subjects) a(value)),
 -- The Workforce maintain permission once per dated company (every row already evaluated it for its
 -- employmentFieldsPermitted key; the row's companyId is its admitted dated company, never NULL) and the
 -- projection of each current manager's company once, instead of once per field and per row.
 maintain AS MATERIALIZED (
   SELECT x.company_id,app.access_workforce_company(x.company_id,'workforce.maintain') AS permitted
   FROM (SELECT DISTINCT (value->>'companyId')::uuid AS company_id FROM admitted) x
 ),
 manager_companies AS MATERIALIZED (
   SELECT x.company_id,app.access_workforce_projection_company(x.company_id) AS projected
   FROM (SELECT DISTINCT me.company_id FROM public.reporting_line r
     JOIN public.employment me ON me.id=r.manager_employment_id AND me.tenant_id=r.tenant_id
     WHERE r.tenant_id=app.current_tenant_id() AND r.line_type='administrative'
       AND r.subordinate_employment_id IN (SELECT (value->>'employmentId')::uuid FROM admitted)
       AND r.superseded_at IS NULL AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)) x
 ),
 extended AS MATERIALIZED (
 SELECT a.value||jsonb_build_object(
 'directSuperiorFullName',a.value->'reportingTo',
 'directSuperiorEmployeeCode',(SELECT me.employee_code FROM public.reporting_line r
 JOIN public.employment me ON me.id=r.manager_employment_id AND me.tenant_id=r.tenant_id AND me.voided_at IS NULL AND app.import_marker_visible(me.import_pending_attempt_id)
 WHERE r.tenant_id=e.tenant_id AND r.subordinate_employment_id=e.id AND r.line_type='administrative'
 AND r.superseded_at IS NULL AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)
 AND me.company_id IN (SELECT m.company_id FROM manager_companies m WHERE m.projected) ORDER BY r.valid_from DESC,r.id LIMIT 1),
 'employmentFieldsPermitted',mp.permitted,'orgDivision',CASE WHEN a.value ? 'orgDivision' THEN a.value->'orgDivision' WHEN mp.permitted THEN to_jsonb(e.org_division) ELSE NULL::jsonb END,'orgBranch',CASE WHEN a.value ? 'orgBranch' THEN a.value->'orgBranch' WHEN mp.permitted THEN to_jsonb(e.org_branch) ELSE NULL::jsonb END,'orgRegion',CASE WHEN a.value ? 'orgRegion' THEN a.value->'orgRegion' WHEN mp.permitted THEN to_jsonb(e.org_region) ELSE NULL::jsonb END,'orgLine',CASE WHEN a.value ? 'orgLine' THEN a.value->'orgLine' WHEN mp.permitted THEN to_jsonb(e.org_line) ELSE NULL::jsonb END,'orgSection',CASE WHEN a.value ? 'orgSection' THEN a.value->'orgSection' WHEN mp.permitted THEN to_jsonb(e.org_section) ELSE NULL::jsonb END,'orgTeam',CASE WHEN a.value ? 'orgTeam' THEN a.value->'orgTeam' WHEN mp.permitted THEN to_jsonb(e.org_team) ELSE NULL::jsonb END,'orgBase',CASE WHEN a.value ? 'orgBase' THEN a.value->'orgBase' WHEN mp.permitted THEN to_jsonb(e.org_base) ELSE NULL::jsonb END,'employmentCategory',CASE WHEN a.value ? 'employmentCategory' THEN a.value->'employmentCategory' WHEN mp.permitted THEN to_jsonb(e.employment_category) ELSE NULL::jsonb END,'hiredOn',CASE WHEN a.value ? 'hiredOn' THEN a.value->'hiredOn' WHEN mp.permitted THEN to_jsonb(e.hired_on) ELSE NULL::jsonb END,'joinDate',CASE WHEN a.value ? 'joinDate' THEN a.value->'joinDate' WHEN mp.permitted THEN to_jsonb(e.join_date) ELSE NULL::jsonb END,'probationValue',CASE WHEN a.value ? 'probationValue' THEN a.value->'probationValue' WHEN mp.permitted THEN to_jsonb(e.probation_value) ELSE NULL::jsonb END,'probationUnit',CASE WHEN a.value ? 'probationUnit' THEN a.value->'probationUnit' WHEN mp.permitted THEN to_jsonb(e.probation_unit) ELSE NULL::jsonb END,'extendedProbationValue',CASE WHEN a.value ? 'extendedProbationValue' THEN a.value->'extendedProbationValue' WHEN mp.permitted THEN to_jsonb(e.extended_probation_value) ELSE NULL::jsonb END,'extendedProbationUnit',CASE WHEN a.value ? 'extendedProbationUnit' THEN a.value->'extendedProbationUnit' WHEN mp.permitted THEN to_jsonb(e.extended_probation_unit) ELSE NULL::jsonb END,'finalConfirmationDate',CASE WHEN a.value ? 'finalConfirmationDate' THEN a.value->'finalConfirmationDate' WHEN mp.permitted THEN to_jsonb(e.final_confirmation_date) ELSE NULL::jsonb END,'contractStartDate',CASE WHEN a.value ? 'contractStartDate' THEN a.value->'contractStartDate' WHEN mp.permitted THEN to_jsonb(e.contract_start_date) ELSE NULL::jsonb END,'contractEndDate',CASE WHEN a.value ? 'contractEndDate' THEN a.value->'contractEndDate' WHEN mp.permitted THEN to_jsonb(e.contract_end_date) ELSE NULL::jsonb END,'contractRemark',CASE WHEN a.value ? 'contractRemark' THEN a.value->'contractRemark' WHEN mp.permitted THEN to_jsonb(e.contract_remark) ELSE NULL::jsonb END,'noticeBeforeConfirmationValue',CASE WHEN a.value ? 'noticeBeforeConfirmationValue' THEN a.value->'noticeBeforeConfirmationValue' WHEN mp.permitted THEN to_jsonb(e.notice_before_confirmation_value) ELSE NULL::jsonb END,'noticeBeforeConfirmationUnit',CASE WHEN a.value ? 'noticeBeforeConfirmationUnit' THEN a.value->'noticeBeforeConfirmationUnit' WHEN mp.permitted THEN to_jsonb(e.notice_before_confirmation_unit) ELSE NULL::jsonb END,'noticeAfterConfirmationValue',CASE WHEN a.value ? 'noticeAfterConfirmationValue' THEN a.value->'noticeAfterConfirmationValue' WHEN mp.permitted THEN to_jsonb(e.notice_after_confirmation_value) ELSE NULL::jsonb END,'noticeAfterConfirmationUnit',CASE WHEN a.value ? 'noticeAfterConfirmationUnit' THEN a.value->'noticeAfterConfirmationUnit' WHEN mp.permitted THEN to_jsonb(e.notice_after_confirmation_unit) ELSE NULL::jsonb END,'tenderResignationDate',CASE WHEN a.value ? 'tenderResignationDate' THEN a.value->'tenderResignationDate' WHEN mp.permitted THEN to_jsonb(e.tender_resignation_date) ELSE NULL::jsonb END,'resignationDate',CASE WHEN a.value ? 'resignationDate' THEN a.value->'resignationDate' WHEN mp.permitted THEN to_jsonb(e.resignation_date) ELSE NULL::jsonb END,'lastWorkingDate',CASE WHEN a.value ? 'lastWorkingDate' THEN a.value->'lastWorkingDate' WHEN mp.permitted THEN to_jsonb(e.last_working_date) ELSE NULL::jsonb END,'confirmationDate',CASE WHEN a.value ? 'confirmationDate' THEN a.value->'confirmationDate' WHEN mp.permitted THEN to_jsonb(e.confirmation_date) ELSE NULL::jsonb END) value
 FROM admitted a JOIN maintain mp ON mp.company_id=(a.value->>'companyId')::uuid JOIN public.employment e ON e.id=(a.value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND app.import_marker_visible(e.import_pending_attempt_id)
 ) SELECT value||jsonb_build_object('filterRevision',md5(value::text)) FROM extended
$$;
--> statement-breakpoint
-- Same trigger function (5020): the same checks and refusals, with the two "every entry is still bound" tests
-- written as set differences (a nested anti-join compared every entry with every dated row: two seconds for a
-- 10,000-employment membership).
CREATE OR REPLACE FUNCTION app.personnel_private_search_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_day date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.actor_id IS DISTINCT FROM app.current_user_id() OR NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=NEW.actor_id AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Private search unavailable' USING ERRCODE='42501'; END IF;
 IF NEW.criteria IS NOT NULL THEN
  IF jsonb_typeof(NEW.criteria)<>'object' OR NEW.criteria-ARRAY['term','filters']<>'{}'::jsonb OR jsonb_typeof(NEW.criteria->'term') IS DISTINCT FROM 'string' OR length(NEW.criteria->>'term')>200 OR jsonb_typeof(NEW.criteria->'filters') IS DISTINCT FROM 'array' OR octet_length(NEW.criteria::text)>65536 THEN RAISE EXCEPTION 'Private filters unavailable' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(NEW.criteria->'filters')>80 OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(NEW.criteria->'filters') f
   WHERE jsonb_typeof(f)<>'object' OR f-ARRAY['field','operator','value']<>'{}'::jsonb
    OR jsonb_typeof(f->'field') IS DISTINCT FROM 'string' OR f->>'field' NOT IN ('code','name','company','department','position','status','jobGrade','employmentType','reportingTo','businessUnit','costCenter','workLocation','groupJoinDate','joinDate','confirmationDate','email','identity','employment.directSuperiorEmployeeCode','employment.directSuperiorFullName','employment.orgDivision','employment.orgBranch','employment.orgRegion','employment.orgLine','employment.orgSection','employment.orgTeam','employment.orgBase','employment.employmentCategory','employment.hiredOn','employment.joinDate','employment.groupService','employment.companyService','employment.yearOfService','employment.probationValue','employment.probationUnit','employment.extendedProbationValue','employment.extendedProbationUnit','employment.finalConfirmationDate','employment.contractStartDate','employment.contractEndDate','employment.contractRemark','employment.noticeBeforeConfirmationValue','employment.noticeBeforeConfirmationUnit','employment.noticeAfterConfirmationValue','employment.noticeAfterConfirmationUnit','employment.tenderResignationDate','employment.resignationDate','employment.lastWorkingDate','employment.confirmationDate')
    OR jsonb_typeof(f->'operator') IS DISTINCT FROM 'string' OR f->>'operator' NOT IN ('contains','equals','blank','notBlank','from','to')
    OR jsonb_typeof(f->'value') IS DISTINCT FROM 'string' OR length(f->>'value')>200
    OR (f->>'operator'='contains' AND f->>'field' IN ('employment.probationValue','employment.extendedProbationValue','employment.noticeBeforeConfirmationValue','employment.noticeAfterConfirmationValue','groupJoinDate','joinDate','confirmationDate','employment.hiredOn','employment.joinDate','employment.finalConfirmationDate','employment.contractStartDate','employment.contractEndDate','employment.tenderResignationDate','employment.resignationDate','employment.lastWorkingDate','employment.confirmationDate'))
    OR (f->>'operator' IN ('from','to') AND f->>'field' NOT IN ('employment.probationValue','employment.extendedProbationValue','employment.noticeBeforeConfirmationValue','employment.noticeAfterConfirmationValue','groupJoinDate','joinDate','confirmationDate','employment.hiredOn','employment.joinDate','employment.finalConfirmationDate','employment.contractStartDate','employment.contractEndDate','employment.tenderResignationDate','employment.resignationDate','employment.lastWorkingDate','employment.confirmationDate'))
    OR (f->>'operator' NOT IN ('blank','notBlank') AND f->>'field' IN ('employment.probationValue','employment.extendedProbationValue','employment.noticeBeforeConfirmationValue','employment.noticeAfterConfirmationValue') AND f->>'value' !~ '^[-+]?(?:[0-9]+[.]?[0-9]*|[.][0-9]+)$')
    OR (f->>'operator' NOT IN ('blank','notBlank') AND f->>'field' IN ('groupJoinDate','joinDate','confirmationDate','employment.hiredOn','employment.joinDate','employment.finalConfirmationDate','employment.contractStartDate','employment.contractEndDate','employment.tenderResignationDate','employment.resignationDate','employment.lastWorkingDate','employment.confirmationDate') AND f->>'value' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
  ) OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.criteria->'filters') f GROUP BY f->>'field' HAVING count(*)>1)
  THEN RAISE EXCEPTION 'Private filters unavailable' USING ERRCODE='22023'; END IF;
 END IF;
 IF jsonb_typeof(NEW.matches)<>'array' OR jsonb_array_length(NEW.matches)>100000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.matches)m WHERE COALESCE(m->>'employmentId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR m->>'kind' IS NULL OR m->>'kind' NOT IN ('public','identity') OR COALESCE(m->>'personRevision','') !~ '^[0-9]{1,12}$' OR COALESCE(m->>'employmentRevision','') !~ '^[0-9]{1,12}$' OR (m->>'identityRevision' IS NOT NULL AND m->>'identityRevision' !~ '^[0-9]{1,12}$') OR (m ? 'filterRevision' AND COALESCE(m->>'filterRevision','') !~ '^[a-f0-9]{32}$') OR jsonb_typeof(m)<>'object' OR m-ARRAY['employmentId','kind','personRevision','employmentRevision','identityRevision','filterRevision']<>'{}'::jsonb) THEN RAISE EXCEPTION 'Private search unavailable' USING ERRCODE='22023'; END IF;
 -- Bind exact row identity and revisions before the guarded resolver can run.
 -- PostgreSQL may reorder WHERE predicates, but cannot push them through these fences.
 IF EXISTS (
  WITH entries AS MATERIALIZED (
   SELECT item,ordinal FROM jsonb_array_elements(NEW.matches) WITH ORDINALITY AS m(item,ordinal)
  ),
  -- Each entry's employment first, by its key. Rows written in one transaction share an xmin, so a
  -- planner free to join entries to persons on the revision text alone multiplies them.
  entry_employments AS MATERIALIZED (
   SELECT m.ordinal,m.item,e.id,e.company_id,e.person_id,e.tenant_id,e.xmin::text AS employment_revision
   FROM entries m
   JOIN public.employment e ON e.id=(m.item->>'employmentId')::uuid AND e.tenant_id=NEW.tenant_id
   WHERE e.voided_at IS NULL
  ),
  matched AS MATERIALIZED (
   SELECT m.ordinal,m.item->>'kind' AS kind,m.id,m.company_id
   FROM entry_employments m
   JOIN public.person p ON p.id=m.person_id AND p.tenant_id=m.tenant_id
   LEFT JOIN public.employee_statutory_my i ON i.person_id=p.id AND i.tenant_id=p.tenant_id
   WHERE m.employment_revision=m.item->>'employmentRevision'
     AND p.xmin::text=m.item->>'personRevision'
     AND (m.item->>'kind'='public' OR i.xmin::text=m.item->>'identityRevision')
  ),
  dated AS MATERIALIZED (
   SELECT m.ordinal,m.kind,
     COALESCE((t.tags->>'companyId')::uuid,m.company_id) AS company_id
   FROM matched m
   JOIN app._personnel_employment_tags(ARRAY(SELECT DISTINCT id FROM matched),v_day) t ON t.employment_id=m.id
  ),
  -- The two company permissions, once per dated company instead of once per entry.
  company_checks AS MATERIALIZED (
   SELECT x.company_id,app.access_workforce_projection_company(x.company_id) AS projected,
     app.personnel_identity_search_permitted(x.company_id) AS identity
   FROM (SELECT DISTINCT company_id FROM dated) x
  )
  -- Every entry needs a dated row in a projected company (for an identity entry, one where identity search is
  -- permitted): the entries that have none, as one set difference instead of a scan of the dated rows per entry.
  SELECT 1 FROM (SELECT m.ordinal FROM entries m
   EXCEPT SELECT d.ordinal FROM dated d JOIN company_checks k ON k.company_id=d.company_id
    WHERE k.projected AND (d.kind='public' OR k.identity)) AS unbound
 ) THEN RAISE EXCEPTION 'Private search changed. Try again.' USING ERRCODE='40001'; END IF;
 IF NEW.scope_ids IS NULL OR cardinality(NEW.scope_ids)>1000 OR EXISTS(SELECT 1 FROM unnest(NEW.scope_ids)x WHERE x IS NULL OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=x AND c.tenant_id=NEW.tenant_id AND app.access_workforce_projection_company(c.id))) THEN RAISE EXCEPTION 'Private search scope unavailable' USING ERRCODE='42501'; END IF;

 -- Fingerprint filters against the complete permission-bound current row. No raw criterion is stored.
 IF EXISTS (
  WITH expected AS MATERIALIZED (SELECT item FROM jsonb_array_elements(NEW.matches)item WHERE item ? 'filterRevision'),
  -- The current rows of the fingerprinted entries only (byte-identical JSON), or every row past 2,000.
  subjects AS MATERIALIZED (
   SELECT array_agg(DISTINCT (item->>'employmentId')::uuid) AS ids,count(DISTINCT item->>'employmentId') AS n FROM expected
  ),
  current_rows AS MATERIALIZED (
   SELECT r.value->>'employmentId' AS id,r.value->>'filterRevision' AS revision
   FROM subjects s CROSS JOIN LATERAL app.personnel_list_rows_for_ids(v_day,NEW.scope_ids,s.ids) r(value) WHERE s.n BETWEEN 1 AND 2000
   UNION ALL
   SELECT r.value->>'employmentId',r.value->>'filterRevision'
   FROM app.personnel_list_rows(v_day,NEW.scope_ids) r(value) WHERE (SELECT n FROM subjects)>2000
  )
  -- Every fingerprint must be a current row's: the fingerprints that are not, as one set difference.
  SELECT 1 FROM (SELECT m.item->>'employmentId',m.item->>'filterRevision' FROM expected m
   EXCEPT SELECT c.id,c.revision FROM current_rows c) AS stale
 ) THEN RAISE EXCEPTION 'Private filters changed. Try again.' USING ERRCODE='40001'; END IF;
 NEW.scope_ids:=ARRAY(SELECT DISTINCT x FROM unnest(NEW.scope_ids)x ORDER BY x);
 PERFORM pg_advisory_xact_lock(hashtextextended('personnel-private-search:'||NEW.tenant_id::text||':'||NEW.actor_id::text,0));
 NEW.created_at:=clock_timestamp();NEW.expires_at:=NEW.created_at+interval '5 minutes';
 DELETE FROM public.personnel_private_search WHERE tenant_id=NEW.tenant_id AND actor_id=NEW.actor_id AND (expires_at<=now() OR token_hash IN(SELECT token_hash FROM public.personnel_private_search WHERE tenant_id=NEW.tenant_id AND actor_id=NEW.actor_id ORDER BY created_at DESC OFFSET 7));
 RETURN NEW;
END $$;
--> statement-breakpoint
-- The Personnel private search's source: exactly app.personnel_search_rows (the same fences, dated company,
-- admission and identity permission, row for row, and the same refusals), returned as
--   population  the number of those rows, counted to at most 100001 (the caller refuses more than 100000), and
--   value       the row's JSON, only for rows that may match; one row with a NULL value when none may.
-- A row may match unless the caller's criteria provably exclude it. p_every keeps every row (no term and no
-- identity filter, or a process locale whose lower case differs on ASCII) and p_none keeps none (an identity filter
-- other than "contains" matches nothing). Otherwise a row is kept when the identity filters (p_identity, already
-- lower-cased) may all match and, unless p_needle is NULL, the term may match. "May contain" is exact for an ASCII
-- value (its JavaScript lower case is its A-Z translation) and true for any other value, so a row is only ever
-- excluded when the JavaScript rule (lib/employee-search.ts and the private-search identity rule) would exclude it
-- (a row with any non-ASCII text is always kept):
-- p_raw and p_folded are the term as matchesEmployeeSearch lowers and folds it, p_needle as toLocaleLowerCase
-- lowers it, and p_nric the separator-free NRIC. Nested loops and JIT compilation are off, as in the resolver above.
CREATE FUNCTION app.personnel_search_candidates(p_scope uuid[],p_every boolean,p_none boolean,p_raw text,p_folded text,p_needle text,p_nric text,p_identity text[])
RETURNS TABLE(population integer,value jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET enable_nestloop=off SET jit=off AS $$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id
   FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id()
     AND c.id=ANY(p_scope)
     AND app.access_workforce_projection_company(c.id)
 ),
 -- Fence the scoped candidates before the dated resolver, which can raise for hidden rows.
 candidates AS MATERIALIZED (
   SELECT e.id,e.person_id,e.tenant_id,e.company_id,e.employee_code,e.xmin::text employment_revision,
          p.full_name,p.primary_email,p.xmin::text person_revision
   FROM public.employment e
   JOIN permitted_companies allowed ON allowed.id=e.company_id
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND app.import_marker_visible(e.import_pending_attempt_id)
 ),
 tagged AS MATERIALIZED (
   SELECT c.*,COALESCE((t.tags->>'companyId')::uuid,c.company_id) dated_company_id
   FROM candidates c
   JOIN app._personnel_employment_tags(ARRAY(SELECT id FROM candidates),(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) t ON t.employment_id=c.id
 ),
 admitted AS MATERIALIZED (
   SELECT t.* FROM tagged t JOIN permitted_companies allowed ON allowed.id=t.dated_company_id
 ),
 -- Fenced, so the permission is evaluated once per company and not pushed down to every admitted row.
 dated_companies AS MATERIALIZED (
   SELECT DISTINCT dated_company_id FROM admitted
 ),
 identity_companies AS MATERIALIZED (
   SELECT d.dated_company_id
   FROM dated_companies d
   WHERE app.personnel_identity_search_permitted(d.dated_company_id)
 ),
 source AS MATERIALIZED (
   SELECT a.*,s.xmin::text AS identity_revision,s.ic_number,s.passport_number
   FROM admitted a
   LEFT JOIN identity_companies allowed ON allowed.dated_company_id=a.dated_company_id
   LEFT JOIN public.employee_statutory_my s ON s.person_id=a.person_id AND s.tenant_id=a.tenant_id
     AND allowed.dated_company_id IS NOT NULL
 ),
 population AS MATERIALIZED (
   SELECT count(*)::integer AS n FROM (SELECT 1 FROM source LIMIT 100001) AS bounded
 ),
 encoding AS MATERIALIZED (
   SELECT pg_catalog.getdatabaseencoding()='UTF8' AS utf8
 ),
 -- A row whose text is all ASCII is decided exactly; any other row is kept for the caller's own check.
 kept AS MATERIALIZED (
   SELECT s.* FROM source s CROSS JOIN encoding x
   CROSS JOIN LATERAL (SELECT concat(s.full_name,s.employee_code,s.primary_email,s.ic_number,s.passport_number) AS text) t
   WHERE NOT p_none AND (p_every OR NOT (x.utf8 AND octet_length(t.text)=length(t.text)) OR (
     (p_needle IS NULL OR strpos(lower(coalesce(s.full_name,'') COLLATE "C"),p_raw)>0
       OR strpos(lower(coalesce(s.employee_code,'') COLLATE "C"),p_raw)>0
       OR (p_folded<>'' AND strpos(translate(lower(coalesce(s.employee_code,'') COLLATE "C"),E' \t\n\x0b\x0c\r._-',''),p_folded)>0)
       OR (s.primary_email IS NOT NULL AND strpos(lower(s.primary_email COLLATE "C"),p_needle)>0)
       OR (s.ic_number IS NOT NULL AND strpos(lower(s.ic_number COLLATE "C"),p_needle)>0)
       OR (p_nric IS NOT NULL AND s.ic_number=p_nric)
       OR (s.passport_number IS NOT NULL AND strpos(lower(s.passport_number COLLATE "C"),p_needle)>0))
     AND NOT EXISTS (SELECT 1 FROM unnest(p_identity) AS q(v)
       WHERE NOT ((s.ic_number IS NOT NULL AND strpos(lower(s.ic_number COLLATE "C"),q.v)>0) OR (s.passport_number IS NOT NULL AND strpos(lower(s.passport_number COLLATE "C"),q.v)>0)))))
 )
 SELECT p.n,CASE WHEN a.id IS NOT NULL THEN jsonb_build_object('employmentId',a.id,'companyId',a.dated_company_id,
   'name',a.full_name,'email',a.primary_email,'employeeCode',a.employee_code,
   'personRevision',a.person_revision,'employmentRevision',a.employment_revision,
   'identityRevision',a.identity_revision,'icNumber',a.ic_number,'passportNumber',a.passport_number) END
 FROM population p LEFT JOIN kept a ON true
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_search_candidates(uuid[],boolean,boolean,text,text,text,text,text[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.personnel_search_candidates(uuid[],boolean,boolean,text,text,text,text,text[]) TO ai_hr_app;

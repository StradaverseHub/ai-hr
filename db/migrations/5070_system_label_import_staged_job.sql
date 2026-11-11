-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5070_system_label_import_staged_job, idx 4470, when 1793330004770.
-- Draft name on its branch: 9961_system_label_import_staged_job. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-labels-20261110 (bulk-operation conversion, 10 Nov 2026): not a
-- reservation, not an installation allocation. The journal position (idx 9961, when 1793330090961) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md. Discard this file's position, not its bytes.
--
-- System Labels import as a staged background job on the shared kernel (5011). The import used to hold the tenant's
-- Access, leave-dependency and catalogue locks for its whole analysis and write (1.3 s idle, 9.7 s loaded at 445
-- codes). It stays all-or-nothing: the worker writes the new codes in short chunk transactions through the ordinary
-- writers, every row it writes stays invisible (the 5010/5012 staged-attempt marker), and one short transaction
-- releases them all at once. A refused or stopped import deletes its staged rows; nobody ever saw them.
-- Admission input (5013): the preview token and the optional row selection (at most 7,000 row keys, far below the
-- default 1 MiB input limit); the workbook travels as the job's source file. The release runs under the creator's
-- authority in an app-role transaction and nothing is settled afterwards, so finalize needs no owner connection.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive,input_shape,finalize_owner)
 VALUES('system_label_import',NULL,'tenant','{"token":"string","selectedKeys":"array?"}'::jsonb,false);
--> statement-breakpoint
-- The nine catalogue tables the import writes. Every row inserted while app.import_attempt is set (only the worker's
-- chunk transactions set it) is stamped by the database; the 5010 guard refuses any other writer of the column.
-- RESTRICTIVE, ANDed with each table's tenant/scope policies, for every role subject to row security.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['department','position','cost_center','business_unit','label_company_assignment','profile_option','job_grade','grade_group','grade_group_member'] LOOP
  EXECUTE format('ALTER TABLE public.%I ADD COLUMN import_pending_attempt_id uuid',t);
  EXECUTE format('CREATE INDEX %I ON public.%I(tenant_id,import_pending_attempt_id) WHERE import_pending_attempt_id IS NOT NULL',t||'_import_pending_idx',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.import_pending_stamp()',t||'_import_pending_stamp',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OF import_pending_attempt_id ON public.%I FOR EACH ROW EXECUTE FUNCTION app.import_pending_guard()',t||'_import_pending_guard',t);
  EXECUTE format($p$CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL
   USING (import_pending_attempt_id IS NULL OR import_pending_attempt_id::text = current_setting('app.import_attempt',true)
    OR import_pending_attempt_id = ANY((SELECT app.import_released_attempt_ids())::uuid[]))$p$,t||'_import_pending',t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Release record of a label import attempt (the attempt id is kept in the job's plan; bulk_job.attempt_id
-- references Import History, which System Labels does not use). 'activated' makes the staged
-- rows and their audit events visible; 'discarded' records that the staged rows were deleted and the events stay
-- hidden, so the visible outcome of a refused import is exactly that of the old rolled-back transaction.
CREATE TABLE app.system_label_import_release (
 attempt_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 job_id uuid NOT NULL,
 created_by uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('activated','discarded')),
 released_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX system_label_import_release_tenant ON app.system_label_import_release(tenant_id) WHERE outcome='activated';
--> statement-breakpoint
REVOKE ALL ON app.system_label_import_release FROM PUBLIC;
--> statement-breakpoint
-- Policy-side released attempts (5012) now include activated label imports, so the staged label rows and the label
-- events stamped in their chunks (domain_event, 5012) become visible in the same instant. Reveals attempt ids only.
CREATE OR REPLACE FUNCTION app.import_released_attempt_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(x.attempt_id),'{}'::uuid[]) FROM (
  SELECT r.attempt_id FROM app.import_attempt_release r WHERE r.tenant_id=app.current_tenant_id()
  UNION ALL
  SELECT l.attempt_id FROM app.system_label_import_release l WHERE l.tenant_id=app.current_tenant_id() AND l.outcome='activated') x;
$$;
--> statement-breakpoint
-- app.import_released_attempt_ids() (5012), now also named by the nine catalogue tables' policies above, is evaluated by row security under whichever role a policy applies to, so it is executable by exactly
-- those roles instead of PUBLIC: a policy's own roles, or, for a policy to PUBLIC, every role holding a privilege on
-- the policy's table (and the table owner where row security is forced). A role granted such a table later needs
-- this grant too; without it the policy fails closed (permission denied), never open.
DO $policy_function_grants$
DECLARE fn regprocedure:='app.import_released_attempt_ids()'::regprocedure; r record;
BEGIN
 FOR r IN
  WITH policies AS (
   SELECT DISTINCT p.oid,p.polrelid,p.polroles FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_depend d
    ON d.classid='pg_catalog.pg_policy'::regclass AND d.objid=p.oid AND d.refclassid='pg_catalog.pg_proc'::regclass AND d.refobjid=fn)
  SELECT DISTINCT g.grantee FROM (
   SELECT unnest(p.polroles) AS grantee FROM policies p
   UNION ALL
   SELECT a.grantee FROM policies p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE 0=ANY(p.polroles) AND (a.grantee<>c.relowner OR c.relforcerowsecurity)
   UNION ALL
   SELECT a.grantee FROM policies p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    JOIN pg_catalog.pg_attribute att ON att.attrelid=c.oid AND att.attacl IS NOT NULL
    CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
    WHERE 0=ANY(p.polroles) AND (a.grantee<>c.relowner OR c.relforcerowsecurity)
   UNION ALL
   SELECT c.relowner FROM policies p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid WHERE 0=ANY(p.polroles) AND c.relforcerowsecurity
  ) g WHERE g.grantee<>0
 LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',fn,pg_catalog.pg_get_userbyid(r.grantee));
 END LOOP;
END $policy_function_grants$;
--> statement-breakpoint
-- Definer-side predicate for the catalogue readers below: unmarked, the reader's own import session, or released.
-- SQL, invoker, no SET clause, so the planner inlines it into each definer.
CREATE FUNCTION app.label_import_marker_visible(p_attempt uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT p_attempt IS NULL OR p_attempt::text=current_setting('app.import_attempt',true)
  OR EXISTS(SELECT 1 FROM app.system_label_import_release r WHERE r.attempt_id=p_attempt AND r.outcome='activated');
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.label_import_marker_visible(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Definer audit (docs/adr/2026-11-10-system-label-import-staged-job.md). Definers bypass row security. Of the 99
-- definers that read the nine tables, these enumerate catalogue rows independently of any reference and would
-- otherwise offer, count, fingerprint or route by a staged code before release; each is re-created from its installed
-- definition with the predicate on exactly the listed reads, after checking how many such reads it has. Readers that
-- reach a catalogue row only through a stored reference or a caller-supplied id cannot meet a staged row (nothing
-- references a new code, and no reader discloses its id); the import's own reservation readers
-- (existing_system_label_import_keys, system_label_catalog_conflicts) keep seeing staged codes so they stay reserved.
DO $$
DECLARE r record; def text; found integer; owner_ name;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  -- Approval routing: a staged department or business unit naming an existing head must not route approvals yet.
  ('app.approver_level(uuid,date)','(FROM business_unit bu\s+WHERE )','bu',1),
  ('app.approver_level(uuid,date)','(FROM department d\s+WHERE )','d',1),
  -- Choice lists offered to administrators and the assistant.
  ('app.company_organisation_options()','(FROM business_unit b WHERE )','b',1),
  ('app.contract_configuration_choices(uuid)','(FROM public\.business_unit b WHERE )','b',1),
  ('app.contract_workflow_business_groups()','(JOIN public\.business_unit bu ON )','bu',1),
  ('app.reward_policy_memberships(uuid[])','(JOIN public\.business_unit u ON )','u',1),
  ('app.assistant_family_maintenance_context(uuid)','(FROM public\.profile_option o WHERE )','o',1),
  -- Archive entry points (whether any archivable code exists).
  ('app.department_archive_entry_available()','(FROM public\.department p WHERE )','p',1),
  ('app.position_archive_entry_available()','(FROM public\.position p WHERE )','p',1),
  -- Value checks: whether a category has configured codes and which codes are allowed.
  ('app.profile_option_value_allowed(text,text,text,uuid)','(FROM public\.profile_option p WHERE )','p',2),
  ('app.profile_option_value_allowed(text,text,text)','(FROM public\.profile_option p WHERE )','p',2),
  ('app.system_label_value_scope_allowed(text,text,uuid)','(FROM public\.profile_option p WHERE )','p',1),
  ('app.access_workforce_value_shape(text,text,jsonb,jsonb)','(FROM public\.profile_option o WHERE )','o',1)
 ) v(sig,pattern,alias,expected) LOOP
  -- Each definer belongs to the migration owner, which re-creates it; see the row-security readers below.
  SELECT o.rolname INTO owner_ FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid=p.proowner WHERE p.oid=r.sig::regprocedure;
  IF owner_<>current_user THEN RAISE EXCEPTION 'label import predicate: % belongs to %, not the migration owner',r.sig,owner_ USING ERRCODE='42501'; END IF;
  def:=pg_catalog.pg_get_functiondef(r.sig::regprocedure);
  SELECT count(*) INTO found FROM regexp_matches(def,r.pattern,'g');
  IF found<>r.expected THEN RAISE EXCEPTION 'label import predicate: % has % reads matching %, expected %',r.sig,found,r.pattern,r.expected; END IF;
  -- One function can appear twice (two aliases); its later entry rewrites the already rewritten definition.
  EXECUTE regexp_replace(def,r.pattern,'\1app.label_import_marker_visible('||r.alias||'.import_pending_attempt_id) AND ','g');
 END LOOP;
END $$;
--> statement-breakpoint
-- Row-security readers. app.reward_setup_grade_choices() (ai_hr_reward_setup_reader, 2205) and
-- app.reward_uploaded_validation(uuid) (ai_hr_reward_upload_reader, 2208) also enumerate grades, but they belong to
-- purpose roles the migration owner may not act as, so it cannot re-create them. Nor do they need the predicate: their
-- owners are neither the owner of job_grade nor BYPASSRLS, so job_grade_import_pending above already hides every
-- staged grade inside them (the grade choice list's live branch has always read job_grade that way). Refuse if that changes.
DO $label_import_rls_readers$
DECLARE f regprocedure;
BEGIN
 FOREACH f IN ARRAY ARRAY['app.reward_setup_grade_choices()','app.reward_uploaded_validation(uuid)']::regprocedure[] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid=p.proowner
    WHERE p.oid=f AND p.prosecdef AND NOT o.rolsuper AND NOT o.rolbypassrls
     AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid='public.job_grade'::regclass
      AND (NOT c.relrowsecurity OR pg_catalog.pg_has_role(p.proowner,c.relowner,'USAGE')
       OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy pol WHERE pol.polrelid=c.oid AND NOT pol.polpermissive
        AND pol.polcmd='*' AND pol.polroles='{0}' AND pol.polname='job_grade_import_pending')))) THEN
   RAISE EXCEPTION 'label import: % must read job_grade under the staged-row policy',f USING ERRCODE='42501';
  END IF;
 END LOOP;
END $label_import_rls_readers$;
--> statement-breakpoint
-- Release-time conflicts: a visible code that appeared while the import was staged and that the import's own rules
-- (the preview's) would have refused. The ordinary writers that ran meanwhile could not see the staged codes; unique
-- indexes caught most collisions physically, these are the rest. Definer: must see every row of the tenant.
CREATE FUNCTION app.system_label_import_conflicts(p_attempt uuid) RETURNS TABLE(kind text,code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH t AS (SELECT app.current_tenant_id() AS id WHERE app.principal_snapshot_current())
 SELECT 'department',s.name FROM public.department s,t WHERE s.tenant_id=t.id AND s.import_pending_attempt_id=p_attempt AND EXISTS(
  SELECT 1 FROM public.department v WHERE v.tenant_id=t.id AND v.id<>s.id AND v.import_pending_attempt_id IS DISTINCT FROM p_attempt
   AND app.label_import_marker_visible(v.import_pending_attempt_id) AND lower(trim(v.name))=lower(trim(s.name)))
 UNION ALL
 SELECT 'position',s.title FROM public.position s,t WHERE s.tenant_id=t.id AND s.import_pending_attempt_id=p_attempt AND EXISTS(
  SELECT 1 FROM public.position v WHERE v.tenant_id=t.id AND v.id<>s.id AND v.import_pending_attempt_id IS DISTINCT FROM p_attempt
   AND app.label_import_marker_visible(v.import_pending_attempt_id) AND lower(trim(v.title))=lower(trim(s.title)))
 UNION ALL
 SELECT 'cost_center',s.code FROM public.cost_center s,t WHERE s.tenant_id=t.id AND s.import_pending_attempt_id=p_attempt AND EXISTS(
  SELECT 1 FROM public.cost_center v WHERE v.tenant_id=t.id AND v.id<>s.id AND v.import_pending_attempt_id IS DISTINCT FROM p_attempt
   AND app.label_import_marker_visible(v.import_pending_attempt_id) AND lower(trim(v.code))=lower(trim(s.code)))
 UNION ALL
 SELECT 'business_unit',s.code FROM public.business_unit s,t WHERE s.tenant_id=t.id AND s.import_pending_attempt_id=p_attempt AND EXISTS(
  SELECT 1 FROM public.business_unit v WHERE v.tenant_id=t.id AND v.id<>s.id AND v.import_pending_attempt_id IS DISTINCT FROM p_attempt
   AND app.label_import_marker_visible(v.import_pending_attempt_id) AND lower(trim(v.code))=lower(trim(s.code)))
 UNION ALL
 SELECT s.category,s.value FROM public.profile_option s,t WHERE s.tenant_id=t.id AND s.import_pending_attempt_id=p_attempt AND EXISTS(
  SELECT 1 FROM public.profile_option v WHERE v.tenant_id=t.id AND v.id<>s.id AND v.import_pending_attempt_id IS DISTINCT FROM p_attempt
   AND app.label_import_marker_visible(v.import_pending_attempt_id) AND v.category=s.category AND v.value=s.value)
 UNION ALL
 SELECT 'grades',s.code FROM public.job_grade s,t WHERE s.tenant_id=t.id AND s.import_pending_attempt_id=p_attempt AND EXISTS(
  SELECT 1 FROM public.job_grade v WHERE v.tenant_id=t.id AND v.id<>s.id AND v.import_pending_attempt_id IS DISTINCT FROM p_attempt
   AND app.label_import_marker_visible(v.import_pending_attempt_id)
   AND (v.code=s.code OR (v.archived_at IS NULL AND lower(v.name)=lower(s.name))))
 UNION ALL
 SELECT 'grade_groups',s.name FROM public.grade_group s,t WHERE s.tenant_id=t.id AND s.import_pending_attempt_id=p_attempt AND (EXISTS(
  SELECT 1 FROM public.grade_group v WHERE v.tenant_id=t.id AND v.id<>s.id AND v.import_pending_attempt_id IS DISTINCT FROM p_attempt
   AND app.label_import_marker_visible(v.import_pending_attempt_id) AND lower(v.name)=lower(s.name))
  -- Every member grade must still be an active grade (the preview refused groups of inactive grades).
  OR EXISTS(SELECT 1 FROM public.grade_group_member m JOIN public.job_grade g ON g.id=m.grade_id AND g.tenant_id=m.tenant_id
   WHERE m.grade_group_id=s.id AND m.tenant_id=t.id AND g.archived_at IS NOT NULL));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.system_label_import_conflicts(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.system_label_import_conflicts(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Release (the visibility flip): one row, under the initiating administrator's freshly checked authority over every
-- staged code. The caller holds the same writer locks as the chunks and has checked conflicts in this transaction.
-- Caches keyed on the company-organisation epoch are invalidated once here, as the inserts' own triggers did.
CREATE FUNCTION app.system_label_import_release_attempt(p_attempt uuid,p_job uuid) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); u uuid:=app.current_user_id(); staged bigint;
BEGIN
 IF t IS NULL OR u IS NULL OR p_attempt IS NULL OR p_job IS NULL THEN RAISE EXCEPTION 'system_label_import_release_invalid' USING ERRCODE='22023'; END IF;
 IF NOT app.principal_snapshot_current() OR NOT app.is_admin()
  OR NOT EXISTS(SELECT 1 FROM public.bulk_job j WHERE j.id=p_job AND j.tenant_id=t AND j.created_by=u AND j.kind='system_label_import' AND j.plan->>'attemptId'=p_attempt::text) THEN
  RAISE EXCEPTION 'system_label_import_release_unavailable' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM app.system_label_import_release r WHERE r.attempt_id=p_attempt) THEN RAISE EXCEPTION 'system_label_import_release_repeated' USING ERRCODE='55000'; END IF;
 -- The administrator must still administer every code's creation company (global codes: a group administrator)
 -- and every flat code's company scope, exactly as the writers required when each code was staged.
 IF EXISTS(SELECT 1 FROM (
   SELECT company_id,is_global FROM public.department WHERE tenant_id=t AND import_pending_attempt_id=p_attempt
   UNION ALL SELECT company_id,is_global FROM public.position WHERE tenant_id=t AND import_pending_attempt_id=p_attempt
   UNION ALL SELECT company_id,is_global FROM public.cost_center WHERE tenant_id=t AND import_pending_attempt_id=p_attempt
   UNION ALL SELECT company_id,is_global FROM public.business_unit WHERE tenant_id=t AND import_pending_attempt_id=p_attempt) o
  WHERE NOT app.is_admin_for(o.company_id) OR (o.is_global AND NOT app.is_group_admin()))
 OR EXISTS(SELECT 1 FROM (
   SELECT scope_company_ids FROM public.profile_option WHERE tenant_id=t AND import_pending_attempt_id=p_attempt
   UNION ALL SELECT scope_company_ids FROM public.job_grade WHERE tenant_id=t AND import_pending_attempt_id=p_attempt
   UNION ALL SELECT scope_company_ids FROM public.grade_group WHERE tenant_id=t AND import_pending_attempt_id=p_attempt) f
  WHERE NOT app.system_label_scope_admin(f.scope_company_ids)) THEN
  RAISE EXCEPTION 'system_label_import_release_forbidden' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM app.system_label_import_conflicts(p_attempt)) THEN RAISE EXCEPTION 'system_label_import_release_conflict' USING ERRCODE='23505'; END IF;
 SELECT (SELECT count(*) FROM public.department WHERE tenant_id=t AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.position WHERE tenant_id=t AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.cost_center WHERE tenant_id=t AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.business_unit WHERE tenant_id=t AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.profile_option WHERE tenant_id=t AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.job_grade WHERE tenant_id=t AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.grade_group WHERE tenant_id=t AND import_pending_attempt_id=p_attempt) INTO staged;
 INSERT INTO app.system_label_import_release(attempt_id,tenant_id,job_id,created_by,outcome) VALUES(p_attempt,t,p_job,u,'activated');
 INSERT INTO public.company_organisation_source_epoch(tenant_id,revision) VALUES(t,1)
  ON CONFLICT(tenant_id) DO UPDATE SET revision=company_organisation_source_epoch.revision+1;
 RETURN staged;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.system_label_import_release_attempt(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.system_label_import_release_attempt(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Discard in bounded batches on the worker's queue-owner connection: delete up to p_limit staged rows per table,
-- children first (memberships, criteria), then the codes; the ordinary delete triggers run (criteria cleanup and
-- locks, epochs). The last call records the attempt as discarded: its chunk events stay hidden for good, and a
-- revoked initiator can never leave staged rows behind. Returns how many staged rows remain.
CREATE FUNCTION app.system_label_import_discard_batch(p_tenant uuid,p_attempt uuid,p_job uuid,p_actor uuid,p_limit integer) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE remaining bigint;
BEGIN
 IF p_tenant IS NULL OR p_attempt IS NULL OR p_job IS NULL OR p_actor IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'system_label_import_discard_invalid' USING ERRCODE='22023';
 END IF;
 IF NOT app.access_workforce_storage_owner() THEN RAISE EXCEPTION 'system_label_import_discard_forbidden' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM app.system_label_import_release r WHERE r.attempt_id=p_attempt AND r.outcome='activated') THEN
  RAISE EXCEPTION 'system_label_import_discard_released' USING ERRCODE='55000';
 END IF;
 DELETE FROM public.grade_group_member WHERE id IN (SELECT id FROM public.grade_group_member WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt ORDER BY id LIMIT p_limit);
 DELETE FROM public.grade_group WHERE id IN (SELECT g.id FROM public.grade_group g WHERE g.tenant_id=p_tenant AND g.import_pending_attempt_id=p_attempt
  AND NOT EXISTS(SELECT 1 FROM public.grade_group_member m WHERE m.grade_group_id=g.id) ORDER BY g.id LIMIT p_limit);
 DELETE FROM public.job_grade WHERE id IN (SELECT id FROM public.job_grade WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt ORDER BY id LIMIT p_limit);
 DELETE FROM public.profile_option WHERE id IN (SELECT id FROM public.profile_option WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt ORDER BY id LIMIT p_limit);
 DELETE FROM public.label_company_assignment WHERE id IN (SELECT id FROM public.label_company_assignment WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt ORDER BY id LIMIT p_limit);
 DELETE FROM public.department WHERE id IN (SELECT id FROM public.department WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt ORDER BY id LIMIT p_limit);
 DELETE FROM public.position WHERE id IN (SELECT id FROM public.position WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt ORDER BY id LIMIT p_limit);
 DELETE FROM public.cost_center WHERE id IN (SELECT id FROM public.cost_center WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt ORDER BY id LIMIT p_limit);
 DELETE FROM public.business_unit WHERE id IN (SELECT id FROM public.business_unit WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt ORDER BY id LIMIT p_limit);
 SELECT (SELECT count(*) FROM public.grade_group_member WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.grade_group WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.job_grade WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.profile_option WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.label_company_assignment WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.department WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.position WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.cost_center WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.business_unit WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt) INTO remaining;
 IF remaining=0 THEN
  INSERT INTO app.system_label_import_release(attempt_id,tenant_id,job_id,created_by,outcome) VALUES(p_attempt,p_tenant,p_job,p_actor,'discarded') ON CONFLICT(attempt_id) DO NOTHING;
 END IF;
 RETURN remaining;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.system_label_import_discard_batch(uuid,uuid,uuid,uuid,integer) FROM PUBLIC,ai_hr_app;

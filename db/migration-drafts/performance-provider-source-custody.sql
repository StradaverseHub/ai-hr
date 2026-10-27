-- UNALLOCATED / UNJOURNALED / UNAPPLIED. Coordinate allocation before any application/exposure.
-- Finite native source footprint for standard/OneHR provider admission, not universal HR-writer protection.
-- Access ownership precedes reader custody; custody precedes the actual fresh native projections.
-- Readers retain shared tenant custody through ai_admit COMMIT, never through external transport.
-- Actual native DML (including hidden->visible UPDATE and INSERT/DELETE phantoms) takes exclusive
-- TRY custody in BEFORE triggers. Busy means WHOLE caller transaction rollback; no hidden retries.
-- Writers can already hold native rows: they MUST NOT wait for custody or introduce a reverse wait.
-- A shared global key separates ordinary tenant DML from privileged TRUNCATE, without serializing
-- independent tenants. No table lock, new row grants, definer data projection or payroll logic added.
CREATE FUNCTION app.performance_provider_source_read_hold_v1() RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();
BEGIN
 IF tid IS NULL OR uid IS NULL OR current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Current Performance source could not be confirmed' USING ERRCODE='42501';
 END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtext('performance-provider-source-global-v1'),0) THEN
  RAISE EXCEPTION 'Performance source is busy' USING ERRCODE='55P03';
 END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtext('performance-provider-source-tenant-v1'),hashtext(tid::text)) THEN
  RAISE EXCEPTION 'Performance source is busy' USING ERRCODE='55P03';
 END IF;
 -- Recheck the actual login AFTER ownership. This is still no subject/role/data grant: every
 -- canonical supplied-Tx owner must freshly enforce its own RLS, assignment and field projection.
 IF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.tenant_id=tid AND u.id=uid
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) OR app.principal_snapshot_current() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Current Performance source could not be confirmed' USING ERRCODE='42501';
 END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.performance_provider_source_read_hold_v1() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.performance_provider_source_read_hold_v1() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.performance_provider_source_write_guard_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tid uuid;subjects uuid[];
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF NOT pg_try_advisory_xact_lock(hashtext('performance-provider-source-global-v1'),0) THEN
   RAISE EXCEPTION 'Performance source is busy' USING ERRCODE='55P03';
  END IF;
  RETURN NULL;
 END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtext('performance-provider-source-global-v1'),0) THEN
  RAISE EXCEPTION 'Performance source is busy' USING ERRCODE='55P03';
 END IF;
 subjects:=CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.tenant_id] WHEN 'DELETE' THEN ARRAY[OLD.tenant_id]
   ELSE ARRAY[OLD.tenant_id,NEW.tenant_id] END;
 FOR tid IN SELECT DISTINCT id FROM unnest(subjects) ids(id) WHERE id IS NOT NULL ORDER BY id LOOP
  IF NOT pg_try_advisory_xact_lock(hashtext('performance-provider-source-tenant-v1'),hashtext(tid::text)) THEN
   RAISE EXCEPTION 'Performance source is busy' USING ERRCODE='55P03';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.performance_provider_source_write_guard_v1() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Explicit reviewed footprint. Installation must fail if a named relation/tenant column is absent;
-- never silently skip a missing owner and pretend it participates. Cross-tenant moves protect both
-- actual OLD/NEW tenant IDs. Foreign-key cascades and definer mutations fire the same native guards.
DO $$
DECLARE relation_name text;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY[
  'app_user','role_assignment','person','employment','assignment','reporting_line','company','department','position','job_grade',
  'review_cycle','performance_review','review_goal','performance_goal','peer_feedback','peer_feedback_request','performance_attachment',
  'performance_onehr_cycle','performance_assessment_participation',
  'performance_onehr_review','performance_onehr_panel','performance_assessment_profit_achievement',
  'performance_onehr_calibration','performance_onehr_calibration_entry','performance_assessment_talent_remark',
  'performance_onehr_plan','performance_onehr_evidence','performance_onehr_result','performance_assessment_release',
  'performance_assessment_rating_record','performance_assessment_draft',
  'performance_assessment_ai_use','performance_calibration_conversation','performance_assessment_file_text',
  'performance_assessment_insight','performance_assessment_summary','performance_assessment_reviewer_remark',
  'performance_kpi_library','performance_assessment_attachment_link','performance_assessment_talent',
  'performance_assessment_talent_history','performance_assessment_career_profile','kb_document'
 ] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=format('public.%I',relation_name)::regclass
    AND attname='tenant_id' AND NOT attisdropped) THEN RAISE EXCEPTION 'Missing Performance source tenant binding';END IF;
  EXECUTE format('CREATE TRIGGER performance_provider_source_row_v1 BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.performance_provider_source_write_guard_v1()',relation_name);
  EXECUTE format('CREATE TRIGGER performance_provider_source_truncate_v1 BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.performance_provider_source_write_guard_v1()',relation_name);
 END LOOP;
END $$;

-- UNAPPLIED PROVISIONAL DEVELOPMENT: coordinator allocation idx713/when1793330000070.
-- Mounted System Labels source proof only in this checkpoint. Custody integration follows here
-- before acceptance; no new table, raw domain_event grant or employee impersonation.
CREATE FUNCTION app.position_archive_grid_source(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.position;result jsonb;
BEGIN
 IF app.current_user_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE OR app.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM public.position WHERE id=p_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR app.is_admin_for(p.company_id) IS NOT TRUE OR p.is_global OR EXISTS(SELECT 1 FROM public.label_company_assignment a WHERE a.tenant_id=p.tenant_id AND a.label_kind='position' AND a.label_id=p.id AND a.company_id<>p.company_id) THEN RAISE EXCEPTION 'Position review unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('positionId',q.id,'companyId',q.company_id,'title',q.title,'archived',q.archived_at IS NOT NULL,
 'inUse',EXISTS(SELECT 1 FROM public.assignment a WHERE a.tenant_id=q.tenant_id AND a.position_id=q.id AND a.superseded_at IS NULL),
 'fields',jsonb_build_object('title',q.title,'jobFamily',q.job_family,'label',q.label,'description',q.description,'isGlobal',q.is_global,'companyId',q.company_id),
 'revision',q.xmin::text,'companyRevision',c.xmin::text,
 'criteria',coalesce((SELECT jsonb_agg(jsonb_build_object('companyId',a.company_id,'revision',a.xmin::text) ORDER BY a.company_id) FROM public.label_company_assignment a WHERE a.tenant_id=q.tenant_id AND a.label_kind='position' AND a.label_id=q.id),'[]'::jsonb),
 'epoch',coalesce((SELECT e.revision::text FROM public.system_label_criteria_epoch e WHERE e.tenant_id=q.tenant_id AND e.label_kind='position'),'0'),
 'authority',jsonb_build_object('configuration',(SELECT a.revision FROM public.access_configuration a WHERE a.tenant_id=q.tenant_id),'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.role,g.company_id) FROM app.current_grants() g))) INTO result
 FROM public.position q JOIN public.company c ON c.id=q.company_id AND c.tenant_id=q.tenant_id WHERE q.id=p.id AND q.tenant_id=p.tenant_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.position_archive_grid_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.position_archive_grid_source(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.position_archive_grid_current_event(p_id uuid,p_archived boolean) RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;proof uuid;matches integer;
BEGIN
 source:=app.position_archive_grid_source(p_id);
 SELECT count(*),min(d.id::text)::uuid INTO matches,proof FROM public.domain_event d JOIN public.position p ON p.id=d.aggregate_id AND p.tenant_id=d.tenant_id
 WHERE p.id=p_id AND p.tenant_id=app.current_tenant_id() AND (p.archived_at IS NOT NULL)=p_archived
 AND p.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid
 AND d.aggregate_type='position' AND d.event_type='position.updated' AND d.actor_type='user' AND d.actor_id=app.current_user_id() AND d.subject_employment_id IS NULL
 AND d.payload=jsonb_build_object('title',p.title,'archived',p_archived);
 IF matches<>1 THEN RAISE EXCEPTION 'Position event unavailable' USING ERRCODE='42501';END IF;
 RETURN proof;
END $$;
REVOKE ALL ON FUNCTION app.position_archive_grid_current_event(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.position_archive_grid_current_event(uuid,boolean) TO ai_hr_app;

-- UNALLOCATED / UNJOURNALLED / UNAPPLIED. Source-owned metadata reader for a human's exact current
-- Testing observation. No narrative, draft, staff identity or independent verification claim.
-- Ordinary assigned testers can read their own canonical run but not its NULL-subject domain event;
-- this bounded helper proves that exact native event without granting event/table/HR read access.
CREATE FUNCTION app.testing_own_execution_event_source(p_run_id uuid,p_event_id uuid)
RETURNS TABLE(case_id uuid,assignment_id uuid,execution_id uuid,version_id uuid,run_id uuid,event_id uuid,
 execution_revision integer,execution_status text,content_hash text,source_content_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT c.id,a.id,e.id,v.id,r.id,ev.id,e.revision,r.execution_status,v.content_hash,v.source_content_hash
 FROM public.test_run r
 JOIN public.test_execution e ON e.id=r.execution_id AND e.tenant_id=r.tenant_id
 JOIN public.test_assignment a ON a.id=e.assignment_id AND a.tenant_id=e.tenant_id
 JOIN public.test_case c ON c.id=a.test_case_id AND c.tenant_id=a.tenant_id AND c.id=r.test_case_id
 JOIN public.test_case_version v ON v.id=c.current_version_id AND v.test_case_id=c.id AND v.tenant_id=c.tenant_id
 JOIN public.domain_event ev ON ev.id=p_event_id AND ev.tenant_id=r.tenant_id
 WHERE app.testing_live_principal() AND r.id=p_run_id AND r.tenant_id=app.current_tenant_id()
  AND a.active AND a.tester_user_id=app.current_user_id() AND e.tester_user_id=app.current_user_id()
  AND r.run_by_user_id=app.current_user_id() AND a.target_version_id=v.id AND e.version_id=v.id AND r.version_id=v.id
  AND e.current_run_id=r.id AND e.revision=r.execution_revision AND e.revision>0
  AND NOT EXISTS(SELECT 1 FROM public.test_execution later WHERE later.assignment_id=a.id AND later.tenant_id=a.tenant_id AND later.version_id=v.id AND later.attempt_no>e.attempt_no)
  AND (v.definition->>'format'='0' OR v.definition->>'format'='1' AND v.definition->'active'='true'::jsonb)
  AND ev.actor_type='user' AND ev.actor_id=app.current_user_id() AND ev.aggregate_type='test_case' AND ev.aggregate_id=c.id
  AND ev.event_type='test_execution.observation_saved' AND ev.subject_employment_id IS NULL AND ev.occurred_at=r.run_at
  AND ev.payload=jsonb_build_object('executionId',e.id,'runId',r.id,'versionId',v.id,'revision',r.execution_revision,'status',r.execution_status,'testerUserId',app.current_user_id())
$$;
REVOKE ALL ON FUNCTION app.testing_own_execution_event_source(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.testing_own_execution_event_source(uuid,uuid) TO ai_hr_app;
COMMENT ON FUNCTION app.testing_own_execution_event_source(uuid,uuid) IS 'Own current assigned Testing run and exact original-actor event metadata only; human report is not independently verified coverage.';

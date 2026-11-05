-- Own-position publication only. This role cannot read other drafts, employees or documents.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_job_profile_reader') THEN CREATE ROLE ai_hr_job_profile_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_job_profile_reader' AND (rolcanlogin OR rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe job profile reader'; END IF;
END $$;
GRANT USAGE ON SCHEMA public,app TO ai_hr_job_profile_reader;
GRANT SELECT ON employment,assignment,job_architecture_position_revision,job_architecture_jd_publication_history,job_document_revision,job_document TO ai_hr_job_profile_reader;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(),app.current_user_id(),app.is_self_person(uuid),app.principal_snapshot_current() TO ai_hr_job_profile_reader;
CREATE POLICY architecture_profile_employment ON employment FOR SELECT TO ai_hr_job_profile_reader USING(tenant_id=app.current_tenant_id() AND app.is_self_person(person_id));
CREATE POLICY architecture_profile_assignment ON assignment FOR SELECT TO ai_hr_job_profile_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM employment e WHERE e.id=assignment.employment_id AND e.tenant_id=assignment.tenant_id AND app.is_self_person(e.person_id)));
CREATE POLICY architecture_profile_mapping ON job_architecture_position_revision FOR SELECT TO ai_hr_job_profile_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM employment e JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id WHERE e.tenant_id=job_architecture_position_revision.tenant_id AND e.company_id=job_architecture_position_revision.company_id AND a.position_id=job_architecture_position_revision.position_id AND app.is_self_person(e.person_id) AND a.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (a.valid_to IS NULL OR a.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date)));
CREATE POLICY architecture_profile_publication ON job_architecture_jd_publication_history FOR SELECT TO ai_hr_job_profile_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM job_architecture_position_revision m WHERE m.tenant_id=job_architecture_jd_publication_history.tenant_id AND m.mapping->>'jobUnitId'=job_architecture_jd_publication_history.job_unit_id::text AND (job_architecture_jd_publication_history.variant_company_id IS NULL OR m.company_id=job_architecture_jd_publication_history.variant_company_id)));
CREATE POLICY architecture_profile_revision ON job_document_revision FOR SELECT TO ai_hr_job_profile_reader USING(tenant_id=app.current_tenant_id() AND status IN('approved','superseded') AND EXISTS(SELECT 1 FROM job_architecture_jd_publication_history p WHERE p.tenant_id=job_document_revision.tenant_id AND p.revision_id=job_document_revision.id));
CREATE POLICY architecture_profile_document ON job_document FOR SELECT TO ai_hr_job_profile_reader USING(tenant_id=app.current_tenant_id() AND NOT inactive AND EXISTS(SELECT 1 FROM job_architecture_jd_publication_history p WHERE p.tenant_id=job_document.tenant_id AND p.job_id=job_document.id));
CREATE FUNCTION app.own_job_architecture_description(p_employment uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE result jsonb;
BEGIN
 IF NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND app.is_self_person(e.person_id)) THEN RAISE EXCEPTION 'Own employment required' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('jobId',j.id,'revisionId',r.id,'title',r.title,'version',r.version,'orgLabels',r.org_labels,'answers',(select coalesce(jsonb_object_agg(s->>'id',r.answers->(s->>'id')),'{}'::jsonb) from jsonb_array_elements(r.definition->'sections') s where s->>'form' in('description','specification')),'definition',jsonb_set(r.definition,'{sections}',(select coalesce(jsonb_agg(s),'[]'::jsonb) from jsonb_array_elements(r.definition->'sections') s where s->>'form' in('description','specification'))),'architecture',r.architecture,'effectiveOn',r.effective_on)
 INTO result FROM employment e
 JOIN LATERAL(SELECT a.position_id FROM assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (a.valid_to IS NULL OR a.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date) ORDER BY a.valid_from DESC,a.id DESC LIMIT 1)a ON true
 JOIN LATERAL(SELECT m.mapping FROM job_architecture_position_revision m WHERE m.tenant_id=e.tenant_id AND m.company_id=e.company_id AND m.position_id=a.position_id ORDER BY m.revision DESC LIMIT 1)m ON true
 JOIN job_architecture_jd_publication_history p ON p.tenant_id=e.tenant_id AND p.job_unit_id::text=m.mapping->>'jobUnitId' AND (p.variant_company_id IS NULL OR p.variant_company_id=e.company_id)
 JOIN job_document j ON j.id=p.job_id AND j.tenant_id=p.tenant_id AND NOT j.inactive
 JOIN job_document_revision r ON r.id=p.revision_id AND r.tenant_id=p.tenant_id AND r.job_id=j.id AND r.status IN('approved','superseded') AND r.effective_on<=timezone('Asia/Kuala_Lumpur',now())::date
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND app.is_self_person(e.person_id)
 ORDER BY (p.variant_company_id IS NOT NULL) DESC,r.effective_on DESC,p.published_at DESC,p.id LIMIT 1;
 RETURN result;
END $$;
ALTER FUNCTION app.own_job_architecture_description(uuid) OWNER TO ai_hr_job_profile_reader;
REVOKE ALL ON FUNCTION app.own_job_architecture_description(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.own_job_architecture_description(uuid) TO ai_hr_app;

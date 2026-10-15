-- Queue scope is retained without an address/document; older audit-only rows keep an empty scope.
ALTER TABLE custom_report_occurrence ADD COLUMN frozen_scope_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];
ALTER TABLE custom_report_occurrence ADD CONSTRAINT custom_report_occurrence_scope_bound CHECK(cardinality(frozen_scope_ids)<=100 AND array_position(frozen_scope_ids,NULL) IS NULL);
--> statement-breakpoint
-- Private managed report delivery. Web requests carry only a durable occurrence and lease nonce.
-- All routines are owner/private-worker only unless the nonce-bound render context is explicitly granted.
CREATE FUNCTION identity_email.report_access_stamp(p_tenant uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'tenant',(SELECT jsonb_build_array(t.id,t.status,t.suspended_at,t.trial_ends_at,t.closed_at) FROM tenant t WHERE t.id=p_tenant),
  'roles',(SELECT coalesce(jsonb_agg(jsonb_build_array(g.id,g.app_user_id,g.role,g.company_id) ORDER BY g.id),'[]'::jsonb) FROM role_assignment g WHERE g.tenant_id=p_tenant),
  'permissions',(SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.id),'[]'::jsonb) FROM payroll_permission_grant g WHERE g.tenant_id=p_tenant),
  'modules',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM tenant_module m WHERE m.tenant_id=p_tenant),
  'settings',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.key),'[]'::jsonb) FROM tenant_setting s WHERE s.tenant_id=p_tenant),
  'companies',(SELECT coalesce(jsonb_agg(jsonb_build_array(c.id,c.country,c.statutory_tier,c.parent_company_id) ORDER BY c.id),'[]'::jsonb) FROM company c WHERE c.tenant_id=p_tenant),
  'employments',(SELECT coalesce(jsonb_agg(jsonb_build_array(e.id,e.person_id,e.company_id,e.hired_on,e.terminated_on,e.resignation_date,e.last_working_date,e.blacklisted_at) ORDER BY e.id),'[]'::jsonb) FROM employment e WHERE e.tenant_id=p_tenant),
  'assignments',(SELECT coalesce(jsonb_agg(jsonb_build_array(a.id,a.employment_id,a.company_id,a.department_id,a.valid_from,a.valid_to,a.superseded_at) ORDER BY a.id),'[]'::jsonb) FROM assignment a WHERE a.tenant_id=p_tenant),
  'departments',(SELECT coalesce(jsonb_agg(jsonb_build_array(d.id,d.company_id,d.parent_department_id) ORDER BY d.id),'[]'::jsonb) FROM department d WHERE d.tenant_id=p_tenant),
  'delegationScopes',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM reporting_line_scope s WHERE s.tenant_id=p_tenant),
  'lines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM reporting_line l WHERE l.tenant_id=p_tenant),
  'catalog',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.code),'[]'::jsonb) FROM module m),
  'defaults',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.key),'[]'::jsonb) FROM setting_definition s)
 )::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION identity_email.report_access_stamp(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION identity_email.report_target(p_id uuid,p_token uuid,p_issuer text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp
SET app.tenant_id='' SET app.user_id='' SET app.roles='' SET app.grants='[]' AS $$
DECLARE bound_tenant uuid;result jsonb;
BEGIN
 SELECT o.tenant_id INTO bound_tenant FROM custom_report_occurrence o
 WHERE o.id=p_id AND o.lease_token=p_token AND o.lease_until>now() AND o.status='pending' AND o.started_at IS NULL;
 IF bound_tenant IS NULL THEN RETURN NULL;END IF;
 PERFORM set_config('app.tenant_id',bound_tenant::text,true);
 SELECT jsonb_build_object(
  'tenantId',o.tenant_id,'ownerUserId',o.owner_user_id,'recipientUserId',o.recipient_user_id,'recipientEmploymentId',o.recipient_employment_id,
  'reportId',o.report_id,'reportVersion',o.report_version,'scheduleId',o.schedule_id,'scheduleRevision',o.schedule_revision,'reviewedDigest',o.reviewed_digest,
  'subject',i.subject,'email',p.primary_email,'locale',pref.email_locale,
  'consentAfterSequence',o.consent_after_sequence,'policyAfterSequence',o.policy_after_sequence,
  'consentUpdatedAt',to_char(o.consent_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'policyUpdatedAt',to_char(o.policy_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'consentVerifiedAt',to_char(o.consent_verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'ownerGrants',op.grants,'recipientGrants',rp.grants,'ownerPersonId',op.person_id,'recipientPersonId',rp.person_id,
  'accessStamp',identity_email.report_access_stamp(bound_tenant),
  'companyIds',to_jsonb(o.frozen_scope_ids)
 ) INTO result
 FROM custom_report_occurrence o JOIN custom_report_schedule s ON s.id=o.schedule_id AND s.tenant_id=o.tenant_id
 JOIN custom_report r ON r.id=o.report_id AND r.id=s.report_id AND r.tenant_id=o.tenant_id AND r.created_by_user_id=o.owner_user_id
 JOIN app_user owner_login ON owner_login.id=o.owner_user_id AND owner_login.tenant_id=o.tenant_id
 JOIN app_user recipient_login ON recipient_login.id=o.recipient_user_id AND recipient_login.tenant_id=o.tenant_id
 JOIN LATERAL app.principal(o.owner_user_id) op ON op.tenant_id=o.tenant_id
 JOIN LATERAL app.principal(o.recipient_user_id) rp ON rp.tenant_id=o.tenant_id
 JOIN employment e ON e.id=o.recipient_employment_id AND e.tenant_id=o.tenant_id AND e.person_id=recipient_login.person_id AND e.person_id=rp.person_id
 JOIN person p ON p.id=e.person_id AND p.tenant_id=o.tenant_id
 JOIN notification_pref pref ON pref.tenant_id=o.tenant_id AND pref.recipient_employment_id=e.id AND pref.category='employee_master_reports' AND pref.channel='email' AND pref.enabled AND pref.email_consent_user_id=o.recipient_user_id
 JOIN notification_email_policy policy ON policy.tenant_id=o.tenant_id AND policy.category='employee_master_reports' AND policy.enabled
 JOIN app_external_identity i ON i.app_user_id=o.recipient_user_id AND i.issuer=pref.report_consent_issuer AND i.subject=pref.report_consent_subject AND i.revoked_at IS NULL
 WHERE o.id=p_id AND o.lease_token=p_token AND o.lease_until>now() AND o.status='pending' AND o.started_at IS NULL
 AND cardinality(o.frozen_scope_ids)>0 AND to_jsonb(o.frozen_scope_ids)=r.spec->'employeeMaster'->'companyIds'
 AND s.enabled AND s.report_version=o.report_version AND s.reviewed_revision=o.schedule_revision AND s.reviewed_digest=o.reviewed_digest AND r.version=o.report_version AND r.dataset_id='master' AND r.spec ? 'employeeMaster'
 AND s.recipients @> jsonb_build_array(jsonb_build_object('userId',o.recipient_user_id,'employmentId',o.recipient_employment_id))
 AND (o.recipient_user_id=o.owner_user_id OR r.shared AND r.shared_role_ids && ARRAY(SELECT g->>'role' FROM jsonb_array_elements(rp.grants) g))
 AND owner_login.archived_at IS NULL AND recipient_login.archived_at IS NULL AND NOT app.login_blocked(o.owner_user_id) AND NOT app.login_blocked(o.recipient_user_id)
 AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date<LEAST(e.resignation_date,e.last_working_date,e.terminated_on))
 AND i.issuer=p_issuer AND pref.report_consent_address_hash=encode(sha256(convert_to(lower(p.primary_email),'UTF8')),'hex')
 AND pref.email_after_sequence=o.consent_after_sequence AND policy.after_sequence=o.policy_after_sequence
 AND pref.updated_at=o.consent_updated_at AND policy.updated_at=o.policy_updated_at AND pref.report_consent_verified_at=o.consent_verified_at;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION identity_email.report_target(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Only nonce holders can resolve render authority. No email, provider subject, password or document is returned.
CREATE FUNCTION app.employee_master_render_context(p_id uuid,p_token uuid,p_issuer text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT identity_email.report_target(p_id,p_token,p_issuer)-ARRAY['email','subject']
$$;
REVOKE ALL ON FUNCTION app.employee_master_render_context(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.employee_master_render_context(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION identity_email.start_report(p_id uuid,p_token uuid,p_issuer text,p_target jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fresh jsonb;
BEGIN
 PERFORM 1 FROM custom_report_occurrence o WHERE o.id=p_id FOR UPDATE;
 fresh:=identity_email.report_target(p_id,p_token,p_issuer);
 IF fresh IS NULL OR fresh IS DISTINCT FROM p_target THEN RETURN false;END IF;
 UPDATE custom_report_occurrence SET status='started',started_at=now(),lease_until=now()+interval '180 seconds'
 WHERE id=p_id AND lease_token=p_token AND status='pending' AND started_at IS NULL AND lease_until>now();
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION identity_email.start_report(uuid,uuid,text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION identity_email.finish_report(p_id uuid,p_token uuid,p_status text,p_reason text,p_rows integer DEFAULT NULL,p_scope uuid[] DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job custom_report_occurrence;
BEGIN
 IF p_status IS NULL OR p_status NOT IN ('sent','failed','skipped','uncertain') OR (p_reason IS NOT NULL AND p_reason NOT IN ('notEligible','recipientChanged','generationFailed','attachmentTooLarge','smtpRejected','smtpUnavailable','uncertain'))
 OR p_status='sent' AND p_reason IS NOT NULL OR p_status<>'sent' AND p_reason IS NULL OR p_status='uncertain' AND p_reason<>'uncertain'
 OR p_rows IS NOT NULL AND (p_rows<0 OR p_rows>50000) OR cardinality(p_scope)>100 THEN RAISE EXCEPTION 'Invalid report delivery outcome';END IF;
 SELECT * INTO job FROM custom_report_occurrence o WHERE o.id=p_id AND o.lease_token=p_token AND o.status IN ('pending','started') FOR UPDATE;
 IF NOT FOUND OR p_status='sent' AND (p_rows IS NULL OR p_scope IS NULL OR ARRAY(SELECT id FROM unnest(p_scope) id ORDER BY id) IS DISTINCT FROM ARRAY(SELECT id FROM unnest(job.frozen_scope_ids) id ORDER BY id)) OR p_status IN ('sent','uncertain') AND job.status<>'started' OR p_status='skipped' AND job.status<>'pending' THEN RETURN false;END IF;
 UPDATE custom_report_occurrence SET status=p_status,reason=p_reason,row_count=p_rows,finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=p_id;
 INSERT INTO custom_report_run(tenant_id,report_id,actor_user_id,report_version,kind,format,scope_ids,row_count,outcome,reason)
 VALUES(job.tenant_id,job.report_id,job.recipient_user_id,job.report_version,'delivery','xlsx',coalesce(p_scope,ARRAY[]::uuid[]),coalesce(p_rows,0),CASE WHEN p_status='sent' THEN 'success' WHEN p_status='skipped' THEN 'skipped' ELSE 'failed' END,p_reason);
 IF p_status='sent' THEN UPDATE custom_report SET last_run_at=now() WHERE id=job.report_id AND tenant_id=job.tenant_id AND version=job.report_version;END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION identity_email.finish_report(uuid,uuid,text,text,integer,uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Owner-only enqueue. No application role may manufacture a lease or choose a recipient target.
CREATE FUNCTION identity_email.queue_report(p_schedule uuid,p_scheduled timestamptz,p_next timestamptz) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE schedule custom_report_schedule;report custom_report;pair jsonb;pref notification_pref;policy notification_email_policy;added integer:=0;inserted integer;eligible integer:=0;
BEGIN
 SELECT * INTO schedule FROM custom_report_schedule s WHERE s.id=p_schedule AND s.enabled AND s.next_run_at=p_scheduled AND s.next_run_at<=now() FOR UPDATE;
 IF NOT FOUND THEN RETURN 0;END IF;
 IF p_next IS NULL OR p_next<=now() OR p_next<=p_scheduled THEN RAISE EXCEPTION 'Invalid next report date';END IF;
 SELECT * INTO report FROM custom_report r WHERE r.id=schedule.report_id AND r.tenant_id=schedule.tenant_id AND r.version=schedule.report_version AND r.dataset_id='master' AND r.spec ? 'employeeMaster' AND r.created_by_user_id IS NOT NULL AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=r.created_by_user_id AND u.tenant_id=r.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id));
 IF NOT FOUND THEN UPDATE custom_report_schedule SET enabled=false,updated_at=now() WHERE id=schedule.id;RETURN 0;END IF;
 SELECT * INTO policy FROM notification_email_policy p WHERE p.tenant_id=schedule.tenant_id AND p.category='employee_master_reports' AND p.enabled AND p.updated_at<=p_scheduled;
 IF FOUND THEN
  FOR pair IN SELECT value FROM jsonb_array_elements(schedule.recipients) LOOP
   SELECT p.* INTO pref FROM notification_pref p JOIN employment e ON e.id=p.recipient_employment_id AND e.tenant_id=p.tenant_id
   JOIN app_user u ON u.id=p.email_consent_user_id AND u.person_id=e.person_id AND u.tenant_id=e.tenant_id
   WHERE p.tenant_id=schedule.tenant_id AND p.recipient_employment_id=(pair->>'employmentId')::uuid AND p.email_consent_user_id=(pair->>'userId')::uuid
   AND p.category='employee_master_reports' AND p.channel='email' AND p.enabled AND p.email_after_sequence IS NOT NULL AND p.report_consent_verified_at IS NOT NULL
   AND p.updated_at<=p_scheduled AND p.report_consent_verified_at<=p_scheduled AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
   IF NOT FOUND THEN CONTINUE;END IF;eligible:=eligible+1;
   INSERT INTO custom_report_occurrence(tenant_id,frozen_scope_ids,schedule_id,report_id,schedule_revision,reviewed_digest,owner_user_id,recipient_user_id,recipient_employment_id,scheduled_for,report_version,consent_after_sequence,policy_after_sequence,consent_updated_at,policy_updated_at,consent_verified_at)
   VALUES(schedule.tenant_id,ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(report.spec->'employeeMaster'->'companyIds')),schedule.id,report.id,schedule.reviewed_revision,schedule.reviewed_digest,report.created_by_user_id,(pair->>'userId')::uuid,(pair->>'employmentId')::uuid,p_scheduled,report.version,pref.email_after_sequence,policy.after_sequence,pref.updated_at,policy.updated_at,pref.report_consent_verified_at)
   ON CONFLICT(schedule_id,recipient_user_id,scheduled_for) DO NOTHING;
   GET DIAGNOSTICS inserted=ROW_COUNT;added:=added+inserted;
  END LOOP;
 END IF;
 IF eligible<jsonb_array_length(schedule.recipients) THEN
  INSERT INTO custom_report_run(tenant_id,report_id,actor_user_id,report_version,kind,format,scope_ids,row_count,outcome,reason)
  VALUES(schedule.tenant_id,report.id,report.created_by_user_id,report.version,'delivery','xlsx',ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(report.spec->'employeeMaster'->'companyIds')),0,'skipped','one-or-more-recipients-ineligible');
 END IF;
 UPDATE custom_report_schedule SET next_run_at=p_next,updated_at=now() WHERE id=schedule.id;
 RETURN added;
END $$;
REVOKE ALL ON FUNCTION identity_email.queue_report(uuid,timestamptz,timestamptz) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION identity_email.claim_reports(p_limit integer DEFAULT 10) RETURNS TABLE(id uuid,lease_token uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_limit<1 OR p_limit>50 THEN RAISE EXCEPTION 'Invalid report sweep limit';END IF;
 -- A started SMTP attempt can have been accepted. Its expired lease is terminal uncertainty.
 UPDATE custom_report_occurrence SET status='uncertain',reason='uncertain',finished_at=now(),lease_token=NULL,lease_until=NULL
 WHERE status='started' AND lease_until<now();
 RETURN QUERY WITH picked AS(SELECT o.id FROM custom_report_occurrence o WHERE o.status='pending' AND o.started_at IS NULL AND (o.lease_until IS NULL OR o.lease_until<now()) ORDER BY o.scheduled_for,o.id LIMIT p_limit FOR UPDATE SKIP LOCKED)
 UPDATE custom_report_occurrence o SET lease_token=gen_random_uuid(),lease_until=now()+interval '180 seconds' FROM picked WHERE o.id=picked.id RETURNING o.id,o.lease_token;
END $$;
REVOKE ALL ON FUNCTION identity_email.claim_reports(integer) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- An opaque permission-source stamp is never permission itself. Canonical field/category/RLS checks
-- run before this read; this wrapper independently binds real user grants and private report visibility.
CREATE FUNCTION app.employee_master_access_stamp(p_report uuid,p_companies uuid[]) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actual jsonb;supplied jsonb;actual_roles text[];
BEGIN
 SELECT p.grants INTO actual FROM app.principal(app.current_user_id()) p JOIN app_user u ON u.id=app.current_user_id()
 WHERE p.tenant_id=app.current_tenant_id() AND u.tenant_id=p.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF actual IS NULL OR p_companies IS NULL OR cardinality(p_companies) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Report context unavailable';END IF;
 SELECT coalesce(jsonb_agg(g ORDER BY g->>'role',g->>'companyId'),'[]'::jsonb) INTO actual FROM jsonb_array_elements(actual) g;
 SELECT coalesce(jsonb_agg(g ORDER BY g->>'role',g->>'companyId'),'[]'::jsonb) INTO supplied FROM jsonb_array_elements(coalesce(nullif(current_setting('app.grants',true),'')::jsonb,'[]'::jsonb)) g;
 SELECT array_agg(DISTINCT g->>'role' ORDER BY g->>'role') INTO actual_roles FROM jsonb_array_elements(actual) g;
 IF actual IS DISTINCT FROM supplied OR actual_roles IS DISTINCT FROM ARRAY(SELECT DISTINCT role FROM unnest(app.current_roles()) role ORDER BY role)
 OR EXISTS(SELECT 1 FROM unnest(p_companies) id WHERE NOT EXISTS(SELECT 1 FROM company c WHERE c.id=id AND c.tenant_id=app.current_tenant_id())) THEN RAISE EXCEPTION 'Report context unavailable';END IF;
 IF p_report IS NOT NULL AND NOT EXISTS(SELECT 1 FROM custom_report r WHERE r.id=p_report AND r.tenant_id=app.current_tenant_id() AND r.dataset_id='master'
 AND app.custom_report_visible(r.created_by_user_id,r.shared,r.shared_role_ids)) THEN RAISE EXCEPTION 'Report unavailable';END IF;
 RETURN encode(sha256(convert_to(jsonb_build_object('actor',app.current_user_id(),'report',p_report,'companies',ARRAY(SELECT DISTINCT id FROM unnest(p_companies) id ORDER BY id),'source',identity_email.report_access_stamp(app.current_tenant_id()))::text,'UTF8')),'hex');
END $$;
REVOKE ALL ON FUNCTION app.employee_master_access_stamp(uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.employee_master_access_stamp(uuid,uuid[]) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.custom_report_frozen_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.frozen_scope_ids IS DISTINCT FROM OLD.frozen_scope_ids THEN RAISE EXCEPTION 'Frozen delivery scope is immutable';END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.custom_report_frozen_scope_guard() FROM PUBLIC;
CREATE TRIGGER custom_report_frozen_scope_guard BEFORE UPDATE ON custom_report_occurrence FOR EACH ROW EXECUTE FUNCTION app.custom_report_frozen_scope_guard();

--> statement-breakpoint
-- Delivery history is readable through its existing RLS. A lease nonce is a private transport
-- capability, never audit content: table-wide SELECT from0546 must not disclose it to app sessions.
REVOKE SELECT ON custom_report_occurrence FROM ai_hr_app;
GRANT SELECT(id,tenant_id,schedule_id,report_id,schedule_revision,reviewed_digest,
 owner_user_id,recipient_user_id,recipient_employment_id,scheduled_for,report_version,
 consent_after_sequence,policy_after_sequence,consent_updated_at,policy_updated_at,consent_verified_at,
 status,started_at,finished_at,row_count,reason,created_at,frozen_scope_ids)
 ON custom_report_occurrence TO ai_hr_app;

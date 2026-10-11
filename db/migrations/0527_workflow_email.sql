-- ADR-0034 workflow email. Old preferences and deliveries are not treated as consent or replayed.
CREATE TABLE notification_email_policy (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 category text NOT NULL CHECK (category IN ('attendance','claims','delegation','leave','notice','offboarding','payroll','performance','profile','readiness','review','rewards','toil')), enabled boolean NOT NULL DEFAULT false,
 after_sequence bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,category)
);
--> statement-breakpoint
ALTER TABLE notification_email_policy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notification_email_policy_read ON notification_email_policy FOR SELECT USING (tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY notification_email_policy_write ON notification_email_policy FOR ALL
 USING (tenant_id=app.current_tenant_id() AND app.is_group_admin())
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.is_group_admin());
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON notification_email_policy TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE notification_pref ADD COLUMN email_consent_user_id uuid REFERENCES app_user(id),
 ADD COLUMN email_after_sequence bigint, ADD COLUMN email_locale text NOT NULL DEFAULT 'en';
--> statement-breakpoint
ALTER TABLE notification_delivery ADD COLUMN recipient_user_id uuid REFERENCES app_user(id),
 ADD COLUMN source_event_id uuid, ADD COLUMN kind text, ADD COLUMN category text,
 ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN lease_token uuid,
 ADD COLUMN lease_until timestamptz, ADD COLUMN started_at timestamptz;
--> statement-breakpoint
CREATE UNIQUE INDEX notification_email_event_user_uq ON notification_delivery(tenant_id,source_event_id,recipient_user_id,kind)
 WHERE channel='email' AND source_event_id IS NOT NULL AND recipient_user_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION app.notification_email_watermark() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT COALESCE(max(sequence),0) FROM domain_event WHERE tenant_id=app.current_tenant_id();
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.notification_email_watermark() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.notification_email_watermark() TO ai_hr_app;
--> statement-breakpoint
-- A recipient can read only its own preferences; the dispatcher gets a narrow enqueue operation instead.
CREATE FUNCTION app.notification_email_enqueue(p_notification uuid,p_category text,p_sequence bigint)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.is_admin() THEN RAISE EXCEPTION 'notification dispatcher required' USING ERRCODE='insufficient_privilege'; END IF;
 INSERT INTO notification_delivery(tenant_id,notification_id,channel,recipient_user_id,source_event_id,kind,category)
 SELECT n.tenant_id,n.id,'email',u.id,n.source_event_id,n.kind,p_category
 FROM notification n JOIN domain_event ev ON ev.id=n.source_event_id AND ev.tenant_id=n.tenant_id
 JOIN employment e ON e.id=n.recipient_employment_id AND e.tenant_id=n.tenant_id
 JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=n.tenant_id
 JOIN notification_pref pref ON pref.tenant_id=n.tenant_id AND pref.recipient_employment_id=e.id
   AND pref.category=p_category AND pref.channel='email' AND pref.enabled
   AND pref.email_consent_user_id=u.id AND pref.email_after_sequence IS NOT NULL AND ev.sequence>pref.email_after_sequence
 JOIN notification_email_policy policy ON policy.tenant_id=n.tenant_id AND policy.category=p_category
   AND policy.enabled AND ev.sequence>policy.after_sequence
 WHERE n.id=p_notification AND n.tenant_id=app.current_tenant_id() AND ev.sequence=p_sequence
 AND p_category IN ('attendance','claims','delegation','leave','notice','offboarding','payroll','performance','profile','readiness','review','rewards','toil') AND NOT app.login_blocked(u.id)
 AND EXISTS(SELECT 1 FROM app_external_identity i WHERE i.app_user_id=u.id AND i.revoked_at IS NULL)
 ON CONFLICT DO NOTHING;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.notification_email_enqueue(uuid,text,bigint) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.notification_email_enqueue(uuid,text,bigint) TO ai_hr_app;
--> statement-breakpoint
-- No arbitrary address is accepted. Consent binds to the exact verified principal and current profile.
CREATE FUNCTION app.notification_email_consent_identity(p_issuer text,p_subject text,p_employment uuid,p_email text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app_external_identity i JOIN app_user u ON u.id=i.app_user_id
 JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
 JOIN person p ON p.id=e.person_id AND p.tenant_id=u.tenant_id
 WHERE i.issuer=p_issuer AND i.subject=p_subject AND i.revoked_at IS NULL
 AND u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND e.id=p_employment
 AND lower(p.primary_email)=lower(p_email) AND NOT app.login_blocked(u.id));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.notification_email_consent_identity(text,text,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.notification_email_consent_identity(text,text,uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- The web dispatcher sees routing metadata only; notification title/body remain recipient-scoped.
CREATE FUNCTION app.notification_email_due(p_limit integer)
RETURNS TABLE(id uuid,recipient_employment_id uuid,source_event_id uuid,kind text,category text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.is_admin() THEN RAISE EXCEPTION 'notification dispatcher required' USING ERRCODE='insufficient_privilege'; END IF;
 UPDATE notification_delivery d SET status='failed',last_error='uncertain',lease_token=NULL,lease_until=NULL,updated_at=now()
 WHERE d.tenant_id=app.current_tenant_id() AND d.channel='email' AND d.status='pending'
 AND d.started_at IS NOT NULL AND d.lease_until<now();
 RETURN QUERY SELECT d.id,n.recipient_employment_id,d.source_event_id,d.kind,d.category
 FROM notification_delivery d JOIN notification n ON n.id=d.notification_id AND n.tenant_id=d.tenant_id
 WHERE d.tenant_id=app.current_tenant_id() AND d.channel='email' AND d.status='pending'
 AND d.recipient_user_id IS NOT NULL AND d.next_attempt_at<=now()
 AND (d.lease_until IS NULL OR d.lease_until<now()) AND d.started_at IS NULL
 ORDER BY d.created_at,d.id LIMIT LEAST(GREATEST(p_limit,1),100);
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.notification_email_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.notification_email_due(integer) TO ai_hr_app;
--> statement-breakpoint
-- Only the isolated service gets EXECUTE. Installation grants no access to the shared app schema.
CREATE FUNCTION identity_email.delivery_target(p_id uuid,p_token uuid,p_issuer text)
RETURNS TABLE(user_id uuid,subject text,email text,category text,link_path text,severity text,locale text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='Asia/Kuala_Lumpur' AS $$
 SELECT u.id,i.subject,p.primary_email,d.category,n.link_path,n.severity::text,pref.email_locale
 FROM notification_delivery d JOIN notification n ON n.id=d.notification_id AND n.tenant_id=d.tenant_id
 JOIN domain_event ev ON ev.id=d.source_event_id AND ev.tenant_id=d.tenant_id
 JOIN employment e ON e.id=n.recipient_employment_id AND e.tenant_id=d.tenant_id
 JOIN app_user u ON u.id=d.recipient_user_id AND u.person_id=e.person_id AND u.tenant_id=d.tenant_id
 JOIN person p ON p.id=u.person_id AND p.tenant_id=d.tenant_id
 JOIN tenant t ON t.id=d.tenant_id AND t.status IN ('active','trial')
 JOIN app_external_identity i ON i.app_user_id=u.id AND i.issuer=p_issuer AND i.revoked_at IS NULL
 JOIN notification_pref pref ON pref.tenant_id=d.tenant_id AND pref.recipient_employment_id=e.id
   AND pref.category=d.category AND pref.channel='email' AND pref.enabled AND pref.email_consent_user_id=u.id
   AND pref.email_after_sequence IS NOT NULL AND ev.sequence>pref.email_after_sequence
 JOIN notification_email_policy policy ON policy.tenant_id=d.tenant_id AND policy.category=d.category
   AND policy.enabled AND ev.sequence>policy.after_sequence
 WHERE d.id=p_id AND d.lease_token=p_token AND d.channel='email' AND d.status='pending'
 AND d.lease_until>now() AND d.started_at IS NULL AND NOT app.login_blocked(u.id)
 AND e.blacklisted_at IS NULL
 AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
      OR current_date<=LEAST(e.resignation_date,e.last_working_date,e.terminated_on));
$$;
--> statement-breakpoint
CREATE FUNCTION identity_email.start_delivery(p_id uuid,p_token uuid,p_issuer text,p_target jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM notification_delivery d WHERE d.id=p_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM identity_email.delivery_target(p_id,p_token,p_issuer) t WHERE to_jsonb(t)=p_target) THEN RETURN false; END IF;
 UPDATE notification_delivery SET started_at=now(),attempts=attempts+1,updated_at=now(),lease_until=now()+interval '90 seconds'
 WHERE id=p_id AND lease_token=p_token AND status='pending' AND started_at IS NULL AND attempts<5;
 RETURN FOUND;
END; $$;
--> statement-breakpoint
CREATE FUNCTION identity_email.finish_delivery(p_id uuid,p_token uuid,p_outcome text,p_error text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_attempts integer; v_started timestamptz;
BEGIN
 IF p_outcome NOT IN ('sent','retry','failed','skipped','uncertain') OR
   (p_error IS NOT NULL AND p_error NOT IN ('relayUnavailable','recipientUnavailable','recipientChanged','notEligible',
     'smtpTemporary','smtpRejected','smtpAuthentication','smtpTls','uncertain')) THEN RAISE EXCEPTION 'invalid delivery outcome'; END IF;
 SELECT attempts,started_at INTO v_attempts,v_started FROM notification_delivery WHERE id=p_id AND lease_token=p_token AND status='pending' FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF (p_outcome='skipped' AND v_started IS NOT NULL) OR (p_outcome IN ('sent','retry','uncertain') AND v_started IS NULL) THEN RETURN false; END IF;
 UPDATE notification_delivery SET
   status=CASE WHEN p_outcome='retry' AND v_attempts<5 THEN 'pending' ELSE CASE WHEN p_outcome IN ('retry','uncertain') THEN 'failed' ELSE p_outcome END END::notification_delivery_status,
   last_error=p_error,sent_at=CASE WHEN p_outcome='sent' THEN now() ELSE NULL END,
   next_attempt_at=now()+make_interval(secs=>LEAST(3600,(60*power(2,v_attempts))::integer)),
   started_at=CASE WHEN p_outcome='retry' AND v_attempts<5 THEN NULL ELSE started_at END,
   lease_token=NULL,lease_until=NULL,updated_at=now()
 WHERE id=p_id AND lease_token=p_token;
 RETURN true;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION identity_email.delivery_target(uuid,uuid,text),identity_email.start_delivery(uuid,uuid,text,jsonb),identity_email.finish_delivery(uuid,uuid,text,text) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Contact erasure also revokes external-mail consent, without changing retained statutory primary_email.
CREATE FUNCTION app.notification_email_revoke_contact(p_employment uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_person uuid; v_count integer;
BEGIN
 SELECT e.person_id INTO v_person FROM employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
 AND (app.can_admin_employment(e.id) OR app.is_self_person(e.person_id));
 IF v_person IS NULL THEN RAISE EXCEPTION 'contact erasure not authorized' USING ERRCODE='insufficient_privilege'; END IF;
 UPDATE notification_pref pref SET enabled=false,email_consent_user_id=NULL,email_after_sequence=NULL,updated_at=now()
 FROM employment e WHERE pref.tenant_id=app.current_tenant_id() AND pref.recipient_employment_id=e.id
 AND e.tenant_id=pref.tenant_id AND e.person_id=v_person AND pref.channel='email' AND pref.email_consent_user_id IS NOT NULL;
 GET DIAGNOSTICS v_count=ROW_COUNT; RETURN v_count;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.notification_email_revoke_contact(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.notification_email_revoke_contact(uuid) TO ai_hr_app;

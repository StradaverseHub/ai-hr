-- Business requests survive email failure. No password, invitation token or reset link is stored here.
CREATE TABLE account_email_delivery (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 kind text NOT NULL CHECK(kind IN ('invitation','recovery')),
 invitation_id uuid REFERENCES app_invitation(id),recovery_email text,
 replaces_delivery_id uuid UNIQUE REFERENCES account_email_delivery(id),
 requested_by uuid REFERENCES app_user(id),
 status notification_delivery_status NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_error text CHECK(last_error IN ('relayUnavailable','providerUnavailable','notEligible','uncertain')),
 lease_token uuid,lease_until timestamptz,started_at timestamptz,sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='invitation' AND invitation_id IS NOT NULL AND recovery_email IS NULL AND tenant_id<>'00000000-0000-0000-0000-000000000000')
    OR (kind='recovery' AND invitation_id IS NULL AND tenant_id='00000000-0000-0000-0000-000000000000'
        AND recovery_email IS NOT NULL AND length(recovery_email) BETWEEN 3 AND 320 AND recovery_email !~ '[[:space:][:cntrl:]]' AND position('@' IN recovery_email)>1)),
 CHECK(status<>'pending' OR lease_token IS NOT NULL AND lease_until IS NOT NULL),
 CHECK(status='pending' OR lease_token IS NULL AND lease_until IS NULL),
 CHECK(status<>'sent' OR started_at IS NOT NULL AND sent_at IS NOT NULL)
);
CREATE UNIQUE INDEX account_email_invitation_uq ON account_email_delivery(invitation_id) WHERE invitation_id IS NOT NULL;
CREATE INDEX account_email_recent_idx ON account_email_delivery(created_at DESC,id DESC);
CREATE INDEX account_email_recovery_rate_idx ON account_email_delivery(recovery_email,created_at DESC) WHERE kind='recovery';
ALTER TABLE account_email_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON account_email_delivery FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON account_email_delivery TO ai_hr_app;
CREATE POLICY account_email_invitation_read ON account_email_delivery FOR SELECT
 USING(kind='invitation' AND tenant_id=app.current_tenant_id() AND app.is_group_admin());
CREATE POLICY account_email_invitation_insert ON account_email_delivery FOR INSERT
 WITH CHECK(kind='invitation' AND tenant_id=app.current_tenant_id() AND app.is_group_admin()
  AND EXISTS(SELECT 1 FROM app_invitation i WHERE i.id=account_email_delivery.invitation_id AND i.tenant_id=account_email_delivery.tenant_id AND i.status='pending')
  AND (replaces_delivery_id IS NULL OR EXISTS(SELECT 1 FROM account_email_delivery prior WHERE prior.id=account_email_delivery.replaces_delivery_id AND prior.tenant_id=account_email_delivery.tenant_id AND prior.kind='invitation' AND prior.status='failed')));

--> statement-breakpoint
-- Recovery mail is installation-wide. A tenant's HR role never grants that capability.
CREATE FUNCTION app.account_email_operator(p_issuer text,p_subject text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM deployment_identity_operator o JOIN app_external_identity i USING(issuer,subject)
 JOIN app_user u ON u.id=i.app_user_id
 WHERE o.issuer=p_issuer AND o.subject=p_subject AND o.revoked_at IS NULL AND i.revoked_at IS NULL
 AND u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND NOT app.login_blocked(u.id))
$$;
CREATE FUNCTION app.account_email_admin_authorized(p_id uuid,p_issuer text,p_subject text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM account_email_delivery d WHERE d.id=p_id AND
  (d.kind='invitation' AND d.tenant_id=app.current_tenant_id() AND app.is_group_admin()
   OR d.kind='recovery' AND app.account_email_operator(p_issuer,p_subject)))
$$;
REVOKE ALL ON FUNCTION app.account_email_operator(text,text),app.account_email_admin_authorized(uuid,text,text) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Public requests receive only an internal lease, never account-existence information. Bound abuse
-- independently of account existence; every caller still receives the same application confirmation.
CREATE FUNCTION app.account_email_request_recovery(p_email text)
RETURNS TABLE(id uuid,lease_token uuid) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE email text:=lower(btrim(p_email));job uuid:=gen_random_uuid();lease uuid:=gen_random_uuid();
BEGIN
 IF email IS NULL OR length(email) NOT BETWEEN 3 AND 320 OR email ~ '[[:space:][:cntrl:]]' OR position('@' IN email)<2 THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('account-email-recovery-rate',0));
 IF (SELECT count(*) FROM account_email_delivery d WHERE d.kind='recovery' AND d.recovery_email=email AND d.created_at>now()-interval '1 hour')>=5
 OR (SELECT count(*) FROM account_email_delivery d WHERE d.kind='recovery' AND d.created_at>now()-interval '1 minute')>=60 THEN RETURN; END IF;
 INSERT INTO account_email_delivery(id,tenant_id,kind,recovery_email,lease_token,lease_until)
 VALUES(job,'00000000-0000-0000-0000-000000000000','recovery',email,lease,now()+interval '90 seconds');
 PERFORM app.append_auth_event(NULL,'account-email',job,'account-email.requested','external',NULL,jsonb_build_object('kind','recovery'));
 RETURN QUERY SELECT job,lease;
END $$;
REVOKE ALL ON FUNCTION app.account_email_request_recovery(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.account_email_request_recovery(text) TO ai_hr_app;

--> statement-breakpoint
-- A lease can access only its own canonical destination. Invitation secrets are checked by hash.
CREATE FUNCTION app.account_email_target(p_id uuid,p_lease uuid,p_hash text)
RETURNS TABLE(kind text,email text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT d.kind,CASE WHEN d.kind='invitation' THEN i.email ELSE d.recovery_email END
 FROM account_email_delivery d LEFT JOIN app_invitation i ON i.id=d.invitation_id AND i.tenant_id=d.tenant_id
 WHERE d.id=p_id AND d.lease_token=p_lease AND d.status='pending' AND d.started_at IS NULL AND d.lease_until>now()
 AND (d.kind='recovery' OR i.status='pending' AND i.expires_at>now() AND i.token_hash=p_hash)
$$;
CREATE FUNCTION app.account_email_start(p_id uuid,p_lease uuid,p_hash text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM account_email_delivery d WHERE d.id=p_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM app.account_email_target(p_id,p_lease,p_hash)) THEN RETURN false; END IF;
 UPDATE account_email_delivery SET started_at=now(),attempts=attempts+1,updated_at=now(),lease_until=now()+interval '90 seconds'
 WHERE id=p_id AND lease_token=p_lease AND status='pending' AND started_at IS NULL;
 RETURN FOUND;
END $$;
CREATE FUNCTION app.account_email_finish(p_id uuid,p_lease uuid,p_status text,p_error text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job account_email_delivery;
BEGIN
 IF p_status IS NULL OR p_status NOT IN ('sent','failed','skipped') OR p_error IS NOT NULL AND p_error NOT IN ('relayUnavailable','providerUnavailable','notEligible','uncertain')
 OR p_status='sent' AND p_error IS NOT NULL OR p_status IN ('failed','skipped') AND p_error IS NULL THEN RAISE EXCEPTION 'invalid account email outcome'; END IF;
 SELECT * INTO job FROM account_email_delivery d WHERE d.id=p_id AND d.lease_token=p_lease AND d.status='pending' FOR UPDATE;
 IF NOT FOUND OR p_status='sent' AND job.started_at IS NULL OR p_status='skipped' AND job.started_at IS NOT NULL THEN RETURN false; END IF;
 UPDATE account_email_delivery SET status=p_status::notification_delivery_status,last_error=p_error,
  attempts=attempts+CASE WHEN started_at IS NULL THEN 1 ELSE 0 END,
  sent_at=CASE WHEN p_status='sent' THEN now() ELSE NULL END,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=p_id;
 PERFORM app.append_auth_event(job.tenant_id,'account-email',job.id,'account-email.'||p_status,'system',NULL,
   jsonb_build_object('kind',job.kind,'error',p_error));
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.account_email_target(uuid,uuid,text),app.account_email_start(uuid,uuid,text),app.account_email_finish(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.account_email_target(uuid,uuid,text),app.account_email_start(uuid,uuid,text),app.account_email_finish(uuid,uuid,text,text) TO ai_hr_app;

--> statement-breakpoint
-- No automatic retry exists. Viewing normalizes abandoned requests; only the explicit retry path
-- can create a replacement. Metadata never includes tokens, links, provider responses or secrets.
CREATE FUNCTION app.account_email_recent(p_issuer text,p_subject text)
RETURNS TABLE(id uuid,kind text,email text,status text,attempts integer,error text,created_at timestamptz,can_retry boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE account_email_delivery d SET status='failed',last_error=CASE WHEN d.started_at IS NULL THEN 'providerUnavailable' ELSE 'uncertain' END,
 lease_token=NULL,lease_until=NULL,updated_at=now()
 WHERE d.status='pending' AND d.lease_until<now() AND app.account_email_admin_authorized(d.id,p_issuer,p_subject);
 RETURN QUERY SELECT d.id,d.kind,CASE WHEN d.kind='invitation' THEN i.email ELSE d.recovery_email END,d.status::text,d.attempts,d.last_error,d.created_at,
 d.status='failed' AND NOT EXISTS(SELECT 1 FROM account_email_delivery child WHERE child.replaces_delivery_id=d.id)
 AND (d.kind='recovery' OR i.status='pending')
 FROM account_email_delivery d LEFT JOIN app_invitation i ON i.id=d.invitation_id AND i.tenant_id=d.tenant_id
 WHERE app.account_email_admin_authorized(d.id,p_issuer,p_subject)
 ORDER BY d.created_at DESC,d.id DESC LIMIT 50;
END $$;
CREATE FUNCTION app.account_email_retry_recovery(p_id uuid,p_issuer text,p_subject text)
RETURNS TABLE(id uuid,lease_token uuid) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE original account_email_delivery;job uuid:=gen_random_uuid();lease uuid:=gen_random_uuid();
BEGIN
 IF NOT app.account_email_operator(p_issuer,p_subject) THEN RAISE EXCEPTION 'installation email administrator required' USING ERRCODE='insufficient_privilege'; END IF;
 SELECT * INTO original FROM account_email_delivery d WHERE d.id=p_id AND d.kind='recovery' AND d.status='failed' FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM account_email_delivery child WHERE child.replaces_delivery_id=p_id) THEN RETURN; END IF;
 INSERT INTO account_email_delivery(id,tenant_id,kind,recovery_email,replaces_delivery_id,requested_by,lease_token,lease_until)
 VALUES(job,original.tenant_id,'recovery',original.recovery_email,original.id,app.current_user_id(),lease,now()+interval '90 seconds');
 PERFORM app.append_auth_event(original.tenant_id,'account-email',job,'account-email.retry-requested','user',app.current_user_id(),jsonb_build_object('kind','recovery','replaces',original.id));
 RETURN QUERY SELECT job,lease;
END $$;
REVOKE ALL ON FUNCTION app.account_email_recent(text,text),app.account_email_retry_recovery(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.account_email_recent(text,text),app.account_email_retry_recovery(uuid,text,text) TO ai_hr_app;

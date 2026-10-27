-- Preserve delivery metadata. Explicit resend creates a new record and never replays an old token.
ALTER POLICY account_email_invitation_insert ON account_email_delivery WITH CHECK(
 kind='invitation' AND tenant_id=app.current_tenant_id() AND app.is_group_admin()
 AND EXISTS(SELECT 1 FROM app_invitation i WHERE i.id=account_email_delivery.invitation_id AND i.tenant_id=account_email_delivery.tenant_id AND i.status='pending')
 AND (replaces_delivery_id IS NULL OR EXISTS(SELECT 1 FROM account_email_delivery prior
  WHERE prior.id=account_email_delivery.replaces_delivery_id AND prior.tenant_id=account_email_delivery.tenant_id
  AND prior.kind='invitation' AND prior.status IN ('failed','sent')))
);

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.account_email_retry_recovery(p_id uuid,p_issuer text,p_subject text)
RETURNS TABLE(id uuid,lease_token uuid) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE original account_email_delivery;job uuid:=gen_random_uuid();lease uuid:=gen_random_uuid();
BEGIN
 IF NOT app.account_email_operator(p_issuer,p_subject) THEN RAISE EXCEPTION 'installation email administrator required' USING ERRCODE='insufficient_privilege'; END IF;
 SELECT * INTO original FROM account_email_delivery d WHERE d.id=p_id AND d.kind='recovery' AND d.status IN ('failed','sent') FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM account_email_delivery child WHERE child.replaces_delivery_id=p_id) THEN RETURN; END IF;
 INSERT INTO account_email_delivery(id,tenant_id,kind,recovery_email,replaces_delivery_id,requested_by,lease_token,lease_until)
 VALUES(job,original.tenant_id,'recovery',original.recovery_email,original.id,app.current_user_id(),lease,now()+interval '90 seconds');
 PERFORM app.append_auth_event(app.current_tenant_id(),'account-email',job,'account-email.retry-requested','user',app.current_user_id(),jsonb_build_object('kind','recovery','replaces',original.id));
 RETURN QUERY SELECT job,lease;
END $$;

--> statement-breakpoint
CREATE FUNCTION app.account_email_history(p_issuer text,p_subject text,p_from date,p_to date,p_zone text,p_before timestamptz,p_before_id uuid)
RETURNS TABLE(id uuid,kind text,email text,status text,attempts integer,error text,created_at timestamptz,can_retry boolean,resend_unavailable text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_from>p_to OR (p_before IS NULL)<>(p_before_id IS NULL) OR NOT EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=p_zone) THEN
  RAISE EXCEPTION 'invalid email history filters';
 END IF;
 -- Keep the existing abandoned-attempt normalization. It never sends or deletes email.
 PERFORM 1 FROM app.account_email_recent(p_issuer,p_subject);
 RETURN QUERY
 SELECT d.id,d.kind,CASE WHEN d.kind='invitation' THEN i.email ELSE d.recovery_email END,d.status::text,d.attempts,d.last_error,d.created_at,
 d.status IN ('failed','sent') AND child.id IS NULL AND (d.kind='recovery' OR i.status='pending'),
 CASE WHEN child.id IS NOT NULL THEN 'superseded'
      WHEN d.kind='invitation' AND i.status<>'pending' THEN 'closed'
      WHEN d.status='pending' THEN 'pending' ELSE NULL END
 FROM account_email_delivery d
 LEFT JOIN app_invitation i ON i.id=d.invitation_id AND i.tenant_id=d.tenant_id
 LEFT JOIN account_email_delivery child ON child.replaces_delivery_id=d.id
 WHERE app.account_email_admin_authorized(d.id,p_issuer,p_subject)
 AND (p_from IS NULL OR d.created_at>=(p_from::timestamp AT TIME ZONE p_zone))
 AND (p_to IS NULL OR d.created_at<((p_to+1)::timestamp AT TIME ZONE p_zone))
 AND (p_before IS NULL OR (d.created_at,d.id)<(p_before,p_before_id))
 ORDER BY d.created_at DESC,d.id DESC LIMIT 26;
END $$;
REVOKE ALL ON FUNCTION app.account_email_history(text,text,date,date,text,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.account_email_history(text,text,date,date,text,timestamptz,uuid) TO ai_hr_app;

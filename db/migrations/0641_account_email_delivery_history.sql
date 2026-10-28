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
RETURNS TABLE(id uuid,kind text,email text,status text,attempts integer,error text,created_at timestamptz,can_retry boolean,resend_unavailable text,cursor_created_at text)
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
      WHEN d.status='pending' THEN 'pending' ELSE NULL END,
 to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
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

--> statement-breakpoint
-- One installation policy. No direct app-table access; only the verified email operator may edit.
CREATE TABLE account_email_retention (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 days integer CHECK(days BETWEEN 1 AND 3650),revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 changed_at timestamptz NOT NULL DEFAULT now(),last_run_at timestamptz,last_deleted integer NOT NULL DEFAULT 0 CHECK(last_deleted>=0)
);
INSERT INTO account_email_retention(singleton) VALUES(true);
ALTER TABLE account_email_retention ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON account_email_retention FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.account_email_retention_view(p_issuer text,p_subject text)
RETURNS TABLE(days integer,revision integer,last_run_at timestamptz,last_deleted integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.account_email_operator(p_issuer,p_subject) THEN RAISE EXCEPTION 'installation email administrator required' USING ERRCODE='insufficient_privilege'; END IF;
 RETURN QUERY SELECT r.days,r.revision,r.last_run_at,r.last_deleted FROM account_email_retention r WHERE singleton;
END $$;
CREATE FUNCTION app.account_email_retention_save(p_issuer text,p_subject text,p_days integer,p_revision integer,p_acknowledged boolean)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.account_email_operator(p_issuer,p_subject) THEN RAISE EXCEPTION 'installation email administrator required' USING ERRCODE='insufficient_privilege'; END IF;
 IF p_revision IS NULL OR p_days IS NOT NULL AND (p_days NOT BETWEEN 1 AND 3650 OR p_acknowledged IS DISTINCT FROM true) THEN RAISE EXCEPTION 'invalid retention policy or missing deletion acknowledgement'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('account-email-retention',0));
 UPDATE account_email_retention SET days=p_days,revision=revision+1,changed_at=now() WHERE singleton AND revision=p_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'retention policy changed; reload before saving'; END IF;
 PERFORM app.append_auth_event(app.current_tenant_id(),'account-email-retention','11111111-1111-4111-8111-111111111641','account-email.retention-changed','user',app.current_user_id(),jsonb_build_object('days',p_days));
END $$;
REVOKE ALL ON FUNCTION app.account_email_retention_view(text,text),app.account_email_retention_save(text,text,integer,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.account_email_retention_view(text,text),app.account_email_retention_save(text,text,integer,integer,boolean) TO ai_hr_app;

--> statement-breakpoint
-- Owner-only scheduled maintenance, not a web action. A complete resend chain is the deletion
-- unit: never remove a predecessor alone and accidentally make it available for resend again.
CREATE FUNCTION app.account_email_retention_prune() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE keep_days integer;removed integer:=0;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('account-email-retention',0)) THEN RETURN 0; END IF;
 SELECT r.days INTO keep_days FROM account_email_retention r WHERE singleton;
 IF keep_days IS NOT NULL THEN
  -- Serialize ledger writers while deciding and deleting complete chains. A racing resend either
  -- commits first (and protects its chain) or observes that its old delivery no longer exists.
  LOCK TABLE account_email_delivery IN SHARE ROW EXCLUSIVE MODE;
  WITH RECURSIVE family AS (
   SELECT d.id,d.id root,d.created_at FROM account_email_delivery d WHERE d.replaces_delivery_id IS NULL
   UNION ALL SELECT child.id,parent.root,child.created_at FROM account_email_delivery child JOIN family parent ON child.replaces_delivery_id=parent.id
  ), eligible AS (
   SELECT f.root FROM family f JOIN account_email_delivery d ON d.id=f.id LEFT JOIN app_invitation i ON i.id=d.invitation_id
   GROUP BY f.root HAVING bool_and(d.status<>'pending' AND d.updated_at<now()-make_interval(days=>keep_days)
    AND (d.kind='recovery' OR i.status<>'pending' OR i.expires_at<=now()))
   ORDER BY min(f.created_at),f.root LIMIT 100
  ), deleted AS (
   DELETE FROM account_email_delivery d USING family f,eligible e WHERE d.id=f.id AND f.root=e.root RETURNING d.id
  ) SELECT count(*)::integer INTO removed FROM deleted;
  IF removed>0 THEN
   PERFORM app.append_auth_event(NULL,'account-email-retention',gen_random_uuid(),'account-email.retention-pruned','system',NULL,jsonb_build_object('days',keep_days,'removed',removed));
  END IF;
 END IF;
 UPDATE account_email_retention SET last_run_at=now(),last_deleted=removed WHERE singleton;
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.account_email_retention_prune() FROM PUBLIC,ai_hr_app;

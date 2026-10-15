-- Auth records are authenticated/encrypted in the HR process. Neither passwords, TOTP secrets,
-- recovery links nor session tokens are stored in plaintext, including in SQL parameters.
CREATE TABLE app_internal_auth_record (
 record_key text PRIMARY KEY CHECK (length(record_key) BETWEEN 1 AND 200),
 owner_id uuid,
 sealed text NOT NULL CHECK (length(sealed) BETWEEN 30 AND 65536),
 expires_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX internal_auth_owner_idx ON app_internal_auth_record(owner_id);
--> statement-breakpoint
CREATE INDEX internal_auth_expiry_idx ON app_internal_auth_record(expires_at) WHERE expires_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app_internal_auth_record ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON app_internal_auth_record FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.internal_auth_read(p_key text,p_lock boolean DEFAULT false) RETURNS TABLE(sealed text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_lock THEN
  RETURN QUERY SELECT r.sealed FROM public.app_internal_auth_record r
  WHERE r.record_key=p_key AND (r.expires_at IS NULL OR r.expires_at>now()) FOR UPDATE;
 ELSE
  RETURN QUERY SELECT r.sealed FROM public.app_internal_auth_record r
  WHERE r.record_key=p_key AND (r.expires_at IS NULL OR r.expires_at>now());
 END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.internal_auth_write(p_key text,p_owner uuid,p_sealed text,p_expiry timestamptz DEFAULT NULL)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 INSERT INTO public.app_internal_auth_record(record_key,owner_id,sealed,expires_at)
 VALUES(p_key,p_owner,p_sealed,p_expiry)
 ON CONFLICT(record_key) DO UPDATE SET owner_id=excluded.owner_id,sealed=excluded.sealed,expires_at=excluded.expires_at,updated_at=now();
$$;
--> statement-breakpoint
CREATE FUNCTION app.internal_auth_delete(p_key text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 DELETE FROM public.app_internal_auth_record WHERE record_key=p_key;
$$;
--> statement-breakpoint
CREATE FUNCTION app.internal_auth_revoke(p_subject uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 DELETE FROM public.app_internal_auth_record WHERE owner_id=p_subject
 AND split_part(record_key,':',1) IN ('session','refresh','challenge','recovery','family');
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.internal_auth_read(text,boolean), app.internal_auth_write(text,uuid,text,timestamptz), app.internal_auth_delete(text),app.internal_auth_revoke(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.internal_auth_read(text,boolean), app.internal_auth_write(text,uuid,text,timestamptz), app.internal_auth_delete(text),app.internal_auth_revoke(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Owner-only maintenance; deleting expired encrypted records never changes HR records.
CREATE FUNCTION app.internal_auth_prune() RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 DELETE FROM public.app_internal_auth_record WHERE expires_at<=now();
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.internal_auth_prune() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- A valid invitation token is the sole pre-auth proof for viewing its fixed address and tenant.
CREATE FUNCTION app.internal_auth_invitation(p_hash text) RETURNS TABLE(email text,tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT i.email,i.tenant_id FROM public.app_invitation i
 WHERE i.token_hash=p_hash AND i.status='pending' AND i.expires_at>now();
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.internal_auth_invitation(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.internal_auth_invitation(text) TO ai_hr_app;
--> statement-breakpoint
-- Only an exact active delivery lease can resolve its immutable original recovery request. The
-- credential subject/version lives in authenticated ciphertext keyed by that original request ID.
CREATE FUNCTION app.internal_auth_recovery_source(p_id uuid,p_lease uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE requests AS (
  SELECT d.id,d.replaces_delivery_id,ARRAY[d.id] AS seen FROM account_email_delivery d
  WHERE d.id=p_id AND d.kind='recovery' AND d.status='pending' AND d.lease_token=p_lease AND d.lease_until>now()
  UNION ALL
  SELECT parent.id,parent.replaces_delivery_id,child.seen||parent.id
  FROM requests child JOIN account_email_delivery parent ON parent.id=child.replaces_delivery_id
  WHERE parent.kind='recovery' AND NOT parent.id=ANY(child.seen) AND cardinality(child.seen)<64
 ) SELECT id FROM requests WHERE replaces_delivery_id IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.internal_auth_recovery_source(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.internal_auth_recovery_source(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Embedded workflow mail reuses the canonical recipient/consent/lease checks. The issuer is derived
-- from the leased job's tenant; callers cannot choose a different identity provider or recipient.
CREATE FUNCTION app.internal_auth_notification_target(p_id uuid,p_token uuid,p_origin text)
RETURNS TABLE(user_id uuid,subject text,email text,category text,link_path text,severity text,locale text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT target.* FROM notification_delivery d
 CROSS JOIN LATERAL identity_email.delivery_target(d.id,p_token,p_origin||'/auth/'||d.tenant_id::text) target
 WHERE d.id=p_id
$$;
--> statement-breakpoint
CREATE FUNCTION app.internal_auth_notification_summary(p_id uuid,p_token uuid,p_origin text)
RETURNS TABLE(required boolean,summary jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT summary.* FROM notification_delivery d
 CROSS JOIN LATERAL identity_email.delivery_summary(d.id,p_token,p_origin||'/auth/'||d.tenant_id::text) summary
 WHERE d.id=p_id
$$;
--> statement-breakpoint
CREATE FUNCTION app.internal_auth_notification_start(p_id uuid,p_token uuid,p_origin text,p_target jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT identity_email.start_delivery(d.id,p_token,p_origin||'/auth/'||d.tenant_id::text,p_target)
 FROM notification_delivery d WHERE d.id=p_id
$$;
--> statement-breakpoint
CREATE FUNCTION app.internal_auth_notification_finish(p_id uuid,p_token uuid,p_outcome text,p_error text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT identity_email.finish_delivery(p_id,p_token,p_outcome,p_error)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.internal_auth_notification_target(uuid,uuid,text),app.internal_auth_notification_summary(uuid,uuid,text),app.internal_auth_notification_start(uuid,uuid,text,jsonb),app.internal_auth_notification_finish(uuid,uuid,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.internal_auth_notification_target(uuid,uuid,text),app.internal_auth_notification_summary(uuid,uuid,text),app.internal_auth_notification_start(uuid,uuid,text,jsonb),app.internal_auth_notification_finish(uuid,uuid,text,text) TO ai_hr_app;
--> statement-breakpoint
-- Installation SMTP authority belongs to this exact enrolled identity and attested test address,
-- never another identity attached to the same HR user.
CREATE FUNCTION app.internal_auth_email_operator(p_issuer text,p_subject text,p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.account_email_operator(p_issuer,p_subject) AND EXISTS(
  SELECT 1 FROM deployment_identity_operator o WHERE o.issuer=p_issuer AND o.subject=p_subject
  AND o.revoked_at IS NULL AND lower(o.test_email)=lower(p_email))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.internal_auth_email_operator(text,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.internal_auth_email_operator(text,text,text) TO ai_hr_app;

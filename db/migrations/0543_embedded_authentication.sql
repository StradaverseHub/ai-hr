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
CREATE FUNCTION app.internal_auth_mail_due() RETURNS TABLE(record_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT r.record_key FROM public.app_internal_auth_record r
 WHERE r.record_key LIKE 'mail:%' AND r.expires_at>now() ORDER BY r.updated_at,r.record_key LIMIT 25;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.internal_auth_invitation(text),app.internal_auth_mail_due() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.internal_auth_invitation(text),app.internal_auth_mail_due() TO ai_hr_app;

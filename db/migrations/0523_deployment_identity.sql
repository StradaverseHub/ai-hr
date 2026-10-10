-- Deployment-owned external identities preserve app_user, person, employment and grant IDs.
-- Only the schema owner / invitation definer can bind identities. No email-based login linking.
CREATE TABLE app_external_identity (
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 500),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 500),
  app_user_id uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (issuer, subject)
);
--> statement-breakpoint
CREATE INDEX app_external_identity_user_idx ON app_external_identity(app_user_id);
--> statement-breakpoint
ALTER TABLE app_external_identity ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON app_external_identity FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.principal_by_identity(p_issuer text, p_subject text)
RETURNS TABLE(app_user_id uuid, tenant_id uuid, person_id uuid, grants jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.id, p.tenant_id, p.person_id, p.grants
  FROM public.app_external_identity i
  JOIN public.app_user u ON u.id = i.app_user_id
  CROSS JOIN LATERAL app.principal(u.id) p
  WHERE i.issuer = p_issuer AND i.subject = p_subject AND i.revoked_at IS NULL
    AND NOT app.login_blocked(u.id);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.principal_by_identity(text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.principal_by_identity(text,text) TO ai_hr_app;
--> statement-breakpoint
-- Opaque browser cookies contain no tokens. Session credentials are encrypted in this private table.
CREATE TABLE app_identity_session (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  sealed text NOT NULL CHECK (length(sealed) BETWEEN 1 AND 20000),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE app_identity_session ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON app_identity_session FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.identity_session_read(p_hash text, p_lock boolean DEFAULT false)
RETURNS TABLE(sealed text, expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_lock THEN
    RETURN QUERY SELECT s.sealed, s.expires_at FROM public.app_identity_session s
      WHERE s.token_hash=p_hash AND s.expires_at>now() FOR UPDATE;
  ELSE
    RETURN QUERY SELECT s.sealed, s.expires_at FROM public.app_identity_session s
      WHERE s.token_hash=p_hash AND s.expires_at>now();
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.identity_session_write(p_hash text, p_sealed text, p_expiry timestamptz)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO public.app_identity_session(token_hash,sealed,expires_at)
  VALUES(p_hash,p_sealed,LEAST(p_expiry,now()+interval '8 hours'))
  ON CONFLICT(token_hash) DO UPDATE SET sealed=excluded.sealed
  WHERE app_identity_session.expires_at>now();
$$;
--> statement-breakpoint
CREATE FUNCTION app.identity_session_delete(p_hash text)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  DELETE FROM public.app_identity_session WHERE token_hash=p_hash;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.identity_session_read(text,boolean), app.identity_session_write(text,text,timestamptz), app.identity_session_delete(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.identity_session_read(text,boolean), app.identity_session_write(text,text,timestamptz), app.identity_session_delete(text) TO ai_hr_app;
--> statement-breakpoint
-- Reuse the existing role/scope/single-use/rebind guards. A verified email is an invitation condition,
-- never an automatic identity binding. Existing external identities cannot be stolen through a seed row.
CREATE FUNCTION app.consume_identity_invitation(p_raw_token text,p_issuer text,p_subject text,p_email text)
RETURNS TABLE(app_user_id uuid,tenant_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_inv public.app_invitation%ROWTYPE;
  v_existing uuid;
  v_legacy text;
  v_result record;
BEGIN
  IF p_issuer IS NULL OR p_issuer='' OR p_subject IS NULL OR p_subject='' OR p_email IS NULL THEN RETURN; END IF;
  SELECT * INTO v_inv FROM public.app_invitation i
    WHERE i.token_hash=encode(sha256(convert_to(p_raw_token,'UTF8')),'hex')
      AND i.status='pending' AND i.expires_at>now() AND lower(i.email)=lower(p_email)
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT i.app_user_id,u.workos_user_id INTO v_existing,v_legacy
    FROM public.app_external_identity i JOIN public.app_user u ON u.id=i.app_user_id
    WHERE i.issuer=p_issuer AND i.subject=p_subject AND i.revoked_at IS NULL;
  IF v_existing IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=v_existing AND u.tenant_id=v_inv.tenant_id) THEN
    RAISE EXCEPTION 'identity belongs to another tenant' USING ERRCODE='insufficient_privilege';
  END IF;
  IF v_inv.person_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM public.app_user u JOIN public.app_external_identity i ON i.app_user_id=u.id
    WHERE u.tenant_id=v_inv.tenant_id AND u.person_id=v_inv.person_id AND u.id IS DISTINCT FROM v_existing
  ) THEN RAISE EXCEPTION 'invitation cannot replace an enrolled identity' USING ERRCODE='insufficient_privilege'; END IF;
  v_legacy:=COALESCE(v_legacy,'oidc:'||encode(sha256(convert_to(p_issuer||chr(10)||p_subject,'UTF8')),'hex'));
  SELECT * INTO v_result FROM app.consume_invitation(p_raw_token,v_legacy);
  IF v_result.app_user_id IS NULL THEN RETURN; END IF;
  IF v_existing IS NOT NULL AND v_existing<>v_result.app_user_id THEN
    RAISE EXCEPTION 'invitation target differs from enrolled identity' USING ERRCODE='insufficient_privilege';
  END IF;
  INSERT INTO public.app_external_identity(issuer,subject,app_user_id)
    VALUES(p_issuer,p_subject,v_result.app_user_id) ON CONFLICT(issuer,subject) DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.issuer=p_issuer AND i.subject=p_subject AND i.app_user_id=v_result.app_user_id AND i.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'identity binding conflict' USING ERRCODE='insufficient_privilege';
  END IF;
  RETURN QUERY SELECT v_result.app_user_id::uuid,v_result.tenant_id::uuid;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.consume_identity_invitation(text,text,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.consume_identity_invitation(text,text,text,text) TO ai_hr_app;

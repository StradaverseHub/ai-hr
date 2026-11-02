-- Exact tenant identity lookup for the audited password-lockout unlock owner.
-- Raw identity tables remain revoked; this helper does not grant credential or provisioning authority.
CREATE FUNCTION app.password_unlock_subject(p_user uuid,p_issuer text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); s text;
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF NOT app.principal_snapshot_current() OR NOT app.is_group_admin() THEN
  RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';
 END IF;
 SELECT i.subject INTO s FROM public.app_external_identity i JOIN public.app_user u ON u.id=i.app_user_id
 WHERE u.id=p_user AND u.tenant_id=t AND i.issuer=p_issuer AND i.revoked_at IS NULL
 FOR UPDATE OF i,u;
 IF s IS NULL THEN RAISE EXCEPTION 'invalid' USING ERRCODE='23514'; END IF;
 RETURN s;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.password_unlock_subject(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.password_unlock_subject(uuid,text) TO ai_hr_app;

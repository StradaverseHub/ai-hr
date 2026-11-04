-- Admission for exact internal accounts, never a raw credential-table grant.
CREATE FUNCTION app.account_management_subject(p_user uuid,p_issuer text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); s text; p uuid;
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF NOT app.principal_snapshot_current() OR NOT app.is_admin() THEN
  RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT i.subject,u.person_id INTO s,p FROM public.app_external_identity i JOIN public.app_user u ON u.id=i.app_user_id
 WHERE u.id=p_user AND u.tenant_id=t AND i.issuer=p_issuer AND i.revoked_at IS NULL FOR UPDATE OF i,u;
 IF s IS NULL THEN RETURN NULL; END IF;
 -- Account-wide actions require authority over EVERY employment, including historical company links.
 -- Unlinked users and users without employment are group-admin only. Lock rows before scope proof.
 PERFORM 1 FROM public.employment e WHERE e.tenant_id=t AND e.person_id=p ORDER BY e.id FOR UPDATE;
 IF NOT app.is_group_admin() AND (p IS NULL OR
  NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=t AND e.person_id=p) OR
  EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=t AND e.person_id=p AND NOT app.is_admin_for(e.company_id))) THEN
  RETURN NULL; END IF;
 RETURN s;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.account_management_subject(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.account_management_subject(uuid,text) TO ai_hr_app;

-- Installation identity administration is separate from every HR/customer role.
CREATE TABLE deployment_identity_operator (
  issuer text NOT NULL, subject text NOT NULL,
  test_email text NOT NULL CHECK (length(test_email) BETWEEN 3 AND 320),
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  PRIMARY KEY (issuer,subject),
  FOREIGN KEY (issuer,subject) REFERENCES app_external_identity(issuer,subject)
);
--> statement-breakpoint
ALTER TABLE deployment_identity_operator ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON deployment_identity_operator FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.is_identity_email_operator() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM deployment_identity_operator o
 JOIN app_external_identity i USING(issuer,subject) JOIN app_user u ON u.id=i.app_user_id
 WHERE o.revoked_at IS NULL AND i.revoked_at IS NULL AND u.id=app.current_user_id()
 AND u.tenant_id=app.current_tenant_id() AND NOT app.login_blocked(u.id));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.is_identity_email_operator() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.is_identity_email_operator() TO ai_hr_app;
--> statement-breakpoint
-- Only the isolated settings service receives EXECUTE on these two functions during installation.
CREATE FUNCTION app.identity_email_operator_info(p_issuer text,p_subject text,p_user uuid,p_tenant uuid)
RETURNS TABLE(test_email text) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT o.test_email FROM deployment_identity_operator o
 JOIN app_external_identity i USING(issuer,subject) JOIN app_user u ON u.id=i.app_user_id
 WHERE o.issuer=p_issuer AND o.subject=p_subject AND o.revoked_at IS NULL AND i.revoked_at IS NULL
 AND u.id=p_user AND u.tenant_id=p_tenant AND NOT app.login_blocked(u.id);
$$;
--> statement-breakpoint
CREATE FUNCTION app.record_identity_email_event(p_issuer text,p_subject text,p_user uuid,p_tenant uuid,p_action text,p_meta jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.identity_email_operator_info(p_issuer,p_subject,p_user,p_tenant)) THEN
  RAISE EXCEPTION 'installation identity administrator required' USING ERRCODE='insufficient_privilege';
 END IF;
 IF p_action NOT IN ('draft-saved','test-requested','test-accepted','test-failed','apply-requested','applied','apply-uncertain')
 OR jsonb_typeof(p_meta) IS DISTINCT FROM 'object'
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_meta) k WHERE k NOT IN ('draftId','outcome','passwordChanged')) THEN
  RAISE EXCEPTION 'invalid identity email audit event';
 END IF;
 PERFORM app.append_auth_event(p_tenant,'app-user',p_user,'identity-email.'||p_action,'user',p_user,p_meta);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.identity_email_operator_info(text,text,uuid,uuid),app.record_identity_email_event(text,text,uuid,uuid,text,jsonb) FROM PUBLIC,ai_hr_app;

-- Board 0735d1b7: Security Center > Users. Two additive parts, no existing row, table, policy or grant changes.
--
-- 1. The bulk-job kind for By Batch Send Invitation (core/account-invitation-batch.ts). One active batch per tenant.
--    A 'send' job carries the person ids frozen at admission (selection resolved on the server); a 'retry' job carries
--    the failed invitation deliveries it re-sends. Invitations never create or enable a login.
INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
VALUES ('account_invitation_batch',NULL,'tenant','{"mode":"string","personIds":"array?","deliveryIds":"array?","role":"string?","companyId":"string?","emailLocale":"string?"}'::jsonb,262144,false);
--> statement-breakpoint
-- 2. Login merge facts (core/login-merge.ts). A merge combines LOGINS only (app_user): the master keeps signing in, each
--    merged login is switched off through its existing archived_at (app.principal_by_subject then refuses it) and its
--    internal sessions end. PERSON, EMPLOYEE, EMPLOYMENT, payroll and every other HR record are untouched; no app_user,
--    identity, credential or grant is deleted and no id is rewritten. Append-only facts: a merge row is inserted once and
--    only its undo columns are stamped once by Undo merge.
--    prior_archived_at: the merged login's archived_at before the merge, restored exactly by Undo merge.
--    group_key_digest: sha256 hex of tenant, basis and the normalised key; never the raw IC, passport or email.
--    carried: what HR ticked for the master, {"roleAssignmentIds":[...],"assistantGrantId":uuid|null}; nothing carries
--    automatically, and the merged login's own grants stay on it.
--    Row security is enabled with no application policy and the application role holds no privilege on the table (the
--    app_internal_auth_record pattern, 0543): ai_hr_app reaches it only through the definers below, each of which proves
--    the session's current principal and tenant and group administration. No CREATE POLICY here, so no access-rule text
--    changes (ADR 0181 rule 2 does not apply).
CREATE TABLE public.app_user_merge(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 master_app_user_id uuid NOT NULL,
 merged_app_user_id uuid NOT NULL,
 match_basis text NOT NULL,
 group_key_digest text NOT NULL,
 prior_archived_at timestamp with time zone,
 carried jsonb NOT NULL DEFAULT '{}'::jsonb,
 merged_by uuid NOT NULL,
 merged_at timestamp with time zone NOT NULL DEFAULT now(),
 reason text NOT NULL,
 undone_by uuid,
 undone_at timestamp with time zone,
 undo_reason text,
 CONSTRAINT app_user_merge_tenant_fk FOREIGN KEY(tenant_id) REFERENCES public.tenant(id),
 CONSTRAINT app_user_merge_master_fk FOREIGN KEY(master_app_user_id) REFERENCES public.app_user(id),
 CONSTRAINT app_user_merge_merged_fk FOREIGN KEY(merged_app_user_id) REFERENCES public.app_user(id),
 CONSTRAINT app_user_merge_merged_by_fk FOREIGN KEY(merged_by) REFERENCES public.app_user(id),
 CONSTRAINT app_user_merge_undone_by_fk FOREIGN KEY(undone_by) REFERENCES public.app_user(id),
 CONSTRAINT app_user_merge_distinct CHECK(master_app_user_id<>merged_app_user_id),
 CONSTRAINT app_user_merge_basis CHECK(match_basis IN ('ic','passport','email')),
 CONSTRAINT app_user_merge_digest CHECK(group_key_digest ~ '^[0-9a-f]{64}$'),
 CONSTRAINT app_user_merge_carried CHECK(jsonb_typeof(carried)='object'),
 CONSTRAINT app_user_merge_reason CHECK(char_length(btrim(reason)) BETWEEN 5 AND 500),
 CONSTRAINT app_user_merge_undo_complete CHECK((undone_at IS NULL)=(undone_by IS NULL) AND (undone_at IS NULL)=(undo_reason IS NULL)),
 CONSTRAINT app_user_merge_undo_reason CHECK(undo_reason IS NULL OR char_length(btrim(undo_reason)) BETWEEN 5 AND 500)
);
--> statement-breakpoint
-- At most one active merge per merged login: one login never has two masters.
CREATE UNIQUE INDEX app_user_merge_active_uq ON public.app_user_merge(tenant_id,merged_app_user_id) WHERE undone_at IS NULL;
--> statement-breakpoint
CREATE INDEX app_user_merge_master_idx ON public.app_user_merge(tenant_id,master_app_user_id);
--> statement-breakpoint
CREATE INDEX app_user_merge_merged_idx ON public.app_user_merge(merged_app_user_id);
--> statement-breakpoint
ALTER TABLE public.app_user_merge ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.app_user_merge FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Records one merge. The caller (core/login-merge.ts) holds the exclusive Access lock and has re-read the duplicate group
-- in the same transaction; this is the database backstop: tenant, current principal, group administration, both logins
-- in the tenant, not the actor's own login, the master not itself merged away, the merged login not an active master.
CREATE FUNCTION app.login_merge_record(p_master uuid,p_merged uuid,p_basis text,p_digest text,p_prior timestamptz,p_carried jsonb,p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); actor uuid:=app.current_user_id(); created uuid;
BEGIN
 IF t IS NULL OR actor IS NULL OR NOT app.principal_snapshot_current() OR NOT app.is_group_admin() THEN
  RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF p_merged=actor THEN RAISE EXCEPTION 'own login' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM public.app_user u WHERE u.tenant_id=t AND u.id IN (p_master,p_merged))<>2 THEN
  RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM public.app_user_merge m WHERE m.tenant_id=t AND m.undone_at IS NULL AND m.merged_app_user_id=p_master) THEN
  RAISE EXCEPTION 'master merged' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.app_user_merge m WHERE m.tenant_id=t AND m.undone_at IS NULL AND m.master_app_user_id=p_merged) THEN
  RAISE EXCEPTION 'member is master' USING ERRCODE='23514'; END IF;
 INSERT INTO public.app_user_merge(tenant_id,master_app_user_id,merged_app_user_id,match_basis,group_key_digest,prior_archived_at,carried,merged_by,reason)
 VALUES(t,p_master,p_merged,p_basis,p_digest,p_prior,coalesce(p_carried,'{}'::jsonb),actor,btrim(p_reason)) RETURNING id INTO created;
 RETURN created;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.login_merge_record(uuid,uuid,text,text,timestamptz,jsonb,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.login_merge_record(uuid,uuid,text,text,timestamptz,jsonb,text) TO ai_hr_app;
--> statement-breakpoint
-- Stamps Undo merge once and returns what the caller restores: the merged login's prior archived_at and what was carried.
CREATE FUNCTION app.login_merge_undo_record(p_merge uuid,p_reason text)
RETURNS TABLE(master_app_user_id uuid,merged_app_user_id uuid,prior_archived_at timestamptz,carried jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); actor uuid:=app.current_user_id(); m public.app_user_merge%ROWTYPE;
BEGIN
 IF t IS NULL OR actor IS NULL OR NOT app.principal_snapshot_current() OR NOT app.is_group_admin() THEN
  RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO m FROM public.app_user_merge x WHERE x.id=p_merge AND x.tenant_id=t FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF m.undone_at IS NOT NULL THEN RAISE EXCEPTION 'already undone' USING ERRCODE='23514'; END IF;
 UPDATE public.app_user_merge x SET undone_at=now(),undone_by=actor,undo_reason=btrim(p_reason) WHERE x.id=m.id;
 RETURN QUERY SELECT m.master_app_user_id,m.merged_app_user_id,m.prior_archived_at,m.carried;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.login_merge_undo_record(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.login_merge_undo_record(uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- The tenant's active merges, merged login -> master, one set-based read. Any administrator of the tenant: the Users list
-- leaves merged logins out for company-scoped administrators too. Ids only; who and why stay group-admin only.
CREATE FUNCTION app.login_merge_active()
RETURNS TABLE(merged_app_user_id uuid,master_app_user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL OR NOT app.is_admin() THEN RETURN; END IF;
 RETURN QUERY SELECT m.merged_app_user_id,m.master_app_user_id FROM public.app_user_merge m
  WHERE m.tenant_id=t AND m.undone_at IS NULL ORDER BY m.merged_app_user_id;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.login_merge_active() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.login_merge_active() TO ai_hr_app;
--> statement-breakpoint
-- Every merge fact naming one login, as master or as merged login, newest first, with the actors' names. Group
-- administrators only. At most 200 rows.
CREATE FUNCTION app.login_merge_facts(p_user uuid)
RETURNS TABLE(id uuid,master_app_user_id uuid,merged_app_user_id uuid,match_basis text,prior_archived_at timestamptz,carried jsonb,
 merged_by uuid,merged_by_name text,merged_at timestamptz,reason text,undone_by uuid,undone_by_name text,undone_at timestamptz,undo_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL OR NOT app.principal_snapshot_current() OR NOT app.is_group_admin() THEN
  RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT m.id,m.master_app_user_id,m.merged_app_user_id,m.match_basis,m.prior_archived_at,m.carried,
  m.merged_by,pb.full_name,m.merged_at,m.reason,m.undone_by,pu.full_name,m.undone_at,m.undo_reason
  FROM public.app_user_merge m
  LEFT JOIN public.app_user ab ON ab.id=m.merged_by AND ab.tenant_id=t LEFT JOIN public.person pb ON pb.id=ab.person_id AND pb.tenant_id=t
  LEFT JOIN public.app_user au ON au.id=m.undone_by AND au.tenant_id=t LEFT JOIN public.person pu ON pu.id=au.person_id AND pu.tenant_id=t
  WHERE m.tenant_id=t AND (m.master_app_user_id=p_user OR m.merged_app_user_id=p_user)
  ORDER BY m.merged_at DESC,m.id DESC LIMIT 200;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.login_merge_facts(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.login_merge_facts(uuid) TO ai_hr_app;

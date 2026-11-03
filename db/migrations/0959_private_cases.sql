-- AI v2 Phase 1, slice 2, W11 (owner, 3 November 2026: "Minimal route in Phase 1"): a protected case route for
-- sensitive matters. Provisional DEVELOPMENT source allocation 0959 / when1793330000359 (docs/MIGRATION-ALLOCATION.md):
-- a scan of every origin ref and registered worktree on 3 November 2026 found claims through 0958 / when1793330000358.
-- It grants no installation, and the journal position is re-frozen at integration. Production is held.
--
-- A private case is a person's own written report to named HR case handlers: grievance, harassment, safety or other.
-- The person writes it in a form, never through the AI. Its text and every handler note are AES-256-GCM encrypted by the
-- application (lib/ai/crypto.ts encryptSecret) with additional data binding tenant, case and author; no readable text
-- is ever stored here. No model, tool, transcript, stored chat or task memory reads these tables.
--
-- Who reads (FORCE row-level security on all four tables, so the physical owner is bound by the policies too):
--  - the author, their own cases (text and status history; never handler notes or who read it);
--  - the handlers designated for the case's company, except the author and anyone the author excluded (a case about
--    one of the handlers). When no eligible handler remains, the group administrators (again except the excluded and
--    the author) receive it. Nobody else: no general HR administrator, manager, agent or other login policy exists.
--  - Two owner-side paths, each narrower than an application read: definer lookups see exactly the cases the calling
--    login may handle (the same predicate), and person erasure (core/pdpa.ts -> app.private_cases_redact, under the
--    admitted, audited review-erasure intent) deletes closed cases and marks open ones; it never reads a word.
-- Handlers are an explicit grant per company (private_case_handler), designated by a group administrator or an HR
-- administrator of that company; an HR administrator cannot designate themself. Grants are revoked, never deleted.
-- Audit: every creation, read, status change and note is a private_case_event row; lifecycle events are written by the
-- triggers below, reads by core/private-cases.ts before it returns any text, inside the same transaction.
-- Grants: every privilege a table must not have is revoked, not merely left ungranted.
--
-- Writers reviewed before each constraint: core/private-cases.ts is the only application writer of all four tables, and
-- app.private_cases_redact the only owner-side writer. All four tables are new.

-- 1. Handlers: one active grant per company and login; revoked grants stay as history.
CREATE TABLE public.private_case_handler (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 app_user_id uuid NOT NULL REFERENCES public.app_user(id),
 granted_by_user_id uuid NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT now(),
 revoked_by_user_id uuid,
 revoked_at timestamptz,
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK ((revoked_at IS NULL)=(revoked_by_user_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX private_case_handler_active_uq ON public.private_case_handler(tenant_id,company_id,app_user_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX private_case_handler_company_idx ON public.private_case_handler(tenant_id,company_id,granted_at DESC);
--> statement-breakpoint
-- Database-owned times: a grant starts active; afterwards only its one revocation changes it.
CREATE FUNCTION app.private_case_handler_stamp() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.granted_at:=now();NEW.revoked_at:=NULL;NEW.revoked_by_user_id:=NULL;RETURN NEW;
 END IF;
 IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'A revoked handler grant is not changed' USING ERRCODE='42501';END IF;
 IF (to_jsonb(NEW)-'revoked_at'-'revoked_by_user_id') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'revoked_by_user_id') OR NEW.revoked_by_user_id IS NULL THEN
  RAISE EXCEPTION 'A handler grant only changes by its revocation' USING ERRCODE='42501';END IF;
 NEW.revoked_at:=now();RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.private_case_handler_stamp() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER private_case_handler_stamp BEFORE INSERT OR UPDATE ON public.private_case_handler
 FOR EACH ROW EXECUTE FUNCTION app.private_case_handler_stamp();
--> statement-breakpoint
-- A current, unarchived login of the caller's tenant (the designation target). Definer: an HR administrator's own
-- app_user visibility is not what decides this.
CREATE FUNCTION app._private_case_login_current(p_user uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=p_user AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._private_case_login_current(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app._private_case_login_current(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The caller holds a current employment in the company: who may open a case for it. Definer, reads non-forced tables.
CREATE FUNCTION app.private_case_author_company(p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_agent_principal() IS NULL AND EXISTS(SELECT 1 FROM public.app_user u
  JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND e.company_id=p_company
   AND (e.terminated_on IS NULL OR e.terminated_on>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.private_case_author_company(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.private_case_author_company(uuid) TO ai_hr_app;
--> statement-breakpoint
-- A current group administrator other than the author and the excluded logins exists: the fallback route can deliver.
CREATE FUNCTION app._private_case_group_admin_available(p_tenant uuid,p_author uuid,p_excluded uuid[]) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.role_assignment r
  JOIN public.app_user u ON u.id=r.app_user_id AND u.tenant_id=r.tenant_id
  WHERE r.tenant_id=p_tenant AND (r.role='super_admin' OR (r.role='hr_admin' AND r.company_id IS NULL))
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND u.id<>p_author AND NOT (u.id=ANY(coalesce(p_excluded,'{}'::uuid[]))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._private_case_group_admin_available(uuid,uuid,uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app._private_case_group_admin_available(uuid,uuid,uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- 2. One private case. id is chosen by the writer so the text's additional data can bind it before the insert.
--    author_person_id is the login's person when the case was opened (the original person wins for erasure, as for
--    chats). route: 'handlers' (the company's handlers) or 'group_admin'; excluded_user_ids are handlers the author
--    named as the subject, who never see it. status: received -> in_review -> closed (received -> closed too); closed
--    is final. erasure_requested_at: person erasure met the case open; it is deleted when a handler closes it.
CREATE TABLE public.private_case (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 author_user_id uuid NOT NULL REFERENCES public.app_user(id),
 author_person_id uuid,
 category text NOT NULL CHECK (category IN ('grievance','harassment','safety','other')),
 status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_review','closed')),
 route text NOT NULL DEFAULT 'handlers' CHECK (route IN ('handlers','group_admin')),
 excluded_user_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(excluded_user_ids)<=50 AND array_position(excluded_user_ids,NULL) IS NULL),
 body_ciphertext text NOT NULL CHECK (body_ciphertext ~ '^[A-Za-z0-9_-]{40,}$' AND octet_length(body_ciphertext)<=65536),
 created_at timestamptz NOT NULL DEFAULT now(),
 status_changed_at timestamptz NOT NULL DEFAULT now(),
 closed_at timestamptz,
 erasure_requested_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK (version>=1),
 UNIQUE (tenant_id,id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK ((status='closed')=(closed_at IS NOT NULL)),
 CHECK (NOT (author_user_id=ANY(excluded_user_ids)))
);
--> statement-breakpoint
CREATE INDEX private_case_company_idx ON public.private_case(tenant_id,company_id,status,created_at DESC);
--> statement-breakpoint
CREATE INDEX private_case_author_idx ON public.private_case(tenant_id,author_user_id,created_at DESC);
--> statement-breakpoint
-- Who may handle one case, for the calling login (the session's own identity, never an argument): a current login,
-- not an agent, not the author, not excluded; a current handler of the company while any eligible handler remains,
-- otherwise a current group administrator. Invoker rights: the handler rows it reads are visible to the caller's role
-- (section 6), so in a definer it answers for the same login and widens nothing.
CREATE FUNCTION app.private_case_may_handle(p_tenant uuid,p_company uuid,p_author uuid,p_route text,p_excluded uuid[]) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND app.current_user_id()<>p_author AND NOT (app.current_user_id()=ANY(p_excluded))
  AND app.principal_snapshot_current() IS TRUE
  AND CASE WHEN p_route='handlers' AND EXISTS(SELECT 1 FROM public.private_case_handler h
    WHERE h.tenant_id=p_tenant AND h.company_id=p_company AND h.revoked_at IS NULL AND h.app_user_id<>p_author AND NOT (h.app_user_id=ANY(p_excluded)))
   THEN EXISTS(SELECT 1 FROM public.private_case_handler h
    WHERE h.tenant_id=p_tenant AND h.company_id=p_company AND h.revoked_at IS NULL AND h.app_user_id=app.current_user_id())
   ELSE app.is_group_admin() END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.private_case_may_handle(uuid,uuid,uuid,text,uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.private_case_may_handle(uuid,uuid,uuid,text,uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- Database-owned lifecycle. On insert: a case starts received, at the clock's time; the company must have a current
-- handler (the route is set up); the exclusions are handlers of that company; the route falls back to the group
-- administrators when no handler other than the author and the excluded remains; with nobody to receive it, refused.
-- On update: only the status, along received -> in_review -> closed (or received -> closed). Person erasure's own
-- transaction (the marker below, owner side only) may set erasure_requested_at on an open case, nothing else.
CREATE FUNCTION app.private_case_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.status:='received';NEW.created_at:=now();NEW.status_changed_at:=now();NEW.closed_at:=NULL;NEW.erasure_requested_at:=NULL;NEW.version:=1;
  NEW.excluded_user_ids:=coalesce((SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(NEW.excluded_user_ids) x),'{}'::uuid[]);
  IF NOT EXISTS(SELECT 1 FROM public.private_case_handler h WHERE h.tenant_id=NEW.tenant_id AND h.company_id=NEW.company_id AND h.revoked_at IS NULL) THEN
   RAISE EXCEPTION 'Private cases are not set up for this company' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM unnest(NEW.excluded_user_ids) x WHERE NOT EXISTS(SELECT 1 FROM public.private_case_handler h
    WHERE h.tenant_id=NEW.tenant_id AND h.company_id=NEW.company_id AND h.revoked_at IS NULL AND h.app_user_id=x)) THEN
   RAISE EXCEPTION 'Only a handler of this company can be excluded' USING ERRCODE='23514';END IF;
  IF NEW.route='handlers' AND NOT EXISTS(SELECT 1 FROM public.private_case_handler h WHERE h.tenant_id=NEW.tenant_id AND h.company_id=NEW.company_id
    AND h.revoked_at IS NULL AND h.app_user_id<>NEW.author_user_id AND NOT (h.app_user_id=ANY(NEW.excluded_user_ids))) THEN NEW.route:='group_admin';END IF;
  IF NEW.route='group_admin' AND app._private_case_group_admin_available(NEW.tenant_id,NEW.author_user_id,NEW.excluded_user_ids) IS NOT TRUE THEN
   RAISE EXCEPTION 'Nobody can receive this case' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF current_user<>'ai_hr_app' AND current_setting('app.private_case_erasure',true)=OLD.tenant_id::text THEN
  IF (to_jsonb(NEW)-'erasure_requested_at') IS DISTINCT FROM (to_jsonb(OLD)-'erasure_requested_at') OR OLD.status='closed' OR OLD.erasure_requested_at IS NOT NULL THEN
   RAISE EXCEPTION 'Erasure only marks an open case' USING ERRCODE='42501';END IF;
  NEW.erasure_requested_at:=now();RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN RAISE EXCEPTION 'Only the status of a case changes' USING ERRCODE='42501';END IF;
 IF NOT ((OLD.status='received' AND NEW.status IN ('in_review','closed')) OR (OLD.status='in_review' AND NEW.status='closed')) THEN
  RAISE EXCEPTION 'Not an allowed status change' USING ERRCODE='23514';END IF;
 NEW.status_changed_at:=now();NEW.version:=OLD.version+1;
 IF NEW.status='closed' THEN NEW.closed_at:=now();END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.private_case_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER private_case_guard BEFORE INSERT OR UPDATE ON public.private_case
 FOR EACH ROW EXECUTE FUNCTION app.private_case_guard();
--> statement-breakpoint
-- 3. A handler's note on a case: encrypted text only, append-only, never shown to the author.
CREATE TABLE public.private_case_note (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 case_id uuid NOT NULL,
 author_user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 body_ciphertext text NOT NULL CHECK (body_ciphertext ~ '^[A-Za-z0-9_-]{40,}$' AND octet_length(body_ciphertext)<=32768),
 FOREIGN KEY (tenant_id,case_id) REFERENCES public.private_case(tenant_id,id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX private_case_note_case_idx ON public.private_case_note(tenant_id,case_id,created_at);
--> statement-breakpoint
-- 4. The case's audit trail. Lifecycle kinds come from the triggers below; 'read' from core/private-cases.ts.
CREATE TABLE public.private_case_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 case_id uuid NOT NULL,
 actor_user_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('created','read','status_changed','note_added')),
 from_status text CHECK (from_status IN ('received','in_review','closed')),
 to_status text CHECK (to_status IN ('received','in_review','closed')),
 at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (tenant_id,case_id) REFERENCES public.private_case(tenant_id,id) ON DELETE CASCADE,
 CHECK ((kind='status_changed')=(from_status IS NOT NULL AND to_status IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX private_case_event_case_idx ON public.private_case_event(tenant_id,case_id,at);
--> statement-breakpoint
CREATE FUNCTION app.private_case_append_only() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF TG_TABLE_NAME='private_case_note' THEN NEW.created_at:=now();ELSE NEW.at:=clock_timestamp();END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'A private case note or audit row is never changed' USING ERRCODE='42501';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.private_case_append_only() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER private_case_note_append_only BEFORE INSERT OR UPDATE ON public.private_case_note
 FOR EACH ROW EXECUTE FUNCTION app.private_case_append_only();
--> statement-breakpoint
CREATE TRIGGER private_case_event_append_only BEFORE INSERT OR UPDATE ON public.private_case_event
 FOR EACH ROW EXECUTE FUNCTION app.private_case_append_only();
--> statement-breakpoint
-- Lifecycle audit, as the acting login (invoker rights: the event insert policy checks that login's access).
CREATE FUNCTION app.private_case_audit() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='private_case_note' THEN
  INSERT INTO public.private_case_event(tenant_id,case_id,actor_user_id,kind) VALUES (NEW.tenant_id,NEW.case_id,NEW.author_user_id,'note_added');
 ELSIF TG_OP='INSERT' THEN
  INSERT INTO public.private_case_event(tenant_id,case_id,actor_user_id,kind) VALUES (NEW.tenant_id,NEW.id,NEW.author_user_id,'created');
 ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
  INSERT INTO public.private_case_event(tenant_id,case_id,actor_user_id,kind,from_status,to_status)
   VALUES (NEW.tenant_id,NEW.id,app.current_user_id(),'status_changed',OLD.status,NEW.status);
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.private_case_audit() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER private_case_audit AFTER INSERT OR UPDATE ON public.private_case
 FOR EACH ROW EXECUTE FUNCTION app.private_case_audit();
--> statement-breakpoint
CREATE TRIGGER private_case_note_audit AFTER INSERT ON public.private_case_note
 FOR EACH ROW EXECUTE FUNCTION app.private_case_audit();
--> statement-breakpoint
-- 5. Definer lookups that return no case content, each answering only for a case the calling login may handle or for
--    a company the calling login may open a case in.
-- The intake form: the company's current handlers by name, so the author can exclude the one the case is about.
CREATE FUNCTION app.private_case_intake_handlers(p_company uuid) RETURNS TABLE(app_user_id uuid,display_name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT h.app_user_id,coalesce(nullif(btrim(p.preferred_name),''),p.full_name)
 FROM public.private_case_handler h JOIN public.app_user u ON u.id=h.app_user_id AND u.tenant_id=h.tenant_id
 LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE h.tenant_id=app.current_tenant_id() AND h.company_id=p_company AND h.revoked_at IS NULL AND h.app_user_id<>app.current_user_id()
  AND app.private_case_author_company(p_company)
 ORDER BY 2,1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.private_case_intake_handlers(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.private_case_intake_handlers(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The names a handler sees on one case: its author, and every login that has handled the company's cases or is a
-- group administrator (note authors and audit actors are among them). Nothing for a case the caller may not handle.
CREATE FUNCTION app.private_case_names(p_case uuid) RETURNS TABLE(app_user_id uuid,display_name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT u.id,coalesce(nullif(btrim(p.preferred_name),''),p.full_name)
 FROM public.private_case c
 JOIN public.app_user u ON u.tenant_id=c.tenant_id AND (u.id=c.author_user_id
  OR EXISTS(SELECT 1 FROM public.private_case_handler h WHERE h.tenant_id=c.tenant_id AND h.company_id=c.company_id AND h.app_user_id=u.id)
  OR EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=c.tenant_id AND r.app_user_id=u.id AND (r.role='super_admin' OR (r.role='hr_admin' AND r.company_id IS NULL))))
 LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id()
  AND app.private_case_may_handle(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.private_case_names(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.private_case_names(uuid) TO ai_hr_app;
--> statement-breakpoint
-- 5b. Person erasure. Joins the existing admitted erasure in THIS transaction (app.assistant_own_leave_reviews_redact
--     records the intent; the canonical pii.erased audit is required at commit), exactly as app.teras_chats_redact does.
--     Closed cases of the person are deleted with their notes and audit; open ones are kept under the retention
--     exception and marked, and go when a handler closes them. It reads no text and returns the number of cases touched.
CREATE FUNCTION app._private_case_erasure_subject(p_tenant uuid,p_user uuid,p_person uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i
  WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=p_tenant AND i.user_id=app.current_user_id()
   AND (i.person_id=p_person OR (p_person IS NULL AND EXISTS(SELECT 1 FROM public.app_user u
    WHERE u.id=p_user AND u.tenant_id=p_tenant AND u.person_id=i.person_id))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._private_case_erasure_subject(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
-- EXECUTE only so an application query's policy check can be planned; it answers only for the caller's own
-- transaction and the erasure policies below also require the table owner as the current user.
GRANT EXECUTE ON FUNCTION app._private_case_erasure_subject(uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.private_cases_redact(subject_employment uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.assistant_review_erasure_intent%ROWTYPE;deleted integer;marked integer;
BEGIN
 SELECT * INTO i FROM app.assistant_review_erasure_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id()
  AND user_id=app.current_user_id() AND employment_id=subject_employment;
 IF NOT FOUND OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(subject_employment) IS NOT TRUE THEN
  RAISE EXCEPTION 'Private case erasure admission unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM public.private_case c WHERE c.tenant_id=i.tenant_id AND c.status='closed'
  AND app._private_case_erasure_subject(c.tenant_id,c.author_user_id,c.author_person_id);
 GET DIAGNOSTICS deleted=ROW_COUNT;
 PERFORM set_config('app.private_case_erasure',i.tenant_id::text,true);
 UPDATE public.private_case c SET erasure_requested_at=now() WHERE c.tenant_id=i.tenant_id AND c.status<>'closed' AND c.erasure_requested_at IS NULL
  AND app._private_case_erasure_subject(c.tenant_id,c.author_user_id,c.author_person_id);
 GET DIAGNOSTICS marked=ROW_COUNT;
 PERFORM set_config('app.private_case_erasure','',true);
 RETURN deleted+marked;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.private_cases_redact(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.private_cases_redact(uuid) TO ai_hr_app;
--> statement-breakpoint
-- ── RLS: forced on every table ──
ALTER TABLE public.private_case_handler ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.private_case_handler FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.private_case ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.private_case FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.private_case_note ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.private_case_note FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.private_case_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.private_case_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- 6. Handler grants: current grants are visible to every login of the tenant (handlers are named to the people who
--    write to them); revoked history to administrators of the company and the handler. The owner reads them in its
--    definer lookups (section 5), always within the calling session's tenant.
CREATE POLICY private_case_handler_read ON public.private_case_handler FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL
  AND (revoked_at IS NULL OR app.is_admin_for(company_id) OR app_user_id=app.current_user_id()));
--> statement-breakpoint
CREATE POLICY private_case_handler_owner_read ON public.private_case_handler FOR SELECT TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.private_case_handler'::regclass))
  AND tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY private_case_handler_designate ON public.private_case_handler FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND granted_by_user_id=app.current_user_id() AND app.is_admin_for(company_id)
  AND (app_user_id<>app.current_user_id() OR app.is_group_admin()) AND app._private_case_login_current(app_user_id));
--> statement-breakpoint
CREATE POLICY private_case_handler_revoke ON public.private_case_handler FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.is_admin_for(company_id) AND revoked_at IS NULL)
 WITH CHECK (tenant_id=app.current_tenant_id() AND revoked_by_user_id=app.current_user_id());
--> statement-breakpoint
-- 7. Cases: the author's own, and the handlers' (app.private_case_may_handle). No other application policy exists.
CREATE POLICY private_case_author_read ON public.private_case FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND author_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY private_case_handler_read ON public.private_case FOR SELECT TO ai_hr_app
 USING (app.private_case_may_handle(tenant_id,company_id,author_user_id,route,excluded_user_ids));
--> statement-breakpoint
CREATE POLICY private_case_author_open ON public.private_case FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND author_user_id=app.current_user_id() AND app.private_case_author_company(company_id)
  AND author_person_id IS NOT DISTINCT FROM (SELECT u.person_id FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY private_case_handler_status ON public.private_case FOR UPDATE TO ai_hr_app
 USING (app.private_case_may_handle(tenant_id,company_id,author_user_id,route,excluded_user_ids))
 WITH CHECK (app.private_case_may_handle(tenant_id,company_id,author_user_id,route,excluded_user_ids));
--> statement-breakpoint
-- A case person erasure met open is deleted by the handler who closes it.
CREATE POLICY private_case_erased_on_close ON public.private_case FOR DELETE TO ai_hr_app
 USING (status='closed' AND erasure_requested_at IS NOT NULL AND app.private_case_may_handle(tenant_id,company_id,author_user_id,route,excluded_user_ids));
--> statement-breakpoint
-- Definer lookups (section 5): the owner sees exactly the cases the calling login may handle.
CREATE POLICY private_case_definer_handler_read ON public.private_case FOR SELECT TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.private_case'::regclass))
  AND app.private_case_may_handle(tenant_id,company_id,author_user_id,route,excluded_user_ids));
--> statement-breakpoint
-- Person erasure: only the table owner as current user (app.private_cases_redact), only the admitted subject's cases.
CREATE POLICY private_case_person_erasure_read ON public.private_case FOR SELECT TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.private_case'::regclass))
  AND app._private_case_erasure_subject(tenant_id,author_user_id,author_person_id));
--> statement-breakpoint
CREATE POLICY private_case_person_erasure_delete ON public.private_case FOR DELETE TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.private_case'::regclass))
  AND status='closed' AND app._private_case_erasure_subject(tenant_id,author_user_id,author_person_id));
--> statement-breakpoint
CREATE POLICY private_case_person_erasure_mark ON public.private_case FOR UPDATE TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.private_case'::regclass))
  AND status<>'closed' AND tenant_id::text=current_setting('app.private_case_erasure',true)
  AND app._private_case_erasure_subject(tenant_id,author_user_id,author_person_id))
 WITH CHECK (tenant_id::text=current_setting('app.private_case_erasure',true));
--> statement-breakpoint
-- 8. Notes: the case's handlers only, never its author; added while the case is open.
CREATE POLICY private_case_note_handler_read ON public.private_case_note FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.private_case c WHERE c.tenant_id=private_case_note.tenant_id AND c.id=private_case_note.case_id
  AND app.private_case_may_handle(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids)));
--> statement-breakpoint
CREATE POLICY private_case_note_handler_add ON public.private_case_note FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND author_user_id=app.current_user_id()
  AND EXISTS(SELECT 1 FROM public.private_case c WHERE c.tenant_id=private_case_note.tenant_id AND c.id=private_case_note.case_id AND c.status<>'closed'
   AND app.private_case_may_handle(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids)));
--> statement-breakpoint
-- 9. Audit: handlers read every row of their cases; the author reads its creation and status changes, never who read
--    it or that a note was added. A row names the acting login and needs that login's access to the case: the author
--    for 'created', a handler for status changes and notes, either for a read.
CREATE POLICY private_case_event_handler_read ON public.private_case_event FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.private_case c WHERE c.tenant_id=private_case_event.tenant_id AND c.id=private_case_event.case_id
  AND app.private_case_may_handle(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids)));
--> statement-breakpoint
CREATE POLICY private_case_event_author_read ON public.private_case_event FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND kind IN ('created','status_changed')
  AND EXISTS(SELECT 1 FROM public.private_case c WHERE c.tenant_id=private_case_event.tenant_id AND c.id=private_case_event.case_id AND c.author_user_id=app.current_user_id()));
--> statement-breakpoint
CREATE POLICY private_case_event_append ON public.private_case_event FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND actor_user_id=app.current_user_id()
  AND app.principal_snapshot_current() IS TRUE
  AND EXISTS(SELECT 1 FROM public.private_case c WHERE c.tenant_id=private_case_event.tenant_id AND c.id=private_case_event.case_id
   AND CASE private_case_event.kind
    WHEN 'created' THEN c.author_user_id=app.current_user_id()
    WHEN 'read' THEN c.author_user_id=app.current_user_id() OR app.private_case_may_handle(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids)
    ELSE app.private_case_may_handle(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids) END));
--> statement-breakpoint
-- ── Grants: exactly what each table needs, everything else revoked ──
REVOKE ALL ON public.private_case_handler,public.private_case,public.private_case_note,public.private_case_event FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.private_case_handler TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE (revoked_at,revoked_by_user_id) ON public.private_case_handler TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON public.private_case TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE (status) ON public.private_case TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.private_case_note TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.private_case_event TO ai_hr_app;

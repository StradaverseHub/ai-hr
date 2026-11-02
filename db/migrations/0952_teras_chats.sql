-- AI Centre round, issue 8 (owner, 3 November 2026: "Store on server now", then "But with active removal in a few days
-- or months, which are configurable") and issue 18 item 1 (the floating panel and Ask share one stored conversation).
-- Provisional DEVELOPMENT source allocation 0952 / when1793330000352 (docs/MIGRATION-ALLOCATION.md): a scan of every
-- origin ref and registered worktree on 3 November 2026 found claims through 0951 / when1793330000351. It grants no
-- installation, and the journal position is re-frozen at integration. Production is held; staging uses fictional data.
--
-- A stored chat is one Noveri conversation (core/teras-wiring/history.ts conversation id) of one login. Its turns hold
-- the person's words, the reply they were shown and the model-side rows, each AES-256-GCM encrypted by the application
-- (lib/ai/crypto.ts encryptSecret) with additional data binding tenant, login, chat, sequence and field. A turn the
-- pre-read gate routed or refused (a sensitive topic, a crisis, a workplace-harms request) stores no words at all:
-- only the marker withheld=true. Nothing here is read by the closed grammar.
--
-- Isolation: FORCE row-level security on all three tables, so the table owner is bound by the policies too.
--  - The login's own policies are the only application read path. No group administrator, HR, manager, agent or other
--    login policy exists on any of them.
--  - Retention (scripts/ai-retention-runner.ts, as the physical table owner's own session, the 0650 pattern) may see and
--    delete only EXPIRED teras_chat rows (expires_at<=now()), which carry no words. Their turns go by the foreign-key
--    cascade, which Postgres runs as the table owner with forced row security suspended; the owner has no policy on
--    teras_chat_turn, so the retention session can neither read nor select a turn, encrypted or not.
--  - Person erasure (core/pdpa.ts) reaches teras_chat only inside app.teras_chats_redact, a definer function, under the
--    same admitted, audited review-erasure intent as app.assistant_transcripts_redact; it deletes and counts, never reads.
--  - A shortened "Keep chats for" lowers the tenant's stored expiries inside app.teras_chat_retention_applied, a definer
--    trigger on the setting; it changes expires_at only, never a turn.
-- Grants: every privilege a table must not have is revoked, not merely left ungranted (cluster default privileges would
-- otherwise hand ai_hr_app full CRUD). Turns are append-only for the application; chats change only by one new turn.
--
-- Writers reviewed before each constraint: core/teras-chats.ts recordChatTurn is the only application writer of
-- teras_chat and teras_chat_turn; setChatRetention is the only writer of teras_chat_retention. All three tables are new.

-- 1. The tenant's "Keep chats for" setting: 1, 7, 30, 90, 180 or 365 days. No row means the default, 30 days. Only a
--    current group administrator writes it, as themself; core/teras-chats.ts audits every change (domain_event).
CREATE TABLE public.teras_chat_retention (
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
 keep_days integer NOT NULL DEFAULT 30 CHECK (keep_days IN (1,7,30,90,180,365)),
 version integer NOT NULL DEFAULT 1 CHECK (version>=1),
 changed_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TRIGGER teras_chat_retention_version BEFORE UPDATE ON public.teras_chat_retention
 FOR EACH ROW EXECUTE FUNCTION app.teras_bump_version('version');
--> statement-breakpoint
-- Invoker rights: the login's tenant policy decides whether the setting is visible; a missing row is the default.
CREATE FUNCTION app.teras_chat_keep_days(p_tenant uuid) RETURNS integer
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT r.keep_days FROM public.teras_chat_retention r WHERE r.tenant_id=p_tenant),30)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_chat_keep_days(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_chat_keep_days(uuid) TO ai_hr_app;
--> statement-breakpoint
-- 2. One stored chat. id is the conversation id; person_id is the login's person when the chat started (the original
--    person wins for erasure, as for transcripts); company_id and scope_digest are the scope it started under
--    (core/assistant-conversation-context.ts assistantConversationScopeDigest: tenant, login, person, roles, grants and
--    company scope). A chat is reopened and continued only under the same digest. expires_at is the last message time
--    plus the tenant's keep_days when that message was written, brought forward at once when the setting is later
--    shortened (section 4b); a longer setting applies from the chat's next message, so an expired chat is never
--    revived. No words live in this table.
CREATE TABLE public.teras_chat (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 app_user_id uuid NOT NULL REFERENCES public.app_user(id) ON DELETE CASCADE,
 person_id uuid,
 company_id uuid NOT NULL,
 scope_digest text NOT NULL CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
 turn_count integer NOT NULL DEFAULT 0 CHECK (turn_count BETWEEN 0 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(),
 last_message_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 UNIQUE (tenant_id,app_user_id,id),
 CHECK (last_message_at>=created_at AND expires_at>last_message_at)
);
--> statement-breakpoint
CREATE INDEX teras_chat_owner_idx ON public.teras_chat(tenant_id,app_user_id,last_message_at DESC,id DESC);
--> statement-breakpoint
CREATE INDEX teras_chat_expiry_idx ON public.teras_chat(expires_at);
--> statement-breakpoint
-- Database-owned times: a chat starts empty; afterwards only one new turn changes it, and never after it expired. The
-- last message time and the expiry are stamped here from the clock and the tenant's setting; a writer cannot set them.
-- The one other change is a shortened setting bringing expires_at forward, inside app.teras_chat_retention_applied (4b).
CREATE FUNCTION app.teras_chat_stamp() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.turn_count<>0 THEN RAISE EXCEPTION 'A chat starts empty' USING ERRCODE='23514';END IF;
  NEW.created_at:=now();
 ELSE
  IF current_user<>'ai_hr_app' AND current_setting('app.teras_chat_restamp',true)=OLD.tenant_id::text THEN
   IF (to_jsonb(NEW)-'expires_at') IS DISTINCT FROM (to_jsonb(OLD)-'expires_at') OR NEW.expires_at>OLD.expires_at THEN
    RAISE EXCEPTION 'A shortened retention only brings an expiry forward' USING ERRCODE='42501';END IF;
   RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-'turn_count'-'last_message_at'-'expires_at') IS DISTINCT FROM (to_jsonb(OLD)-'turn_count'-'last_message_at'-'expires_at') THEN
   RAISE EXCEPTION 'Only a new turn changes a chat' USING ERRCODE='42501';END IF;
  IF NEW.turn_count IS DISTINCT FROM OLD.turn_count+1 THEN RAISE EXCEPTION 'A chat grows one turn at a time' USING ERRCODE='42501';END IF;
  IF OLD.expires_at<=now() THEN RAISE EXCEPTION 'An expired chat is not continued' USING ERRCODE='42501';END IF;
 END IF;
 NEW.last_message_at:=now();
 NEW.expires_at:=now()+make_interval(days=>app.teras_chat_keep_days(NEW.tenant_id));
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_chat_stamp() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_chat_stamp BEFORE INSERT OR UPDATE ON public.teras_chat
 FOR EACH ROW EXECUTE FUNCTION app.teras_chat_stamp();
--> statement-breakpoint
-- 3. One turn of a stored chat, numbered from 1 in the chat's order. A withheld turn is the marker only; any other turn
--    holds all three ciphertexts (a missing one makes the check false, never unknown). Ciphertexts are base64url tokens
--    (lib/ai/crypto.ts), never readable text, and bounded in size.
CREATE TABLE public.teras_chat_turn (
 tenant_id uuid NOT NULL,
 app_user_id uuid NOT NULL,
 chat_id uuid NOT NULL,
 seq integer NOT NULL CHECK (seq BETWEEN 1 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(),
 withheld boolean NOT NULL,
 question_ciphertext text,
 reply_ciphertext text,
 model_ciphertext text,
 PRIMARY KEY (tenant_id,chat_id,seq),
 FOREIGN KEY (tenant_id,app_user_id,chat_id) REFERENCES public.teras_chat(tenant_id,app_user_id,id) ON DELETE CASCADE,
 CHECK (CASE WHEN withheld THEN question_ciphertext IS NULL AND reply_ciphertext IS NULL AND model_ciphertext IS NULL
  ELSE coalesce(question_ciphertext ~ '^[A-Za-z0-9_-]{40,}$' AND reply_ciphertext ~ '^[A-Za-z0-9_-]{40,}$' AND model_ciphertext ~ '^[A-Za-z0-9_-]{40,}$',false) END),
 CHECK (octet_length(coalesce(question_ciphertext,''))<=32768 AND octet_length(coalesce(reply_ciphertext,''))<=131072
  AND octet_length(coalesce(model_ciphertext,''))<=262144)
);
--> statement-breakpoint
CREATE FUNCTION app.teras_chat_turn_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'A stored chat turn is never changed' USING ERRCODE='42501'; END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_chat_turn_immutable() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_chat_turn_immutable BEFORE UPDATE ON public.teras_chat_turn
 FOR EACH ROW EXECUTE FUNCTION app.teras_chat_turn_immutable();
--> statement-breakpoint
-- 4. The chat's task memory (teras_task_memory, keyed by the same conversation id) goes with the chat, whichever path
--    removed it: the person's own deletion or erasure, retention, person erasure, or the login's deletion. Definer
--    rights because the retention and erasure paths are not the login; it only deletes that one conversation's memory.
CREATE FUNCTION app.teras_chat_memory_erased() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 DELETE FROM public.teras_task_memory m WHERE m.tenant_id=OLD.tenant_id AND m.app_user_id=OLD.app_user_id AND m.conversation_id=OLD.id::text;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_chat_memory_erased() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_chat_memory_erased AFTER DELETE ON public.teras_chat
 FOR EACH ROW EXECUTE FUNCTION app.teras_chat_memory_erased();
--> statement-breakpoint
-- 4b. A shortened "Keep chats for" applies to every chat of the tenant at once: each expiry later than the last message
--     plus the new days is brought forward to it (when that is already past, the chat is expired now and the next
--     retention pass deletes it). A longer value changes no stored expiry. It fires only after the group administrator's
--     own write passed the setting's policies. Definer rights because the chats belong to other logins, scoped by a
--     transaction-local marker that the restamp policies below and app.teras_chat_stamp require. expires_at only.
CREATE FUNCTION app.teras_chat_retention_applied() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous integer:=30;
BEGIN
 IF TG_OP='UPDATE' THEN previous:=OLD.keep_days;END IF;
 IF NEW.keep_days>=previous THEN RETURN NULL;END IF;
 PERFORM set_config('app.teras_chat_restamp',NEW.tenant_id::text,true);
 UPDATE public.teras_chat c SET expires_at=c.last_message_at+make_interval(days=>NEW.keep_days)
  WHERE c.tenant_id=NEW.tenant_id AND c.expires_at>c.last_message_at+make_interval(days=>NEW.keep_days);
 PERFORM set_config('app.teras_chat_restamp','',true);
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_chat_retention_applied() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_chat_retention_applied AFTER INSERT OR UPDATE OF keep_days ON public.teras_chat_retention
 FOR EACH ROW EXECUTE FUNCTION app.teras_chat_retention_applied();
--> statement-breakpoint
-- 5. Person erasure. Joins the existing admitted erasure in THIS transaction (app.assistant_own_leave_reviews_redact
--    records the intent; the canonical pii.erased audit is required at commit), exactly as app.assistant_transcripts_redact
--    does. Deletes every chat of the person (by the original person, or the current person of a login whose chat
--    recorded none) and that person's logins' task memory; returns the number of chats. It reads no turn.
CREATE FUNCTION app._teras_chat_erasure_subject(p_tenant uuid,p_user uuid,p_person uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i
  WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=p_tenant AND i.user_id=app.current_user_id()
   AND (i.person_id=p_person OR (p_person IS NULL AND EXISTS(SELECT 1 FROM public.app_user u
    WHERE u.id=p_user AND u.tenant_id=p_tenant AND u.person_id=i.person_id))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._teras_chat_erasure_subject(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
-- EXECUTE only so an application query's policy check can be planned; it answers only for the caller's own
-- transaction and the erasure policy below also requires the table owner as the current user.
GRANT EXECUTE ON FUNCTION app._teras_chat_erasure_subject(uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.teras_chats_redact(subject_employment uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.assistant_review_erasure_intent%ROWTYPE;n integer;
BEGIN
 SELECT * INTO i FROM app.assistant_review_erasure_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id()
  AND user_id=app.current_user_id() AND employment_id=subject_employment;
 IF NOT FOUND OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(subject_employment) IS NOT TRUE THEN
  RAISE EXCEPTION 'Chat erasure admission unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM public.teras_chat c WHERE c.tenant_id=i.tenant_id AND app._teras_chat_erasure_subject(c.tenant_id,c.app_user_id,c.person_id);
 GET DIAGNOSTICS n=ROW_COUNT;
 DELETE FROM public.teras_task_memory m WHERE m.tenant_id=i.tenant_id
  AND m.app_user_id IN (SELECT u.id FROM public.app_user u WHERE u.tenant_id=i.tenant_id AND u.person_id=i.person_id);
 RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_chats_redact(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_chats_redact(uuid) TO ai_hr_app;
--> statement-breakpoint
-- ── RLS: forced on every table ──
ALTER TABLE public.teras_chat_retention ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_chat_retention FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_chat ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_chat FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_chat_turn ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_chat_turn FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The setting: readable in the tenant; written only by a current group administrator as themself (the 0890 pattern).
CREATE POLICY teras_chat_retention_read ON public.teras_chat_retention FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY teras_chat_retention_admin_insert ON public.teras_chat_retention FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.is_group_admin()
  AND app.principal_snapshot_current() IS TRUE AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_chat_retention_admin_update ON public.teras_chat_retention FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.is_group_admin() AND app.principal_snapshot_current() IS TRUE)
 WITH CHECK (tenant_id=app.current_tenant_id() AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
-- Chats: the login's own, and only while that login's principal snapshot is current for any change.
CREATE POLICY teras_chat_own_read ON public.teras_chat FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_chat_own_start ON public.teras_chat FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app_user_id=app.current_user_id()
  AND app.principal_snapshot_current() IS TRUE
  AND person_id IS NOT DISTINCT FROM (SELECT u.person_id FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY teras_chat_own_turn ON public.teras_chat FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app_user_id=app.current_user_id() AND app.principal_snapshot_current() IS TRUE)
 WITH CHECK (tenant_id=app.current_tenant_id() AND app_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_chat_own_delete ON public.teras_chat FOR DELETE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app_user_id=app.current_user_id() AND app.principal_snapshot_current() IS TRUE);
--> statement-breakpoint
-- Retention: the physical owner's own session (scripts/ai-retention-runner.ts) sees and deletes expired chats only.
CREATE POLICY teras_chat_expired_owner_read ON public.teras_chat FOR SELECT TO PUBLIC
 USING (current_user=session_user AND session_user<>'ai_hr_app'
  AND session_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.teras_chat'::regclass))
  AND expires_at<=now());
--> statement-breakpoint
CREATE POLICY teras_chat_expired_owner_delete ON public.teras_chat FOR DELETE TO PUBLIC
 USING (current_user=session_user AND session_user<>'ai_hr_app'
  AND session_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.teras_chat'::regclass))
  AND expires_at<=now());
--> statement-breakpoint
-- Person erasure: only the table owner as current user (app.teras_chats_redact), only the admitted subject's chats.
CREATE POLICY teras_chat_person_erasure_read ON public.teras_chat FOR SELECT TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.teras_chat'::regclass))
  AND app._teras_chat_erasure_subject(tenant_id,app_user_id,person_id));
--> statement-breakpoint
CREATE POLICY teras_chat_person_erasure_delete ON public.teras_chat FOR DELETE TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.teras_chat'::regclass))
  AND app._teras_chat_erasure_subject(tenant_id,app_user_id,person_id));
--> statement-breakpoint
-- Shortened retention: only the table owner as current user (app.teras_chat_retention_applied), only the tenant whose
-- setting this transaction shortened, and only expires_at (app.teras_chat_stamp refuses anything else).
CREATE POLICY teras_chat_restamp_read ON public.teras_chat FOR SELECT TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.teras_chat'::regclass))
  AND tenant_id::text=current_setting('app.teras_chat_restamp',true));
--> statement-breakpoint
CREATE POLICY teras_chat_restamp ON public.teras_chat FOR UPDATE TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.teras_chat'::regclass))
  AND tenant_id::text=current_setting('app.teras_chat_restamp',true))
 WITH CHECK (tenant_id::text=current_setting('app.teras_chat_restamp',true));
--> statement-breakpoint
-- Turns: the login reads its own and appends the turn its chat has just counted. No other policy exists: the owner,
-- the retention session and the erasure function never see a turn; turns leave only with their chat.
CREATE POLICY teras_chat_turn_own_read ON public.teras_chat_turn FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_chat_turn_own_append ON public.teras_chat_turn FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app_user_id=app.current_user_id()
  AND app.principal_snapshot_current() IS TRUE
  AND EXISTS (SELECT 1 FROM public.teras_chat c WHERE c.tenant_id=teras_chat_turn.tenant_id AND c.id=teras_chat_turn.chat_id
   AND c.app_user_id=teras_chat_turn.app_user_id AND c.turn_count=teras_chat_turn.seq));
--> statement-breakpoint
-- ── Grants: exactly what each table needs, everything else revoked ──
REVOKE ALL ON public.teras_chat_retention,public.teras_chat,public.teras_chat_turn FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON public.teras_chat_retention TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON public.teras_chat TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE (turn_count) ON public.teras_chat TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.teras_chat_turn TO ai_hr_app;

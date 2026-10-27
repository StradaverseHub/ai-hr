-- Assistant transcript retention (N10). Journaled after 0655 (conversation candidates, including its
-- own-invalidation bridge).
-- Explicit owner decision: raw Assistant chat content retires after30days. Accounting survives.
-- LOCKING (deliberate, for the integrator): drizzle applies this file in one transaction, so CREATE INDEX
-- CONCURRENTLY is unavailable. ADD COLUMN (nullable, no default) is catalog-only, but ADD CONSTRAINT
-- validates every existing row and the plain CREATE INDEX scans the table, all under the ACCESS EXCLUSIVE
-- lock ADD COLUMN takes and holds to COMMIT: new Assistant exchanges (and own-history reads) wait for
-- that scan. Kept plain because assistant_exchange rows are per-question and the per-user daily cap
-- bounds growth; the actual installed row count/size is UNKNOWN here. Measure it on the target before
-- applying; if the scan is not acceptably short, build the index in a separate operator step outside
-- the migration transaction instead. NOT VALID would not shorten this transaction's lock.
ALTER TABLE public.assistant_exchange ADD COLUMN content_retired_at timestamptz;
ALTER TABLE public.assistant_exchange ADD CONSTRAINT assistant_exchange_retired_content CHECK(
 content_retired_at IS NULL OR(question='' AND answer IS NULL AND tool_calls='[]'::jsonb AND disclosure_receipt IS NULL AND error IS NULL));
CREATE INDEX assistant_transcript_expiry ON public.assistant_exchange(tenant_id,asked_at,id) WHERE content_retired_at IS NULL;
--> statement-breakpoint
-- ORIGINAL identity custody, not current-link guesses. No copied transcript or HR values.
CREATE TABLE app.assistant_transcript_identity(
 exchange_id uuid PRIMARY KEY REFERENCES public.assistant_exchange(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),user_id uuid NOT NULL REFERENCES public.app_user(id),
 person_id uuid REFERENCES public.person(id)
);
ALTER TABLE app.assistant_transcript_identity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.assistant_transcript_identity FROM PUBLIC,ai_hr_app;
-- Only an existing actual completed strategy binding establishes original historical identity.
-- One atomic DO statement owns CREATE→backfill→DROP even with statement-autocommit tooling.
-- FORCE RLS gets no lasting/app-role exception. A mismatched nonsuper physical owner may see no
-- markers; absence is legacy UNKNOWN, never proof of complete historical identity capture.
DO $backfill$
BEGIN
 EXECUTE 'CREATE POLICY transcript_identity_migration_read ON public.ai_assistant_answer_strategy_use FOR SELECT TO PUBLIC USING(current_user=session_user AND current_user=pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid=''public.ai_assistant_answer_strategy_use''::regclass)))';
 INSERT INTO app.assistant_transcript_identity(exchange_id,tenant_id,user_id,person_id)
 SELECT e.id,e.tenant_id,e.app_user_id,s.person_id FROM public.assistant_exchange e
 JOIN public.ai_assistant_answer_strategy_use s ON s.exchange_id=e.id AND s.tenant_id=e.tenant_id AND s.user_id=e.app_user_id
 WHERE s.state='completed';
 EXECUTE 'DROP POLICY transcript_identity_migration_read ON public.ai_assistant_answer_strategy_use';
END $backfill$;
--> statement-breakpoint
CREATE FUNCTION app.assistant_transcript_source_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor_person uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  -- asked_at is both the 30-day retention clock and the per-user daily-question key. The legacy 0451
  -- self-row UPDATE grant must not let any caller defer retirement or replenish an allowance.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.app_user_id IS DISTINCT FROM OLD.app_user_id OR NEW.asked_at IS DISTINCT FROM OLD.asked_at THEN RAISE EXCEPTION 'Transcript source identity immutable' USING ERRCODE='42501';END IF;
  IF OLD.content_retired_at IS NOT NULL AND NEW.content_retired_at IS DISTINCT FROM OLD.content_retired_at THEN RAISE EXCEPTION 'Retired transcript cannot reopen' USING ERRCODE='42501';END IF;
  RETURN NEW;
 END IF;
 -- Existing self-only INSERT RLS remains the app authority boundary. Physical database owners
 -- retain ordinary restore/fixture rights; this trigger grants no new role or bypass capability.
 SELECT u.person_id INTO actor_person FROM public.app_user u WHERE u.id=NEW.app_user_id AND u.tenant_id=NEW.tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Transcript source identity unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=NEW.tenant_id AND i.person_id=actor_person)
 OR EXISTS(SELECT 1 FROM public.domain_event e WHERE e.tenant_id=NEW.tenant_id AND e.event_type='pii.erased' AND e.aggregate_type='person' AND e.aggregate_id=actor_person AND e.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'Transcript unavailable after erasure' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assistant_transcript_source_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_transcript_source_guard BEFORE INSERT OR UPDATE ON public.assistant_exchange FOR EACH ROW EXECUTE FUNCTION app.assistant_transcript_source_guard();
CREATE FUNCTION app.assistant_transcript_source_capture() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 INSERT INTO app.assistant_transcript_identity(exchange_id,tenant_id,user_id,person_id)
 SELECT NEW.id,NEW.tenant_id,NEW.app_user_id,u.person_id FROM public.app_user u WHERE u.id=NEW.app_user_id AND u.tenant_id=NEW.tenant_id;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.assistant_transcript_source_capture() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_transcript_source_capture AFTER INSERT ON public.assistant_exchange FOR EACH ROW EXECUTE FUNCTION app.assistant_transcript_source_capture();
--> statement-breakpoint
-- Ephemeral exact-row scope permits only this private retirement owner through FORCE RLS.
CREATE TABLE app.assistant_transcript_retirement_scope(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,exchange_id uuid NOT NULL,PRIMARY KEY(xact_id,tenant_id,exchange_id));
ALTER TABLE app.assistant_transcript_retirement_scope ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.assistant_transcript_retirement_scope FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.assistant_transcript_retirement_visible(tid uuid,eid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.assistant_transcript_retirement_scope s WHERE s.xact_id=pg_current_xact_id() AND s.tenant_id=tid AND s.exchange_id=eid)
$$;
REVOKE ALL ON FUNCTION app.assistant_transcript_retirement_visible(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_transcript_retirement_visible(uuid,uuid) TO ai_hr_app;
CREATE POLICY transcript_retirement_feedback_read ON public.ai_agent_feedback FOR SELECT TO PUBLIC USING(app.assistant_transcript_retirement_visible(tenant_id,exchange_id));
CREATE POLICY transcript_retirement_feedback_delete ON public.ai_agent_feedback FOR DELETE TO PUBLIC USING(app.assistant_transcript_retirement_visible(tenant_id,exchange_id));
CREATE POLICY transcript_retirement_strategy_read ON public.ai_assistant_answer_strategy_use FOR SELECT TO PUBLIC USING(app.assistant_transcript_retirement_visible(tenant_id,exchange_id));
CREATE POLICY transcript_retirement_strategy_delete ON public.ai_assistant_answer_strategy_use FOR DELETE TO PUBLIC USING(app.assistant_transcript_retirement_visible(tenant_id,exchange_id));
CREATE FUNCTION app._assistant_transcript_bounds() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Transcript write transaction unavailable';END IF;
 IF current_setting('statement_timeout')::interval=interval '0' OR current_setting('statement_timeout')::interval>interval '5 seconds' THEN PERFORM set_config('statement_timeout','5s',true);END IF;
 IF current_setting('lock_timeout')::interval=interval '0' OR current_setting('lock_timeout')::interval>interval '500 milliseconds' THEN PERFORM set_config('lock_timeout','500ms',true);END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_transcript_bounds() FROM PUBLIC,ai_hr_app;
-- Every owner below that applies these bounds restores the caller's prior statement_timeout and
-- lock_timeout before it returns, so the bounds never outlive the owner in the caller's transaction.
--> statement-breakpoint
-- linked_markers=false ONLY for same-Tx PDPA composition: the shared bridge
-- app.assistant_conversation_metadata_redact then deletes AND audits the subject's markers/intents/arms.
-- Deleting them here first would hide them from its count and under-report assistantConversationLearning.
CREATE FUNCTION app._assistant_transcripts_retire(tid uuid,ids uuid[],linked_markers boolean) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n integer;saved_statement text:=current_setting('statement_timeout');saved_lock text:=current_setting('lock_timeout');
BEGIN
 PERFORM app._assistant_transcript_bounds();
 IF tid IS NULL OR ids IS NULL OR linked_markers IS NULL THEN RAISE EXCEPTION 'Transcript retirement unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_transcript_retirement_scope(xact_id,tenant_id,exchange_id) SELECT pg_current_xact_id(),tid,e.id FROM public.assistant_exchange e WHERE e.tenant_id=tid AND e.id=ANY(ids);
 -- Content and replay proof retire atomically; identity/dates/usage and financial rows stay intact.
 UPDATE public.assistant_exchange e SET question='',answer=NULL,tool_calls='[]'::jsonb,disclosure_receipt=NULL,error=NULL,content_retired_at=clock_timestamp()
 WHERE e.tenant_id=tid AND e.id=ANY(ids) AND e.content_retired_at IS NULL;
 GET DIAGNOSTICS n=ROW_COUNT;
 DELETE FROM public.ai_agent_feedback f WHERE f.tenant_id=tid AND f.exchange_id=ANY(ids);
 IF linked_markers THEN DELETE FROM public.ai_assistant_answer_strategy_use s WHERE s.tenant_id=tid AND s.exchange_id=ANY(ids);END IF;
 DELETE FROM app.assistant_transcript_identity i WHERE i.tenant_id=tid AND i.exchange_id=ANY(ids);
 DELETE FROM app.assistant_transcript_retirement_scope s WHERE s.xact_id=pg_current_xact_id() AND s.tenant_id=tid AND s.exchange_id=ANY(ids);
 PERFORM set_config('statement_timeout',saved_statement,true),set_config('lock_timeout',saved_lock,true);
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app._assistant_transcripts_retire(uuid,uuid[],boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_transcripts_erase_own() RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();ids uuid[];retired integer;
 saved_statement text:=current_setting('statement_timeout');saved_lock text:=current_setting('lock_timeout');
BEGIN
 PERFORM app._assistant_transcript_bounds();
 IF tid IS NULL OR uid IS NULL THEN RAISE EXCEPTION 'Own transcript retirement unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||tid::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=uid AND u.tenant_id=tid AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Own transcript retirement unavailable' USING ERRCODE='42501';END IF;
 -- Invalidate ALL own pending bindings. Main's actual each-turn/completion check must require the
 -- same pending marker, in this same Access interval, so in-flight raw content cannot resurrect.
 PERFORM app.assistant_answer_invalidate_own_strategy_uses();
 SELECT coalesce(array_agg(e.id ORDER BY e.id),'{}'::uuid[]) INTO ids FROM public.assistant_exchange e WHERE e.tenant_id=tid AND e.app_user_id=uid AND e.content_retired_at IS NULL;
 retired:=app._assistant_transcripts_retire(tid,ids,true);
 PERFORM set_config('statement_timeout',saved_statement,true),set_config('lock_timeout',saved_lock,true);
 RETURN retired;
END $$;
REVOKE ALL ON FUNCTION app.assistant_transcripts_erase_own() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_transcripts_erase_own() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_transcripts_redact(subject_employment uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.assistant_review_erasure_intent%ROWTYPE;ids uuid[];retired integer;
 saved_statement text:=current_setting('statement_timeout');saved_lock text:=current_setting('lock_timeout');
BEGIN
 PERFORM app._assistant_transcript_bounds();
 SELECT * INTO i FROM app.assistant_review_erasure_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND employment_id=subject_employment;
 IF NOT FOUND OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(subject_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Transcript erasure admission unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||i.tenant_id::text,0));
 -- Known original PERSON wins over later account relinking. Legacy rows without original custody
 -- can only use actual current USER→PERSON membership; free text is never parsed as identity.
 SELECT coalesce(array_agg(e.id ORDER BY e.id),'{}'::uuid[]) INTO ids FROM public.assistant_exchange e
 LEFT JOIN app.assistant_transcript_identity original ON original.exchange_id=e.id AND original.tenant_id=e.tenant_id
 WHERE e.tenant_id=i.tenant_id AND e.content_retired_at IS NULL AND(original.person_id=i.person_id OR(original.exchange_id IS NULL AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=e.app_user_id AND u.tenant_id=i.tenant_id AND u.person_id=i.person_id)));
 -- Pending/completed markers, evaluation intents and arms are NOT deleted here: core/pdpa.ts calls the
 -- shared bridge app.assistant_conversation_metadata_redact next in this same Tx, which owns their
 -- original/current PERSON predicate and the audited assistantConversationLearning count.
 -- Existing admitted review-erasure intent requires the canonical pii.erased audit at commit.
 retired:=app._assistant_transcripts_retire(i.tenant_id,ids,false);
 PERFORM set_config('statement_timeout',saved_statement,true),set_config('lock_timeout',saved_lock,true);
 RETURN retired;
END $$;
REVOKE ALL ON FUNCTION app.assistant_transcripts_redact(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_transcripts_redact(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Internal physical-owner only: fixed approved30day raw-content policy, bounded batch; NO app grant.
-- Identity matches core/ai-retention-maintenance's ownership proof: the session is a superuser, or it is
-- BOTH this function's owner and public.assistant_exchange's physical owner. An app session reaching this
-- through any other definer keeps session_user=ai_hr_app and is refused. NULL inputs refuse.
CREATE FUNCTION app.assistant_transcripts_retire_expired(wanted_tenant uuid,retention_days integer,row_limit integer) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ids uuid[];retired integer;
 saved_statement text:=current_setting('statement_timeout');saved_lock text:=current_setting('lock_timeout');
BEGIN
 PERFORM app._assistant_transcript_bounds();
 IF wanted_tenant IS NULL OR session_user='ai_hr_app' OR NOT(
  coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname=session_user),false)
  OR(current_user=session_user AND EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid='public.assistant_exchange'::regclass AND pg_get_userbyid(c.relowner)=session_user)))
 OR retention_days IS DISTINCT FROM 30 OR row_limit IS NULL OR row_limit<1 OR row_limit>100 THEN RAISE EXCEPTION 'Transcript maintenance unavailable' USING ERRCODE='42501';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||wanted_tenant::text,0)) THEN RAISE EXCEPTION 'Transcript maintenance busy' USING ERRCODE='55P03';END IF;
 SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO ids FROM(SELECT e.id FROM public.assistant_exchange e WHERE e.tenant_id=wanted_tenant AND e.content_retired_at IS NULL AND e.asked_at<=clock_timestamp()-make_interval(days=>retention_days) ORDER BY e.asked_at,e.id LIMIT row_limit FOR UPDATE SKIP LOCKED) selected;
 retired:=app._assistant_transcripts_retire(wanted_tenant,ids,true);
 PERFORM set_config('statement_timeout',saved_statement,true),set_config('lock_timeout',saved_lock,true);
 RETURN retired;
END $$;
REVOKE ALL ON FUNCTION app.assistant_transcripts_retire_expired(uuid,integer,integer) FROM PUBLIC,ai_hr_app;

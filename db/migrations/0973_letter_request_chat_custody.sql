-- AI v2 Phase 2 wave 2: letter requests in the AI Centre chat custody and retention model. Provisional DEVELOPMENT source
-- allocation 0973 / when1793330000373 (docs/MIGRATION-ALLOCATION.md, "letters chat custody"), assigned by the AI v2
-- coordinator. It grants no installation, and the journal position is re-frozen at integration. Production is held.
--
-- WHAT A LETTER REQUEST FROM CHAT LEAVES BEHIND, AND WHICH CLASS EACH PART IS IN.
--  - The prepared card (core/proposals/letter-request.ts) is a signed proposal, good for ten minutes. It is never a
--    database row of its own: the browser holds it, and the harness keeps an open card in the conversation's task memory
--    (teras_task_memory.openProposals). CHAT-LINKED: the 0952 delete trigger already removes that memory with its chat,
--    on every path that removes a chat. Nothing here is needed for it.
--  - letter_request.client_key is the card's own id (Confirm passes it so a repeated Confirm is the same request,
--    core/assistant-actions/letter-request-proposal-confirm.ts). It is the only thing on the request that ties it to a
--    chat card, and it is needed only while the card can still be confirmed. CHAT-LINKED: it must not outlive the chat.
--    Before this migration it stayed on the request for good. This migration clears it when the chat goes.
--  - The request itself (letter type, purpose, status, HR's linked letter, decline reason and message, who handled it,
--    version, times) and its letter-request.* events. THE HR RECORD: it follows the letters domain's own retention and is
--    never deleted or changed when a chat is. Its events never carried the card id.
--
-- HOW. When a stored chat row is deleted, by any path (the person deleting one chat or erasing all of theirs, which leave
-- a tombstone; the retention runner, scripts/ai-retention-runner.ts, for an expired chat; person erasure,
-- app.teras_chats_redact; or the login's deletion, by cascade), an AFTER DELETE trigger on teras_chat clears client_key on
-- that login's own letter requests confirmed since the chat started (ten minutes earlier, the card's life, as a margin).
-- There is no stored chat-to-request link and none is added: the card id lives only in the chat's task memory, so the
-- requests that could have come from the chat are those of the same login confirmed after it started. That may also clear
-- the key of a request confirmed from a later chat; a key outlives its card by design only for ten minutes, so the most a
-- wider clear can do is turn a repeated Confirm of a still-open card into the "already requested" refusal
-- (letter_request_open_uq). It never touches another login's request, another tenant's, or any column but client_key.
--
-- Definer rights because neither the retention runner nor the erasing administrator nor the person (an employee holds no
-- UPDATE on letter_request) may otherwise write the request. It is scoped by a transaction-local marker naming the tenant
-- and login of the deleted chat, which the two owner-only policies below and the guard's new branch require; it changes
-- client_key only, to NULL, and bumps neither the request's version nor its status time, so HR's view is unchanged.
-- Grants: unchanged. The application role still holds no UPDATE on client_key; nothing new is granted to anyone.
--
-- Writers reviewed before each change: core/letter-requests.ts (insert with client_key; status changes), core/letters.ts
-- through linkLetterRequestDraftTx (status, letter), app.letter_request_issued (status) and, new here,
-- app.teras_chat_letter_card_keys_forgotten (client_key to NULL). The guard below is 0961's, unchanged but for one branch
-- at the top of UPDATE.

-- 1. The guard: 0961's lifecycle, plus one owner-side change. Under the marker for the request's own tenant and login,
--    and not as the application role, client_key may go from a value to NULL with nothing else changing, on a request in
--    any status (an issued or declined request is final for HR, not for the card id).
CREATE OR REPLACE FUNCTION app.letter_request_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE type_name text;linked_state text;
BEGIN
 IF TG_OP='UPDATE' AND current_user<>'ai_hr_app' AND OLD.client_key IS NOT NULL AND NEW.client_key IS NULL
   AND current_setting('app.letter_request_card_keys',true)=OLD.tenant_id::text||':'||OLD.requested_by::text
   AND (to_jsonb(NEW)-'client_key') IS NOT DISTINCT FROM (to_jsonb(OLD)-'client_key') THEN
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN
  NEW.status:='requested';NEW.letter_id:=NULL;NEW.decline_reason:=NULL;NEW.employee_message:=NULL;NEW.handled_by:=NULL;
  NEW.created_at:=now();NEW.status_changed_at:=now();NEW.version:=1;NEW.purpose:=nullif(btrim(NEW.purpose),'');
  type_name:=app._letter_request_type_name(NEW.tenant_id,NEW.company_id,NEW.template_id);
  IF type_name IS NULL THEN RAISE EXCEPTION 'This letter type is not open for employee requests' USING ERRCODE='23514';END IF;
  NEW.letter_type_name:=type_name;RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','letter_id','decline_reason','employee_message','handled_by','status_changed_at','version'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','letter_id','decline_reason','employee_message','handled_by','status_changed_at','version']) THEN
  RAISE EXCEPTION 'Only the status of a letter request changes' USING ERRCODE='42501';END IF;
 IF OLD.status IN ('issued','declined') THEN RAISE EXCEPTION 'A letter request that is issued or declined is final' USING ERRCODE='23514';END IF;
 IF NEW.status='in_progress' THEN
  IF NEW.letter_id IS NULL OR NEW.letter_id IS NOT DISTINCT FROM OLD.letter_id OR NEW.decline_reason IS NOT NULL OR NEW.employee_message IS NOT NULL THEN
   RAISE EXCEPTION 'Preparing a letter request links one new draft' USING ERRCODE='23514';END IF;
  IF OLD.letter_id IS NOT NULL AND app._letter_request_letter_state(OLD.letter_id)='issued' THEN
   RAISE EXCEPTION 'The linked letter is already issued' USING ERRCODE='23514';END IF;
  IF app._letter_request_letter_matches(NEW.letter_id,NEW.tenant_id,NEW.company_id,NEW.employment_id,NEW.template_id) IS NOT TRUE
    OR coalesce(app._letter_request_letter_state(NEW.letter_id),'') NOT IN ('draft','submitted','returned','approved') THEN
   RAISE EXCEPTION 'The draft is not this request''s letter' USING ERRCODE='23514';END IF;
  NEW.handled_by:=app.current_user_id();
 ELSIF NEW.status='declined' THEN
  NEW.decline_reason:=nullif(btrim(NEW.decline_reason),'');NEW.employee_message:=nullif(btrim(NEW.employee_message),'');
  IF NEW.decline_reason IS NULL OR NEW.letter_id IS DISTINCT FROM OLD.letter_id THEN
   RAISE EXCEPTION 'Declining a letter request needs a reason and keeps its letter link' USING ERRCODE='23514';END IF;
  NEW.handled_by:=app.current_user_id();
 ELSIF NEW.status='issued' THEN
  linked_state:=app._letter_request_letter_state(OLD.letter_id);
  IF OLD.status<>'in_progress' OR NEW.letter_id IS DISTINCT FROM OLD.letter_id OR linked_state IS DISTINCT FROM 'issued'
    OR NEW.handled_by IS DISTINCT FROM OLD.handled_by OR NEW.decline_reason IS NOT NULL OR NEW.employee_message IS NOT NULL THEN
   RAISE EXCEPTION 'A letter request is issued only with its letter' USING ERRCODE='23514';END IF;
 ELSE
  RAISE EXCEPTION 'Not an allowed letter request change' USING ERRCODE='23514';
 END IF;
 NEW.status_changed_at:=now();NEW.version:=OLD.version+1;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.letter_request_guard() FROM PUBLIC;
--> statement-breakpoint
-- 2. Owner-only visibility and the one write, under the marker only: the deleted chat's own tenant and login. The read
--    policy carries no client_key condition because PostgreSQL also checks an updated row against the read policies.
CREATE POLICY letter_request_card_key_read ON public.letter_request FOR SELECT TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.letter_request'::regclass))
  AND tenant_id::text||':'||requested_by::text=current_setting('app.letter_request_card_keys',true));
--> statement-breakpoint
CREATE POLICY letter_request_card_key_forget ON public.letter_request FOR UPDATE TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.letter_request'::regclass))
  AND tenant_id::text||':'||requested_by::text=current_setting('app.letter_request_card_keys',true) AND client_key IS NOT NULL)
 WITH CHECK (client_key IS NULL AND tenant_id::text||':'||requested_by::text=current_setting('app.letter_request_card_keys',true));
--> statement-breakpoint
-- 3. The chat goes, its card ids go: whichever path deleted the chat row. Clears client_key only; returns nothing.
CREATE FUNCTION app.teras_chat_letter_card_keys_forgotten() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM set_config('app.letter_request_card_keys',OLD.tenant_id::text||':'||OLD.app_user_id::text,true);
 UPDATE public.letter_request r SET client_key=NULL
  WHERE r.tenant_id=OLD.tenant_id AND r.requested_by=OLD.app_user_id AND r.client_key IS NOT NULL
   AND r.created_at>=OLD.created_at-interval '10 minutes';
 PERFORM set_config('app.letter_request_card_keys','',true);
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_chat_letter_card_keys_forgotten() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_chat_letter_card_keys_forgotten AFTER DELETE ON public.teras_chat
 FOR EACH ROW EXECUTE FUNCTION app.teras_chat_letter_card_keys_forgotten();

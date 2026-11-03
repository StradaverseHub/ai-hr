-- AI v2 Phase 2, P2-6: the learning loops and the AI quality page (owner decision, 3 November 2026: "the agents and AI
-- should have improvement loops and learning mechanism to keep improving").
-- Provisional DEVELOPMENT source allocation 0972 / when1793330000372 (docs/MIGRATION-ALLOCATION.md), reserved for the
-- learning loops by the AI v2 coordinator (wave 2). It grants no installation, and the journal position is re-frozen at
-- integration. Production is held.
--
-- THE OWNER'S LIMITS, AND HOW THIS SCHEMA KEEPS THEM.
--  - Learning never changes calculation code, permissions or disclosure rules: nothing here is read by a calculation, a
--    guard or the harness. These tables hold what people did with AI Centre's work and what administrators decided.
--  - Nothing learned crosses tenants: every row carries its tenant and company and every policy pins both. An eval
--    candidate leaves the tenant only as a file an administrator downloads after approving its redacted text.
--  - Every applied change is versioned and reversible: statuses and reviews are append-only versions (the latest wins,
--    and an earlier state is restored by a new version); a candidate's every change bumps its version.
--  - Gated sensitive turns store no words, so they are never learned from: every signal and gap row must name the outcome
--    record of the turn it came from, and the insert policies refuse a record that is private to the asker (a routed or
--    refused turn, migration 0905/0928), a record of another login, or a company other than the record's.
--
-- 1. teras_learning_signal: one row per thing a person did with AI Centre's work: confirmed a prepared card unchanged,
--    opened it to edit, discarded it, decided against a recommendation, or marked an answer helpful or not. Counts,
--    closed-vocabulary names and references only: no words, no figures. Written by the person, under their own login,
--    for their own turn's record. Read by the administrators of the record's company (app.is_admin_for), and by the person
--    who wrote it. Append-only, with two exceptions for an answer's mark: it may be changed once (a second row,
--    'answer_changed', which then counts instead of the first), and a "Not helpful" mark may gain its one optional reason
--    (wrong, not what I asked, missing something) once, by the person who made it (a column grant and a trigger).
-- 2. teras_learning_signal_review: an administrator's review of a signal (dismissed, reopened, made an eval candidate).
--    Append-only versions; the highest version is the signal's review state.
-- 3. teras_gap_occurrence: one row per turn AI Centre could not answer or do: an honest gap, a capability question it could
--    not meet, or a request with no route (suggest_action's no_match / not_available). The intent key is derived in code
--    from closed vocabularies (kind and product area), never from words. Written by the asker for their own record; read
--    by the company's administrators. No login, person or name is stored. Append-only.
-- 4. teras_gap_example: the question of a gap turn, REDACTED in code before it is written (names, ids, figures, dates,
--    emails and phone numbers replaced by placeholders, core/learning/redact.ts). It follows the asker's stored chat: it is
--    written only for a turn stored in the asker's own chat (teras_chat, 0952), keeps an internal link to that chat (never
--    shown, never exported), and goes with it: ON DELETE CASCADE removes it when the chat is deleted, erased by the person,
--    removed by retention or by person erasure. Its own expiry is the tenant's "Keep chats for" from when it was written (a
--    trigger stamps it), and a shortened setting expires it at once, so it never outlives its chat; an administrator's read
--    deletes every expired one before it reads. The gap's count (teras_gap_occurrence) stays. Never written
--    for a gated turn (the same record check).
-- 5. teras_gap_status: an administrator's status for one intent in one company: open, planned, won't do or duplicate (of
--    another intent). Append-only versions; the latest wins; setting it back to open is a new version.
-- 6. teras_eval_candidate: a question an administrator promoted to an eval candidate, with the corrected expectation,
--    the role and the locale, redacted and fictionalised. draft -> approved -> exported; withdrawn at any time before
--    export. Its text changes only while it is a draft, and every change bumps its version (a trigger). Only an approved
--    candidate is exported, as a file for a developer to add to test/assistant-smart-eval-set.ts. Nothing changes the
--    eval set or the prompt automatically.
--
-- Writers reviewed: every table is new; core/learning/* is their only writer.

-- ── Shared guards ──
-- Append-only: refuses UPDATE and DELETE (DELETE is allowed only where a policy and a grant admit it, see 4).
CREATE FUNCTION app.teras_learning_append_only() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION '% is append-only',TG_TABLE_NAME USING ERRCODE='42501'; END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_learning_append_only() FROM PUBLIC;
--> statement-breakpoint
-- The turn a learning row comes from: the current login's own, open (not private to the asker) outcome record of a
-- person's run, in this company. Invoker rights: teras_outcome_record's own policy (0928) lets a login read only its
-- own records here, so the check cannot see, or vouch for, anyone else's turn.
CREATE FUNCTION app.teras_learning_own_record(p_record uuid,p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL AND EXISTS(
  SELECT 1 FROM public.teras_outcome_record r
  WHERE r.id=p_record AND r.tenant_id=app.current_tenant_id() AND r.authority_kind='person'
   AND r.asked_by_user_id=app.current_user_id() AND r.private_to_asker IS FALSE AND r.company_id=p_company)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_learning_own_record(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_learning_own_record(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- An administrator of the company, under their own current login (never an agent principal).
CREATE FUNCTION app.teras_learning_admin(p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL AND app.is_admin_for(p_company) IS TRUE
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_learning_admin(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_learning_admin(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 1. Signals ──
CREATE TABLE public.teras_learning_signal (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 record_id uuid NOT NULL,
 -- One signal per record and key: a card ('card:' || proposal id), the answer ('answer'), the recommendation.
 signal_key text NOT NULL CHECK (signal_key ~ '^(card:[0-9a-f-]{36}|answer|answer_changed|recommendation)$'),
 kind text NOT NULL CHECK (kind IN ('card_confirmed','card_edited','card_discarded','recommendation_rejected','answer_helpful','answer_unhelpful')),
 action text NOT NULL CHECK (action ~ '^[a-z_-]{1,40}(\.[a-z_-]{1,40}){0,4}$'),
 area text NOT NULL CHECK (area ~ '^[a-z_]{1,40}$'),
 role text NOT NULL CHECK (role IN ('employee','manager','hr_admin','payroll','group_admin')),
 locale text NOT NULL CHECK (locale IN ('en','ms','zh','vi','ta','th')),
 proposal_id uuid,
 -- The optional reason of a "Not helpful" mark.
 reason text CHECK (reason IN ('wrong','not_what_asked','missing_something')),
 by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,record_id,signal_key),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 FOREIGN KEY (tenant_id,record_id) REFERENCES public.teras_outcome_record(tenant_id,id),
 CHECK ((signal_key LIKE 'card:%')=(kind IN ('card_confirmed','card_edited','card_discarded'))),
 CHECK ((signal_key IN ('answer','answer_changed'))=(kind IN ('answer_helpful','answer_unhelpful'))),
 CHECK (reason IS NULL OR kind='answer_unhelpful'),
 CHECK ((signal_key='recommendation')=(kind='recommendation_rejected')),
 CHECK ((proposal_id IS NOT NULL)=(signal_key LIKE 'card:%') AND (proposal_id IS NULL OR signal_key='card:'||proposal_id::text))
);
--> statement-breakpoint
CREATE INDEX teras_learning_signal_company_idx ON public.teras_learning_signal(tenant_id,company_id,at);
--> statement-breakpoint
-- Append-only, except that a "Not helpful" mark may gain its reason once, by the person who made it, within a day.
CREATE FUNCTION app.teras_learning_signal_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.kind='answer_unhelpful' AND OLD.reason IS NULL AND NEW.reason IS NOT NULL AND OLD.at>now()-interval '1 day'
  AND OLD.by_user_id=app.current_user_id()
  AND (to_jsonb(NEW)-'reason')=(to_jsonb(OLD)-'reason') THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'teras_learning_signal is append-only' USING ERRCODE='42501';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_learning_signal_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_learning_signal_append_only BEFORE UPDATE OR DELETE ON public.teras_learning_signal
 FOR EACH ROW EXECUTE FUNCTION app.teras_learning_signal_guard();
--> statement-breakpoint
ALTER TABLE public.teras_learning_signal ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_learning_signal FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY teras_learning_signal_read ON public.teras_learning_signal FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL
  AND (app.teras_learning_admin(company_id) OR by_user_id=app.current_user_id()));
--> statement-breakpoint
CREATE POLICY teras_learning_signal_own_insert ON public.teras_learning_signal FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE
  AND by_user_id=app.current_user_id() AND app.teras_learning_own_record(record_id,company_id));
--> statement-breakpoint
-- The person adds the reason to their own "Not helpful" mark (the trigger above allows nothing else).
CREATE POLICY teras_learning_signal_own_reason ON public.teras_learning_signal FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND by_user_id=app.current_user_id() AND kind='answer_unhelpful')
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE AND by_user_id=app.current_user_id()
  AND app.teras_learning_own_record(record_id,company_id));
--> statement-breakpoint
REVOKE ALL ON public.teras_learning_signal FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.teras_learning_signal TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE (reason) ON public.teras_learning_signal TO ai_hr_app;
--> statement-breakpoint

-- ── 2. Signal reviews ──
CREATE TABLE public.teras_learning_signal_review (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 signal_id uuid NOT NULL REFERENCES public.teras_learning_signal(id),
 decision text NOT NULL CHECK (decision IN ('dismissed','reopened','promoted')),
 version integer NOT NULL CHECK (version>=1),
 by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,signal_id,version),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id)
);
--> statement-breakpoint
CREATE TRIGGER teras_learning_signal_review_append_only BEFORE UPDATE OR DELETE ON public.teras_learning_signal_review
 FOR EACH ROW EXECUTE FUNCTION app.teras_learning_append_only();
--> statement-breakpoint
ALTER TABLE public.teras_learning_signal_review ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_learning_signal_review FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY teras_learning_signal_review_read ON public.teras_learning_signal_review FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.teras_learning_admin(company_id));
--> statement-breakpoint
-- The signal must be one of this company's (read under the administrator's own signal policy).
CREATE POLICY teras_learning_signal_review_insert ON public.teras_learning_signal_review FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE AND app.teras_learning_admin(company_id)
  AND by_user_id=app.current_user_id()
  AND EXISTS(SELECT 1 FROM public.teras_learning_signal s WHERE s.id=teras_learning_signal_review.signal_id
   AND s.tenant_id=teras_learning_signal_review.tenant_id AND s.company_id=teras_learning_signal_review.company_id));
--> statement-breakpoint
REVOKE ALL ON public.teras_learning_signal_review FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.teras_learning_signal_review TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Gap occurrences ──
CREATE TABLE public.teras_gap_occurrence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 record_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('cannot_answer','no_route','not_supported')),
 area text NOT NULL CHECK (area ~ '^[a-z_]{1,40}$'),
 intent_key text NOT NULL CHECK (intent_key ~ '^(cannot_answer|no_route|not_supported):[a-z_]{1,40}$' AND intent_key=kind||':'||area),
 role text NOT NULL CHECK (role IN ('employee','manager','hr_admin','payroll','group_admin')),
 locale text NOT NULL CHECK (locale IN ('en','ms','zh','vi','ta','th')),
 at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,record_id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 FOREIGN KEY (tenant_id,record_id) REFERENCES public.teras_outcome_record(tenant_id,id)
);
--> statement-breakpoint
CREATE INDEX teras_gap_occurrence_company_idx ON public.teras_gap_occurrence(tenant_id,company_id,intent_key,at);
--> statement-breakpoint
CREATE TRIGGER teras_gap_occurrence_append_only BEFORE UPDATE OR DELETE ON public.teras_gap_occurrence
 FOR EACH ROW EXECUTE FUNCTION app.teras_learning_append_only();
--> statement-breakpoint
ALTER TABLE public.teras_gap_occurrence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_gap_occurrence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY teras_gap_occurrence_read ON public.teras_gap_occurrence FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.teras_learning_admin(company_id));
--> statement-breakpoint
CREATE POLICY teras_gap_occurrence_own_insert ON public.teras_gap_occurrence FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE AND app.teras_learning_own_record(record_id,company_id));
--> statement-breakpoint
REVOKE ALL ON public.teras_gap_occurrence FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.teras_gap_occurrence TO ai_hr_app;
--> statement-breakpoint

-- ── 4. Redacted gap examples ──
CREATE TABLE public.teras_gap_example (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 record_id uuid NOT NULL,
 -- The asker's stored chat the question came from: internal only (never read out, never exported), so the example goes
 -- with the chat whichever way the chat is removed.
 chat_id uuid NOT NULL REFERENCES public.teras_chat(id) ON DELETE CASCADE,
 intent_key text NOT NULL CHECK (intent_key ~ '^(cannot_answer|no_route|not_supported):[a-z_]{1,40}$'),
 -- Redacted in code; no digit survives redaction, so none may be stored.
 text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 400 AND text !~ '[0-9]' AND text !~ '[@]'),
 redaction_version integer NOT NULL CHECK (redaction_version>=1),
 at timestamptz NOT NULL DEFAULT now(),
 -- Stamped by the trigger below; the default only satisfies NOT NULL before it runs.
 expires_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,record_id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 FOREIGN KEY (tenant_id,record_id) REFERENCES public.teras_gap_occurrence(tenant_id,record_id)
);
--> statement-breakpoint
CREATE INDEX teras_gap_example_company_idx ON public.teras_gap_example(tenant_id,company_id,intent_key,at);
--> statement-breakpoint
-- The tenant's "Keep chats for" (0952, default 30 days) decides how long an example is kept; the writer cannot choose.
CREATE FUNCTION app.teras_gap_example_stamp() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'A gap example is never changed' USING ERRCODE='42501'; END IF;
 NEW.at:=now();
 NEW.expires_at:=now()+make_interval(days=>app.teras_chat_keep_days(NEW.tenant_id));
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_gap_example_stamp() FROM PUBLIC;
--> statement-breakpoint
-- Whether an example is within the tenant's "Keep chats for" as it is NOW: a shortened setting expires older examples at
-- once, as it expires older chats at once (0952), without reading any chat (chats are their login's only).
CREATE FUNCTION app.teras_gap_example_kept(p_tenant uuid,p_at timestamptz) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_at+make_interval(days=>app.teras_chat_keep_days(p_tenant))>now()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_gap_example_kept(uuid,timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_gap_example_kept(uuid,timestamptz) TO ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER teras_gap_example_stamp BEFORE INSERT OR UPDATE ON public.teras_gap_example
 FOR EACH ROW EXECUTE FUNCTION app.teras_gap_example_stamp();
--> statement-breakpoint
ALTER TABLE public.teras_gap_example ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_gap_example FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- An administrator of the company reads its examples. The expiry is not repeated here: a DELETE that names its rows must
-- also pass this policy, so an expired example has to stay visible to the delete below. The one reader
-- (core/learning/quality.ts) deletes the expired examples first and filters on the same two conditions in the same
-- transaction.
CREATE POLICY teras_gap_example_read ON public.teras_gap_example FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.teras_learning_admin(company_id));
--> statement-breakpoint
-- The chat must be the asker's own (0952 lets a login read only its own chats).
CREATE POLICY teras_gap_example_own_insert ON public.teras_gap_example FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE AND app.teras_learning_own_record(record_id,company_id)
  AND EXISTS(SELECT 1 FROM public.teras_chat c WHERE c.id=teras_gap_example.chat_id AND c.tenant_id=teras_gap_example.tenant_id
   AND c.app_user_id=app.current_user_id()));
--> statement-breakpoint
-- Only an expired example (its own stamp, or the tenant's "Keep chats for" as it is now) is ever deleted directly, by an
-- administrator of its company.
CREATE POLICY teras_gap_example_expired_delete ON public.teras_gap_example FOR DELETE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.teras_learning_admin(company_id) AND (expires_at<=now() OR NOT app.teras_gap_example_kept(tenant_id,at)));
--> statement-breakpoint
REVOKE ALL ON public.teras_gap_example FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON public.teras_gap_example TO ai_hr_app;
--> statement-breakpoint

-- ── 5. Gap statuses ──
CREATE TABLE public.teras_gap_status (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 intent_key text NOT NULL CHECK (intent_key ~ '^(cannot_answer|no_route|not_supported):[a-z_]{1,40}$'),
 status text NOT NULL CHECK (status IN ('open','planned','wont_do','duplicate')),
 duplicate_of text CHECK (duplicate_of IS NULL OR duplicate_of ~ '^(cannot_answer|no_route|not_supported):[a-z_]{1,40}$'),
 version integer NOT NULL CHECK (version>=1),
 by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,company_id,intent_key,version),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK ((status='duplicate')=(duplicate_of IS NOT NULL)),
 CHECK (duplicate_of IS NULL OR duplicate_of<>intent_key)
);
--> statement-breakpoint
CREATE TRIGGER teras_gap_status_append_only BEFORE UPDATE OR DELETE ON public.teras_gap_status
 FOR EACH ROW EXECUTE FUNCTION app.teras_learning_append_only();
--> statement-breakpoint
ALTER TABLE public.teras_gap_status ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_gap_status FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY teras_gap_status_read ON public.teras_gap_status FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.teras_learning_admin(company_id));
--> statement-breakpoint
CREATE POLICY teras_gap_status_insert ON public.teras_gap_status FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE AND app.teras_learning_admin(company_id)
  AND by_user_id=app.current_user_id());
--> statement-breakpoint
REVOKE ALL ON public.teras_gap_status FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.teras_gap_status TO ai_hr_app;
--> statement-breakpoint

-- ── 6. Eval candidates ──
CREATE TABLE public.teras_eval_candidate (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 signal_id uuid REFERENCES public.teras_learning_signal(id),
 intent_key text CHECK (intent_key IS NULL OR intent_key ~ '^(cannot_answer|no_route|not_supported):[a-z_]{1,40}$'),
 role text NOT NULL CHECK (role IN ('employee','manager','hr_admin','payroll','group_admin')),
 locale text NOT NULL CHECK (locale IN ('en','ms','zh','vi','ta','th')),
 kind text NOT NULL CHECK (kind IN ('answer','do','clarify','guide','honest_gap','refuse')),
 factor text NOT NULL CHECK (factor IN ('facts','capability','doing','privacy_wording','brevity','language','safety')),
 -- Redacted in code (core/learning/redact.ts); no digit or e-mail sign survives redaction.
 question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 600 AND question !~ '[0-9@]'),
 expectation text NOT NULL CHECK (char_length(expectation) BETWEEN 1 AND 1200 AND expectation !~ '[0-9@]'),
 redaction_version integer NOT NULL CHECK (redaction_version>=1),
 state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','exported','withdrawn')),
 version integer NOT NULL DEFAULT 1 CHECK (version>=1),
 created_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 changed_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 changed_at timestamptz NOT NULL DEFAULT now(),
 approved_by_user_id uuid REFERENCES public.app_user(id),
 approved_at timestamptz,
 exported_by_user_id uuid REFERENCES public.app_user(id),
 exported_at timestamptz,
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK ((signal_id IS NULL)<>(intent_key IS NULL)),
 CHECK ((state IN ('approved','exported'))=(approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL)),
 CHECK ((state='exported')=(exported_at IS NOT NULL AND exported_by_user_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX teras_eval_candidate_one_per_signal ON public.teras_eval_candidate(tenant_id,signal_id) WHERE signal_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX teras_eval_candidate_company_idx ON public.teras_eval_candidate(tenant_id,company_id,state,changed_at);
--> statement-breakpoint
-- Every change is a new version by the current administrator. The text changes only on a draft that stays a draft; the
-- states move draft -> approved -> exported, approved -> draft (to edit again), and draft or approved -> withdrawn.
-- Exported and withdrawn are final. The tenant, company, origin, role and locale never change.
CREATE FUNCTION app.teras_eval_candidate_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'draft' OR NEW.version<>1 OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
   OR NEW.changed_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'A new eval candidate is a draft by the current administrator' USING ERRCODE='42501';
  END IF;
  NEW.created_at:=now(); NEW.changed_at:=now();
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'An eval candidate is never deleted' USING ERRCODE='42501'; END IF;
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.company_id<>OLD.company_id OR NEW.signal_id IS DISTINCT FROM OLD.signal_id
  OR NEW.intent_key IS DISTINCT FROM OLD.intent_key OR NEW.role<>OLD.role OR NEW.locale<>OLD.locale
  OR NEW.created_by_user_id<>OLD.created_by_user_id OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION 'An eval candidate keeps its origin' USING ERRCODE='42501';
 END IF;
 IF OLD.state IN ('exported','withdrawn') THEN RAISE EXCEPTION 'An eval candidate is final once exported or withdrawn' USING ERRCODE='42501'; END IF;
 IF NOT ((OLD.state='draft' AND NEW.state IN ('draft','approved','withdrawn'))
  OR (OLD.state='approved' AND NEW.state IN ('draft','exported','withdrawn'))) THEN
  RAISE EXCEPTION 'Eval candidate state % cannot become %',OLD.state,NEW.state USING ERRCODE='42501';
 END IF;
 IF (NEW.question<>OLD.question OR NEW.expectation<>OLD.expectation OR NEW.kind<>OLD.kind OR NEW.factor<>OLD.factor
  OR NEW.redaction_version<>OLD.redaction_version) AND NOT (OLD.state='draft' AND NEW.state='draft') THEN
  RAISE EXCEPTION 'An eval candidate''s text changes only while it is a draft' USING ERRCODE='42501';
 END IF;
 IF NEW.version<>OLD.version+1 OR NEW.changed_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Every eval candidate change is the next version, by the current administrator' USING ERRCODE='42501';
 END IF;
 IF NEW.state='approved' AND OLD.state<>'approved' AND NEW.approved_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'The approving administrator is the current one' USING ERRCODE='42501';
 END IF;
 IF NEW.state='exported' AND NEW.exported_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'The exporting administrator is the current one' USING ERRCODE='42501';
 END IF;
 NEW.changed_at:=now();
 IF NEW.state='approved' AND OLD.state<>'approved' THEN NEW.approved_at:=now(); END IF;
 IF NEW.state='exported' THEN NEW.exported_at:=now(); END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_eval_candidate_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_eval_candidate_guard BEFORE INSERT OR UPDATE OR DELETE ON public.teras_eval_candidate
 FOR EACH ROW EXECUTE FUNCTION app.teras_eval_candidate_guard();
--> statement-breakpoint
ALTER TABLE public.teras_eval_candidate ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_eval_candidate FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY teras_eval_candidate_read ON public.teras_eval_candidate FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.teras_learning_admin(company_id));
--> statement-breakpoint
-- A candidate comes from one of this company's signals or gap intents.
CREATE POLICY teras_eval_candidate_insert ON public.teras_eval_candidate FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE AND app.teras_learning_admin(company_id)
  AND (teras_eval_candidate.signal_id IS NULL OR EXISTS(SELECT 1 FROM public.teras_learning_signal s WHERE s.id=teras_eval_candidate.signal_id
   AND s.tenant_id=teras_eval_candidate.tenant_id AND s.company_id=teras_eval_candidate.company_id))
  AND (teras_eval_candidate.intent_key IS NULL OR EXISTS(SELECT 1 FROM public.teras_gap_occurrence o WHERE o.tenant_id=teras_eval_candidate.tenant_id
   AND o.company_id=teras_eval_candidate.company_id AND o.intent_key=teras_eval_candidate.intent_key)));
--> statement-breakpoint
CREATE POLICY teras_eval_candidate_update ON public.teras_eval_candidate FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.teras_learning_admin(company_id))
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE AND app.teras_learning_admin(company_id));
--> statement-breakpoint
REVOKE ALL ON public.teras_eval_candidate FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON public.teras_eval_candidate TO ai_hr_app;

-- Recruitment slice 18 (docs/recruitment-reconstruction/specification.md "Slice 18"): interview set-up — interviewer groups, a
-- question bank linked to scorecard templates, and the company's interview addresses and meeting rooms. No meeting-room or calendar
-- integration (D-058): rooms are AI HR's own list.
--
-- Who: recruitment administrators (app.can_admin_recruitment_for) write every set-up table; the database refuses anybody else
-- (row security) and pins company, tenant and author (guards below). Reads:
--   groups and their members  — administrators and the company's operators (recruiters and assistants schedule interviews and add
--                               a group's members as interviewers). A group grants NO access: no predicate reads these tables.
--   questions and their links — administrators and the company's job teams (interviewers read the linked questions as guidance on
--                               their scorecard form).
--   addresses and rooms       — administrators and the company's job teams (interview details show the address).
-- None of these tables holds candidate data, so app.recruitment_destroy_candidate is NOT restated. Interviews gain an address and a
-- room; an interview is removed with its candidate as before, which never touches an address or a room.
--
-- What this installs:
--   1. Six tables, each with tenant_id + company_id, a composite company key, ENABLE + FORCE row security, explicit GRANTs to
--      ai_hr_app and none to PUBLIC:
--        recruitment_interviewer_group         name (unique in the company, ≤80);
--        recruitment_interviewer_group_member  one row per member user; (group, company, tenant) composite key, so a member row
--                                               belongs to its group's company; ON DELETE CASCADE with its group; the user must have
--                                               access to the company when added (app.recruitment_user_in_company, guard below);
--        recruitment_interview_question        title ≤200, guidance ≤2,000, optional category ≤80, retired_at (retired questions
--                                               are hidden from scorecard forms and cannot gain links);
--        recruitment_interview_question_link   question × scorecard template (evaluation form), both of the same company (composite
--                                               keys); a linked question cannot be deleted (no cascade);
--        recruitment_interview_address         name ≤120 (unique in the company), address ≤500, region ≤120, optional map link that
--                                               must be https (CHECK; the pack validates the same);
--        recruitment_interview_room            per address (composite key (address, company, tenant)), name ≤120 (unique in the
--                                               address), capacity 1–1,000, enabled.
--   2. recruitment_interview.address_id and .room_id. Composite keys: the address is the interview's company's; the room is the
--      address's (key (room, address, company, tenant)). An address is for an on-site interview; a room needs an address. A NEW room
--      choice must be enabled (guard). A room is never booked for two interviews whose times overlap: an EXCLUSION constraint
--      (btree_gist, installed by 0001_rls_grants_constraints.sql and already used by 0426) over (room_id WITH =, the interview's
--      period WITH &&) WHERE the interview names a room and is not cancelled, so cancelling an interview frees the room. The period
--      is [starts_at, starts_at + duration) — half-open, so an interview ending at 10:00 and one starting at 10:00 in the same room
--      are allowed (touching is not overlapping). The constraint sees every interview, whatever the caller's row security, and is
--      race-free (two concurrent bookings cannot both commit). app.recruitment_interview_period is IMMUTABLE: adding a whole
--      number of MINUTES to a timestamptz does not depend on the session time zone (only day and month parts do).
--      PRECONDITION — public.recruitment_interview is empty wherever this applies: the recruitment tables are new in this release
--      block (5200–5218 are unapplied outside throwaway databases, CI and the branch author's local render database), so adding
--      the columns, keys and the exclusion constraint locks no populated table (as 5218's header states for its indexes). An
--      installation that already holds interviews must not apply this migration as written. The two plain indexes use CREATE INDEX
--      IF NOT EXISTS like 5218.
--   3. app.recruitment_user_in_company (SECURITY DEFINER, boolean only, for an administrator of the company): may this user be an
--      interviewer of the company — an active login employed by it, or holding recruitment administration covering it. A member
--      who later loses access stays listed (as for job team members) and is skipped when a group is added to an interview.
--   4. app.recruitment_delete_company_setup restated (5218 body byte for byte) plus one block: the question links, questions, group
--      members, groups, rooms and addresses, before the evaluation forms the links name.
--   5. Closing an application frees its rooms. The pack cancels an application's FUTURE open interviews in the same transaction
--      whenever it leaves 'active' (packs/recruitment/interview-closing.ts, from every path that rejects, archives or hires). A
--      hiring manager may close an application without operating the job, so a new UPDATE policy admits the job's reviewers and
--      the place guard admits from a non-operator only that cancellation (future, open, application no longer active, nothing
--      else changed).
--   6. app.recruitment_guard_interviewer restated (5202 body byte for byte plus one check): an interviewer is added only while the
--      application is active, so naming one on an interview of a closed application cannot grant read of the candidate.
--   0. The empty-table precondition below is CHECKED first: the migration refuses (55000) if recruitment_interview has rows.
--
-- Nothing here calls a model, scores a candidate or changes an application. Questions are guidance only: they are never answered
-- fields and add nothing to a scorecard's totals.

-- ── 0. Precondition: no interview exists yet ──────────────────────────────────────────────────────────────
-- 5219 adds columns, keys and an exclusion constraint to public.recruitment_interview and builds indexes on it inside this
-- transaction; that is only safe on an empty table (header). Refuse loudly otherwise. The table forces row security, which binds its
-- owner too, so the check lifts FORCE for this transaction only (the owner then reads every row) and restores it at once.
ALTER TABLE public.recruitment_interview NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM public.recruitment_interview) THEN
  RAISE EXCEPTION '5219_recruitment_interview_setup needs an empty recruitment_interview table: this installation already holds interviews. Do not apply 5219 as written; build its interview indexes and constraint for a populated table first.'
   USING ERRCODE = '55000';
 END IF;
END $$;
ALTER TABLE public.recruitment_interview FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ── 1. Interviewer groups ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_interviewer_group (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_interviewer_group_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_interviewer_group_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interviewer_group_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interviewer_group_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_interviewer_group_name_uq ON public.recruitment_interviewer_group (tenant_id, company_id, lower(btrim(name)));
CREATE INDEX recruitment_interviewer_group_created_by_idx ON public.recruitment_interviewer_group (created_by_user_id);
CREATE INDEX recruitment_interviewer_group_updated_by_idx ON public.recruitment_interviewer_group (updated_by_user_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_interviewer_group_member (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 group_id uuid NOT NULL,
 app_user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_interviewer_group_member_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_interviewer_group_member_group_fk FOREIGN KEY (group_id, company_id, tenant_id)
  REFERENCES public.recruitment_interviewer_group(id, company_id, tenant_id) ON DELETE CASCADE,
 CONSTRAINT recruitment_interviewer_group_member_user_fk FOREIGN KEY (app_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interviewer_group_member_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interviewer_group_member_uq UNIQUE (group_id, app_user_id)
);
CREATE INDEX recruitment_interviewer_group_member_company_idx ON public.recruitment_interviewer_group_member (tenant_id, company_id);
CREATE INDEX recruitment_interviewer_group_member_user_idx ON public.recruitment_interviewer_group_member (app_user_id);
CREATE INDEX recruitment_interviewer_group_member_created_by_idx ON public.recruitment_interviewer_group_member (created_by_user_id);
--> statement-breakpoint

-- ── 2. Question bank ───────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_interview_question (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
 guidance text CHECK (guidance IS NULL OR length(btrim(guidance)) BETWEEN 1 AND 2000),
 category text CHECK (category IS NULL OR length(btrim(category)) BETWEEN 1 AND 80),
 retired_at timestamptz,
 retired_by_user_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_interview_question_retired_ck CHECK ((retired_at IS NULL) = (retired_by_user_id IS NULL)),
 CONSTRAINT recruitment_interview_question_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_interview_question_retired_by_fk FOREIGN KEY (retired_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interview_question_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interview_question_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interview_question_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE INDEX recruitment_interview_question_company_idx ON public.recruitment_interview_question (tenant_id, company_id);
CREATE INDEX recruitment_interview_question_retired_by_idx ON public.recruitment_interview_question (retired_by_user_id) WHERE retired_by_user_id IS NOT NULL;
CREATE INDEX recruitment_interview_question_created_by_idx ON public.recruitment_interview_question (created_by_user_id);
CREATE INDEX recruitment_interview_question_updated_by_idx ON public.recruitment_interview_question (updated_by_user_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_interview_question_link (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 question_id uuid NOT NULL,
 evaluation_form_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_interview_question_link_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_interview_question_link_question_fk FOREIGN KEY (question_id, company_id, tenant_id)
  REFERENCES public.recruitment_interview_question(id, company_id, tenant_id),
 CONSTRAINT recruitment_interview_question_link_form_fk FOREIGN KEY (evaluation_form_id, company_id, tenant_id)
  REFERENCES public.recruitment_evaluation_form(id, company_id, tenant_id),
 CONSTRAINT recruitment_interview_question_link_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interview_question_link_uq UNIQUE (evaluation_form_id, question_id)
);
CREATE INDEX recruitment_interview_question_link_company_idx ON public.recruitment_interview_question_link (tenant_id, company_id);
CREATE INDEX recruitment_interview_question_link_question_idx ON public.recruitment_interview_question_link (question_id);
CREATE INDEX recruitment_interview_question_link_created_by_idx ON public.recruitment_interview_question_link (created_by_user_id);
--> statement-breakpoint

-- ── 3. Addresses and rooms ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_interview_address (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 address text NOT NULL CHECK (length(btrim(address)) BETWEEN 1 AND 500),
 region text NOT NULL CHECK (length(btrim(region)) BETWEEN 1 AND 120),
 -- https only: a scheme of exactly "https://", a host of letters, digits, dots and hyphens (no user name or password), an optional
 -- port, then an optional path, query or fragment without spaces, quotes or angle brackets.
 map_url text CONSTRAINT recruitment_interview_address_map_https_ck
  CHECK (map_url IS NULL OR (length(map_url) <= 2000 AND map_url ~ '^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(:[0-9]{1,5})?([/?#][^[:space:][:cntrl:]"<>\\`]*)?$')),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_interview_address_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_interview_address_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interview_address_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interview_address_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_interview_address_name_uq ON public.recruitment_interview_address (tenant_id, company_id, lower(btrim(name)));
CREATE INDEX recruitment_interview_address_created_by_idx ON public.recruitment_interview_address (created_by_user_id);
CREATE INDEX recruitment_interview_address_updated_by_idx ON public.recruitment_interview_address (updated_by_user_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_interview_room (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 address_id uuid NOT NULL,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 1000),
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_interview_room_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_interview_room_address_fk FOREIGN KEY (address_id, company_id, tenant_id)
  REFERENCES public.recruitment_interview_address(id, company_id, tenant_id),
 CONSTRAINT recruitment_interview_room_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interview_room_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interview_room_scope_uq UNIQUE (id, address_id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_interview_room_name_uq ON public.recruitment_interview_room (address_id, lower(btrim(name)));
CREATE INDEX recruitment_interview_room_company_idx ON public.recruitment_interview_room (tenant_id, company_id);
CREATE INDEX recruitment_interview_room_created_by_idx ON public.recruitment_interview_room (created_by_user_id);
CREATE INDEX recruitment_interview_room_updated_by_idx ON public.recruitment_interview_room (updated_by_user_id);
--> statement-breakpoint

-- ── 4. Row security and grants ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_interviewer_group','recruitment_interviewer_group_member','recruitment_interview_question',
  'recruitment_interview_question_link','recruitment_interview_address','recruitment_interview_room'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
  -- Administrators read and write. The policy names no role, so it binds the owner too: inside
  -- app.recruitment_delete_company_setup it admits the caller, who administers the company being deleted, and nobody else.
  EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))'
   ' WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))', t || '_admin', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Groups: the company's operators (recruiters and assistants) read them to add a group's members to an interview. Never a write.
CREATE POLICY recruitment_interviewer_group_operator ON public.recruitment_interviewer_group FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_in_company(company_id));
CREATE POLICY recruitment_interviewer_group_member_operator ON public.recruitment_interviewer_group_member FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_in_company(company_id));
-- Questions, links, addresses and rooms: the company's job teams read them (scorecard guidance; interview details). Never a write.
CREATE POLICY recruitment_interview_question_team ON public.recruitment_interview_question FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
CREATE POLICY recruitment_interview_question_link_team ON public.recruitment_interview_question_link FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
CREATE POLICY recruitment_interview_address_team ON public.recruitment_interview_address FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
CREATE POLICY recruitment_interview_room_team ON public.recruitment_interview_room FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recruitment_interviewer_group, public.recruitment_interview_question,
 public.recruitment_interview_address, public.recruitment_interview_room TO ai_hr_app;
GRANT SELECT, INSERT, DELETE ON public.recruitment_interviewer_group_member, public.recruitment_interview_question_link TO ai_hr_app;
--> statement-breakpoint

-- ── 5. Who may be an interviewer of the company ────────────────────────────────────────────────────────────
-- An active login (not archived) of the tenant employed by the company, or holding recruitment administration covering it
-- (app.recruitment_user_administers, 5210). Answers a boolean only, and only to a caller who administers recruitment for the
-- company (anybody else gets false).
CREATE FUNCTION app.recruitment_user_in_company(p_company uuid, p_user uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
 SELECT p_company IS NOT NULL AND p_user IS NOT NULL AND app.current_tenant_id() IS NOT NULL AND app.can_admin_recruitment_for(p_company)
  AND EXISTS (SELECT 1 FROM public.app_user u WHERE u.id = p_user AND u.tenant_id = app.current_tenant_id() AND u.archived_at IS NULL
   AND (EXISTS (SELECT 1 FROM public.employment e WHERE e.tenant_id = u.tenant_id AND e.person_id = u.person_id AND e.company_id = p_company)
    OR app.recruitment_user_administers(p_company, p_user)));
$$;
REVOKE ALL ON FUNCTION app.recruitment_user_in_company(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_user_in_company(uuid, uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 6. Guards (run as the caller) ──────────────────────────────────────────────────────────────────────────
-- Set-up rows with an audit pair (groups, questions, addresses, rooms): recorded by the current user; they keep their tenant,
-- company and creation record; a room keeps its address. A question's retirement records the current user.
CREATE FUNCTION app.recruitment_guard_interview_setup() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
   OR NEW.updated_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'Interview set-up is recorded by the current user' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now();
 ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'Interview set-up keeps its company and creation record' USING ERRCODE = '23514';
 END IF;
 -- Table-specific fields are read only inside the branch for that table (PL/pgSQL does not short-circuit a record's fields).
 IF TG_TABLE_NAME = 'recruitment_interview_room' THEN
  IF TG_OP = 'UPDATE' THEN
   IF NEW.address_id IS DISTINCT FROM OLD.address_id THEN
    RAISE EXCEPTION 'A room keeps its address' USING ERRCODE = '23514';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME = 'recruitment_interview_question' THEN
  IF TG_OP = 'INSERT' THEN
   IF NEW.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'A new question is not retired' USING ERRCODE = '23514';
   END IF;
  ELSIF NEW.retired_by_user_id IS NOT NULL AND NEW.retired_by_user_id IS DISTINCT FROM OLD.retired_by_user_id
   AND NEW.retired_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'A retirement records the current user' USING ERRCODE = '42501';
  END IF;
 END IF;
 NEW.updated_by_user_id := app.current_user_id(); NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_interview_setup() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_interviewer_group_guard BEFORE INSERT OR UPDATE ON public.recruitment_interviewer_group
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_interview_setup();
CREATE TRIGGER recruitment_interview_question_guard BEFORE INSERT OR UPDATE ON public.recruitment_interview_question
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_interview_setup();
CREATE TRIGGER recruitment_interview_address_guard BEFORE INSERT OR UPDATE ON public.recruitment_interview_address
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_interview_setup();
CREATE TRIGGER recruitment_interview_room_guard BEFORE INSERT OR UPDATE ON public.recruitment_interview_room
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_interview_setup();
--> statement-breakpoint
-- A group member is added by an administrator of the company (row security refuses anybody else too; this answers first, with the
-- same 42501), recorded as the current user, and must have access to the company now. Members are never updated (no grant).
CREATE FUNCTION app.recruitment_guard_interviewer_group_member() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
  OR NOT app.can_admin_recruitment_for(NEW.company_id) THEN
  RAISE EXCEPTION 'A group member is added by the current user' USING ERRCODE = '42501';
 END IF;
 IF NOT app.recruitment_user_in_company(NEW.company_id, NEW.app_user_id) THEN
  RAISE EXCEPTION 'Choose a person with access to this company' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_interviewer_group_member_access';
 END IF;
 NEW.created_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_interviewer_group_member() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_interviewer_group_member_guard BEFORE INSERT ON public.recruitment_interviewer_group_member
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_interviewer_group_member();
--> statement-breakpoint
-- A question link is added by the current user, to a question that is not retired. Links are never updated (no grant).
CREATE FUNCTION app.recruitment_guard_interview_question_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'A question link is added by the current user' USING ERRCODE = '42501';
 END IF;
 IF EXISTS (SELECT 1 FROM public.recruitment_interview_question q WHERE q.id = NEW.question_id AND q.retired_at IS NOT NULL) THEN
  RAISE EXCEPTION 'A retired question is not linked' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_interview_question_link_retired';
 END IF;
 NEW.created_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_interview_question_link() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_interview_question_link_guard BEFORE INSERT ON public.recruitment_interview_question_link
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_interview_question_link();
--> statement-breakpoint

-- ── 7. Interviews: address, room and the non-overlap constraint ────────────────────────────────────────────
-- The interview's period, half-open: [start, start + minutes). IMMUTABLE because a whole number of minutes is added (no day or month
-- part), which no session time zone changes.
CREATE FUNCTION app.recruitment_interview_period(p_start timestamptz, p_minutes integer) RETURNS tstzrange
 LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
 SELECT tstzrange(p_start, p_start + make_interval(mins => p_minutes), '[)');
$$;
REVOKE ALL ON FUNCTION app.recruitment_interview_period(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_interview_period(timestamptz, integer) TO ai_hr_app;
--> statement-breakpoint
-- PRECONDITION (header): public.recruitment_interview is empty wherever this applies.
ALTER TABLE public.recruitment_interview
 ADD COLUMN address_id uuid,
 ADD COLUMN room_id uuid,
 ADD CONSTRAINT recruitment_interview_address_fk FOREIGN KEY (address_id, company_id, tenant_id)
  REFERENCES public.recruitment_interview_address(id, company_id, tenant_id),
 ADD CONSTRAINT recruitment_interview_room_fk FOREIGN KEY (room_id, address_id, company_id, tenant_id)
  REFERENCES public.recruitment_interview_room(id, address_id, company_id, tenant_id),
 -- An address is for an on-site interview; a room needs its address (the room key above is then checked in full).
 ADD CONSTRAINT recruitment_interview_place_ck CHECK ((address_id IS NULL OR interview_type = 'onsite') AND (room_id IS NULL OR address_id IS NOT NULL)),
 ADD CONSTRAINT recruitment_interview_room_no_overlap EXCLUDE USING gist (
  room_id WITH =,
  app.recruitment_interview_period(starts_at, duration_minutes) WITH &&
 ) WHERE (room_id IS NOT NULL AND cancelled_at IS NULL);
CREATE INDEX IF NOT EXISTS recruitment_interview_address_idx ON public.recruitment_interview (address_id) WHERE address_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS recruitment_interview_room_idx ON public.recruitment_interview (room_id) WHERE room_id IS NOT NULL;
--> statement-breakpoint
-- A NEW room choice (scheduling, or changing an interview's room) must be an enabled room. Keeping a room that was disabled later
-- is allowed (the interview stays booked there until it is cancelled or moved). And: a caller who does not operate the job (a
-- hiring manager, admitted by the policy below only so that closing an application frees its rooms) may only CANCEL a FUTURE,
-- open interview of an application that is no longer active, changing nothing else.
CREATE FUNCTION app.recruitment_guard_interview_place() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND NOT app.can_operate_recruitment_job(NEW.company_id, NEW.job_id) THEN
  IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL OR OLD.starts_at <= now()
   OR (to_jsonb(NEW) - ARRAY['cancelled_at','cancelled_by_user_id','updated_at','updated_by_user_id'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['cancelled_at','cancelled_by_user_id','updated_at','updated_by_user_id'])
   OR NOT EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = NEW.application_id AND a.tenant_id = NEW.tenant_id AND a.state <> 'active') THEN
   RAISE EXCEPTION 'Only the job''s operators change an interview' USING ERRCODE = '42501';
  END IF;
  -- The audit values are the database's, not the caller's (the cancelling user is checked by 5202's interview guard).
  NEW.cancelled_at := now(); NEW.updated_at := now(); NEW.updated_by_user_id := app.current_user_id();
 END IF;
 IF NEW.room_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.room_id IS DISTINCT FROM OLD.room_id)
  AND NOT EXISTS (SELECT 1 FROM public.recruitment_interview_room r WHERE r.id = NEW.room_id AND r.tenant_id = NEW.tenant_id AND r.enabled) THEN
  RAISE EXCEPTION 'Choose an enabled meeting room' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_interview_room_enabled';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_interview_place() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_interview_place_guard BEFORE INSERT OR UPDATE ON public.recruitment_interview
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_interview_place();
--> statement-breakpoint
-- Closing an application frees its rooms: the job's reviewers (the hiring manager may reject or hire) may update an interview of the
-- job, and the guard above admits only the cancellation of a future, open interview of an application that is no longer active.
CREATE POLICY recruitment_interview_close_review ON public.recruitment_interview FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.can_review_recruitment_job(company_id, job_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_review_recruitment_job(company_id, job_id));
--> statement-breakpoint
-- Interviewers (5202's guard restated: its body byte for byte plus one check): an interviewer is added only while the application
-- is active, so adding one to an interview of a rejected, archived or hired application cannot grant read of that candidate.
CREATE OR REPLACE FUNCTION app.recruitment_guard_interviewer() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM public.recruitment_interview i
  WHERE i.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.interview_id ELSE NEW.interview_id END AND i.cancelled_at IS NOT NULL) THEN
  RAISE EXCEPTION 'A cancelled interview is closed' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 -- Slice 18 (5219): an interviewer is added only while the application is active (being named grants read of the candidate).
 IF NOT EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = NEW.application_id AND a.tenant_id = NEW.tenant_id AND a.state = 'active') THEN
  RAISE EXCEPTION 'Interviewers are added only while the application is active' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_interview_interviewer_application_active';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_interviewer() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint

-- ── 8. Deleting a company (core/company-refs.ts): 5218's body plus the interview set-up ─────────────────────────────
CREATE OR REPLACE FUNCTION app.recruitment_delete_company_setup(p_company uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE removed integer := 0; n integer;
BEGIN
 IF p_company IS NULL OR app.current_tenant_id() IS NULL OR NOT app.is_admin_for(p_company) THEN
  RAISE EXCEPTION 'Deleting a company''s recruitment setup needs its administrator' USING ERRCODE = '42501';
 END IF;
 IF EXISTS (SELECT 1 FROM public.recruitment_job_opening WHERE tenant_id = app.current_tenant_id() AND company_id = p_company)
  OR EXISTS (SELECT 1 FROM public.recruitment_candidate WHERE tenant_id = app.current_tenant_id() AND company_id = p_company)
  OR EXISTS (SELECT 1 FROM public.recruitment_requisition WHERE tenant_id = app.current_tenant_id() AND company_id = p_company) THEN
  RAISE EXCEPTION 'The company has recruitment history' USING ERRCODE = '23503';
 END IF;
 PERFORM set_config('app.recruitment_company_delete', p_company::text, true);
 DELETE FROM public.recruitment_tag WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_tag_group WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_approval_step WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_offer_field WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_company_setting WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 8: the careers page and its privacy notice versions (a consent that names a version needs a candidate, which
 -- refuses the delete as retained history above).
 DELETE FROM public.recruitment_careers_site WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_careers_notice WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 18: interview set-up (company setup; no candidate data). Question links before the questions and the evaluation forms
 -- they name; group members (they also go with their group, ON DELETE CASCADE; listed so the count covers them) before the groups;
 -- rooms before their addresses (an interview naming either needs an application, whose job opening refuses the delete above).
 -- The administrator policies admit the owner here, as for the waiting rules.
 DELETE FROM public.recruitment_interview_question_link WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_interview_question WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_interviewer_group_member WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_interviewer_group WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_interview_room WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_interview_address WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_evaluation_form WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_archive_reason WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_process WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 17: the waiting rules (company setup; no candidate data), before the stages they name. The administrator policy admits
 -- the owner here, as for the position templates.
 DELETE FROM public.recruitment_stage_waiting_rule WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_stage WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 9: the users' read markers for the company's recruitment tasks (no candidate data).
 DELETE FROM public.recruitment_task_read_marker WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 10: the agency setup, children first. Assignments and submissions need a job opening, which refuses above. A
 -- contract's terms and listed users go with it (ON DELETE CASCADE). The administrator policies admit the owner here
 -- because the caller administers the company (app.is_admin_for implies app.can_admin_recruitment_for).
 DELETE FROM public.recruitment_agency_tag_link WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency_consultant WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency_contract WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency_tag WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 11: screening feedback, then the requests it answers. Both need an application, whose job opening refuses the delete
 -- above; they are listed so the remover covers every company table (owner-bound policies on the company being deleted).
 DELETE FROM public.recruitment_screening_answer WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_screening_request WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 12: background checks, children first (files, details, types of a check, checks), then the company's check types.
 -- Checks need an application, whose job opening refuses the delete above (owner-bound policies on the company being
 -- deleted); the types are company setup (the administrator policy admits the owner here, as for the agency tables).
 DELETE FROM public.recruitment_background_check_file WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check_detail WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check_type_link WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check_type WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 13: the blocked list (history, marks, restricted values, entries — each needs a candidate, which refuses the delete
 -- above; listed so the remover covers every company table), then the pools: memberships (need a candidate too), shares,
 -- sub-pools, pools (real company setup). Owner-bound policies on the company being deleted.
 DELETE FROM public.recruitment_blocked_history WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_application_review_mark WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_blocked_entry_restricted WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_blocked_entry WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_talent_pool_member WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_talent_pool_share WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_talent_pool WHERE tenant_id = app.current_tenant_id() AND company_id = p_company AND parent_id IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_talent_pool WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 14: custom values (each needs a candidate or a job, which refuses the delete above; listed so the remover covers
 -- every company table; owner-bound policies on the company being deleted), then the options and the fields (company setup;
 -- the administrator policy admits the owner here, as for the check types). Options before their fields.
 DELETE FROM public.recruitment_candidate_custom_restricted WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_candidate_custom_value WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_job_custom_value WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_custom_field_option WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_custom_field WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 15: position templates (company setup; a job opening made from one needs a job, which refuses the delete above).
 -- Their custom values first (they also go with the template, ON DELETE CASCADE; listed so the count covers them), then the
 -- templates. The administrator policy admits the owner here, as for the custom fields.
 DELETE FROM public.recruitment_position_template_value WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_position_template WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 16: the import notes and To assign markers (each needs a candidate, which refuses the delete above), the import rows and
 -- the imports (an import whose every row was refused names no candidate, so it can exist without one), then the export templates
 -- (company setup; the administrator policy admits the owner here). Owner-bound policies on the company being deleted.
 DELETE FROM public.recruitment_candidate_import_note WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_to_assign WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_candidate_import_row WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_candidate_import WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_export_template WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 PERFORM set_config('app.recruitment_company_delete', '', true);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_delete_company_setup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;

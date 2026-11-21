-- Recruitment slice 13 (docs/recruitment-reconstruction/specification.md "Slice 13"): talent pools and the blocked list.
--
-- Custom talent pools (D-050): per company, a pool and at most one level of sub-pools, a description, and sharing — All
-- recruiters (the company's operators: recruiters and assistants of any job) or Only listed users. A sub-pool follows its
-- pool's sharing. Administrators see every pool. A candidate can be in any number of pools; deleting a pool removes its
-- memberships, never the candidates, and a pool with sub-pools cannot be deleted. The slice 4 public pool is unchanged.
--
-- The blocked list (D-049): an administrator adds a candidate with a reason and removes them with a reason; history is kept.
-- Any of the candidate's active applications, and every NEW application from any channel (manual entry, careers page,
-- employee referral, agency) whose candidate matches an active entry (the same ID number; the same normalised name plus the
-- same e-mail or mobile; or the same e-mail and the same mobile) or already has an open mark on another application, is
-- marked "Needs an administrator's review". "Not the same person" clears a candidate's marks for an entry for good. While
-- marked, an application cannot change stage, receive or progress an offer (a decline can be recorded), or be hired
-- (database guards below; the service refuses first). Matching never changes what a channel answers: it runs after the
-- insert, never raises, and returns nothing.
--
-- What this installs:
--   1. Seven tables, each with tenant_id + company_id, ENABLE + FORCE row security, explicit GRANTs to ai_hr_app and none
--      to PUBLIC:
--        recruitment_talent_pool                pools and sub-pools (administrators write; shared operators read)
--        recruitment_talent_pool_share          the users a "listed users" pool is shared with (top-level pools only)
--        recruitment_talent_pool_member         candidates in pools, who added them and when (operators of the candidate
--                                               add and remove, in pools they can see)
--        recruitment_blocked_entry              who is on the blocked list (no reason, no identity values): administrators,
--                                               and the operators of the candidate (active entries only), read it
--        recruitment_blocked_entry_restricted   ADMINISTRATORS ONLY: the reason, the removal reason and the normalised
--                                               identity values used for matching (cleared when the entry is removed)
--        recruitment_blocked_history            ids, action, actor and time — never a reason or an identity value
--                                               (administrators read it)
--        recruitment_application_review_mark    "Needs an administrator's review" on an application (administrators read every
--                                               mark, the job's operators the open ones; anyone else learns only a yes/no through
--                                               app.recruitment_application_needs_review for an application they may read)
--      plus app.recruitment_blocked_context, the per-transaction context marker (no grant to anybody), like 4405's destroy
--      marker and 4408's careers context.
--   2. The blocked-list tables have NO write grant to the app role. Every write goes through the owner-run functions below,
--      which open the context marker for one company for the length of the call: app.recruitment_block_candidate,
--      app.recruitment_unblock_candidate and app.recruitment_resolve_review_mark (administrators only), and the deferred
--      matching trigger on recruitment_application (every channel, every author: HR sessions, the referral and careers
--      definers). Owner-only policies bound to the marker open the candidate and restricted rows of THAT company to the
--      matching, only for that transaction; a GUC or session value cannot open them.
--   3. Guards: the two-level pool tree, sharing that follows the parent, pool writes by administrators (row security) as the
--      current user; memberships by the current user for a candidate whose personal data is not removed. A marked
--      application cannot change stage or be hired (recruitment_application), cannot receive an offer or have one submitted,
--      approved, sent or decided (recruitment_offer), and cannot be handed to a new hire (recruitment_hire_handoff). These are
--      ADDED triggers beside 4401/4403/4405's guards, which stay exactly as they are; withdrawing an offer, recording a decline
--      and rejecting the application stay possible. An application created in the same transaction is matched before the
--      guard decides (a new application's applied_at is the database's clock, so it is recognised).
--   4. app.recruitment_destroy_candidate restated (4412 body byte for byte) plus steps: it takes the company's blocked-list
--      lock and refuses while the person's entry holds an open mark on another candidate's active application; the
--      candidate's pool memberships go; their blocked entries, the entries' restricted values, history and the marks those
--      entries made are deleted. app.recruitment_destroying restated (4405) to read the marker without assigning a
--      transaction id. app.recruitment_delete_company_setup restated (4412 body byte for byte) plus the seven
--      tables, children first.
--
-- Nothing here calls a model, scores a candidate or notifies anybody.

-- ── 1. Tables ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_talent_pool (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 parent_id uuid,
 name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
 description text CHECK (description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 500),
 sharing text NOT NULL DEFAULT 'all_recruiters' CHECK (sharing IN ('all_recruiters','listed_users')),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_talent_pool_not_own_parent CHECK (parent_id IS DISTINCT FROM id),
 CONSTRAINT recruitment_talent_pool_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_talent_pool_scope_uq UNIQUE (id, company_id, tenant_id),
 CONSTRAINT recruitment_talent_pool_parent_fk FOREIGN KEY (parent_id, company_id, tenant_id) REFERENCES public.recruitment_talent_pool(id, company_id, tenant_id),
 CONSTRAINT recruitment_talent_pool_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_talent_pool_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
-- Unique among siblings (top-level pools share the nil parent).
CREATE UNIQUE INDEX recruitment_talent_pool_name_uq ON public.recruitment_talent_pool
 (tenant_id, company_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));
CREATE INDEX recruitment_talent_pool_parent_idx ON public.recruitment_talent_pool (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX recruitment_talent_pool_created_by_idx ON public.recruitment_talent_pool (created_by_user_id);
CREATE INDEX recruitment_talent_pool_updated_by_idx ON public.recruitment_talent_pool (updated_by_user_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_talent_pool_share (
 pool_id uuid NOT NULL,
 app_user_id uuid NOT NULL,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_talent_pool_share_pk PRIMARY KEY (pool_id, app_user_id),
 CONSTRAINT recruitment_talent_pool_share_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_talent_pool_share_pool_fk FOREIGN KEY (pool_id, company_id, tenant_id)
  REFERENCES public.recruitment_talent_pool(id, company_id, tenant_id) ON DELETE CASCADE,
 CONSTRAINT recruitment_talent_pool_share_user_fk FOREIGN KEY (app_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_talent_pool_share_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
-- The visibility policy probes (pool, current user) through the primary key; a user's own shares by user.
CREATE INDEX recruitment_talent_pool_share_user_idx ON public.recruitment_talent_pool_share (tenant_id, app_user_id);
CREATE INDEX recruitment_talent_pool_share_company_idx ON public.recruitment_talent_pool_share (tenant_id, company_id);
CREATE INDEX recruitment_talent_pool_share_created_by_idx ON public.recruitment_talent_pool_share (created_by_user_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_talent_pool_member (
 pool_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 added_at timestamptz NOT NULL DEFAULT now(),
 added_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_talent_pool_member_pk PRIMARY KEY (pool_id, candidate_id),
 CONSTRAINT recruitment_talent_pool_member_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_talent_pool_member_pool_fk FOREIGN KEY (pool_id, company_id, tenant_id)
  REFERENCES public.recruitment_talent_pool(id, company_id, tenant_id) ON DELETE CASCADE,
 CONSTRAINT recruitment_talent_pool_member_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id)
  REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_talent_pool_member_added_by_fk FOREIGN KEY (added_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_talent_pool_member_candidate_idx ON public.recruitment_talent_pool_member (candidate_id);
CREATE INDEX recruitment_talent_pool_member_company_idx ON public.recruitment_talent_pool_member (tenant_id, company_id);
CREATE INDEX recruitment_talent_pool_member_added_by_idx ON public.recruitment_talent_pool_member (added_by_user_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_blocked_entry (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 removed_at timestamptz,
 removed_by_user_id uuid,
 CONSTRAINT recruitment_blocked_entry_removed_ck CHECK ((removed_at IS NULL) = (removed_by_user_id IS NULL)),
 CONSTRAINT recruitment_blocked_entry_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_blocked_entry_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id)
  REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_blocked_entry_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_blocked_entry_removed_by_fk FOREIGN KEY (removed_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_blocked_entry_scope_uq UNIQUE (id, company_id, tenant_id)
);
-- One active entry per candidate; the company's active entries (matching reads them on every new application).
CREATE UNIQUE INDEX recruitment_blocked_entry_active_uq ON public.recruitment_blocked_entry (tenant_id, company_id, candidate_id) WHERE removed_at IS NULL;
CREATE INDEX recruitment_blocked_entry_candidate_idx ON public.recruitment_blocked_entry (candidate_id);
CREATE INDEX recruitment_blocked_entry_created_by_idx ON public.recruitment_blocked_entry (created_by_user_id);
CREATE INDEX recruitment_blocked_entry_removed_by_idx ON public.recruitment_blocked_entry (removed_by_user_id) WHERE removed_by_user_id IS NOT NULL;
--> statement-breakpoint
-- ADMINISTRATORS ONLY. The reason and the identity values already on the candidate's record when they were added, normalised
-- by the slice 5 normalisers (app.recruitment_norm_*), used only for matching; cleared when the entry is removed.
CREATE TABLE public.recruitment_blocked_entry_restricted (
 entry_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
 removal_reason text CHECK (removal_reason IS NULL OR char_length(btrim(removal_reason)) BETWEEN 1 AND 500),
 id_norm text,
 name_norm text,
 email_norm text,
 mobile_norm text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT recruitment_blocked_entry_restricted_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_blocked_entry_restricted_entry_fk FOREIGN KEY (entry_id, company_id, tenant_id)
  REFERENCES public.recruitment_blocked_entry(id, company_id, tenant_id)
);
CREATE INDEX recruitment_blocked_entry_restricted_company_idx ON public.recruitment_blocked_entry_restricted (tenant_id, company_id);
-- Matching is equality lookups on these (one per rule part); a removed entry's values are cleared, so it is in none of them.
CREATE INDEX recruitment_blocked_entry_restricted_id_idx ON public.recruitment_blocked_entry_restricted (tenant_id, company_id, id_norm) WHERE id_norm IS NOT NULL;
CREATE INDEX recruitment_blocked_entry_restricted_name_idx ON public.recruitment_blocked_entry_restricted (tenant_id, company_id, name_norm) WHERE name_norm IS NOT NULL;
CREATE INDEX recruitment_blocked_entry_restricted_email_idx ON public.recruitment_blocked_entry_restricted (tenant_id, company_id, email_norm) WHERE email_norm IS NOT NULL;
CREATE INDEX recruitment_blocked_entry_restricted_mobile_idx ON public.recruitment_blocked_entry_restricted (tenant_id, company_id, mobile_norm) WHERE mobile_norm IS NOT NULL;
CREATE INDEX recruitment_blocked_entry_restricted_candidate_idx ON public.recruitment_blocked_entry_restricted (candidate_id);
--> statement-breakpoint
-- What happened, by whom and when: ids and fixed codes only (no reason text, no identity value). candidate_id is the blocked
-- candidate; application_id the application a mark concerns.
CREATE TABLE public.recruitment_blocked_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 entry_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 application_id uuid,
 action text NOT NULL CHECK (action IN ('added','removed','marked','mark_cleared')),
 detail text CHECK (detail IS NULL OR detail IN ('not_same_person','entry_removed')),
 actor_user_id uuid,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT recruitment_blocked_history_shape_ck CHECK ((action IN ('marked','mark_cleared')) = (application_id IS NOT NULL)
  AND (action = 'mark_cleared') = (detail IS NOT NULL) AND (action = 'marked' OR actor_user_id IS NOT NULL)),
 CONSTRAINT recruitment_blocked_history_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_blocked_history_entry_fk FOREIGN KEY (entry_id, company_id, tenant_id) REFERENCES public.recruitment_blocked_entry(id, company_id, tenant_id),
 CONSTRAINT recruitment_blocked_history_application_fk FOREIGN KEY (application_id, company_id, tenant_id)
  REFERENCES public.recruitment_application(id, company_id, tenant_id),
 CONSTRAINT recruitment_blocked_history_actor_fk FOREIGN KEY (actor_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_blocked_history_entry_idx ON public.recruitment_blocked_history (entry_id, occurred_at);
CREATE INDEX recruitment_blocked_history_company_idx ON public.recruitment_blocked_history (tenant_id, company_id, occurred_at DESC);
CREATE INDEX recruitment_blocked_history_candidate_idx ON public.recruitment_blocked_history (candidate_id);
CREATE INDEX recruitment_blocked_history_application_idx ON public.recruitment_blocked_history (application_id) WHERE application_id IS NOT NULL;
CREATE INDEX recruitment_blocked_history_actor_idx ON public.recruitment_blocked_history (actor_user_id) WHERE actor_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE public.recruitment_application_review_mark (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 -- The application's candidate (not the listed person): "Not the same person" applies per candidate and entry.
 candidate_id uuid NOT NULL,
 entry_id uuid NOT NULL,
 marked_at timestamptz NOT NULL DEFAULT now(),
 cleared_at timestamptz,
 cleared_by_user_id uuid,
 cleared_kind text CHECK (cleared_kind IN ('not_same_person','entry_removed')),
 CONSTRAINT recruitment_application_review_mark_cleared_ck CHECK ((cleared_at IS NULL) = (cleared_kind IS NULL)
  AND (cleared_at IS NULL) = (cleared_by_user_id IS NULL)),
 CONSTRAINT recruitment_application_review_mark_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_application_review_mark_application_fk FOREIGN KEY (application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_application(id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_application_review_mark_entry_fk FOREIGN KEY (entry_id, company_id, tenant_id)
  REFERENCES public.recruitment_blocked_entry(id, company_id, tenant_id),
 CONSTRAINT recruitment_application_review_mark_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id)
  REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_application_review_mark_cleared_by_fk FOREIGN KEY (cleared_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_application_review_mark_uq UNIQUE (application_id, entry_id)
);
-- The guards and the yes/no read probe an application's OPEN marks; a removal clears an entry's marks.
CREATE INDEX recruitment_application_review_mark_open_idx ON public.recruitment_application_review_mark (application_id) WHERE cleared_at IS NULL;
CREATE INDEX recruitment_application_review_mark_entry_idx ON public.recruitment_application_review_mark (entry_id);
-- A candidate's marks per entry ("Not the same person", and a new application carrying an open mark over).
CREATE INDEX recruitment_application_review_mark_candidate_idx ON public.recruitment_application_review_mark (candidate_id, entry_id);
CREATE INDEX recruitment_application_review_mark_company_idx ON public.recruitment_application_review_mark (tenant_id, company_id) WHERE cleared_at IS NULL;
CREATE INDEX recruitment_application_review_mark_job_idx ON public.recruitment_application_review_mark (job_id);
CREATE INDEX recruitment_application_review_mark_cleared_by_idx ON public.recruitment_application_review_mark (cleared_by_user_id) WHERE cleared_by_user_id IS NOT NULL;
--> statement-breakpoint
-- The context marker: one row per (transaction, company) while a blocked-list function runs, deleted before it returns. No
-- grant to ai_hr_app or PUBLIC; row security forced; its only policy admits the table owner.
CREATE TABLE app.recruitment_blocked_context (
 txid bigint NOT NULL,
 company_id uuid NOT NULL,
 tenant_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (txid, company_id)
);
ALTER TABLE app.recruitment_blocked_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.recruitment_blocked_context FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.recruitment_blocked_context FROM PUBLIC, ai_hr_app;
CREATE POLICY recruitment_blocked_context_owner ON app.recruitment_blocked_context FOR ALL
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_blocked_context'::regclass)))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_blocked_context'::regclass)));
--> statement-breakpoint
-- True only while a blocked-list function runs for THIS company of THIS tenant in THIS transaction. txid_current_if_assigned
-- never assigns a transaction id, so evaluating it has no side effect. The app role evaluates it inside policies on its own
-- reads (row security evaluates every permissive policy) but can never make it true.
CREATE FUNCTION app.recruitment_blocked_matching(p_tenant uuid, p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
 SELECT p_tenant IS NOT NULL AND p_company IS NOT NULL AND EXISTS (SELECT 1 FROM app.recruitment_blocked_context m
  WHERE m.txid = txid_current_if_assigned() AND m.company_id = p_company AND m.tenant_id = p_tenant);
$$;
REVOKE ALL ON FUNCTION app.recruitment_blocked_matching(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_blocked_matching(uuid, uuid) TO ai_hr_app;
--> statement-breakpoint
-- The slice 13 match (packs/recruitment/pool-model.ts blockedIdentityMatch is the same rule) on values ALREADY normalised by
-- app.recruitment_norm_*: the same ID number; or the same name plus the same e-mail or the same mobile; or the same e-mail
-- and the same mobile. One matching item alone (an e-mail, a mobile or a name) is not a match. The functions below use the
-- same rule as indexed equality lookups (one per part).
CREATE FUNCTION app.recruitment_blocked_identity_match(e_id text, e_name text, e_email text, e_mobile text, c_id text, c_name text, c_email text, c_mobile text)
 RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
 SELECT coalesce(e_id IS NOT NULL AND e_id = c_id, false)
  OR coalesce(e_name IS NOT NULL AND e_name = c_name AND (coalesce(e_email IS NOT NULL AND e_email = c_email, false)
   OR coalesce(e_mobile IS NOT NULL AND e_mobile = c_mobile, false)), false)
  OR coalesce(e_email IS NOT NULL AND e_email = c_email AND e_mobile IS NOT NULL AND e_mobile = c_mobile, false);
$$;
REVOKE ALL ON FUNCTION app.recruitment_blocked_identity_match(text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_blocked_identity_match(text, text, text, text, text, text, text, text) TO ai_hr_app;
--> statement-breakpoint
-- The company-level lock between adding or removing an entry (exclusive) and matching a new application at commit (shared):
-- whichever commits first is seen by the other, so a new application can never slip past an entry added at the same moment.
CREATE FUNCTION app.recruitment_blocked_lock_key(p_tenant uuid, p_company uuid) RETURNS bigint
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
 SELECT hashtextextended('recruitment-blocked:' || p_tenant::text || ':' || p_company::text, 0);
$$;
REVOKE ALL ON FUNCTION app.recruitment_blocked_lock_key(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

-- ── 2. Row security and grants ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_talent_pool','recruitment_talent_pool_share','recruitment_talent_pool_member','recruitment_blocked_entry',
  'recruitment_blocked_entry_restricted','recruitment_blocked_history','recruitment_application_review_mark'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Pools: administrators read and write every pool of their companies. The company's operators (recruiters and assistants of
-- any job) read a pool shared with all recruiters, or one whose top-level pool lists them. The share probe reads only the
-- share table, whose policies never read a pool back, so nothing recurses.
CREATE POLICY recruitment_talent_pool_admin ON public.recruitment_talent_pool FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_talent_pool_shared ON public.recruitment_talent_pool FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_in_company(company_id)
  AND (sharing = 'all_recruiters' OR EXISTS (SELECT 1 FROM public.recruitment_talent_pool_share s
   WHERE s.pool_id = coalesce(recruitment_talent_pool.parent_id, recruitment_talent_pool.id) AND s.tenant_id = recruitment_talent_pool.tenant_id
    AND s.app_user_id = app.current_user_id())));
CREATE POLICY recruitment_talent_pool_share_admin ON public.recruitment_talent_pool_share FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_talent_pool_share_own ON public.recruitment_talent_pool_share FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app_user_id = app.current_user_id());
-- Memberships: a pool the caller can see (the pool's own row security answers the probe) and a candidate the caller operates
-- (administrators, and recruiters and assistants of one of the candidate's jobs). The same rule reads, adds and removes.
CREATE POLICY recruitment_talent_pool_member_read ON public.recruitment_talent_pool_member FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id)
  AND EXISTS (SELECT 1 FROM public.recruitment_talent_pool p WHERE p.id = recruitment_talent_pool_member.pool_id));
CREATE POLICY recruitment_talent_pool_member_insert ON public.recruitment_talent_pool_member FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id)
  AND EXISTS (SELECT 1 FROM public.recruitment_talent_pool p WHERE p.id = recruitment_talent_pool_member.pool_id));
CREATE POLICY recruitment_talent_pool_member_delete ON public.recruitment_talent_pool_member FOR DELETE
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id)
  AND EXISTS (SELECT 1 FROM public.recruitment_talent_pool p WHERE p.id = recruitment_talent_pool_member.pool_id));
-- The blocked list. Entries: administrators (every entry, removed ones included), and the operators of the candidate (they
-- see THAT a candidate is listed now, never why, and nothing of a removed entry). The restricted values and the history:
-- administrators only. Marks: administrators all; the job's operators the OPEN ones.
CREATE POLICY recruitment_blocked_entry_read ON public.recruitment_blocked_entry FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND (app.can_admin_recruitment_for(company_id)
  OR (removed_at IS NULL AND app.recruitment_operates_candidate(company_id, candidate_id))));
CREATE POLICY recruitment_blocked_entry_restricted_admin ON public.recruitment_blocked_entry_restricted FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_blocked_history_admin ON public.recruitment_blocked_history FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_application_review_mark_read ON public.recruitment_application_review_mark FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND (app.can_admin_recruitment_for(company_id)
  OR (cleared_at IS NULL AND app.can_operate_recruitment_job(company_id, job_id))));
--> statement-breakpoint
-- Owner-run, context-bound: the blocked-list functions below (and only while their marker exists) read and write the
-- blocked-list tables of THAT company, and read its applications, candidates and their ID numbers for matching.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_blocked_entry','recruitment_blocked_entry_restricted','recruitment_blocked_history',
  'recruitment_application_review_mark','recruitment_application','recruitment_candidate','recruitment_candidate_restricted'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND app.recruitment_blocked_matching(tenant_id, company_id))', t || '_blocked_read', t, 'public.' || t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['recruitment_blocked_entry','recruitment_blocked_entry_restricted','recruitment_blocked_history',
  'recruitment_application_review_mark'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND app.recruitment_blocked_matching(tenant_id, company_id))', t || '_blocked_insert', t, 'public.' || t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['recruitment_blocked_entry','recruitment_blocked_entry_restricted','recruitment_application_review_mark'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND app.recruitment_blocked_matching(tenant_id, company_id)) WITH CHECK (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND app.recruitment_blocked_matching(tenant_id, company_id))', t || '_blocked_update', t, 'public.' || t, 'public.' || t);
 END LOOP;
END $$;
--> statement-breakpoint
-- The move, offer and hire guards (owner-run triggers) ask whether an application has an OPEN mark, whoever the caller is (an
-- approver may not read the application). Open marks carry ids only; the app role never satisfies this (it is never the owner).
CREATE POLICY recruitment_application_review_mark_open_guard ON public.recruitment_application_review_mark FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_application_review_mark'::regclass))
  AND cleared_at IS NULL);
-- The review-mark guard asks whether an offer's or hand-off's application was created in THIS transaction (applied_at is the
-- transaction's time); the owner sees exactly the applications created in the current transaction, nothing older.
CREATE POLICY recruitment_application_blocked_new ON public.recruitment_application FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_application'::regclass))
  AND applied_at = now());
-- Whether the company has any ACTIVE entry, asked by the matching before it writes its context marker (most companies have
-- none, so most new applications cost one index probe and no write). An entry row carries ids only; never a reason or an
-- identity value (those are in the restricted table, which has no such policy).
CREATE POLICY recruitment_blocked_entry_active_probe ON public.recruitment_blocked_entry FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_blocked_entry'::regclass))
  AND removed_at IS NULL);
--> statement-breakpoint
-- Removal of a candidate's personal data (marker-bound, owner-only): their blocked entries with the restricted values and the
-- history, and every mark those entries made. Pool memberships go through the ordinary policies (the remover administers the
-- company). The company delete (owner-only, the company being deleted).
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_blocked_entry','recruitment_blocked_entry_restricted','recruitment_blocked_history'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying(candidate_id))', t || '_destroy_read', t, 'public.' || t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying(candidate_id))', t || '_destroy', t, 'public.' || t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['recruitment_talent_pool','recruitment_talent_pool_share','recruitment_talent_pool_member','recruitment_blocked_entry',
  'recruitment_blocked_entry_restricted','recruitment_blocked_history','recruitment_application_review_mark'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND current_setting(''app.recruitment_company_delete'', true) = company_id::text)', t || '_company_delete_read', t, 'public.' || t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND current_setting(''app.recruitment_company_delete'', true) = company_id::text)', t || '_company_delete', t, 'public.' || t);
 END LOOP;
END $$;
--> statement-breakpoint
-- A mark made by an entry of the person being removed (on anyone's application): the entry's row is visible to the owner here
-- through its own destroy policy above; no entry policy reads a mark back, so nothing recurses.
CREATE POLICY recruitment_application_review_mark_destroy_read ON public.recruitment_application_review_mark FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_application_review_mark'::regclass))
  AND tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.recruitment_blocked_entry e
   WHERE e.id = recruitment_application_review_mark.entry_id AND app.recruitment_destroying(e.candidate_id)));
CREATE POLICY recruitment_application_review_mark_destroy ON public.recruitment_application_review_mark FOR DELETE
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_application_review_mark'::regclass))
  AND tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.recruitment_blocked_entry e
   WHERE e.id = recruitment_application_review_mark.entry_id AND app.recruitment_destroying(e.candidate_id)));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recruitment_talent_pool TO ai_hr_app;
GRANT SELECT, INSERT, DELETE ON public.recruitment_talent_pool_share, public.recruitment_talent_pool_member TO ai_hr_app;
-- The blocked list: read only. Writes go through the owner-run functions below.
GRANT SELECT ON public.recruitment_blocked_entry, public.recruitment_blocked_entry_restricted, public.recruitment_blocked_history,
 public.recruitment_application_review_mark TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Pool guards ────────────────────────────────────────────────────────────────────────────────────────
-- Written as the current user (row security admits administrators only). A sub-pool's parent is a top-level pool of the same
-- company (two levels at most), fixed once created, and the sub-pool follows the parent's sharing. A pool with sub-pools is
-- not deleted (the sub-pools first); its memberships and shares go with it (ON DELETE CASCADE).
CREATE FUNCTION app.recruitment_guard_talent_pool() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE p public.recruitment_talent_pool%ROWTYPE;
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF current_setting('app.recruitment_company_delete', true) IS DISTINCT FROM OLD.company_id::text
   AND EXISTS (SELECT 1 FROM public.recruitment_talent_pool c WHERE c.parent_id = OLD.id) THEN
   RAISE EXCEPTION 'Delete the sub-pools first' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_talent_pool_has_subpools';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
   OR NEW.updated_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'A talent pool is created by the current user' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now();
 ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'A talent pool keeps its company, place and creation record' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_talent_pool_fixed';
 END IF;
 IF NEW.parent_id IS NOT NULL THEN
  SELECT * INTO p FROM public.recruitment_talent_pool WHERE id = NEW.parent_id AND tenant_id = NEW.tenant_id AND company_id = NEW.company_id;
  IF NOT FOUND OR p.parent_id IS NOT NULL THEN
   RAISE EXCEPTION 'Pools nest two levels at most: a pool and its sub-pools' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_talent_pool_depth';
  END IF;
  NEW.sharing := p.sharing;
 END IF;
 NEW.updated_by_user_id := app.current_user_id(); NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_talent_pool() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_talent_pool_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_talent_pool
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_talent_pool();
--> statement-breakpoint
-- A top-level pool's sharing reaches its sub-pools (each sub-pool's guard copies it again).
CREATE FUNCTION app.recruitment_talent_pool_sharing_follows() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 UPDATE public.recruitment_talent_pool SET sharing = NEW.sharing WHERE parent_id = NEW.id AND sharing IS DISTINCT FROM NEW.sharing;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_talent_pool_sharing_follows() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_talent_pool_sharing_follows AFTER UPDATE OF sharing ON public.recruitment_talent_pool
 FOR EACH ROW WHEN (NEW.parent_id IS NULL AND NEW.sharing IS DISTINCT FROM OLD.sharing) EXECUTE FUNCTION app.recruitment_talent_pool_sharing_follows();
--> statement-breakpoint
-- Shares: on top-level pools only (a sub-pool follows its pool), by the current user, never changed.
CREATE FUNCTION app.recruitment_guard_talent_pool_share() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
  RAISE EXCEPTION 'A pool share is added or removed, never changed' USING ERRCODE = '23514';
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'A pool share is added by the current user' USING ERRCODE = '42501';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.recruitment_talent_pool p WHERE p.id = NEW.pool_id AND p.tenant_id = NEW.tenant_id AND p.parent_id IS NULL) THEN
  RAISE EXCEPTION 'A sub-pool follows its pool''s sharing' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_talent_pool_depth';
 END IF;
 NEW.created_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_talent_pool_share() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_talent_pool_share_guard BEFORE INSERT OR UPDATE ON public.recruitment_talent_pool_share
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_talent_pool_share();
--> statement-breakpoint
-- Memberships: added by the current user, never changed; not for a candidate whose personal data was removed (serialised
-- against the removal by the 4405 candidate lock).
CREATE FUNCTION app.recruitment_guard_talent_pool_member() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
  RAISE EXCEPTION 'A pool membership is added or removed, never changed' USING ERRCODE = '23514';
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.added_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'A candidate is added to a pool by the current user' USING ERRCODE = '42501';
 END IF;
 PERFORM pg_advisory_xact_lock_shared(app.recruitment_candidate_lock_key(NEW.tenant_id, NEW.candidate_id));
 IF EXISTS (SELECT 1 FROM public.recruitment_candidate c WHERE c.id = NEW.candidate_id AND c.destroyed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'This candidate''s personal data has been removed' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_candidate_removed';
 END IF;
 NEW.added_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_talent_pool_member() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_talent_pool_member_guard BEFORE INSERT OR UPDATE ON public.recruitment_talent_pool_member
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_talent_pool_member();
--> statement-breakpoint

-- ── 4. Blocked-list guards ────────────────────────────────────────────────────────────────────────────────
-- Every write happens inside a blocked-list function's context (the app role has no write grant at all); deletes only in the
-- removal of the blocked candidate's personal data or the company delete. An entry keeps its candidate and creation; once
-- removed it stays removed. A mark keeps its application and entry and is cleared once. History is append-only.
CREATE FUNCTION app.recruitment_guard_blocked() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_candidate uuid;
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF current_setting('app.recruitment_company_delete', true) IS NOT DISTINCT FROM OLD.company_id::text THEN
   RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'recruitment_application_review_mark' THEN
   SELECT e.candidate_id INTO v_candidate FROM public.recruitment_blocked_entry e WHERE e.id = OLD.entry_id;
  ELSE
   v_candidate := OLD.candidate_id;
  END IF;
  IF NOT app.recruitment_destroying(v_candidate) THEN
   RAISE EXCEPTION 'Blocked-list records are removed only with the blocked candidate''s personal data' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
 END IF;
 IF NOT app.recruitment_blocked_matching(NEW.tenant_id, NEW.company_id) THEN
  RAISE EXCEPTION 'The blocked list is changed only through its functions' USING ERRCODE = '42501';
 END IF;
 IF TG_OP = 'INSERT' THEN
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME = 'recruitment_blocked_history' THEN
  RAISE EXCEPTION 'Blocked-list history is append-only' USING ERRCODE = '23514';
 ELSIF TG_TABLE_NAME = 'recruitment_blocked_entry' THEN
  IF (to_jsonb(NEW) - ARRAY['removed_at','removed_by_user_id']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['removed_at','removed_by_user_id'])
   OR OLD.removed_at IS NOT NULL THEN
   RAISE EXCEPTION 'A blocked-list entry keeps its candidate and is removed once' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_blocked_entry_removed';
  END IF;
 ELSIF TG_TABLE_NAME = 'recruitment_application_review_mark' THEN
  IF (to_jsonb(NEW) - ARRAY['cleared_at','cleared_by_user_id','cleared_kind']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['cleared_at','cleared_by_user_id','cleared_kind'])
   OR OLD.cleared_at IS NOT NULL THEN
   RAISE EXCEPTION 'A review mark keeps its application and is cleared once' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_review_mark_cleared';
  END IF;
 ELSIF TG_TABLE_NAME = 'recruitment_blocked_entry_restricted' THEN
  IF NEW.entry_id IS DISTINCT FROM OLD.entry_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
   OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id OR NEW.reason IS DISTINCT FROM OLD.reason THEN
   RAISE EXCEPTION 'A blocked-list entry keeps its reason' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_blocked() FROM PUBLIC, ai_hr_app;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_blocked_entry','recruitment_blocked_entry_restricted','recruitment_blocked_history',
  'recruitment_application_review_mark'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_blocked()',
   t || '_guard', t);
 END LOOP;
END $$;
--> statement-breakpoint

-- ── 5. Marking ────────────────────────────────────────────────────────────────────────────────────────────
-- Mark one application for one entry (once per pair, ever) and record it in the history — unless an administrator decided
-- that this application's candidate is "Not the same person" for that entry (then the candidate is never marked again for it).
-- Owner-only: called inside the blocked-list functions' context, never by the app role.
CREATE FUNCTION app.recruitment_blocked_mark(p_tenant uuid, p_company uuid, p_entry uuid, p_listed uuid, p_application uuid, p_job uuid, p_candidate uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE n integer;
BEGIN
 IF EXISTS (SELECT 1 FROM public.recruitment_application_review_mark x WHERE x.candidate_id = p_candidate AND x.entry_id = p_entry
  AND x.cleared_kind = 'not_same_person') THEN
  RETURN 0;
 END IF;
 INSERT INTO public.recruitment_application_review_mark (tenant_id, company_id, job_id, application_id, candidate_id, entry_id)
  VALUES (p_tenant, p_company, p_job, p_application, p_candidate, p_entry) ON CONFLICT (application_id, entry_id) DO NOTHING;
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n > 0 THEN
  INSERT INTO public.recruitment_blocked_history (tenant_id, company_id, entry_id, candidate_id, application_id, action)
   VALUES (p_tenant, p_company, p_entry, p_listed, p_application, 'marked');
 END IF;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_blocked_mark(uuid, uuid, uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- Match ONE application against the company's active entries and mark it: the listed candidate themself; the slice 13 rule as
-- indexed equality lookups (same ID number; same name with the same e-mail or mobile; same e-mail and mobile); and any entry
-- that already holds an open mark on another application of the same candidate (a new application does not launder a hold).
-- p_only_new: only if the application was created in THIS transaction (its applied_at is stamped with the transaction's time,
-- section 6) — the guards' case. Takes the company lock shared FIRST, then asks whether any entry is active, and writes its
-- context marker only when one is. Owner-only. Never raises for an ordinary application: it only reads and marks.
CREATE FUNCTION app.recruitment_blocked_match(p_tenant uuid, p_company uuid, p_application uuid, p_only_new boolean) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE a record; v_name text; v_email text; v_mobile text; v_id text; e record; n integer := 0; v_opened integer;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(app.recruitment_blocked_lock_key(p_tenant, p_company));
 IF NOT EXISTS (SELECT 1 FROM public.recruitment_blocked_entry b WHERE b.tenant_id = p_tenant AND b.company_id = p_company AND b.removed_at IS NULL) THEN
  RETURN 0;
 END IF;
 INSERT INTO app.recruitment_blocked_context (txid, tenant_id, company_id) VALUES (txid_current(), p_tenant, p_company)
  ON CONFLICT (txid, company_id) DO NOTHING;
 GET DIAGNOSTICS v_opened = ROW_COUNT;
 SELECT x.id, x.job_id, x.candidate_id, x.applied_at INTO a FROM public.recruitment_application x
  WHERE x.id = p_application AND x.tenant_id = p_tenant AND x.company_id = p_company;
 IF FOUND AND (NOT p_only_new OR a.applied_at = now()) THEN
  SELECT app.recruitment_norm_name(c.full_name), app.recruitment_norm_email(c.email), app.recruitment_norm_mobile(c.phone)
   INTO v_name, v_email, v_mobile FROM public.recruitment_candidate c WHERE c.id = a.candidate_id AND c.tenant_id = p_tenant;
  SELECT app.recruitment_norm_id(r.id_number) INTO v_id FROM public.recruitment_candidate_restricted r
   WHERE r.candidate_id = a.candidate_id AND r.tenant_id = p_tenant;
  FOR e IN SELECT b.id, b.candidate_id FROM public.recruitment_blocked_entry b
    WHERE b.removed_at IS NULL AND b.tenant_id = p_tenant AND b.company_id = p_company AND b.id IN (
     SELECT b2.id FROM public.recruitment_blocked_entry b2
      WHERE b2.tenant_id = p_tenant AND b2.company_id = p_company AND b2.candidate_id = a.candidate_id AND b2.removed_at IS NULL
     UNION SELECT x.entry_id FROM public.recruitment_blocked_entry_restricted x
      WHERE v_id IS NOT NULL AND x.tenant_id = p_tenant AND x.company_id = p_company AND x.id_norm = v_id
     UNION SELECT x.entry_id FROM public.recruitment_blocked_entry_restricted x
      WHERE v_name IS NOT NULL AND v_email IS NOT NULL AND x.tenant_id = p_tenant AND x.company_id = p_company AND x.name_norm = v_name AND x.email_norm = v_email
     UNION SELECT x.entry_id FROM public.recruitment_blocked_entry_restricted x
      WHERE v_name IS NOT NULL AND v_mobile IS NOT NULL AND x.tenant_id = p_tenant AND x.company_id = p_company AND x.name_norm = v_name AND x.mobile_norm = v_mobile
     UNION SELECT x.entry_id FROM public.recruitment_blocked_entry_restricted x
      WHERE v_email IS NOT NULL AND v_mobile IS NOT NULL AND x.tenant_id = p_tenant AND x.company_id = p_company AND x.email_norm = v_email AND x.mobile_norm = v_mobile
     UNION SELECT m.entry_id FROM public.recruitment_application_review_mark m
      WHERE m.candidate_id = a.candidate_id AND m.cleared_at IS NULL AND m.application_id <> a.id)
    ORDER BY b.created_at, b.id LOOP
   n := n + app.recruitment_blocked_mark(p_tenant, p_company, e.id, e.candidate_id, a.id, a.job_id, a.candidate_id);
  END LOOP;
 END IF;
 IF v_opened > 0 THEN
  DELETE FROM app.recruitment_blocked_context WHERE txid = txid_current() AND company_id = p_company;
 END IF;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_blocked_match(uuid, uuid, uuid, boolean) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- At commit (a deferred constraint trigger, so the candidate's ID number written after the application in the same
-- transaction is seen): match every NEW application of any channel. Runs as the owner for every author (an HR user, the
-- referral or the careers definer); returns nothing and never refuses, so no channel answers differently for a listed person.
CREATE FUNCTION app.recruitment_blocked_match_application() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
BEGIN
 PERFORM app.recruitment_blocked_match(NEW.tenant_id, NEW.company_id, NEW.id, false);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_blocked_match_application() FROM PUBLIC, ai_hr_app;
CREATE CONSTRAINT TRIGGER recruitment_application_blocked_match AFTER INSERT ON public.recruitment_application
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.recruitment_blocked_match_application();
--> statement-breakpoint
-- An administrator adds a candidate of their company to the blocked list with a reason (1–500 characters). The entry stores
-- the identity values already on the candidate's record, normalised; the candidate's active applications and every active
-- application of another candidate matching by the slice 13 rule are marked (except a candidate already found "Not the same
-- person" — impossible for a new entry). Returns the entry id. The reason is in the administrators-only table; the history and
-- the caller's audit event carry ids only.
CREATE FUNCTION app.recruitment_block_candidate(p_candidate uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE c public.recruitment_candidate%ROWTYPE; v_reason text := btrim(coalesce(p_reason, '')); v_id text; v_name text; v_email text; v_mobile text;
 v_entry uuid; a record;
BEGIN
 IF p_candidate IS NULL OR app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN
  RAISE EXCEPTION 'Only recruitment administrators change the blocked list' USING ERRCODE = '42501';
 END IF;
 PERFORM pg_advisory_xact_lock_shared(app.recruitment_candidate_lock_key(app.current_tenant_id(), p_candidate));
 SELECT * INTO c FROM public.recruitment_candidate WHERE id = p_candidate AND tenant_id = app.current_tenant_id();
 IF NOT FOUND OR NOT app.can_admin_recruitment_for(c.company_id) THEN
  RAISE EXCEPTION 'Only recruitment administrators change the blocked list' USING ERRCODE = '42501';
 END IF;
 IF c.destroyed_at IS NOT NULL THEN
  RAISE EXCEPTION 'This candidate''s personal data has been removed' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_candidate_removed';
 END IF;
 IF char_length(v_reason) NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'A reason of 1 to 500 characters is required' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_blocked_reason';
 END IF;
 PERFORM pg_advisory_xact_lock(app.recruitment_blocked_lock_key(c.tenant_id, c.company_id));
 IF EXISTS (SELECT 1 FROM public.recruitment_blocked_entry b WHERE b.tenant_id = c.tenant_id AND b.company_id = c.company_id
  AND b.candidate_id = c.id AND b.removed_at IS NULL) THEN
  RAISE EXCEPTION 'The candidate is already on the blocked list' USING ERRCODE = '23505', CONSTRAINT = 'recruitment_blocked_entry_active_uq';
 END IF;
 INSERT INTO app.recruitment_blocked_context (txid, tenant_id, company_id) VALUES (txid_current(), c.tenant_id, c.company_id)
  ON CONFLICT (txid, company_id) DO NOTHING;
 v_name := app.recruitment_norm_name(c.full_name); v_email := app.recruitment_norm_email(c.email); v_mobile := app.recruitment_norm_mobile(c.phone);
 SELECT app.recruitment_norm_id(r.id_number) INTO v_id FROM public.recruitment_candidate_restricted r WHERE r.candidate_id = c.id AND r.tenant_id = c.tenant_id;
 INSERT INTO public.recruitment_blocked_entry (tenant_id, company_id, candidate_id, created_by_user_id)
  VALUES (c.tenant_id, c.company_id, c.id, app.current_user_id()) RETURNING id INTO v_entry;
 INSERT INTO public.recruitment_blocked_entry_restricted (entry_id, tenant_id, company_id, candidate_id, reason, id_norm, name_norm, email_norm, mobile_norm)
  VALUES (v_entry, c.tenant_id, c.company_id, c.id, v_reason, v_id, v_name, v_email, v_mobile);
 INSERT INTO public.recruitment_blocked_history (tenant_id, company_id, entry_id, candidate_id, action, actor_user_id)
  VALUES (c.tenant_id, c.company_id, v_entry, c.id, 'added', app.current_user_id());
 -- The candidate's own active applications, and the active applications of every live candidate of the company that matches
 -- (indexed equality lookups on the 4405 expression indexes, one per rule part, never a company-wide scan of names).
 FOR a IN SELECT x.id, x.job_id, x.candidate_id FROM public.recruitment_application x
   WHERE x.tenant_id = c.tenant_id AND x.company_id = c.company_id AND x.state = 'active'
    AND x.candidate_id IN (
     SELECT c.id
     UNION SELECT r.candidate_id FROM public.recruitment_candidate_restricted r
      WHERE v_id IS NOT NULL AND r.tenant_id = c.tenant_id AND r.company_id = c.company_id AND r.id_number IS NOT NULL
       AND app.recruitment_norm_id(r.id_number) = v_id
     UNION SELECT y.id FROM public.recruitment_candidate y
      WHERE v_name IS NOT NULL AND y.tenant_id = c.tenant_id AND y.company_id = c.company_id AND app.recruitment_norm_name(y.full_name) = v_name
       AND (coalesce(v_email IS NOT NULL AND y.email IS NOT NULL AND app.recruitment_norm_email(y.email) = v_email, false)
        OR coalesce(v_mobile IS NOT NULL AND y.phone IS NOT NULL AND app.recruitment_norm_mobile(y.phone) = v_mobile, false))
     UNION SELECT y.id FROM public.recruitment_candidate y
      WHERE v_email IS NOT NULL AND v_mobile IS NOT NULL AND y.tenant_id = c.tenant_id AND y.company_id = c.company_id AND y.email IS NOT NULL
       AND app.recruitment_norm_email(y.email) = v_email AND y.phone IS NOT NULL AND app.recruitment_norm_mobile(y.phone) = v_mobile)
    AND NOT EXISTS (SELECT 1 FROM public.recruitment_candidate d WHERE d.id = x.candidate_id AND d.destroyed_at IS NOT NULL)
   ORDER BY x.applied_at, x.id LOOP
  PERFORM app.recruitment_blocked_mark(c.tenant_id, c.company_id, v_entry, c.id, a.id, a.job_id, a.candidate_id);
 END LOOP;
 DELETE FROM app.recruitment_blocked_context WHERE txid = txid_current() AND company_id = c.company_id;
 RETURN v_entry;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_block_candidate(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_block_candidate(uuid, text) TO ai_hr_app;
--> statement-breakpoint
-- An administrator removes an entry with a reason (1–500): the entry is marked removed, its identity values are cleared (no
-- longer used for matching; the reason and the removal reason stay for administrators), and every open mark it made is
-- cleared. Returns how many marks were cleared. Serialised with matching and with the removal of the listed person's data by
-- the company lock (exclusive); an entry that the removal deleted meanwhile is refused by name.
CREATE FUNCTION app.recruitment_unblock_candidate(p_entry uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE e public.recruitment_blocked_entry%ROWTYPE; v_reason text := btrim(coalesce(p_reason, '')); m record; n integer := 0;
BEGIN
 IF p_entry IS NULL OR app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN
  RAISE EXCEPTION 'Only recruitment administrators change the blocked list' USING ERRCODE = '42501';
 END IF;
 SELECT * INTO e FROM public.recruitment_blocked_entry WHERE id = p_entry AND tenant_id = app.current_tenant_id();
 IF NOT FOUND OR NOT app.can_admin_recruitment_for(e.company_id) THEN
  RAISE EXCEPTION 'Only recruitment administrators change the blocked list' USING ERRCODE = '42501';
 END IF;
 IF char_length(v_reason) NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'A reason of 1 to 500 characters is required' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_blocked_reason';
 END IF;
 PERFORM pg_advisory_xact_lock(app.recruitment_blocked_lock_key(e.tenant_id, e.company_id));
 INSERT INTO app.recruitment_blocked_context (txid, tenant_id, company_id) VALUES (txid_current(), e.tenant_id, e.company_id)
  ON CONFLICT (txid, company_id) DO NOTHING;
 SELECT * INTO e FROM public.recruitment_blocked_entry WHERE id = p_entry FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'The entry no longer exists' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_blocked_entry_gone';
 END IF;
 IF e.removed_at IS NOT NULL THEN
  RAISE EXCEPTION 'The entry has already been removed' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_blocked_entry_removed';
 END IF;
 UPDATE public.recruitment_blocked_entry SET removed_at = now(), removed_by_user_id = app.current_user_id() WHERE id = e.id;
 UPDATE public.recruitment_blocked_entry_restricted SET removal_reason = v_reason, id_norm = NULL, name_norm = NULL, email_norm = NULL, mobile_norm = NULL
  WHERE entry_id = e.id;
 INSERT INTO public.recruitment_blocked_history (tenant_id, company_id, entry_id, candidate_id, action, actor_user_id)
  VALUES (e.tenant_id, e.company_id, e.id, e.candidate_id, 'removed', app.current_user_id());
 FOR m IN UPDATE public.recruitment_application_review_mark SET cleared_at = now(), cleared_by_user_id = app.current_user_id(), cleared_kind = 'entry_removed'
   WHERE entry_id = e.id AND cleared_at IS NULL RETURNING application_id LOOP
  INSERT INTO public.recruitment_blocked_history (tenant_id, company_id, entry_id, candidate_id, application_id, action, detail, actor_user_id)
   VALUES (e.tenant_id, e.company_id, e.id, e.candidate_id, m.application_id, 'mark_cleared', 'entry_removed', app.current_user_id());
  n := n + 1;
 END LOOP;
 DELETE FROM app.recruitment_blocked_context WHERE txid = txid_current() AND company_id = e.company_id;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_unblock_candidate(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_unblock_candidate(uuid, text) TO ai_hr_app;
--> statement-breakpoint
-- An administrator resolves a mark: 'not_same_person' clears every open mark that entry made on THIS candidate's applications,
-- and the candidate is not marked again for it (app.recruitment_blocked_mark) — refused for the listed person's own marks; 'remove_from_list' removes the entry (with the
-- reason, 1–500) and so clears every mark it made. Returns how many marks were cleared.
CREATE FUNCTION app.recruitment_resolve_review_mark(p_mark uuid, p_resolution text, p_reason text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE m public.recruitment_application_review_mark%ROWTYPE; v_listed uuid; x record; n integer := 0;
BEGIN
 IF p_mark IS NULL OR app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN
  RAISE EXCEPTION 'Only recruitment administrators resolve a review mark' USING ERRCODE = '42501';
 END IF;
 SELECT * INTO m FROM public.recruitment_application_review_mark WHERE id = p_mark AND tenant_id = app.current_tenant_id();
 IF NOT FOUND OR NOT app.can_admin_recruitment_for(m.company_id) THEN
  RAISE EXCEPTION 'Only recruitment administrators resolve a review mark' USING ERRCODE = '42501';
 END IF;
 IF p_resolution = 'remove_from_list' THEN
  IF m.cleared_at IS NOT NULL THEN
   RAISE EXCEPTION 'The mark has already been cleared' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_review_mark_cleared';
  END IF;
  RETURN app.recruitment_unblock_candidate(m.entry_id, p_reason);
 END IF;
 IF p_resolution IS DISTINCT FROM 'not_same_person' THEN
  RAISE EXCEPTION 'Resolve a mark as not the same person or by removing the entry' USING ERRCODE = '22023';
 END IF;
 PERFORM pg_advisory_xact_lock(app.recruitment_blocked_lock_key(m.tenant_id, m.company_id));
 INSERT INTO app.recruitment_blocked_context (txid, tenant_id, company_id) VALUES (txid_current(), m.tenant_id, m.company_id)
  ON CONFLICT (txid, company_id) DO NOTHING;
 SELECT * INTO m FROM public.recruitment_application_review_mark WHERE id = p_mark FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'The mark no longer exists' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_review_mark_gone';
 END IF;
 IF m.cleared_at IS NOT NULL THEN
  RAISE EXCEPTION 'The mark has already been cleared' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_review_mark_cleared';
 END IF;
 SELECT e.candidate_id INTO v_listed FROM public.recruitment_blocked_entry e WHERE e.id = m.entry_id;
 -- The listed person IS that person: only removing the entry resolves a mark their own entry made on their own application.
 IF v_listed = m.candidate_id THEN
  RAISE EXCEPTION 'A mark from the candidate''s own entry is resolved by removing the entry' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_review_mark_own_entry';
 END IF;
 FOR x IN UPDATE public.recruitment_application_review_mark SET cleared_at = now(), cleared_by_user_id = app.current_user_id(), cleared_kind = 'not_same_person'
   WHERE candidate_id = m.candidate_id AND entry_id = m.entry_id AND tenant_id = m.tenant_id AND cleared_at IS NULL RETURNING application_id LOOP
  INSERT INTO public.recruitment_blocked_history (tenant_id, company_id, entry_id, candidate_id, application_id, action, detail, actor_user_id)
   VALUES (m.tenant_id, m.company_id, m.entry_id, v_listed, x.application_id, 'mark_cleared', 'not_same_person', app.current_user_id());
  n := n + 1;
 END LOOP;
 DELETE FROM app.recruitment_blocked_context WHERE txid = txid_current() AND company_id = m.company_id;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_resolve_review_mark(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_resolve_review_mark(uuid, text, text) TO ai_hr_app;
--> statement-breakpoint
-- Does this application need an administrator's review? A yes/no for anyone who may read the application (the job's
-- reviewers, its interviewers and administrators), so a hiring manager or interviewer learns exactly that and nothing else
-- (not the blocked list, the entry or the reason). False for an application the caller may not read. Read-only.
CREATE FUNCTION app.recruitment_application_needs_review(p_application uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
 SELECT p_application IS NOT NULL AND EXISTS (SELECT 1 FROM public.recruitment_application_review_mark m
  WHERE m.application_id = p_application AND m.cleared_at IS NULL AND m.tenant_id = app.current_tenant_id()
   AND app.can_read_recruitment_application(m.company_id, m.job_id, m.application_id));
$$;
REVOKE ALL ON FUNCTION app.recruitment_application_needs_review(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_application_needs_review(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 6. The move, offer and hire refusal while marked ──────────────────────────────────────────────────────
-- An application's applied_at is the database's own clock (whatever a writer sends), so "created in this transaction" is
-- applied_at = now(): the guard below matches such an application before deciding, because the commit-time matching has not
-- run yet. A writer cannot backdate a new application past that check.
CREATE FUNCTION app.recruitment_application_applied_now() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 NEW.applied_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_application_applied_now() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_application_applied_now BEFORE INSERT ON public.recruitment_application
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_application_applied_now();
--> statement-breakpoint
-- Added BESIDE the existing guards (4401/4405 application guard, 4403/4405 offer guard, 4403 hire hand-off guard), which are
-- unchanged. Owner-run so it sees the open mark whoever the caller is (an offer approver may not read the application).
-- While an application has an open mark: no stage change (forward or back) and no hire; no new offer, and an existing offer
-- cannot be submitted, approved, sent or accepted (withdrawing it to Draft and recording the candidate's decline stay
-- possible); no new-hire hand-off. Rejecting the application stays possible. An application created in THIS transaction is
-- matched first (its commit-time matching has not run yet). The removal of the candidate's personal data is not affected.
CREATE FUNCTION app.recruitment_guard_review_mark() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE v_application uuid; v_blocked boolean := false; v_new boolean;
BEGIN
 IF TG_TABLE_NAME = 'recruitment_application' THEN
  v_application := OLD.id;
  v_blocked := OLD.state = 'active' AND (NEW.current_stage_id IS DISTINCT FROM OLD.current_stage_id OR NEW.state = 'hired');
  v_new := OLD.applied_at = now();
 ELSIF TG_TABLE_NAME = 'recruitment_offer' THEN
  v_application := NEW.application_id;
  v_blocked := TG_OP = 'INSERT' OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'draft')
   OR (NEW.pending_position IS DISTINCT FROM OLD.pending_position AND NEW.status <> 'draft')
   OR (NEW.sent_at IS DISTINCT FROM OLD.sent_at AND NEW.sent_at IS NOT NULL)
   OR (NEW.candidate_decision IS DISTINCT FROM OLD.candidate_decision AND NEW.candidate_decision IS DISTINCT FROM 'declined');
 ELSE
  v_application := NEW.application_id;
  v_blocked := true;
 END IF;
 IF v_blocked THEN
  -- Only an application created in THIS transaction (applied_at is the transaction's time) is matched here; any other is
  -- checked with no lock taken and nothing written.
  IF v_new IS NULL THEN
   v_new := EXISTS (SELECT 1 FROM public.recruitment_application x WHERE x.id = v_application AND x.applied_at = now());
  END IF;
  IF v_new THEN
   PERFORM app.recruitment_blocked_match(NEW.tenant_id, NEW.company_id, v_application, true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.recruitment_application_review_mark m WHERE m.application_id = v_application AND m.cleared_at IS NULL) THEN
   RAISE EXCEPTION 'This application needs an administrator''s review first' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_application_needs_review';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_review_mark() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_application_review_mark_guard BEFORE UPDATE OF current_stage_id, state ON public.recruitment_application
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_review_mark();
CREATE TRIGGER recruitment_offer_review_mark_guard BEFORE INSERT OR UPDATE ON public.recruitment_offer
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_review_mark();
CREATE TRIGGER recruitment_hire_handoff_review_mark_guard BEFORE INSERT ON public.recruitment_hire_handoff
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_review_mark();
--> statement-breakpoint

-- ── 6b. Removal marker without a transaction id ──────────────────────────────────────────────────────────
-- 4405's app.recruitment_destroying, restated with ONE change: it compares the marker with txid_current_if_assigned() instead
-- of txid_current(). The removal function writes its marker first (which assigns the transaction id), so for it the answer is
-- unchanged; a read path (a READ ONLY transaction, a hot standby) no longer assigns an id just by asking, and gets false.
CREATE OR REPLACE FUNCTION app.recruitment_destroying(p_candidate uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
 SELECT p_candidate IS NOT NULL AND EXISTS (SELECT 1 FROM app.recruitment_destroy_marker m
  WHERE m.txid = txid_current_if_assigned() AND m.candidate_id = p_candidate);
$$;
--> statement-breakpoint

-- ── 7. Removal: 4412's app.recruitment_destroy_candidate, byte for byte, plus the pools and the blocked list ──────────
-- (The new steps follow the background check steps, before the candidate row is cleared.)
CREATE OR REPLACE FUNCTION app.recruitment_destroy_candidate(p_candidate uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE c public.recruitment_candidate%ROWTYPE; v_apps uuid[]; v_offers uuid[]; n integer; result jsonb := '{}'::jsonb;
BEGIN
 IF p_candidate IS NULL OR app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN
  RAISE EXCEPTION 'Removing a candidate''s personal data needs a recruitment administrator' USING ERRCODE = '42501';
 END IF;
 -- Before anything else: no concurrent write to this candidate's record may interleave with the removal.
 PERFORM pg_advisory_xact_lock(app.recruitment_candidate_lock_key(app.current_tenant_id(), p_candidate));
 SELECT * INTO c FROM public.recruitment_candidate WHERE id = p_candidate AND tenant_id = app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.can_admin_recruitment_for(c.company_id) THEN
  RAISE EXCEPTION 'Removing a candidate''s personal data needs a recruitment administrator' USING ERRCODE = '42501';
 END IF;
 IF c.destroyed_at IS NOT NULL THEN
  RAISE EXCEPTION 'This candidate''s personal data has already been removed' USING ERRCODE = '23514';
 END IF;
 SELECT coalesce(array_agg(a.id), '{}') INTO v_apps FROM public.recruitment_application a WHERE a.candidate_id = c.id AND a.tenant_id = c.tenant_id;
 IF EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = ANY (v_apps) AND a.state IN ('active','hired')) THEN
  RAISE EXCEPTION 'A candidate with an active or hired application keeps their record' USING ERRCODE = '23514';
 END IF;
 -- Slice 13: for a person with a blocked-list entry only (stable here: this removal holds the candidate's lock exclusively and
 -- adding an entry needs it), the company's blocked-list lock (after the candidate's: candidate, then company — the order
 -- every writer here takes), so matching never marks against an entry this removal is deleting, and this removal sees every
 -- mark committed before it. A listed person whose entry still holds an open mark on ANOTHER candidate's active application
 -- keeps their record until an administrator resolves that mark (no hold is lifted without a decision).
 IF EXISTS (SELECT 1 FROM public.recruitment_blocked_entry e WHERE e.candidate_id = c.id AND e.tenant_id = c.tenant_id) THEN
  PERFORM pg_advisory_xact_lock(app.recruitment_blocked_lock_key(c.tenant_id, c.company_id));
  IF EXISTS (SELECT 1 FROM public.recruitment_blocked_entry e
    JOIN public.recruitment_application_review_mark m ON m.entry_id = e.id AND m.cleared_at IS NULL AND m.candidate_id <> c.id
    JOIN public.recruitment_application a ON a.id = m.application_id AND a.state = 'active'
    WHERE e.candidate_id = c.id AND e.tenant_id = c.tenant_id) THEN
   RAISE EXCEPTION 'Resolve the reviews this person''s blocked-list entry holds on other candidates first' USING ERRCODE = '23514',
    CONSTRAINT = 'recruitment_blocked_entry_has_open_marks';
  END IF;
 END IF;
 SELECT coalesce(array_agg(o.id), '{}') INTO v_offers FROM public.recruitment_offer o WHERE o.application_id = ANY (v_apps) AND o.tenant_id = c.tenant_id;
 INSERT INTO app.recruitment_destroy_marker (txid, candidate_id, tenant_id) VALUES (txid_current(), c.id, c.tenant_id);

 -- Slice 10: agency submissions about this person lose their personal data — the one accepted onto this candidate, and those
 -- no candidate links (refused, rejected or still waiting) whose ONLY recorded match is this candidate as a Duplicate (the
 -- same ID number, or the same name with the same e-mail or mobile); one still waiting is closed as rejected. A submission
 -- that matched this candidate only as Suspected, or matched others too, is about someone else: it only loses its link.
 -- Indexed lookups only (by candidate, and the link table by candidate). Each row keeps job, contract, consultant, dates.
 UPDATE public.recruitment_agency_submission s SET full_name = NULL, email = NULL, mobile = NULL, id_type = NULL, id_number = NULL,
  current_salary_amount = NULL, current_salary_currency = NULL, expected_salary_amount = NULL, expected_salary_currency = NULL, comments = NULL,
  review_reason = NULL, resume_name = NULL, resume_mime = NULL, resume_size = NULL, resume_content = NULL, personal_data_removed_at = now()
  WHERE s.candidate_id = c.id AND s.tenant_id = c.tenant_id AND s.personal_data_removed_at IS NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('agencySubmissions', n);
 UPDATE public.recruitment_agency_submission s SET full_name = NULL, email = NULL, mobile = NULL, id_type = NULL, id_number = NULL,
  current_salary_amount = NULL, current_salary_currency = NULL, expected_salary_amount = NULL, expected_salary_currency = NULL, comments = NULL,
  review_reason = NULL, resume_name = NULL, resume_mime = NULL, resume_size = NULL, resume_content = NULL,
  outcome = CASE WHEN s.outcome = 'waiting' THEN 'rejected' ELSE s.outcome END, personal_data_removed_at = now()
  WHERE s.id IN (SELECT m.submission_id FROM app.recruitment_agency_submission_match m
    WHERE m.candidate_id = c.id AND m.tenant_id = c.tenant_id AND m.duplicate
     AND NOT EXISTS (SELECT 1 FROM app.recruitment_agency_submission_match o WHERE o.submission_id = m.submission_id AND o.candidate_id <> c.id))
   AND s.candidate_id IS NULL AND s.personal_data_removed_at IS NULL
   -- Two ID numbers that differ are two people, however alike name and contacts are: only the link goes.
   AND NOT EXISTS (SELECT 1 FROM public.recruitment_candidate_restricted r WHERE r.candidate_id = c.id AND r.tenant_id = c.tenant_id
    AND r.id_number IS NOT NULL AND s.id_number IS NOT NULL AND app.recruitment_norm_id(r.id_number) <> app.recruitment_norm_id(s.id_number));
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('agencyMatchedSubmissions', n);
 DELETE FROM app.recruitment_agency_submission_match WHERE candidate_id = c.id;
 DELETE FROM public.recruitment_candidate_file WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('files', n);
 DELETE FROM public.recruitment_candidate_restricted WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('restricted', n);
 DELETE FROM public.recruitment_candidate_entry WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('entries', n);
 DELETE FROM public.recruitment_candidate_tag WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('tags', n);
 DELETE FROM public.recruitment_candidate_consent WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('consents', n);
 -- Feedback: the 1–5 ratings stay (they carry no personal data); every note and the overview go.
 UPDATE public.recruitment_scorecard s SET overview = NULL,
  ratings = (SELECT coalesce(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'object' THEN e.value - 'notes' ELSE e.value END), '{}'::jsonb)
   FROM jsonb_each(s.ratings) e)
  WHERE s.application_id = ANY (v_apps) AND s.tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('scorecards', n);
 -- Offers: values and rejection comments go; the offer skeleton (status, rounds, decision) stays.
 DELETE FROM public.recruitment_offer_value WHERE offer_id = ANY (v_offers) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('offerValues', n);
 UPDATE public.recruitment_offer SET last_rejection_comment = NULL
  WHERE id = ANY (v_offers) AND tenant_id = c.tenant_id AND last_rejection_comment IS NOT NULL;
 UPDATE public.recruitment_offer_approval SET comment = CASE WHEN decision = 'rejected' THEN '—' ELSE NULL END
  WHERE offer_id = ANY (v_offers) AND tenant_id = c.tenant_id AND comment IS NOT NULL;
 -- The application keeps its skeleton; a free-text source (it may name a referrer) goes.
 UPDATE public.recruitment_application SET source = NULL WHERE id = ANY (v_apps) AND source IS NOT NULL;
 -- Slice 7: a referral keeps its job, date and referrer; the referrer's reason (it describes the candidate) goes.
 UPDATE public.recruitment_referral SET reason = NULL WHERE candidate_id = c.id AND tenant_id = c.tenant_id AND reason IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('referrals', n);
 -- Slice 8: a careers application keeps its job and date; the applicant's message goes.
 UPDATE public.recruitment_careers_application SET message = NULL WHERE candidate_id = c.id AND tenant_id = c.tenant_id AND message IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('careersMessages', n);
 -- Slice 11: screening notes and feedback comments go (they describe the candidate); each request keeps its reviewer, sender,
 -- times and closing, and each answer its result, reviewer and time. Indexed by application.
 UPDATE public.recruitment_screening_request SET note = NULL WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id AND note IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('screeningNotes', n);
 UPDATE public.recruitment_screening_answer SET comment = NULL WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id AND comment IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('screeningComments', n);
 -- Slice 12: the person's OPEN background checks are cancelled by the system (a fixed code, so they no longer show as open
 -- or count as the recorder's to-dos); every check keeps its types, status, outcome and dates; the restricted details
 -- (provider, reference, authorisation, summary, cancellation reason) and every file (authorisation and report) go. Indexed
 -- by application.
 UPDATE public.recruitment_background_check SET status = 'cancelled', system_cancel_reason = 'candidate_removed',
  status_changed_by_user_id = app.current_user_id()
  WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id AND status IN ('awaiting_authorisation','in_progress');
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('backgroundChecksCancelled', n);
 DELETE FROM public.recruitment_background_check_file WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('backgroundCheckFiles', n);
 DELETE FROM public.recruitment_background_check_detail WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('backgroundCheckDetails', n);
 -- Slice 13: the person's pool memberships go (the remover administers the company, so the ordinary membership policy admits
 -- the delete). Their blocked-list entries go with the restricted values (reason, removal reason, identity values), the
 -- history, and every mark those entries made on anyone's application (such a mark has no basis once its entry is gone;
 -- marker-bound owner policies). A mark that SOMEONE ELSE's entry made on this person's applications stays (ids only).
 -- Indexed by candidate and by entry.
 DELETE FROM public.recruitment_talent_pool_member WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('poolMemberships', n);
 DELETE FROM public.recruitment_application_review_mark WHERE entry_id IN (SELECT e.id FROM public.recruitment_blocked_entry e
  WHERE e.candidate_id = c.id AND e.tenant_id = c.tenant_id) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('blockedMarks', n);
 DELETE FROM public.recruitment_blocked_history WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 DELETE FROM public.recruitment_blocked_entry_restricted WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 DELETE FROM public.recruitment_blocked_entry WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('blockedEntries', n);
 UPDATE public.recruitment_candidate SET
  full_name = 'Removed candidate ' || upper(substr(replace(c.id::text, '-', ''), 1, 8)), email = NULL, phone = NULL, location = NULL,
  current_company = NULL, current_title = NULL, highest_education = NULL, notice_period = NULL, source = NULL,
  destroyed_at = now(), destroyed_by_user_id = app.current_user_id(), updated_at = now(), updated_by_user_id = app.current_user_id()
  WHERE id = c.id;
 DELETE FROM app.recruitment_destroy_marker WHERE txid = txid_current() AND candidate_id = c.id;
 RETURN result || jsonb_build_object('applications', cardinality(v_apps), 'offers', cardinality(v_offers));
END $$;
REVOKE ALL ON FUNCTION app.recruitment_destroy_candidate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_destroy_candidate(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 8. Deleting a company (core/company-refs.ts): 4412's body plus the pool and blocked-list tables ─────────────────
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
 DELETE FROM public.recruitment_evaluation_form WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_archive_reason WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_process WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
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
 PERFORM set_config('app.recruitment_company_delete', '', true);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_delete_company_setup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;

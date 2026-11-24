-- ADR 0181 Phase 2 pilot: precomputed company access for the Job descriptions read path
-- (docs/adr/0181-addendum-precomputed-company-access.md, owner approved 24 November 2026).
--
-- app.access_workforce_company(company,capability) was evaluated for every job_document row, again for every
-- job_document_revision row (through app.job_document_scope) and again by the count. Its answer splits into
--  * facts about the current session and user (principal snapshot, archive, login block on current_date, claimed
--    grants, storage owner): the same for every row, so they stay live and are evaluated once per statement; and
--  * facts that differ by company (admin role scope, configurable-access allowance, the effective-dated company
--    tree): stored here, maintained in the same transaction as every change to their inputs by statement triggers.
-- app.access_workforce_companies(capability) returns the companies once per statement (an InitPlan). Its mode is
-- installation wide: 'legacy' (the default) evaluates the existing per-company owner once per company, exactly as
-- 5076 and 7150 do; 'shadow' also reads the stored answer and logs difference counts only; 'precomputed' serves the
-- stored answer when the tenant is trusted and inside its date window, and otherwise the legacy answer. No mode
-- denies by itself. The job_document write policies are unchanged; the revision write policy is FOR ALL and so
-- governs reads too, and is restated once per statement with the same predicate.
--
-- Restated predecessor bodies are pinned by test/access-effective-company-equivalence.test.ts: a change to any of
-- them must change these functions in the same migration.
CREATE TABLE public.access_company_closure(
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 ancestor_id uuid NOT NULL,
 descendant_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,ancestor_id,descendant_id)
);
--> statement-breakpoint
CREATE TABLE public.access_effective_company(
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 user_id uuid NOT NULL,
 capability text NOT NULL CHECK(capability IN ('workforce.view','workforce.maintain')),
 company_id uuid NOT NULL,
 roles text[] NOT NULL CHECK(cardinality(roles)>0 AND roles <@ ARRAY['hr_admin','super_admin']::text[]),
 access_version bigint NOT NULL,
 PRIMARY KEY(tenant_id,user_id,capability,company_id)
);
--> statement-breakpoint
CREATE TABLE public.access_company_state(
 tenant_id uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
 access_version bigint NOT NULL DEFAULT 1,
 computed_for date,
 valid_until date,
 trusted boolean NOT NULL DEFAULT true,
 refreshed_at timestamptz,
 last_verified_at timestamptz,
 last_difference_count integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE public.access_precompute_control(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 mode text NOT NULL DEFAULT 'legacy' CHECK(mode IN ('legacy','shadow','precomputed')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO public.access_precompute_control(singleton,mode) VALUES(true,'legacy');
--> statement-breakpoint
ALTER TABLE public.access_company_closure ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_company_closure FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_effective_company ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_effective_company FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_company_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_company_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_precompute_control ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_precompute_control FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Only the owner (the definer functions below) reads or writes these tables; ai_hr_app has no privilege on them.
CREATE POLICY access_company_closure_owner ON public.access_company_closure FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY access_effective_company_owner ON public.access_effective_company FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY access_company_state_owner ON public.access_company_state FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY access_precompute_control_owner ON public.access_precompute_control FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON public.access_company_closure,public.access_effective_company,public.access_company_state,public.access_precompute_control FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The company tree as app.company_org_descendant_for_tenant walks it today: each company with itself and every
-- ancestor reached through app.company_org_parent_for_tenant, stopping at a missing company, a cycle or the root.
CREATE FUNCTION app.access_company_closure_compute(p_tenant uuid) RETURNS TABLE(ancestor_id uuid,descendant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE up(descendant_id,ancestor_id,path) AS (
  SELECT c.id,c.id,ARRAY[c.id] FROM public.company c WHERE c.tenant_id=p_tenant
  UNION ALL
  SELECT up.descendant_id,parent.id,up.path||parent.id
  FROM up CROSS JOIN LATERAL (SELECT app.company_org_parent_for_tenant(p_tenant,up.ancestor_id) AS id) p
  JOIN public.company parent ON parent.id=p.id AND parent.tenant_id=p_tenant
  WHERE NOT (parent.id=ANY(up.path))
 )
 SELECT DISTINCT up.ancestor_id,up.descendant_id FROM up;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_company_closure_compute(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The company-dependent part of app.access_workforce_company's user branch, for every admin role holder (or the
-- listed users) of the tenant, over the STORED closure: role_assignment scope (app.access_scope_covers), and when
-- the capability is supported, app.access_allowed_for_tenant without its user-only conditions (archive and login
-- block), which the read function checks live for the same user. The catalogue is read as this tenant sees it
-- (app.access_capability_effective, 5071), exactly as both installed predecessors read it.
CREATE FUNCTION app.access_effective_company_compute(p_tenant uuid,p_users uuid[])
RETURNS TABLE(user_id uuid,capability text,company_id uuid,roles text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH admin AS (
  SELECT r.app_user_id AS user_id,r.role::text AS role,r.company_id AS scope
  FROM public.role_assignment r JOIN public.app_user u ON u.id=r.app_user_id AND u.tenant_id=r.tenant_id
  WHERE r.tenant_id=p_tenant AND r.role::text IN ('hr_admin','super_admin') AND (p_users IS NULL OR r.app_user_id=ANY(p_users))
 ),
 covered AS (
  SELECT a.user_id,a.role,k.descendant_id AS company_id FROM admin a
  JOIN public.access_company_closure k ON k.tenant_id=p_tenant
   AND ((a.scope IS NULL AND k.ancestor_id=k.descendant_id) OR k.ancestor_id=a.scope)
 ),
 pairs AS (SELECT DISTINCT cv.user_id,cv.company_id FROM covered cv),
 config AS (SELECT coalesce(bool_or(s.initialized),false) AS initialized FROM public.access_configuration s WHERE s.tenant_id=p_tenant),
 allowed AS (
  SELECT p.user_id,c.id AS capability,p.company_id
  FROM pairs p CROSS JOIN app.access_capability_effective(p_tenant) c CROSS JOIN config
  WHERE c.id IN ('workforce.view','workforce.maintain')
   AND CASE WHEN NOT c.supported THEN true ELSE (config.initialized AND jsonb_array_length(c.bindings)>0 AND c.scope='company'
    AND NOT EXISTS(SELECT 1 FROM public.access_user_override o
     WHERE o.tenant_id=p_tenant AND o.user_id=p.user_id AND o.capability_id=c.id AND o.effect='deny' AND o.retired_at IS NULL
      AND (o.company_id IS NULL OR EXISTS(SELECT 1 FROM public.access_company_closure k WHERE k.tenant_id=p_tenant AND k.ancestor_id=o.company_id AND k.descendant_id=p.company_id)))
    AND (EXISTS(SELECT 1 FROM public.access_user_override o
      WHERE o.tenant_id=p_tenant AND o.user_id=p.user_id AND o.capability_id=c.id AND o.effect='allow' AND o.retired_at IS NULL
       AND (o.company_id IS NULL OR EXISTS(SELECT 1 FROM public.access_company_closure k WHERE k.tenant_id=p_tenant AND k.ancestor_id=o.company_id AND k.descendant_id=p.company_id)))
     OR EXISTS(SELECT 1 FROM public.access_effective_membership m
      JOIN public.access_group g ON g.id=m.group_id AND g.tenant_id=m.tenant_id
      JOIN public.access_group_grant a ON a.group_id=g.id AND a.tenant_id=g.tenant_id
      WHERE m.tenant_id=p_tenant AND m.user_id=p.user_id AND g.retired_at IS NULL AND a.capability_id=c.id AND a.retired_at IS NULL
       AND (m.company_id IS NULL OR EXISTS(SELECT 1 FROM public.access_company_closure k WHERE k.tenant_id=p_tenant AND k.ancestor_id=m.company_id AND k.descendant_id=p.company_id))
       AND (a.company_id IS NULL OR EXISTS(SELECT 1 FROM public.access_company_closure k WHERE k.tenant_id=p_tenant AND k.ancestor_id=a.company_id AND k.descendant_id=p.company_id))))) END
 )
 SELECT al.user_id,al.capability,al.company_id,array_agg(DISTINCT cv.role ORDER BY cv.role)
 FROM allowed al JOIN covered cv ON cv.user_id=al.user_id AND cv.company_id=al.company_id
 GROUP BY al.user_id,al.capability,al.company_id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_effective_company_compute(uuid,uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Maintain one tenant in the caller's transaction. Incrementing access_version first takes the tenant's state row
-- lock, which serialises maintainers; under Read Committed the statements after it see every earlier committer.
-- p_users NULL (or a closure outside its date window) recomputes the closure and every row of the tenant.
-- The day is the company tree's own clock (app.company_org_parent_for_tenant): no new SQL clock is introduced.
CREATE FUNCTION app.access_effective_company_refresh(p_tenant uuid,p_users uuid[]) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 v_today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 v_version bigint;v_for date;v_until date;
BEGIN
 IF p_tenant IS NULL OR NOT EXISTS(SELECT 1 FROM public.tenant t WHERE t.id=p_tenant) THEN RETURN NULL; END IF;
 INSERT INTO public.access_company_state AS s(tenant_id) VALUES(p_tenant)
  ON CONFLICT(tenant_id) DO UPDATE SET access_version=s.access_version+1
  RETURNING s.access_version,s.computed_for,s.valid_until INTO v_version,v_for,v_until;
 IF p_users IS NULL OR v_for IS NULL OR v_for>v_today OR (v_until IS NOT NULL AND v_today>=v_until) THEN
  DELETE FROM public.access_company_closure k WHERE k.tenant_id=p_tenant;
  INSERT INTO public.access_company_closure(tenant_id,ancestor_id,descendant_id)
   SELECT p_tenant,x.ancestor_id,x.descendant_id FROM app.access_company_closure_compute(p_tenant) x;
  UPDATE public.access_company_state s SET computed_for=v_today,refreshed_at=now(),
   valid_until=(SELECT min(r.effective_on) FROM public.company_organisation_run r WHERE r.tenant_id=p_tenant AND r.state='published' AND r.effective_on>v_today)
  WHERE s.tenant_id=p_tenant;
  DELETE FROM public.access_effective_company e WHERE e.tenant_id=p_tenant;
  INSERT INTO public.access_effective_company(tenant_id,user_id,capability,company_id,roles,access_version)
   SELECT p_tenant,x.user_id,x.capability,x.company_id,x.roles,v_version FROM app.access_effective_company_compute(p_tenant,NULL) x;
 ELSE
  DELETE FROM public.access_effective_company e WHERE e.tenant_id=p_tenant AND e.user_id=ANY(p_users);
  INSERT INTO public.access_effective_company(tenant_id,user_id,capability,company_id,roles,access_version)
   SELECT p_tenant,x.user_id,x.capability,x.company_id,x.roles,v_version FROM app.access_effective_company_compute(p_tenant,p_users) x;
  UPDATE public.access_company_state s SET refreshed_at=now() WHERE s.tenant_id=p_tenant;
 END IF;
 RETURN v_version;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_effective_company_refresh(uuid,uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Statement triggers. Transition tables are named new_rows and old_rows on every table.
CREATE FUNCTION app.access_effective_company_role_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t record;
BEGIN
 IF TG_OP='INSERT' THEN
  FOR t IN SELECT n.tenant_id,array_agg(DISTINCT n.app_user_id) AS users FROM new_rows n GROUP BY n.tenant_id LOOP PERFORM app.access_effective_company_refresh(t.tenant_id,t.users); END LOOP;
 ELSIF TG_OP='DELETE' THEN
  FOR t IN SELECT o.tenant_id,array_agg(DISTINCT o.app_user_id) AS users FROM old_rows o GROUP BY o.tenant_id LOOP PERFORM app.access_effective_company_refresh(t.tenant_id,t.users); END LOOP;
 ELSE
  FOR t IN SELECT x.tenant_id,array_agg(DISTINCT x.app_user_id) AS users FROM (SELECT n.tenant_id,n.app_user_id FROM new_rows n UNION ALL SELECT o.tenant_id,o.app_user_id FROM old_rows o) x GROUP BY x.tenant_id LOOP
   PERFORM app.access_effective_company_refresh(t.tenant_id,t.users);
  END LOOP;
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.access_effective_company_user_rows_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t record;
BEGIN
 IF TG_OP='INSERT' THEN
  FOR t IN SELECT n.tenant_id,array_agg(DISTINCT n.user_id) AS users FROM new_rows n GROUP BY n.tenant_id LOOP PERFORM app.access_effective_company_refresh(t.tenant_id,t.users); END LOOP;
 ELSIF TG_OP='DELETE' THEN
  FOR t IN SELECT o.tenant_id,array_agg(DISTINCT o.user_id) AS users FROM old_rows o GROUP BY o.tenant_id LOOP PERFORM app.access_effective_company_refresh(t.tenant_id,t.users); END LOOP;
 ELSE
  FOR t IN SELECT x.tenant_id,array_agg(DISTINCT x.user_id) AS users FROM (SELECT n.tenant_id,n.user_id FROM new_rows n UNION ALL SELECT o.tenant_id,o.user_id FROM old_rows o) x GROUP BY x.tenant_id LOOP
   PERFORM app.access_effective_company_refresh(t.tenant_id,t.users);
  END LOOP;
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.access_effective_company_tenant_rows_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;
BEGIN
 IF TG_OP='INSERT' THEN
  FOR t IN SELECT DISTINCT n.tenant_id FROM new_rows n LOOP PERFORM app.access_effective_company_refresh(t,NULL); END LOOP;
 ELSIF TG_OP='DELETE' THEN
  FOR t IN SELECT DISTINCT o.tenant_id FROM old_rows o LOOP PERFORM app.access_effective_company_refresh(t,NULL); END LOOP;
 ELSE
  FOR t IN SELECT n.tenant_id FROM new_rows n UNION SELECT o.tenant_id FROM old_rows o LOOP PERFORM app.access_effective_company_refresh(t,NULL); END LOOP;
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
-- A company update matters only when it moves the tree (parent or tenant); other company edits cost nothing here.
CREATE FUNCTION app.access_effective_company_company_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;
BEGIN
 IF TG_OP='INSERT' THEN
  FOR t IN SELECT DISTINCT n.tenant_id FROM new_rows n LOOP PERFORM app.access_effective_company_refresh(t,NULL); END LOOP;
 ELSIF TG_OP='DELETE' THEN
  FOR t IN SELECT DISTINCT o.tenant_id FROM old_rows o LOOP PERFORM app.access_effective_company_refresh(t,NULL); END LOOP;
 ELSE
  FOR t IN SELECT x.tenant_id FROM (
    SELECT n.tenant_id FROM new_rows n LEFT JOIN old_rows o ON o.id=n.id
     WHERE o.id IS NULL OR o.parent_company_id IS DISTINCT FROM n.parent_company_id OR o.tenant_id IS DISTINCT FROM n.tenant_id
    UNION
    SELECT o.tenant_id FROM old_rows o LEFT JOIN new_rows n ON n.id=o.id
     WHERE n.id IS NULL OR o.parent_company_id IS DISTINCT FROM n.parent_company_id OR o.tenant_id IS DISTINCT FROM n.tenant_id) x
  LOOP PERFORM app.access_effective_company_refresh(t,NULL); END LOOP;
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
-- The capability catalogue is global and migration-owned: a change to a Workforce capability recomputes every
-- tenant that has companies.
CREATE FUNCTION app.access_effective_company_capability_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;relevant boolean;
BEGIN
 IF TG_OP='INSERT' THEN SELECT EXISTS(SELECT 1 FROM new_rows n WHERE n.id IN ('workforce.view','workforce.maintain')) INTO relevant;
 ELSIF TG_OP='DELETE' THEN SELECT EXISTS(SELECT 1 FROM old_rows o WHERE o.id IN ('workforce.view','workforce.maintain')) INTO relevant;
 ELSE SELECT EXISTS(SELECT 1 FROM new_rows n WHERE n.id IN ('workforce.view','workforce.maintain')) OR EXISTS(SELECT 1 FROM old_rows o WHERE o.id IN ('workforce.view','workforce.maintain')) INTO relevant;
 END IF;
 IF relevant THEN
  FOR t IN SELECT DISTINCT c.tenant_id FROM public.company c ORDER BY 1 LOOP PERFORM app.access_effective_company_refresh(t,NULL); END LOOP;
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
-- A capability publication (5071) changes what each tenant sees of the catalogue: opening or closing a version
-- recomputes every tenant; one tenant's publication recomputes that tenant (access_capability_tenant_publication
-- has tenant_id and uses the tenant function).
CREATE FUNCTION app.access_effective_company_publication_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;
BEGIN
 FOR t IN SELECT DISTINCT c.tenant_id FROM public.company c ORDER BY 1 LOOP PERFORM app.access_effective_company_refresh(t,NULL); END LOOP;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_effective_company_publication_changed(),app.access_effective_company_role_changed(),app.access_effective_company_user_rows_changed(),
 app.access_effective_company_tenant_rows_changed(),app.access_effective_company_company_changed(),
 app.access_effective_company_capability_changed() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- A trigger with transition tables takes one event, so each table gets an INSERT, an UPDATE and a DELETE trigger.
DO $triggers$
DECLARE
 target record;ev text;
BEGIN
 FOR target IN SELECT * FROM (VALUES
  ('role_assignment','access_effective_company_role_changed'),
  ('access_membership','access_effective_company_user_rows_changed'),
  ('access_user_override','access_effective_company_user_rows_changed'),
  ('access_group','access_effective_company_tenant_rows_changed'),
  ('access_group_grant','access_effective_company_tenant_rows_changed'),
  ('access_configuration','access_effective_company_tenant_rows_changed'),
  ('company_organisation_run','access_effective_company_tenant_rows_changed'),
  ('company_organisation_mapping','access_effective_company_tenant_rows_changed'),
  ('company','access_effective_company_company_changed'),
  ('access_capability','access_effective_company_capability_changed'),
  ('app.access_capability_publication','access_effective_company_publication_changed'),
  ('app.access_capability_tenant_publication','access_effective_company_tenant_rows_changed')) v(tbl,fn)
 LOOP
  FOREACH ev IN ARRAY ARRAY['insert','update','delete'] LOOP
   EXECUTE format('CREATE TRIGGER %I AFTER %s ON %s REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION app.%I()',
    'access_effective_company_'||ev,upper(ev),CASE WHEN target.tbl LIKE 'app.%' THEN target.tbl ELSE 'public.'||quote_ident(target.tbl) END,
    CASE ev WHEN 'insert' THEN 'NEW TABLE AS new_rows' WHEN 'delete' THEN 'OLD TABLE AS old_rows' ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows' END,
    target.fn);
  END LOOP;
 END LOOP;
END;
$triggers$;
--> statement-breakpoint
-- Why the stored answer cannot be used for this statement, or NULL when it can.
CREATE FUNCTION app.access_effective_company_unusable() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.current_user_id() IS NULL THEN 'no_user'
  WHEN s.tenant_id IS NULL THEN 'no_state'
  WHEN NOT s.trusted THEN 'untrusted'
  WHEN s.computed_for IS NULL OR s.computed_for>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   OR (s.valid_until IS NOT NULL AND (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date>=s.valid_until) THEN 'outside_window'
 END
 FROM (SELECT 1) one LEFT JOIN public.access_company_state s ON s.tenant_id=app.current_tenant_id();
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_effective_company_unusable() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The stored answer for the current user: the live user-only conditions of app.access_workforce_company, then the
-- stored companies whose qualifying role is claimed in this session for that company (app.has_role_for over the
-- stored closure).
CREATE FUNCTION app.access_effective_company_stored(p_capability text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.current_user_id() IS NOT NULL AND app.principal_snapshot_current()
   AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
    AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
  THEN (SELECT coalesce(array_agg(e.company_id ORDER BY e.company_id),'{}'::uuid[]) FROM public.access_effective_company e
   WHERE e.tenant_id=app.current_tenant_id() AND e.user_id=app.current_user_id() AND e.capability=p_capability
    AND EXISTS(SELECT 1 FROM app.current_grants() g WHERE g.role=ANY(e.roles)
     AND (g.company_id IS NULL OR EXISTS(SELECT 1 FROM public.access_company_closure k
      WHERE k.tenant_id=e.tenant_id AND k.ancestor_id=g.company_id AND k.descendant_id=e.company_id))))
  ELSE '{}'::uuid[] END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_effective_company_stored(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The companies of the current tenant on which the session may use a Workforce capability, once per statement.
-- Exactly { c : app.access_workforce_company(c, p_capability) } in every mode. Shadow log lines carry counts only.
CREATE FUNCTION app.access_workforce_companies(p_capability text) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_mode text;v_reason text;v_stored uuid[];v_legacy uuid[];
BEGIN
 IF p_capability IS NULL OR p_capability NOT IN ('workforce.view','workforce.maintain') OR app.current_tenant_id() IS NULL THEN
  RETURN '{}'::uuid[];
 END IF;
 SELECT c.mode INTO v_mode FROM public.access_precompute_control c WHERE c.singleton;
 v_mode:=coalesce(v_mode,'legacy');
 IF v_mode<>'legacy' THEN
  v_reason:=app.access_effective_company_unusable();
  IF v_reason IS NULL THEN
   v_stored:=app.access_effective_company_stored(p_capability);
   IF v_mode='precomputed' THEN RETURN v_stored; END IF;
  END IF;
 END IF;
 SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}'::uuid[]) INTO v_legacy FROM public.company c
  WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_company(c.id,p_capability);
 IF v_mode='shadow' THEN
  IF v_reason IS NULL THEN
   RAISE LOG 'access_effective_company shadow capability=% missing=% extra=% reason=compared',p_capability,
    (SELECT count(*) FROM unnest(v_legacy) x WHERE x<>ALL(v_stored)),(SELECT count(*) FROM unnest(v_stored) x WHERE x<>ALL(v_legacy));
  ELSE
   RAISE LOG 'access_effective_company shadow capability=% missing=0 extra=0 reason=%',p_capability,v_reason;
  END IF;
 END IF;
 RETURN v_legacy;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_companies(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_companies(text) TO ai_hr_app;
--> statement-breakpoint
-- Rebuild-and-compare for one tenant (owner connection, scripts/access-effective-company-check.ts). A closure
-- outside its date window is recomputed first (the expected midnight case, not a difference). Any difference
-- between the maintained rows and a from-scratch recompute marks the tenant untrusted, so reads fall back to the
-- legacy answer until an operator re-trusts it. Returns counts only.
CREATE FUNCTION app.access_effective_company_verify(p_tenant uuid)
RETURNS TABLE(window_refreshed boolean,closure_missing integer,closure_extra integer,rows_missing integer,rows_extra integer,trusted boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 v_today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 s public.access_company_state%ROWTYPE;
 v_refreshed boolean:=false;cm integer;ce integer;rm integer;re integer;
BEGIN
 SELECT * INTO s FROM public.access_company_state x WHERE x.tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND OR s.computed_for IS NULL OR s.computed_for>v_today OR (s.valid_until IS NOT NULL AND v_today>=s.valid_until) THEN
  PERFORM app.access_effective_company_refresh(p_tenant,NULL);v_refreshed:=true;
 END IF;
 SELECT count(*) INTO cm FROM (SELECT x.ancestor_id,x.descendant_id FROM app.access_company_closure_compute(p_tenant) x
  EXCEPT SELECT k.ancestor_id,k.descendant_id FROM public.access_company_closure k WHERE k.tenant_id=p_tenant) d;
 SELECT count(*) INTO ce FROM (SELECT k.ancestor_id,k.descendant_id FROM public.access_company_closure k WHERE k.tenant_id=p_tenant
  EXCEPT SELECT x.ancestor_id,x.descendant_id FROM app.access_company_closure_compute(p_tenant) x) d;
 SELECT count(*) INTO rm FROM (SELECT x.user_id,x.capability,x.company_id,x.roles FROM app.access_effective_company_compute(p_tenant,NULL) x
  EXCEPT SELECT e.user_id,e.capability,e.company_id,e.roles FROM public.access_effective_company e WHERE e.tenant_id=p_tenant) d;
 SELECT count(*) INTO re FROM (SELECT e.user_id,e.capability,e.company_id,e.roles FROM public.access_effective_company e WHERE e.tenant_id=p_tenant
  EXCEPT SELECT x.user_id,x.capability,x.company_id,x.roles FROM app.access_effective_company_compute(p_tenant,NULL) x) d;
 UPDATE public.access_company_state x SET last_verified_at=now(),last_difference_count=cm+ce+rm+re,
  trusted=x.trusted AND cm+ce+rm+re=0 WHERE x.tenant_id=p_tenant RETURNING x.trusted INTO s.trusted;
 RETURN QUERY SELECT v_refreshed,cm,ce,rm,re,coalesce(s.trusted,false);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_effective_company_verify(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Operator only: after the cause of a difference is fixed, recompute the tenant and trust it again.
CREATE FUNCTION app.access_effective_company_retrust(p_tenant uuid) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v bigint;
BEGIN
 v:=app.access_effective_company_refresh(p_tenant,NULL);
 UPDATE public.access_company_state s SET trusted=true,last_difference_count=0 WHERE s.tenant_id=p_tenant;
 RETURN v;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_effective_company_retrust(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Operator only, installation wide: 'legacy', 'shadow' or 'precomputed'.
CREATE FUNCTION app.access_precompute_set_mode(p_mode text) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 UPDATE public.access_precompute_control SET mode=p_mode,updated_at=now() WHERE singleton RETURNING mode;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_precompute_set_mode(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Build every existing tenant once, as the owner, in this migration's transaction.
DO $build$
DECLARE t uuid;
BEGIN
 FOR t IN SELECT DISTINCT c.tenant_id FROM public.company c ORDER BY 1 LOOP PERFORM app.access_effective_company_refresh(t,NULL); END LOOP;
END;
$build$;
--> statement-breakpoint
-- The Job descriptions read policies, once per statement instead of once per row. Same predicates:
-- app.job_document_scope(t,j) is t = current tenant AND the job is in t AND its company passes
-- app.access_workforce_company(company,'workforce.view').
DROP POLICY job_document_read ON public.job_document;
--> statement-breakpoint
CREATE POLICY job_document_read ON public.job_document FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND company_id=ANY((SELECT app.access_workforce_companies('workforce.view'))::uuid[]));
--> statement-breakpoint
-- job_document_revision_write is FOR ALL, so PostgreSQL also ORs its USING into every revision read. Same predicate,
-- once per statement: job_document_scope (view) AND the job's company passes 'workforce.maintain'. One job row
-- (its primary key) satisfies both EXISTS clauses of the original, so they combine into one.
DROP POLICY job_document_revision_write ON public.job_document_revision;
--> statement-breakpoint
CREATE POLICY job_document_revision_write ON public.job_document_revision FOR ALL TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.job_document j
  WHERE j.tenant_id=job_document_revision.tenant_id AND j.id=job_document_revision.job_id
   AND j.company_id=ANY((SELECT app.access_workforce_companies('workforce.view'))::uuid[])
   AND j.company_id=ANY((SELECT app.access_workforce_companies('workforce.maintain'))::uuid[])))
 WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.job_document j
  WHERE j.tenant_id=job_document_revision.tenant_id AND j.id=job_document_revision.job_id
   AND j.company_id=ANY((SELECT app.access_workforce_companies('workforce.view'))::uuid[])
   AND j.company_id=ANY((SELECT app.access_workforce_companies('workforce.maintain'))::uuid[])));
--> statement-breakpoint
DROP POLICY job_document_revision_read ON public.job_document_revision;
--> statement-breakpoint
CREATE POLICY job_document_revision_read ON public.job_document_revision FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.job_document j
  WHERE j.tenant_id=job_document_revision.tenant_id AND j.id=job_document_revision.job_id
   AND j.company_id=ANY((SELECT app.access_workforce_companies('workforce.view'))::uuid[])));

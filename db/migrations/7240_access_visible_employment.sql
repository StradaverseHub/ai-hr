-- ADR 0181: precomputed employment visibility, step (c) of the addendum the owner approved on 24 November 2026
-- (docs/adr/0181-addendum-precomputed-employment-visibility.md).
--
-- app.visible_employment_ids() (5144) answers, once per statement, which employments the caller may see: the admin
-- arm (session claims, once per company), the caller's own employments, the recursive administrative-line walk from
-- each of the caller's current employments, the department-head walk, and the attendance final-decision window.
-- The two walks are the cost: every statement re-walks them with a definer company check per hop. Here:
--  * the administrative-line walk is stored per root employment (access_reporting_reach), keyed by employment, so a
--    role change, a claim or a user linked to a person needs no maintenance; the caller's own employments stay live;
--  * the department tree is stored as a closure clamped exactly as app.heads_department_of clamps it
--    (access_department_closure); the head's qualification and the subjects' current assignments stay live;
--  * the admin arm, the self arm and the attendance window are unchanged and live.
-- app.access_visible_employment_ids() returns the relationship part (everything but the admin arm). Its mode is
-- installation wide, as 7210's: 'legacy' (the default) runs the 5144 statements unchanged; 'shadow' also reads the
-- stored answer and logs exact-set difference counts only; 'precomputed' serves the stored answer when the tenant is
-- trusted, fresh, inside both date windows and on the Kuala Lumpur clock, and otherwise the legacy answer. No mode
-- denies by itself.
-- app.visible_employment_ids() keeps its signature and result: the admin arm unioned with the relationship part.
-- employment_rls and person_rls ask their company questions once per statement (app.employment_read_companies,
-- app.employment_partner_companies) instead of per row, with identical predicates (addendum section 6).
--
-- Maintenance is attached to the input tables with statement triggers that first diff the columns they read, so the
-- many employment writers that save other columns cost nothing here (the 7210 lesson). Dates: reporting lines are
-- evaluated on the HR date, (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date, which is what their current_date means on
-- the product's sessions; a session whose current_date differs always gets the legacy answer.
CREATE TABLE public.access_reporting_reach(
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 root_employment_id uuid NOT NULL REFERENCES employment(id) ON DELETE CASCADE,
 subject_employment_id uuid NOT NULL REFERENCES employment(id) ON DELETE CASCADE,
 access_version bigint NOT NULL,
 PRIMARY KEY(root_employment_id,subject_employment_id)
);
--> statement-breakpoint
CREATE INDEX access_reporting_reach_subject_idx ON public.access_reporting_reach(subject_employment_id);
--> statement-breakpoint
CREATE INDEX access_reporting_reach_tenant_idx ON public.access_reporting_reach(tenant_id);
--> statement-breakpoint
CREATE TABLE public.access_department_closure(
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 ancestor_department_id uuid NOT NULL REFERENCES department(id) ON DELETE CASCADE,
 descendant_department_id uuid NOT NULL REFERENCES department(id) ON DELETE CASCADE,
 PRIMARY KEY(ancestor_department_id,descendant_department_id)
);
--> statement-breakpoint
CREATE INDEX access_department_closure_tenant_idx ON public.access_department_closure(tenant_id);
--> statement-breakpoint
CREATE TABLE public.access_employment_state(
 tenant_id uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
 access_version bigint NOT NULL DEFAULT 1,
 computed_for date,
 valid_until date,
 closure_signature text,
 stale boolean NOT NULL DEFAULT false,
 trusted boolean NOT NULL DEFAULT true,
 last_verified_at timestamptz,
 last_difference_count integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE public.access_employment_precompute_control(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 mode text NOT NULL DEFAULT 'legacy' CHECK(mode IN ('legacy','shadow','precomputed')),
 -- A whole-tenant recompute above this many employments is not done inline: the tenant is marked stale (reads fall
 -- back) and the scheduled check rebuilds it (ADR 0181: changes too large for a request run outside it).
 inline_rebuild_limit integer NOT NULL DEFAULT 20000 CHECK(inline_rebuild_limit>=0),
 updated_at timestamptz
);
--> statement-breakpoint
INSERT INTO public.access_employment_precompute_control(singleton,mode) VALUES(true,'legacy');
--> statement-breakpoint
ALTER TABLE public.access_reporting_reach ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_reporting_reach FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_department_closure ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_department_closure FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_employment_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_employment_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_employment_precompute_control ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.access_employment_precompute_control FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY access_reporting_reach_owner ON public.access_reporting_reach FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY access_department_closure_owner ON public.access_department_closure FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY access_employment_state_owner ON public.access_employment_state FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY access_employment_precompute_control_owner ON public.access_employment_precompute_control FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON public.access_reporting_reach,public.access_department_closure,public.access_employment_state,public.access_employment_precompute_control FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The administrative-line walk of app.is_admin_report_of / the 5144 `down` CTE, per root employment, on p_day:
-- direct reports first (depth 1), then reports of every reachable non-terminated manager, up to depth 64, each
-- subordinate non-terminated and its company a descendant (or itself) of the ROOT's company (the stored 7210
-- closure is app.is_company_descendant). Roots are the tenant's non-terminated employments (all, or p_roots).
-- p_within restricts the nodes a path may pass through or end at, and p_targets the subjects returned; both NULL
-- means unrestricted. A path to a subject only passes through that subject's ancestors, so restricting to
-- (targets and their ancestors) changes no answer for those targets.
CREATE FUNCTION app.access_reach_compute(p_tenant uuid,p_day date,p_roots uuid[],p_targets uuid[],p_within uuid[])
RETURNS TABLE(root_employment_id uuid,subject_employment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE roots AS MATERIALIZED (
  SELECT e.id,e.company_id FROM public.employment e
  WHERE e.tenant_id=p_tenant AND e.terminated_on IS NULL AND (p_roots IS NULL OR e.id IN (SELECT unnest(p_roots)))
 ),
 within AS MATERIALIZED (SELECT unnest(p_within) AS id),
 down(root,root_company,emp,depth) AS (
  SELECT r.id,r.company_id,rl.subordinate_employment_id,1
  FROM roots r
  JOIN public.reporting_line rl ON rl.manager_employment_id=r.id
  JOIN public.employment sub ON sub.id=rl.subordinate_employment_id
  WHERE rl.line_type='administrative' AND rl.superseded_at IS NULL
   AND rl.valid_from<=p_day AND (rl.valid_to IS NULL OR rl.valid_to>p_day)
   AND sub.terminated_on IS NULL
   AND (p_within IS NULL OR sub.id IN (SELECT w.id FROM within w))
   AND EXISTS(SELECT 1 FROM public.access_company_closure k WHERE k.tenant_id=p_tenant AND k.ancestor_id=r.company_id AND k.descendant_id=sub.company_id)
  UNION
  SELECT d.root,d.root_company,rl.subordinate_employment_id,d.depth+1
  FROM down d
  JOIN public.reporting_line rl ON rl.manager_employment_id=d.emp
  JOIN public.employment mid ON mid.id=rl.manager_employment_id
  JOIN public.employment sub ON sub.id=rl.subordinate_employment_id
  WHERE rl.line_type='administrative' AND rl.superseded_at IS NULL
   AND rl.valid_from<=p_day AND (rl.valid_to IS NULL OR rl.valid_to>p_day)
   AND mid.terminated_on IS NULL AND sub.terminated_on IS NULL AND d.depth<64
   AND (p_within IS NULL OR sub.id IN (SELECT w.id FROM within w))
   AND EXISTS(SELECT 1 FROM public.access_company_closure k WHERE k.tenant_id=p_tenant AND k.ancestor_id=d.root_company AND k.descendant_id=sub.company_id)
 )
 SELECT DISTINCT d.root,d.emp FROM down d WHERE p_targets IS NULL OR d.emp IN (SELECT unnest(p_targets));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_reach_compute(uuid,date,uuid[],uuid[],uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The department walk of app.heads_department_of / the 5144 `dept_down` CTE, per ancestor department of the
-- tenant: itself (depth 0), then children whose company descends from (or is) the ANCESTOR department's company,
-- up to depth 64.
CREATE FUNCTION app.access_department_closure_compute(p_tenant uuid)
RETURNS TABLE(ancestor_department_id uuid,descendant_department_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE dn(anc,anc_company,id,depth) AS (
  SELECT d.id,d.company_id,d.id,0 FROM public.department d WHERE d.tenant_id=p_tenant
  UNION
  SELECT dn.anc,dn.anc_company,c.id,dn.depth+1
  FROM dn JOIN public.department c ON c.parent_department_id=dn.id
  WHERE dn.depth<64
   AND EXISTS(SELECT 1 FROM public.access_company_closure k WHERE k.tenant_id=p_tenant AND k.ancestor_id=dn.anc_company AND k.descendant_id=c.company_id)
 )
 SELECT DISTINCT dn.anc,dn.id FROM dn;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_department_closure_compute(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The fingerprint of the tenant's stored company closure: the reach and department closure are computed over it.
CREATE FUNCTION app.access_employment_closure_signature(p_tenant uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT md5(coalesce(string_agg(k.ancestor_id::text||'>'||k.descendant_id::text,',' ORDER BY k.ancestor_id,k.descendant_id),''))
 FROM public.access_company_closure k WHERE k.tenant_id=p_tenant;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_employment_closure_signature(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The next day on or after which the tenant's administrative lines change validity: the earliest valid_from or
-- valid_to after p_day (a line stops applying on its valid_to day).
CREATE FUNCTION app.access_employment_line_window(p_tenant uuid,p_day date) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT min(x.d) FROM (
  SELECT rl.valid_from AS d FROM public.reporting_line rl WHERE rl.tenant_id=p_tenant AND rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_from>p_day
  UNION ALL
  SELECT rl.valid_to FROM public.reporting_line rl WHERE rl.tenant_id=p_tenant AND rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_to>p_day
 ) x;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_employment_line_window(uuid,date) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Maintain one tenant in the caller's transaction. Incrementing access_version first takes the tenant's state row
-- lock, which serialises maintainers; under Read Committed the statements after it see every earlier committer.
-- p_changed NULL (or a state outside its window) recomputes the tenant: inline up to the installation's
-- inline_rebuild_limit employments (or when p_force), otherwise the tenant is marked stale and reads fall back until
-- the scheduled check rebuilds it. Otherwise only the pairs whose subject is a changed employment or below it, for
-- the roots that can reach them, are recomputed and written as a difference. p_boundary is the earliest date a
-- changed line starts or stops applying, which can only shorten the window.
CREATE FUNCTION app.access_visible_employment_refresh(p_tenant uuid,p_changed uuid[],p_force boolean,p_boundary date)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 v_today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 v_version bigint;v_for date;v_until date;v_limit integer;
 v_targets uuid[];v_within uuid[];v_roots uuid[];
BEGIN
 IF p_tenant IS NULL OR NOT EXISTS(SELECT 1 FROM public.tenant t WHERE t.id=p_tenant) THEN RETURN NULL; END IF;
 INSERT INTO public.access_employment_state AS s(tenant_id) VALUES(p_tenant)
  ON CONFLICT(tenant_id) DO UPDATE SET access_version=s.access_version+1
  RETURNING s.access_version,s.computed_for,s.valid_until INTO v_version,v_for,v_until;
 IF p_changed IS NULL OR v_for IS NULL OR v_for>v_today OR (v_until IS NOT NULL AND v_today>=v_until) THEN
  SELECT c.inline_rebuild_limit INTO v_limit FROM public.access_employment_precompute_control c WHERE c.singleton;
  IF NOT coalesce(p_force,false) AND (SELECT count(*) FROM public.employment e WHERE e.tenant_id=p_tenant)>coalesce(v_limit,20000) THEN
   UPDATE public.access_employment_state s SET stale=true WHERE s.tenant_id=p_tenant;
   RETURN v_version;
  END IF;
  DELETE FROM public.access_department_closure k WHERE k.tenant_id=p_tenant;
  INSERT INTO public.access_department_closure(tenant_id,ancestor_department_id,descendant_department_id)
   SELECT p_tenant,x.ancestor_department_id,x.descendant_department_id FROM app.access_department_closure_compute(p_tenant) x;
  DELETE FROM public.access_reporting_reach r WHERE r.tenant_id=p_tenant;
  INSERT INTO public.access_reporting_reach(tenant_id,root_employment_id,subject_employment_id,access_version)
   SELECT p_tenant,x.root_employment_id,x.subject_employment_id,v_version FROM app.access_reach_compute(p_tenant,v_today,NULL,NULL,NULL) x;
  UPDATE public.access_employment_state s SET computed_for=v_today,valid_until=app.access_employment_line_window(p_tenant,v_today),
   closure_signature=app.access_employment_closure_signature(p_tenant),stale=false
  WHERE s.tenant_id=p_tenant;
  RETURN v_version;
 END IF;
 IF cardinality(p_changed)=0 THEN RETURN v_version; END IF;
 -- Affected subjects: the changed employments and everything below them on current lines (no clamp, no
 -- termination filter: a node outside one root's clamp can be inside another's).
 WITH RECURSIVE t(emp,depth) AS (
  SELECT x,0 FROM unnest(p_changed) x
  UNION
  SELECT rl.subordinate_employment_id,t.depth+1 FROM t JOIN public.reporting_line rl ON rl.manager_employment_id=t.emp
  WHERE rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_from<=v_today AND (rl.valid_to IS NULL OR rl.valid_to>v_today) AND t.depth<64
 ) SELECT array_agg(DISTINCT t.emp) INTO v_targets FROM t;
 -- Every node a path to an affected subject can pass through: the subjects and their ancestors.
 WITH RECURSIVE u(emp,depth) AS (
  SELECT x,0 FROM unnest(v_targets) x
  UNION
  SELECT rl.manager_employment_id,u.depth+1 FROM u JOIN public.reporting_line rl ON rl.subordinate_employment_id=u.emp
  WHERE rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_from<=v_today AND (rl.valid_to IS NULL OR rl.valid_to>v_today) AND u.depth<64
 ) SELECT array_agg(DISTINCT u.emp) INTO v_within FROM u;
 -- Roots to recompute: the changed employments, their current ancestors, and every stored root that reaches an
 -- affected subject (which covers paths the change removed).
 WITH RECURSIVE a(emp,depth) AS (
  SELECT x,0 FROM unnest(p_changed) x
  UNION
  SELECT rl.manager_employment_id,a.depth+1 FROM a JOIN public.reporting_line rl ON rl.subordinate_employment_id=a.emp
  WHERE rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_from<=v_today AND (rl.valid_to IS NULL OR rl.valid_to>v_today) AND a.depth<64
 ) SELECT array_agg(DISTINCT z.id) INTO v_roots FROM (
  SELECT a.emp AS id FROM a
  UNION SELECT r.root_employment_id FROM public.access_reporting_reach r WHERE r.subject_employment_id IN (SELECT unnest(v_targets))
 ) z;
 v_roots:=coalesce(v_roots,'{}'::uuid[]);v_targets:=coalesce(v_targets,'{}'::uuid[]);v_within:=coalesce(v_within,'{}'::uuid[]);
 -- One statement: the recomputed pairs, the stale pairs deleted, the new pairs inserted (the two sets are disjoint).
 WITH n AS MATERIALIZED (
  SELECT x.root_employment_id,x.subject_employment_id FROM app.access_reach_compute(p_tenant,v_today,v_roots,v_targets,v_within) x
 ), gone AS (
  DELETE FROM public.access_reporting_reach r
  WHERE r.root_employment_id IN (SELECT unnest(v_roots)) AND r.subject_employment_id IN (SELECT unnest(v_targets))
   AND NOT EXISTS(SELECT 1 FROM n WHERE n.root_employment_id=r.root_employment_id AND n.subject_employment_id=r.subject_employment_id)
  RETURNING 1
 )
 INSERT INTO public.access_reporting_reach(tenant_id,root_employment_id,subject_employment_id,access_version)
  SELECT p_tenant,n.root_employment_id,n.subject_employment_id,v_version FROM n
  ON CONFLICT(root_employment_id,subject_employment_id) DO NOTHING;
 IF p_boundary IS NOT NULL AND p_boundary>v_for THEN
  UPDATE public.access_employment_state s SET valid_until=CASE WHEN s.valid_until IS NULL THEN p_boundary ELSE least(s.valid_until,p_boundary) END
  WHERE s.tenant_id=p_tenant;
 END IF;
 RETURN v_version;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_visible_employment_refresh(uuid,uuid[],boolean,date) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The department closure alone (department tree edits): thousands of rows at most, recomputed inline.
CREATE FUNCTION app.access_department_closure_refresh(p_tenant uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_tenant IS NULL OR NOT EXISTS(SELECT 1 FROM public.tenant t WHERE t.id=p_tenant) THEN RETURN; END IF;
 INSERT INTO public.access_employment_state AS s(tenant_id) VALUES(p_tenant)
  ON CONFLICT(tenant_id) DO UPDATE SET access_version=s.access_version+1;
 DELETE FROM public.access_department_closure k WHERE k.tenant_id=p_tenant;
 INSERT INTO public.access_department_closure(tenant_id,ancestor_department_id,descendant_department_id)
  SELECT p_tenant,x.ancestor_department_id,x.descendant_department_id FROM app.access_department_closure_compute(p_tenant) x;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_department_closure_refresh(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Statement triggers. Transition tables are named new_rows and old_rows on every table; each operation has its own
-- trigger, so each branch reads only the transition tables its operation has.
-- reporting_line: only administrative lines feed the stored walk, and only these columns.
CREATE FUNCTION app.access_visible_employment_line_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t record;v_today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF TG_OP='INSERT' THEN
  FOR t IN SELECT n.tenant_id,array_agg(DISTINCT n.subordinate_employment_id) AS emps,
    min(least(CASE WHEN n.valid_from>v_today THEN n.valid_from END,CASE WHEN n.valid_to>v_today THEN n.valid_to END)) AS boundary
   FROM new_rows n WHERE n.line_type::text='administrative' GROUP BY n.tenant_id
  LOOP PERFORM app.access_visible_employment_refresh(t.tenant_id,t.emps,false,t.boundary); END LOOP;
 ELSIF TG_OP='DELETE' THEN
  FOR t IN SELECT o.tenant_id,array_agg(DISTINCT o.subordinate_employment_id) AS emps
   FROM old_rows o WHERE o.line_type::text='administrative' GROUP BY o.tenant_id
  LOOP PERFORM app.access_visible_employment_refresh(t.tenant_id,t.emps,false,NULL); END LOOP;
 ELSE
  FOR t IN SELECT x.tenant_id,array_agg(DISTINCT x.emp) AS emps,
    min(least(CASE WHEN x.valid_from>v_today THEN x.valid_from END,CASE WHEN x.valid_to>v_today THEN x.valid_to END)) AS boundary
   FROM (
    SELECT n.tenant_id,n.subordinate_employment_id AS emp,n.valid_from,n.valid_to FROM new_rows n JOIN old_rows o ON o.id=n.id
    WHERE 'administrative' IN (n.line_type::text,o.line_type::text)
     AND (o.tenant_id,o.manager_employment_id,o.subordinate_employment_id,o.line_type,o.superseded_at,o.valid_from,o.valid_to)
      IS DISTINCT FROM (n.tenant_id,n.manager_employment_id,n.subordinate_employment_id,n.line_type,n.superseded_at,n.valid_from,n.valid_to)
    UNION ALL
    SELECT o.tenant_id,o.subordinate_employment_id,o.valid_from,o.valid_to FROM new_rows n JOIN old_rows o ON o.id=n.id
    WHERE 'administrative' IN (n.line_type::text,o.line_type::text)
     AND (o.tenant_id,o.manager_employment_id,o.subordinate_employment_id,o.line_type,o.superseded_at,o.valid_from,o.valid_to)
      IS DISTINCT FROM (n.tenant_id,n.manager_employment_id,n.subordinate_employment_id,n.line_type,n.superseded_at,n.valid_from,n.valid_to)
   ) x GROUP BY x.tenant_id
  LOOP PERFORM app.access_visible_employment_refresh(t.tenant_id,t.emps,false,t.boundary); END LOOP;
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
-- employment: the walk reads company_id and terminated_on (and the tenant); a new employment has no lines yet (lines
-- bring their own trigger). Every other column returns at once.
CREATE FUNCTION app.access_visible_employment_employment_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t record;
BEGIN
 IF TG_OP='DELETE' THEN
  FOR t IN SELECT o.tenant_id,array_agg(DISTINCT o.id) AS emps FROM old_rows o GROUP BY o.tenant_id
  LOOP PERFORM app.access_visible_employment_refresh(t.tenant_id,t.emps,false,NULL); END LOOP;
 ELSIF TG_OP='UPDATE' THEN
  FOR t IN SELECT x.tenant_id,array_agg(DISTINCT x.id) AS emps FROM (
    SELECT n.tenant_id,n.id FROM new_rows n JOIN old_rows o ON o.id=n.id
    WHERE (o.tenant_id,o.company_id,o.terminated_on) IS DISTINCT FROM (n.tenant_id,n.company_id,n.terminated_on)
    UNION ALL
    SELECT o.tenant_id,o.id FROM new_rows n JOIN old_rows o ON o.id=n.id WHERE o.tenant_id IS DISTINCT FROM n.tenant_id
   ) x GROUP BY x.tenant_id
  LOOP PERFORM app.access_visible_employment_refresh(t.tenant_id,t.emps,false,NULL); END LOOP;
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
-- department: the closure reads parent_department_id and company_id (and the tenant).
CREATE FUNCTION app.access_visible_employment_department_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;
BEGIN
 IF TG_OP='INSERT' THEN
  FOR t IN SELECT DISTINCT n.tenant_id FROM new_rows n LOOP PERFORM app.access_department_closure_refresh(t); END LOOP;
 ELSIF TG_OP='DELETE' THEN
  FOR t IN SELECT DISTINCT o.tenant_id FROM old_rows o LOOP PERFORM app.access_department_closure_refresh(t); END LOOP;
 ELSE
  FOR t IN
   SELECT n.tenant_id FROM new_rows n JOIN old_rows o ON o.id=n.id
   WHERE (o.tenant_id,o.parent_department_id,o.company_id) IS DISTINCT FROM (n.tenant_id,n.parent_department_id,n.company_id)
   UNION
   SELECT o.tenant_id FROM new_rows n JOIN old_rows o ON o.id=n.id WHERE o.tenant_id IS DISTINCT FROM n.tenant_id
  LOOP PERFORM app.access_department_closure_refresh(t); END LOOP;
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
-- access_company_closure (7210 rewrites a tenant's closure on every company-tree refresh): recompute only when the
-- closure actually changed, compared by fingerprint.
CREATE FUNCTION app.access_visible_employment_closure_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;
BEGIN
 FOR t IN SELECT DISTINCT n.tenant_id FROM new_rows n LOOP
  IF (SELECT s.closure_signature FROM public.access_employment_state s WHERE s.tenant_id=t) IS DISTINCT FROM app.access_employment_closure_signature(t) THEN
   PERFORM app.access_visible_employment_refresh(t,NULL,false,NULL);
  END IF;
 END LOOP;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_visible_employment_line_changed(),app.access_visible_employment_employment_changed(),
 app.access_visible_employment_department_changed(),app.access_visible_employment_closure_changed() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $triggers$
DECLARE target record;ev text;
BEGIN
 FOR target IN SELECT * FROM (VALUES
  ('reporting_line','access_visible_employment_line_changed',ARRAY['insert','update','delete']),
  ('employment','access_visible_employment_employment_changed',ARRAY['update','delete']),
  ('department','access_visible_employment_department_changed',ARRAY['insert','update','delete']),
  ('access_company_closure','access_visible_employment_closure_changed',ARRAY['insert'])) v(tbl,fn,events)
 LOOP
  FOREACH ev IN ARRAY target.events LOOP
   EXECUTE format('CREATE TRIGGER %I AFTER %s ON public.%I REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION app.%I()',
    'access_visible_employment_'||ev,upper(ev),target.tbl,
    CASE ev WHEN 'insert' THEN 'NEW TABLE AS new_rows' WHEN 'delete' THEN 'OLD TABLE AS old_rows' ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows' END,
    target.fn);
  END LOOP;
 END LOOP;
END;
$triggers$;
--> statement-breakpoint
-- Why the stored answer cannot be used for this statement, or NULL when it can.
CREATE FUNCTION app.access_visible_employment_unusable() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.current_user_id() IS NULL THEN 'no_user'
  WHEN current_date<>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN 'clock'
  WHEN s.tenant_id IS NULL THEN 'no_state'
  WHEN NOT s.trusted THEN 'untrusted'
  WHEN s.stale THEN 'stale'
  WHEN s.computed_for IS NULL OR s.computed_for>current_date OR (s.valid_until IS NOT NULL AND current_date>=s.valid_until) THEN 'outside_window'
  WHEN c.tenant_id IS NULL OR c.computed_for IS NULL OR c.computed_for>current_date OR (c.valid_until IS NOT NULL AND current_date>=c.valid_until) THEN 'company_window'
 END
 FROM (SELECT 1) one
 LEFT JOIN public.access_employment_state s ON s.tenant_id=app.current_tenant_id()
 LEFT JOIN public.access_company_state c ON c.tenant_id=app.current_tenant_id();
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_visible_employment_unusable() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The relationship part exactly as 5144 computes it (self, administrative walk, department-head walk), without the
-- admin arm and without the attendance window, which the callers add.
CREATE FUNCTION app.access_visible_employment_legacy() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE
 me AS (
   SELECT e.id, e.company_id
   FROM employment e
   JOIN app_user u ON u.person_id = e.person_id
   WHERE u.id = app.current_user_id()
     AND e.tenant_id = app.current_tenant_id()
     AND e.terminated_on IS NULL
 ),
 down AS (
   SELECT m.company_id AS root_company, rl.subordinate_employment_id AS emp, 1 AS depth
   FROM me m
   JOIN reporting_line rl ON rl.manager_employment_id = m.id
   JOIN employment sub ON sub.id = rl.subordinate_employment_id
   WHERE rl.line_type = 'administrative'
     AND rl.superseded_at IS NULL
     AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
     AND sub.terminated_on IS NULL
     AND app.is_company_descendant(sub.company_id, m.company_id)
   UNION
   SELECT d.root_company, rl.subordinate_employment_id, d.depth + 1
   FROM down d
   JOIN reporting_line rl ON rl.manager_employment_id = d.emp
   JOIN employment mid ON mid.id = rl.manager_employment_id
   JOIN employment sub ON sub.id = rl.subordinate_employment_id
   WHERE rl.line_type = 'administrative'
     AND rl.superseded_at IS NULL
     AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
     AND mid.terminated_on IS NULL
     AND sub.terminated_on IS NULL
     AND d.depth < 64
     AND app.is_company_descendant(sub.company_id, d.root_company)
 ),
 caller_dept AS (
   SELECT m.id AS caller, a.department_id AS dept, d.company_id AS company
   FROM me m
   JOIN assignment a ON a.employment_id = m.id
   JOIN department d ON d.id = a.department_id
   WHERE a.valid_to IS NULL AND a.superseded_at IS NULL
     AND a.department_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM reporting_line rl
       WHERE rl.manager_employment_id = m.id
         AND rl.line_type = 'administrative'
         AND rl.superseded_at IS NULL
         AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
     )
 ),
 dept_down AS (
   SELECT cd.caller, cd.dept AS id, 0 AS depth
   FROM caller_dept cd
   UNION
   SELECT dd.caller, d.id, dd.depth + 1
   FROM dept_down dd
   JOIN department d ON d.parent_department_id = dd.id
   JOIN caller_dept cd ON cd.caller = dd.caller
   WHERE app.is_company_descendant(d.company_id, cd.company)
     AND dd.depth < 64
 ),
 hod AS (
   SELECT a.employment_id
   FROM assignment a
   WHERE a.valid_to IS NULL AND a.superseded_at IS NULL
     AND a.department_id IS NOT NULL
     AND a.department_id IN (SELECT dd.id FROM dept_down dd)
 ),
 visible AS (
   SELECT e.id
   FROM employment e
   JOIN app_user u ON u.person_id = e.person_id
   WHERE e.tenant_id = app.current_tenant_id()
     AND u.id = app.current_user_id()
   UNION
   SELECT d.emp FROM down d
   UNION
   SELECT h.employment_id FROM hod h
 )
 SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}'::uuid[]) FROM visible v WHERE v.id IS NOT NULL;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_visible_employment_legacy() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The same relationship part from the stored rows: the caller's current employments (live) as roots of the stored
-- reach; the department-head arm from the caller's qualified current departments (live), each with itself and its
-- stored closure, then the current assignments in those departments (assignment_current_department_idx, 7230).
CREATE FUNCTION app.access_visible_employment_stored() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH me AS MATERIALIZED (
   SELECT e.id
   FROM public.employment e
   JOIN public.app_user u ON u.person_id = e.person_id
   WHERE u.id = app.current_user_id()
     AND e.tenant_id = app.current_tenant_id()
     AND e.terminated_on IS NULL
 ),
 caller_dept AS MATERIALIZED (
   SELECT a.department_id AS dept
   FROM me m
   JOIN public.assignment a ON a.employment_id = m.id
   JOIN public.department d ON d.id = a.department_id
   WHERE a.valid_to IS NULL AND a.superseded_at IS NULL
     AND a.department_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.reporting_line rl
       WHERE rl.manager_employment_id = m.id
         AND rl.line_type = 'administrative'
         AND rl.superseded_at IS NULL
         AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
     )
 ),
 departments AS MATERIALIZED (
   SELECT cd.dept AS id FROM caller_dept cd
   UNION
   SELECT k.descendant_department_id FROM public.access_department_closure k JOIN caller_dept cd ON k.ancestor_department_id = cd.dept
 ),
 visible AS (
   SELECT e.id
   FROM public.employment e
   JOIN public.app_user u ON u.person_id = e.person_id
   WHERE e.tenant_id = app.current_tenant_id()
     AND u.id = app.current_user_id()
   UNION
   SELECT r.subject_employment_id FROM public.access_reporting_reach r JOIN me m ON r.root_employment_id = m.id
   UNION
   SELECT a.employment_id
   FROM public.assignment a JOIN departments x ON a.department_id = x.id
   WHERE a.valid_to IS NULL AND a.superseded_at IS NULL AND a.department_id IS NOT NULL
 )
 SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}'::uuid[]) FROM visible v WHERE v.id IS NOT NULL;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_visible_employment_stored() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The relationship part of employment visibility for the session, once per statement, with the attendance window
-- subject merged exactly as 5144 merges it. Shadow log lines carry counts only.
CREATE FUNCTION app.access_visible_employment_ids() RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_mode text;v_reason text;v_stored uuid[];v_ids uuid[];v_window uuid;v_self integer;
BEGIN
 SELECT c.mode INTO v_mode FROM public.access_employment_precompute_control c WHERE c.singleton;
 v_mode:=coalesce(v_mode,'legacy');
 IF v_mode<>'legacy' THEN
  v_reason:=app.access_visible_employment_unusable();
  IF v_reason IS NULL THEN
   v_stored:=app.access_visible_employment_stored();
   IF v_mode='precomputed' THEN v_ids:=v_stored; END IF;
  END IF;
 END IF;
 IF v_ids IS NULL THEN
  v_ids:=app.access_visible_employment_legacy();
  IF v_mode='shadow' THEN
   SELECT count(*) INTO v_self FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id
    WHERE e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id();
   IF v_reason IS NULL THEN
    RAISE LOG 'access_visible_employment shadow missing=% extra=% relationship=% reason=compared',
     (SELECT count(*) FROM unnest(v_ids) x WHERE x<>ALL(v_stored)),(SELECT count(*) FROM unnest(v_stored) x WHERE x<>ALL(v_ids)),
     CASE WHEN cardinality(v_ids)>v_self THEN 1 ELSE 0 END;
   ELSE
    RAISE LOG 'access_visible_employment shadow missing=0 extra=0 relationship=% reason=%',CASE WHEN cardinality(v_ids)>v_self THEN 1 ELSE 0 END,v_reason;
   END IF;
  END IF;
 END IF;
 IF coalesce(current_setting('app.attendance_final_window', true), '') <> '' THEN
  v_window := app.attendance_effect_window_employment();
  IF v_window IS NOT NULL AND NOT v_window = ANY(v_ids) THEN
   v_ids := (SELECT array_agg(x ORDER BY x) FROM unnest(v_ids || v_window) x);
  END IF;
 END IF;
 RETURN v_ids;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_visible_employment_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_visible_employment_ids() TO ai_hr_app;
--> statement-breakpoint
-- The caller's own person and the persons of the relationship part (app.visible_person_ids without the admin arm,
-- which person_rls already admits through app.is_admin()).
CREATE FUNCTION app.access_visible_person_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH visible AS (
   SELECT u.person_id AS id FROM public.app_user u
   WHERE u.id = app.current_user_id() AND u.tenant_id = app.current_tenant_id()
   UNION
   SELECT e.person_id FROM public.employment e
   WHERE e.tenant_id = app.current_tenant_id() AND e.id IN (SELECT unnest(app.access_visible_employment_ids()))
 )
 SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}'::uuid[]) FROM visible v WHERE v.id IS NOT NULL;
$$;
--> statement-breakpoint
-- person_rls applies to every role (it has no TO list), so every role that reads person evaluates this reader, as it
-- evaluated app.visible_person_ids, which kept PostgreSQL's default EXECUTE for PUBLIC. Same here.
GRANT EXECUTE ON FUNCTION app.access_visible_person_ids() TO PUBLIC;
--> statement-breakpoint
-- The tenant's companies on which the session holds an administrator, Payroll partner or performance-and-
-- compensation partner claim (app.is_admin_for, app.can_admin_payroll_for, app.can_admin_perfcomp_for), once per
-- company instead of once per row. Employment and department companies belong to the employment's tenant
-- (employment_company_tenant_fk, 2101/2102), so the tenant's company list covers every row these are asked about.
CREATE FUNCTION app.employment_read_companies() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}'::uuid[]) FROM public.company c
 WHERE c.tenant_id=app.current_tenant_id()
  AND (app.is_admin_for(c.id) OR app.can_admin_payroll_for(c.id) OR app.can_admin_perfcomp_for(c.id));
$$;
--> statement-breakpoint
CREATE FUNCTION app.employment_partner_companies() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}'::uuid[]) FROM public.company c
 WHERE c.tenant_id=app.current_tenant_id()
  AND (app.can_admin_payroll_for(c.id) OR app.can_admin_perfcomp_for(c.id));
$$;
--> statement-breakpoint
-- employment_rls applies to ai_hr_app only. person_rls applies to every role and asks employment_partner_companies,
-- as it asked app.can_admin_payroll_for and app.can_admin_perfcomp_for (default EXECUTE for PUBLIC).
REVOKE ALL ON FUNCTION app.employment_read_companies() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employment_read_companies() TO ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employment_partner_companies() TO PUBLIC;
--> statement-breakpoint
-- app.visible_employment_ids (replaces 5144): the 2105 admin arm unchanged, unioned with the relationship part
-- (which carries the attendance window subject exactly as 5144 merged it). Same signature, result and order.
DO $guard$
BEGIN
 IF md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid='app.visible_employment_ids()'::regprocedure))<>'a474882bf20bcb093f42ab0e92c3c3a1' THEN
  RAISE EXCEPTION 'Unexpected visible_employment_ids predecessor' USING ERRCODE='55000';
 END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.visible_employment_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE possible_admin boolean;
BEGIN
 SELECT EXISTS(
  SELECT 1 FROM (
   SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)) AS grants
   FROM app.current_grants() g
   WHERE EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id())
  ) normalized CROSS JOIN LATERAL jsonb_array_elements(normalized.grants) payload(value)
  WHERE payload.value->>'role' IN ('hr_admin','super_admin')
 ) INTO possible_admin;
 RETURN (
  WITH
  tenant_company AS MATERIALIZED (
    SELECT DISTINCT e.company_id FROM employment e WHERE e.tenant_id = app.current_tenant_id() AND possible_admin
  ),
  admin_company AS MATERIALIZED (
    SELECT c.company_id
    FROM tenant_company c
    WHERE app.is_admin_for(c.company_id)
  ),
  visible AS (
    SELECT e.id
    FROM employment e
    WHERE e.tenant_id = app.current_tenant_id()
      AND e.company_id IN (SELECT ac.company_id FROM admin_company ac)
    UNION
    SELECT x FROM unnest(app.access_visible_employment_ids()) x
  )
  SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}'::uuid[]) FROM visible v WHERE v.id IS NOT NULL
 );
END;
$$;
--> statement-breakpoint
-- Rebuild-and-compare for one tenant (owner connection, scripts/access-effective-company-check.ts). A tenant that is
-- stale or outside its window is rebuilt first (expected, not a difference). Any difference between the stored
-- rows and a from-scratch recompute (including of the company closure they rest on) marks the tenant untrusted, so
-- reads fall back to the legacy answer until an operator re-trusts it. Returns counts only.
CREATE FUNCTION app.access_visible_employment_verify(p_tenant uuid)
RETURNS TABLE(window_refreshed boolean,closure_differences integer,departments_missing integer,departments_extra integer,reach_missing integer,reach_extra integer,trusted boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 v_today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 s public.access_employment_state%ROWTYPE;
 v_refreshed boolean:=false;cd integer;dm integer;de integer;rm integer;re integer;
BEGIN
 SELECT * INTO s FROM public.access_employment_state x WHERE x.tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND OR s.stale OR s.computed_for IS NULL OR s.computed_for>v_today OR (s.valid_until IS NOT NULL AND v_today>=s.valid_until) THEN
  PERFORM app.access_visible_employment_refresh(p_tenant,NULL,true,NULL);v_refreshed:=true;
 END IF;
 SELECT count(*) INTO cd FROM (
  (SELECT x.ancestor_id,x.descendant_id FROM app.access_company_closure_compute(p_tenant) x
   EXCEPT SELECT k.ancestor_id,k.descendant_id FROM public.access_company_closure k WHERE k.tenant_id=p_tenant)
  UNION ALL
  (SELECT k.ancestor_id,k.descendant_id FROM public.access_company_closure k WHERE k.tenant_id=p_tenant
   EXCEPT SELECT x.ancestor_id,x.descendant_id FROM app.access_company_closure_compute(p_tenant) x)) d;
 SELECT count(*) INTO dm FROM (SELECT x.ancestor_department_id,x.descendant_department_id FROM app.access_department_closure_compute(p_tenant) x
  EXCEPT SELECT k.ancestor_department_id,k.descendant_department_id FROM public.access_department_closure k WHERE k.tenant_id=p_tenant) d;
 SELECT count(*) INTO de FROM (SELECT k.ancestor_department_id,k.descendant_department_id FROM public.access_department_closure k WHERE k.tenant_id=p_tenant
  EXCEPT SELECT x.ancestor_department_id,x.descendant_department_id FROM app.access_department_closure_compute(p_tenant) x) d;
 SELECT count(*) INTO rm FROM (SELECT x.root_employment_id,x.subject_employment_id FROM app.access_reach_compute(p_tenant,v_today,NULL,NULL,NULL) x
  EXCEPT SELECT r.root_employment_id,r.subject_employment_id FROM public.access_reporting_reach r WHERE r.tenant_id=p_tenant) d;
 SELECT count(*) INTO re FROM (SELECT r.root_employment_id,r.subject_employment_id FROM public.access_reporting_reach r WHERE r.tenant_id=p_tenant
  EXCEPT SELECT x.root_employment_id,x.subject_employment_id FROM app.access_reach_compute(p_tenant,v_today,NULL,NULL,NULL) x) d;
 UPDATE public.access_employment_state x SET last_verified_at=now(),last_difference_count=cd+dm+de+rm+re,
  trusted=x.trusted AND cd+dm+de+rm+re=0 WHERE x.tenant_id=p_tenant RETURNING x.trusted INTO s.trusted;
 RETURN QUERY SELECT v_refreshed,cd,dm,de,rm,re,coalesce(s.trusted,false);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_visible_employment_verify(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Operator only: after the cause of a difference is fixed, rebuild the tenant and trust it again.
CREATE FUNCTION app.access_visible_employment_retrust(p_tenant uuid) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v bigint;
BEGIN
 v:=app.access_visible_employment_refresh(p_tenant,NULL,true,NULL);
 UPDATE public.access_employment_state s SET trusted=true,last_difference_count=0 WHERE s.tenant_id=p_tenant;
 RETURN v;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_visible_employment_retrust(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Operator only, installation wide: 'legacy', 'shadow' or 'precomputed'.
CREATE FUNCTION app.access_visible_employment_set_mode(p_mode text) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 UPDATE public.access_employment_precompute_control SET mode=p_mode,updated_at=now() WHERE singleton RETURNING mode;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_visible_employment_set_mode(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Build every existing tenant once, as the owner, in this migration's transaction.
DO $build$
DECLARE t uuid;
BEGIN
 FOR t IN SELECT x.id FROM public.tenant x ORDER BY 1 LOOP PERFORM app.access_visible_employment_refresh(t,NULL,true,NULL); END LOOP;
END;
$build$;
--> statement-breakpoint
-- employment_rls and person_rls: the company questions once per statement, the relationship part from the reader.
-- The predecessors are compared as PostgreSQL deparses them: a scratch policy carrying the reviewed predecessor
-- text is created and dropped inside this transaction, and its expression must equal the installed one.
DO $policies$
DECLARE
 emp_pred constant text := $q$(voided_at IS NULL) AND (tenant_id = app.current_tenant_id()) AND CASE WHEN ((SELECT current_setting('app.bank_import_point_read'::text, true)) = 'on'::text) THEN CASE WHEN (app.is_admin_for(company_id) OR app.can_admin_payroll_for(company_id)) THEN true ELSE ((voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND ((id IN (SELECT unnest((SELECT app.visible_employment_ids())))) OR app.can_admin_payroll_for(company_id) OR app.can_admin_perfcomp_for(company_id)))) END ELSE ((voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND ((id IN (SELECT unnest((SELECT app.visible_employment_ids())))) OR app.can_admin_payroll_for(company_id) OR app.can_admin_perfcomp_for(company_id)))) END$q$;
 emp_next constant text := $q$(voided_at IS NULL) AND (tenant_id = app.current_tenant_id()) AND CASE WHEN ((SELECT current_setting('app.bank_import_point_read'::text, true)) = 'on'::text) THEN CASE WHEN (app.is_admin_for(company_id) OR app.can_admin_payroll_for(company_id)) THEN true ELSE ((voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND ((company_id = ANY ((SELECT app.employment_read_companies())::uuid[])) OR (id IN (SELECT unnest((SELECT app.access_visible_employment_ids()))))))) END ELSE ((voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND ((company_id = ANY ((SELECT app.employment_read_companies())::uuid[])) OR (id IN (SELECT unnest((SELECT app.access_visible_employment_ids()))))))) END$q$;
 person_pred constant text := $q$(voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND (((SELECT app.is_admin()) OR (id = ANY ((SELECT app.visible_person_ids())::uuid[]))) OR (EXISTS ( SELECT 1 FROM employment e WHERE ((e.person_id = person.id) AND (e.tenant_id = app.current_tenant_id()) AND (app.can_admin_payroll_for(e.company_id) OR app.can_admin_perfcomp_for(e.company_id)))))))$q$;
 person_next constant text := $q$(voided_at IS NULL) AND ((tenant_id = app.current_tenant_id()) AND ((SELECT app.is_admin()) OR (id IN (SELECT unnest((SELECT app.access_visible_person_ids())))) OR (EXISTS ( SELECT 1 FROM employment e WHERE ((e.person_id = person.id) AND (e.tenant_id = app.current_tenant_id()) AND (e.company_id = ANY ((SELECT app.employment_partner_companies())::uuid[])))))))$q$;
 installed text;expected text;
BEGIN
 SELECT pg_get_expr(p.polqual,p.polrelid) INTO installed FROM pg_policy p WHERE p.polrelid='public.employment'::regclass AND p.polname='employment_rls';
 EXECUTE format('CREATE POLICY access_visible_employment_guard ON public.employment FOR SELECT TO ai_hr_app USING (%s)',emp_pred);
 SELECT pg_get_expr(p.polqual,p.polrelid) INTO expected FROM pg_policy p WHERE p.polrelid='public.employment'::regclass AND p.polname='access_visible_employment_guard';
 DROP POLICY access_visible_employment_guard ON public.employment;
 IF installed IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Employment policy differs from the reviewed predecessor' USING ERRCODE='55000'; END IF;
 IF (SELECT regexp_replace(pg_get_expr(p.polwithcheck,p.polrelid),'\s+','','g') FROM pg_policy p WHERE p.polrelid='public.employment'::regclass AND p.polname='employment_rls')
  IS DISTINCT FROM '((tenant_id=app.current_tenant_id())ANDapp.is_admin_for(company_id))' THEN
  RAISE EXCEPTION 'Employment policy check differs from the reviewed predecessor' USING ERRCODE='55000';
 END IF;
 EXECUTE format('ALTER POLICY employment_rls ON public.employment USING (%s)',emp_next);
 SELECT pg_get_expr(p.polqual,p.polrelid) INTO installed FROM pg_policy p WHERE p.polrelid='public.person'::regclass AND p.polname='person_rls';
 EXECUTE format('CREATE POLICY access_visible_person_guard ON public.person FOR SELECT TO ai_hr_app USING (%s)',person_pred);
 SELECT pg_get_expr(p.polqual,p.polrelid) INTO expected FROM pg_policy p WHERE p.polrelid='public.person'::regclass AND p.polname='access_visible_person_guard';
 DROP POLICY access_visible_person_guard ON public.person;
 IF installed IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Person policy differs from the reviewed predecessor' USING ERRCODE='55000'; END IF;
 EXECUTE format('ALTER POLICY person_rls ON public.person USING (%s)',person_next);
END;
$policies$;

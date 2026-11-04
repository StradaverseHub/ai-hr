-- Approved Org Chart34b9579a. Explicit roots only; no inferred roots or data backfill.
CREATE TABLE public.org_chart_root (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 employment_id uuid NOT NULL REFERENCES employment(id), valid_from date NOT NULL, valid_to date,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(valid_to IS NULL OR valid_to>=valid_from)
);
--> statement-breakpoint
ALTER TABLE public.org_chart_root ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_chart_root FORCE ROW LEVEL SECURITY;
CREATE POLICY org_chart_root_read ON public.org_chart_root FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND app.can_see_employment(employment_id));
CREATE POLICY org_chart_root_insert ON public.org_chart_root FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin() AND app.access_workforce_employment(employment_id,'workforce.maintain'));
CREATE POLICY org_chart_root_update ON public.org_chart_root FOR UPDATE TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND app.is_admin() AND app.access_workforce_employment(employment_id,'workforce.maintain'))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin() AND app.access_workforce_employment(employment_id,'workforce.maintain'));
GRANT SELECT,INSERT ON public.org_chart_root TO ai_hr_app;
GRANT UPDATE(valid_to) ON public.org_chart_root TO ai_hr_app;
CREATE INDEX org_chart_root_employment_idx ON public.org_chart_root(tenant_id,employment_id,valid_from);
--> statement-breakpoint
-- Same lock as the canonical reporting writer, including imports and reviewed writes. Protect both
-- directions of the invariant even when a caller bypasses the screen. No implicit relationship edits.
CREATE FUNCTION app.check_org_chart_root() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE check_cycle boolean:=true;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||NEW.tenant_id::text,0));
 IF TG_TABLE_NAME='org_chart_root' THEN
  IF NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Top-level employee must belong to the same tenant'; END IF;
  IF EXISTS(SELECT 1 FROM reporting_line r WHERE r.tenant_id=NEW.tenant_id AND r.subordinate_employment_id=NEW.employment_id AND r.line_type='administrative' AND r.superseded_at IS NULL AND daterange(r.valid_from,r.valid_to,'[)') && daterange(NEW.valid_from,NEW.valid_to,'[)')) THEN
   RAISE EXCEPTION 'A top-level employee cannot also have a Direct Superior in the same date range';
  END IF;
  IF EXISTS(SELECT 1 FROM org_chart_root r WHERE r.tenant_id=NEW.tenant_id AND r.employment_id=NEW.employment_id AND r.id<>NEW.id AND daterange(r.valid_from,r.valid_to,'[)') && daterange(NEW.valid_from,NEW.valid_to,'[)')) THEN RAISE EXCEPTION 'Top-level date ranges overlap'; END IF;
 ELSE
  IF TG_OP='UPDATE' THEN
   check_cycle:=NEW.manager_employment_id IS DISTINCT FROM OLD.manager_employment_id OR NEW.subordinate_employment_id IS DISTINCT FROM OLD.subordinate_employment_id OR NEW.line_type IS DISTINCT FROM OLD.line_type OR NEW.valid_from<OLD.valid_from OR (OLD.valid_to IS NOT NULL AND (NEW.valid_to IS NULL OR NEW.valid_to>OLD.valid_to)) OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL);
  END IF;
  IF check_cycle AND NEW.line_type='administrative' AND NEW.superseded_at IS NULL THEN
   IF NEW.manager_employment_id=NEW.subordinate_employment_id THEN RAISE EXCEPTION 'Direct Superior cannot refer to self'; END IF;
   IF EXISTS(WITH RECURSIVE chain(manager,effective) AS (
    SELECT r.manager_employment_id,daterange(r.valid_from,r.valid_to,'[)')*daterange(NEW.valid_from,NEW.valid_to,'[)') FROM public.reporting_line r
     WHERE r.tenant_id=NEW.tenant_id AND r.subordinate_employment_id=NEW.manager_employment_id AND r.id<>NEW.id AND r.line_type='administrative' AND r.superseded_at IS NULL AND daterange(r.valid_from,r.valid_to,'[)')&&daterange(NEW.valid_from,NEW.valid_to,'[)')
    UNION SELECT r.manager_employment_id,c.effective*daterange(r.valid_from,r.valid_to,'[)') FROM public.reporting_line r JOIN chain c ON r.subordinate_employment_id=c.manager
     WHERE r.tenant_id=NEW.tenant_id AND r.id<>NEW.id AND r.line_type='administrative' AND r.superseded_at IS NULL AND c.effective&&daterange(r.valid_from,r.valid_to,'[)')
   ) SELECT 1 FROM chain WHERE manager=NEW.subordinate_employment_id) THEN RAISE EXCEPTION 'Direct Superior would create a reporting loop'; END IF;
  END IF;
  IF NEW.line_type='administrative' AND NEW.superseded_at IS NULL AND EXISTS(SELECT 1 FROM org_chart_root r WHERE r.tenant_id=NEW.tenant_id AND r.employment_id=NEW.subordinate_employment_id AND daterange(r.valid_from,r.valid_to,'[)') && daterange(NEW.valid_from,NEW.valid_to,'[)')) THEN
   RAISE EXCEPTION 'End the top-level designation before assigning a Direct Superior';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER org_chart_root_integrity BEFORE INSERT OR UPDATE ON public.org_chart_root FOR EACH ROW EXECUTE FUNCTION app.check_org_chart_root();
CREATE TRIGGER reporting_line_org_chart_root_integrity BEFORE INSERT OR UPDATE ON public.reporting_line FOR EACH ROW EXECUTE FUNCTION app.check_org_chart_root();

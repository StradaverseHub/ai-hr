-- Company group tree: subtree/ancestry helpers, cycle guard, and statutory-identity RLS (ADR-0009).

-- ── Tree helpers (SECURITY DEFINER: must walk the full tree regardless of caller visibility) ──
-- True if `child` is `ancestor` itself or a descendant of it (walks parents upward).
CREATE OR REPLACE FUNCTION app.is_company_descendant(child uuid, ancestor uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH RECURSIVE up AS (
    SELECT id, parent_company_id FROM company WHERE id = child
    UNION ALL
    SELECT c.id, c.parent_company_id FROM company c JOIN up ON c.id = up.parent_company_id
  )
  SELECT EXISTS (SELECT 1 FROM up WHERE id = ancestor);
$$;
--> statement-breakpoint
-- All company ids in the subtree rooted at `root` (inclusive).
CREATE OR REPLACE FUNCTION app.company_subtree(root uuid)
  RETURNS TABLE (id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH RECURSIVE down AS (
    SELECT id FROM company WHERE id = root
    UNION ALL
    SELECT c.id FROM company c JOIN down ON c.parent_company_id = down.id
  )
  SELECT id FROM down;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.is_company_descendant(uuid, uuid) TO ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.company_subtree(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── Cycle guard: a company may not be its own ancestor (DB-enforced) ──
CREATE OR REPLACE FUNCTION app.guard_company_cycle() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_company_id IS NOT NULL
     AND (NEW.parent_company_id = NEW.id OR app.is_company_descendant(NEW.parent_company_id, NEW.id)) THEN
    RAISE EXCEPTION 'company % cannot have parent % — would create a cycle', NEW.id, NEW.parent_company_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER company_no_cycle BEFORE INSERT OR UPDATE ON company
  FOR EACH ROW EXECUTE FUNCTION app.guard_company_cycle();
--> statement-breakpoint

-- ── company_statutory_my: tenant-readable, admin-managed ──
GRANT SELECT, INSERT, UPDATE, DELETE ON company_statutory_my TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE company_statutory_my ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_statutory_my_rls ON company_statutory_my FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());

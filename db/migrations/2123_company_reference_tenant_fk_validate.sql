-- Tenant-isolation defence in depth, ADR-0174 follow-up part 4 of 4: check the data, then validate the 2122
-- company/tenant keys, exactly as 2102 did for company_id.
--
-- Each key is validated in its own subtransaction, so one offending table does not hide the others. A row
-- whose tenant_id differs from its referenced company's tenant is reported with its table and first
-- offending key, and the migration then fails as a whole: the installation stays on its previous journal
-- row. Nothing is rewritten or deleted automatically; such a row is a data defect for its owner to review.
-- VALIDATE reads past row-level security, as every foreign-key check does.
--
-- VALIDATE takes SHARE UPDATE EXCLUSIVE on each table and ROW SHARE on company; when 2122 lands in the same
-- run its locks are held until the commit (writes to these six tables wait, reads continue).
DO $company_reference_validate$
DECLARE
  target text[];
  problem text;
  report text[] := ARRAY[]::text[];
BEGIN
  FOREACH target SLICE 1 IN ARRAY ARRAY[
    ['public.company', 'company_parent_company_tenant_fk'],
    ['public.notice', 'notice_owner_company_tenant_fk'],
    ['public.overtime_pattern', 'overtime_pattern_creation_company_tenant_fk'],
    ['public.overtime_pattern_version', 'overtime_pattern_version_creation_company_tenant_fk'],
    ['public.performance_kpi_library', 'performance_kpi_library_group_company_tenant_fk'],
    ['public.reporting_line', 'reporting_line_scope_company_tenant_fk']
  ] LOOP
    BEGIN
      EXECUTE pg_catalog.format('ALTER TABLE %s VALIDATE CONSTRAINT %I', target[1]::regclass, target[2]);
    EXCEPTION WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS problem = PG_EXCEPTION_DETAIL;
      report := report || pg_catalog.format('%s: %s', target[1], problem);
    END;
  END LOOP;
  IF pg_catalog.cardinality(report) > 0 THEN
    RAISE EXCEPTION 'Rows reference a company of another tenant; review them before validating'
      USING ERRCODE = 'foreign_key_violation', DETAIL = pg_catalog.array_to_string(report, '; ');
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname LIKE '%\_company\_tenant\_fk' AND contype = 'f' AND NOT convalidated
      AND confrelid = 'public.company'::regclass
  ) THEN
    RAISE EXCEPTION 'A company/tenant key is still not validated' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $company_reference_validate$;

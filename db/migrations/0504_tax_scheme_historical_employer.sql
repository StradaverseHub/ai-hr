-- r382: historical payroll context for already-visible employment records only.
-- No employment/person/assignment visibility change. Historical declarations require administration
-- of BOTH the declared employer and today's employer. Actor/time/immutable grants remain unchanged.
DROP POLICY employment_tax_scheme_my_insert ON employment_tax_scheme_my;
--> statement-breakpoint
CREATE POLICY employment_tax_scheme_my_insert ON employment_tax_scheme_my FOR INSERT WITH CHECK (
 tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)
 AND EXISTS (
  SELECT 1 FROM company c WHERE c.id=employment_tax_scheme_my.company_id
   AND c.tenant_id=employment_tax_scheme_my.tenant_id AND c.country='MY'
 )
 AND EXISTS (
  SELECT 1 FROM employment e
  WHERE e.id=employment_tax_scheme_my.employment_id AND e.tenant_id=employment_tax_scheme_my.tenant_id
   AND app.is_admin_for(e.company_id)
   AND (
    e.company_id=employment_tax_scheme_my.company_id
    OR EXISTS (
     SELECT 1 FROM assignment a
     WHERE a.employment_id=e.id AND a.tenant_id=employment_tax_scheme_my.tenant_id
      AND a.company_id=employment_tax_scheme_my.company_id AND a.superseded_at IS NULL
      AND a.valid_from <= (to_date(employment_tax_scheme_my.valid_to||'-01','YYYY-MM-DD') + interval '1 month' - interval '1 day')::date
      AND (a.valid_to IS NULL OR a.valid_to > to_date(employment_tax_scheme_my.valid_from||'-01','YYYY-MM-DD'))
    )
   )
 )
 AND declared_by_user_id=app.current_user_id() AND declared_at=now() AND archived_at IS NULL
 AND EXISTS (SELECT 1 FROM app_user u WHERE u.id=declared_by_user_id AND u.tenant_id=employment_tax_scheme_my.tenant_id)
);

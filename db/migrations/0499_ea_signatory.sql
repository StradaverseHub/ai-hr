-- r376, board 450f443f. EA officer display identity without opening person RLS.
-- Returns only the configured LHDN signatory name and current company job title.
-- The caller must own the subject employment or administer its payroll AND this employer.
-- The employer must be the subject's current company or have paid them in the requested year.
-- All relations are qualified against temporary-table substitution; PUBLIC cannot execute.
-- Rollback: DROP FUNCTION app.ea_signatory(uuid, uuid, text);
CREATE FUNCTION app.ea_signatory(p_employment_id uuid, p_company_id uuid, p_year text)
RETURNS TABLE(officer_name text, officer_position text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT sp.full_name, title.title
  FROM public.employment subject
  JOIN public.company co ON co.id = p_company_id AND co.tenant_id = subject.tenant_id
  JOIN public.company_statutory_authority auth
    ON auth.company_id = co.id AND auth.tenant_id = co.tenant_id AND auth.authority = 'lhdn'
  JOIN public.person sp ON sp.id = auth.signatory_person_id AND sp.tenant_id = co.tenant_id
  LEFT JOIN LATERAL (
    SELECT pos.title
    FROM public.employment se
    JOIN public.assignment a ON a.employment_id = se.id AND a.tenant_id = se.tenant_id
    JOIN public.position pos ON pos.id = a.position_id AND pos.tenant_id = se.tenant_id
    WHERE se.person_id = sp.id AND se.company_id = co.id AND se.tenant_id = co.tenant_id
      AND se.hired_on <= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      AND (se.terminated_on IS NULL OR se.terminated_on >= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
      AND a.superseded_at IS NULL
      AND a.valid_from <= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      AND (a.valid_to IS NULL OR a.valid_to > (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
      AND COALESCE(a.company_id, se.company_id) = co.id
    ORDER BY a.valid_from DESC, se.hired_on DESC, a.id
    LIMIT 1
  ) title ON true
  WHERE subject.id = p_employment_id AND subject.tenant_id = app.current_tenant_id()
    AND p_year ~ '^[0-9]{4}$'
    AND (
      EXISTS (SELECT 1 FROM public.app_user u
        WHERE u.id = app.current_user_id() AND u.tenant_id = subject.tenant_id AND u.person_id = subject.person_id)
      OR (app.can_admin_payroll_for(subject.company_id) AND app.can_admin_payroll_for(co.id))
    )
    AND (subject.company_id = co.id OR EXISTS (
      SELECT 1 FROM public.payslip ps
      JOIN public.payroll_batch pb ON pb.id = ps.batch_id AND pb.tenant_id = ps.tenant_id
      WHERE ps.employment_id = subject.id AND ps.tenant_id = subject.tenant_id
        AND pb.company_id = co.id AND pb.pay_period LIKE p_year || '-%'
    ));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ea_signatory(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ea_signatory(uuid, uuid, text) TO ai_hr_app;

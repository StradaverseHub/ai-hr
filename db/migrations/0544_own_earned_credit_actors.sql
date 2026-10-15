-- Board 2634fa7a: grant actor names for the employee's own earned-credit register.
-- Centrally reserved 0544 / 1791900000024. Ship after 0541 AI, 0542 email and 0543 authentication.
--
-- person RLS stays unchanged. This reader exposes a name only for the grant event of a lot owned by
-- the current login's person in the current tenant. It has no manager/admin bypass. Multiple own
-- employments are intentional. An unknown or erased actor stays NULL; no historical actor is invented.
-- Match order is the HR register's existing order: first the exact lot+recorded instant, then the
-- legacy subject+ledger instant fallback, with event sequence breaking ties in either group.
-- Every relation is schema-qualified and pg_catalog precedes pg_temp to resist temporary-table shadows.
-- Rollback: DROP FUNCTION app.own_earned_credit_actors(uuid[]);

CREATE OR REPLACE FUNCTION app.own_earned_credit_actors(p_lot_ids uuid[])
  RETURNS TABLE(event_id uuid, actor_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(exact_event.id, legacy_event.id),
         (SELECT p.full_name
            FROM public.app_user actor
            JOIN public.person p ON p.id = actor.person_id AND p.tenant_id = actor.tenant_id
           WHERE actor.id = COALESCE(exact_event.actor_id, legacy_event.actor_id)
             AND actor.tenant_id = lot.tenant_id)
    FROM public.toil_accrual lot
    JOIN public.employment e ON e.id = lot.employment_id AND e.tenant_id = lot.tenant_id
    LEFT JOIN public.leave_ledger credit ON credit.id = lot.ledger_entry_id AND credit.tenant_id = lot.tenant_id
    LEFT JOIN LATERAL (
      SELECT de.id, de.actor_id
        FROM public.domain_event de
       WHERE de.tenant_id = lot.tenant_id
         AND de.subject_employment_id = lot.employment_id
         AND de.aggregate_id = lot.id
         AND de.occurred_at = COALESCE(credit.created_at, lot.created_at)
       ORDER BY de.sequence
       LIMIT 1
    ) exact_event ON true
    -- Most lots have the aggregate-linked event. Do not scan the employee's full event history for
    -- each of those lots: the existing aggregate index resolves the exact branch, and only older lots
    -- without it evaluate the legacy timestamp fallback.
    LEFT JOIN LATERAL (
      SELECT de.id, de.actor_id
        FROM public.domain_event de
       WHERE exact_event.id IS NULL
         AND credit.id IS NOT NULL
         AND de.tenant_id = lot.tenant_id
         AND de.subject_employment_id = lot.employment_id
         AND de.occurred_at = credit.created_at
       ORDER BY de.sequence
       LIMIT 1
    ) legacy_event ON true
   WHERE lot.id = ANY(p_lot_ids)
     AND lot.tenant_id = app.current_tenant_id()
     AND COALESCE(exact_event.id, legacy_event.id) IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.app_user login
        WHERE login.id = app.current_user_id()
          AND login.tenant_id = lot.tenant_id
          AND login.person_id = e.person_id
     );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.own_earned_credit_actors(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.own_earned_credit_actors(uuid[]) TO ai_hr_app;

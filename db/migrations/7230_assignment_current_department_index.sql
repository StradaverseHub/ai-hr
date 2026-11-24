-- Current assignments by department (ADR 0181 employment-visibility addendum, approved 24 November 2026, step (b)).
-- Nothing indexed assignment.department_id. The employee picker's department options probe current assignments per
-- company and department pair (core/employee-choice.ts readOptions; 2.6 s mean on staging), and the department-head
-- arm of precomputed employment visibility reads the current assignments of a department subtree. Both filter
-- exactly `valid_to IS NULL AND superseded_at IS NULL AND department_id = ...` within one tenant, so the index is
-- partial on that predicate and carries employment_id for the probe's row-security check.
-- An index only: no rows, policies, grants or functions change. Building it holds a SHARE lock on assignment
-- (writes wait, reads continue) for the build only; the lock wait is bounded so a busy table fails the migration
-- instead of queueing writers behind it.
SET LOCAL lock_timeout='5s';
--> statement-breakpoint
CREATE INDEX assignment_current_department_idx ON public.assignment (tenant_id, department_id) INCLUDE (employment_id)
 WHERE valid_to IS NULL AND superseded_at IS NULL AND department_id IS NOT NULL;

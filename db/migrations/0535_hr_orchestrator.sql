-- Coordination state references authoritative HR records. It contains no copied field values.
CREATE TABLE hr_orchestration_case (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 employment_id uuid NOT NULL REFERENCES employment(id) ON DELETE CASCADE,
 gap text NOT NULL,
 state text NOT NULL CHECK (state IN ('needs_input','needs_review','verified','inactive')),
 audience text NOT NULL CHECK (audience IN ('employee','hr')),
 harness_version text NOT NULL,
 opened_at timestamptz NOT NULL DEFAULT now(),
 observed_at timestamptz NOT NULL DEFAULT now(),
 verified_at timestamptz,
 reopen_count integer NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
 CONSTRAINT hr_orchestration_case_identity UNIQUE(tenant_id,employment_id,gap),
 CHECK ((state = 'verified') = (verified_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX hr_orchestration_case_queue ON hr_orchestration_case(tenant_id,state,opened_at);
--> statement-breakpoint
ALTER TABLE hr_orchestration_case ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hr_orchestration_case_scope ON hr_orchestration_case FOR ALL
 USING (tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id)
   AND EXISTS (SELECT 1 FROM employment e WHERE e.id=hr_orchestration_case.employment_id AND e.tenant_id=app.current_tenant_id()))
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id)
   AND EXISTS (SELECT 1 FROM employment e WHERE e.id=hr_orchestration_case.employment_id AND e.tenant_id=app.current_tenant_id()));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON hr_orchestration_case TO ai_hr_app;
--> statement-breakpoint
REVOKE DELETE ON hr_orchestration_case FROM ai_hr_app;

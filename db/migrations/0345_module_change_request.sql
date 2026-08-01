-- ADR-0077 slice 5 — the module change REQUEST: the only entitlement write path before the console.
--
-- WHY AN INTENT ROW AND A RUNNER, rather than a service the app calls. `tenant_module` is SELECT-only
-- to ai_hr_app by 0313, deliberately: "a customer may see what they have, never grant it." So the write
-- has to happen under the owner role, and the owner credential is kept out of the web application
-- (migration 0001, and scripts/provision-runner.ts is the established shape for exactly this). An
-- operator records an INTENT here; the out-of-band runner applies it. No hand SQL against
-- tenant_module, ever — that is the rule this table exists to make keepable.
--
-- Same grant discipline as 0313: an EXPLICIT REVOKE, because ALTER DEFAULT PRIVILEGES means omitting a
-- GRANT does not deny anything. The customer may SEE a pending change against their own tenant (it is
-- their subscription) and may never write one.
CREATE TABLE module_change_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  module_code text NOT NULL REFERENCES module(code),
  -- NULL = tenant-wide, mirroring tenant_module.company_id exactly (slice 2 scoping).
  company_id uuid,
  action text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  -- Which step the runner reached, so a failure names where it stopped rather than just failing.
  current_step text,
  error text,
  -- The runner's claim stamp, read by the stale-reclaim sweep (provision-runner idiom).
  claimed_at timestamptz,
  -- WHO asked. Text for now: platform_user exists but the console that would populate it is slice 7,
  -- and inventing a FK to a table nothing writes would be a constraint with no data behind it.
  requested_by text NOT NULL,
  -- Deactivation only: the operator's chosen disposition for blocking state, recorded BEFORE the
  -- runner acts so the decision is auditable separately from its execution.
  disposition jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT module_change_request_action_ck CHECK (action IN ('activate', 'deactivate')),
  CONSTRAINT module_change_request_status_ck CHECK (status IN ('pending', 'running', 'done', 'failed')),
  -- A company-scoped request cannot name another tenant's company — the same composite FK 0313 gave
  -- tenant_module, for the same reason.
  CONSTRAINT module_change_request_company_same_tenant_fk FOREIGN KEY (company_id, tenant_id)
    REFERENCES company (id, tenant_id)
);--> statement-breakpoint

-- The runner's claim query: oldest pending first.
CREATE INDEX module_change_request_claim_idx ON module_change_request (status, created_at);--> statement-breakpoint

ALTER TABLE module_change_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON module_change_request FROM ai_hr_app;--> statement-breakpoint
GRANT SELECT ON module_change_request TO ai_hr_app;--> statement-breakpoint
-- SELECT-only policy, and deliberately no write policy: with writes revoked at the grant level the
-- attempt fails before RLS is consulted, and the ABSENCE of a policy means a future re-grant does not
-- silently open a hole. Copied from tenant_module_read for exactly that reasoning.
CREATE POLICY module_change_request_read ON module_change_request
  FOR SELECT USING (tenant_id = app.current_tenant_id());

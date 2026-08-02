-- 0350 — ADR-0077 slice 9: tenant CLOSURE (dual-controlled) and the SUSPENSION WINDOW record.
--
-- r105 refused to let dunning ever reach 'closed': closure starts a retention clock that ends in
-- destruction, and a lapsed invoice must not begin deleting payroll history. So closure needs its own
-- evidence — who asked, who approved, and that they were two different people — held on the row rather
-- than only in an event, because the CHECK below is what makes single-person closure unrepresentable.
--
-- Written on the OWNER connection like every other tenant column (0313 leaves ai_hr_app with SELECT
-- only on tenant), so no RLS policy changes here.
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS closure_requested_by uuid;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS closure_requested_at timestamptz;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS closure_approved_by uuid;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS closure_approved_at timestamptz;

-- DUAL CONTROL, IN THE DATABASE. The service refuses first with a readable message; this is the
-- backstop that keeps a hand-written UPDATE from closing a tenant on one person's say-so. Two distinct
-- non-null ids, or nothing at all.
ALTER TABLE tenant DROP CONSTRAINT IF EXISTS tenant_closure_dual_control_check;
ALTER TABLE tenant
  ADD CONSTRAINT tenant_closure_dual_control_check
  CHECK (
    closed_at IS NULL
    OR (
      closure_requested_by IS NOT NULL
      AND closure_approved_by IS NOT NULL
      AND closure_requested_by <> closure_approved_by
    )
  );

-- tenant_suspension_window = one row per period the tenant spent out of good standing.
--
-- THIS IS THE INPUT REACTIVATION NEEDS. r108 established the asymmetry: accrual self-heals on the next
-- ordinary run, but both expiry sweeps compare a stored date to `today`, so a plain re-run after
-- reinstatement forfeits everything whose date fell INSIDE the window — days the employee never had a
-- chance to use, taken because their employer was late paying. Reactivation pushes those expiries out
-- by exactly the frozen time, and it can only do that if the frozen time was written down.
--
-- resumed_at NULL ⇒ the tenant is suspended right now (an OPEN window). Readers must handle it;
-- core/tenant-lifecycle.ts counts an open window up to the date being asked about, so a
-- still-suspended tenant reports the time frozen so far rather than zero.
CREATE TABLE IF NOT EXISTS tenant_suspension_window (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  suspended_at date NOT NULL,
  resumed_at date,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A window cannot end before it began. Zero-length is allowed: suspended and reinstated same day is a
  -- real thing that happened and should be recorded, not rejected.
  CONSTRAINT tenant_suspension_window_order_check CHECK (resumed_at IS NULL OR resumed_at >= suspended_at)
);

-- At most ONE open window per tenant. Two would mean the tenant was suspended twice without being
-- reinstated in between, which is not a state the lifecycle can produce — and if it ever did, the
-- frozen-day arithmetic would double-count it and hand back twice the leave.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_suspension_window_open_uq
  ON tenant_suspension_window (tenant_id)
  WHERE resumed_at IS NULL;

CREATE INDEX IF NOT EXISTS tenant_suspension_window_tenant_idx
  ON tenant_suspension_window (tenant_id, suspended_at);

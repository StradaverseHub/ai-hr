-- ADR-0076 slice 1 — the payroll anomaly layer's substrate.
--
-- WHY THIS EXISTS. ADR-0074 set the commercial target: ~3,000 headcount run by 3 payroll staff, a ~1000:1
-- ratio against an industry baseline of 1 FTE per 250-500. That is only reachable if the overwhelming
-- majority of people are paid with zero human touch, which makes it an EXCEPTION-RATE problem, not a
-- headcount problem. At a 97% auto-clear rate ~90 of 3,000 need human eyes per cycle. Nothing in this
-- codebase currently measures that rate, so nobody knows the baseline. These three tables are where it
-- starts being measured.
--
-- NOTHING HERE IS ON THE MONEY PATH. The evaluator is read-only: it reads payslips and writes verdicts.
-- It never mutates a payslip, a batch total, or a statutory figure. The deterministic kernel keeps
-- computing every ringgit; this layer only classifies what the kernel produced. That separation is what
-- makes the ratio defensible to a CFO and an auditor, and it is why these tables cascade from their batch
-- and are referenced by nothing.
--
-- THRESHOLDS ARE DATA, NOT CODE (payroll_anomaly_config), mirroring statutory_ruleset, for one reason:
-- calibration must not require a deploy. Tuning a threshold during a client's first live cycles is a
-- versioned, audited config change. ADR-0076 §6 is blunt that no amount of building substitutes for real
-- history — the shipped defaults are conservative placeholders, explicitly labelled untuned in the seed so
-- nobody mistakes 30% for an empirically derived number.

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- VERDICT — one live row per (batch, employment).
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payroll_anomaly_verdict" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  -- CASCADE: a deleted batch's verdicts are meaningless. This is the only table pair in the payroll area
  -- that may cascade, precisely because it holds no financial record — deleting a verdict destroys an
  -- opinion about a payslip, never the payslip.
  "batch_id" uuid NOT NULL REFERENCES "payroll_batch"("id") ON DELETE CASCADE,
  "employment_id" uuid NOT NULL REFERENCES "employment"("id"),
  -- auto_clear | review | block. DERIVED, never scored: any block finding -> block, any review -> review,
  -- else auto_clear (ADR-0076 §2.5). A CHECK rather than a pg enum, matching payroll_status_history.action.
  "disposition" text NOT NULL,
  -- STAYS NULL UNTIL PHASE 1b, deliberately. A "confidence" number implies a calibrated probability, and
  -- with no payroll history any number emitted here would be decoration inviting exactly the false trust
  -- this design exists to prevent. The column is present so 1b needs no migration.
  "score" numeric(5, 4),
  -- COVERAGE TRANSPARENCY (ADR-0076 §2.4), and the reason these two columns are not optional. The failure
  -- mode to avoid is a statistical detector silently returning "no findings" on a client with two cycles of
  -- history, which is indistinguishable from "checked and clean". Recording what was SKIPPED and why lets a
  -- verdict say "auto-clear, but 2 of 6 detectors could not run yet", so a 100% auto-clear rate in month one
  -- reads as thin coverage rather than a clean bill of health.
  "detectors_run" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "detectors_skipped" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "computed_at" timestamptz NOT NULL DEFAULT now(),
  -- Re-run history is KEPT, never deleted: the evaluator is idempotent and re-runnable on an open batch
  -- (and will run daily once the dry-run scheduler lands), so a superseded verdict is the audit record of
  -- what the system believed at the time.
  "superseded_at" timestamptz,
  "resolved_by_user_id" uuid REFERENCES "app_user"("id"),
  "resolved_at" timestamptz,
  -- accepted | fixed_upstream | false_positive. `false_positive` is the FP-rate numerator (ADR-0076 §5).
  "resolution" text,
  "resolution_note" text,
  CONSTRAINT "payroll_anomaly_verdict_disposition_ck"
    CHECK ("disposition" IN ('auto_clear', 'review', 'block')),
  CONSTRAINT "payroll_anomaly_verdict_resolution_ck"
    CHECK ("resolution" IS NULL OR "resolution" IN ('accepted', 'fixed_upstream', 'false_positive'))
);
--> statement-breakpoint

-- One LIVE verdict per employee per batch. Partial on superseded_at so the re-run trail is retained.
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_anomaly_verdict_live_uq"
  ON "payroll_anomaly_verdict" ("batch_id", "employment_id")
  WHERE "superseded_at" IS NULL;
--> statement-breakpoint

-- The queue's read: every live verdict of one batch, worst disposition first.
CREATE INDEX IF NOT EXISTS "payroll_anomaly_verdict_batch_idx"
  ON "payroll_anomaly_verdict" ("tenant_id", "batch_id", "disposition")
  WHERE "superseded_at" IS NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- FINDING — one row per detector hit.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payroll_anomaly_finding" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "verdict_id" uuid NOT NULL REFERENCES "payroll_anomaly_verdict"("id") ON DELETE CASCADE,
  "detector_id" text NOT NULL,
  "severity" text NOT NULL,
  -- The numbers that triggered it. Every figure the narrative prints is interpolated FROM HERE — the model
  -- is never asked to produce a ringgit amount (ADR-0074's non-negotiable invariant).
  "facts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Provenance into domain_event, so a finding can always be traced to the events that caused it.
  "source_event_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- An i18n KEY, not prose: this string is rendered in six locales.
  "suggested_action" text NOT NULL,
  -- OPTIONAL LLM output, additive only. Generated after classification and never able to revise it; a
  -- narration failure or timeout degrades to the structured facts above, so it is never on the critical path.
  "narrative" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_anomaly_finding_severity_ck" CHECK ("severity" IN ('block', 'review', 'info'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payroll_anomaly_finding_verdict_idx"
  ON "payroll_anomaly_finding" ("verdict_id");
--> statement-breakpoint

-- Detector-level rollups for the calibration metrics ("which detector produces our false positives").
CREATE INDEX IF NOT EXISTS "payroll_anomaly_finding_detector_idx"
  ON "payroll_anomaly_finding" ("tenant_id", "detector_id");
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- CONFIG — thresholds per tenant, optionally per company.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "payroll_anomaly_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  -- NULL = the tenant-wide default. A company row overrides it, so one entity can be tuned without
  -- disturbing the rest of a 60-entity group.
  "company_id" uuid REFERENCES "company"("id"),
  "detector_id" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "params" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "effective_from" date NOT NULL DEFAULT CURRENT_DATE,
  "created_by_user_id" uuid REFERENCES "app_user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- Archived rather than deleted: a verdict computed last cycle must remain explicable by the thresholds
  -- that were in force when it was computed.
  "archived_at" timestamptz
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "payroll_anomaly_config_live_uq"
  ON "payroll_anomaly_config" ("tenant_id", COALESCE("company_id", '00000000-0000-0000-0000-000000000000'::uuid), "detector_id", "effective_from")
  WHERE "archived_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payroll_anomaly_config_lookup_idx"
  ON "payroll_anomaly_config" ("tenant_id", "detector_id")
  WHERE "archived_at" IS NULL;
--> statement-breakpoint

-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────────────────
-- Explicit and NOT optional: production's ALTER DEFAULT PRIVILEGES masks an omission here, so a restored
-- developer cluster is where "permission denied for table payroll_anomaly_verdict" would surface — after
-- the deploy, on the first evaluation. Same reasoning as 0418 / 0419 / 0420 / 0421.
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_anomaly_verdict" TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_anomaly_finding" TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_anomaly_config" TO ai_hr_app;
--> statement-breakpoint

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
-- A DELIBERATE DEPARTURE FROM payslip_rls, and the one design decision here worth arguing with.
--
-- payslip is readable by can_see_employment OR can_admin_payroll_employment — an employee may read their
-- own payslip, because it is THEIR document. An anomaly verdict is NOT their document. It is an operator's
-- working note about them: "missing bank profile", "pay without attendance", "confirm the employee actually
-- worked". Showing that to the employee would leak an unreviewed machine judgement about their pay, and
-- ADR-0076 is explicit that early cycles will produce false positives. So read is payroll-admin ONLY.
--
-- The employee-facing surface promised by ADR-0074 is a different thing built later (the explanation
-- agent, which narrates a FINAL payslip), and it must not be back-doored through this table.
ALTER TABLE "payroll_anomaly_verdict" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "payroll_anomaly_verdict_rls" ON "payroll_anomaly_verdict";
--> statement-breakpoint
CREATE POLICY "payroll_anomaly_verdict_rls" ON "payroll_anomaly_verdict" FOR ALL
  USING ("tenant_id" = app.current_tenant_id() AND app.can_admin_payroll_employment("employment_id"))
  WITH CHECK ("tenant_id" = app.current_tenant_id() AND app.can_admin_payroll_employment("employment_id"));
--> statement-breakpoint

-- Findings inherit the verdict's visibility via EXISTS rather than carrying their own employment_id: one
-- place decides who may see an anomaly, so the two can never drift apart.
ALTER TABLE "payroll_anomaly_finding" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "payroll_anomaly_finding_rls" ON "payroll_anomaly_finding";
--> statement-breakpoint
CREATE POLICY "payroll_anomaly_finding_rls" ON "payroll_anomaly_finding" FOR ALL
  USING (
    "tenant_id" = app.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM "payroll_anomaly_verdict" v
      WHERE v."id" = "payroll_anomaly_finding"."verdict_id"
        AND app.can_admin_payroll_employment(v."employment_id")
    )
  )
  WITH CHECK (
    "tenant_id" = app.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM "payroll_anomaly_verdict" v
      WHERE v."id" = "payroll_anomaly_finding"."verdict_id"
        AND app.can_admin_payroll_employment(v."employment_id")
    )
  );
--> statement-breakpoint

-- Config is company-scoped (or tenant-wide when company_id IS NULL, which only a tenant admin may touch).
ALTER TABLE "payroll_anomaly_config" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "payroll_anomaly_config_rls" ON "payroll_anomaly_config";
--> statement-breakpoint
CREATE POLICY "payroll_anomaly_config_rls" ON "payroll_anomaly_config" FOR ALL
  USING (
    "tenant_id" = app.current_tenant_id()
    AND ("company_id" IS NULL OR app.can_admin_payroll_for("company_id"))
  )
  WITH CHECK (
    "tenant_id" = app.current_tenant_id()
    AND ("company_id" IS NULL OR app.can_admin_payroll_for("company_id"))
  );

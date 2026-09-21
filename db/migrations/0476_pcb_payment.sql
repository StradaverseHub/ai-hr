-- 0476 — r321 (72b100cd) "PCB 2(II)": the employer's PAYMENT of monthly tax deductions to LHDN.
--
-- WHY A TABLE OF ITS OWN, AND NOT TWO MORE COLUMNS ON statutory_report.
--
-- PCB 2(II) section 2 asks, per month, for the receipt / bank slip / transaction NUMBER and the receipt
-- DATE — separately for MTD and for CP38. `statutory_report.ack_ref` is the wrong shape for that in two
-- ways at once: it is ONE reference per company+period (its own contract calls it "the agency's
-- acknowledgement / receipt reference" for the RETURN), and a return is not a payment. An employer may
-- lodge one CP39 and pay against it more than once, and LHDN issues a receipt per payment.
--
-- Widening ack_ref to mean two things, or smuggling the pair into `totals`, would make a generic
-- cross-agency table carry MY-tax-payment semantics. Measured on production 2026-09-21: all six CP39
-- rows are status=draft with ack_ref NULL and filed_on NULL, so nothing is being lost by leaving that
-- column exactly as it is.
--
-- THE GRAIN IS (company, period, kind) — one payment reference per deduction stream per month, which is
-- the grain the form's own table is ruled at. `kind` is the split the form draws: 'mtd' is the ordinary
-- monthly deduction, 'cp38' the LHDN instalment instruction, and they are paid and receipted apart.
--
-- ⚠️ NOTHING HERE IS DERIVED AND NOTHING HERE IS CALCULATED. Every row is a fact an operator keys in
-- after paying, and the form prints it verbatim. A month with no row prints an EMPTY box, never 0.00:
-- on a tax form an absent box asserts nothing while a zero asserts the money does not exist, and those
-- are different statements to LHDN (CLAUDE.md §8).

CREATE TABLE IF NOT EXISTS "pcb_payment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "company_id" uuid NOT NULL REFERENCES "company"("id"),
  -- 'YYYY-MM', the deduction month the payment settles — the same period_key shape statutory_report uses.
  "period_key" text NOT NULL,
  -- 'mtd' | 'cp38'. The two streams PCB 2(II) reports in separate columns.
  "kind" text NOT NULL,
  -- The receipt / bank slip / transaction number LHDN issued. Free text and deliberately unvalidated:
  -- this repo cannot verify LHDN's format, and pattern-policing one would be inventing third-party
  -- behaviour (the same reasoning statutory_report.ack_ref records).
  "receipt_ref" text NOT NULL,
  -- The receipt / transaction date, as printed on the form.
  "paid_on" date NOT NULL,
  "recorded_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "pcb_payment" DROP CONSTRAINT IF EXISTS "pcb_payment_kind_chk";--> statement-breakpoint
ALTER TABLE "pcb_payment"
  ADD CONSTRAINT "pcb_payment_kind_chk" CHECK ("kind" IN ('mtd', 'cp38'));--> statement-breakpoint

-- 'YYYY-MM'. Pinned here as well as in the service because a malformed key would silently never match
-- the form's month lookup and the box would print empty — a wrong answer that looks like a missing one.
ALTER TABLE "pcb_payment" DROP CONSTRAINT IF EXISTS "pcb_payment_period_chk";--> statement-breakpoint
ALTER TABLE "pcb_payment"
  ADD CONSTRAINT "pcb_payment_period_chk" CHECK ("period_key" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');--> statement-breakpoint

-- ONE payment reference per company, month and stream: re-keying a correction updates the row rather
-- than leaving two references for one box, which the form has no way to print.
CREATE UNIQUE INDEX IF NOT EXISTS "pcb_payment_company_period_kind_uq"
  ON "pcb_payment" ("company_id", "period_key", "kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pcb_payment_tenant_idx" ON "pcb_payment" ("tenant_id");--> statement-breakpoint

-- CLAUDE.md §6 — a migration that CREATEs a table must GRANT on it: a dev restore has no default
-- privileges and the suite connects as the owner, so no test would see the omission (0345, 0354).
GRANT SELECT, INSERT, UPDATE, DELETE ON "pcb_payment" TO ai_hr_app;--> statement-breakpoint

ALTER TABLE "pcb_payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "pcb_payment_tenant_read" ON "pcb_payment";--> statement-breakpoint
CREATE POLICY "pcb_payment_tenant_read" ON "pcb_payment"
  FOR SELECT TO ai_hr_app USING ("tenant_id" = app.current_tenant_id());--> statement-breakpoint
DROP POLICY IF EXISTS "pcb_payment_tenant_write" ON "pcb_payment";--> statement-breakpoint
CREATE POLICY "pcb_payment_tenant_write" ON "pcb_payment"
  FOR ALL TO ai_hr_app USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

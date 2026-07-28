-- Balance Deduction Source (feedback cdf9ca48) + Allow Unpaid Leave (feedback a7fab30b).
--
-- These two arrived as separate requests but describe ONE mechanism between them: which balance a leave
-- application is measured against, and what happens to the part that balance cannot cover. Built together
-- because either alone leaves the combination undefined — a type that borrows Annual Leave AND allows
-- unpaid leave has to measure its unpaid overflow against the BORROWED balance, and that only has an
-- answer if both settings exist at once.
--
-- ALL THREE COLUMNS ARE INERT AT THEIR DEFAULTS. balance_source_type_id NULL ⇒ the type draws on its own
-- ledger exactly as today; allow_unpaid_leave false ⇒ the existing allow_negative_balance gate decides,
-- unchanged; unpaid_days NULL ⇒ the whole request is paid, which is what every existing row is. So no
-- backfill, and nothing changes until an administrator deliberately switches a leave type over.

-- Which leave type's balance this type spends. NULL = its own (the default and today's behaviour).
-- Self-referencing FK: the picker only ever offers other types of the same tenant, and RLS scopes the read
-- that populates it. ON DELETE is deliberately omitted (RESTRICT) — a type that is somebody's balance source
-- must not vanish and silently return the borrower to spending its own (empty) ledger.
ALTER TABLE "leave_type" ADD COLUMN "balance_source_type_id" uuid REFERENCES "leave_type"("id");--> statement-breakpoint

-- Self-reference is refused in the DB as well as the service: "deduct from another leave type" pointing at
-- itself is not a configuration, it is a typo, and it would make the resolved source depend on how many
-- times you followed the pointer. Longer chains are refused in updateLeaveType (they need a second row to
-- see, which a row-level CHECK cannot do).
ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_balance_source_not_self"
  CHECK ("balance_source_type_id" IS NULL OR "balance_source_type_id" <> "id");--> statement-breakpoint

-- Whether an application of this type may proceed past the available balance, with the uncovered part
-- treated as unpaid leave. NOT NULL DEFAULT false ⇒ every existing type keeps today's refuse-on-insufficient
-- behaviour with no backfill.
ALTER TABLE "leave_type" ADD COLUMN "allow_unpaid_leave" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- The portion of THIS request's `days` that the balance did not cover and that is therefore unpaid. The
-- request stays ONE row of the type the employee actually applied for (the reporter is explicit that the
-- history must still read "Emergency Leave", not "Annual Leave + Unpaid Leave") — the split lives in this
-- column rather than in a second request row. days - unpaid_days is what the ledger debits at approval and
-- what payroll leaves alone; unpaid_days is what payroll deducts through its existing unpaid route.
ALTER TABLE "leave_request" ADD COLUMN "unpaid_days" numeric(6,2);--> statement-breakpoint

-- Bounds, so a hand-written row can never claim more unpaid days than the request has.
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_unpaid_days_within_days"
  CHECK ("unpaid_days" IS NULL OR ("unpaid_days" >= 0 AND "unpaid_days" <= "days"));--> statement-breakpoint

COMMENT ON COLUMN "leave_type"."balance_source_type_id" IS
  'Balance Deduction Source (cdf9ca48): the leave type whose balance this type checks and debits. NULL = own balance. Single hop only — updateLeaveType refuses chains.';--> statement-breakpoint
COMMENT ON COLUMN "leave_type"."allow_unpaid_leave" IS
  'Allow Unpaid Leave (a7fab30b): true = an application beyond the available balance is accepted, with the excess recorded on leave_request.unpaid_days. false = today''s refuse-on-insufficient behaviour.';--> statement-breakpoint
COMMENT ON COLUMN "leave_request"."unpaid_days" IS
  'Allow Unpaid Leave (a7fab30b): the part of `days` the balance could not cover. NULL/0 = fully paid. Excluded from the approval ledger debit; counted by payroll as unpaid leave.';

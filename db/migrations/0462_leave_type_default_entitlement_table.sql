-- 76ffdcf2 (r269) — leave_type gains ONE nullable column: default_entitlement_template_lineage_id.
--
-- ── WHAT AND WHY ──────────────────────────────────────────────────────────────────────────────────────
-- Until now an employee whom NO entitlement eligibility rule ("benefit scheme") matched resolved to
-- nothing for a leave type that has two or more entitlement tables — the resolver refuses to guess which
-- of several tables a person should get (r193 fault 3, core/entitlement-template.ts). The reporter read
-- that as "a benefit scheme decides whether you are entitled at all", which is not what the engine does,
-- and asked that nobody fall through. This column is the answer: HR NAMES one entitlement table per leave
-- type as the default, and anyone no scheme covers receives that table instead of receiving nothing.
--
-- ⚠️ THE SAFETY PROPERTY IS UNCHANGED AND THIS IS WHY. r193's rule is "never hand out a table NOBODY
-- CHOSE". A default is chosen, by a named human, on this leave type. Where the column is NULL the
-- behaviour is byte-identical to today: nothing resolves, `noEntitlementOpinion` holds, the caller posts
-- NOTHING (delta exactly 0, never 0 days). The statutory EA-1955 floor is NOT resurrected as a fallback —
-- fa3f4ccb settled twice, on the reporter's written instruction, that the floor is advisory and out of
-- the arithmetic.
--
-- ── THE VALUE IS A LINEAGE, NOT A VERSION, AND THEREFORE CARRIES NO FOREIGN KEY ────────────────────────
-- `entitlement_template.lineage_id` is the stable identity across versions (an edit closes the running
-- version and inserts a successor), so it is NOT unique on that table and cannot be the target of a
-- references() constraint. The eligibility rule's own `template_lineage_id` is modelled exactly the same
-- way and for the same reason. What keeps it honest is the SERVICE: setLeaveTypeDefaultTemplate refuses a
-- lineage that does not belong to this leave type, and the resolver ignores a default whose lineage has no
-- version in force on the date being resolved (a stopped default simply stops applying — it never
-- resolves against some other version, which is the staleness the lineage design exists to remove).
--
-- ── NO DATA STEP, NO CHECK, NO GRANT ──────────────────────────────────────────────────────────────────
-- Every existing row keeps NULL, i.e. today's behaviour exactly. No CHECK: a NOT VALID check still fires
-- on every UPDATE of leave_type (CLAUDE.md §6) and the rule being enforced is a cross-table one a check
-- cannot express anyway. Nothing is created, so the existing leave_type grants and RLS policies carry
-- over untouched.
--
-- Journal entry: idx 462 (see meta/_journal.json).

DO $$
DECLARE total int; typed int;
BEGIN
  SELECT count(*) INTO total FROM leave_type;
  SELECT count(*) INTO typed FROM entitlement_template;
  RAISE NOTICE '0462 leave_type.default_entitlement_template_lineage_id added (nullable): % leave types keep a NULL default, i.e. unchanged resolution; % entitlement_template versions exist to choose from.', total, typed;
END $$;
--> statement-breakpoint
ALTER TABLE "leave_type" ADD COLUMN "default_entitlement_template_lineage_id" uuid;

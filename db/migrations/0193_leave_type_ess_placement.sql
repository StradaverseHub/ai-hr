-- Leave grouping visibility (feedback b653ac1b).
--
-- Adds one additive, NULLABLE text column ess_placement to leave_type letting an HR admin decide WHERE a
-- leave type sits on the employee self-service Leave tab: as a Primary card (stands out at the top), inside
-- a Secondary group (tucked below), or Hidden (not shown to the employee at all).
--
--   ess_placement — 'primary' | 'secondary'. NULL ⇒ resolve from a code-keyed default map
--     (lib/leave-groups.ts): the common types (ANNUAL/SICK/HOSPITALIZATION/EMERGENCY/REPLACEMENT) default to
--     'primary', the sensitive/rarely-used ones (PROLONGED_ILLNESS_*, SUSPENSION_*, UNRECORDED,
--     UNPAID_MEDICAL) default to 'hidden', everything else to 'secondary'. An explicit HR choice overrides
--     the default.
--
-- HIDDEN IS NOT A SEPARATE MECHANISM. "Hidden" placement reuses the SINGLE employee-visibility switch added
-- by 7b11f1c1 (leave_type.visible_to_employee): choosing Hidden sets visible_to_employee=false; resolving a
-- type's placement reads that flag first (false ⇒ hidden) before consulting ess_placement / the default.
-- So we deliberately do NOT store 'hidden' in ess_placement and do NOT add a second hidden column — a
-- 'hidden' string value is rejected by the service (choose Hidden ⇒ the flag), keeping one source of truth.
--
-- Presentation/config only: this NEVER touches balances, entitlement math, accrual, eligibility, workflow
-- or payroll — it only decides how the leave types are arranged on screen (the reporter's stated scope).
--
-- Backward compatible: ess_placement NULL on every existing row ⇒ each type resolves to its code-keyed
-- default, and (since no visible_to_employee is written) every type keeps today's exact visibility. Additive
-- only, no backfill. No RLS change: leave_type already has tenant-read + admin-write policies; the new column
-- inherits them (same as the 0179 visual-config / 0182 leave-unit / 0190 visibility migrations).
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS ess_placement text;
--> statement-breakpoint
ALTER TABLE leave_type DROP CONSTRAINT IF EXISTS leave_type_ess_placement_chk;
--> statement-breakpoint
ALTER TABLE leave_type ADD CONSTRAINT leave_type_ess_placement_chk CHECK (ess_placement IN ('primary', 'secondary'));

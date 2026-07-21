-- R51 cluster 722904dc/71b9143a — Leave Approval Escalation settings, per company.
--
-- When an approver sits on a pending leave request past a configured number of WORKING days, the nightly
-- review-sweep (scripts/review-sweep.ts → core/leave-escalation.ts) drops a bell notification on the next
-- approver in the chain (or a configured approval role). These are the SETTINGS the sweep reads.
--
-- Columns on `company` — NOT a new table (panel-resolved): company already carries the sibling per-company
-- leave settings (leave_multi_approval, leave_cycle, leave_half_day_full_deduction), already has RLS and the
-- app grant, so columns avoid a new table + policies + GRANT (the ADR-0002 footgun) entirely. All columns
-- are nullable or defaulted, so every existing row keeps today's behaviour (escalation OFF).
--
--   escalation_enabled      — the per-company on/off switch. Default false = no behaviour change anywhere.
--   escalate_after_days     — how many working days an approver may sit on a step before escalation.
--                             NULL while disabled; validated 1..90 in code (setLeaveEscalationPolicy).
--   escalation_target       — who gets chased: 'next_level' (the next approver in the chain, the default)
--                             or 'specific_role' (a named approval level kind). TEXT + CHECK, not a pgEnum
--                             (the 0275 lesson: enums are painful to widen).
--   escalation_target_role  — the approval role when target = 'specific_role'; validated in code against
--                             LEVEL_KINDS (core/leave-approval-policy.ts), NULL otherwise.
--   escalation_updated_at   — when the escalation settings were last SAVED. Dedicated column, NOT
--                             company.updated_at (which moves on any unrelated company edit): requests whose
--                             waiting clock started BEFORE this moment are grandfathered — flipping the
--                             switch on (or shortening the days) must not fire a burst of alerts for every
--                             already-old request on the first night.
ALTER TABLE company ADD COLUMN escalation_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE company ADD COLUMN escalate_after_days integer;
--> statement-breakpoint
ALTER TABLE company ADD COLUMN escalation_target text NOT NULL DEFAULT 'next_level';
--> statement-breakpoint
ALTER TABLE company ADD COLUMN escalation_target_role text;
--> statement-breakpoint
ALTER TABLE company ADD COLUMN escalation_updated_at timestamptz;
--> statement-breakpoint
ALTER TABLE company ADD CONSTRAINT company_escalation_target_check CHECK (escalation_target IN ('next_level', 'specific_role'));

-- AI Centre: the probation and passport loops may act on their own as REQUEST-ONLY steps (owner decision, 11 November
-- 2026; the AI Centre audit, autonomy finding 6). UNALLOCATED DRAFT 9780 / when 1793330099780 from the
-- coordinator-provided 9780-9789 block (docs/MIGRATION-ALLOCATION.md); the final 51NN tag is assigned at integration.
--
-- Migration 2004 repeats the code cap in the database: only the missed clock-outs and missing employee data loops may
-- stand above Prepare, record an automatic action or have a weekly sample. This widens exactly those four CHECKs to add
-- the probation ending loop (opens the review and routes it to the manager with its due date; decides nothing) and the
-- passports loop (sends the employee the renewal request). The code cap (core/loops/autonomy.ts) still decides how high
-- each loop may go; this only stops the database refusing what the code allows.
-- No policy, trigger, grant, function or row changes. Existing rows already satisfy the wider checks.
ALTER TABLE public.teras_loop_level DROP CONSTRAINT teras_loop_level_cap;
--> statement-breakpoint
ALTER TABLE public.teras_loop_level ADD CONSTRAINT teras_loop_level_cap CHECK (level<=1 OR worker_id IN
 ('loop_missed_clock_outs','loop_missing_employee_data','loop_probation_ending','loop_document_expiry'));
--> statement-breakpoint
ALTER TABLE public.teras_loop_level_change DROP CONSTRAINT teras_loop_level_change_cap;
--> statement-breakpoint
ALTER TABLE public.teras_loop_level_change ADD CONSTRAINT teras_loop_level_change_cap CHECK (to_level<=1 OR worker_id IN
 ('loop_missed_clock_outs','loop_missing_employee_data','loop_probation_ending','loop_document_expiry'));
--> statement-breakpoint
ALTER TABLE public.teras_loop_action DROP CONSTRAINT teras_loop_action_worker_id_check;
--> statement-breakpoint
ALTER TABLE public.teras_loop_action ADD CONSTRAINT teras_loop_action_worker_id_check CHECK (worker_id IN
 ('loop_missed_clock_outs','loop_missing_employee_data','loop_probation_ending','loop_document_expiry'));
--> statement-breakpoint
ALTER TABLE public.teras_loop_sample_review DROP CONSTRAINT teras_loop_sample_review_worker_id_check;
--> statement-breakpoint
ALTER TABLE public.teras_loop_sample_review ADD CONSTRAINT teras_loop_sample_review_worker_id_check CHECK (worker_id IN
 ('loop_missed_clock_outs','loop_missing_employee_data','loop_probation_ending','loop_document_expiry'));

-- 0370 · Remove the Expiry step from Leave Condition configuration (feedback c459bff9)
--
-- WHAT THIS UNDOES. Migration 0155 (fec49317 "Leave Type Expiry Field") added an OPTIONAL age-from-earning
-- expiry pair to leave_type — `expiry_value` + `expiry_unit` (months | days) — plus three CHECK constraints
-- (leave_type_expiry_unit_ck, leave_type_expiry_pair_ck, leave_type_expiry_value_pos_ck). This migration
-- removes all five objects. 0155 itself is SHIPPED and is NOT edited: this is a new forward migration, so a
-- database that has never seen 0155 and one that has both end in the same place.
--
-- WHY, AND WHY IT IS A RESET RATHER THAN A DELETION. The reporter asked for the Expiry step to come off the
-- Condition flow so a NEW expiry framework can be designed from a clean slate (that design lands with the
-- entitlement architecture redesign, 6e9a126e). Leaving the columns behind — even unread — would hand that
-- redesign a legacy pair to inherit and reconcile. So the storage goes with the screen.
--
-- WHAT IS *NOT* REMOVED, DELIBERATELY:
--
--   1. ANNUAL's carry-forward expiry. carry_forward_expiry_* / expireCarriedLeave is a DIFFERENT CLOCK over a
--      DIFFERENT POPULATION: it governs the leftover balance carried across a year end, counted FROM YEAR
--      END. The pair dropped here governed how long a day survived after it was EARNED, counted from the
--      earning date, and was deliberately switched off for ANNUAL precisely so the same day was never taken
--      away twice. Carry-forward expiry is untouched by this migration and is not a replacement for what is
--      being removed. After this ships, NO leave type has age-based expiry on earned days at all.
--
--   2. Ledger rows already stamped 'sys:leave_type_expiry' (AGED_FORFEIT_REASON). Those are transactions
--      employees have already seen. They stay posted, stay inside the Forfeited figure, and stay classified
--      as an AUTOMATIC forfeit rather than a manual HR adjustment. The constant and its three readers stay in
--      the code for that reason even though nothing writes it any more — see core/leave.ts. On the live
--      database this population is EXACTLY ZERO rows / 0 days (counted 2026-08-04), but the code and the
--      reconciliation identity must remain correct for any tenant that does hold such rows.
--
-- WHAT WAS CONFIGURED, FOR THE RECORD. Counted on production 2026-08-04 before anything was touched: exactly
-- ONE leave type had an expiry configured — RL / Replacement Leave, 2 months. That single row is the entire
-- surviving record of what this feature ever held, which is why it is written down here and in the release
-- note: after the DROP there is no way to recover it.
--
-- BALANCE IMPACT: ZERO. Dropping configuration posts no ledger rows. Nothing is added to and nothing is taken
-- away from any employee's balance on the day this runs. The only behavioural change is prospective: unused
-- days on non-ANNUAL types now keep accumulating instead of aging out.
--
-- HOST PREREQUISITE (NOT PERFORMED BY THIS MIGRATION). The live scheduler for the sweep this removes is a
-- CRONTAB, not a systemd timer. The line
--     30 3 * * * cd /opt/ai-hr && /opt/node20/bin/node --env-file=.env.production --import tsx \
--                scripts/expire-aged-leave.ts >> /home/ubuntu/aihr-cron-logs/expire-aged.log 2>&1
-- MUST be removed from the host crontab BEFORE the deploy that deletes scripts/expire-aged-leave.ts, or cron
-- fires nightly at a file that no longer exists.
--
-- ORDERING NOTE. The columns are dropped, not merely cleared: DROP COLUMN removes the values with them, so no
-- separate UPDATE ... SET expiry_value = NULL step is needed or wanted. Postgres drops a column's dependent
-- CHECK constraints automatically, but the three are dropped explicitly first so this migration reads as the
-- exact inverse of 0155 and so a database where the columns were already removed by hand still converges.

DO $$ BEGIN
  ALTER TABLE "leave_type" DROP CONSTRAINT IF EXISTS "leave_type_expiry_value_pos_ck";
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "leave_type" DROP CONSTRAINT IF EXISTS "leave_type_expiry_pair_ck";
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "leave_type" DROP CONSTRAINT IF EXISTS "leave_type_expiry_unit_ck";
END $$;--> statement-breakpoint

ALTER TABLE "leave_type" DROP COLUMN IF EXISTS "expiry_value";--> statement-breakpoint
ALTER TABLE "leave_type" DROP COLUMN IF EXISTS "expiry_unit";--> statement-breakpoint

-- No RLS change: leave_type keeps the tenant-read / admin-write policies it already carries, and removing a
-- column needs no policy change. The grant is re-stated per the migration standard — a no-op on an existing
-- table, and the guarantee that the app role still reaches the table it reads.
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_type" TO ai_hr_app;

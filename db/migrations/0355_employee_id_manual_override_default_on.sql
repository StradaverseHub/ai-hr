-- 0355 — employee_id_config.allow_manual_override: make the stored value agree with the behaviour.
--
-- Item bd271009 makes the "Allow manual override" switch DO something for the first time. It has existed
-- since 0261, is written by createConfig/updateConfig and rendered on the setup screen, and was read by
-- nothing: turning it off changed no behaviour anywhere in the product.
--
-- THE PROBLEM WITH SIMPLY OBEYING IT. The column was added `NOT NULL DEFAULT false`, and every existing
-- row was written while the switch was decorative — so a literal reading would silently HIDE Manual Key In
-- for every company that already has a setup, on the day this ships. Nobody chose that; they just never
-- had a reason to tick a box that did nothing.
--
-- TWO WAYS OUT, AND WHY THIS ONE. The alternative was to treat `false` as "unset, permit manual" at the
-- READ site. That leaves the setup screen printing "No" next to a rule that says yes — two answers to one
-- question, which is exactly the drift this codebase keeps paying for elsewhere. Writing the value down
-- instead means the screen and the wizard state the same fact, and an administrator who genuinely wants
-- Manual Key In off can now untick the box and have it obeyed.
--
-- SCOPE. ACTIVE configs only — an inactive row applies to nobody, so flipping it would be changing a
-- stored answer no one asked. Idempotent (re-running matches nothing). Touches no employee-visible row:
-- not one employment, person, salary, leave balance or Employee ID changes. The running counters
-- (current_running_number) are deliberately NOT in the SET list.
UPDATE "employee_id_config"
   SET "allow_manual_override" = true,
       "updated_at" = now()
 WHERE "status" = 'active'
   AND "allow_manual_override" = false;

-- The COLUMN DEFAULT is deliberately left at false. Nothing inserts without an explicit value from the
-- setup form (whose checkbox now starts ticked), and flipping a column default would silently change what
-- a future INSERT that omits the column means — a wider blast radius than this item needs.

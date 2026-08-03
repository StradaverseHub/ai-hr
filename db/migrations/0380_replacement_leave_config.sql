-- 296fc027 · Step 1 — Replacement Leave becomes CONFIGURABLE in one place, and gains the three settings
-- the request asks for: an employee-request switch, a recorded-only "Replacement Leave From" choice, and
-- an expiry period expressed as a number PLUS a unit.
--
-- ADDITIVE COLUMNS ONLY on toil_policy — no new table, so the existing `toil_policy_rls` policy and the
-- ai_hr_app DML grants from 0076 already cover every column added here. (Stated rather than assumed: a
-- migration two rounds ago created a table with no grant and a developer cluster threw `permission
-- denied` where production was fine by accident via ALTER DEFAULT PRIVILEGES.)
--
-- NOTHING IS RECOMPUTED. Every column is NOT NULL with a DEFAULT that reproduces today's behaviour
-- exactly, so an existing toil_policy row means precisely what it meant before this ran, and every
-- toil_accrual already banked keeps the expiry date frozen onto it at grant time. There are no UPDATEs
-- here for the same reason: `toil_accrual.expires_on` is FROZEN at grant and is never re-derived.

-- ── The expiry period gains a UNIT, and does NOT overload `expiry_days` to carry it ───────────────────
--
-- The obvious shortcut is one number column plus a unit, with `expiry_days` holding "3" when the unit is
-- Months. That is refused: a column named `expiry_days` holding a month count is a trap for every future
-- reader (and for the `expires_on = approved_on + expiry_days` arithmetic in core/toil.ts, which would
-- silently produce a 3-DAY expiry). So the two counts live in two columns, both NOT NULL and both always
-- populated, and `expiry_unit` says which one is authoritative.
--
-- This also means flipping Day(s) ⇄ Month(s) on the form and back is lossless: the count you had under
-- the other unit is still there. `expiry_days` therefore keeps its exact current meaning — the stored day
-- count, used when the unit is Day(s) — which is what every existing row already is.
CREATE TYPE "toil_expiry_unit" AS ENUM ('days', 'months');--> statement-breakpoint
ALTER TABLE "toil_policy" ADD COLUMN "expiry_unit" "toil_expiry_unit" DEFAULT 'days' NOT NULL;--> statement-breakpoint
-- Months are computed by CALENDAR-MONTH ADDITION (core/toil.ts addMonths), not by 30-day arithmetic: an
-- employee told "3 months" expects the same day-of-month three months on. The clamp for a short target
-- month (31 Jan + 1 month ⇒ 28/29 Feb) is in the code, with the test that pins it.
ALTER TABLE "toil_policy" ADD COLUMN "expiry_months" integer DEFAULT 3 NOT NULL;--> statement-breakpoint

-- ── The employee-request switch ───────────────────────────────────────────────────────────────────────
--
-- DEFAULT false, which is the honest backfill: no tenant has an employee request path today, so every
-- existing row must come out of this migration with it OFF. When it is off the employee never sees the
-- button AND cannot submit — enforced in the service (core/replacement-request.ts), not only in the UI,
-- because the UI is one action POST away from being bypassed.
ALTER TABLE "toil_policy" ADD COLUMN "employee_request_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- ── "Replacement Leave From" — RECORDED ONLY ──────────────────────────────────────────────────────────
--
-- Three values, and NOTHING reads this column except the form that writes it. It is not validated
-- against attendance, timesheets or overtime, and it does not change what is banked. The page says so on
-- screen (admin.replacementLeave.fromRecordedOnly) so nobody expects it to bite yet.
--
-- DELIBERATELY NOT `accrual_basis`. That column (hours_worked vs premium_equivalent) answers "how much is
-- one banked day worth", which is a different axis from "which worked time may be banked at all".
-- Overloading it would make the premium multiplier depend on a setting that has no reader.
--
-- The default is 'overtime' rather than a neutral value because that is what the engine actually does
-- today: only a rest-day/holiday OT day is bankable (RL_ELIGIBLE_DAY_TYPES). A row that came out of this
-- migration saying "working hours" would be recording something untrue about the system it describes.
CREATE TYPE "toil_replacement_leave_from" AS ENUM ('working_hours', 'overtime', 'working_hours_and_overtime');--> statement-breakpoint
ALTER TABLE "toil_policy" ADD COLUMN "replacement_leave_from" "toil_replacement_leave_from" DEFAULT 'overtime' NOT NULL;--> statement-breakpoint

-- ── Who may submit — the eligibility criteria ─────────────────────────────────────────────────────────
--
-- JSONB, shaped exactly like `leave_type.eligibility` (a map of criterion key → string[], empty/absent ⇒
-- no restriction on that criterion), so the house reading of "empty means everyone" carries over and the
-- same ChipMultiSelect/MultiSelectPopover form contract (`fd.getAll(key)`) applies unchanged.
--
-- NULL is the backfill and means EVERYONE, which is the only safe answer for a switch that is itself OFF
-- by default: a tenant turning employee requests on for the first time gets "anyone may ask" and narrows
-- from there, rather than silently getting "nobody may ask" and filing a bug.
--
-- The eight criteria are resolved by core/replacement-eligibility.ts, which is the NEW as-of resolver —
-- four of these (department, position, employment type, grade) are the ones core/leave-org-criteria.ts
-- documents as DEFERRED because they do not live on `employment`.
ALTER TABLE "toil_policy" ADD COLUMN "request_eligibility" jsonb;

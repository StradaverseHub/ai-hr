-- Feedback module v2 (ADR-0051): close the loop. A DEPLOYED item can be refuted by the reporter
-- ("not up to standard, still needs changes") → it re-enters the loop as `contested` (the refiner
-- re-plans, carrying contest_reason), and this counter records how many round-trips it has taken.
-- Additive + backfill-safe: existing rows default to 0.
ALTER TABLE feedback_request ADD COLUMN IF NOT EXISTS reopened_count integer NOT NULL DEFAULT 0;

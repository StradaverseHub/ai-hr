-- ADR-0049 §2 — Recruiting Partner ships WITH the recruitment (ATS) tables, never as an inert label.
--
-- The enum value ONLY. Everything that grants it authority is in 4401, the same split as 0610/0611:
-- an enum label added by ALTER TYPE cannot be USED (cast, compared as ::role, inserted) until the
-- transaction that added it commits, and drizzle's migrator runs every pending migration inside ONE
-- transaction, so 4401 references the label only as TEXT (has_role_for takes text; the role allow-lists
-- are text CHECK constraints and text comparisons), never as a ::role literal.
--
-- Irreversible once released (Postgres has no DROP VALUE); ADR-0049 §2 accepted that for the ATS PR.
ALTER TYPE "role" ADD VALUE IF NOT EXISTS 'recruiting_partner';

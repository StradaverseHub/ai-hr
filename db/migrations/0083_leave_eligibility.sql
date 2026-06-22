-- ADR-0038 2A-1: leave eligibility engine. Self-declared person gender + marital status (gate maternity/
-- paternity), and a per-leave-type eligibility rule. All additive + backfill-safe (existing rows null =
-- unknown / open to all). person.gender + marital_status follow the same low-risk-personal-field path as
-- address/date_of_birth (self-edit on /me, RLS-confined).
ALTER TABLE person ADD COLUMN gender text;--> statement-breakpoint
ALTER TABLE person ADD COLUMN marital_status text;--> statement-breakpoint
ALTER TABLE leave_type ADD COLUMN eligibility jsonb;

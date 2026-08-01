-- ADR-0077 slice 5, step 1 of N — the COUNTRY dimension on leave_type.
--
-- WHY THIS SHIPS BEFORE ANY SECOND PACK EXISTS. leave_type carries generic codes ('ANNUAL', 'SICK')
-- seeded by the country pack. Today one pack (MY) owns them, so `(tenant_id, lower(code))` is unique
-- enough. The moment a second pack seeds its own 'ANNUAL' for the same tenant, that index rejects it —
-- a legitimate SG row refused because a MY row already holds the code. The dimension lands ONCE, now,
-- rather than being retrofitted under a live second pack.
--
-- INERT ON ARRIVAL: every existing row is 'MY', and with a single country the new index constrains
-- exactly what the old one did. No behaviour changes today.
--
-- THE DEFAULT IS DELIBERATE, and the index is what makes it safe. A second-country seeder that forgets
-- to set country does NOT silently write an 'MY' row: it collides with the existing MY row on
-- (tenant_id, 'MY', lower(code)) and the insert FAILS. Loud, at the first attempt, rather than a
-- mis-attributed row nobody notices. Keeping the default also avoids making `country` a required field
-- at ~30 existing insert sites for a value every one of them means.
ALTER TABLE leave_type ADD COLUMN country text NOT NULL DEFAULT 'MY';
--> statement-breakpoint
-- 0031's index, replaced rather than supplemented: leaving both would re-impose the cross-country
-- collision the new one exists to remove.
DROP INDEX IF EXISTS leave_type_tenant_code_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX leave_type_tenant_country_code_uq
  ON leave_type (tenant_id, country, lower(code))
  WHERE archived_at IS NULL;

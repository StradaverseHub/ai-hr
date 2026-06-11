-- Leave-type code integrity (follow-up to 0030): the code is free text but semantically
-- load-bearing — the statutory floor (entitlement(code)), standing grants on hire, and the
-- year-boundary carry-forward all key on exact uppercase codes. A tenant creating 'annual'
-- would silently get no EA-1955 floor. Service layer now uppercases/validates; DB backstops:

UPDATE leave_type SET code = upper(btrim(code)), name = btrim(regexp_replace(name, '\s+', ' ', 'g'));--> statement-breakpoint
CREATE UNIQUE INDEX leave_type_tenant_code_uq ON leave_type (tenant_id, lower(code)) WHERE archived_at IS NULL;--> statement-breakpoint
ALTER TABLE leave_type ADD CONSTRAINT leave_type_code_shape CHECK (code ~ '^[A-Z][A-Z0-9_]{1,31}$');

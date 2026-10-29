-- Extend the existing owner; preserve key identity, RLS, grants, uniqueness and immutable history.
-- Android has no Apple environment or monotonic assertion counter. Its encrypted receipt stores
-- the original bounded certificate proof for audit/status recovery, never an Android private key.
ALTER TABLE mobile_integrity_key DROP CONSTRAINT mobile_integrity_key_platform_check;
ALTER TABLE mobile_integrity_key DROP CONSTRAINT mobile_integrity_key_app_id_check;
ALTER TABLE mobile_integrity_key DROP CONSTRAINT mobile_integrity_key_proof_kind_check;
ALTER TABLE mobile_integrity_key ALTER COLUMN environment DROP NOT NULL;
ALTER TABLE mobile_integrity_key ADD CONSTRAINT mobile_integrity_key_platform_check CHECK(platform IN ('ios','android'));
ALTER TABLE mobile_integrity_key ADD CONSTRAINT mobile_integrity_key_app_id_check CHECK(length(app_id) BETWEEN 3 AND 300);
ALTER TABLE mobile_integrity_key ADD CONSTRAINT mobile_integrity_key_proof_kind_check
 CHECK(proof_kind IN ('apple_key_proof','apple_app_metadata','google_key_generation_proof'));
--> statement-breakpoint
ALTER TABLE mobile_integrity_key ADD CONSTRAINT mobile_integrity_key_platform_evidence_check CHECK(
 (platform='ios' AND environment IS NOT NULL AND length(app_id)>=12
  AND proof_kind IN ('apple_key_proof','apple_app_metadata'))
 OR
 (platform='android' AND environment IS NULL AND proof_kind='google_key_generation_proof'
  AND assertion_counter=0 AND metadata IS NOT NULL AND jsonb_typeof(metadata)='object')
);

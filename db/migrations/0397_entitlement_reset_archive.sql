-- 6e9a126e RELEASE ONE — the written record of everything the reset will clear.
--
-- The approved plan promises the reporter, in these words: "you read the old figures off that record
-- while you retype them". The clearing is irreversible, and the completeness of this record is the ONLY
-- promise the clearing makes. So the table lands NOW, in release one, before any clearing capability
-- exists — and 0398 takes the first capture immediately.
--
-- ⚠️ IT COPIES leave_shared_group_reset_archive's TABLE SHAPE, NOT ITS ZERO-READER POSTURE.
-- That table (0342) is documented as never read, never joined, written once — and
-- test/shared-leave-group-single-mechanism.test.ts actively asserts that no core file reads it. As a
-- precedent for "denormalise it to text so it stays readable" it is exactly right; as a precedent for
-- what the reporter is allowed to DO with it, it is exactly the gap this item must not repeat. This one
-- has a reader: a read-only admin listing with a CSV download at /admin/leave/entitlements/archive.
--
-- ONE table for BOTH cleared layers, discriminated by `layer`, rather than two. The reporter reads one
-- list, and a single capture transaction cannot half-succeed across two tables. The policy side is NOT
-- optional: 67 leave_policy rows are HALF of what release three clears, and revision 3 of the plan left
-- them out of the archive entirely.
--
-- EVERY COLUMN IS TEXT. The point of the table is that it survives the DROP of everything it describes,
-- so it holds no ids and no joins — names, figures and dates, rendered.

CREATE TABLE IF NOT EXISTS entitlement_reset_archive (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  captured_at timestamptz NOT NULL DEFAULT now(),
  -- Which capture run wrote this row. The archive is RE-captured immediately before the reset (release
  -- three), because configuration can move between now and then. Without a tag the listing would silently
  -- interleave two snapshots taken months apart and the reporter would retype a mixture of both.
  capture_tag text NOT NULL,
  -- 'scheme' (benefit_scheme × scheme_leave_entitlement) | 'policy' (leave_policy).
  layer text NOT NULL,
  scheme_name text,
  scheme_category text,
  leave_type_name text,
  leave_type_code text,
  -- NULL on the policy side means the GROUP DEFAULT (all companies), which the listing renders as such
  -- rather than leaving blank — a blank cell reads as missing data, and this record's job is to be read.
  company_name text,
  scheme_grade_group_name text,
  -- The grades inside that group at capture time. grade_group SURVIVES the reset, but the record still
  -- has to say who the table actually reached, or "Grade 12-15 Permanent" is a name with no members.
  scheme_grade_group_members text,
  grade_name text,
  employment_type text,
  -- THE POINT OF THE TABLE: the figures, rendered readable. Scheme side = the band table written out.
  -- Policy side = the accrual figures written out.
  entitlement_text text,
  -- The scheme layer is UNDATED — it has no valid_from/valid_to at all — so the scheme side records that
  -- honestly rather than inventing a window it never had.
  valid_from_text text,
  valid_to_text text,
  note text
);
--> statement-breakpoint

ALTER TABLE entitlement_reset_archive DROP CONSTRAINT IF EXISTS entitlement_reset_archive_layer_check;
--> statement-breakpoint
ALTER TABLE entitlement_reset_archive ADD CONSTRAINT entitlement_reset_archive_layer_check
  CHECK (layer IN ('scheme', 'policy'));
--> statement-breakpoint

ALTER TABLE entitlement_reset_archive DROP CONSTRAINT IF EXISTS entitlement_reset_archive_tag_check;
--> statement-breakpoint
ALTER TABLE entitlement_reset_archive ADD CONSTRAINT entitlement_reset_archive_tag_check
  CHECK (btrim(capture_tag) <> '');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entitlement_reset_archive_tenant_idx
  ON entitlement_reset_archive (tenant_id, capture_tag);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entitlement_reset_archive_layer_idx
  ON entitlement_reset_archive (tenant_id, layer);
--> statement-breakpoint

-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────────────────
-- Stated explicitly rather than inherited from ALTER DEFAULT PRIVILEGES — see 0396's note.
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement_reset_archive" TO ai_hr_app;
--> statement-breakpoint

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
-- ADMIN-ONLY, on BOTH halves — deliberately NARROWER than the config tables it describes.
-- The rows are a full dump of the tenant's entitlement configuration: every scheme, every band table,
-- every company and grade banding. An ordinary employee has no reason to read the whole organisation's
-- pay-adjacent configuration, and unlike leave_policy this table is never resolved on anybody's behalf —
-- nothing but the admin listing reads it. So the read half is gated too.
ALTER TABLE entitlement_reset_archive ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS entitlement_reset_archive_rls ON "entitlement_reset_archive";
--> statement-breakpoint
CREATE POLICY entitlement_reset_archive_rls ON "entitlement_reset_archive" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());

-- Board 4197534a (27 November 2026): Overtime Patterns, one Pattern Code for many companies through Eligibility.
-- Reserved in docs/MIGRATION-ALLOCATION.md (journal index 11020, when 1795495007620).
--
-- overtime_pattern_version.planned_eligibility holds a draft's Eligibility step until the pattern is activated:
--   {"v":1,"criteria":{"<field>":["<id or value>",...]},"employmentIds":["<employment id>",...],"priority":100,"from":"YYYY-MM-DD"}
-- Activation (packs/attendance/overtime-patterns.ts activateOvertimePatternWithEligibility) turns it into ordinary
-- overtime_pattern_assignment rows in the same transaction; the assignment rows remain the only thing the overtime
-- calculation reads. The company set stays in overtime_pattern_version_company.
--
-- Nullable with no default because the table is populated (docs/SCALE-AND-RELEASE-RULES.md rule 10): every existing
-- version reads NULL ("no planned eligibility"). The only writers of overtime_pattern_version are the overtime pack's
-- draft save, fork and activation (packs/attendance/overtime-patterns.ts) and the operator consolidation data script
-- (scripts/data/overtime-pattern-consolidate.ts); none writes the column before this migration. Existing rows satisfy
-- the CHECK (NULL), so validating it on install only reads the table.
--
-- Covered by the version's existing row security and grants (no new table, policy or grant). The 0551 guard trigger
-- already makes an activated version immutable, which covers this column. A new BEFORE trigger validates the ids
-- inside it with the same reference check the definition and assignment targets use (app.check_overtime_references):
-- every Personnel/Attendance id named must belong to the version's tenant.
--
-- No existing function, policy, column or row changes. Rollback (before any value is written):
--   DROP TRIGGER overtime_pattern_version_planned_eligibility_refs ON public.overtime_pattern_version;
--   DROP FUNCTION app.check_overtime_planned_eligibility();
--   ALTER TABLE public.overtime_pattern_version DROP COLUMN planned_eligibility;
ALTER TABLE public.overtime_pattern_version ADD COLUMN planned_eligibility jsonb;
--> statement-breakpoint
ALTER TABLE public.overtime_pattern_version ADD CONSTRAINT overtime_pattern_version_planned_eligibility_ck
 CHECK(planned_eligibility IS NULL OR (jsonb_typeof(planned_eligibility)='object' AND octet_length(planned_eligibility::text)<=262144
  AND jsonb_typeof(coalesce(planned_eligibility->'criteria','{}'::jsonb))='object'
  AND jsonb_typeof(coalesce(planned_eligibility->'employmentIds','[]'::jsonb))='array'));
--> statement-breakpoint
CREATE FUNCTION app.check_overtime_planned_eligibility() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE doc jsonb;
BEGIN
 IF NEW.planned_eligibility IS NULL THEN RETURN NEW;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(coalesce(NEW.planned_eligibility->'criteria','{}'::jsonb)) c WHERE jsonb_typeof(c.value)<>'array') THEN
  RAISE EXCEPTION 'Planned overtime eligibility criteria must be lists' USING ERRCODE='23514';
 END IF;
 SELECT jsonb_build_object('children',coalesce(jsonb_agg(jsonb_build_object('type','selection','field',c.key,'values',c.value)),'[]'::jsonb)
   ||jsonb_build_array(jsonb_build_object('type','selection','field','employmentId','values',coalesce(NEW.planned_eligibility->'employmentIds','[]'::jsonb))))
  INTO doc FROM jsonb_each(coalesce(NEW.planned_eligibility->'criteria','{}'::jsonb)) c;
 PERFORM app.check_overtime_references(NEW.tenant_id,doc);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.check_overtime_planned_eligibility() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER overtime_pattern_version_planned_eligibility_refs BEFORE INSERT OR UPDATE OF planned_eligibility ON public.overtime_pattern_version
 FOR EACH ROW EXECUTE FUNCTION app.check_overtime_planned_eligibility();

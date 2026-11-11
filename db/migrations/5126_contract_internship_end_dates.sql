-- UNALLOCATED DRAFT (board 2260a06b, contract and internship end dates, 11 November 2026). Final tag, idx and when are
-- assigned above the freshly verified ledger at integration (docs/MIGRATION-ALLOCATION.md). No table, column or data change.
--
-- 1. Employment Movement Field Controls may name the two end dates. The employment columns already exist
--    (contract_end_date 0110/0388, internship_end_date 0110); only the rule vocabulary CHECK widens. The table holds a
--    few rows per tenant and every existing row satisfies the wider list, so the validating re-add is short.
ALTER TABLE "movement_type_field_rule" DROP CONSTRAINT "movement_type_field_rule_field_check";--> statement-breakpoint
ALTER TABLE "movement_type_field_rule" ADD CONSTRAINT "movement_type_field_rule_field_check" CHECK ("field" IN (
	'companyId','businessUnitId','departmentId','positionId','gradeId','employmentType','locationId',
	'managerEmploymentId','basicSalary','currency','payMode','paymentTerm','orgDivision','employmentCategory',
	'orgRegion','orgBranch','orgTeam','orgSection','orgLine','orgBase','contractEndDate','internshipEndDate'));--> statement-breakpoint
-- 2. Is a Contract Management case for this employment still open? Contract dates change through that case while it
--    runs (records_pending writes them under its own protected intent), so the Personnel profile, Movement and
--    Information-Only Correction refuse a contract date change and point HR to the renewal. Read-only boolean about one
--    employment of the CURRENT tenant; callers have already proved workforce.maintain on that employment. A case is
--    open until it is renewed, handed off or cancelled, the same terminal set contract_create_case uses.
CREATE FUNCTION app.contract_renewal_open(wanted_employment uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_case c WHERE c.tenant_id=app.current_tenant_id() AND c.employment_id=wanted_employment
  AND c.data->>'state' NOT IN('renewed','handed_off','cancelled')); $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_renewal_open(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.contract_renewal_open(uuid) TO ai_hr_app;

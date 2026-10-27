-- P1 WP-G: the reward calendar. One row per (reward cycle, company): the date each annual approval step is
-- due, the ER/PIP case-decision due date, and the off-cycle service levels in days. Every column is
-- optional: an unset date means "no due date", never a guessed one. The calendar only DISPLAYS deadlines;
-- it never moves, blocks or approves a review (ADR-0099 approval order is unchanged).
CREATE TABLE reward_calendar (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 cycle_id uuid NOT NULL, company_id uuid NOT NULL,
 bu_due date, returned_due date, bg_due date, gr_due date, ctro_due date, ec_due date, payroll_due date,
 case_due date,
 offcycle_bg_days smallint CHECK(offcycle_bg_days BETWEEN 1 AND 90),
 offcycle_gr_days smallint CHECK(offcycle_gr_days BETWEEN 1 AND 90),
 offcycle_ctro_days smallint CHECK(offcycle_ctro_days BETWEEN 1 AND 90),
 offcycle_ec_days smallint CHECK(offcycle_ec_days BETWEEN 1 AND 90),
 offcycle_returned_days smallint CHECK(offcycle_returned_days BETWEEN 1 AND 90),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,cycle_id) REFERENCES reward_cycle(tenant_id,id),
 FOREIGN KEY(company_id,tenant_id) REFERENCES company(id,tenant_id),
 UNIQUE(tenant_id,cycle_id,company_id)
);
--> statement-breakpoint
-- Read: a company HR administrator, or anyone holding a Reward Desk seat on a live review of this cycle in
-- this company. Write: a company HR administrator, or the Group Rewards seat on such a review.
CREATE FUNCTION app.reward_calendar_access(wanted_cycle uuid, wanted_company uuid, writer boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.reward_admin(wanted_company) OR EXISTS(
  SELECT 1 FROM reward_unit r CROSS JOIN LATERAL app.reward_roles(r.id) AS seat(role)
  WHERE r.tenant_id=app.current_tenant_id() AND r.cycle_id=wanted_cycle AND r.company_id=wanted_company AND r.deleted_at IS NULL
   AND (NOT writer OR seat.role='gr'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_calendar_access(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_calendar_access(uuid,uuid,boolean) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE reward_calendar ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY reward_calendar_read ON reward_calendar FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_calendar_access(cycle_id,company_id,false));
CREATE POLICY reward_calendar_insert ON reward_calendar FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND updated_by=app.current_user_id() AND app.reward_calendar_access(cycle_id,company_id,true));
CREATE POLICY reward_calendar_update ON reward_calendar FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.reward_calendar_access(cycle_id,company_id,true)) WITH CHECK(tenant_id=app.current_tenant_id() AND updated_by=app.current_user_id() AND app.reward_calendar_access(cycle_id,company_id,true));
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON reward_calendar TO ai_hr_app;

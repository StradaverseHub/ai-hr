-- Leave Year Edit/Delete (dcd8e32f) — close the DELETE hole in leave_year_config RLS.
--
-- 0190's policy is FOR ALL: Postgres applies its WITH CHECK (tenant match AND app.is_admin()) to
-- INSERT/UPDATE only. DELETE is gated by USING alone, which carries no is_admin() term — so ANY
-- authenticated tenant member could hard-delete a leave-year record (DELETE is granted to ai_hr_app
-- since 0190, and deleteLeaveYearAction was reachable as a POST endpoint). Mirrors the 0277
-- compensation fix: permissive policies OR together, so a second permissive policy could not close
-- the hole — a RESTRICTIVE policy ANDs with the existing FOR ALL one, making DELETE additionally
-- require the admin branch. Reads / inserts / updates are unchanged. The service layer re-asserts
-- the same rule (assertAdmin in deleteLeaveYear) with a friendlier message first.
CREATE POLICY leave_year_config_delete_admin ON leave_year_config AS RESTRICTIVE FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND app.is_admin());

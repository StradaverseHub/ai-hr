-- Keep the 0515 set-based visibility invariant for the four board policies introduced by
-- 0547, 0548 and 0551. Only can_see_employment(X) changes to its proven equivalent set
-- membership. The scalar SELECT plus uuid[] cast makes the set an InitPlan; tenant fences,
-- workflow-v2 readers, administrator/payroll arms and all write policies remain unchanged.
ALTER POLICY replacement_holiday_read ON public.replacement_holiday
 USING(tenant_id=app.current_tenant_id() AND employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]));
--> statement-breakpoint
ALTER POLICY replacement_holiday_revision_read ON public.replacement_holiday_revision
 USING(tenant_id=app.current_tenant_id() AND employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]));
--> statement-breakpoint
ALTER POLICY attendance_workflow_reassignment_read ON public.attendance_workflow_reassignment
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=request_id AND (w.employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) OR app.attendance_workflow_v2_read(w.correction_id))));
--> statement-breakpoint
ALTER POLICY overtime_assignment_employment_read ON public.overtime_pattern_assignment_employment
 USING(tenant_id=app.current_tenant_id() AND(app.is_admin() OR employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]) OR app.can_admin_payroll_employment(employment_id)));

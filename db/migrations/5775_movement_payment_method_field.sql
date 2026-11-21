-- Board 8cff7fef: dated Payment Method shares the configured comparison grid and pay-document privacy.
ALTER TABLE "movement_type_field_rule" DROP CONSTRAINT "movement_type_field_rule_field_check";--> statement-breakpoint
ALTER TABLE "movement_type_field_rule" ADD CONSTRAINT "movement_type_field_rule_field_check" CHECK ("field" IN (
  'companyId','businessUnitId','departmentId','positionId','gradeId','employmentType','locationId','managerEmploymentId','basicSalary','currency','payMode','paymentTerm','paymentMethod','orgDivision','employmentCategory','orgRegion','orgBranch','orgTeam','orgSection','orgLine','orgBase','contractEndDate','internshipEndDate','confirmationDate','probationValue','probationUnit','extendedProbationValue','extendedProbationUnit','noticeBeforeConfirmationValue','noticeBeforeConfirmationUnit','noticeAfterConfirmationValue','noticeAfterConfirmationUnit'));--> statement-breakpoint
ALTER TABLE "movement_attachment" DROP CONSTRAINT "movement_attachment_field_check";--> statement-breakpoint
ALTER TABLE "movement_attachment" ADD CONSTRAINT "movement_attachment_field_check" CHECK ("field" IN (
  'companyId','businessUnitId','departmentId','positionId','gradeId','employmentType','locationId','managerEmploymentId','basicSalary','currency','payMode','paymentTerm','paymentMethod','orgDivision','employmentCategory','orgRegion','orgBranch','orgTeam','orgSection','orgLine','orgBase','contractEndDate','internshipEndDate','confirmationDate','probationValue','probationUnit','extendedProbationValue','extendedProbationUnit','noticeBeforeConfirmationValue','noticeBeforeConfirmationUnit','noticeAfterConfirmationValue','noticeAfterConfirmationUnit'));--> statement-breakpoint

DROP POLICY movement_attachment_read ON movement_attachment;--> statement-breakpoint
DROP POLICY movement_attachment_insert ON movement_attachment;--> statement-breakpoint
CREATE POLICY "movement_attachment_read" ON "movement_attachment" FOR SELECT
  USING (
    tenant_id = app.current_tenant_id()
    AND app.access_workforce_employment(employment_id, 'workforce.view')
    AND (
      field NOT IN ('basicSalary', 'currency', 'payMode', 'paymentTerm', 'paymentMethod')
      OR app.can_admin_employment(employment_id)
      OR app.can_admin_perfcomp_employment(employment_id)
      OR app.can_admin_payroll_employment(employment_id)
    )
  );--> statement-breakpoint
CREATE POLICY "movement_attachment_insert" ON "movement_attachment" FOR INSERT
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND app.is_admin()
    AND app.access_workforce_employment(employment_id, 'workforce.maintain')
    AND (
      field NOT IN ('basicSalary', 'currency', 'payMode', 'paymentTerm', 'paymentMethod')
      OR app.can_admin_employment(employment_id)
      OR app.can_admin_perfcomp_employment(employment_id)
    )
  );--> statement-breakpoint

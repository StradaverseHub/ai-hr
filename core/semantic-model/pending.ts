/** Agent action registry entries not yet declared in the semantic model. SHRINK ONLY: a new registry action
 * must be declared in ./entities.ts, never added here (test/semantic-model-drift.test.ts fails otherwise).
 * Remove an id from this list in the same change that declares it. */
export const NOT_YET_MODELLED_ACTIONS:readonly string[]=Object.freeze([
 'employees.import','org.position.archive','org.department.archive','org.employee_id_template.status','org.people_general.change','org.reporting.change',
 'leave.edit','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide','knowledge_base.article.create',
 'payroll.close','payroll.reopen','payroll.reset','claims.draft.save',
 'performance.checkin.cancel','performance.checkin.complete','performance.checkin.schedule','performance.goal.approve','performance.review.acknowledge',
 'performance.onehr.plan.acknowledge','rewards.post','rewards.cancel_review','rewards.calendar.update','lifecycle.offboarding.step.complete',
 'lifecycle.offboarding.step.undo','lifecycle.offboarding.case.cancel','rewards.annual_review.return','lifecycle.acknowledgement.submit','toil.replacement.request',
 'multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save',
 'leave.adjustment.apply','employees.movement.transfer','employees.compensation.maintain','attendance.schedule_group.maintain','employees.profile_request.reject',
 'attendance.day_schedule.correct','employees.code.maintain','employees.workforce_profile.maintain','employees.bank.maintain','employees.document_metadata.maintain',
 'employees.fixed_item.archive','employees.cost_allocation.maintain','employees.payment_method.maintain','employees.tp3_opening.maintain','employees.passport.maintain',
 'employees.emergency_contact.maintain','employees.family.maintain','employees.qualification.maintain','employees.draft.discard','employees.draft.activate',
 'toil.credit.grant','approvals.claim.chase','approvals.attendance.chase','approvals.toil.chase','employees.review_overdue.remind','attendance.missing_clock.remind',
 'employees.passport_expiry.remind','lifecycle.step.chase',
]);

# Complete AI Centre function inventory

Source checkpoint: `df1199a7c44d1ff44879e30bdb8bf2fafb91639d` (7 November 2026).

This inventory contains **251 registered rows**: 115 using existing feature/action/worker/learning controls, 125 independent read/preparation/module restrictions, one platform configuration entry and ten required services. The independent restrictions include 56 explicitly named operations. Counts describe registered controls, not 251 separate autonomous workers or proof of a staffing reduction.

Administration → Workers is the control entry point. A group administrator can stop all AI, resume eligible future work, and configure the independent functions. Existing feature, worker, action, recurring-job and payroll-learning switches retain their own owners. A child switch narrows these permissions; turning it on cannot enable a module, grant access or raise a budget. Platform feedback planning has its own `read:operation_feedback_plan` workload restriction. Shared schedulers and mandatory validation/privacy/audit/retention stay available; their optional AI jobs are controlled individually.

Stop-all prevents fresh admission and later AI-authorized results/writes after the stop commits. Stop followed by resume invalidates the older request generation. Previously authorized external traffic may already be in flight; its actual or uncertain outcome and usage must still be settled. Cached viewing and manual HR remain governed by their native permissions.

The list was emitted by the actual inventory owner during [hosted checks 42358642517](https://github.com/StradaverseHub/ai-hr/actions/runs/42358642517): seven files and 120 assertions passed, including all 41 new operation boundaries with their own switch off and with stop-all. It does not report any tenant's current settings, candidate installation or acceptance. Canonical metadata remains in `core/ai-centre-inventory.ts`; the listed operation entry points come from `lib/ai/centre-operations.ts`.

| Stable function key | Function | Control owner | Entry point or settings |
| --- | --- | --- | --- |
| `action:approvals.attendance.chase` | approvals.attendance.chase | Existing switch owner | `/control-tower/agents/features#ai-component-action-approvals-attendance-chase` |
| `action:approvals.attendance.decide` | approvals.attendance.decide | Existing switch owner | `/control-tower/agents/features#ai-component-action-approvals-attendance-decide` |
| `action:approvals.claim.chase` | approvals.claim.chase | Existing switch owner | `/control-tower/agents/features#ai-component-action-approvals-claim-chase` |
| `action:approvals.claim.decide` | approvals.claim.decide | Existing switch owner | `/control-tower/agents/features#ai-component-action-approvals-claim-decide` |
| `action:approvals.leave.decide` | approvals.leave.decide | Existing switch owner | `/control-tower/agents/features#ai-component-action-approvals-leave-decide` |
| `action:approvals.toil.chase` | approvals.toil.chase | Existing switch owner | `/control-tower/agents/features#ai-component-action-approvals-toil-chase` |
| `action:approvals.toil.decide` | approvals.toil.decide | Existing switch owner | `/control-tower/agents/features#ai-component-action-approvals-toil-decide` |
| `action:attendance.correction.request` | attendance.correction.request | Existing switch owner | `/control-tower/agents/features#ai-component-action-attendance-correction-request` |
| `action:attendance.day_schedule.correct` | attendance.day_schedule.correct | Existing switch owner | `/control-tower/agents/features#ai-component-action-attendance-day_schedule-correct` |
| `action:attendance.missing_clock.remind` | attendance.missing_clock.remind | Existing switch owner | `/control-tower/agents/features#ai-component-action-attendance-missing_clock-remind` |
| `action:attendance.overtime.request` | attendance.overtime.request | Existing switch owner | `/control-tower/agents/features#ai-component-action-attendance-overtime-request` |
| `action:attendance.schedule_group.maintain` | attendance.schedule_group.maintain | Existing switch owner | `/control-tower/agents/features#ai-component-action-attendance-schedule_group-maintain` |
| `action:claims.cancel` | claims.cancel | Existing switch owner | `/control-tower/agents/features#ai-component-action-claims-cancel` |
| `action:claims.draft.save` | claims.draft.save | Existing switch owner | `/control-tower/agents/features#ai-component-action-claims-draft-save` |
| `action:claims.submit` | claims.submit | Existing switch owner | `/control-tower/agents/features#ai-component-action-claims-submit` |
| `action:country-my.statutory.update` | country-my.statutory.update | Existing switch owner | `/control-tower/agents/features#ai-component-action-country-my-statutory-update` |
| `action:employees.bank.maintain` | employees.bank.maintain | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-bank-maintain` |
| `action:employees.code.maintain` | employees.code.maintain | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-code-maintain` |
| `action:employees.compensation.maintain` | employees.compensation.maintain | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-compensation-maintain` |
| `action:employees.cost_allocation.maintain` | employees.cost_allocation.maintain | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-cost_allocation-maintain` |
| `action:employees.document_metadata.maintain` | employees.document_metadata.maintain | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-document_metadata-maintain` |
| `action:employees.draft.activate` | employees.draft.activate | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-draft-activate` |
| `action:employees.draft.discard` | employees.draft.discard | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-draft-discard` |
| `action:employees.emergency_contact.maintain` | employees.emergency_contact.maintain | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-emergency_contact-maintain` |
| `action:employees.family.maintain` | employees.family.maintain | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-family-maintain` |
| `action:employees.fixed_item.archive` | employees.fixed_item.archive | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-fixed_item-archive` |
| `action:employees.import` | employees.import | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-import` |
| `action:employees.movement.transfer` | employees.movement.transfer | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-movement-transfer` |
| `action:employees.passport.maintain` | employees.passport.maintain | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-passport-maintain` |
| `action:employees.passport_expiry.remind` | employees.passport_expiry.remind | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-passport_expiry-remind` |
| `action:employees.payment_method.maintain` | employees.payment_method.maintain | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-payment_method-maintain` |
| `action:employees.profile_request.reject` | employees.profile_request.reject | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-profile_request-reject` |
| `action:employees.qualification.maintain` | employees.qualification.maintain | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-qualification-maintain` |
| `action:employees.review_overdue.remind` | employees.review_overdue.remind | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-review_overdue-remind` |
| `action:employees.tp3_opening.maintain` | employees.tp3_opening.maintain | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-tp3_opening-maintain` |
| `action:employees.workforce_profile.maintain` | employees.workforce_profile.maintain | Existing switch owner | `/control-tower/agents/features#ai-component-action-employees-workforce_profile-maintain` |
| `action:ess.profile.request` | ess.profile.request | Existing switch owner | `/control-tower/agents/features#ai-component-action-ess-profile-request` |
| `action:knowledge_base.article.create` | knowledge_base.article.create | Existing switch owner | `/control-tower/agents/features#ai-component-action-knowledge_base-article-create` |
| `action:leave.adjustment.apply` | leave.adjustment.apply | Existing switch owner | `/control-tower/agents/features#ai-component-action-leave-adjustment-apply` |
| `action:leave.apply` | leave.apply | Existing switch owner | `/control-tower/agents/features#ai-component-action-leave-apply` |
| `action:leave.cancel` | leave.cancel | Existing switch owner | `/control-tower/agents/features#ai-component-action-leave-cancel` |
| `action:leave.edit` | leave.edit | Existing switch owner | `/control-tower/agents/features#ai-component-action-leave-edit` |
| `action:lifecycle.acknowledgement.submit` | lifecycle.acknowledgement.submit | Existing switch owner | `/control-tower/agents/features#ai-component-action-lifecycle-acknowledgement-submit` |
| `action:lifecycle.offboarding.case.cancel` | lifecycle.offboarding.case.cancel | Existing switch owner | `/control-tower/agents/features#ai-component-action-lifecycle-offboarding-case-cancel` |
| `action:lifecycle.offboarding.step.complete` | lifecycle.offboarding.step.complete | Existing switch owner | `/control-tower/agents/features#ai-component-action-lifecycle-offboarding-step-complete` |
| `action:lifecycle.offboarding.step.undo` | lifecycle.offboarding.step.undo | Existing switch owner | `/control-tower/agents/features#ai-component-action-lifecycle-offboarding-step-undo` |
| `action:lifecycle.step.chase` | lifecycle.step.chase | Existing switch owner | `/control-tower/agents/features#ai-component-action-lifecycle-step-chase` |
| `action:multi_cycle_payroll.create_run` | multi_cycle_payroll.create_run | Existing switch owner | `/control-tower/agents/features#ai-component-action-multi_cycle_payroll-create_run` |
| `action:notifications.email_preferences.save` | notifications.email_preferences.save | Existing switch owner | `/control-tower/agents/features#ai-component-action-notifications-email_preferences-save` |
| `action:org.department.archive` | org.department.archive | Existing switch owner | `/control-tower/agents/features#ai-component-action-org-department-archive` |
| `action:org.employee_id_template.status` | org.employee_id_template.status | Existing switch owner | `/control-tower/agents/features#ai-component-action-org-employee_id_template-status` |
| `action:org.people_general.change` | org.people_general.change | Existing switch owner | `/control-tower/agents/features#ai-component-action-org-people_general-change` |
| `action:org.position.archive` | org.position.archive | Existing switch owner | `/control-tower/agents/features#ai-component-action-org-position-archive` |
| `action:org.reporting.change` | org.reporting.change | Existing switch owner | `/control-tower/agents/features#ai-component-action-org-reporting-change` |
| `action:payroll.close` | payroll.close | Existing switch owner | `/control-tower/agents/features#ai-component-action-payroll-close` |
| `action:payroll.reopen` | payroll.reopen | Existing switch owner | `/control-tower/agents/features#ai-component-action-payroll-reopen` |
| `action:payroll.reset` | payroll.reset | Existing switch owner | `/control-tower/agents/features#ai-component-action-payroll-reset` |
| `action:performance.checkin.cancel` | performance.checkin.cancel | Existing switch owner | `/control-tower/agents/features#ai-component-action-performance-checkin-cancel` |
| `action:performance.checkin.complete` | performance.checkin.complete | Existing switch owner | `/control-tower/agents/features#ai-component-action-performance-checkin-complete` |
| `action:performance.checkin.schedule` | performance.checkin.schedule | Existing switch owner | `/control-tower/agents/features#ai-component-action-performance-checkin-schedule` |
| `action:performance.goal.approve` | performance.goal.approve | Existing switch owner | `/control-tower/agents/features#ai-component-action-performance-goal-approve` |
| `action:performance.onehr.plan.acknowledge` | performance.onehr.plan.acknowledge | Existing switch owner | `/control-tower/agents/features#ai-component-action-performance-onehr-plan-acknowledge` |
| `action:performance.review.acknowledge` | performance.review.acknowledge | Existing switch owner | `/control-tower/agents/features#ai-component-action-performance-review-acknowledge` |
| `action:rewards.annual_review.return` | rewards.annual_review.return | Existing switch owner | `/control-tower/agents/features#ai-component-action-rewards-annual_review-return` |
| `action:rewards.calendar.update` | rewards.calendar.update | Existing switch owner | `/control-tower/agents/features#ai-component-action-rewards-calendar-update` |
| `action:rewards.cancel_review` | rewards.cancel_review | Existing switch owner | `/control-tower/agents/features#ai-component-action-rewards-cancel_review` |
| `action:rewards.post` | rewards.post | Existing switch owner | `/control-tower/agents/features#ai-component-action-rewards-post` |
| `action:system_testing.execution.save` | system_testing.execution.save | Existing switch owner | `/control-tower/agents/features#ai-component-action-system_testing-execution-save` |
| `action:toil.credit.grant` | toil.credit.grant | Existing switch owner | `/control-tower/agents/features#ai-component-action-toil-credit-grant` |
| `action:toil.replacement.request` | toil.replacement.request | Existing switch owner | `/control-tower/agents/features#ai-component-action-toil-replacement-request` |
| `action:typed_pay_components.create` | typed_pay_components.create | Existing switch owner | `/control-tower/agents/features#ai-component-action-typed_pay_components-create` |
| `feature:approval_chasers` | approval_chasers | Existing switch owner | `/control-tower/agents/features#ai-feature-approval_chasers` |
| `feature:claims_triage` | claims_triage | Existing switch owner | `/control-tower/agents/features#ai-feature-claims_triage` |
| `feature:clock_reminders` | clock_reminders | Existing switch owner | `/control-tower/agents/features#ai-feature-clock_reminders` |
| `feature:document_reminders` | document_reminders | Existing switch owner | `/control-tower/agents/features#ai-feature-document_reminders` |
| `feature:feedback_planning` | feedback_planning | Platform configuration; workload child below | `/control-tower/agents/features#ai-feature-feedback_planning` |
| `feature:hr_assistant` | hr_assistant | Existing switch owner | `/control-tower/agents/features#ai-feature-hr_assistant` |
| `feature:lifecycle_chasers` | lifecycle_chasers | Existing switch owner | `/control-tower/agents/features#ai-feature-lifecycle_chasers` |
| `feature:module_agent_evaluation` | module_agent_evaluation | Existing switch owner | `/control-tower/agents/features#ai-feature-module_agent_evaluation` |
| `feature:module_agent_planning` | module_agent_planning | Existing switch owner | `/control-tower/agents/features#ai-feature-module_agent_planning` |
| `feature:pay_rule_draft` | pay_rule_draft | Existing switch owner | `/control-tower/agents/features#ai-feature-pay_rule_draft` |
| `feature:payroll_explanation` | payroll_explanation | Existing switch owner | `/control-tower/agents/features#ai-feature-payroll_explanation` |
| `feature:payroll_hypotheses` | payroll_hypotheses | Existing switch owner | `/control-tower/agents/features#ai-feature-payroll_hypotheses` |
| `feature:performance_360` | performance_360 | Existing switch owner | `/control-tower/agents/features#ai-feature-performance_360` |
| `feature:performance_assistant` | performance_assistant | Existing switch owner | `/control-tower/agents/features#ai-feature-performance_assistant` |
| `feature:performance_calib` | performance_calib | Existing switch owner | `/control-tower/agents/features#ai-feature-performance_calib` |
| `feature:performance_idp` | performance_idp | Existing switch owner | `/control-tower/agents/features#ai-feature-performance_idp` |
| `feature:performance_pm` | performance_pm | Existing switch owner | `/control-tower/agents/features#ai-feature-performance_pm` |
| `feature:performance_review` | performance_review | Existing switch owner | `/control-tower/agents/features#ai-feature-performance_review` |
| `feature:performance_tc` | performance_tc | Existing switch owner | `/control-tower/agents/features#ai-feature-performance_tc` |
| `feature:personnel_import_mapping` | personnel_import_mapping | Existing switch owner | `/control-tower/agents/features#ai-feature-personnel_import_mapping` |
| `feature:provider_evaluation` | provider_evaluation | Existing switch owner | `/control-tower/agents/features#ai-feature-provider_evaluation` |
| `feature:readiness_reminders` | readiness_reminders | Existing switch owner | `/control-tower/agents/features#ai-feature-readiness_reminders` |
| `feature:report_insight` | report_insight | Existing switch owner | `/control-tower/agents/features#ai-feature-report_insight` |
| `feature:review_chasers` | review_chasers | Existing switch owner | `/control-tower/agents/features#ai-feature-review_chasers` |
| `learning:payroll` | Payroll history learning | Existing switch owner | `/control-tower/loops/payroll-cycle/settings` |
| `module:approvals` | approvals | Independent tenant restriction | `#ai-centre-functions` |
| `module:assistant` | assistant | Independent tenant restriction | `#ai-centre-functions` |
| `module:attendance` | attendance | Independent tenant restriction | `#ai-centre-functions` |
| `module:claims` | claims | Independent tenant restriction | `#ai-centre-functions` |
| `module:country-my` | country-my | Independent tenant restriction | `#ai-centre-functions` |
| `module:employees` | employees | Independent tenant restriction | `#ai-centre-functions` |
| `module:ess` | ess | Independent tenant restriction | `#ai-centre-functions` |
| `module:knowledge_base` | knowledge_base | Independent tenant restriction | `#ai-centre-functions` |
| `module:leave` | leave | Independent tenant restriction | `#ai-centre-functions` |
| `module:lifecycle` | lifecycle | Independent tenant restriction | `#ai-centre-functions` |
| `module:multi_cycle_payroll` | multi_cycle_payroll | Independent tenant restriction | `#ai-centre-functions` |
| `module:notifications` | notifications | Independent tenant restriction | `#ai-centre-functions` |
| `module:org` | org | Independent tenant restriction | `#ai-centre-functions` |
| `module:payroll` | payroll | Independent tenant restriction | `#ai-centre-functions` |
| `module:performance` | performance | Independent tenant restriction | `#ai-centre-functions` |
| `module:rewards` | rewards | Independent tenant restriction | `#ai-centre-functions` |
| `module:system_explorer` | system_explorer | Independent tenant restriction | `#ai-centre-functions` |
| `module:system_testing` | system_testing | Independent tenant restriction | `#ai-centre-functions` |
| `module:toil` | toil | Independent tenant restriction | `#ai-centre-functions` |
| `module:typed_pay_components` | typed_pay_components | Independent tenant restriction | `#ai-centre-functions` |
| `read:ai_quality_summary` | ai_quality_summary | Independent tenant restriction | `#ai-centre-functions` |
| `read:approval_queue` | approval_queue | Independent tenant restriction | `#ai-centre-functions` |
| `read:available_actions` | available_actions | Independent tenant restriction | `#ai-centre-functions` |
| `read:company_setup` | company_setup | Independent tenant restriction | `#ai-centre-functions` |
| `read:correction_controls_guidance` | correction_controls_guidance | Independent tenant restriction | `#ai-centre-functions` |
| `read:employee_profile` | employee_profile | Independent tenant restriction | `#ai-centre-functions` |
| `read:explain_attendance_day` | explain_attendance_day | Independent tenant restriction | `#ai-centre-functions` |
| `read:explain_claim_limit` | explain_claim_limit | Independent tenant restriction | `#ai-centre-functions` |
| `read:explain_leave_entitlement` | explain_leave_entitlement | Independent tenant restriction | `#ai-centre-functions` |
| `read:explain_pay_difference` | explain_pay_difference | Independent tenant restriction | `#ai-centre-functions` |
| `read:explain_payslip_statutory` | explain_payslip_statutory | Independent tenant restriction | `#ai-centre-functions` |
| `read:explain_why` | explain_why | Independent tenant restriction | `#ai-centre-functions` |
| `read:import_attendance_clockings` | import_attendance_clockings | Independent tenant restriction | `#ai-centre-functions` |
| `read:import_employee_records` | import_employee_records | Independent tenant restriction | `#ai-centre-functions` |
| `read:import_leave_balances` | import_leave_balances | Independent tenant restriction | `#ai-centre-functions` |
| `read:import_payroll_history` | import_payroll_history | Independent tenant restriction | `#ai-centre-functions` |
| `read:leave_entitlement_explain` | leave_entitlement_explain | Independent tenant restriction | `#ai-centre-functions` |
| `read:loops_overview` | loops_overview | Independent tenant restriction | `#ai-centre-functions` |
| `read:my_claim_statuses` | my_claim_statuses | Independent tenant restriction | `#ai-centre-functions` |
| `read:my_leave_balances` | my_leave_balances | Independent tenant restriction | `#ai-centre-functions` |
| `read:my_leave_requests` | my_leave_requests | Independent tenant restriction | `#ai-centre-functions` |
| `read:my_module_work` | my_module_work | Independent tenant restriction | `#ai-centre-functions` |
| `read:my_pay_change` | my_pay_change | Independent tenant restriction | `#ai-centre-functions` |
| `read:my_payroll_readiness` | my_payroll_readiness | Independent tenant restriction | `#ai-centre-functions` |
| `read:my_payslip_summary` | my_payslip_summary | Independent tenant restriction | `#ai-centre-functions` |
| `read:my_policy_handbook` | my_policy_handbook | Independent tenant restriction | `#ai-centre-functions` |
| `read:my_reporting_line` | my_reporting_line | Independent tenant restriction | `#ai-centre-functions` |
| `read:operation_architecture_advice` | Generate Job Architecture advice | Independent tenant restriction | `packs/job-architecture/owner.ts#generateArchitectureAdvice` |
| `read:operation_architecture_description` | Draft a job description | Independent tenant restriction | `packs/job-architecture/owner.ts#generateArchitectureAdvice` |
| `read:operation_architecture_outlier` | Explain an architecture outlier | Independent tenant restriction | `packs/job-architecture/owner.ts#generateArchitectureAdvice` |
| `read:operation_architecture_position` | Suggest a position mapping | Independent tenant restriction | `packs/job-architecture/owner.ts#generateArchitectureAdvice` |
| `read:operation_assistant_import` | Prepare an Assistant import file | Independent tenant restriction | `core/assistant-import.ts#prepareAssistantImport` |
| `read:operation_assistant_import_employee` | Prepare employee import data | Independent tenant restriction | `core/assistant-import.ts#prepareAssistantImport` |
| `read:operation_assistant_import_leave_bf` | Prepare leave bf import data | Independent tenant restriction | `core/assistant-import.ts#prepareAssistantImport` |
| `read:operation_assistant_import_leave_history` | Prepare leave history import data | Independent tenant restriction | `core/assistant-import.ts#prepareAssistantImport` |
| `read:operation_assistant_import_payroll_fixed` | Prepare payroll fixed import data | Independent tenant restriction | `core/assistant-import.ts#prepareAssistantImport` |
| `read:operation_assistant_import_payroll_history` | Prepare payroll history import data | Independent tenant restriction | `core/assistant-import.ts#prepareAssistantImport` |
| `read:operation_assistant_import_payroll_individual` | Prepare payroll individual import data | Independent tenant restriction | `core/assistant-import.ts#prepareAssistantImport` |
| `read:operation_career_plan` | Suggest a career plan | Independent tenant restriction | `packs/performance/onehr/career-draft-service.ts#suggestAssessmentCareerPlan` |
| `read:operation_competency_insight` | Generate competency insights | Independent tenant restriction | `packs/performance/onehr/competency-insight-service.ts#getAssessmentCompetencyInsight` |
| `read:operation_conversation_evaluation` | Evaluate a conversation strategy | Independent tenant restriction | `core/module-agent-releases.ts#evaluateConversationAgentCandidate` |
| `read:operation_development_goals` | Suggest development goals | Independent tenant restriction | `packs/performance/onehr/development-suggestion-service.ts#suggestAssessmentDevelopmentGoals` |
| `read:operation_domain_analysis` | Analyse an HR domain | Independent tenant restriction | `core/ai-domain-analysis.ts#generateDomainAnalysis` |
| `read:operation_feedback_plan` | Draft a feedback plan | Independent tenant restriction | `core/feedback.ts#generateFeedbackPlan` |
| `read:operation_human_planner_evaluation` | Evaluate a question planner | Independent tenant restriction | `core/module-agent-releases.ts#evaluateHumanQuestionPlannerCandidate` |
| `read:operation_human_question_plan` | Plan reads from a human question | Independent tenant restriction | `core/module-agent-releases.ts#proposeOwnModuleReadPlan` |
| `read:operation_idp_fit` | Explain development-plan fit | Independent tenant restriction | `packs/performance/onehr/idp-fit-service.ts#getAssessmentIdpFit` |
| `read:operation_manager_review_draft` | Draft a manager review | Independent tenant restriction | `core/performance.ts#draftManagerReview` |
| `read:operation_module_read_plan` | Run a reviewed module read plan | Independent tenant restriction | `core/module-agent-releases.ts#runGovernedModuleReadPlan` |
| `read:operation_pay_formula_draft` | Draft a pay formula | Independent tenant restriction | `core/pay-formula-ai.ts#draftPayFormula` |
| `read:operation_pay_rule_draft` | Draft a pay rule | Independent tenant restriction | `core/pay-rule-ai.ts#draftPayRule` |
| `read:operation_payroll_comparison` | Explain payroll comparisons | Independent tenant restriction | `core/ai-payroll-comparison-analysis.ts#generatePrivatePayrollComparisonAnalysis` |
| `read:operation_performance_admin` | Ask the Performance administrator assistant | Independent tenant restriction | `packs/performance/onehr/admin-agent-service.ts#askAssessmentAdmin` |
| `read:operation_performance_calibration` | Ask the calibration assistant | Independent tenant restriction | `packs/performance/onehr/calibration-conversation.ts#sendCalibrationMessage` |
| `read:operation_performance_career_commands` | Prepare career draft changes | Independent tenant restriction | `packs/performance/onehr/review-command-ai.ts#proposeCareerCommands` |
| `read:operation_performance_conversation` | Ask the Performance review assistant | Independent tenant restriction | `packs/performance/onehr/conversation.ts#sendReviewMessage` |
| `read:operation_performance_evidence_vision` | Read assessment images with AI | Independent tenant restriction | `packs/performance/onehr/evidence-reading.ts#readAssessmentFileTexts` |
| `read:operation_performance_feedback` | Ask the colleague feedback assistant | Independent tenant restriction | `packs/performance/onehr/feedback-conversation.ts#sendFeedbackMessage` |
| `read:operation_performance_guide` | Ask the Performance guide | Independent tenant restriction | `packs/performance/onehr/guide-service.ts#askPerformanceGuide` |
| `read:operation_performance_insight` | Generate Performance insights | Independent tenant restriction | `packs/performance/onehr/insight-service.ts#getAssessmentPerformanceInsight` |
| `read:operation_performance_journey_commands` | Prepare review and evidence draft changes | Independent tenant restriction | `packs/performance/onehr/review-command-ai.ts#proposeJourneyCommands` |
| `read:operation_performance_narrative` | Draft a Performance narrative | Independent tenant restriction | `packs/performance/onehr/ai.ts#draftOnehrNarrative` |
| `read:operation_performance_review_commands` | Prepare review draft changes | Independent tenant restriction | `packs/performance/onehr/review-command-ai.ts#proposeReviewCommands` |
| `read:operation_performance_rewrite` | Rewrite a Performance draft | Independent tenant restriction | `packs/performance/onehr/rewrite-service.ts#rewriteAssessmentField` |
| `read:operation_performance_setting_commands` | Prepare scorecard draft changes | Independent tenant restriction | `packs/performance/onehr/review-command-ai.ts#proposeSettingCommands` |
| `read:operation_performance_setting_suggestion` | Suggest a Performance scorecard | Independent tenant restriction | `packs/performance/onehr/review-command-ai.ts#proposeSettingSuggestion` |
| `read:operation_policy_values` | Read policy setting values with AI | Independent tenant restriction | `core/handbook/policies.ts#readPolicyValues` |
| `read:operation_potential_insight` | Generate potential insights | Independent tenant restriction | `packs/performance/onehr/potential-insight-service.ts#getAssessmentPotentialInsight` |
| `read:operation_prompt_evaluation` | Evaluate a read-plan prompt | Independent tenant restriction | `core/module-agent-releases.ts#evaluatePromptAgentCandidate` |
| `read:operation_prompt_synthetic_job` | Run a synthetic planned job | Independent tenant restriction | `core/module-agent-releases.ts#runPromptPlannedSyntheticJob` |
| `read:operation_provider_baseline` | Run a legacy provider baseline | Independent tenant restriction | `core/ai-provider-baseline.ts#runProviderBaseline` |
| `read:operation_provider_readiness` | Verify a provider candidate | Independent tenant restriction | `core/ai-provider-readiness.ts#evaluateProviderCandidate` |
| `read:operation_record_cycle` | Summarise a personal review cycle | Independent tenant restriction | `packs/performance/onehr/record-insight-service.ts#getAssessmentRecordInsight` |
| `read:operation_record_present` | Summarise the current personal record | Independent tenant restriction | `packs/performance/onehr/record-insight-service.ts#getAssessmentRecordInsight` |
| `read:operation_record_trend` | Summarise personal review trends | Independent tenant restriction | `packs/performance/onehr/record-insight-service.ts#getAssessmentRecordInsight` |
| `read:operation_report_spec_draft` | Draft a report | Independent tenant restriction | `core/report-ai.ts#draftReportSpec` |
| `read:operation_rewards_advice` | Generate a Rewards advisor suggestion | Independent tenant restriction | `packs/rewards/advisor.ts#generateRewardAdvisor` |
| `read:operation_specialist_evaluation` | Evaluate a canonical specialist | Independent tenant restriction | `core/module-agent-releases.ts#evaluateCanonicalSpecialistCandidate` |
| `read:operation_specialist_job` | Run a canonical specialist job | Independent tenant restriction | `core/module-agent-releases.ts#runGovernedSpecialistJob` |
| `read:operation_talent_insight` | Generate talent insights | Independent tenant restriction | `packs/performance/onehr/talent-insight-service.ts#getAssessmentTalentInsight` |
| `read:operation_workforce_analysis` | Analyse workforce trends | Independent tenant restriction | `core/ai-workforce-analysis.ts#generateWorkforceAnalysis` |
| `read:operation_written_performance` | Summarise written Performance remarks | Independent tenant restriction | `packs/performance/onehr/written-remarks-service.ts#getAssessmentWrittenRemarks` |
| `read:operation_written_potential` | Summarise written potential remarks | Independent tenant restriction | `packs/performance/onehr/written-remarks-service.ts#getAssessmentWrittenRemarks` |
| `read:operations_status` | operations_status | Independent tenant restriction | `#ai-centre-functions` |
| `read:orchestrator_observe` | Record readiness monitoring | Independent tenant restriction | `#ai-centre-functions` |
| `read:organisation_tagging_guidance` | organisation_tagging_guidance | Independent tenant restriction | `#ai-centre-functions` |
| `read:password_policy_guidance` | password_policy_guidance | Independent tenant restriction | `#ai-centre-functions` |
| `read:pay_aggregates` | pay_aggregates | Independent tenant restriction | `#ai-centre-functions` |
| `read:payroll_audit_status` | payroll_audit_status | Independent tenant restriction | `#ai-centre-functions` |
| `read:payroll_cycle_status` | payroll_cycle_status | Independent tenant restriction | `#ai-centre-functions` |
| `read:payroll_learning_status` | payroll_learning_status | Independent tenant restriction | `#ai-centre-functions` |
| `read:payroll_loop_settings` | payroll_loop_settings | Independent tenant restriction | `#ai-centre-functions` |
| `read:prepare_import` | prepare_import | Independent tenant restriction | `#ai-centre-functions` |
| `read:product_capabilities` | product_capabilities | Independent tenant restriction | `#ai-centre-functions` |
| `read:product_destinations` | product_destinations | Independent tenant restriction | `#ai-centre-functions` |
| `read:product_guidance` | product_guidance | Independent tenant restriction | `#ai-centre-functions` |
| `read:provider_connection_test` | provider_connection_test | Independent tenant restriction | `#ai-centre-functions` |
| `read:salary_payroll_checks` | salary_payroll_checks | Independent tenant restriction | `#ai-centre-functions` |
| `read:setup_copilot` | setup_copilot | Independent tenant restriction | `#ai-centre-functions` |
| `read:setup_readiness` | setup_readiness | Independent tenant restriction | `#ai-centre-functions` |
| `read:suggest_action` | suggest_action | Independent tenant restriction | `#ai-centre-functions` |
| `read:team_leave_summary` | team_leave_summary | Independent tenant restriction | `#ai-centre-functions` |
| `read:upcoming_holidays` | upcoming_holidays | Independent tenant restriction | `#ai-centre-functions` |
| `read:who_is_away` | who_is_away | Independent tenant restriction | `#ai-centre-functions` |
| `read:workforce_metrics` | workforce_metrics | Independent tenant restriction | `#ai-centre-functions` |
| `scheduled_job:ai-alerts` | ai-alerts | Required service; no AI off switch | `/admin/scheduled-actions` |
| `scheduled_job:ai-retention` | ai-retention | Required service; no AI off switch | `/admin/scheduled-actions` |
| `scheduled_job:payroll-loops` | payroll-loops | Required service; no AI off switch | `/admin/scheduled-actions` |
| `scheduled_job:review.sweep` | review.sweep | Required service; no AI off switch | `/admin/scheduled-actions` |
| `system:audit` | audit | Required service; no AI off switch | `/assistant?view=insights` |
| `system:capacity` | capacity | Required service; no AI off switch | `/assistant?view=insights` |
| `system:policies` | policies | Required service; no AI off switch | `/policies` |
| `system:privacy` | privacy | Required service; no AI off switch | `/assistant?view=privacy` |
| `system:quality` | quality | Required service; no AI off switch | `/assistant?view=insights` |
| `system:validation` | validation | Required service; no AI off switch | `/assistant?view=insights` |
| `worker:approval_chasers` | Approval chasers | Existing switch owner | `/control-tower/agents/features#ai-feature-approval_chasers` |
| `worker:approver_recommendation` | Approver recommendations | Existing switch owner | `/control-tower/agents/features#worker-approver_recommendation` |
| `worker:claims_triage` | Claims input triage | Existing switch owner | `/control-tower/agents/features#ai-feature-claims_triage` |
| `worker:clock_reminders` | Missing clock-in reminders | Existing switch owner | `/control-tower/agents/features#ai-feature-clock_reminders` |
| `worker:conversation` | Noveri conversation | Existing switch owner | `/control-tower/agents/features#worker-conversation` |
| `worker:daily_digest` | Daily digest | Existing switch owner | `/control-tower/agents/features#ai-centre-jobs` |
| `worker:document_reminders` | Passport expiry reminders | Existing switch owner | `/control-tower/agents/features#ai-feature-document_reminders` |
| `worker:explainers` | Explainers | Existing switch owner | `/control-tower/agents/features#worker-explainers` |
| `worker:lifecycle_chasers` | Lifecycle step chasers | Existing switch owner | `/control-tower/agents/features#ai-feature-lifecycle_chasers` |
| `worker:loop_document_expiry` | Passports expiring | Existing switch owner | `/control-tower/agents/features#worker-loop_document_expiry` |
| `worker:loop_missed_clock_outs` | Missed clock-outs | Existing switch owner | `/control-tower/agents/features#worker-loop_missed_clock_outs` |
| `worker:loop_missing_employee_data` | Missing employee data | Existing switch owner | `/control-tower/agents/features#worker-loop_missing_employee_data` |
| `worker:loop_payroll_audit` | Audit loop | Existing switch owner | `/control-tower/agents/features#worker-loop_payroll_audit` |
| `worker:loop_payroll_inputs` | Pre-salary loop | Existing switch owner | `/control-tower/agents/features#worker-loop_payroll_inputs` |
| `worker:loop_probation_ending` | Probation ending | Existing switch owner | `/control-tower/agents/features#worker-loop_probation_ending` |
| `worker:loop_salary_payroll` | Salary payroll loop | Existing switch owner | `/control-tower/agents/features#worker-loop_salary_payroll` |
| `worker:payroll_anomaly_narrator` | Payroll anomaly narrator | Existing switch owner | `/control-tower/agents/features#ai-feature-payroll_explanation` |
| `worker:readiness_nudges` | Readiness nudges | Existing switch owner | `/control-tower/agents/features#ai-feature-readiness_reminders` |
| `worker:review_chasers` | Employment review chasers | Existing switch owner | `/control-tower/agents/features#ai-feature-review_chasers` |
| `worker:team_absence_weekly_summary` | Weekly team absence summary | Existing switch owner | `/control-tower/agents/features#ai-centre-jobs` |

## Low-headcount operation

These controls reduce the need to supervise every AI step and allow a failing function to be isolated while unrelated work continues. A staffing target still needs a measured pilot: track human handling time, exception backlog and age, failed/retried work, payroll accuracy, response quality and provider cost over two payroll cycles. Keep named human owners for sensitive employment/pay/access decisions and escalation. The inventory and stop switch alone do not establish that the centre can safely run with a particular headcount.

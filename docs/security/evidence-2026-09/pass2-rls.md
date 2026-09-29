# Pass2 verify — per-table RLS completeness (VERDICT: isolation intact)
VERIFIED: 178/178 public base tables relrowsecurity=t; 0 tables RLS-off. 176/178 have >=1 policy.
RLS-on/0-policy: platform_user (forced) + tenant_suspension_window = deny-all; ai_hr_app has NO privileges on either (double-locked; tenant_suspension_window pinned by test).
Sensitive predicates all tenant AND per-subject (can_see_employment/can_see_person), NOT tenant-only: payslip, compensation, person, employee_statutory_my, employee_dependent, employee_document, employment, leave_request, feedback_request, domain_event (insert WITH CHECK tenant => no cross-tenant audit forging).
App role: ai_hr_app rolsuper=f rolbypassrls=f; owns 0 tables; member of no role => RLS enforced regardless of FORCE. Live probe: SET ROLE ai_hr_app + no tenant ctx => 0 rows (deny-by-default). postgres control => 9 rows.
GAP (LOW-MED): NO completeness guard test asserting every public table RLS-on + policy. Existing RLS tests are per-feature. Fix: add schema-drift test (relrowsecurity=false set empty; RLS-on/0-policy => 0 app grants w/ allowlist). Same class as rule 20 for the RLS axis.
=> REFUTES systemic RLS IDOR. Isolation SOLID.

# Personnel parity: activate a supported saved Draft

## Verified native effects

`app/admin/personnel/new/actions.ts#createDraftAction` calls `createEmployeeDraftWithReservedCode`: it reserves an employee ID and creates a Draft, not a person or employment. `saveDraftAction` calls `saveEmployeeDraft`. `createEmployeeAction` calls `saveAndCompleteEmployeeDraft`: it saves exact submitted input under the Draft lock and activates it inside an inner savepoint. On a business failure the normal wizard commits the attempted saved Draft and throws after commit, keeping all business effects rolled back.

Activation uses the native hire, country statutory, compensation, family, profile and payroll owners and emits `employee-draft.completed`. It removes the exact Draft only after those owners finish. The native actor is HR/admin under current company `workforce.maintain`, with tenant/company RLS and existing native validation. Hiring, pay and access are never Automatic.

## This increment

`employees.draft.activate` is Approve-tier, human-selected activation of an existing saved Draft. It reuses `createReviewCustody` and the SAME `app.assistant_own_leave_review` table, with company/Draft binding while no employment exists. The encrypted review contains only the chosen references and digest; HR source values remain at their native owner and in the local canonical review. No provider call is added.

Supported shapes are deliberately finite: an existing reserved employee code; profile name, work email, phone and ID mode; company, department, employment type and join date; explicit initial payroll salary, allowance, pay mode/term/rate and remarks. Every captured supported value is displayed, along with initial compensation defaults and standing leave types/consequences. A MY country pack is explicitly required for this reviewed subset. Bank, identity, passport, family, other profile/job values, unreserved legacy Drafts, incomplete inputs and unsupported countries remain native handoffs. No nonempty captured field is silently dropped. This is not complete hiring parity.

Preparation binds the full Draft data/version/reservation, current company and department, native employee ID rule, standing leave definitions, company payroll configuration, Criteria epoch and entitlement snapshot. Confirmation repeats the source interval before calling the SAME `saveAndCompleteEmployeeDraft` with an optional enclosing transaction. Default wizard behavior stays unchanged; the Assistant's enclosing custody transaction instead rolls back completely if activation fails, avoiding a hidden Draft-save success or a false hire receipt.

Completion requires an actual current-transaction `employee-draft.completed` event by this login, for this exact Draft and company, a newly written person/employment, matching reserved code, and removal of the original Draft. Recovery reads the exact original event and reopens the same review. It never blindly activates again. Completed person/employment privacy targets feed the existing native-outcome custody and erasure owners.

The legacy `createEmployeeAction` export remains `backlog:approve` because it accepts broader shapes. The new registry entry therefore has no export-level registration claim. Registered action availability and full callable-export parity remain different measurements.

## Provisional source allocation

0714_assistant_employee_draft_activation / idx695 / when1793330000043 is UNAPPLIED and provisional. It follows0713 only in this isolated source package, not as an installation priority. Reallocate at integration freeze above the then-live ordered accepted ledger. Historical SQL bytes remain unchanged.

## Evidence and limits

Authored native-service lifecycle, source/digest/country/reference, SQL receipt, late failure/atomic rollback, default-wizard savepoint preservation, role-matrix and UI recovery checks. Six locales carry the review copy, captured field labels and consent. CI-only renderer fixtures cover desktop/mobile. No local tests, compiler, build, DB or dev server were run. Runtime/type/rendered acceptance is unverified until parent freezes the reviewed exact40SHA on `alpha-focused-checks` with `run_typecheck=true`.

Installed Next.js documentation was not available in this dependency-free builder or the canonical main checkout. The new server page follows the current repository's awaited `searchParams` and existing Assistant access pattern; framework behavior remains for the exact-SHA compiler/renderer checks. No dependencies or local runtime were provisioned.

Release hold remains: no merges, main/alpha movement, staging/production deploys, release publication or PR101 release integration/full gate.

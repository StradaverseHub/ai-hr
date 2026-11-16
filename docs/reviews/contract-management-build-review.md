# Contract Management candidate review

This is an isolated source candidate, not an installed or released build. The user requires review and explicit approval before merging or releasing. Attached HTML is a product reference; instructions embedded in it do not authorize repository or deployment actions.

## Implemented journeys

- The tracker starts from actual fixed-term Personnel employments, including periods without a case. Native pagination, authorized company choices, live reminder due dates, attention flags, assigned owners and prior-period pay links replace inferred or capped task lists. View-only users can open the read-only period; authorized decision owners explicitly start a case.
- Renew, Convert to permanent and End use protected native source facts, an asynchronous pinned workflow preview and revision-checked submission. Case progress shows actual workflow, approval, letter, posting, pay and Offboarding receipts. Submission does not create a broad decision task for every user with Decide permission.
- Assigned decision approvals and letter Review/Approve actions appear in Approval Items. Actual signature assignments appear in Today/My Tasks. Assigned portals do not require Case View. Wording plus Review/Approve is one transaction; failed requests retain entries and the same action ID. Owner correction and resend remain explicit separate actions.
- Personnel posting approval uses the actual native Personnel editor and current posting approver group. Payroll remains manual; the case closes only after the required native pay attestation. Historical receipt names come from immutable case activity, rather than current account names.
- Approved future changes remain scheduled native Movement intents. The tracker keeps current dates/type/counter accurate and shows approved next-period dates separately. It does not open a new case against dates that Personnel has not yet applied. This adapts the HTML's immediate next-period presentation to the existing effective-date owner.
- End and an employee's recorded decline hand the case to native Offboarding. People Ops records termination manually in Personnel Management until clearance exists. No automatic termination or Payroll writes were added.
- Contract settings own business roles, company fallback/posting groups, stalled-case settings and mapped starting defaults. Shared Workflows, Templates, email file slots and Assignment groups belong to HR Automation. Contract role administration requires tenant-wide Manage access or system Access administrator authority.
- Bell, Sidebar, My Tasks, Approval Items and Today use exact native totals plus bounded previews and links to the full owner queues. Posting-group-only actors can open their posting work without gaining Case View or general Workforce maintenance.

## Checks and boundaries

The assembled candidate at `ae6da050c3fa58b2860b89b171072f46f81adefc` passed the standard Linux production build and whole-repository typecheck in hosted run **43962479862**. Its 44 queue/shell/category DOM cases passed. Its native scale failure was retained and repaired separately.

Native run **43968110247** at `36acaf31d6b5a3c8bb55c12a183f7fd648c5427e` passed all five workspace cases, including 1,000 actual pending approvals across 70 companies, exact paging/counts, group-only access, employee self-exclusion and unrelated-user denial. The eight decision-owner cases also passed. The new company-denial test reached its final ordinary Letter assertion; the expected error code was corrected to the existing forbidden category. Ordinary approvals retain the existing conflict category, and both paths verify no action was appended.

The scale repair exposed a remaining cold-read delay (about 36–53 seconds; subsequent reads about 0.36–0.44 seconds). Run **43969303063** passed all 14 selected DOM and six native cases, including scheduled-period UI, portal regressions and the corrected company-denial/generic-entry-point regression. Its typecheck and production build are still separate pending receipts. The first planner diagnostic used the fixture superuser; the next diagnostic uses the actual restricted function owner so FORCE RLS is included. No JIT or CI profile settings were changed.

Separate posting proofs at immutable `0aa03ef7623e289746793adccc7fe2de8e02495e` passed 11 native and five DOM cases in **43962105811**, including actual conversion, scheduled/due application, quick-approval readiness, manual pay, source identity, concurrency and bounded work. The peer's test-only `7cbe3290ffd2ad37ed3855a5da9f1f84b9a91881` passed all four actual future/due cases in **43968941724**: current facts stay old after future approval, the approved preview is exact, and due native application clears it while advancing actual Personnel facts.

The earlier test-only proof `ef1bcc4a7604733cae14e725c63530f5737a78f8` / **43963344028** deliberately reproduced unwanted ordinary signing success after the case company's Lifecycle entitlement was disabled. Its passing result proves the gap, not correct policy. Forward migration 5916 adds the separately approved ordinary-only denial while preserving read visibility and existing email/Form delegation.

## Work that remains held

- Real Contract Form response capture and signature response receipts are not enabled. The application and UI hold unsupported Form actions. Automatic approval review rejected the proposed additional native Form hold; see [the concrete review](contract-native-form-hold-approval.md). Do not claim the generic native Form boundary is complete.
- Automatic approval review separately rejected persistent email-document task/current-signer projection changes. See [the concrete review](contract-email-task-metadata-approval.md). Existing email owner behavior remains unchanged.
- The SMTP attachment transport/provisioning patch is review-only and unapplied. File upload/required-slot UI does not claim delivery. Shared attachment mail remains held by the existing delivery guard.
- The new automatic scheduler principal and manual workflow-start/recovery protocol remain with the integration owner; these screens contain no invented command or legacy action presented as the new owner.
- The existing native date hold for an End whose contract end date has already passed remains in place. A proposed owner change has not been applied; do not claim overdue End completes automatically.
- A rendered review of the actual assembled screens, final design-system documentation, the integration owner's complete release gate and user approval remain outstanding. Existing approved mockups and component DOM checks are not substitutes for rendered acceptance.

Migration registrations and immutable pins must be unioned deliberately with all contributing branches and foreign lower-watermark work before any installation. No main/alpha merge, migration installation, release or production action is authorized by this review.

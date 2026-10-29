Rewards handles salary, promotion and bonus reviews when enabled. [Rewards configuration](/admin/rewards) belongs to authorized administrators; [Rewards reviews](/rewards) is the workspace for explicitly assigned participants. The steps below apply where the relevant controls are available in your installation. If a required control is unavailable, ask the installation administrator to check its availability before proceeding.

## Set up a review

1. Create/select the cycle, company, business unit, year and snapshot date.
2. Review the selected shared configuration and version. Check its eligibility summary, effective dates and group policy before creating the review.
3. Use [Rewards access](/admin/rewards/access) to assign the review's BU, BG, GR, CTRO, EC and payroll responsibilities as required. An HR role alone does not grant every review role.
4. Review employee source data and import the supported facts template if needed. Check confidentiality, performance, talent and any case decisions before submitting.
5. Group Rewards enters the unit-specific bonus inputs in the review; those figures are separate from the shared configuration.
6. Enter recommendations and explanations. For promotion, compare current/proposed roles and complete the required rationale and acknowledgements.

## Manage review access

Company administrators manage only reviews within their authorized scope. Select an existing eligible login and the exact review, role and start date; set an end date or the person being covered when appropriate. Preview individual, batch or copied assignments before saving. Saving submits an access request: a different authorized administrator must approve it before membership changes. You cannot approve your own request or a change to your own access. Rejections require a reason. If there is no independent administrator, arrange that coverage rather than resubmitting the request.

Assignments are editable only while the review is Draft. Check required-role coverage; submission is blocked when required coverage is missing. Replace the last eligible person in a required role in one edit rather than removing them first. PBP access is read only, and payroll handoff also requires current company-administrator authority.

People changes can suspend an assignment, including resignation notice, a changed People assignment or an unavailable login. Check the displayed reason and effective dates. An explicit request to restore suspended access needs a reason and independent approval. Restoration cannot override an unavailable login or the assignment's date window; later People changes are checked again. Earlier requests, assignments and decisions remain available as history.

## Share configuration and manage exclusions

Open [Shared rewards configuration](/admin/rewards/shared). Choose the reward year, then select company and business-unit pairs in the Business group → Business unit → Company hierarchy. Choices follow current effective People assignments, not a business unit's global catalogue availability or the company that created its label. A company with no current relationship shows an explanation instead of an empty list. Correct the underlying People assignment rather than choosing an unrelated business unit.

Search and select-all controls apply within your permitted scope. The selected company/unit names remain above the choices while scrolling. Saved selections whose relationship is no longer valid remain visible for explicit correction; they are not silently reassigned. Review unavailable or already assigned pairs before saving. Each pair can belong to only one shared configuration for that year.

A company exclusion covers that company for the whole reward year and prevents new unit reviews for it. It is separate from selecting business units or choosing a salary-only policy. Excluding a company or bringing it back requires a reason. Existing reviews and their records are retained.

Inspect saved versions, compare policy and coverage changes, and check the reviews using a version. Changes create a version for future reviews; existing reviews retain their own policy snapshots, employees, budgets, access and approvals. Saving with no selected pairs archives the shared configuration for future use while retaining its history. You need authority over every company in an existing or proposed shared configuration to manage it.

## Edit shared policy and eligibility

Shared configuration holds group rules: eligibility dates, salary-increase pool percentages, merit and bonus matrices, salary ranges, bonus structure and lump-sum rules. PAT, target bonus months, multiplier overrides, branch ratings and budget-cap exemptions belong to each unit review. Editing shared policy does not change those unit inputs.

Use the salary-range and bonus-month tables instead of comma-separated text:

- Supply salary ranges for H and JG 12–22, with Minimum below Midpoint below Maximum. JG 23 has no range.
- Supply bonus rows for H and JG 12–23. UA must be zero, months must rise across UA → BE → ME → AE → OU, and values support at most two decimal places.
- **Import from Excel** checks the displayed column order and previews proposed values. Use an .xlsx file within the stated size limit. **Copy from last year’s configuration** lists only prior-year configurations you may access; choose the intended saved version and review its preview.
- Apply proposed values to the draft, correct highlighted cells, then review and save the configuration. Importing or copying alone does not publish a configuration or update an existing review. Changing the reward year discards open copy choices and previews.

The branch-factor grid appears only for the PPCH branch-factor structure. Enter each segment's UA–OU factors there; UA is nil. Branch ratings are entered in the unit review, and that structure uses a fixed unit multiplier of 1.00. Standard plans do not apply dormant branch settings.

Before creating a review, check **Eligibility is judged against** for the selected configuration and version: Active as of, joined-before, confirmed-by and salary-effective dates; the salary-increase exclusion window; minimum bonus rating; notice and ER exclusions; and Senior plan treatment. The summary refreshes when the selected company, unit or year changes. A legacy configuration may identify snapshot-based status or an unspecified minimum instead of inventing a saved rule; review explicit settings before saving a new version.

The salary-increase exclusion applies to employees whose basic salary changed within its dates. Their pay is excluded from the salary-increase pool base, while bonus remains subject to its own rules and uses the adjusted basic salary. A lateral transfer without a basic-salary change is not excluded for that reason.

## Enter unit bonus inputs

Group Rewards opens the unit review's **Unit budget inputs** section. Enter PAT forecast 9+3, Actual PAT when available, Target PAT, target bonus months and any permitted multiplier override. For PPCH, complete the branch ratings. Record a reason when saving changed inputs.

Check the pool status before proceeding:

- **Not set** means the required valid figures are incomplete or contain zero/placeholder values; it is not an approved zero budget.
- **Provisional (9+3)** uses the forecast and target. Preparation may continue, but a provisional review cannot progress to CTRO or EC approval.
- **Final (Actual)** uses Actual PAT. Check the previous pool, new pool and difference when actual results replace the forecast. Relevant approvers are notified of a changed pool.

Check both Standard and JG H utilisation again after an input change. Submission must fit the final pool. A budget-cap exemption requires a reason and a different Group Rewards user to confirm it; a recorded exemption does not bypass the final-pool submission control.

A saved legacy budget basis is not automatically changed. Group Rewards must review the displayed basis and explicitly adopt unit inputs for that review. PAT figures and their change history are restricted to Group Rewards; other authorized approvers see the resulting pool and multiplier, not the underlying PAT. Shared configuration lists and version comparisons do not expose unit PAT.

## Record Senior plan decisions

Group Rewards handpicks JG 21–23 members through the review's Senior membership controls in Rewards configuration. Preview the membership and submit it for checking. A different Group Rewards user must confirm the selection before the review progresses to the BU review stage. Unselected employees in those grades continue under the standard matrices.

In the unit review's **Senior plan — offline decisions** section:

1. Confirm that membership has been independently checked.
2. Record the offline-approved increment percentage or new basic salary, bonus amount, approval reference and approval date. Supply the supporting approval document when applicable, and record the reason for the entry or change. Do not enter both a percentage and a new basic salary. Salary reductions are refused.
3. Submit the amounts for a different Group Rewards user to check against the approval evidence and confirm.
4. Check that the decision is confirmed. A change needs a reason and fresh independent confirmation; changed source salary or grade also requires the decision to be reviewed again.

Members without complete confirmed decisions remain pending, and payroll transfer is blocked. Selected Senior members' basic salary and awards sit outside the standard increase and bonus pool bases and utilisation; they receive no lump-sum token. Their separately shown totals and amounts are visible only to Group Rewards, CTRO and EC. Other authorized reviewers see that the Senior plan is handled separately.

Confirmed Senior salary and bonus follow the authorized payroll posting for the same payout, marked Senior plan, with the salary update reflected in employee records. Recording or confirming an offline award is not itself payroll posting. Membership, inputs, decisions and changes retain their user, time, reason and before/after history.

## Review and approve

Annual reviews follow BU → BG → GR → CTRO → EC. Submit only after reviewing warnings. Submitted inputs are frozen; corrections require returning the review to draft and submitting a new revision. Returns require a reason, and consecutive stages require different users.

Ad-hoc and mid-year reviews depend on a posted annual parent and its remaining pools. Submission reserves funding, so another open request can affect availability. Use the request's own route and exception requirements; do not assume it follows every annual stage.

## Post to payroll

An assigned payroll reviewer with the necessary company administrator authority selects the intended draft payroll batch and posts the approved result. Review employee salary/grade and source-data freshness first. If source data changed, use the return/refresh workflow rather than forcing a stale recommendation through.

Posting can change compensation and add payroll inputs. Final approval alone does not pay the award. Posted reviews cannot be returned through the ordinary review workflow. Promotion posting is constrained by the effective-day rule because grade is not a generally dated attribute.

## Confidentiality and exceptions

Review membership, stage, confidentiality and own-record exclusions control row access. Visible aggregate budgets do not mean every underlying employee row is visible. Do not distribute exports outside the approved audience. Role comparison proposes text for human review; it is not an AI verdict on promotion.

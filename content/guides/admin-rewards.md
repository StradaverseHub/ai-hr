Rewards handles salary, promotion and bonus reviews when enabled. [Rewards configuration](/admin/rewards/review-plans) belongs to authorized administrators; [Rewards reviews](/rewards) is the workspace for explicitly assigned participants. The steps below apply where the relevant controls are available in your installation. If a required control is unavailable, ask the installation administrator to check its availability before proceeding.

## Set up a review

1. Create/select the cycle, company, business unit, year and snapshot date.
2. Review the selected review plan and version. Check its eligibility summary, effective dates and group policy before creating the review.
3. Use [Rewards access](/admin/rewards/access) to assign the review's BU, BG, GR, CTRO, EC and payroll responsibilities as required. An HR role alone does not grant every review role.
4. Review employee source data and import the supported facts template if needed. Check confidentiality, performance, talent and any case decisions before submitting.
5. Group Rewards enters the unit-specific bonus inputs in the review; those figures are separate from the review plan.
6. Enter recommendations and explanations. For promotion, compare current/proposed roles and complete the required rationale and acknowledgements.

## Manage review access

Company administrators manage only reviews within their authorized scope. Select an existing eligible login and the exact review, role and start date; set an end date or the person being covered when appropriate. Preview individual, batch or copied assignments before saving. Saving submits an access request: a different authorized administrator must approve it before membership changes. You cannot approve your own request or a change to your own access. Rejections require a reason. If there is no independent administrator, arrange that coverage rather than resubmitting the request.

Assignments are editable only while the review is Draft. Check required-role coverage; submission is blocked when required coverage is missing. Replace the last eligible person in a required role in one edit rather than removing them first. PBP access is read only, and payroll handoff also requires current company-administrator authority.

People changes can suspend an assignment, including resignation notice, a changed People assignment or an unavailable login. Check the displayed reason and effective dates. An explicit request to restore suspended access needs a reason and independent approval. Restoration cannot override an unavailable login or the assignment's date window; later People changes are checked again. Earlier requests, assignments and decisions remain available as history.

## Set up Review Plans

Open [Review Plans](/admin/rewards/review-plans). Create a reward year and check its salary effective date, eligibility dates, salary-increase exclusion window and snapshot date. Prior-year dates move forward and can be edited. These dates apply to the whole year.

Each eligible legal company gets one draft plan. Grouping records, archived entities, test or demo companies, aliases and companies not paid in Malaysian ringgit are left out. Review **Companies left out** to check classifications rather than adding an unsuitable company to the grid.

For each company, choose Standard plan, Uploaded awards, or Excluded – no awards. An exclusion needs a reason. Choose the active salary structure and bonus matrix for the year. Suggestions identify their source and remain highlighted until accepted or changed. Branch-factor matrices are suggested only where the company used them last year; deliberately choosing one elsewhere still needs the branch-factor acknowledgement.

Select rows to apply choices together. **Accept all suggestions** and **Copy last year's choices** stage proposed changes; review and save them before they take effect. The coverage line shows companies ready and missing inputs. A plan becomes Ready when its required choices are reviewed, its Business Unit is confirmed and its PAT inputs are entered. There is no separate Make active step.

Authorized review creators can create selected reviews or all Ready reviews. Creation runs in the background with company progress and can resume safely. Uploaded-awards companies use the uploaded-awards review; excluded companies get no new review. Review creation does not replace Group Rewards preparation and release.

Group Rewards, CTRO and HR Admin edit within their configuration authority; a company-scoped HR Admin edits only those companies. Creating a reward year needs whole-group authority. EC can view. Permission settings can narrow these defaults. Existing multi-company plans and versions remain read-only under **Earlier plans**.

## Change a company's library choices

Salary Structures and Bonus Matrices show read-only **Used by** lists, including drafts. Company assignments belong in Review Plans. Year settings own the merit matrix and pools; Limit Controls owns the limits.

A deliberate change to a company's salary structure or bonus matrix recalculates an existing review during set-up. After release to the BU CEO, review the impact and give a reason; the review is recalculated and its current approver is told. EC-approved reviews stay locked. Merely publishing a newer library version does not rebind an existing review.

The salary-increase exclusion applies to employees whose basic salary changed within its dates. Their pay is excluded from the salary-increase pool base, while bonus remains subject to its own rules and uses adjusted basic salary. A lateral transfer without a basic-salary change is not excluded for that reason.

## Enter unit bonus inputs

Group Rewards opens the unit review's **Unit budget inputs** section. Enter PAT forecast 9+3, Actual PAT when available, Target PAT, target bonus months and any permitted multiplier override. For PPCH, complete the branch ratings. Record a reason when saving changed inputs.

Check the pool status before proceeding:

- **Not set** means the required valid figures are incomplete or contain zero/placeholder values; it is not an approved zero budget.
- **Provisional (9+3)** uses the forecast and target. Preparation may continue, but a provisional review cannot progress to CTRO or EC approval.
- **Final (Actual)** uses Actual PAT. Check the previous pool, new pool and difference when actual results replace the forecast. Relevant approvers are notified of a changed pool.

Check both Standard and JG H utilisation again after an input change. Submission must fit the final pool. A budget-cap exemption requires a reason and is active when Group Rewards saves it; a recorded exemption does not bypass the final-pool submission control.

A saved legacy budget basis is not automatically changed. Group Rewards must review the displayed basis and explicitly adopt unit inputs for that review. PAT figures and their change history are restricted to Group Rewards; other authorized approvers see the resulting pool and multiplier, not the underlying PAT. Review Plans lists and version comparisons do not expose unit PAT.

## Record Senior plan decisions

Group Rewards handpicks JG 21–23 members through the review's Senior membership controls in Rewards configuration. Preview the membership and save it. The saved selection is active, and it must be saved before the review progresses to the BU review stage. Unselected employees in those grades continue under the standard matrices.

In the unit review's **Senior plan — offline decisions** section:

1. Confirm that the Senior plan membership has been saved.
2. Record the offline-approved increment percentage or new basic salary, bonus amount, approval reference and approval date. Supply the supporting approval document when applicable, and record the reason for the entry or change. Do not enter both a percentage and a new basic salary. Salary reductions are refused.
3. Save the amounts. They are active when saved, and the change log records who saved them and why.
4. Check that the decision shows as active. A change needs a reason; changed source salary or grade also requires the decision to be entered again.

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

## Open the reviews workspace

Use [Rewards reviews](/rewards/reviews) for the review list and [Rewards](/rewards) for the dashboard. A review appears only within your assigned role and company scope. Opening configuration or reading public guidance does not grant access to employee recommendations, budgets or approvals. Review the current preparation status and evidence on the native page before making a recommendation or confirming a review action.

## Configuration changes and the change log

Group Rewards saves Rewards configuration directly: salary structures, bonus matrices, PAT Inputs, Review Plans, Senior plan decisions, budget-cap exemptions and the review set-up release. **Save draft** keeps work in progress; **Save and make active** puts a change into effect. No second person confirms it. Changing PAT, a salary structure or a bonus matrix after a review that uses it has been released, releasing a review to the BU CEO and removing someone's access show **Review before saving** first: check what changes, which reviews are affected and what happens to them, then give a reason.

Every save is recorded in the [Change log](/admin/rewards/change-log) with the person, date and time, the old and new values and the reason, and the other Rewards configuration holders receive one notice. The log can be filtered and exported to Excel. Reviews retain their library versions until an authorized person deliberately changes the company’s choice in Review Plans; EC-approved reviews stay locked. Nobody can add or widen their own Rewards access or change the permission switches for a role they hold.


Use [AI Centre › Operations](/control-tower/loops) to review the loops, the payroll cycle, exceptions and record readiness. AI suggestions support a responsible reviewer; they are not authority to pay, terminate employment or change access.

## Coordinate outstanding work

[Record readiness](/control-tower/readiness) is the one list of missing employee data: each gap, the people it affects,
who acts (the employee, HR or group HR), the next action, and what the missing-data loop has already asked the employee.
**Check current records** refreshes the queue from the HR engine without sending reminders. The scheduled review also refreshes
it and runs readiness and claims passes when their tenant switches are enabled. Readiness can use fixed
templates; scheduled model drafting additionally requires an admitted principal.

A verified closure means the missing field is now present or no longer required. HR still validates
the information itself. Ended employments are retired from the queue without being counted as fixes.
If a gap returns, its case reopens and the reopen count is shown. The recorded check time identifies
the observation behind the queue. Execution failures are shown separately from outstanding HR work.

Use the Operations tabs (Loops, Payroll cycle, Exceptions and Record readiness) to move between them.
Administration holds Workers (every AI piece, its switch and its inventory record), Setup, Spend and providers and,
for group administrators, the [Build list](/control-tower/agents/build-list) of agent capabilities ranked by the work they
would take off HR, with its export. How it works explains each capability. Insights holds HR capacity (time freed, the
baseline, and where the work is) and AI quality, which includes the agreement and payroll-check figures. No screen shows
a ratio of HR staff to employees. The employee links open the authoritative personnel record.

## Work through an exception

1. Select the company and period where offered.
2. Open [Record readiness](/control-tower/readiness) or [Exceptions](/control-tower/exceptions).
3. Read the underlying facts and the affected record. Verify the source data before accepting an explanation or suggested action.
4. Resolve the exception on [Exceptions](/control-tower/exceptions), the one place exceptions are resolved. Its **Cause already fixed** group closes exceptions whose cause is now on file, and its acknowledged group resolves blocks a standing acknowledgement covers; each is re-checked when you press it.
5. Review the outcome in the authoritative HR/payroll record. A resolved suggestion is not proof that an external payment or submission occurred.

[How it works](/control-tower/how-it-works) describes the current model and, for administrators, what is switched on for your company. [Administration](/control-tower/agents) and [AI configuration](/admin/ai) expose the available configuration. Check provider readiness, permissions and the scope of any enabled behavior before changing it.

## Assistant

[Assistant](/assistant) answers with the data and tools allowed to the signed-in user. Use specific company, employee and period context. Check cited records and proposed actions. The model does not become the authoritative payroll calculator or gain another person's access because a prompt asks for it.

You can attach a supported spreadsheet or CSV to ask for import mapping help when that capability is available to your role. Review the proposed destination and column mapping, then open the relevant native import screen to validate its preview. An Assistant suggestion or file attachment does not save HR records: the native import screen retains its own permissions, validation and confirmation. Keep private workbooks out of public feedback and provide only the data needed for the selected task. If provider setup is unavailable, a Group HR administrator can review its configuration and evaluation status under AI configuration; a saved provider is not proof of a successful evaluation.

## Company policies (the Living Handbook)

[AI Centre › Policies](/policies) keeps your company's own policies in your own words, with every version and the date it applies from. Administrators of every company a policy applies to write and edit it.

1. Write the policy with New policy: its title, area, the companies it applies to and the date it applies from.
2. Use Read the values. AI Centre highlights the words it read and lists each value under What the system will enforce, beside what the system does now. It only proposes values for settings that already exist: the claims mileage rates, a claim type's submission window and a leave type's default entitlement table. Everything else stays text and is marked Not enforced yet.
3. Confirm or reject each value. Changing the text means its values are read and confirmed again.
4. For claims policies, If this had applied shows what the claims service calculates from the last 12 months of real claims. AI Centre works out no amount.
5. Send for approval. A group administrator approves it. A change to what the system enforces needs a second, different administrator: someone who did not write or send it. A text-only change needs one approval.
6. On approval, the claims or leave service applies each confirmed value through its own settings and checks, from the policy's date. An owner can refuse a value; the refusal is shown under Approval.

Where the handbook and the system disagree lists every confirmed value the system no longer matches, with both values. Use the handbook prepares a draft that applies the handbook again; Update the handbook prepares a draft whose text says what the system does. Both go through the same confirmation and approval. Claims and leave settings are shared by every company in your group, so they are enforced only from a policy that applies to all of them. Employees see approved versions only, and AI Centre answers their questions from the version in force, citing the policy and paragraph.

## AI quality

[AI quality](/assistant?view=insights#ai-quality), under AI Centre › Insights, shows HR and group administrators how people use AI Centre's work, what it could not answer or do, and what the loops propose. Its own guide, "Admin Guide: AI Quality and Learning", explains each figure and decision.

## Reports and operations

Use [Reports](/reports) and [Analytics](/analytics) for authorized summaries. Confirm filters and totals before sharing an export. [Scheduled actions](/admin/scheduled-actions) shows the operational actions available to the relevant administrator; a configured item is not proof that its last execution succeeded.

Use [System explorer](/admin/system-explorer) and [System testing](/admin/system-testing) when those modules and permissions are available. Keep product issues in [Feedback](/feedback) with reproducible steps and the affected record references, without credentials or unnecessary personal data.

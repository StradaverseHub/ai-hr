[Lifecycle](/lifecycle) coordinates employee checklists, IT requisitions, asset requests and the asset register. The module must be enabled. Its Agent and Manager assignments are module responsibilities, not the employee's ordinary line-manager role.

## Configure first

Open [Lifecycle configuration](/admin/lifecycle). Review company staff assignments, checklist definitions, approval levels, custom fields and the equipment catalogue. Deactivate obsolete steps through configuration so existing checklist history remains understandable.

## Shared resignation configuration

New managed resignations require Lifecycle to be enabled for the employee's company. Configuration access, case decisions and Personnel posting approval are separate permissions.

Use the shared HR Automation configuration area:

- [Workflows](/automation/workflows?module=off): select Offboarding and review its decision, letter and notification workflows. Installed starter workflows are Paused; configure real recipients and explicitly make the relevant workflows Live after review.
- [Templates](/automation/templates?module=off): maintain document and email templates. Publish the document version to use and check its routing. A retention letter must end with the employee's Sign step alone.
- [Assignment groups and Routing rules](/automation/groups): maintain responsible people and matching rules. These groups are shared, so changes can affect other lifecycle work.

Open [Onboarding & offboarding settings](/lifecycle/v9?view=settings). Under Personnel postings, choose a populated approver group. Under Retention offers, review “No second retention offer within (months)”: the default is 12 months from the previous offer's acceptance; enter 1–60 months or leave blank for no limit. This restricts another retention offer, not the employee's ability to resign again.

## Manage resignation exceptions and outcomes

If no decision can be assigned, the submission remains recorded and shows a configuration repair flag. Correct the workflow or assignment group, then use **Run workflows again** when offered. Do not ask the employee to submit a duplicate. A failed existing workflow may instead offer **Retry failed workflows**.

Acceptance follows the configured letter and linked offboarding workflow. For managed resignations, employment termination is recorded only after clearance is completed and its Termination posting is approved in [Offboarding Personnel postings](/lifecycle/offboarding/postings). Accepting the resignation or releasing its letter alone does not terminate employment. Accepted retention terms also require their configured posting approvals before Personnel Management records the effective-dated changes.

Choosing that a replacement is needed creates an assigned recruitment follow-up. Its owner records the recruitment request URL; the choice does not automatically create a vacancy.

Existing in-flight legacy resignation requests remain on their existing route. Do not recreate them to migrate them into the managed journey.

## Onboard a joiner

1. Open [Onboarding](/lifecycle/onboarding) and create a case or use its import workflow.
2. Check company, start date, contact information, laptop requirement and any linked employee.
3. Track each assigned checklist step and the associated [IT requisition](/lifecycle/requisitions).
4. Complete the required approval before issuing equipment where the workflow requires it.
5. Record the actual asset issued and verify its holder in [Assets](/lifecycle/assets).
6. Have the signed-in new hire complete the offered acknowledgement through My lifecycle after handover.

An onboarding case can exist before an employment. It does not by itself create HR employment or login credentials.

## Offboard and return equipment

Open [Offboarding](/lifecycle/offboarding), record the intended outcome and work through the appropriate checklist and IT return. Track returned equipment against the actual holder. Checklist completion does not itself terminate employment or prove identity access has been revoked; complete those authoritative workflows separately.

## Asset requests and approvals

Use [Asset requests](/lifecycle/asset-requests) for employee requests. Assigned module staff review, approve and advance fulfillment through the permitted stages. A requester cannot approve their own request, and consecutive approval levels require the appropriate distinct approvers. Review the timeline after every handoff.

## Exceptions

Cancelling an onboarding case does not mean its existing requisition has also been cancelled. Inspect related records. Use the live worklist for outstanding tasks; a due task is not evidence that a reminder email was sent. A checkbox for an external action is a recorded human confirmation, not proof of an automatic external integration.

## Work on offboarding requisitions

Open [Offboarding requisitions](/lifecycle/requisitions/offboarding), then open the request shown by the native list. HR with Full case view can review the authorised case scope; a fulfilment team sees only its own Return or Revoke items, never the private case. Review the issuing team/person and date where recorded; an absent historical source is shown as not recorded.

Update only the offered item controls, enter the required reason and save. The request records item progress and its completion time. Completing an item does not clear the whole case, sign a document or terminate employment. If access or the revision changes, reopen the current native request before deciding.

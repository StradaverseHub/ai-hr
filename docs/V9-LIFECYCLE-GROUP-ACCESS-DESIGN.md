# V9 group page and case-action boundary

Status: proposed authorization change, not applied. The preset editor, typed configuration metadata and pure merge/record rules are implemented; database authorization and case-action wiring are pending owner confirmation. The supplied Admin V9 HTML is the product reference. Its `JORD`, `JPRESETS`, `joinerPerm` and `JPACT` functions distinguish page visibility from case actions. Automatic approval review rejected the first attempted implementation of the database predicates/update policy because it could persistently broaden mutation authority. That rejected command did not execute.

## Reviewable behavior

| Preset | Case details | HR-only fields | Notes | Checklist | Equipment | History | Case actions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Fulfilling team | View | Hidden | View | Own/team tasks | Work on their items | Equipment | None |
| Coordinator | View | Hidden | View | All tasks | Work on their items | Full | None |
| Approver | Hidden | Hidden | Hidden | Hidden | View | Hidden | None |
| Full case view | View | View only with actual company HR authority | View | All tasks | Work on their items | Full | Edit, submit, cancel, reopen |
| Custom | Explicit per section | Actual company HR authority still required | Explicit | Explicit | Explicit | Explicit | Explicit None/Allowed |

Only the existing Master Admin configuration writer can select groups, presets or custom values. Multiple selected groups combine the greatest visibility for each section, matching the HTML. A module member retains the full page view; a group page grant does not make someone a module configuration administrator. Request-record group access is independent of New Joiners page access and grants no case actions.

## Required storage and service boundaries

- Keep the existing task/approval/fulfilment participant predicate unchanged. A new page reader must never become a writer by reusing that predicate in an update policy.
- Add read authorization separately, with fresh active-account/tenant checks and redacted response projections. Hidden case sections, HR answers, identity fields and private documents must be absent from serialized responses, not merely hidden in the UI.
- If the owner approves case actions, add a distinct fresh predicate for selected groups whose effective `actions` value is `allowed`. Apply it only to case operations, preserving canonical revision checks, audit/history, Personnel locks and company HR checks. It grants no global HR role, Payroll permission, template/configuration administration, identity grant or arbitrary asset mutation.
- A read-only preset receives no new case-update permission. The existing assigned-task, approval and providing-team work authorities remain independently checked.
- Case edits must respect each section: hidden case fields and notes cannot be changed, equipment selections require the appropriate equipment/case authority, and HR-only fields require actual company HR permission.
- No real account/group membership will be changed as part of implementation or tests. A later Master Admin decision in the application owns actual grants. Deployment still requires the final migration rehearsals, full gate and coordinated staging window.

## Required evidence before release

Compare the TypeScript and database preset/merge results for every preset and multiple-group combinations. Verify view-only users cannot save/submit/cancel/reopen through services or direct application-role SQL. Verify an explicitly allowed case actor can perform only permitted case actions, stale revisions fail, private fields remain absent, changing/revoking the configuration takes effect on the next request, and unrelated tenants/companies remain isolated. Retain existing assigned-task/approval/fulfilment regression checks and render the actual group-view journeys.

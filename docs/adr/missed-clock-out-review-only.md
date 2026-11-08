# Missed clock-outs require human approval

Status: Accepted by the owner on 9 November 2026.

Attendance Irregularity and Self Overtime submissions require an applicable configured human approval workflow. The owner selected Prepare/review-only for the missed-clock-out loop when asked how that requirement interacts with its former automatic correction mode.

The loop may detect missing clock-outs and prepare a correction card. The employee reviews the time and submits through the attendance owner; the configured human approvers decide. The loop cannot promote above Prepare, create or approve a correction automatically, or auto-approve compensation for a historical automatic action.

The restriction applies to stale stored Act configurations as well as new settings. Code and the database's effective-level owner enforce the ceiling. Existing raw configurations, actions, attribution, decisions and audit history remain intact. Safe stop, pause, disable and authorised lowering remain available; no historical administrator is falsely recorded as making this policy change.

Old automatic actions remain readable. Their former one-click Undo now returns a finite human-review-required result without creating an application, changing attendance, or recording an undo. Employees use their attendance day to request a correction; authorised administrators use the existing attendance editor and approval workflow. These paths retain current self-approval, tenant/company scope, payroll and historical-effect safeguards. A prior automatic action grants no new approval authority.

The missing-employee-data loop may still send a request for a person to complete their own details. It changes no employee record and retains its existing promotion, limits, audit and withdrawal rules.

Verification must distinguish current Prepare/no-write behaviour from declared restored historical fixtures. Historical attribution and cards remain covered independently; previous automatic-act expectations are superseded by this decision.

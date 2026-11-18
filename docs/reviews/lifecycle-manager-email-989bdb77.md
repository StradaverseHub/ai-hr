# Personnel manager email delivery

Approved board item `989bdb77-0599-4183-998f-13cbf2513579` separates a manager's Personnel employment identity from an application login. Task assignment still requires an eligible login; email uses the current administrative reporting line and the manager's Personnel work mailbox. A draft joiner uses the authorised Personnel draft's `reportingManagerEmploymentId`. Multiple distinct effective managers hold delivery for HR review. Missing, inactive, unavailable and invalid-mailbox states remain distinct.

The case's current manager summary, merge values and recipient preview use the same reader. The existing sealed outbox captures the authorised work address as a business-mailbox recipient. It retains transport validation, deduplication, uncertain-outcome protection and retry receipts.

Held emails derive their due day from the run's frozen workflow, current case anchor and the HR date owner. Late continuation requires the case's HR actor to choose **Send anyway** or **Skip this email**. The choice is revision-guarded and recorded in case/run history. A system sweep cannot make it. A skipped step does not skip subsequent workflow steps or alter any sent message.

Recipient source review: Employee work/personal mailboxes already use Personnel fields at enqueue time. TA remains a stored account identity; it does not have a general Personnel-employment recipient resolver. HR signatory remains company configuration. Assignment groups and task owners retain their existing owners. There is no HOD role in the V9 recipient union. This change introduces no HOD role or alternative assignment-group registry.

Recovery is a separate operator action, never part of deployment:

```
node --conditions=react-server --import tsx scripts/recover-lifecycle-manager-email.ts --tenant TENANT_UUID --user HR_USER_UUID
node --conditions=react-server --import tsx scripts/recover-lifecycle-manager-email.ts --tenant TENANT_UUID --user HR_USER_UUID --apply PRIVATE_REVIEWED_REPORT.json
```

The first command reports the SQL-paged exact tenant/case/run/step/revision manifest and due-day classifications. The second admits a job on the protected bulk-job kernel. The worker rechecks current HR authority, case revision, current manager, all recipients and prior delivery before each checkpoint. Future holds rejoin the normal scheduler, due-today holds resume normally, and late holds remain for HR. Replayed or changed entries do not resend. Manifests remain private. An admitted due-today job can queue email; run it only with recovery authority for the verified installation, then independently verify the job receipt. No live recovery or deployment is claimed by this source change.

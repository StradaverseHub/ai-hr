Use [Notice Board administration](/admin/notice-board) for company notices and [Knowledge Base](/knowledge-base) for reference articles/files. Review audience and dates before publishing.

## Publish guidance

Create a company-authored article for local policies. Choose its audience deliberately and verify the published view. HR administrators publish new knowledge-base content; ordinary employees do not have a general upload right. Bundled system guides are maintained with the application and refreshed during deployment, so do not use their bodies as the only copy of a company policy.

## Enable workflow email

1. Open [Workflow email](/admin/settings/notifications) and inspect relay readiness.
2. A group administrator selects the categories the tenant permits and saves the policy. Company-scoped administrators can inspect the permitted delivery view but do not change tenant-wide policy.
3. Employees opt in for their own eligible employment/categories using Notifications. Tenant policy does not replace recipient consent.
4. Verify that the managed relay and delivery worker are active, then inspect delivery status for new eligible events.

Enabling a category does not send a historical backlog. In-app notifications remain available for mapped events. Workflow email does not attach payroll documents or replace authorization on the linked application record.

## Delivery failures

Inspect the recorded delivery status and safe error category. A failed delivery can offer a retry to a group administrator. Read the possible-duplicate acknowledgement before retrying: an uncertain transport outcome can mean the original message already reached the recipient. Do not repeatedly retry without investigating relay readiness and recipient eligibility.

## Installation email is separate

[Email delivery](/admin/settings/email) requires a separately enrolled installation capability and supported identity session. It is not granted by HR or customer-provisioning operator roles. Its save-draft, send-test and activate workflow controls the installation relay. Saving a draft is not activation, and application deployment does not imply a human confirmed receipt of the test message.

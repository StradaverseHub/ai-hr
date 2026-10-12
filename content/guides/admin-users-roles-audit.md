Use [Users](/admin/users) to manage login access and grants. A person, an employment and a login are separate: hiring does not create a password, and ending employment is not a reason to erase audit history.

## Activate an employee

Group administrators see eligible staff under **Pending activation**. Each person appears once across employments. Existing accounts, including archived accounts, are managed through their existing entry rather than recreated.

1. Select the intended person and review their profile email.
2. Choose the invitation workflow or the manual username/temporary-password workflow if available on this installation.
3. Review the role and company scope. Employee access is the default; elevated access must be deliberate.
4. For invitations, check delivery readiness and use the existing pending invitation state before sending another.
5. For manual creation, verify the person's identity and email ownership, supply a compliant temporary password and confirm private delivery. The employee must change it at first login. Do not put credentials in notes, feedback or knowledge-base articles.
6. If setup remains pending, use its resume action. Do not create a second person/account to work around a partial setup.

Manual enrollment requires the supported identity configuration and a verified group-administrator session. A company-scoped HR grant, demo identity or unsupported provider session does not enable it. Manual account creation does not reset an existing person's credentials.

## Roles and scope

Review role grants, company boundaries and function access together. Group access is broader than a company grant. Payroll permissions and workflow assignments can impose additional restrictions. Operator provisioning and installation email administration are separate capabilities; neither follows automatically from an HR role.

Use archive/revocation controls for existing accounts when appropriate and verify the resulting access. Rehire does not automatically unarchive a login. Do not use email similarity to merge or rebind identities.

## Audit and privacy

[Audit trail](/admin/audit) records supported changes with actor and context. Use it to investigate who changed access or configuration and when. [Data privacy](/admin/privacy) provides the implemented privacy workflows. Review their scope before confirming an irreversible operation.

## Knowledge-base publishing

HR administrators can create articles and upload files in [Knowledge Base](/knowledge-base). Audience filters restrict readers: employees cannot deep-link into manager or HR-only guides. Keep company policies in company-authored articles; bundled system guides refresh during deployment.

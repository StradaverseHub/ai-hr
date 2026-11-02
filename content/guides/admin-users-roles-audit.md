Use [Users](/admin/users) to manage login access and grants. A person, an employment and a login are separate: hiring does not create a password, and ending employment is not a reason to erase audit history.

## Activate an employee

Group administrators see eligible staff under **Pending activation**. Each person appears once across employments. Existing accounts, including archived accounts, are managed through their existing entry rather than recreated.

1. Select the intended person and review their profile email.
2. Choose the invitation workflow or the manual username/temporary-password workflow if available on this installation.
3. Review the role and company scope. Employee access is the default; elevated access must be deliberate.
4. For invitations, choose the email language, check delivery readiness and use the existing pending invitation state before sending another. An invitation retry retains its chosen language.
5. For manual creation, verify the person's identity and email ownership, supply a compliant temporary password and confirm private delivery. The employee follows the first-login password-change and verification steps required by the active policy. Do not put credentials in notes, feedback or knowledge-base articles.
6. If setup remains pending, use its resume action. Do not create a second person/account to work around a partial setup.

Manual enrollment requires the supported identity configuration and a verified group-administrator session. A company-scoped HR grant, demo identity or unsupported provider session does not enable it. Manual account creation does not reset an existing person's credentials.

## Review password policy and a locked account

With a current group-administrator session, open **System Configuration → Security Center → [Password Policy](/admin/security-center/password-policy)**. This page is available for the installation's embedded HR login. A company-scoped administrator or a different identity provider does not gain access through this link.

1. Review all twelve controls: minimum and maximum length; uppercase, lowercase, number and special-character requirements; expiry; password history; failed-login lockout; automatic unlock; forced first-login change; and first-reset verification. Review the additional counts, intervals and time units shown for enabled controls.
2. Decide the policy for the whole organization before selecting **Save**. It affects this tenant's logins, not just one company or the account you are viewing. Existing legacy requirements remain authoritative until an explicit save; review the entire form rather than assuming the displayed choices are already active.
3. If validation refuses the change, correct the indicated values. If another administrator has changed the policy, reload and review their current values before deciding what to save. A successful save is audited; navigating away does not undo it.

For a locked account, first verify the person's identity and the reason for the lock. An authorized group administrator can open [Users](/admin/users), select the exact internal-login user in **Unlock account**, and confirm the manual unlock. The action is audited. It clears the failed-login lock; it does not reset the password, change roles or bypass MFA and other access checks. Automatic unlock follows only an explicitly enabled policy and its configured waiting period; viewing guidance never triggers it.

Assistant guidance only explains these controls and their location. It does not read passwords, change policy, reset credentials or unlock an account for you. Use the existing recovery process when a password needs resetting; do not create a replacement login.

## Create a user without an employee record

Group administrators can choose **New user without an employee record** in either account setup form. Enter the person's full name and email, then explicitly select their role and company scope. Use an email invitation or, when supported by the installation, a username and temporary password.

This creates a named person and login access without an employment, employee number, payroll record or employee self-service entitlement. The Users directory marks these accounts **No employee record**. Access follows the chosen grants and existing permission rules; an external manager gains no reporting relationships merely from a role.

If that email already belongs to a person in this group, choose the existing person instead of creating a duplicate. Unfinished manual setup uses **Resume setup**. A revoked invitation leaves the person available for another activation. Archive blocks a standalone login using the same existing control. If the person is later hired, reuse their existing person record; the existing employment lifecycle then governs login blocking.

## Find and group users

Search by name or email, then filter by login status, role and company scope. Group administrators can also filter by whether the person has an employee record. **Group by** organizes the same directory by status, role, company scope or employee record. Users with several roles or scopes appear in each matching group; the matching-user count remains distinct. Group headings expand and collapse, and the directory shows 20 entries per page.

Each row shows current status and role/scope information. **Manage** opens that user's assigned roles, role editor, assistant control and archive/restore actions. **Activate** opens the two supported activation methods for a pending person; **Resume setup** returns to the unfinished manual enrollment. These controls retain the existing group/delegated-administrator restrictions.

## Roles and scope

Review role grants, company boundaries and function access together. Group access is broader than a company grant. Payroll permissions and workflow assignments can impose additional restrictions. Operator provisioning and installation email administration are separate capabilities; neither follows automatically from an HR role.

Use archive/revocation controls for existing accounts when appropriate and verify the resulting access. Rehire does not automatically unarchive a login. Do not use email similarity to merge or rebind identities.

## Audit and privacy

[Audit trail](/admin/audit) records supported changes with actor and context. Use it to investigate who changed access or configuration and when. [Data privacy](/admin/privacy) provides the implemented privacy workflows. Review their scope before confirming an irreversible operation.

## Knowledge-base publishing

HR administrators can create articles and upload files in [Knowledge Base](/knowledge-base). Audience filters restrict readers: employees cannot deep-link into manager or HR-only guides. Keep company policies in company-authored articles; bundled system guides refresh during deployment.

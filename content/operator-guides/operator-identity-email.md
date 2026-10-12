This guide distinguishes installation responsibilities from tenant HR responsibilities. The provisioning operator role does not automatically confer either customer HR access or installation email configuration.

## Identity and first-owner readiness

The installation's configured identity provider owns authentication and password policy. A maintainer must complete the supported deployment/cutover prerequisites. The human owner completes first sign-in, password enrollment and any required MFA. A successful application build does not prove that those human steps happened.

Before handing over to a customer, verify the intended sign-in URL, provider configuration and initial administrator activation path. Do not promise invitations or password recovery until their delivery prerequisites are ready.

## Configure installation email

Only a separately enrolled installation email administrator can open [Email delivery](/admin/settings/email). Access is tied to the authenticated identity and enrollment, not a broad HR role.

1. Review the current active settings and save a draft with the intended sender and supported implicit-TLS relay configuration.
2. Send the draft test. It goes to the configured owner/test recipient, not an arbitrary address entered in the browser.
3. Confirm the human recipient actually received it.
4. Activate that exact tested draft within the allowed test window. If the active revision changed, refresh and retest.
5. Verify the active/readiness state. A saved draft or failed test leaves the existing relay unchanged.

Do not record SMTP passwords in the knowledge base. A failed or uncertain activation needs investigation; it is not permission to weaken TLS checks or assume success.

## Workflow email is an additional opt-in

The active relay is only one prerequisite. The tenant's group administrator enables categories in [Workflow email](/admin/settings/notifications), recipients consent through Notifications, and the delivery worker processes eligible events. Enabling policy does not send a historical backlog. A sent delivery means relay acceptance, not proof of inbox arrival or human reading.

## Customer handover

Ask the customer administrator to verify company structure, employees, user activation, permission scope, leave/attendance setup, payroll configuration and enabled modules using the Getting Started guide in their tenant Knowledge Base. Manual employee account creation is available only through its supported group-administrator/identity workflow; it must not adopt or reset an existing identity by matching email.

For a missing screen, distinguish a missing entitlement, a missing role/company grant and an unavailable deployment capability before changing access.

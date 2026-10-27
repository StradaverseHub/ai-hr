# Microsoft 365 application authentication for email

AIHR internal authentication supports unattended SMTP with an application identity. An enrolled
installation operator configures it in **System Configuration → Email delivery**. It uses existing
encrypted mail settings and the Save, Test and Activate workflow. No user sign-in, delegated refresh
token or callback is needed. Application OAuth itself does not require a database migration; the
named-connections and paginated history upgrade requires its separately journaled release migration.

## Microsoft 365 administrator setup

Register a single-tenant Entra application, add **Office 365 Exchange Online → Application permissions
→ SMTP.SendAsApp**, and grant tenant administrator consent. Register its service principal in
Exchange Online using `New-ServicePrincipal`. Use the **Enterprise application** object ID; the
app-registration object ID is different. Restrict access to the designated sending mailbox using
Exchange mailbox permissions and grant the sender's required Send As permission. Verify SMTP AUTH
is enabled for that mailbox under the organization's approved security policy. Do not grant
unrelated Graph, IMAP or POP permissions for AIHR SMTP.

Microsoft also supports [scoped Exchange App RBAC for SMTP](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/smtp-app-rbac-onboarding).
An administrator using that route grants `Application SMTP.SendAsApp` with a mailbox resource scope;
the token need not contain an `SMTP.SendAsApp` claim. Verify the chosen authorization route rather
than treating an absent claim alone as an authentication failure.

Create a client secret with an expiry and rotation owner. Privately provide its **value**, tenant ID,
application/client ID and allowed mailbox to the AIHR installation operator. Keep secrets out of
chat, tickets and tracked files. The request uses `client_credentials` with
`https://outlook.office365.com/.default`. The screenshot's delegated `SMTP.Send` uses another flow.
Follow Microsoft's [application SMTP setup](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)
and [SMTP submission requirements](https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/how-to-set-up-a-multifunction-device-or-application-to-send-email-using-microsoft-365-or-office-365).

## AIHR setup and acceptance

1. Open or create a named connection in Email delivery, then select Microsoft 365 application OAuth.
   AIHR fixes the connection
   to `smtp.office365.com:587`, mandatory STARTTLS and verified TLS 1.2 or later.
2. Enter tenant ID, application ID, mailbox username, client secret value and From address. Save the
   connection. Saving does not replace the active connection.
3. Send the test to the operator's verified address and check the actual inbox, including junk mail.
   After receiving it, confirm receipt and activate the tested connection. Exactly one connection is
   active for the installation. Other saved connections remain inactive until explicitly activated.
4. Verify account and Reports deliveries separately. Configuring email does not install Reports
   private services, enable scheduling, create consent or replay held deliveries.

Saved secrets are write-only. A blank secret retains it only for the same authentication method,
host, mailbox, tenant and application. Changing those requires a new secret. Every saved replacement
requires a fresh successful test and explicit receipt before activation. For rotation, leave the
old credential valid until the replacement is accepted, then revoke it in Entra. Preserve the
existing authentication encryption key and its database backup together.

Each delivery obtains a short-lived access token in memory. Provider bodies and credentials stay
out of public failures and audit events. Reports obtains the token outside database transactions,
then rechecks the occurrence, identities, contact, permissions and relay revision before marking
the attempt started. Its isolated sender receives the token, never the client secret or encryption
key. A token or SMTP failure does not trigger a new delivery.

The reviewed internal Reports installer also installs `aihr-smtp-token.socket` and its one-request
Python service. The socket accepts only the existing web/broker UID. The helper uses a separate
dynamic UID, no private environment file, no database credentials and a fixed Microsoft endpoint.
The Auth broker retains its loopback-only network filter. Upgrade the reviewed private Reports
bundle before expecting OAuth Reports delivery; a missing helper fails closed. Check the installed
UID/socket/proc boundaries and memory budgets on Linux as part of that upgrade's acceptance.

Password and no-auth relays retain implicit TLS support and may select mandatory STARTTLS. Application
OAuth is available only for the internal authentication owner; legacy managed identity settings
reject it. National clouds, certificate credentials, delegated authorization and Graph sending
are outside this implementation.

## Failure handling

A failed test leaves active settings in place. Check consent, enterprise service-principal
registration, mailbox grants, SMTP AUTH policy and secret expiry privately. Token acquisition
does not prove SMTP authorization or inbox receipt. Keep real tenant delivery, receipt and
production activation evidence separate from simulated transport and local tests.

## Saved connections and delivery history

The list identifies the connection name, host, authentication mailbox, sender, encryption and active
state. Opening a connection edits its saved candidate. If a live connection has saved changes, its
last activated configuration continues sending until the replacement is tested and activated.
Saving an inactive connection does not change the canonical active-relay revision used by Reports.

Account-mail history has local-date filtering and older pages; timestamps stay UTC in storage and
use the installed country pack's display clock. Malaysia supplies Asia/Kuala_Lumpur (MYT).
Delivery-log retention defaults to Never delete. The verified installation email administrator can
choose 1–3650 days and must acknowledge permanent deletion, including existing eligible history.
The period is elapsed 24-hour days since the last delivery activity, independent of display timezone.
Pending sends and unexpired pending invitations are protected. An entire resend chain is retained
until every entry is inactive and old enough; cleanup never exposes a retained predecessor for resend.
Accounts, invitation records and append-only security audit events are not deleted. Policy changes
and cleanup counts are audited without recipient addresses. Deleted log entries cannot be previewed
or resent from history. Backups have their own retention; this setting does not rewrite backups.

### Commission the cleanup timer

Source deployment alone does not install or enable maintenance. The release operator must install
`deploy/systemd/aihr-account-email-retention.service` and its matching timer after the journaled
migration is applied. Do not install a second cron job for the same task. The service template uses
the reviewed Node 22 path and a dedicated `aihr-maintenance` OS identity: create or map that identity
privately during the reviewed maintenance window. Supply only `MIGRATION_DATABASE_URL` in
`/etc/aihr/account-email-retention.env`, readable only by the maintenance identity/root; do not copy
the web environment or add database-owner credentials to the web process. The prune function is
revoked from PUBLIC and `ai_hr_app`; only its database owner can run it.

The timer runs hourly with up to five minutes of jitter and catches up a missed invocation. Each
transaction removes at most 100 complete eligible resend chains. It takes a nonblocking advisory
lock against other cleanup runs and policy edits, and serializes delivery-ledger writes while deleting.
A lock timeout or failed audit append rolls the transaction back; no successful cleanup is claimed.
The web app never starts cleanup while viewing or saving settings.

In the authorized maintenance window, validate the installed units, explicitly start one service
invocation, inspect its exit status/journal and then enable the timer. Verify the sanitized count and
last-success timestamp in Email delivery, and inspect the timer's next scheduled invocation. Missing
initial success is shown explicitly in the UI; a last-success timestamp is not proof that a timer is
still enabled. Stopping the timer or choosing Never delete stops future removal; deleted rows cannot
be restored through this page. This preparation does not install the timer or authorize production.

The email preview is explicitly a template preview, not an archived original. Live activation and
password-reset links are hidden. Provider acceptance is not proof of inbox receipt. Explicit resend
retains the previous attempt and issues a fresh link; invitation resend revokes the old link and
preserves its role and company scope. An accepted invitation cannot be resent. Recovery resend still
requires the installation identity administrator and current account eligibility.

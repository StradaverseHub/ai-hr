# Account email from the import worker (By Batch Send Invitation)

"By Batch Send Invitation" (`bulk_job_kind` `account_invitation_batch`, migration 7600) runs in the protected
import worker, `aihr-bank-import.service`, not in the web process. The worker reads only the root-owned
`/etc/aihr/import-worker.env`. This page explains what it needs to send account email, and gives the operator
procedures for staging and production. **Nothing here is installed by deploying the source.**

## What the worker needs, and what it does not

With embedded login (`AUTH_PROVIDER=internal`, [ADR-0117](../../docs/adr/0117-embedded-hr-authentication.md)),
account email uses the HR-owned SMTP connection stored encrypted in the database: Admin → System Settings → Email
delivery ([README](README.md#smtp-and-recovery)). The app sends it itself with Nodemailer. Microsoft 365 application
OAuth fetches its token from `login.microsoftonline.com` in the same process.

The worker therefore needs the web process's exact values of three settings:

| Key | Why the worker needs it |
| --- | --- |
| `AUTH_PROVIDER=internal` | selects embedded login, so account email uses the HR-owned SMTP connection |
| `AUTH_PUBLIC_ORIGIN` | the origin of the invitation link in the email |
| `AUTH_SESSION_KEY` | opens the encrypted SMTP connection and organisation records; any other value opens nothing |

Without them, the worker does not select embedded login. Readiness then asks the legacy Keycloak relay socket
`/run/aihr-identity-email.sock`, and every invitation fails with "The email service is not available"
(staging, 28 November 2026). The web shows the same batch as Failed, and no login is created.

**Do not install the `deploy/identity-email/aihr-identity-email.*` relay for this.** That unit is the cancelled Keycloak
email agent: it `Requires=aihr-keycloak.service` and is never used with `AUTH_PROVIDER=internal`. The "relay" in
messages such as `relayUnavailable` is the active SMTP connection in Email delivery.

The worker also needs:
- an active, tested SMTP connection in Email delivery (once per installation, shared with the web);
- outbound network access from the worker host to that SMTP server's port (465 implicit TLS or 587 STARTTLS for
  Microsoft 365) and, for Microsoft 365 OAuth, HTTPS to `login.microsoftonline.com`. The unit applies no address
  restriction; a host firewall might.

The reviewed worker tools carry these keys (`ENV_KEYS` in `deploy/systemd/bank_import_worker_installer_v2.py`).
The first-install helper copies them from the web environment. The staging update and production helpers accept them
in an existing file through the reviewed-key flow (`--previous-worker-env-sha256`,
[BANK-IMPORT.md](../systemd/BANK-IMPORT.md#a-reviewed-key-added-after-the-last-activation---previous-worker-env-sha256)).
At startup the worker logs `Import worker: AUTH_PROVIDER/AUTH_PUBLIC_ORIGIN/AUTH_SESSION_KEY are missing or invalid`
when they are absent. Other jobs keep running.

Setting `AUTH_PROVIDER` in the worker has a second effect: the "setup in progress" skip (people whose username and
password setup an administrator has started) now applies to batch invitations, as on the web. Automation, letter and
notification email are only queued in the worker; their separate sweeps deliver them, so they are unchanged.

## Preconditions (both environments)

1. The source change that added these keys is merged into **both** `main` and `alpha`, so every later candidate's
   worker helpers accept them. A later update or rollback with a helper from before that change refuses the edited
   file ("unreviewed key"). In that case, remove the three lines (restore the backup below) before using the old helper.
   The running release does not need the change: the worker reads the keys from its environment either way.
2. The owner has chosen the SMTP provider and the test inbox, and has given an explicit go-ahead for this target.
   The owner enters SMTP credentials in the app themselves. Never collect a password, client secret, session key or
   OTP in chat, tickets, logs or tracked files.
3. Read-only check of the web environment (no lease needed): the web's `AUTH_PROVIDER` is `internal`. On staging the
   web environment is `/opt/ai-hr/.env.production`. On the customer production layout it is `/etc/aihr/runtime.env`.
   Confirm with `systemctl show aihr -p EnvironmentFiles` rather than assuming. Compare by digest only; never print a
   value.

## Staging: config-only window through the shared queue

Every staging change goes through the [shared staging queue](../../docs/STAGING-RELEASE-QUEUE.md) under a lease,
even a quick one. Tell the coordinator (ORCHESTRATOR session) before you start.

1. **Ticket and claim.** Read `status`. Submit a ticket whose `source` and `base` are the running staging SHA, with
   `"risk":"isolated"`, `"migrations":[]` and acceptance "worker account email: By Batch Send Invitation delivers to
   the owner's test inbox". Prepare it with candidate = baseline = the running SHA and build ID. Claim it and keep the
   lease file. Enter `accepting` with the exact running build. Do not run `operator-release deploy`: this window
   installs no source.
2. **SMTP connection (owner).** The owner signs in to staging, opens Admin → System Settings → Email delivery and checks
   for an active connection. If there is none, the owner creates one for the chosen provider, enters the credentials,
   sends the test to their own verified address, confirms receipt within 30 minutes and activates it. The operator
   does not see or handle the credentials.
3. **Back up and record digests.** As root on the staging host:
   ```bash
   sudo install -m 0600 -o root -g root /etc/aihr/import-worker.env /etc/aihr/import-worker.env.before-auth-$(date +%Y%m%d)
   sudo sha256sum /etc/aihr/import-worker.env
   sudo cat "$(systemctl show aihr-bank-import.service -p WorkingDirectory --value)/worker-install-v2.json"
   ```
   The current digest should equal the receipt's `selectedEnvironmentSha256`. If it does not, stop and review: an
   earlier edit is already pending.
4. **Copy the three settings.** The copy uses the same parser as the installer and prints no value. It refuses unless
   the web selects `internal`, the origin is canonical HTTPS and the key is 64 hex characters, and refuses if the
   worker file already has one of the keys.
   ```bash
   sudo /usr/bin/python3 -I - /opt/ai-hr/.env.production <<'PY'
   import json, os, re, subprocess, sys
   web, target = sys.argv[1], '/etc/aihr/import-worker.env'
   keys = ['AUTH_PROVIDER', 'AUTH_PUBLIC_ORIGIN', 'AUTH_SESSION_KEY']
   code = "const fs=require('node:fs'),{parseEnv}=require('node:util');const e=parseEnv(fs.readFileSync(0,'utf8'));const k=" + json.dumps(keys) + ";console.log(JSON.stringify(Object.fromEntries(k.filter(x=>e[x]!==undefined).map(x=>[x,e[x]]))));"
   with open(web, 'rb') as f:
       values = json.loads(subprocess.run(['/opt/node22/bin/node', '-e', code], input=f.read(), capture_output=True, check=True).stdout)
   ok = (values.get('AUTH_PROVIDER') == 'internal'
         and re.fullmatch(r'https://[a-z0-9.-]+(:[0-9]+)?', values.get('AUTH_PUBLIC_ORIGIN', '')) is not None
         and re.fullmatch(r'[a-fA-F0-9]{64}', values.get('AUTH_SESSION_KEY', '')) is not None)
   if not ok: sys.exit('web environment does not select a valid internal provider (values withheld)')
   current = open(target, encoding='utf-8').read()
   if any(re.search('^' + k + '=', current, re.M) for k in keys): sys.exit('worker environment already has an AUTH key; review it')
   if current and not current.endswith('\n'): sys.exit('worker environment does not end with a newline; review it')
   added = ''.join(k + '=' + json.dumps(values[k], ensure_ascii=False) + '\n' for k in keys)
   temporary = target + '.new'
   fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
   with os.fdopen(fd, 'w', encoding='utf-8') as f: f.write(current + added)
   os.chown(temporary, 0, 0); os.rename(temporary, target)
   print('added', ', '.join(keys), '(values withheld)')
   PY
   sudo sha256sum /etc/aihr/import-worker.env
   ```
   Each line is `KEY="value"`, the installer's format, which both the staging and the production parsers accept.
5. **Restart the worker** so it loads the file (a graceful SIGTERM; the current unit of work finishes first):
   ```bash
   sudo systemctl restart aihr-bank-import.service
   sudo journalctl -u aihr-bank-import.service --since '-2 min' --no-pager | grep -E 'Import worker (started|serves|supervisor)|AUTH_PROVIDER' || true
   cd /opt/ai-hr && node --env-file=.env.production --import tsx scripts/check-import-worker.ts
   ```
   Expect `Import worker started` and no `AUTH_PROVIDER/AUTH_PUBLIC_ORIGIN/AUTH_SESSION_KEY are missing` line.
   `check-import-worker` ([EMPLOYEE-IMPORT.md](../systemd/EMPLOYEE-IMPORT.md)) exits 0 when a live worker serves
   every kind.
6. **Acceptance with fictional data.** Use a fictional person in a fictional staging company whose work email is the
   owner's chosen test inbox, with no login and no pending invitation. As a group administrator, open Users →
   By Batch Send Invitation, select only that person and send. Then check:
   - the batch finishes with that person as "Email recorded as sent", and Email log shows the delivery as sent;
   - the email arrives in the test inbox (check junk mail). Its link uses the staging origin;
   - opening the link, choosing a username and password and enrolling an authenticator creates the login. The new
     login is linked to that person through the invitation only, never by matching email;
   - denied path: a user without the group administrator role cannot open or start the batch.
   Record the outcome privately (no address, link or token in tracked files).
7. **Finish.** `finish` the lease with the evidence reference. At the next staging update, the helper needs
   `--previous-worker-env-sha256` set to the receipt's `selectedEnvironmentSha256` you read in step 3.

**Rollback:** restore the backup (`sudo install -m 0600 -o root -g root <backup> /etc/aihr/import-worker.env`) and
restart the worker. Batch invitations then fail again as before; nothing else changes. Keep the backup privately until
the next update has activated with the new receipt, then remove it.

## Production: separately authorized configuration window

Production needs the owner's explicit go-ahead for this change, separate from any release installation. Follow
[the production release handoff](../../docs/PRODUCTION-RELEASE-HANDOFF.md):
- verify the target first (section 1 and section 4): private SSH alias, service identities, installed SHA/build and the
  web provider;
- retain the private configuration backup;
- record the change in the private release record.

It is a configuration change, not a release: no package is published and no board item moves.

1. Confirm the staging procedure above passed and was accepted. Confirm the preconditions on the production target.
   On the customer layout the web environment is `/etc/aihr/runtime.env`. The worker host may be a different VM from
   the web: run the steps on the host that runs `aihr-bank-import.service`, and copy values only through the
   operator's private channel. Never use chat or a tracked file.
2. The owner checks or configures the production SMTP connection in Email delivery, as in staging step 2.
3. Back up, record the digest and receipt, copy the three settings (staging step 4, with the production web
   environment path) and restart the worker (staging step 5), running the readiness check with the production web
   environment.
   The production parser also accepts the `KEY="value"` lines.
4. Acceptance uses only an isolated fictional fixture that the owner approves, sent to the owner's chosen test
   inbox, with the same checks as staging step 6. Never invite a real employee as a test.
5. At the next production update, pass `--previous-worker-env-sha256` (the receipt value from step 3) to
   `production-drain`, `production-activate` and, if used, `production-rollback`.

Rollback is the same as on staging: restore the backup and restart the worker.

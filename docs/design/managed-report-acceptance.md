# Managed Reports controlled Linux acceptance

This is source preparation for approved5f9c8062 and ADR0119. No VM, installer, bundle, fixture, test, SMTP, memory or cron outcome has run. The normal app/release gate and actual report-builder experience remain separate requirements.

The existing installer uses fixed system paths, real Linux peer credentials, dedicated OS identities and cgroups. This fixture therefore requires a dedicated disposable Linux VM. Docker on a shared host is insufficient for this contract. The presence of Docker, Colima or Lima on the developer Mac does not prove that such a VM or its prerequisites exist. Do not start one during another agent's resource window.

## Required graph and boundaries

One named database, ai_hr_report_delivery_acceptance, contains only the receipt-bound fictional tenant. Provisioning, hiring, compensation, Family, notification policy/consent, report and schedule writes use the actual authoritative owners. Direct owner inserts are limited to declared fictional login/grant/external-identity/operator enrollment. No report result, occurrence, authorization flag, consent revision, lease expiry or workbook is forged in SQL. The actual private queue/claim/start/finish functions retain authority over execution.

The owner is a real fictional super-admin; the recipient is a distinct real fictional HR admin and employment. Both map to actual verified local-provider accounts. The saved report is shared with the recipient's role. The installed mail UID resolves nonce-bound targets, checks the actual provider and opens only the separate app-role renderer's ID-bound workbook. The renderer has no SMTP/provider/migration credential. The local TLS sink accepts only owner@report-acceptance.invalid and recipient@report-acceptance.invalid and has no relay/upstream capability.

A root-owned marker, exact database/issuer/relay guards, reviewed bundle hashes, clean root-owned candidate and exclusive owned lock are prerequisites, not substitutes for app authorization. The runner never changes permission semantics, disables RLS, accepts caller-supplied workbooks, initializes a provider mock, creates a VM/database/role, installs CA trust, or invents provider verification.

The parent must hand over both test slots and the dev DB/resource window before any build, fixture, VM or Linux execution. Hold those resources around the host-to-VM session using the established testlock/devdb-lock scripts. Inside the dedicated VM, the runner exclusively creates /run/aihr-report-acceptance.lock. Cron is stopped during controlled cases and no other managed timer/user cron is permitted. Only the final case starts the preinstalled existing minute runner. A40-minute watchdog stops owned child groups, test cron/managed units and the local sink, and closes both DB pools. Failure preserves private evidence and the disposable DB; it never resets a started journey.

## Source readiness sequence

After resource handoff, use the clean integrated board-oct15 candidate with real dependencies:

```sh
pnpm -C /Users/zenlam/Projects/ai-hr/.claude/worktrees/board-oct15 exec vitest run test/employee-master-delivery-config.test.ts test/employee-master-managed-delivery.test.ts test/employee-master-report-handler.test.ts test/employee-master-delivery-standing.test.ts test/employee-master-delivery-db.test.ts test/employee-master-consent.test.ts test/employee-master-schedule.test.ts test/employee-master-attachment-smtp.test.ts test/employee-master-delivery-fixture.test.ts
pnpm -C /Users/zenlam/Projects/ai-hr/.claude/worktrees/board-oct15 exec tsx scripts/build-report-email-upgrade.ts
pnpm -C /Users/zenlam/Projects/ai-hr/.claude/worktrees/board-oct15 exec esbuild scripts/dev-managed-report-acceptance.ts --bundle --platform=node --target=node20 --format=cjs --outfile=deploy/identity-email/generated/report-acceptance.cjs
shasum -a 256 /Users/zenlam/Projects/ai-hr/.claude/worktrees/board-oct15/deploy/identity-email/generated/report-acceptance.cjs /Users/zenlam/Projects/ai-hr/.claude/worktrees/board-oct15/deploy/identity-email/generated/report-upgrade.cjs
```

These are coordinated commands, not permission to run outside the lock handoff. Use the test harness namespace assigned by the parent; its DB test machinery is independent of the fixed Linux VM database. The new attachment regression exercises real implicit-TLS SMTP and parses the emitted XLSX. Existing managed-service tests mock rendering/SMTP; their green result alone cannot demonstrate installed Linux execution.

Before installation, prove the complete migration chain including0542,0546 and0549 is applied on the disposable database under the actual restricted migration owner. The current restricted-owner regression recreates report_target, not the entire pending migration chain. Full restricted-owner DDL rehearsal and grant/FORCE-RLS evidence remain required.

## Dedicated Linux prerequisites

The VM must run the reviewed Node20 runtime and have systemd running, cgroup v2 memory.peak/memory.events, local PostgreSQL5432, the restricted ai_hr_app and aihr_identity_email roles and separate migration credentials. The existing accepted identity/workflow mail installation and real local Keycloak service must already be present. No normal/production installation may be repurposed.

Use a clean, root-owned candidate at /srv/aihr-report-acceptance/candidate, with its own real node_modules and no .env.local/.env.production. Root stages reviewed artifacts at /root/aihr-report-acceptance, files0600 and directory0700:

- fixture.cjs: the report-acceptance.cjs bundle.
- report-upgrade.cjs: the existing build-report-email-upgrade artifact.
- ca.pem, server.pem and server.key: disposable TLS certificate chain/key with IP SAN127.0.0.1; Publish the same public CA as root-owned0644 /usr/local/share/ca-certificates/aihr-report-acceptance.crt and configure the mail unit's own NODE_EXTRA_CA_CERTS to that readable path; /root is deliberately inaccessible to the mail UID. The actual provider's separate SMTP-test realm must also trust the CA through its real supported trust store. The fixture itself reads that CA at process startup. Do not disable certificate validation.
- runner.env: only DATABASE_URL, MIGRATION_DATABASE_URL and optionally IDENTITY_EMAIL_SOCKET=/run/aihr-identity-email.sock. Both DB URLs must use127.0.0.1:5432/ai_hr_report_delivery_acceptance, with ai_hr_app and the separate migration role. No query overrides are allowed. Keep credentials out of shell arguments, logs and this document.

The existing private email-agent.env must point to the same named DB through aihr_identity_email, use IDENTITY_EMAIL_TEST_RECIPIENT=owner@report-acceptance.invalid, WORKFLOW_EMAIL_ISSUER=https://report-acceptance.invalid/identity/realms/ai-hr and WORKFLOW_EMAIL_ORIGIN=https://report-acceptance.invalid. Actual local provider clients/credentials remain private to their accepted owner. No provider secret is put in runner.env or renderer.env.

Create exactly these real fictional local-provider accounts before fixture preparation: usernames report-delivery-owner / report-delivery-recipient, the corresponding fixed addresses above, enabled and emailVerified=true, no federation/service-account identity or outstanding required action. The fixture checks the real provider before creating any application login binding. Provide the dedicated base app's normal Keycloak authentication/UI connection so the operator can use actual Email settings during preparation. Browser routing/DNS/certificate setup for this fictional installation remains a VM provisioning prerequisite.

Root creates /etc/aihr-report-acceptance.json, mode0600, with this reviewed structure (replace placeholders with actual reviewed hashes/UUID/SHA; placeholders cannot pass):

```json
{
  "version": 1,
  "purpose": "disposable-managed-report-acceptance",
  "database": "ai_hr_report_delivery_acceptance",
  "candidateRoot": "/srv/aihr-report-acceptance/candidate",
  "candidateSha": "<clean integrated40-character SHA>",
  "runId": "<fresh UUID>",
  "fixtureSha256": "<reviewed fixture SHA256>",
  "upgradeSha256": "<reviewed upgrade SHA256>",
  "caSha256": "<reviewed CA SHA256>"
}
```

Preinstall exactly one root crontab command on this dedicated VM, leaving cron.service stopped and ubuntu/postgres crontabs empty. It is the existing provisioning/report minute runner, not a new scheduler:

```cron
* * * * * cd /srv/aihr-report-acceptance/candidate && /usr/local/lib/aihr-identity-email/node --env-file=/root/aihr-report-acceptance/runner.env --import tsx scripts/provision-runner.ts >> /var/lib/aihr-report-acceptance/cron.log 2>&1
```

Read it back with crontab -u root -l. The runner refuses another command, other managed timer or an active cron daemon at startup. It starts this daemon only for the final real two-tick proof and stops it in cleanup. This VM root-cron proof does not assert that a production Ubuntu crontab is installed.

## Preparation and verification commands

On the marked disposable VM only, after root staging/digest review and resource handoff:

```sh
sudo env NODE_EXTRA_CA_CERTS=/root/aihr-report-acceptance/ca.pem /usr/local/lib/aihr-identity-email/node --env-file=/root/aihr-report-acceptance/runner.env /root/aihr-report-acceptance/fixture.cjs prepare
```

Preparation creates only the canonical fictional tenant/employments and explicit fixture identities, then serves the local TLS sink. Use the actual enrolled owner's System Settings → Email delivery controls to Save/Test/confirm receipt/Apply TLS127.0.0.1:24656, authentication off, from owner@report-acceptance.invalid. The provider's test message must actually reach the sink. Create the root-owned /var/lib/aihr-report-acceptance/<runId>/stop file to end preparation cleanly. Preserve fixture.json; do not delete/reset the DB or invent managed state files. Preparation supplies no delivery PASS.

Then run:

```sh
sudo env NODE_EXTRA_CA_CERTS=/root/aihr-report-acceptance/ca.pem /usr/local/lib/aihr-identity-email/node --env-file=/root/aihr-report-acceptance/runner.env /root/aihr-report-acceptance/fixture.cjs verify
```

Verification validates the already tested/applied canonical relay and executes the reviewed upgrade with AIHR_REPORT_RENDER_DATABASE_URL derived only from the fixed app-role URL. The equivalent standalone installation and probe commands, for an explicitly approved private installation session, are:

```sh
sudo /bin/sh -c '. /root/aihr-report-acceptance/runner.env; export AIHR_REPORT_RENDER_DATABASE_URL="$DATABASE_URL"; exec /usr/local/lib/aihr-identity-email/node /root/aihr-report-acceptance/report-upgrade.cjs'
sudo /usr/bin/python3 -I /usr/local/lib/aihr-identity-email/verify-report-isolation.py
sudo curl --fail --silent --show-error --unix-socket /run/aihr-identity-email.sock -H 'content-type: application/json' -d '{"op":"status"}' http://localhost/v1/reports
```

The probe proves kernel peer/DAC/artifact boundaries and configured memory limits. It does not generate an HR report or send SMTP. The verification fixture additionally checks real selected-recipient MIME/XLSX content, unselected-sensitive-column absence, post-generation consent/compensation/provider/report revocation, rejection and lost ACK, an actual mail-process kill after DATA/start, pending nonce replacement after actual lease expiry, ten-minute actual artifact expiry, twenty-file budget/cleanup with both successful renderer removal acknowledgement and exact owned-path ENOENT proof, actual oversized canonical Family data, and measured mail/renderer/aggregate memory peaks with no cgroup OOM kill. It then lets two actual cron ticks exercise reports.employee-master.deliver and proves a single additional delivery.

All recurrence waits use actual future minutes and real lease/expiry time; no consent/due/lease SQL is backdated. The pending-lease test models a runner dying before IPC by abandoning its lease; only the started-mail case kills an actual installed process. A receipt is written only after every required assertion in that sequence and successful owned-resource cleanup. Failure preserves the journey and failure.json; verification-started prevents rerun/reset. The private installer rollback snapshot is retained, and the VM/database/artifacts remain available for diagnosis. Cleanup stops only the validated fixture units/cron/sink/owned child groups and closes fixture DB pools. It identifies an in-flight cron Node process by exact argv/cwd/root UID/start time, terminates only those owned PIDs, and proves they exited before closing the fixture pools; stopping cron alone would not stop an existing tick. Do not call the fixture a production-release receipt.

## Required outcomes still outside this source runner

- Provisioning the VM, PostgreSQL roles/database, actual provider/base installation, CA trust, app authentication and guarded root marker has not been done. Missing prerequisites must refuse.
- Linux bundle loading, TypeScript, regressions and every runtime fixture outcome are UNRUN. The20MB setup deliberately uses bounded canonical Family rows and must actually reach the intended limit; another failure cannot stand in for attachmentTooLarge. Memory sampling must observe both real processes, or verification refuses. The receipt records Linux architecture and Node version; ARM Linux proof cannot stand in for the separate production x86_64/node20 build/migration rehearsal. Start with enough time before the KL date boundary to finish the40-minute window; crossing it refuses instead of substituting current data into a past-date report.
- Actual weekly/monthly UI save/reopen/off-by-default behavior, owner suspension, employee transfer, cross-tenant/company salary denial, all locales/themes/viewports and full report-builder/export journeys retain the approved acceptance map. This fixture's concrete revocation controls do not replace them.
- The normal installed production cron must separately be inspected with crontab -l, and Scheduled Actions must show the canonical report job outcome. No production install, real mail or production mutation is authorized by this document.

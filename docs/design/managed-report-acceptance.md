# Isolated internal Report delivery acceptance

This staged source replaces the old Keycloak-only fixture. It has **not been executed, built, typechecked or tested** in this checkpoint. It creates no consent, Auth credential, verified-MFA flag, external binding, SMTP configuration or alternative scheduler. The consent-page/action fix is a separate prerequisite. Source checks and canonical readbacks do not replace parent-observed human interactions.

FACT supplied by the parent: the owned, stopped Lima VM is `board16-report-linux`, `LIMA_HOME=/private/tmp/aihr-b16-lima`, Ubuntu24.04 ARM, with reviewed Node20.20.2 and Node22.23.1. `/opt/ai-hr` was at299; its isolated `ai_hr_report_delivery_acceptance` passed a restricted-owner rehearsal of460 journal entries through0553, including0543 and0552. **460 is a journal length.** These facts do not establish current source, human enrollment, TLS, installed services, SMTP or cron acceptance. The runner rechecks exact candidate and every applied SQL hash/when; do not recreate or reset that VM/database to hide drift. ARM evidence is separate from production x86/runtime/release evidence.

The first Mac manual report course remains `node scripts/dev-browser-original18.mjs --scenario=reports`, local5433 named `ai_hr_board18_reports_browser`, port3197. Its demo identities, absent Notifications entitlement and closed no-mail configuration intentionally cannot supply genuine delivery opt-in. Preserve its reports/receipts separately. Do not convert its demo actors or copy consent/Auth records into Linux.

## Explicit prerequisites, unavailable until prepared/reviewed

The isolated Linux candidate must be the exact clean integrated HEAD at `/opt/ai-hr`, root-owned/non-writable, with its actual built app running as a fixed non-root systemd unit **`aihr-report-acceptance.service`**. The runner never starts/installs that web unit. Keep the actual restricted app URL and `AUTH_PROVIDER=internal`, `AUTH_PUBLIC_ORIGIN=https://localhost:3543`, `AUTH_SESSION_KEY` in its private canonical configuration; no migration credential in web. Use the operator-reviewed Node22.23.1 runtime. Node20 remains solely the unchanged legacy provisioning prerequisite.

Canonical Auth requires HTTPS even for localhost. Use a genuinely trusted isolated certificate and loopback-only VM forward to browser port3543 (check/reserve it first); no HTTP exception, certificate bypass, `rejectUnauthorized:false`, browser insecure flag or production sfm-certificate dependency is introduced. Root must separately review/provide the CA/trust/proxy/forwarding prerequisites. The sink requires a certificate valid for127.0.0.1, implicit TLS24656 and no upstream relay. Actual web and fixture must already trust the same root-owned public bundle at `/usr/local/share/ca-certificates/aihr-report-acceptance.crt` through `NODE_EXTRA_CA_CERTS`. Transport installer alone propagates that public trust to sender. The runner performs no trust changes.

Use actual `ai_hr_app` (no ownership/membership/bypass), restricted canonical migration owner and separately prepared `aihr_identity_email` sender role. Exact localhost5432 database only. Sender setup/privileges remain the reviewed internal installer’s responsibility. Root-private `/root/aihr-report-acceptance/owner.json` has exactly `{"databaseUrl":"<operator-authorised existing owner URL>"}`. Never put its value in argv/logs. The app URL/key/origin come only from the **actual running web PID**, with UID/cgroup/PID readbacks, not this file or caller overrides.

Build only under the parent's full resource handoff from the final candidate (commands below are NOT RUN):

```sh
pnpm exec tsx deploy/identity-email/build-internal-reports.ts
pnpm exec esbuild scripts/dev-managed-report-acceptance.ts --bundle --platform=node --target=node22 --format=cjs --outfile=deploy/identity-email/generated/report-acceptance.cjs
shasum -a 256 deploy/identity-email/generated/report-acceptance.cjs deploy/identity-email/generated/internal-report-upgrade.cjs
```

No import.meta/top-level-await CLI assumption is needed. Stage those exact reviewed bundles root0600 as `/root/aihr-report-acceptance/{fixture.cjs,internal-report-upgrade.cjs}`, plus root0600 `ca.pem`, `server.pem`, `server.key`. Use only the actual reviewed root-owned Node22.23.1 executable. Root0600 `/etc/aihr-report-acceptance.json` is a **strict version2** marker:

```json
{
  "version": 2,
  "purpose": "disposable-internal-report-acceptance",
  "vm": "board16-report-linux",
  "database": "ai_hr_report_delivery_acceptance",
  "candidateRoot": "/opt/ai-hr",
  "origin": "https://localhost:3543",
  "runId": "<fresh UUID>",
  "candidateSha": "<exact clean HEAD>",
  "machineSha256": "<SHA256 of actual /etc/machine-id bytes>",
  "fixtureSha256": "<reviewed fixture bundle SHA256>",
  "installerSha256": "<reviewed internal installer SHA256>",
  "componentsSha256": "<reviewed private components.json SHA256>",
  "caSha256": "<reviewed ca.pem SHA256>",
  "certificateSha256": "<reviewed server.pem SHA256>",
  "serverKeySha256": "<reviewed private server.key SHA256>",
  "nodeSha256": "<reviewed executing Node22.23.1 bytes SHA256>",
  "runtimePath": "<its actual absolute nonsymlink executable path>",
  "webUnit": "aihr-report-acceptance.service"
}
```

Root0600 `components.json` in the staging directory contains exactly eight basename→SHA256 pairs from the reviewed builder output: internal-report-agent.cjs, report-auth-broker.cjs, report-renderer.cjs, internal-report-schedule.cjs, internal-report-tick, report-auth-peer.py, renderer-peer.py and verify-internal-report-isolation.py. No paths/extra files. Root reviews these against the same candidate/installer before pinning the sidecar; verify compares every installed byte hash. Canonical installer/probe retain unit substitutions and UID/limit authority; this fixture does not recreate them. Preserve the parent’s actual Linux app build/launch receipt for the candidate separately: a Git SHA/active PID alone cannot prove a Next build’s provenance.

Marker hashes are operator-reviewed pins, not permission to accept untrusted files. Root safe-parent/single-link/descriptor checks still apply. The runner uses one exclusive `/run/aihr-report-acceptance.lock`,40-minute watchdog and bounded child groups/pools; a5-minute cleanup failsafe prevents indefinite cleanup. An interrupted/failed started verification is preserved and cannot be automatically rerun/reset. No productive installation may satisfy this marker.

## Stage1: prepare once

All cron initially stopped. Invoke the **root-staged bundle**, with the reviewed Node executable and already-approved public CA setting, as root:

```sh
NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/aihr-report-acceptance.crt <reviewed-node22> /root/aihr-report-acceptance/fixture.cjs prepare
```

Fresh System-only target is required. Canonical `provisionTenant` creates one fictional tenant with Notifications and Payroll; canonical Org/hire/Compensation owners create the department, two receiving employments and dated3500MYR source facts. The canonical provisioned owner app_user is reused. Only limited fictional initial login/bootstrap grants use the owner insertion seam; the recipient's actual `hr_admin` group grant uses `assignRole`. No new report or schedule is created. The canonical provisioning invitation is discarded, never used as a mail proof.

Private `/var/lib/aihr-report-acceptance/<runId>/fixture.json` declares distinct user/person/employment UUIDs and actual routes. Preparation exits and closes pools. Existing/partial/unknown state refuses; no Demo seed or reset. Both actors are actual group HR administrators so the real root enrollment helper can select them without broadening its policy.

## Stage2: genuine human configuration and installation pause

Start the same reviewed bundle in `configure` mode; it serves only the local TLS sink:

```sh
NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/aihr-report-acceptance.crt <reviewed-node22> /root/aihr-report-acceptance/fixture.cjs configure
```

In a separate trusted root terminal, with the exact installed Auth configuration and migration owner supplied privately, use **existing** `scripts/internal-auth-bootstrap.ts` for each exact private-manifest user UUID. No generated fixture password, OTP or recovery code is accepted as human evidence. Supply temporary passwords privately on stdin, never in argv/environment/chat/logs:

```sh
<reviewed-node22> --import tsx scripts/internal-auth-bootstrap.ts --app-user-id=<owner UUID> --organization=report-acceptance --username=report-delivery-owner --email=owner@report-acceptance.invalid --password-stdin --installation-owner
<reviewed-node22> --import tsx scripts/internal-auth-bootstrap.ts --app-user-id=<recipient UUID> --organization=report-acceptance --username=report-delivery-recipient --email=recipient@report-acceptance.invalid --password-stdin
```

Only the owner gets installation SMTP authority. Both humans use actual `/login`, change their temporary password, enroll/prove their authenticator and retain recovery codes privately. Do not bootstrap scoped Mac HR_B or invent an employment to make enrollment pass.

Owner `/admin/settings/email`: Save a draft with host127.0.0.1/port24656, implicit TLS, auth off, From owner@report-acceptance.invalid; Test, inspect actual private sink receipt (`configuration-mail-N.eml`), explicitly confirm receipt, Apply. No raw SMTP relay or draft is stored in fixture manifests. Owner `/admin/settings/notifications`: explicitly enable Employee Master reports. Recipient `/me/notifications`: choose exact own receiving employment, opt in and Save through the canonical provider-aware action/page.

Now use the reviewed **internal** installer and probe, following [transport prerequisites](managed-report-internal-transport.md). Supply its actual web unit, reviewed Node and separately authorised sender/runner URLs privately; no caller key override:

```sh
<reviewed-node22> /root/aihr-report-acceptance/internal-report-upgrade.cjs --install-internal-reports
/usr/bin/python3 -I /usr/local/lib/aihr-identity-email/verify-internal-report-isolation.py --web-unit aihr-report-acceptance.service
/usr/local/lib/aihr-identity-email/internal-node /usr/local/lib/aihr-identity-email/internal-report-schedule.cjs --plan aihr-report-acceptance.service
```

The canonical handoff must see its one exact **existing non-root** provisioning line, fixed Node20 path/bytes and full unchanged scheduler inventory. The VM currently has no cron setup: its separately reviewed owned prerequisite must be prepared first; this fixture never fabricates a cron or changes user crontabs. No unrelated timer/sweep can substitute. Keep cron stopped until verify. Record the actual reviewed inventory SHA256.

Owner creates **two real UI reports**, each shared to HR Admin, saved as-at the fixture date, company only, exactly Code + Full name, no Drafts/extra fields; preview/save/reopen. Enable weekly/current weekday and monthly/current day, exact recipient user+employment, near-future times. Set both next occurrences30seconds–4minutes ahead **after installation/plan** so no fake due timestamp is needed. Record actual report/schedule UUIDs and UI screenshots separately.

Write root0600 `human-ready.json` in the private run directory, strict shape:

```json
{"version":1,"runId":"<same UUID>","candidateSha":"<same HEAD>","reviewedInventorySha256":"<actual reviewed plan SHA256>","reports":{"weekly":{"reportId":"<UI UUID>","scheduleId":"<UI UUID>"},"monthly":{"reportId":"<different UI UUID>","scheduleId":"<different UI UUID>"}}}
```

There are no `verified`, consent or MFA booleans. Configure re-reads exact binding tuples through the fixture owner, canonical explicit-Tx Credential/assertActiveCredential and active-relay owners through the app role, and actual recipient opt-in through Notifications. Only safe identity/version/relay-revision/watermark metadata is persisted. This readiness check is not atomic send authority; the broker repeats final authority inside its canonical transaction. Configure exits, closes sink/pools and writes `configured.json`; it establishes no send PASS.

## Stage3: integrate/resume verification once

Immediately restart the same staged bundle in `verify` mode. If timing/candidate/receipt changed, refuse and preserve; do not backdate schedules or delete receipts to retry.

```sh
NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/aihr-report-acceptance.crt <reviewed-node22> /root/aihr-report-acceptance/fixture.cjs verify
```

It repeats canonical human/source/relay readbacks and installed probe, re-plans exact inventory, then invokes only installed `--activate` handoff. It never writes a cron/marker itself. Two real minute ticks deliver both declared actual UI weekly/monthly reports. Check exact immutable reportVersion/scheduleRevision/recipient pair, row count, pinned artifact SHA256/length/MIME and parsed real SMTP XLSX containing both fictional employee codes; preserve actual MIME/workbook privately. A further unchanged tick must produce neither extra occurrence nor SMTP. Schedule as-at stays exactly saved, never hidden rolling date.

Cron stops and all actual default/dedicated runners must become idle under the canonical closed classifier; unknown processes refuse. Active admission remains until cleanup, preventing legacy fallback while controlled fault copies run. These copies are canonical owner-created **fixture cases**, not UI completion: permission/report change after generation, real local SMTP rejection/lostACK, unstarted180s lease fresh nonce, actual sender process kill after started then uncertainty/no retry, actual10-minute artifact expiry,20-artifact budget and acknowledgement+path-absence cleanup, actual Family-derived20MB workbook refusal. Recurrence/lease/expiry waits are real time; no due/consent/lease row is backdated. In the final case the recipient must withdraw report email in the actual own form while its pending lease is still live; a private `withdraw-request.json` identifies the exact subject/occurrence. The runner waits for canonical ineligibility and refuses if the lease expires first. It never writes or restores consent.

Measure actual sender+broker **combined192MiB** dispatch slice, sender192/broker192, renderer512 and outer768 peaks, no OOM. A missing peak is Unknown/refusal, not zero/PASS. The40-minute watchdog may expose a feasibility/timing failure; do not raise limits or silently omit a case. Root fixture process is outside these service budgets; no aggregate host-memory claim is made.

Before canonical imports or writers the runner changes into its validated root-owned exact candidate. Before activation it requires the canonical scheduling lock to be absent and captures absent marker/cron, existing receipt identities and exact scheduler/source/runtime/instance pins. If activation fails after publishing a paused marker, cleanup discovers only the one new canonical receipt matching that baseline and invokes the canonical exact-installation rollback; an orphan receipt alone remains as history. Unknown or changed ownership refuses cleanup rather than unlinking files.

Cleanup first awaits absence of every captured detached child group (including descendants after leader exit), propagating signal permission failures and requiring an independent inventory even after ESRCH. A bounded TERM/KILL drain cannot release the lock while members remain. Interruption stops admission and joins the main writer before cleanup; if it cannot settle within two minutes, exit retains the lock for inspection. Cleanup calls only the canonical exact-installation scheduling rollback, proves unchanged original scheduler inventory, drains private one-shot workers before discovering only its exact occurrence/lease artifacts, requires renderer acknowledgement plus absence, and stops its used sender service/sink/child groups and closes pools. It leaves the web unit, installed sockets/runtime, original cron bytes, Node20 and private evidence intact. Cleanup requires canonical scheduling lock absence after the owned child drain, before partial activation recovery, and again immediately before releasing the outer lock. A killed canonical writer may leave its own lock even before publishing a receipt; that remains unresolved and is never blindly removed. Only successful cleanup closes/removes the exact inode- and PID-bound acceptance lock. A cleanup failure retains that lock and withholds completion. A complete `verification.json` is written **only after cleanup succeeds**. Failure retains a finite private failure stage; no private SQL/key/provider error is printed and no automatic retry occurs.

Missing/incomplete prerequisites remain: current exact candidate build/bundles, trusted isolated HTTPS/port forward, actual non-root web unit/config, private sender role/runtime installation, canonical legacy cron prerequisite/inventory, human enrollment/MFA/SMTP/consent/report interactions and all actual executions. The installed client now enforces exact broker cgroup/InvocationID retirement before returning JSON, and the isolation probe contains real sender/renderer namespace checks against a pinned key-bearing process. Their actual execution, held-broker no-early-SMTP observation, first-connect ordering and hidden environment denial still need dedicated runtime proof beyond post-call idle/peak checks. Identity disable/rebind/inactive-owner/relay-Apply races, lost broker EOF, hostile peers/grants and installation failure rollback still need their canonical regression and actual interaction receipts; this minimal course does not claim them. Source preparation is not Linux acceptance, human Auth acceptance, production activation or release-gate completion.

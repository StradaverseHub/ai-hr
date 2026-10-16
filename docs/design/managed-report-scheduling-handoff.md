# Internal report scheduling handoff

SOURCE ONLY. No cron, VM, process, database or installation command in this document has been run for
this patch. The base transport installer still changes no cron or admission marker. Full provisioning
remains key-bearing; this course suppresses only its report stage and gives reports a key-free tick.

## Preserved owners and prerequisites

The only supported starting course is exactly one existing, non-root user's provisioning entry:

```
* * * * * cd /opt/ai-hr && deploy/cron-alert.sh provision /home/ubuntu/aihr-cron-logs/provision.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/provision-runner.ts
```

Every user crontab is read and hashed, never rewritten. `/etc/crontab`, other `/etc/cron.d` files and
systemd timers with their triggered service source are inventoried too. Unknown/duplicate report
schedules refuse. Other notification, flock, provisioning and holiday jobs retain their existing
commands, order, runtime and environment. Node20 is never written or replaced; its actual resolved
executable path and bytes are pinned for activation/rollback. This is a trusted host inventory review,
not a claim to detect arbitrary malicious-root code or indirect scheduling concealed in unrelated scripts.

Before execution, install the reviewed internal transport and genuine prerequisites, and deploy the
same candidate containing `lib/employee-master-dispatch.ts` and the runner guard. Build the root-owned
scheduling bundle from that candidate; its two fixed source SHA256 values must match deployed files.
The actual active web unit must use `/opt/ai-hr`, fixed canonical internal Auth configuration and the
same app database. The root-owned separate `internal-node` must actually run Node22.13+ or Node24;
Node20 does not satisfy this prerequisite. The base installer must already have written private0600
`/etc/aihr-internal-report/runner.env` from actual app settings and separately authorized owner URL.
No owner URL is accepted in scheduling CLI arguments.

The selected legacy username, group name, UID and primary GID come from the one exact existing cron owner. They
must be non-root and resolve consistently by both name and numeric IDs. Their identity metadata is
included in the reviewed inventory digest. The fixed system Python executable/parent chain and
root-owned launcher are checked before marker publication. The sender socket must already permit
that base GID; the handoff refuses rather than adding group membership. Launcher execution clears all
supplementary groups. If the existing deployment relies on supplementary DB socket permissions, this
course needs a separately reviewed prerequisite; it will not silently grant or retain them.

## Explicit commands after review and resource handoff

Run only the installed, root-owned bundled CLI with the installed separate Node runtime. Do not run
web-owned TypeScript as root. Replace `actual-web.service` with the independently verified actual unit.

```
sudo /usr/local/lib/aihr-identity-email/internal-node /usr/local/lib/aihr-identity-email/internal-report-schedule.cjs --plan actual-web.service
```

The plan prints a scheduler inventory SHA256 and existing cron username, no environment or process
arguments. Review the source/inventory and preserve that exact SHA256. Activation refuses if any
preexisting marker/owned cron file exists, the source guard is not deployed at the active candidate,
or the scheduler inventory changed. It supports a first installation, not silent replacement.

```
sudo /usr/local/lib/aihr-identity-email/internal-node /usr/local/lib/aihr-identity-email/internal-report-schedule.cjs --activate actual-web.service REVIEWED_INVENTORY_SHA256
```

Activation writes a private immutable receipt under `/var/lib/aihr-internal-report-schedule`, then
publishes public nonsensitive root0644 `/etc/aihr-internal-report-dispatch.json` in `paused` state.
The default process consults that marker immediately before its report stage. Paused/active suppress
only reports; absent preserves the old course; malformed/untrusted markers refuse reports without
falling back. Provisioning/reissue/holiday stages run before that check and remain unchanged.

The manager then enumerates relevant Linux processes, pins PID plus kernel start time, and waits for
all pre-handoff default/dedicated processes to exit. Exact known command/UID/cwd/executable forms only;
unknown relevant processes refuse. It does not kill anything. The wait is bounded to 15 minutes. New
default processes see the deployed guard and suppress reports while the marker exists. After drain,
source/active candidate, all scheduler inventory and Node20 are rechecked. Only then is the exact new
root0644 file `/etc/cron.d/aihr-internal-reports` created without replacing anything:

```
# AIHR owned internal Employee Master dispatch v1
* * * * * root /usr/local/lib/aihr-identity-email/internal-report-tick
```

The file is compared to the compiled canonical source, not a supplied hash of arbitrary content.
After another inventory check the marker becomes active. The root Python launcher checks safe root
parents/regular single-link files, parses the closed quoted env as data without shell evaluation,
checks exact runner identity, obtains a nonblocking lock, then clears groups and drops GID/UID before
execing Node. The root lock descriptor remains inherited through exec. The non-root Node process
rechecks active marker, identity, source pins, database instance, exact cron bytes and runtime/version
before any application imports. A busy lock skips a tick. A paused launcher exits quietly. Neither
private env files nor their URLs enter argv, stdout or logs.

Failures after pause leave admission paused, never automatically resume legacy dispatch. An exclusive
root manager lock prevents cooperating activation/rollback operations. A crashed manager leaves its
lock for explicit inspection; the next command will not steal it. Receipt filenames contain the
installation UUID, also printed on successful activation; inspect that private directory after a
partial failure rather than guessing state or deleting files.

## Rollback

```
sudo /usr/local/lib/aihr-identity-email/internal-node /usr/local/lib/aihr-identity-email/internal-report-schedule.cjs --rollback INSTALLATION_UUID
```

Rollback requires the exact private receipt/marker identity. It pauses active admission, drains all
existing dedicated processes with the same bounded/unknown-process refusal, and checks unchanged
preexisting scheduler inventory and Node20 path/bytes. It removes only its exact owned cron file,
then removes the marker last. Default reports resume through the unchanged original crontab. A
partial installation with no owned cron file can follow this course. Unexpected file/inventory
changes refuse and retain paused admission. Receipts are retained; neither user crontabs nor other
scheduler files are overwritten. Roll back scheduling before removing transport/runtime files.

Root ownership, safe parent chains, descriptor stability checks, no-replace initial publication and
fresh byte comparison protect this course from unprivileged file replacement and cooperating root
operations. Compare+rename/unlink is not a kernel CAS against an uncooperating or malicious root that
changes a path between comparison and mutation. Root remains the installation authority. External
scheduler edits must be frozen during handoff; detected changes refuse, and this implementation does
not claim to constrain an adversarial root.

Changing either pinned source file after activation makes report admission refuse until a reviewed
handoff is restored; it does not silently accept a newly deployed guard. Plan upgrades around paused
admission/rollback and rebuild the bundle from the eventual exact candidate.

## Prepared checks, not acceptance evidence

`test/employee-master-dispatch.test.ts` prepares strict marker/runtime/source/DB/cron tests, exact
process classification and PID-lifetime checks, closed Python env-parser controls including literal
shell metacharacters, privilege-drop/lock descriptor source guards, activation/rollback ordering and
AST proof that the only user-crontab operation is `-l`. The existing runner suite adds pre-import
active admission, bad-marker refusal and default report-only suppression/legacy preservation.
These tests, semantic types and bundle builds remain unrun in this checkpoint.

Actual Linux requirements remain: root DAC/UID/GID proof, lock FD inheritance through Node, real
process enumeration/drain under load and PID reuse, refused malformed/unexpected files, unchanged
crontab/Node20 receipts, two real isolated report ticks plus rollback, service memory/crash/no-retry,
canonical Auth/consent/artifact authorization and local TLS SMTP attachment proof. No production,
mail, consent or human authentication acceptance is implied by this source.

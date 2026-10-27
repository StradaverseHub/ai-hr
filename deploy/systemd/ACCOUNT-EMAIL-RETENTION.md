# Account-email retention maintenance

Deployment does not enable this timer. Never delete is the default policy; enabling a finite policy requires the installation email administrator's explicit acknowledgement.

The service executes only the system PostgreSQL 16 client and the fixed `app.account_email_retention_prune()` SQL function. Do not substitute web-writable application scripts, Node dependencies, shell wrappers or the web service's full environment when using an owner database connection.

Use a dedicated `aihr-maintenance` non-login OS identity with an unshared primary group. Keep `/etc/aihr-account-email-retention` root-owned, mode 0750, with that dedicated group; keep `pg_service.conf` root-owned, mode 0640, readable only by the dedicated group. Its `[aihr_email_retention]` section contains the privately supplied owner connection fields. Credentials never belong in source, command-line arguments, chat or logs.

`deploy/email-retention-maintenance.py` is the bounded helper for the reviewed staging release, not a general-purpose installer. It pins the source/build and migration watermark, preserves Never delete, refuses conflicting files/identities, and checks unchanged protected-record counts. Its `recover` mode validates the existing units and a completed zero-removal invocation before enabling the timer; it does not rerun cleanup or overwrite files. Run only the reviewed, hash-bound operator packet with sudo entry in the human operator's private terminal.

Successful inactive oneshot services may have their `ExecMain*` metadata cleared by systemd garbage collection. Do not treat a default `Result=success` as execution evidence, or require a transient timestamp to survive. The helper correlates the dedicated client's zero result, executable and UID with root systemd start and completed-job journal records for the same invocation, and with the database's last-run timestamp.

After commissioning, verify the timer is enabled/active, its next scheduled invocation, and zero deletions under Never delete. Retain failed attempts and use bounded forward recovery; never silently overwrite private configuration or select finite retention for an owner.

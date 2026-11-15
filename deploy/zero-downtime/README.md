# Zero-downtime web releases (ADR-0181)

The web keeps serving through a release. The candidate starts beside the running release, Nginx moves traffic to it with a graceful reload, and the old release drains and stops. Rollback moves traffic back. Read [ADR-0181](../../docs/adr/0181-zero-downtime-web-release.md) for the decisions and limits, and the [production release handoff](../../docs/PRODUCTION-RELEASE-HANDOFF.md) for authority. Nothing here authorizes a production installation.

| File | Role |
| --- | --- |
| `release-web.sh` | Controller, run as root on the app VM. Every subcommand refuses on unexpected state. |
| `aihr-web@.service` | Slot unit (`blue` 3101, `green` 3102). Same hardening as `deploy/aihr-customer.service`. |
| `nginx-aihr-web.conf` | Site pieces: `upstream aihr_web` include, static union, proxy locations. |
| `migrate-online.sh` | Shipped in each release: its database sequence while the previous release serves. |
| `probe.mjs` | Continuous request probe through Nginx; non-zero exit on any failed request. |
| `rehearsal/` | Stand-in releases for the CI rehearsal only. |

## One-time adoption (needs explicit permission on each installation)

1. **Convert the site with no behaviour change.**
   - Write `/etc/nginx/aihr-upstream.conf` containing `upstream aihr_web { server 127.0.0.1:3000; keepalive 32; }`.
   - Include it at `http {}` level.
   - Change the site's `proxy_pass` to `http://aihr_web`, using the proxy parameters in `nginx-aihr-web.conf`.
   - Add the `/_next/static/` location.
   - Run `nginx -t && systemctl reload nginx`. Traffic still reaches the legacy `aihr` service.
2. **Install the slot unit:** `/etc/systemd/system/aihr-web@.service`, plus `/etc/aihr/web-slot-blue.env` (`PORT=3101`) and `/etc/aihr/web-slot-green.env` (`PORT=3102`). Then `systemctl daemon-reload`.
3. **Adopt:**
   ```sh
   sudo AIHR_WEB_VERIFY_URL=https://127.0.0.1/login AIHR_WEB_VERIFY_HOST=<site host> \
     deploy/zero-downtime/release-web.sh adopt 3000
   ```
   This copies the running tree into `releases/<BUILD_ID>`, starts it on `blue`, moves Nginx to `blue`, drains, then stops and disables the legacy `aihr` unit. `/opt/ai-hr` stays for timers, cron and the worker.

Run the probe through the real front door for the whole adoption, and keep its JSON as evidence:

```sh
node deploy/zero-downtime/probe.mjs --base https://<site> --path /login --path /health --out probe.json
```

## An online release

Prerequisites:
- the package is published from accepted staging;
- the database backup has **finished** (it holds `ACCESS SHARE` locks while running);
- the probe is running.

```sh
R=deploy/zero-downtime/release-web.sh
sudo $R stage /var/tmp/aihr-release-<tag>/stage   # immutable releases/<BUILD_ID>, static union
sudo $R mode <BUILD_ID>                           # exit 0 online, 3 maintenance (stop: use the window runbook)
sudo $R migrate <BUILD_ID>                        # previous release serving; lock_timeout-bounded
sudo $R start <BUILD_ID>                          # idle slot: health, served build id, warm-up
sudo $R switch                                    # Nginx -> idle slot, verify through Nginx, drain, stop old
```

Then update `/opt/ai-hr` for timers and cron, with the timers paused, as the current runbook does, and verify as usual. `switch --keep-previous` leaves the old slot running for an instant rollback; stop it later with the next `start`.

| Situation | Action |
| --- | --- |
| `mode` says maintenance | Use the stopped-service runbook in an announced window. Alternatively, a reviewer records exact, reasoned acceptances (`--accept file`; see the classifier header). Acceptance means the reviewer vouches that the previous release cannot observe the change. |
| `migrate` fails before the migration | Nothing changed. The previous release serves. |
| `migrate` fails on lock waits | Every attempt rolled back. Retry later. |
| A post-migration step fails | The schema is migrated and compatible. Repair forward and rerun `migrate`; every step is idempotent. |
| `start` fails | Traffic was never moved. Read `journalctl -u aihr-web@<slot>`. |
| `switch` cannot verify the new build through Nginx | The old slot is still running. Run `rollback`. |
| A problem after the switch | `rollback` puts the previous slot back in front, restarting it if it was stopped. Fix forward. The database is not restored in place (ADR-0181 decision 1). |

`status` shows the active slot, each slot's release, service state and health. `history.log` under `/opt/aihr-web` records every action. `prune --keep N` deletes old release trees, never the two slots' releases, and rebuilds the static union.

## Rehearsal

`.github/workflows/zero-downtime-rehearsal.yml` runs the real controller, unit and Nginx configuration on a GitHub-hosted runner with stand-in releases and the probe. It also runs the lock bound against real PostgreSQL and a real Next build. It touches no staging or production host. Its pass is mechanism evidence only. An installation still needs the isolated production-shaped rehearsal and its own acceptance.

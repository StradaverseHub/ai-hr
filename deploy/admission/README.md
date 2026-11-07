# Generation admission: source candidate, CHECKONLY

This directory is an opt-in component candidate. It is **not installed or release
qualified**. Existing application units, ports, proxy configuration, private
profiles, source/build grants and production remain unchanged. There is no
installation command, deploy flag or marker that authorizes adopting it.

The privileged helper belongs at `/usr/local/lib/aihr-admission/controller.py`,
outside all application-writable parents, with a root-owned private profile at
`/etc/aihr-admission/profile.json`. The sample deliberately contains invalid
identity placeholders. Never copy it to a live installation as an accepted
profile. Its values must eventually come from the protected release owner and
validated target facts, not an application request or a caller-supplied URL.

## Lifecycle

1. Nginx `ExecStartPre` writes a fresh DOWN inventory. `ExecStartPost` proves
   that the new master serves its private revision endpoint. Disk UP entries are
   never replayed after proxy restart or reboot.
2. Worker `ExecStartPre` verifies the configured unit/invocation, reserves a
   fresh generation endpoint while holding the common lock and writes a
   PORT-only root-owned EnvironmentFile. A retried prestart repairs that same
   file without changing the reserved endpoint. The stock Next command remains
   the runtime owner; no custom HTTP proxy/server wraps the application.
3. Worker `ExecStartPost` checks the real process, start ticks, executable,
   working directory, source/build and ownership of the reserved loopback
   listener. The fixed `/health` probe runs outside the configuration lock.
4. After health succeeds, compare-and-swap verifies the same epoch, profile,
   systemd InvocationID, process and socket. A durable publication intent
   precedes atomic include replacement, Nginx validation and reload. A new
   connection must observe the exact new private revision before publication is
   acknowledged. Concurrent successful callbacks for the same generation are
   idempotent; stale callbacks cannot remove or admit a replacement.
5. The release controller requests drain **before** asking systemd to stop a
   worker. Removing its endpoint from new proxy workers is only the beginning:
   every older Nginx process that could still reference that endpoint must exit.
   Drain waits outside the configuration lock. Expiry retains the application
   process and endpoint and returns a failure. No forced kill occurs here.
6. Crash cleanup and the reconciliation timer remove dead generations from new
   publications. An interrupted reload retains all possibly exposed endpoints
   and all observed Nginx cgroup worker identities, then requires a fresh proved
   revision. Port reuse requires both the old application process and every
   referring proxy process identity to be gone. Pool exhaustion refuses startup.

Endpoint removal includes a second same-config barrier reload. A master can fork
an old-config child after the initial process snapshot but before handling HUP.
The first activation proof captures that conservative reader superset; the
second reload retires it without making the newly current children block the
removed endpoint forever. Native proof uses two actual Nginx workers.

Nginx HUP replaces workers while old workers continue their existing clients;
the old workers keep their old configuration. Merely marking a server DOWN and
reloading therefore cannot make its port immediately reusable.
[Nginx process control](https://nginx.org/en/docs/control.html).

## Boundaries and failure behavior

The profile has closed keys, bounded values, allowlisted unit forms and fixed
binary paths. The installed CLI accepts operations and known unit names only;
it has no profile-path override, URL argument, shell execution or arbitrary
package input. Linux PID plus start ticks and real socket ownership fence PID
reuse. State/profile/overlay paths refuse symlinks and writable ancestors.
Application UID 0 is rejected. State and operation errors omit credentials,
environment values, command output and health response bodies.

`check-only` inspects current unit identity, immutable root-owned release/runtime
bytes and root-owned service/environment sources. It refuses writable children,
symlinks, loader/interpreter environment overrides and unsupported source
syntax. It never installs and always reports `installationAvailable:false` and
`releaseEligible:false`, with remaining installation gates. Initial inspection
must itself run in an already trusted clean root environment: `LD_PRELOAD` is
processed before Python isolation begins. A privileged hook must not be added to
a service whose environment boundary is still application-writable.
[systemd execution environment](https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html).

All service reload paths, including external certificate/config reload owners,
must use the same guarded controller. Direct privileged HUP/config changes
outside that protocol invalidate its endpoint-reader proof and must be excluded
by the accepted installation contract. Root administration remains trusted.

The location example does not replace an existing vhost. Preserve the original
Host including its port, forwarded client/TLS information, cookies, upload
limits, timeouts and upgrade behavior. At a trusted outer Nginx/TLS hop, an inner
HTTP proxy must preserve the verified forwarded HTTPS scheme. Do not trust an
arbitrary public client-supplied forwarded header. Keep automatic upstream
replay disabled; a write whose response is lost remains an explicit failure.
[Nginx proxy directives](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

An empty healthy pool or an actual backend crash can still produce an explicit
HTTP failure. This component must not disguise 503/502 or failed startup as
success. Zero observed failures in a qualification workload is a measured result,
not a promise that hardware/process failures cannot occur.

## Hosted proof manifest

No tests or systemd/Nginx processes are run locally. Freeze the source, obtain
independent review, then use the existing focused Actions route with these
selectors as separate planned units:

| Selector | Purpose | Required runner capability |
| --- | --- | --- |
| `test/runtime-ready-admission.test.ts` | Protocol, stale/PID identities, reload recovery, drain retention, pool exhaustion and cross-build refusal | Standard Linux, Python stdlib |
| `test/runtime-ready-admission-contract.test.ts` | Existing installation tests and safe format-2 profile-absence boundary | Standard Linux/Node |
| `test/runtime-ready-admission-native.test.ts` | Actual Nginx, systemd, root/nonroot ownership and concurrent transport | Dedicated standard GitHub-hosted Linux, sudo, official distro Nginx |

The native selector must run alone. The focused workflow adds only a conditional
constant official `nginx` package prerequisite and records its distro version.
Missing actual capabilities fail the test; nothing is skipped. The native
harness refuses existing fixture paths/units, creates only root-owned isolated
fictional code and separate nonroot receipts/cache, and cleans its own objects
by recorded inode. It never opens an application database or provider.

The native report is DEVELOPMENT ONLY. It checks cold traffic exclusion;
simultaneous readiness callbacks; actual socket/start-tick identity checks;
failed nonroot writes to helper/profile/PORT/release; allowed cache/receipt writes;
2 MB uploads, Host-port/HTTPS/cookies, streaming and WebSocket echo; lost-response
POST with one durable receipt and explicit 502; drain expiry; stale callbacks;
reload validation and after-HUP interruption; exhaustion and startup failure;
proxy restart beginning DOWN; and preservation of an unrelated fixture vhost.
The restart test is not a physical host reboot test. Keep original failed and
successful run/artifact identities; repair only failed or invalidated coverage.

## Installation gates still open

1. Extend the existing authenticated operator → promotion → private installGrant
   → shared staging lease route. Current format-2 remains **LEGACY_IN_PLACE**.
   It now refuses any present or uncertain managed profile. Only verified ENOENT
   below safe parents permits legacy behavior; EACCES or symlinks never do.
2. Bind actual protected helper/runtime/config/include/module inventories,
   immutable release bytes, environment source boundaries, service descriptors,
   overlay, reserved endpoints and measured resource envelope. Do not run
   application-owned code as root to obtain those facts. Private target profiles,
   environments and grants never belong in public source/artifacts.
3. Complete target inspection and the immutable release-layout transition.
   In-place `/opt/ai-hr` replacement is not overlapping immutable deployment.
   Existing pinned `-p 3000` ignores the PORT overlay and default wildcard binding
   cannot satisfy loopback ownership. Review a stock-Next argv transition through
   the protected installer; do not silently replace its command here.
4. Bind an authenticated old/new web, background worker, schema and Server
   Action/key/payload compatibility window. `begin` refuses cross-source/build
   overlap meanwhile. A self-reported digest or a `verified:true` marker is not
   authority. Older browser actions also require explicit skew testing.
5. Declare native NGINX capability on the real release-controller unit; adopt the
   same controller and immutable layout in the qualified performance runner.
   Focused development evidence is not an authenticated release witness.
6. Run actual Next login/MFA/actions/streams/uploads and unchanged strict browser
   preflight, then resource-admitted worker comparisons with real latency/error,
   Busy/crash/lock and capacity evidence. Preserve shared Nginx hosts and the
   unrelated 8080 service. Staging installation follows only the complete release
   contract; production remains held.

The supplied read-only staging snapshot establishes active Nginx 1.24/systemd
255 and stock Next CLI. It does not establish safe environment/release ownership,
the entire ingress chain, reserved endpoints or installation authority. No
six-phase completion or installation claim follows from this source candidate.

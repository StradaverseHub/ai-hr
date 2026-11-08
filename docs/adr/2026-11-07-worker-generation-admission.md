# Per-generation web readiness through the existing Nginx owner

Status: source candidate; hosted component proof and protected installation
integration pending. Production held.

Cold worker initialization can consume the request deadline before a business
handler begins. A healthy sibling does not prevent a round-robin proxy from
sending traffic to that new worker. Adding workers without per-worker admission
can therefore increase the number of cold requests.

Use existing Nginx as the transport owner and stock Next CLI as each worker's
application owner. A root-owned stdlib controller reserves a generation-unique
loopback port DOWN before process startup, proves health plus native unit/process/
socket/source/build identity, then publishes it through a validated and proved
Nginx revision. No custom application HTTP proxy is introduced.

Nginx graceful reload keeps older workers serving their existing clients with
their previous configuration. The controller retains every endpoint until all
referring proxy PID/start-tick identities and the old app process have exited.
Drain expiry retains the old process; planned drain is a release-owner operation
before stop, not a failing ExecStop hook. Reconciliation retains uncertain state
and forces a new proved revision after interrupted publication. A new Nginx
master always starts DOWN. See [Nginx process control](https://nginx.org/en/docs/control.html).

Admission requires native active/running or activating/start-post at the process/
socket proof and final publication; a known stopping service cannot remain UP
merely because its PID is alive. Recovery preserves every acknowledged or
possibly exposed pending endpoint through its second retirement barrier,
including an interrupted ADD never acknowledged UP. Interrupted cleanup of a
nonpublished WARMING/DRAINING generation requires positive native unit/cgroup
death proof, a free endpoint and all proxy readers gone; process=None is never
treated as proof of death. Nondelegated root-owned cgroups and a disjoint current
MainPID/ControlPID process family permit eventual recovery after automatic
restart without freeing an orphaned or uncertain endpoint.

This costs private endpoint headroom, a small privileged lifecycle component and
an explicit immutable installation contract. It avoids a second proxy product,
application-level proxy semantics and unsafe same-port restart races. Long-lived
streams can delay retirement indefinitely; exhaustion refuses new startup rather
than killing a live stream or reusing a referenced endpoint. Readiness is not a
business cache and does not change authorization, payroll/leave calculations,
transaction rules, mutations or automatic command retries.

The existing format-2 CI installer remains legacy in-place and refuses present,
inaccessible or unsafe managed profiles. No new grant or operator authority is
implemented. A future authenticated contract should bind controller/profile,
resource envelope, complete Nginx/runtime inventory, worker inventory, immutable
release manifest, root environment boundary, overlay and compatibility-window
digests derived from real validated target facts. Compatibility must cover old/
new web, background workers, schema, action IDs, encryption keys and payloads.
Until then cross-build overlap refuses. Root-owned JSON declaring itself verified
does not replace authenticated installation authority.

Actual protected installation, the existing full release controller's declared
NGINX capability, stock-Next command transition, real Next transport/browser
qualification and matched-resource worker tests remain gates. The fictional
native component witness exercises real Linux processes and Nginx but cannot
certify those application or release concerns. Full lifecycle, proof selectors,
failure semantics and outstanding gates are in the [component runbook](../../deploy/admission/README.md).

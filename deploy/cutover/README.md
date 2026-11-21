# Immutable release cutover

Prepare an artifact off the active route. Take a target lock only to recheck the baseline, switch traffic and prove the result. Keep the previous release running until the candidate passes. If the outcome fails, restore the previous route and check it through ingress.

## Controller boundary

- **Build and qualification** produce a content-addressed artifact and evidence on the integrated revision. The trusted deployment launcher independently authenticates the producer, artifact digest and allowed target.
- **Preparation** takes place outside the target lock. The launcher stages and warms the verified artifact. The controller checks the supplied artifact digest and the candidate's own readiness and expected user outcome. Its receipt lives under a directory owned by the release operator.
- **Activation** is serialized on the target. It refuses if the actual ingress revision or schema differs from the prepared baseline. A durable journal is written before changing the ingress pointer. Activation succeeds only after the same ingress serves the candidate's expected identity and outcome. The previous endpoint remains available for rollback.
- **Recovery** is conservative. If an interrupted switch left a journal, the next activation or an explicit recovery restores and verifies the recorded baseline before another cutover. A failed rollback leaves the journal for recovery.
- **Upgrades** use a separately rehearsed path. The first controller only accepts equal schema identities. The upgrade design stages a backwards-compatible expansion, runs resumable backfills, verifies both app versions against the expanded schema, then activates. Cleanup of the old schema is a later change. A one-way change requires a tested forward repair or restore procedure.

## Runtime contract

The deployment owner provisions a target root, its `endpoints` and `prepared` subdirectories, and a trusted loopback ingress. Only the release operator can write the root, route pointer, lock, and receipts. A trusted launcher runs each release at `endpoints/<artifact SHA-256>.sock` and binds the probe responses to the process and the verified artifact it launched. Ingress connects through `active.sock` for each new backend connection. A working baseline must already be present.

The `GET /health` probe returns exactly `source`, `artifact` and `schema`, representing the observed source commit, artifact digest and schema identity. The `GET /release-check` probe returns the expected user outcome as a JSON object. Keep these probes internal and free of real employee data or irreversible actions. Launcher authentication, environment-specific approval, probe hosting and ingress wiring are prerequisites to live adoption. The qualification workflow runs on fictional loopback services, with an actual HTTP cutover and rollback.

Use the controller on the deployment host with its private root and ingress port.

```bash
python3 deploy/cutover/controller.py --root /run/aihr-release --port 3200 prepare \
  --request /private/release-request.json --artifact /private/verified-build.tar.gz
python3 deploy/cutover/controller.py --root /run/aihr-release --port 3200 activate \
  --artifact-digest "$ARTIFACT_SHA256"
python3 deploy/cutover/controller.py --root /run/aihr-release --port 3200 recover
```

A preparation request contains `baseline` and `candidate` objects with the health identity fields, plus the expected `smoke` object. Activation reports preparation time, time waiting for the target lock, and time holding it. Record those separately from build and external approval time.

For Next.js runtime preparation, `next_probe.py` confirms that the installed `.next/BUILD_ID` matches the verified package and that the selected local endpoint serves both application health and the byte-for-byte compiled build manifest. Run the same probe through the trusted ingress after switching. The probe supplies build arrival evidence. The launcher still validates the complete artifact, and the live journey supplies the user outcome.

## Shared staging

Commissioning has two parts. First an administrator runs `commission-ingress.sh` against the reviewed staging Nginx configuration. This installs a canonical socket bridge and a loopback listener on port 3301. It keeps the current release selected and checks both the loopback listener and the public HTTPS route. The script retains the original site configuration and restores it if setup fails.

Then the staging deployment owner runs `install-queue.py` with the known installed coordinator hash and exact live source and build. It holds the shared operation lock, refuses an active or prepared release, checks ingress and then enables the new queue observer. Without that commissioning step the installed coordinator retains its canonical-only policy.

Once commissioned, ordinary migration-free tickets enter the cutover lane automatically. Use `release.sh` with an independently authorized build-only workflow and a frozen, clean candidate. The operator runtime needs the repository's existing TypeScript loader and candidate tool dependencies for validating the canonical build evidence.

1. `prepare <candidate-worktree> <baseline-sha> <baseline-build> <CI-controller-sha> <CI-run-id> <private-evidence-dir> <signed-out-smoke-path>` authenticates the build packet. It checks the dependency inputs and migration inventory and warms the exact application in a memory-bounded user systemd unit. Both build copies use the verified staging dependency tree. The cutover lease preserves that dependency tree during activation and reconciliation. The canonical build is materialized independently. Source transfer, build extraction, readiness and the read-only ledger check occur before the lease.
2. `activate <private-evidence-dir>` claims the existing shared queue lease. It binds preparation to the leased source and baseline, verifies the database ledger again, switches ingress and records arrival after observing the actual candidate bytes and smoke response. Application data migrations and seed scripts do not run in this lane.
3. `promote <private-evidence-dir>` reconciles the canonical app while the verified candidate serves public traffic. It proves the restarted canonical backend through its socket, parks ingress there and proves the same build again. This preserves the existing upgrade and package tooling and releases the temporary worker's memory at handback.
4. Verify the changed signed-in journey and the signed-out access boundary on the exact staging build. Write `acceptance.json` to the evidence directory with a `reason` referencing the evidence. `finish <private-evidence-dir>` retires the temporary runtime and closes the lease only after verifying the canonical route.

If initial switching fails, the controller restores the old route and verifies its bytes. A process interrupted during switching leaves a journal. Use the matching installing lease with `staging.py recover --lease-stdin` before starting another release. If canonical synchronization fails, retain the lease and the green route while inspecting its rollback evidence. The canonical deployment and queue record are separate durable facts. A retry must check both before changing traffic again.

Time the commit, build publication, verified packet, warm runtime, lease claim, switch, canonical verification, live journey and handback. The full gate is separate from this authenticated, staging-only path. Qualification with disposable services does not count as a timed release.

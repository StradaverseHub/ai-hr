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

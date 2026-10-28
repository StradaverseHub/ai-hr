# WP4 — gateway fail-closed and caller drift (R9)

Rechecked on matching fetched main/alpha `b5758c54c431765461d84235ad19c72ad71cf578`.

- Still open: `governed()` used no-op accounting for missing governance; only Test connection intentionally constructed raw configuration. The production caller inventory walked core/packs/app, allowed the `assessmentAiConfigTx` string bypass, and was not always-run.
- The gateway now refuses missing governance before workload transport. A branded, runtime-issued `UngovernedProbe` capability authorizes connection checks only and survives the gateway's configuration capture; it cannot run a draft or conversation. Source guards confine production capability issuance to `testConnection`.
- Probe admission commits a metadata-only `ai_model_run` row before transport and settles completed/failed afterward; process interruption leaves pending evidence. It reuses the current group-admin authority owner and `ai_settle`, carries no prompt/key, and has operation `probe`, feature `provider_evaluation`. Operational checks remain outside workload allowances; quota, aggregate and monetary-history readers exclude probes without changing actual workload history.
- Append-only migration 0678 is reserved in `docs/MIGRATION-ALLOCATION.md`; alpha and live staging watermark were read before allocation. Reconcile later branch appends before integration; no SQL was applied to staging.
- Caller inventory includes lib/scripts, SDK imports and raw provider fetches. Performance callers must call an imported admission owner or the governed shared wrapper; a bare settings-resolver string is insufficient. The inventory test is always-run. Negative fixtures cover injected raw provider fetches, SDK imports and probe-issuer aliases.
- Already fixed at this base: none of R9.

Focused runtime and exact-candidate gate results are recorded on the PR once executed. New tests: `ai-gateway-fail-closed.test.ts`, `ai-connection-probe-db.test.ts`; expanded `ai-management-contract.test.ts`. No real provider/network calls, staging migration or deployment. No layout changes; six locales gain an operational probe label. Next package: WP15 (R12–R14).

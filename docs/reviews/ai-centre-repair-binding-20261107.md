# AI Centre: repair source binding for review

Date: 7 November 2026

Status: exact source comparison prepared; approval renewal for this repaired fingerprint is pending. This is not a release receipt.

## Exact binding

| Source | Files | Provider SHA-256 |
| --- | ---: | --- |
| Owner-approved combined candidate `6dd25ff899da9a8922195d9553df3211302b9338` | 1,460 | `7220621d4734a0252f6dbc10e9bd917e2145e1db7d86c5621cdb5f9821e0efc3` |
| Repaired candidate | 1,460 | `d4a22c5196d4a7a2dd752d5a76f5d7cffb31894d0efb50623aa0a6c97eec269f` |

An independent immutable Git-blob import-closure comparison reproduces the approved digest and matches the repaired generator. There are no added or removed provider-closure files. Exactly six covered files change:

- `core/assistant.ts` and `core/assistant-read-session.ts`: mandatory function/module checks use the actual opaque read owner's transaction. Previously a second transaction waited on the first transaction's Access/stop locks, producing a self-deadlock. Private ownership, principal matching and callback lifetime are checked. No raw transaction escapes and no ambient transaction auto-join is introduced.
- `core/ai-domain-analysis.ts`, `core/ai-workforce-analysis.ts`, `core/ai-payroll-comparison-analysis.ts`: the existing input validators/capture run before the asynchronous control boundary. This preserves refusal of getters/proxies and caller-mutation isolation instead of cloning away or executing those inputs first. Native authorization, source replay and projection remain mandatory.
- `lib/ai/agent-capability-inventory.ts`: the three new administrator control actions are classified `handoff:ai_governance`. The model receives no preparation or execution authority over these controls.

Provider serializers, outgoing fields, prompts, workload purposes and contracts are unchanged. No new provider-data permission, employment authority or automation ceiling is requested. The request is to carry the same 28 existing approvals forward to this exact repaired fingerprint, preserving all original review metadata. Both pending contracts (`structured_canonical_records_v1`, `attendance_trend_analysis_v1`) remain byte-for-byte unchanged. The literal approved records currently still bind the preceding approved fingerprint and therefore refuse model egress on this repaired source until actual human renewal.

## Complete original verification and repairs

[Full run 42350407759](https://github.com/StradaverseHub/ai-hr/actions/runs/42350407759) completed against frozen `6dd25ff899da9a8922195d9553df3211302b9338`. Build, whole compiler, migrations, controller checks and all three browser engines passed. Application failures remain failures on that original source; no release PASS is claimed.

The repair also updates explicit database-boundary doubles, follows controlled public Performance wrappers to their concrete private provider implementations in the source-inventory test, follows the unchanged 0812 SQL switch owner through its narrowing 2700 wrapper, and appends migration 2700's exact journal row/hash to the populated-upgrade fixture. All earlier SQL bytes, journal-prefix witnesses, native-data preservation and access assertions remain intact. The worker-link DOM regression renders the real target control form in both directions. Actual read-owner regression checks same-carrier transactions, unknown/off/on flags and forged/cross-principal/escaped owners.

Competing human native-write probes in a callback-tail test are explicitly bound outside the AI async context. They still invoke real native services and require actual refusal while the source owner holds its locks; the hooks no longer misidentify that independent human request as part of the AI activity.

One unchanged concurrent Schedule Group case failed in the full run with a busy dependency refusal. Its exact installed-baseline source passed [diagnostic 42352357450](https://github.com/StradaverseHub/ai-hr/actions/runs/42352357450). It remains unchanged and requires a repaired-candidate recheck; one baseline pass does not prove the original failure was environmental. The planner short-expiry case that exceeded 30 seconds in an earlier focused run passed within the complete gate; its real database clock and timeout remain unchanged.

Repair verification must use failed/affected coverage and the existing impact classifier. Retain all original artifacts and failures. The present cross-source recovery adapter refuses edited test fixtures; no fabricated receipt or modified verifier is introduced. Final authenticated release qualification is still required.

## Staging boundary

The separate PR229 release owner is preparing its authorized staging test window. Preserve the actual `a4bd903840cdae2a94e67d5f57e3b54c9e2a86ac` baseline and epoch-56 arrival lease while that work finishes. No lease recovery, installation, shared-branch advancement, package publication, human acceptance or production deployment is authorized by this binding request. Before AI Centre installation, preserve any newly installed PR229 source and migrations, recheck the exact source binding and use the shared queue.

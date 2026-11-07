# AI Centre: preserve the arrived UI release

Date: 7 November 2026

Status: exact combined binding prepared for human review; approval literals remain on the previously approved fingerprint.

## Exact source comparison

| Source | Provider files | SHA-256 |
| --- | ---: | --- |
| Approved AI Centre coverage source, including test repairs `73a4ccb783eae6265da20ba43b18f386a1e9246f` | 1,460 | `74601c3b6b283daee4c26ac9262ef186e81643a853da7af4f9e320b9210bca9e` |
| Same AI Centre source preserving arrived UI release `09f4fcb9482dca79177df93fea29039611c40550` | 1,460 | `01412858d86338a16ad2117ef882284c043144bdc0655ae1c154306684816770` |

An independent immutable Git-blob closure comparison reproduces the approved digest and the combined generator result. No covered files are added or removed. The only six provider-closure differences are `messages/en.json`, `messages/ms.json`, `messages/ta.json`, `messages/th.json`, `messages/vi.json` and `messages/zh.json`.

These translation changes preserve the existing UI owner's labels, search/empty-state messages, leave submission/balance guidance, company-selection help and corrected login instructions. They do not change provider serializers, prompts, outgoing field categories, destinations, purposes or contracts. The [UI source assessment](ui-audit-source-binding-20261107.md) records the separate UI binding; its approval does not authorize the combined fingerprint.

All 46 incoming UI files outside generated manifests and literal approvals are preserved byte-for-byte from `09f4fcb9482dca79177df93fea29039611c40550`. This includes its leave form error handling, organization filters, permissions layouts, responsive components and behavior tests. The merge keeps all AI Centre controls, the [251-row inventory](ai-centre-complete-function-inventory-20261107.md), native permissions and the existing 704-entry migration prefix plus migrations 2700 and 3000. Applied SQL, package and lockfile bytes are unchanged.

The requested renewal changes exactly the same 28 approved source-digest literals. All original reviewer, evidence and review-date metadata must remain unchanged. Both pending records, `structured_canonical_records_v1` and `attendance_trend_analysis_v1`, must remain byte-for-byte unchanged. The approval file is currently byte-identical to `73a4ccb783eae6265da20ba43b18f386a1e9246f`; generated manifests alone grant no provider approval. The module manifest is regenerated last with the existing generator.

## Verification and release limits

Original full run [42361505681](https://github.com/StradaverseHub/ai-hr/actions/runs/42361505681) remains failed on source `c6accdcdcde2612beecfa3cdc1c61aff936687e9`. All planned jobs finished; build, compiler, migrations and all browser engines passed. Two test units had six failures. The import transaction fixture repair passed [eight assertions](https://github.com/StradaverseHub/ai-hr/actions/runs/42363387753).

The three Personnel legacy failures reproduced in the exact 24-file cohort on both [unchanged baseline](https://github.com/StradaverseHub/ai-hr/actions/runs/42364630419) and [diagnostic candidate](https://github.com/StradaverseHub/ai-hr/actions/runs/42364630936), each with 337 passes and three failures. The diagnostic preserved actual transactions, RLS and locks, and located refusal at native request visibility. Static investigation found the photo-consumer fixture sets installation-wide Access capability support/bindings and never restores them; tenant reset intentionally preserves that catalogue. This makes a later legacy fixture's uninitialized Access state fail the supported-capability check. Test-only repair `73a4ccb783eae6265da20ba43b18f386a1e9246f` captures and restores the original three records; native authority and all behavior assertions remain unchanged. Its [exact 24-file recheck](https://github.com/StradaverseHub/ai-hr/actions/runs/42365383479) is pending at preparation. Independent Standards and Spec reviews report no actionable findings; hosted results remain mandatory.

Read-only staging state now proves UI source `09f4fcb9482dca79177df93fea29039611c40550`, matching built source and build `Q3Pmy99yco3QjWlBO5FE2`, state `ok`, and `stale_build=0`. This is arrival evidence, not human acceptance or AI Centre installation. The UI owner retains epoch 58; its acceptance and release window remain exclusive. The declared CI baseline and main/alpha must be refreshed before choosing the final release witness.

Preserving this actual installed UI release changes production source and test/browser coverage, including two new DOM files. Earlier qualification cannot represent the combined inventory; the final source must satisfy the actual immutable impact plan and authenticated release policy. Existing successful evidence stays recorded on its producing source. No failed workflow is relabelled PASS. This renewal permits provider-dependent verification and staging qualification; it does not authorize production deployment, package publication, human acceptance or interruption of the UI lease.

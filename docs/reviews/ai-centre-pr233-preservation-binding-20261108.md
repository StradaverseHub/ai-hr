# AI Centre preservation of accepted PR233 — exact source binding review

## Review target

Preserve PR230 source `a946d035686b7c763895214d37dc7dd6c8043139` (independent full42397699185 PASS47,324 checks) and the installed, repaired PR233 source `29d9edcbc4368be871688e9fdf35347676a7841c` / build `nw4kf_2PL5FhcL9EjvsMc`. This is staging-only. Production installation and package publication remain on hold.

The exact provider-data fingerprint is **`6375c8ceaa5f473e0e8cfa67c66dcf9ca0bd7dfb04d7365fed09a70ac1a5c4af`** over **1461** transitive files (previously `30dd256580cfd85dee9087f131c7a8b917a9ca3dad283730edcb461188218ca5` over1460). The registry still contains its original28 approvals against30dd; no renewal has been performed. The new manifest therefore does not itself authorize provider egress.

## Requested human decision

Carry forward the same28 approvals to this exact fingerprint. Keep both pending contracts (`structured_canonical_records_v1`, `attendance_trend_analysis_v1`) pending and retain every original reviewer, evidence link, review date and all other metadata. Only the28 sourceDigest literals may change after actual approval. This is provisional repository-owner renewal, not a fabricated specialist review. [The source rule](../../lib/ai/provider-data-reviews.ts#L9) requires actual human approval before editing source-bound records.

The original approval file is currently byte-identical to A946. Provider contract policy, disclosure protocol and provider adapters are byte-identical. Preserving PR233 changes native attendance, payroll, scope and reporting source dependencies and adds the payroll reconciliation items helper. The exact changed transitive source hashes are below. No provider policy or transport is weakened.

## Applied history and unapplied reallocation

All707 PR233 journal entries and their SQL bytes are preserved exactly, including3100,3101 and the non-superuser RLS forward repair3110. Only PR230's never-installed2700 and3000 files are renamed to3200/3201, with identical SQL payloads:

- `3200_ai_centre_controls`: idx2500, when1793330002800, SHA256 `2182ae4a614d0b847f399af18f9cfc43e82d3c9fd6f42ca960bfe22ebf4f10e2`.
- `3201_ai_centre_function_coverage`: idx2501, when1793330002801, SHA256 `0c7239f512174c0d941dcb441cf98bd3a685a8e4d65973dc92f136dfb6b78d8a`.

The combined journal has709 entries. The populated-upgrade helper preserves all old hash assertions and appends both new identities. Two existing source-path assertions follow the renamed files; their assertions and operation-boundary coverage are unchanged. The capability inventory retains PR230's three admin controls and adds PR233's approver-search classification.

## Exact changed transitive privacy sources

| Source | Prior A946 SHA256 | Combined SHA256 |
| --- | --- | --- |
| `core/attendance-application-history.ts` | `9ca141b1e68cca45e73e776aeb7770839676a975abf9c3a9c827b057ac5e71b2` | `d892a5f44bc14d851bae9a6f4952574b845ec1051cceea67777feb9c0598de2c` |
| `core/attendance-workflow.ts` | `fc5b898db37dba9324afa1c43fc2960b4ca2dc4d2a3a293e57e32c875a8634bc` | `de62fab68aba4e627558f1edf7e967e49a24d583434ce14b75c9aacdde1c9c1f` |
| `core/company-refs.ts` | `f2ac0d4c4042e15677a3f3ccf4f3b10c7ab89c614bfbea00eba6271c0b7686ab` | `3f70d0695901bf0ed0fcfd7dfb37c447e9b7b4486e4b69676b62d5684a1753b3` |
| `core/pay-components.ts` | `1fee8c42a39cfe5c4cd3bbe59bcf9b7470a4c6272def9521c90753b227963a1a` | `183bb891fa196813e073146584076f80e8801dc81e4fb6462143bb809ae58822` |
| `core/pay-formula.ts` | `c0c0fdfece067896da7a893e1b61c2f020214d4f48c279b44d3d58453c958476` | `7254a1327781de1ce46da439b1fac1241adfd4927f0d20360c6038bf66286736` |
| `core/payroll-view.ts` | `f7968f7bc46141705cfa90dcd4bf8ed6c31c6fe7e32efd5132f3a31261b4ea60` | `a832be07e8960108db810ed45e62dc5915f01b4fb71bd49d6f38e8dae55a85ae` |
| `core/report-payroll-comparison.ts` | `a86ee9d879c26a23b134d9876ad30da18af6bf65eafad22614e02034ee51968d` | `e7e094d1f49cf7c00eab782413a322d8b2b4506f44716ade4b2b512311da7283` |
| `db/schema.ts` | `7af0efdd49ffc5b6aaf55a47357808dffd7bc5c20216299808be81fee10d3f3b` | `e8fd1aee4096e61a6a0a9e5183b18ee75be15e50f420a47bb4e38efc13e3f5af` |
| `lib/ai/agent-capability-inventory.ts` | `cdeddad45cebb71928867e09ee4fcf1735cfe8b0d4e53f0a6b379b8b46905018` | `b083f8f38be182b933354a19619b8662d2df2f7b3e48e5d39cbc903ffd50dedd` |
| `lib/attendance-workflow-config.ts` | `815114c3d9fc6f3a36af6e40dd12a9034ffdfe579f26ac9dce7e819a6eae0f84` | `7fa5d5c6d9f4e0afe0ce3ad0d1eeb0db807dc20e83d6dc1b9bc1b44616390d3c` |
| `lib/attendance-workflow.ts` | `bc7499c8fd801454901bc7ad685eee1863ab491cccf18392edcc8f6e75b99572` | `8377af11aa6057b4f0d81814d23d33226f89835fd431e2d6b8319f54083e609c` |
| `lib/payroll-comparison-result.ts` | `664c8575748164719488edf0b0e03fd052a5012fba54c6e5de5bc052b16c2080` | `cf6bb0e77e122c6fa963ccf9ed03287fec6a4edef34d3a1ea324aadc45e957ba` |
| `lib/payroll-comparison-source.ts` | `a1bc5001135554ce2cf704090375e0213c494a06c1507b54288d9feedd460dc2` | `96080a37b7672d51e7829128bc1c4ea9571d6ffcb19e7979e4cc3e619fd820e2` |
| `lib/payroll-period-comparison.ts` | `7a10e2a6a6eec8beca98660df564b2fe27636e831c1ab5daac7b5bff12c8ea59` | `054f7e8ae05fe3ac399b2bb6dd6acbb964abdf784ff28fa8cbe861c5e2509a9c` |
| `lib/payroll-reconciliation-items.ts` | `new` | `3ed03884c5ba26d094b63c80aa3e07b900784cf6f9b361a75ded5476e6da2187` |
| `messages/en.json` | `934eac028b8be0ca5d13fd677dcc9a94e028df86994f7df7ee6773349e34e2dc` | `620474aa38eb3ddc3b90eb47e86b30c46cccc791839a94eb84a97754749f9e80` |
| `messages/ms.json` | `9cf4454eb3d8fe6d02c71d5674f7f0a12301978ca1c95322376c56929df85142` | `ca9094ddde3d9f52c7880fbc36fc762f654fc67ae92ea008071ffc5f12afa9bf` |
| `messages/ta.json` | `06307c03fea83a77d3ffc35da91e60c06eb7fd7d451c254ba8ea31697cb54df9` | `30e584370f9d945db77249cfddb3eb9fcdd7296aa2aa560de6350acf6815bc50` |
| `messages/th.json` | `ada144005030d908c9818161489e88ea7d78c62a70f45f6b715b3db8299a79c7` | `15ba9e24a88fd4d027d71ed52651c6844504299e1eef605b70e0baa5224748d8` |
| `messages/vi.json` | `2552a7f71002721a0002fd48657ff05df315514152dd5130e0a7d992d3476c7f` | `86efc24dc64d419ffc4a9c050431e1483c5754127aca9ac0a204bf656e1d1f54` |
| `messages/zh.json` | `462f0539941412290dae84460208e28983d66dde41b99e1856a5a9cfaaeb01f2` | `ada5c6921ed3c8723a0d96304c365bbed5a1b232b39ead04412a4ecbc510b100` |

## Verification and installation conditions

Static source manifests are generated/checkable, while the28 human approvals remain unrenewed. The module manifest before renewal is `c82430f4f8e6225ac8122c308db05191fd0a4abeb7136f294123161a5791dbbf` over473 files; it must be regenerated after any approved registry change because it includes that file. The provider fingerprint omits its own manifest and literal registry, so it remains the exact requested6375 fingerprint after renewal.

The prior A946 and PR233 CI results remain on their original source/controller/baseline identities. They are not relabelled onto this integration. Combined-source verification must follow the actual immutable impact and current707-entry baseline, including populated upgrade, non-superuser owner behavior, source-bound build/worker, independent admission and rendered stop-all/per-function/manual-HR/import journeys. No lease is claimed and no updated administrator commands are executable yet.

PR233's protected e064b4a2 recovery bytes and original expired-grant audit remain retained. This integration neither deletes them nor replays the retired grant.

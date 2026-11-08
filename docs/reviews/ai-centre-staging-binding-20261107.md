# AI Centre: current staging integration binding

Date: 7 November 2026

Status: combined provider-source renewal approved by the repository owner on 7 November 2026. Staging qualification and acceptance remain pending; this is not a release receipt.

## Why a second binding is needed

The owner approved renewal of the original AI Centre packet's exact provider fingerprint `ba8f8b5e200eba8fdfd61e189a7ccd0cf1c074fad2373bd794a8d050246d6dea`. That renewal is recorded in `c83b326f9e56318ac9d907b8b49bf3aa61a38b63`: exactly 28 approved digests changed; both pending records and all other approval metadata were preserved. The provider generator still independently confirms that exact approved fingerprint.

The required read-only staging preflight found that staging already runs `a4bd903840cdae2a94e67d5f57e3b54c9e2a86ac`, build `NCeRGh_texMU8NbSM1M0l`. Main and alpha were freshly fetched and alpha still identifies `eb9411f24f74dc3ce02d1e3fa6a834c7e0ac2d6c`. The installed payroll-import/System Labels release is ahead of that published alpha history. Its shared staging lease is epoch 56, owned by `codex-labels-payroll`, in `arrived` phase. This task has not claimed, recovered or changed that lease.

Installing the original AI Centre candidate would omit the installed payroll-import migration and source. The prepared integration instead merges the exact installed release, preserves its complete 703-entry journal as an unchanged prefix, and appends only `2700_ai_centre_controls` (idx 2000, timestamp 1793330002300). Every installed migration SQL byte is unchanged. The actual staging ledger independently matched all 703 ordered entries and hashes through `2460_payroll_individual_import_queue`, timestamp 1793330001860. This read-only preflight grants no deployment authority.

## Exact integration for review

| Surface | Files | Provider SHA-256 |
| --- | ---: | --- |
| Owner-approved AI Centre source | 1,458 | `ba8f8b5e200eba8fdfd61e189a7ccd0cf1c074fad2373bd794a8d050246d6dea` |
| Already installed payroll-import/System Labels source | 1,458 | `5a36925dcd34b937c8afc1dadd9b0c06d54b1e4ba9a020824f17da67684a038c` |
| Prepared combined source | 1,460 | `7220621d4734a0252f6dbc10e9bd917e2145e1db7d86c5621cdb5f9821e0efc3` |

The combined generated module-agent fingerprint is currently `271b100b485f9d6e47ffc4c3c839f972a919a5147180e15bdabc408f0ac02f65` (472 files). It will be regenerated if the owner approves updating the literal provider records.

An independent Git-blob import-closure/hash comparison reproduces the approved AI Centre fingerprint and matches the combined generator. Relative to that approved source, the combined provider closure adds two files, changes 12 and removes none:

- Added: `core/individual-import-job.ts`, `lib/individual-import-job.ts`.
- Changed: `core/admin.ts`, `core/individual-txn-import.ts`, `core/product-context/capability-catalogue.ts`, `lib/ai/agent-capability-inventory.ts`, `lib/permissions.ts`, `packs/payroll/service.ts`, and the six root locale JSON files.

These are the already installed import queue/capability/permission and System Labels changes. AI Centre execution/control code is preserved from the approved candidate. Provider workload policy, outgoing serializers and prompts are unchanged. No new AI field, purpose, contract, employment authority or automation ceiling is requested.

The 28 literal approval records deliberately retain the already approved AI Centre fingerprint. Both pending contracts (`structured_canonical_records_v1`, `attendance_trend_analysis_v1`) remain byte-for-byte unchanged. The combined candidate therefore refuses source-bound model calls until the owner approves this exact combined fingerprint. The earlier exact approval has not been expanded automatically to this integration.

## Combined binding approved

After reviewing the exact combined fingerprint and comparison linked in this chat, the repository owner selected:

> Approve combined fingerprint; continue staging verification

This approval binds `7220621d4734a0252f6dbc10e9bd917e2145e1db7d86c5621cdb5f9821e0efc3`. Exactly the same 28 approved records receive this digest. Both pending records remain byte-for-byte unchanged, and all other original review metadata is preserved. The preceding pending-state paragraphs describe the prepared merge before this approval; they are superseded only for this exact provider fingerprint. No new outgoing field, purpose, contract or automation ceiling is authorised. Production deployment is not authorised.

The provider manifest is checked unchanged; the renewed module-agent fingerprint is recorded with the final qualification candidate below.

## Remaining staging prerequisites

1. Completed: owner approved carrying the same 28 existing purposes forward to combined provider fingerprint `7220621d4734a0252f6dbc10e9bd917e2145e1db7d86c5621cdb5f9821e0efc3`, preserving both pending records and all original review provenance.
2. Regenerate the module-agent identity and qualify the final exact candidate using the authenticated full staging workflow. Previous focused development passes retain their original candidate identities and cannot supply a release witness.
3. Obtain an available staging window through the shared queue after the current lease owner hands back. Recheck installed source/build, journal watermark, applied hashes, alpha history and migration allocation before preparing this isolated migration-bearing release.
4. After qualified installation, verify exact arrival/build, migrations, service/health and rendered group-administrator and denied-role journeys: stop-all, no stale resume, individual off/on, unrelated functions preserved, late work/reminder suppression, and ordinary manual HR/audit availability. Human staging acceptance remains separate. Production deployment is not authorised.

## Verification

The original AI Centre implementation's 315-case regression and final 79-case boundary runs, build and full compiler passed before renewal. Post-renewal source/privacy/planner checks and combined native-control/migration checks are recorded at their actual candidate identities in the staging handoff. No successful combined full gate, staging installation or human acceptance is claimed here.

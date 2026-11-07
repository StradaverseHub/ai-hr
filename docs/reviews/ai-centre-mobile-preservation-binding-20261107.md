# AI Centre preservation of the mobile staging release

Status: exact source comparison for human review; approval renewal is pending. This packet grants no release, staging acceptance, package publication or production permission.

The AI Centre candidate preserves final UI4a5a9de8c7c4c7a92dcce5d55a14b736336a87e7 and integrates mobile source109a046ef38f90514f1da458056aa09e015a47a4. The mobile release has claimed its earlier queue batch and is installing on staging; independent final arrival/handback must still be verified. Original D30 and its passing/failing results retain their own source/controller/baseline identities.

## Exact binding

| Input | Previously approved AI Centre source | Preserved combined source |
| --- | --- | --- |
| Provider transform source | 01412858d86338a16ad2117ef882284c043144bdc0655ae1c154306684816770 | 30dd256580cfd85dee9087f131c7a8b917a9ca3dad283730edcb461188218ca5 |
| Provider closure files | 1460 | 1460 |
| Module-agent source | 80ac5744dbc9a3f4316c12e6bd6e575809f630bd261ef7be0cb09f7e9f94e457 | b7f88c85a2901b574bf1396ddaf9bf3aee9e29831dbc020deff3ecde32d6ee09 |
| Module source files | 473 | 473 |

The full source delta from prior AI Centre candidateD30 adds11 incoming nonmanifest/nonapproval files byte-for-byte from mobile109a. The two generated manifests reflect the actual combined source. The approvals file remains byte-for-byte identical to D30: the same28 approved records still bind0141; both pending contracts and all reviewer/evidence/date metadata remain unchanged. Egress against the new digest remains blocked until actual human approval. Neither the mobile release's distinct approvals nor an earlier AI Centre approval is silently transferred.

## Covered native changes

Only three provider-closure files change:

- core/attendance.ts adds an optional requestIds filter to the existing scoped attendance-correction reader.
- core/claims.ts adds an optional requestIds filter to the existing pending-claims reader.
- core/read.ts adds optional requestIds filters to the existing leave and cancellation readers.

These filters narrow existing authorized native reads to the identifiers on the current mobile page. Existing company/tenant scope, native owners and single-request options remain. The incoming mobile coordinator shares simultaneous display reads only for the complete verified context, retains no completed response and does not own decisions. Its API/test/source files are preserved verbatim; they are outside the provider transform closure.

No provider serializer, prompt, outgoing field/category, destination, workload purpose or contract is changed by this preservation. Regeneration changes the exact source binding because the native reader bytes changed. The repository provider-data-reviews.ts rule requires actual human approval before renewing source-bound records even for this internal read change.

## Requested human decision

Carry the same28 approvals forward to exact provider fingerprint30dd256580cfd85dee9087f131c7a8b917a9ca3dad283730edcb461188218ca5, with both pending contracts and every original review metadata field unchanged. This permits provider-dependent verification and staging qualification only. Production remains on hold.

## Required verification

Verify the mobile owner's final actual source/build and normal shared-lease handback. Reconstruct the immutable combined impact and complete required checks, preserving all original failures and valid evidence under their actual source identities. Recheck704 ordered baseline migration hashes, rehearse appended2700/3000, independently authenticate matching worker bytes for the final combined candidate, prepare the protected administrator handoff, and perform exact source/build/worker/runtime/706ledger and rendered function/stop/permission journeys. Prior D30 bytes and witnesses cannot be relabelled onto this combined source.

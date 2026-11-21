# Board staging source binding — proposed renewal

## Reviewable candidate and scope

The owner approved implementation of the four board items and explicitly requested staging release on 8 November 2026. The four-item checkpoint is `8f3991941f3abd5d11494b549ca989a21d9eb64a` (PR234). The release immediately ahead of it owns staging lease65 and source `9dd3847b4a3ce9e4cf4df744edcf10b250dcbbb8` (PR230). Preserve that incoming source; this packet does not deploy it, claim its lease, or certify its acceptance.

Integration checkpoint `286167f60e9c01c8a9205e2a652d03db2dabbf6d` preserves both parents through a merge. The only manual code conflict combines their three distinct imports in `packs/rewards/service.ts`. The journal retains all709 entries from9dd unchanged and appends3300/3301; the four migrations' SQL bytes remain exact to their owning parents. The installed707-entry29d9 prefix was independently verified against all ordered live hashes. The incoming709 prefix must be verified again after that release arrives.

## Exact proposed provider fingerprint

The static closure contains1,465 source files. Its proposed fingerprint is:

`e5a7cf8cb8331fe4816bdad18b0d17feae665708ac38443082f210201bba4879`

The prior9dd fingerprint is `6375c8ceaa5f473e0e8cfa67c66dcf9ca0bd7dfb04d7365fed09a70ac1a5c4af`. Compared with9dd,21 covered paths change. The generated manifest is refreshed for review, but the literal approval registry has **not** been renewed.

| Covered sources | Assessed effect |
| --- | --- |
| core/company-refs.ts; core/pay-component-company.ts; core/pay-components.ts; core/payroll-individual-txn.ts; lib/pay-component-company.ts; packs/payroll/service.ts | Native company availability, company deletion retention, and dated new-entry checks. No new provider operation or automatic company/pay-item payload. |
| db/schema.ts | Nullable native company-availability column. Existing provider transforms still own outgoing shapes. |
| core/notifications.ts; packs/rewards/notification-recipients.ts | Bounded existing event delivery and current approver lookup; no provider call or financial event payload. Incoming AI Centre activity/stop controls retained. |
| packs/rewards/service.ts; packs/rewards/access-policy.ts; packs/rewards/dashboard-model.ts; packs/rewards/governance-model.ts; packs/rewards/preparation-model.ts | Existing native Rewards owners gain checked preparation, figure withholding, scoped dashboard aggregates and presentation preferences. New reads enforce live seats and confidentiality. These are local HR application operations; they do not add a provider dataset or a model decision. Existing AI Centre stop/read guards remain intact. |
| lib/permissions.ts | Registers two Rewards destinations under the incumbent screen owner, without a new provider capability or role grant. |
| messages/{en,ms,ta,th,vi,zh}.json | Action Centre name, company availability and preparation/dashboard copy. No new prompt or disclosure purpose. |

Package/lockfile, provider transports, source-root definitions, disclosure transforms, contract registry, consent rules, and provider review validation are unchanged from9dd. The new application surfaces do not add a provider call. No employee/payroll value, internal company/unit ID, catalogue, source snapshot, or credential is newly selected for transmission by these changes. Authored inputs continue to require their existing consent and finite contracts. This is a technical source assessment, not independent privacy certification or a new human approval.

## Requested bounded action

Renew only the `sourceDigest` literals in the same28 already-approved provider review records to the exact fingerprint above. Preserve the two pending/refused contracts and every original reviewer, timestamp, evidence, status and contract ID. A reverse replacement must reproduce the original registry bytes. Regenerate the module-agent manifest last; do not renew or activate any stored evaluation or promotion.

The repository rule in `lib/ai/provider-data-reviews.ts` requires actual human approval before editing that source-bound registry. The requested staging deployment does not assert the owner already inspected this new exact fingerprint. This packet makes that approval concrete. Any later covered-source change requires reassessment.

## Evidence and remaining work

Four-item focused run42465208956 passed32 checks; run42464417997 passed the whole compiler, Linux production build and six-locale setup component checks at its recorded source. The original release run42465873315 refused its stale provider manifest during plan/build admission; application/browser matrices were not admitted. Its actual terminal results remain original failures, never relabelled to this integration. Existing9dd qualification belongs to9dd only. The combined candidate still needs its full hosted gate, populated/native-owner rehearsal, fresh live-baseline reconciliation, lease admission, exact source/build/ledger arrival, restart/health and changed authenticated journeys.

Production installation and package publication are outside this request. Attendance Formula Builder and Maybank remain blocked on their board questions and are absent from this candidate.

## Actual owner decision

The owner answered the exact-fingerprint question in this release chat on8November2026: “Approve this exact renewal; continue staging”. Exactly28 literal source digests now renew to the fingerprint above. Reverse replacement reproduces the original registry byte-for-byte; both pending contracts and all original metadata remain untouched. This is the actual human authorization for the bounded renewal, not specialist certification, a hosted PASS or installation acceptance. The proposed-state descriptions above record the packet presented before that answer.

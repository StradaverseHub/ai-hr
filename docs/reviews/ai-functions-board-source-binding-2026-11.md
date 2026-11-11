# AI Functions and approved board release provider binding

The repository owner approved carrying forward 28 existing provider approvals on 10 November 2026 MYT. The approval covers review commit `d8b5566b40826c4ead708f1135d5fae883eb8a71` and provider source fingerprint `324b0005225b557a93812f5fa920b1edddeaa49cfae505352d09795628ac763c` across 1,476 files. The serving comparison source was `b698f5d35b0cca12e2c1268f3bea08d0aa1d070e` with fingerprint `020279efedc544846db0bcc91e6fba27b8c49725169178fa8307c1bc8b6b394c`.

The reviewed changes remove Attendance Formula authoring and its two public guidance topics, preserve historical payroll evidence, and update native attendance routing, payroll presentation and employee loop follow-up. Employee notifications and digests use the existing delivery channels. The provider diff removes the retired authoring contract and keeps existing outbound data fields, serializers and transport for the continuing contracts.

The registry changes only the source fingerprint on the 28 continuing approvals. Their original review metadata stays in place. The historical Attendance Formula approval remains bound to its prior source, its workload is unavailable, and both pending records retain their status. Agent evaluations and promotions remain bound to their original source.

The owner approved this exact provider binding. Staging installation and acceptance use the separate release procedure.

## Joint Schedule Group follow-up

On 10 November 2026 MYT the repository owner approved the repaired joint review commit `c406671e5f61d8fb915a91e74502d3ca818cff29` and its exact fingerprint `d6d5ec5e83b43e042e3ca0729815f5ca1b240e69293a99217df6095888fa03c1` across 1,479 provider source files. The serving comparison source is `5c990a639607b404a6d8fc7f78ca4752d2461476` with fingerprint `ffd2e1fec9fd42740bdd1cda8b4859237c78327bdca9471b17c9406b44eb58ce`. This binding supersedes the earlier approval for the different candidate above.

The approved Schedule Group work adds a native, dated clock policy and native attendance and payroll replay. Its new save action remains a native confirmation action. The clock policy, raw punches, and audit reasons remain in the application. The provider inventory removes the retired authoring purpose and public guidance topics. Existing outbound fields, approved purposes and transports remain the same.

Reversing the 28 substitutions yields the serving registry byte for byte. Both pending records and the retired Attendance Formula contract keep their prior bindings and review metadata. Existing evaluations and promotions retain their original source identities.

## Online clock compatibility repair

On 10 November 2026 MYT the repository owner approved compatibility review commit `39d25732db1ad349473521dc32a776e52840e891` and exact fingerprint `2213fbcc07038de42a8f6a10e554affddf99dc665c1c97269295928d63543027`. The repair restores the previous online punch response and removes the extra receipt timestamp from that response. The shared overtime parser test now exercises empty and explicit zero rates. No provider transport or payload gains data.

The same 28 approvals carry forward to the new fingerprint. Historical review metadata, both pending records, and the retired Attendance Formula contract keep their original values and status. This exact binding supersedes the earlier joint candidate above.

## Four approved board items: Shared Leave Groups, HRD Corp levy, Security Center Users and Schedule Group

On 10 November 2026 MYT the repository owner approved combined review commit `c040577e199c81f3f0e4a9f2955d6909c8a6a0c0` and exact fingerprint `af80e1f36af9182034c599c908a094566af5c935ca581848bc2cc61ab0911e4a`. The candidate integrates board items 50d9b809, c2ea9567, 07c98c36 and c03670cc on claude/fb-board-four-integration-20261110.

Outbound data changes are limited to three. A new read-only `shared_leave_groups` topic of the existing operations_status tool gives HR and group administrators each shared leave group's name, member leave type names, shared days per year, maximum days per application and employee placement; it returns no ids, employees, balances or requests, is refused to non-administrators before reading, runs under tenant row-level security and has its own AI Centre control (`read:shared_leave_groups`, migration 4800). The attendance-day explainer may label overtime minutes at a typed non-standard rate as "OT other rate" where it previously said Flat OT; the rate itself is not sent. HRD Corp wage base and levy values change under the corrected HRDF rule, in fields that already go out. An independent review found no other new outbound field from the HRDF breakdown stamp, the Security Center account controls or the group-wide clock policy.

The same 28 approvals carry forward to the new fingerprint. Historical review metadata, both pending records, and the retired Attendance Formula contract keep their original values and status. This exact binding supersedes the online clock compatibility repair binding above.

## Four approved board items: gate repair re-binding

On 10 November 2026 MYT the repository owner approved re-binding to repair commit `60030e151703e3698508b2302a7010c18e2b9db1` and exact fingerprint `b6e04e75dd91e46898fc6d8c509cf331e00bbae6e65ee9cf565d66859680312c`. The only covered-source change since the binding above is that the HRD Corp levy working stamped on payslips omits pay items that paid RM0, so it prints no +RM0.00 rows. That working is not read by any AI path. No provider transport or payload gains data, and the outbound changes recorded above are unchanged.

The same 28 approvals carry forward to the new fingerprint. Historical review metadata, both pending records, and the retired Attendance Formula contract keep their original values and status. This exact binding supersedes the four-item binding above.

## Architecture optimisation release binding

On 11 November 2026 MYT the repository owner approved carrying the existing approvals forward to this release's AI code version, in their words: "i fully approve carrying the existing approvals forward to this release's AI code version". The release is the architecture optimisation candidate on `claude/architecture-release-20261110` (head `ceb7fa849bcbb52fb1051883a95f2950a23042b0` before this record), with exact fingerprint `c4745ba3dfa34e710b67857fbb6069a539f8c674609c4d171289ecf8aca6f579` over 1,522 files.

No provider contract, outbound field or transport is added or widened. The covered-source changes since `b6e04e75…` come from the architecture candidate (bounded database admission, request-scoped shared read snapshots, Home and Claims read consolidation, online migration tooling, restored roster and Claims behaviour, and the deduplicated server source maps in `package.json`'s build script); none of them adds data to any provider payload.

The same 28 approvals carry forward to the new fingerprint. Historical review metadata, both pending records, and the retired Attendance Formula contract keep their original values and status. This binding covers this release only and grants no production authority; a later change to the covered source needs a new owner decision.

## Board staging window 1 (rebased on 8d5254eb)

On 11 November 2026 MYT the repository owner approved staging window 1 review commit `56454e12b2a46567b1319970606d1d3ee7aadfc5` and exact fingerprint `a146ce7f78b132b784519acd00be3aa4aedc03fdb3237f574ab6ec1c15ddbaa6` in the Claude board session ("Yes, I approve"). The window integrates board items 81e64843 (delete, retire and restore On/Off Boarding workflows), f3edc521 (Automatic sign-out under Password Policy) and eaa7697c (Personnel list search). No provider transform, outbound field, approved purpose or transport changes; the only changed file under lib/ai is the agent capability inventory, which registers the board actions as native handoff, internal or backlog entries.

The same 28 approvals carry forward from `b6e04e75dd91e46898fc6d8c509cf331e00bbae6e65ee9cf565d66859680312c` (the four-item board release 8d5254eb) to the new fingerprint. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status.

## Board staging window 2 (rebased on 8d5254eb)

On 11 November 2026 MYT the repository owner approved staging window 2 review commit `76c7f32a251b6c9eaf959b2b4ac9027893325521` and exact fingerprint `68679de0d5212e8341257bdc7f8f37674b9b14aced7da4c643a9f3b5c104084f` in the Claude board session ("Yes, I approve"). The window integrates board item b31981c0 (simplified Overtime Patterns editor). No provider transform, outbound field, approved purpose or transport changes; the only changed file under lib/ai is the agent capability inventory, which registers the board actions as native handoff, internal or backlog entries.

The same 28 approvals carry forward from `a146ce7f78b132b784519acd00be3aa4aedc03fdb3237f574ab6ec1c15ddbaa6` (board staging window 1) to the new fingerprint. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status.

## Combined optimisation release binding

On 11 November 2026 MYT the repository owner's approval to carry the existing approvals forward to this release's AI code version ("i fully approve carrying the existing approvals forward to this release's AI code version") is applied to the combined optimisation release on `claude/combined-release-fixes-20261111` (head `e109a581fff2db63ed48c941798d1805122182e6` before this record), with exact fingerprint `b0fd4f12ad94f19d862bb3478e8b01a54d69a4142fa3b7fb59de2ee5ab3bc20c` over 1,558 files. The release merges main through `9cf69292a`, including board staging window 1 above.

No provider contract, outbound field or transport is added or widened. Of the 229 covered files changed since `c4745ba3…`, the only changes under `lib/ai` or the AI governance path are the board window 1 capability inventory entries recorded above and lock-mode changes in `core/ai-governance.ts` (the provider-call pause checks hold the tenant Access lock shared instead of exclusive). The rest are the bulk background jobs, the reader/writer Access lock, the commit-sealed audit chain, Home and Personnel read consolidation and their security fixes; none of them adds data to any provider payload.

The same 28 approvals carry forward to the new fingerprint. Historical review metadata, both pending records, and the retired Attendance Formula contract keep their original values and status. This binding covers this release only and grants no production authority; a later change to the covered source needs a new owner decision.

## Combined optimisation release candidate 2 binding

The same owner approval ("i fully approve carrying the existing approvals forward to this release's AI code version") is applied to release candidate 2 on `claude/combined-release-rc2-20261111`, which merges the gate repairs and main through `6a21b7382` (board staging window 2 above), with exact fingerprint `2977f22beabd9029861706b724fa086f0ed462bfe40fb231bd738663453f8f35` over 1,558 files.

No provider contract, outbound field or transport is added or widened. Of the 11 covered files changed since `b0fd4f12…`, the only AI-path change is the capability inventory: board window 2's Overtime Patterns entries, and six release entry points classified as presentation reads (`internal:session_and_presentation`) or, for the roster prepare route that generates and copies rosters, `backlog:confirm`. The others move the leave colour and icon allow-lists into a dependency-free module, make a same-period payroll close retry instead of queueing, drop two redirect-only pages from the setup assistant's linkable destinations, and add translations. None of them adds data to any provider payload.

The same 28 approvals carry forward to the new fingerprint. Historical review metadata, both pending records, and the retired Attendance Formula contract keep their original values and status. This binding covers this release only and grants no production authority.

## Combined optimisation release candidate 3 binding

The same owner approval ("i fully approve carrying the existing approvals forward to this release's AI code version") is applied to the release after its second gate's repairs, on `claude/combined-release-rc2-20261111`, with exact fingerprint `5e63130395cffe5cb95023a4e1ce67884ff1234d8fc0279dadaae9485628fea4` over 1,558 files.

No provider contract, outbound field or transport is added or widened. The five covered files changed since `2977f22b…` are: `core/claims.ts`, where the Approvals claim queue resolves approval subjects once per employment and pages in SQL with the same results, proven by an equivalence test against the previous queue; `db/admission.ts`, `db/client.ts` and `db/read-retry.ts`, where a draining admission queue is served instead of refused at a fixed deadline and a refused permit, which started no work, is requested again; and a comment in `lib/internal-auth/store.ts`. None of them adds data to any provider payload.

The same 28 approvals carry forward to the new fingerprint. Historical review metadata, both pending records, and the retired Attendance Formula contract keep their original values and status. This binding covers this release only and grants no production authority.

## Combined optimisation release rc3 binding

On 12 November 2026 MYT the repository owner approved re-binding for this release without a further prompt ("Ai rebinding and approval can proceed without me. I have fully approved this."). The approval is applied to release candidate rc3 on `claude/combined-release-rc3-20261112` (head `62cf77b84676c4692405c16a21aeed21d337432e` before this record), with exact fingerprint `3baa446f7cfdbae12c6db4c7aebe9074409b8b96182164d6c0bb042e4dfe0a04` over 1,558 files.

No provider contract, outbound field or transport is added or widened. The covered-source changes since `5e631303…` change lock modes and read shapes only: the Assistant choice pickers, the AI Centre control check and the AI principal read take the shared Access lock instead of the exclusive one; the AI Centre, payroll-audit, loop and Personnel readers read set-wise; and every tenant transaction runs with JIT off. None of them adds data to any provider payload.

The same 28 approvals carry forward to the new fingerprint. Historical review metadata, both pending records, and the retired Attendance Formula contract keep their original values and status. This binding covers this release only and grants no production authority.

## AI-native exceptions and Today release binding (12 November 2026)

On 12 November 2026 MYT the repository owner approved re-binding the provider approvals for the payroll anomaly and net-swing source changed by the exceptions detectors branch (session handoff `ainative-handoff-20261111` §5 item 1). The owner then widened that approval the same day, relayed by the release coordinator: "I approve fully on the rebinding and the AI approval, dont have to wait for my decision". The approval is applied to the release candidate on `claude/ainative-release-20261112`, based on alpha `f7ee5177feb1ca37a11847bf9fe349c3deab0b0d`, which merges:

- `claude/ainative-exc-detectors-20261111` at `7b3170c7c7a753080978ddd56499e4ceee40fe2e`;
- `claude/ainative-exc-page-20261111` at `ea17cbdd1da4641fe0ece5871403a3aec5ece367` (it contains the detectors branch);
- `claude/ainative-today-employee-20261111` at `c35038453b712d3ff1374d713f3d72f4f959dd4f`.

The exact fingerprint is `2b50c1986a7aaa8e21d3c68e4a333c0972ea67674a28e304151e4d296d65a434` over 1,559 files. The previous fingerprint was `5e631303…`, over 1,558 files.

Twelve covered files changed, all from the detectors branch. The exceptions page and Today branches change no covered source.

- `core/payroll-anomaly.ts` and `core/payroll-anomaly-detectors.ts`: anomaly detection and batch resolution of open exceptions.
- `core/loops/net-swing.ts`, `core/loops/salary-payroll.ts` and the new `core/loops/swing-rows.ts`: the net-swing explanation rows. The new file is the one added to the closure.
- `core/pay-difference.ts`: pay difference.
- `messages/{en,ms,ta,th,vi,zh}.json`: translations.

They are in the closure through the payroll hypothesis and anomaly narration roots (`core/payroll-hypothesis.ts` imports `core/payroll-anomaly.ts`). No provider contract, outbound field, approved purpose or transport is added or widened.

The same 28 approvals carry forward to the new fingerprint. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status. This binding covers this release only and grants no production authority.

### Re-binding after rc3 (12 November 2026)

This binding follows the rc3 binding above. It is applied under the same 12 November 2026 owner approval, quoted above. The candidate merged alpha `05c4aa0348700a08de6723e88a67f2cbd43689d4`, which is rc3 as installed on staging. Re-binding on top of rc3's fingerprint `3baa446f…` (1,558 files) gives the exact fingerprint `80f49217133642f005e14d21bf76644de7a06f64a7d721b78bb43db45d2235fe` over 1,559 files. The earlier `2b50c198…` binding is superseded.

The covered files that differ from that alpha are the same twelve detectors-branch files listed above. In `core/payroll-anomaly.ts`, rc3's SQL paging of the cross-run exceptions queue merged cleanly with the detectors branch's batch resolve. Neither change adds data to any provider payload. The same 28 approvals carry forward to the new fingerprint. Both pending records and the retired Attendance Formula contract keep their original values. This binding grants no production authority.

### Re-binding after the first full gate's repair (12 November 2026)

Full gate 43120033983, attempt 1 at `7353338ba`, failed in one no-database unit. `test/agent-capability-inventory.test.ts` found that the exceptions page's new bulk "Mark as expected" action (`app/control-tower/exceptions/actions.ts` `markGroupExpectedAction`) was not classified.

It is now classified `backlog:approve`, the same ceiling as the single-exception resolve `resolveAnomalyAction`. It stays a human action on that screen, and the agent cannot prepare it. `lib/ai/agent-capability-inventory.ts` is the only covered file changed since `80f49217…`. No provider contract, outbound field, approved purpose or transport changes.

Under the same 12 November 2026 owner approval, the same 28 approvals carry forward to the exact fingerprint `def82461e55bc63977b0bbe0be16bec688bb025777019c8c9349777cdbf2ae1c` over 1,559 files. Both pending records and the retired Attendance Formula contract keep their original values. This binding grants no production authority.

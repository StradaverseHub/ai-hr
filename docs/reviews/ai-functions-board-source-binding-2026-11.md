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

## Board staging window 3 (rebased on 8d5254eb)

On 11 November 2026 MYT the repository owner approved staging window 3 review commit `00de11161fb623c3dece33d516e55ad1f267c49e` and exact fingerprint `56043471ab48e71069e2f62b97da6ef18d012b9f95dd877094b8a9af81aa33d2` in the Claude board session ("Yes, I approve"). The window integrates board item ccd3a65c (Import Employees correction fields and history, migration 4900). No provider transform, outbound field, approved purpose or transport changes; the only changed file under lib/ai is the agent capability inventory, which registers the board actions as native handoff, internal or backlog entries.

The same 28 approvals carry forward from `68679de0d5212e8341257bdc7f8f37674b9b14aced7da4c643a9f3b5c104084f` (board staging window 2) to the new fingerprint. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status.

## Board staging window 3 repair

On 11 November 2026 MYT the repository owner approved staging window 3 repair review commit `fbaa5d1ef8a525d01ee6113e8307f98c464a7349` and exact fingerprint `87c8f100d3c6afb8ba0ee7527ce60af1ced8edb3e123f4c89897a99ed80bd0dd` in the Claude board session ("Yes, I approve"). The window integrates board item ccd3a65c (Import Employees correction fields and history, migration 4900) with repair fbaa5d1e (Import Log run-page loading screen, permission registration and reviewed worker-compatibility pins). No provider transform, outbound field, approved purpose or transport changes; the only changed file under lib/ai is the agent capability inventory, which registers the board actions as native handoff, internal or backlog entries.

The same 28 approvals carry forward from `56043471ab48e71069e2f62b97da6ef18d012b9f95dd877094b8a9af81aa33d2` (board staging window 3 review 00de1116) to the new fingerprint. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status.

## Board staging window 3 on combined release f7ee5177

On 11 November 2026 MYT the repository owner approved staging window 3 on combined release f7ee5177 review commit `2d49115c5cf7e3f2372fc1acdadce099ff685418` and exact fingerprint `bb53ae0db356ff44b17fff59144b84f41468fce79ec8a0010a94327da17aa5f8` in the Claude board session ("Yes, I approve"). The window integrates board item ccd3a65c (Import Employees correction fields and history, migration renumbered to 5100) merged onto combined release candidate f7ee5177, with the section and register import jobs recording their section. No provider transform, outbound field, approved purpose or transport changes; the only changed file under lib/ai is the agent capability inventory, which registers the board actions as native handoff, internal or backlog entries.

The same 28 approvals carry forward from `5e63130395cffe5cb95023a4e1ce67884ff1234d8fc0279dadaae9485628fea4` (combined release candidate f7ee5177) to the new fingerprint. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status.

## Board staging window 4 on combined release f7ee5177

On 11 November 2026 MYT the repository owner approved staging window 4 on combined release f7ee5177 review commit `97232663ebdcf7ad6821cd72183add6e6ea6217d` and exact fingerprint `ae34a88e47bbd4ebf3c20b1cb1c1d03b9e521dd54f059ef18fd00ff789132f32` in the Claude board session ("Yes, I approve"). The window integrates board item 4452ba3c (Attendance approval workflow OR groups, stored previews and skipped ended chains, migration renumbered to 5101 with the 3210 shared submission lock). No provider transform, outbound field, approved purpose or transport changes; the only changed file under lib/ai is the agent capability inventory, which registers the board actions as native handoff, internal or backlog entries.

The same 28 approvals carry forward from `bb53ae0db356ff44b17fff59144b84f41468fce79ec8a0010a94327da17aa5f8` (board staging window 3 on combined release e28ed58f) to the new fingerprint. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status.

## Irwin board items combined staging release on window 4

On 12 November 2026 MYT the repository owner approved re-binding the provider approvals for the combined staging release of Irwin Law's eight approved board items, review commit `24066d7bd632b376c2737df9e5d6832f538db7aa` and exact fingerprint `5870fe6a094e898474f6552da69fe94d92d779e9faf41b6ae21b571e4c119e6d`, in the Claude board session ("yes approve"). The release merges onto board staging window 4 (`claude/staging-board-20261110d-w4`): 73cbffa1 (Leave type identity layout and icon/colour pickers), 792053e5 (payroll reprocess reprices formula-priced individual transactions, migration 5110), 1859cce0 (Import Employees error report and upload errors), 2f803985 (Schedule Group working pattern and relocated overtime bands), 2260a06b (contract and internship end dates, migration 5111), aa045103 (Personnel search suggestions and multi-select column filters), 82748f92 (People Configuration Settings page) and 8d02748a (readable import log references, migration 5112). No provider transform, outbound field, approved purpose or transport changes; the only changed files under lib/ai are the two regenerated source manifests.

The same 28 approvals carry forward from `ae34a88e47bbd4ebf3c20b1cb1c1d03b9e521dd54f059ef18fd00ff789132f32` (board staging window 4 on combined release f7ee5177) to the new fingerprint. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status.

## Irwin board items combined release: gate repairs

On 12 November 2026 MYT the repository owner pre-approved re-binding for staging releases ("Once done, release to staging, coordinate with the other sessions. And I approve fully on the rebinding and the AI approval, dont have to wait for my decision"). Full gate 43101582280 on `d1761f92a9e7cf9bae184ed6e8d970947310d3a3` failed seven test files. The repairs on `claude/irwin-combined-gate-fixes-20261112` change covered sources only in `core/import.ts` (each imported row now uses its own released savepoint), `core/improvement/definition-of-done-gaps.ts` (People Settings card hub listed) and `content/guides/admin-people-org.md` (guide link). No provider transform, outbound field, approved purpose or transport changes.

The same 28 approvals carry forward from `5870fe6a094e898474f6552da69fe94d92d779e9faf41b6ae21b571e4c119e6d` to the exact fingerprint `8f1b9ba06b4c38abc1920f996f73120d2c27961d84e468bdabd400959251cca7`. The review commit is the commit that records this section on that branch.

## Combined optimisation release rc3 binding

On 12 November 2026 MYT the repository owner approved re-binding for this release without a further prompt ("Ai rebinding and approval can proceed without me. I have fully approved this."). The approval is applied to release candidate rc3 on `claude/combined-release-rc3-20261112` (head `62cf77b84676c4692405c16a21aeed21d337432e` before this record), with exact fingerprint `3baa446f7cfdbae12c6db4c7aebe9074409b8b96182164d6c0bb042e4dfe0a04` over 1,558 files.

No provider contract, outbound field or transport is added or widened. The covered-source changes since `5e631303…` change lock modes and read shapes only: the Assistant choice pickers, the AI Centre control check and the AI principal read take the shared Access lock instead of the exclusive one; the AI Centre, payroll-audit, loop and Personnel readers read set-wise; and every tenant transaction runs with JIT off. None of them adds data to any provider payload.

The same 28 approvals carry forward to the new fingerprint. Historical review metadata, both pending records, and the retired Attendance Formula contract keep their original values and status. This binding covers this release only and grants no production authority.

## Irwin board items combined release: rebase onto rc3

On 12 November 2026 MYT the repository owner's pre-approval for this release ("Once done, release to staging, coordinate with the other sessions. And I approve fully on the rebinding and the AI approval, dont have to wait for my decision") is applied to `claude/irwin-board-combined-20261112`, which merges `origin/alpha` at `05c4aa0348700a08de6723e88a67f2cbd43689d4` (release candidate rc3, now on staging) into the gate-repaired Irwin release at `b05eb83d390856455d81f036a9358e6f929675d1`. The merged covered source has the exact fingerprint `4de1a055962d8fe58c752e7437fdfe5c25b8871ff67e11c8316d50cbbd9084aa` over 1,563 files; the agent source manifest is `9a323c538e0291fc354cd2acbace37927b1e63ed765a756687072cef35710276` over 487 files.

No provider transform, outbound field, approved purpose or transport changes. Apart from the two regenerated manifests and these re-bound approvals, no file under `lib/ai`, `core/teras-wiring`, `core/assistant.ts` or `core/ai-governance.ts` differs from the Irwin release, and only the agent capability inventory differs from rc3. Against rc3 the covered changes are the Irwin release's eight board items already recorded above (the only `lib/ai` change is the agent capability inventory's board entries); against the Irwin release they are rc3's lock-mode and set-wise read changes recorded in the rc3 binding (including `core/ai-centre-control.ts` and `core/ai-principal.ts`). The merge itself adds only comments naming the renumbered migrations (5123 and 5127) in `core/import-history.ts`, `core/import-actor-label.ts` and `db/schema.ts`. None of them adds data to any provider payload.

The same 28 approvals carry forward from `3baa446f7cfdbae12c6db4c7aebe9074409b8b96182164d6c0bb042e4dfe0a04` (rc3; this branch's previous binding was `8f1b9ba06b4c38abc1920f996f73120d2c27961d84e468bdabd400959251cca7`) to `4de1a055962d8fe58c752e7437fdfe5c25b8871ff67e11c8316d50cbbd9084aa`. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status. The review commit is the merge commit that records this section on that branch. This binding covers this release only and grants no production authority.

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

### Re-binding after Irwin 69de131e (12 November 2026)

Staging moved before this candidate was installed. The candidate merged alpha `69de131ecec4d132cf456d695f68337edff032e7`, the Irwin board release, which is now installed on staging. Its binding `4de1a055962d8fe58c752e7437fdfe5c25b8871ff67e11c8316d50cbbd9084aa` (1,563 files) reproduces from alpha's own tree. Under the owner's standing 12 November 2026 approval, quoted above, the same 28 approvals carry forward from that binding to the exact fingerprint `06f8b5ca8c882d880f24173e1e300e8936e338f354cf9617e836a7c262f61d05` over 1,564 files. This supersedes `def82461…`.

Thirteen covered files differ from that alpha, and they are this candidate's own changes:

- the twelve detectors-branch files listed above;
- `lib/ai/agent-capability-inventory.ts`, whose `backlog:approve` classification of `markGroupExpectedAction` the coordinator confirmed.

Irwin's changes to `core/payroll.ts` (re-pricing formula-priced one-off rows during payslip generation), `core/payroll-history-revisions.ts`, `core/payroll-individual-txn.ts`, the inventory and the message catalogues merged without conflict. They do not touch the anomaly verdicts, the findings or the Exceptions queue. No provider contract, outbound field, approved purpose or transport is added or widened. Both pending records and the retired Attendance Formula contract keep their original values. This binding grants no production authority.
## Information-correction read lock

On 12 November 2026 MYT the repository owner's pre-approval for staging releases ("Once done, release to staging, coordinate with the other sessions. And I approve fully on the rebinding and the AI approval, dont have to wait for my decision") is applied to `claude/ic-read-lock-20261112`, branched from `origin/alpha` at `69de131ecec4d132cf456d695f68337edff032e7` (the release on staging). The covered source changes from `4de1a055962d8fe58c752e7437fdfe5c25b8871ff67e11c8316d50cbbd9084aa` to the exact fingerprint `b68662143d3204ee71e6fbdb96b8fb7937c12901f9e07997a678e1d408fbc1be` over 1,563 files; the agent source manifest changes from `9a323c538e0291fc354cd2acbace37927b1e63ed765a756687072cef35710276` to `dfc7b45d47e64f6122f4a536d3bbc5c754b2fbe5b9ca044faba92d3347760d44` over 487 files.

The covered changes are lock modes only. `core/workforce-lock-mode.ts` (`joinWorkforceBarrierTx`, the Workforce 'maintain' barrier) now takes the shared Access lock inside a display read (`withAccessDisplayRead`) when its transaction holds none, as `joinAccessConfigurationTx` already does for 'view'; outside a display read it is unchanged. `core/cost-allocation-import.ts` wraps the per-company reference read in `withAccessDisplayRead`. The uncovered `core/information-correction.ts` opens the correction form and its review as such reads, without row locks, while the save keeps its exclusive lock and row locks. The authority checks and their results are unchanged. No provider transform, outbound field, approved purpose or transport changes; apart from the two regenerated manifests and these re-bound approvals, no file under `lib/ai`, `core/teras-wiring`, `core/assistant.ts` or `core/ai-governance.ts` changes. None of these changes adds data to any provider payload.

The same 28 approvals carried forward from `4de1a055962d8fe58c752e7437fdfe5c25b8871ff67e11c8316d50cbbd9084aa` to `b68662143d3204ee71e6fbdb96b8fb7937c12901f9e07997a678e1d408fbc1be` on the fix branch. Rebased onto staging alpha `2a486e58273726729fe4b1a5b3892ad7109b372e` (ai-hr-c2, fingerprint `06f8b5ca8c882d880f24173e1e300e8936e338f354cf9617e836a7c262f61d05`), they carry forward to the exact fingerprint `58325103e2f43020e77d3db1d094ac0799e97f7f5dc1455a55a157b569209f55`, which also covers the Personnel search dropdown fix (no AI source). Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status. The review commit is the commit that records this section on that branch. This binding covers this release only and grants no production authority.

## Remaining read-path Access locks

On 12 November 2026 MYT the repository owner's pre-approval for staging releases ("Once done, release to staging, coordinate with the other sessions. And I approve fully on the rebinding and the AI approval, dont have to wait for my decision") is applied to `claude/read-locks-20261112`, branched from `origin/alpha` at `2a2495919c3cf1c4ec66996f246deb7778806329` (the release on staging). The covered source changes from `58325103e2f43020e77d3db1d094ac0799e97f7f5dc1455a55a157b569209f55` to the exact fingerprint `ec60aebe9a35d56623c1e146cbdacbbd5faa66b6784a970af04d2655ce509de9` over 1,564 files; the agent source manifest changes from `930a9919b56339480887afc6a58e75305380dcf96658a984a719f649ad5cb3d2` to `4f50611837023ec1d130b23a3505a6b75b8ad4de6d0190b2354a924e17f0ca5d` over 487 files.

The covered changes are lock modes only (SCALE rule 1). Pure reads that took the tenant's exclusive Access lock now take it shared, with the same authority checks and the same results:

- `core/cost-allocation-import.ts`: the allocation template (`costAllocationWorkbookReferences`) and the import reviews (`previewCostAllocationImport`, `previewCostAllocationUpload`) run inside `withAccessDisplayRead` and join the shared workforce barrier. A review neither bumps the label criteria nor locks rows; the confirm and the employee-import commit keep their exclusive writer locks, repeat the review and refuse a different token.
- `core/employment-cost-allocations.ts`: `prepareCostAllocationsTx` gains a `review` option that runs the same 'maintain' checks and returns the same values and digest without the label-criteria and row locks. Every save still takes them.
- `core/import.ts`: the employee import dry run (`validateEmployeeImport`) reads its allocation sheet as such a review. The commit is unchanged.
- `core/assistant-actions/document-metadata-source.ts` and `document-metadata-review-store.ts`: the Assistant document choices read takes the shared Access lock before the same agent-action guard and administrator check. The prepare, confirm and reconcile commands keep the exclusive lock.
- `core/org.ts` and `core/assistant-actions/module-action-server.ts`: the Org chooser search joins the workforce barrier in the mode it holds instead of always taking the exclusive barrier. The Org section's availability, its choices and a review's labels run inside `withAccessDisplayRead`. The reviewed reporting-line commands are unchanged.

The uncovered `core/information-correction-import.ts` resolves an upload's employees and Direct Superiors in one statement each and reads the rows' organisation warnings in one transaction (SCALE rule 2). The uncovered `core/movement-import.ts` gains a comment on why the movement check stays exclusive. No provider transform, outbound field, approved purpose or transport changes. Apart from the two regenerated manifests and these re-bound approvals, no file under `lib/ai`, `core/teras-wiring`, `core/assistant.ts` or `core/ai-governance.ts` changes. None of these changes adds data to any provider payload.

The same 28 approvals carry forward from `58325103e2f43020e77d3db1d094ac0799e97f7f5dc1455a55a157b569209f55` to `ec60aebe9a35d56623c1e146cbdacbbd5faa66b6784a970af04d2655ce509de9`. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status. The review commit is the commit that records this section on that branch. This binding covers this release only and grants no production authority.

### Re-binding for the native Today endpoints (12 November 2026)

Branch `claude/mobile-today-server-20261112`, cut from staging alpha `2a2495919c3cf1c4ec66996f246deb7778806329` (fingerprint `58325103e2f43020e77d3db1d094ac0799e97f7f5dc1455a55a157b569209f55`, 1,564 files). It adds the native app's Today endpoints (GET `/api/mobile/v2/today`, POST `/api/mobile/v2/today/clock-out` and `/api/mobile/v2/today/undo`). Full gate 43160199776 at `a6d96dadd` failed in one no-database unit: `test/agent-capability-inventory.test.ts` found both POST routes unclassified.

They are now classified `internal:other_client_same_service` in `lib/ai/agent-capability-inventory.ts`, as every other mobile POST is. They are another bearer-token client of owners already classified: `confirmMissedClockOut` (core/loops/clock-out-confirm.ts) and `undoLoopAction` (core/loops/undo.ts), whose web entry points stay `internal:assistant_surface`. The person confirms or undoes their own day. The agent cannot prepare either action. No provider transform, outbound field, approved purpose or transport changes. No model is called by these routes.

On the candidate before alpha moved, under the owner's standing 12 November 2026 approval ("Once done, release to staging, coordinate with the other sessions. And I approve fully on the rebinding and the AI approval, dont have to wait for my decision"), the same 28 approvals carry forward from `58325103…` to the exact fingerprint `bb2b8fd020012cc24ef69b377455707247c856a0fdc6984ea1eb6d3a5e440b0b` over 1,564 files. The agent source manifest becomes `8704f035f58586e158fbdd51e17ce687ba69f4bc6f532def9804a7126e0bdd65` over 487 files. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status. The review commit is the commit that records this section. This binding covers this staging release only and grants no production authority.

Staging then moved to alpha `69e30634e` (remaining read-path Access locks, above), whose binding is `ec60aebe9a35d56623c1e146cbdacbbd5faa66b6784a970af04d2655ce509de9`. The candidate merged that alpha. The only covered file this candidate changes on top of it is `lib/ai/agent-capability-inventory.ts` (the two classifications above). Under the same approval, the same 28 approvals carry forward from `ec60aebe…` to the exact merged fingerprint `0d98715d0edf03d9945b00980eb26af4e57f8bf5f2764b7b3cc5cc9fc05c9839` over 1,564 files. The agent source manifest becomes `747fa7f3aa04bbcf5f71faa840d9f1af7b8fb2b0577c222a11c729bc8adba4f1` over 487 files. This supersedes `bb2b8fd0…`. No provider transform, outbound field, approved purpose or transport changes. Both pending records and the retired Attendance Formula contract keep their original values. This binding covers this staging release only and grants no production authority.

### Re-binding for the combined board candidate (12 November 2026)

Branch `claude/board-combined-20261112`, cut from staging alpha `f84f4c567` (binding `0d98715d0edf03d9945b00980eb26af4e57f8bf5f2764b7b3cc5cc9fc05c9839`, 1,564 files). It merges five board lanes: Rewards direct configuration (60f1fdcd), Rewards reviewer dashboard (4de410ed, 356ae8c1, 81a7b286), Rewards review desk and Review Set-up (37f82412, 70d5e7c5), On/Off Boarding routing and return assignment (259c6162, d1e26f81) and On/Off Boarding email (5a8c382c, 4a60b3ec, 6bdda222).

Fifty covered files change, seven of them new (`lib/email-body/doc.ts`, `lib/email-body/render.ts`, `lib/lifecycle-bulk-assignment.ts`, `lib/lifecycle-v9-recipients.ts`, `lib/lifecycle-v9-return-presets.ts`, `packs/rewards/config-change-model.ts`, `packs/rewards/config-change.ts`). They are Rewards and On/Off Boarding business services, email rendering and delivery, message catalogues and navigation that sit in the transitive import closure. The only covered AI file that changes is `lib/ai/agent-capability-inventory.ts`, which classifies the lanes' new server actions under existing classes (`backlog:approve`, `internal:session_and_presentation`, `handoff:access_and_authentication`). No provider transform, outbound field, approved purpose or transport changes, and no model is called by the new code.

Under the owner's standing 12 November 2026 approval, the same 28 approvals carry forward from `0d98715d…` to the exact fingerprint `864059a44d4e636f6bfa4e0ddeecf901bf12fdff65da2ece211c175caa6260dd` over 1,571 files. The agent source manifest becomes `2b0e9795a9c4dfbaac2831f9f7ddd155aa789617f62c453bbbf0721bff1d5008` over 487 files. Both pending records and the retired Attendance Formula contract keep their original values. Alpha has since moved past `f84f4c567` (binding `178bb617…`); admitting this candidate onto that alpha needs a fresh re-bind. This binding covers this staging candidate only and grants no production authority.

The candidate's inventory check (Actions run 43221493369) then found two classification drifts, fixed in `lib/ai/agent-capability-inventory.ts`: the Rewards desk cell edit `saveRewardCell` takes `backlog:approve` in place of the removed `saveInlineRewardIncrease`, and the read-only workflow dry run `planV9Workflow` is renamed `previewV9WorkflowPlan` and keeps `backlog:automatic`. No provider transform, outbound field, approved purpose or transport changes. Under the same approval, the same 28 approvals carry forward from `864059a4…` to the exact fingerprint `c9019d0abb4273edbf19614efe94e1bc1a4b7a6a99caa3325d6f9ccdf08041ef` over 1,571 files, superseding it. The agent source manifest becomes `a07f7db323e85757b68ef30e0cc3c09d90d0d5c398a1d0dc559d43cf843773bb` over 487 files. Staging candidate only; no production authority.

### Re-binding for the Rewards off-cycle lane base (12 November 2026)

Branch `claude/board-rewards-offcycle-20261112`, cut from the combined board candidate `claude/board-combined-20261112` at `78d560a68` (binding `c9019d0abb4273edbf19614efe94e1bc1a4b7a6a99caa3325d6f9ccdf08041ef`, 1,571 files). It merges Rewards Limit Controls (fc804e8c, `36eb5b459`) and makes the unit review policy form and the AI advisor settings form show the pools, lump-sum settings and advisor thresholds read-only once the reward year has a Limit Controls version (the server keeps the stored values on save).

The covered files that change are Rewards business services and models (`packs/rewards/access-policy.ts`, `advisor.ts`, `advisor-model.ts`, `engine.ts`, `index.ts`, `service.ts`, and the new `limit-controls.ts` and `limit-controls-model.ts`), notifications (`core/notification-registry.ts`, `core/notifications.ts`), `lib/product-context/destinations.ts` and the message catalogues, all in the transitive import closure. The advisor change keeps its existing outbound fields: the thresholds it already used now come from Limit Controls when the year has a version, and its settings save keeps the stored thresholds. The only covered AI file that changes is `lib/ai/agent-capability-inventory.ts`, which classifies the Limit Controls server actions under existing classes (`internal:session_and_presentation`, `backlog:approve`). No provider transform, outbound field, approved purpose or transport changes, and no model computes money.

Under the owner's standing 12 November 2026 approval, the same 28 approvals carry forward from `c9019d0a…` to the exact fingerprint `881a239951f451cce3eefab314ccbccab504e90e63dbeda5c458d2fb73225df1` over 1,573 files. The agent source manifest becomes `f44d1d73361a47397369dab19a991f66611c6468f81540ded4438647780bcf58` over 487 files. Both pending records and the retired Attendance Formula contract keep their original values. This binding covers this lane candidate only and grants no production authority.

### Re-binding for Rewards off-cycle and mid-year recommendations (12 November 2026)

Same branch, board item b945f0cc on top of the binding above (`881a2399…`). The covered files that change are Rewards business services and models (`packs/rewards/offcycle.ts`, `service.ts`, `limit-controls.ts`, `config-change-model.ts`, `dashboard-model.ts`) and the message catalogues; the only covered AI file is `lib/ai/agent-capability-inventory.ts`, which classifies the new server actions under existing classes (`saveDashboardKindAction` and `previewOffcycleYearAction` as `internal:session_and_presentation`, `saveOffcycleYearAction` as `backlog:approve`). Off-cycle balances are computed by the database; no model is called by the new code and no provider transform, outbound field, approved purpose or transport changes.

Under the owner's standing 12 November 2026 approval, the same 28 approvals carry forward from `881a2399…` to the exact fingerprint `150e07ce0b5cfa391239bb306780ba5ff51197650ee76ab3d21fc561633761b7` over 1,573 files. The agent source manifest becomes `b4b34720fc027349987132c1cc237e88e981dbe670890e139901c43401e68f1f` over 487 files. Both pending records and the retired Attendance Formula contract keep their original values. This binding covers this lane candidate only and grants no production authority.

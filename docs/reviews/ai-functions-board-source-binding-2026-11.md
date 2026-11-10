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

## Board staging window 1 (rebased on 8d5254eb)

On 11 November 2026 MYT the repository owner approved staging window 1 review commit `56454e12b2a46567b1319970606d1d3ee7aadfc5` and exact fingerprint `a146ce7f78b132b784519acd00be3aa4aedc03fdb3237f574ab6ec1c15ddbaa6` in the Claude board session ("Yes, I approve"). The window integrates board items 81e64843 (delete, retire and restore On/Off Boarding workflows), f3edc521 (Automatic sign-out under Password Policy) and eaa7697c (Personnel list search). No provider transform, outbound field, approved purpose or transport changes; the only changed file under lib/ai is the agent capability inventory, which registers the board actions as native handoff, internal or backlog entries.

The same 28 approvals carry forward from `b6e04e75dd91e46898fc6d8c509cf331e00bbae6e65ee9cf565d66859680312c` (the four-item board release 8d5254eb) to the new fingerprint. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status.

## Board staging window 2 (rebased on 8d5254eb)

On 11 November 2026 MYT the repository owner approved staging window 2 review commit `76c7f32a251b6c9eaf959b2b4ac9027893325521` and exact fingerprint `68679de0d5212e8341257bdc7f8f37674b9b14aced7da4c643a9f3b5c104084f` in the Claude board session ("Yes, I approve"). The window integrates board item b31981c0 (simplified Overtime Patterns editor). No provider transform, outbound field, approved purpose or transport changes; the only changed file under lib/ai is the agent capability inventory, which registers the board actions as native handoff, internal or backlog entries.

The same 28 approvals carry forward from `a146ce7f78b132b784519acd00be3aa4aedc03fdb3237f574ab6ec1c15ddbaa6` (board staging window 1) to the new fingerprint. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status.

## Board staging window 3 (rebased on 8d5254eb)

On 11 November 2026 MYT the repository owner approved staging window 3 review commit `00de11161fb623c3dece33d516e55ad1f267c49e` and exact fingerprint `56043471ab48e71069e2f62b97da6ef18d012b9f95dd877094b8a9af81aa33d2` in the Claude board session ("Yes, I approve"). The window integrates board item ccd3a65c (Import Employees correction fields and history, migration 4900). No provider transform, outbound field, approved purpose or transport changes; the only changed file under lib/ai is the agent capability inventory, which registers the board actions as native handoff, internal or backlog entries.

The same 28 approvals carry forward from `68679de0d5212e8341257bdc7f8f37674b9b14aced7da4c643a9f3b5c104084f` (board staging window 2) to the new fingerprint. Historical review metadata, both pending records and the retired Attendance Formula contract keep their original values and status.

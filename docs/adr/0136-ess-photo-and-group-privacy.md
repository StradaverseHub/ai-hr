# ADR-0136 — Photo approval and profile privacy share the existing request owner

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

Status: source implementation in progress; unverified and undeployed.

The approved Employee Change Requests revision2 replaces immediate own-photo writes with submission and HR decision. The existing profile_change_request and named routing owner remain canonical. Photo bytes belong in a request-bound side table, not proposal JSON, audit text or a general Personnel permission grant.

A pending proposal leaves the master photo unchanged. Approval rechecks current permission, named reviewer, route revision/context, state, active subject and master fingerprint, under the same policy and photo locks as the canonical writers. Rejection, permission withdrawal and PDPA redaction retain request metadata/history and remove pending bytes. The original master stays unchanged for refusals. Proposed-byte responses use fresh request visibility and private/no-store headers. Applied0571 remains immutable; additive0578 removes the former own master-photo RLS course.

Routing version2 adds explicit request types and exclusion criteria/identities. Version1 retains its positive-only semantics. Both inclusion and exclusion use the dated organisation resolver; empty exclusion means nobody, while empty inclusion still means all active subjects. Exclusions take priority. A fresh preview fingerprint binds actor, policy revision, targets, eligibility and selected rules before a version2 save. Historical assignments remain explicit; only a reasoned reassignment changes an existing request's route history.

Visibility version4 retains field choices and adds tab/section caps. Editable follows each field's supported authority; View Only caps every write including finite legacy emergency contact rights; Hide also strips linked source/derived facts before employee serialization. Tab controls cannot silently rewrite field settings. Hidden tabs and extra server panels are omitted, not merely concealed with CSS. Closing permissions atomically withdraws affected pending proposals while authorised HR master access remains unchanged.

Migration0578@1791900000058 is confirmed centrally. Its SQL is source-only and not journalled until Board1's verified0576/0577 arrive in ascending order. Required proof includes byte access/retention, stale baseline and reviewer refusals, real foreign users, concurrent saves, field/group precedence, exact old-policy compatibility, actual app save/reopen, six locales and keyboard/narrow views, populated restricted-owner rehearsal and the authentic full gate. Source checks or lifecycle exits do not establish PASS.

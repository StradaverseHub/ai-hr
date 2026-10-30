# Employee-code correction parity

Owned source package from frozen `1f5eab65a1cff89acb5409bfa5e451e7b6d03c58`. Freshly fetched main/alpha both
`7098cde191d98669560d08adb0bcc3b16d981ee9`; the explicitly assigned wave base was ahead249/behind7.
No integration or release claim is made.

Native `saveWorkforceCodeAction` reaches `core/workforce-code.ts#setWorkforceEmployeeCode`, also reached
by legacy `core/org.ts#setEmployeeCode` inside `setPersonAction`. This package invokes the SAME existing
SQL `app.access_workforce_set_employee_code` inside optional outerTx; default native behavior remains.
The broad legacy Personal Details composite remains backlog because its profile effect is independent.

The only human inputs are selected employment, matching subject alias, explicit nullable current code
and raw new code. Undefined baseline is rejected. Native normalization trims and uppercases letters,
numbers and dashes with the existing 30-character maximum. The canonical review shows exact previous
and normalized new code. The native claim owner checks tenant-wide employments and reserved Drafts;
only existing collision kinds can escape it, never claimant IDs, names or captured Draft data. Assistant
collision refusals are intentionally generic. A reservation obtained after review prevents confirmation.
Unchanged code produces no event and is handed back to the native screen without an orphan review.

Authority is the CURRENT positive native command company view+maintain permission, including non-HR
users. No fake HR role, raw-row grant, ESS/report grant, shared-person maintenance or all-company
restriction is added. A denial on another employment company of the same person does not block this
employment-grain correction. Selected-company denial blocks source/body access. Purpose Workforce
list projection supplies only authorized employee labels and code. The server-only scope helper locks
the selected employment before private metadata/body access and binds actual person/company ownership,
complete employment revision and policy generation into the private review digest. Person ID is not
sent to the browser. Fresh authority and source checks repeat on confirmation and recovery.

Intentional Assistant narrowing: the caller's own Person is refused for every role; native self editing
remains available. This action uses truthful workforce_maintainer metadata; the pure cached-role actor
mapper does not offer it without a current positive native capability witness. It has no inline hint
protocol and does not widen Assistant module reads; the native review page is separately guarded.

The existing encrypted generic assigned ledger owns admission, private commitment, explicit digest
confirmation, expiry/discard, replay, uncertain same-ID reopen, native-outcome privacy targets and erasure.
Completion requires both selected employment and employment.employee-code.set event written in the
CURRENT TOP-LEVEL transaction by the same login, exact employment/company/person binding and matching
native event after-code. The Person is ownership metadata and remains unchanged; its xmin is deliberately
not required to equal the correction transaction. Body custody and native writes roll back together.
No provider or external effect is introduced; pay, personal details and access do not change.

SQL0721/idx702/when1793330000050 is an unapplied PROVISIONAL source claim only, not installation priority.
Sibling0720 is separately owned. Every predecessor subject-kind, binding/verifier/outcome list and dynamic
registry-count bound is preserved additively; accepted historical SQL is unchanged.

Authored evidence includes the full native role matrix plus positive non-HR grants, explicit null baseline,
selected-company denials, no added cross-company person restriction, stale code/revision/policy generation,
tenant/login/subject/field refusal, both native collision kinds and late Draft reservation, exact-once
concurrency/replay/recovery, current-TX receipt, atomic late audit failure and native/supplied-Tx behavior.
Contract and actual streamed transport fixtures exercise all six operations and bounded Unicode labels;
six-locale real-control UI fixtures cover exact human/canonical review, separate consent, uncertainty,
expiry and desktop/mobile CI-only screenshot capture. These checks were authored, not executed locally.
Installed Next documentation was unavailable in this dependency-free checkout; the page follows the
existing awaited searchParams/access pattern. No dependency or runtime was provisioned.

Only static diff checks and source manifest generation are local. Parent owns exact-SHA Actions checks
with whole typecheck ON. No tests/compiler/DB/build/devserver/CI/push/PR/merge/deployment occurred here.
Global release hold remains.

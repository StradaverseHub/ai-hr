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

Nullable actor custody amendment (source only): this provisional migration extends the original
actor/subject scope CHECK for this exact action only. A current authorized USER may have no PERSON;
employment/company stay required and all testing columns stay null. The entire predecessor predicate
is retained in ELSE; subject-person, no-self, current principal, permission and receipt proofs remain.
Authored unrun fixtures use two actual app_user rows with personId:null, contrast the native owner in
a rolled-back outer transaction, then prepare/reopen/confirm/replay the real encrypted ledger. They
assert nullable actor versus nonnull true subject, exact user ownership, sealed-body presence/retirement,
foreign-login refusal, one native event and stale/fresh-self refusal after actor relinking.
The code fixture additionally covers a genuine unlinked non-HR USER granted native Workforce view and maintain.
No tests, collection, compiler, database, build or server were run for this amendment.


## Hosted-failure source repair, 30 October 2026

The isolated repair explicitly retains approved-passport base
f0389e30784e9a52a87bf73f8a03096910e0ca8d after freshly fetched main/alpha (272 ahead,
36 behind). Original native run41013029636 and commands run failures remain evidence;
this source repair makes no runtime PASS claim.

Positive Workforce command authority deliberately does not grant raw employment or audit-table
reads. The source's invoker SELECT of domain_event therefore hid the successful native event from
positively granted non-HR users. Provisional0721 now exposes a closed current-event locator returning
one UUID only. It checks current USER/principal, exact employment company command scope and actual
person/company ownership, no own person, current top-level employment and event xmin, exact native
aggregate/subject/user, explicit nullable before and persisted canonical after. Zero or multiple
matching events refuse. The existing completion verifier is unchanged. No domain_event RLS, native
0579 SQL/default code command, ledger or HR role is broadened.

Authored unrun fixtures retain all existing native HR/non-HR/null-actor/recovery coverage and add
raw audit/employment invisibility with successful bounded lookup; historical/current wrong expected
values; actual native event tampering of actor, aggregate, subject and before/after payload; ambiguous
UUIDs; released-savepoint row/event xmin contrasts; and direct scope refusals. Negative current-proof
cases require the native command to finish before the locator refuses, and all outer effects roll
back. The code expiry fixture now supplies valid created-before-expiry chronology in the past.

The code role adapter's create block now reads only the fixture target's stored employeeCode through
the fixture owner. Previously it called Assistant choices using groupOf(base) before role/reference
login setup and failed before all eleven code role cases executed. The offer, screen, own-confirm,
foreign-custody phases, names, roles and variants remain unchanged and still use each real role's
current authority.

Only static diff/source inspection and manifest regeneration were performed. No local tests,
collection, compiler, database, build, server, CI, provider, push or release operation was run.
Recommended affected hosted checks: assistant-employee-code-maintenance.test.ts; commands parity
entrypoint including all eleven code roles; existing strict transport/contract and static parity
guards; whole compiler. Preserve unaffected completed frozen-run evidence.

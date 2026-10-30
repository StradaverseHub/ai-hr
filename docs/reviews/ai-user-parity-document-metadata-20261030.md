# Ordinary Personnel document metadata — source candidate

The owned checkout starts at frozen wave3 source1f5eab65a1cff89acb5409bfa5e451e7b6d03c58 on
codex/ai-user-parity-personnel-document-meta-20261030. Fresh origin/main and origin/alpha were both
7098cde191d98669560d08adb0bcc3b16d981ee9; the assigned candidate diverged249ahead/7behind. The explicit
frozen base was retained. No inherited bank/creation repair, other worktree or protected ref was changed.

Only updateEmployeeDocumentMetaAction is classified registered:employees.document_metadata.maintain.
The human page /assistant/document-details edits an existing ordinary document's title, category and
description. Native upload, attachment replacement, hard deletion, download, all photos and issued
letters remain backlog/native handoffs. This is not full document-export parity. The page always links
back to native Personnel; no file chooser, bytes, generated content, physical-upload attestation,
provider call or download endpoint is introduced.

The native owner core/employee-documents.ts owns normalizeEmployeeDocumentMetadata (existing title
trim/slice200, category/description trim-to-null), its read/lock snapshot and the same actual
updateEmployeeDocumentMeta. The public writer retains default owned withTenant behavior and now accepts
optional outerTx and returns its native event ID. It still changes only those three fields plus the
existing updater/time audit columns. A native-owned additive metadataAfterHash is computed in SQL from
the actual UPDATE RETURNING title/category/description and included in employee-document.updated.
Raw description remains absent from the audit; proof internals do not enter the human flow.

Each Assistant interval proves a current human principal, Assistant grant, employees module and Approve
policy, then current HR role and the actual document's stored employment maintain permission BEFORE
private metadata is read or body custody is unwrapped. IDs resolve server-side and the posted employment
must match. Issued-letter pointers are rejected; the native0603 letter-folder trigger remains intact.
No-own-person approval is an explicit Assistant narrowing, checked against actual current app_user and
captured person. Documents are employment facts: another retained company's generic person denial is
not invented as a new document permission. Actual native employment denial and role/tenant/company
checks remain authoritative.

Preparation returns a closed metadata projection, filename/MIME/stored-size labels and exact normalized
before/after. It does not speculate a write. Access locks and the document FOR UPDATE are retained through
confirmation; company/employment/Access revisions and the document xmin bind a private reviewed digest.
The entitlement snapshot is canonicalized only for the private digest using the pure `canonicalEntitlementsForDigest` helper: module/company sets are sorted and deduplicated, nested setting object keys are deterministic, ordered setting arrays and every real value/status remain unchanged. The helper detaches its output, never mutates the current snapshot and is never used for permission decisions. A same-locked-native-source witness proves ordering equivalence and a real setting change still changes the digest.
The opaque document row revision also changes on attachment replacement, so bytes need not be read or
hashed. Runtime snapshot/choices queries deliberately never SELECT content. Existing oversized/invalid
legacy fields hand off instead of widening the contract or silently omitting consequences.

The one encrypted generic assigned ledger uses subject_kind employee_document and the exact document
ID, retaining stored employment/company/person binding.0720 wraps prior subject/binding/verifier helpers,
complete constraint expressions and index predicates. Every old kind delegates unchanged. The native
outcome owners extend additively and keep registry-derived bounds. Existing erasure/outcome targets are
only employment and person (supported by the shared target owner); no document target/table/ledger is
invented. The description is covered by native hash recomputation from the persisted row, not assumed
to exist in the native title/category audit payload.

First completion proves the document row and native event belong to the current top-level transaction,
current user, exact aggregate and stored employment; the row remains an ordinary document and records
the current updater. It verifies the native title/category payload and all-three-field after hash. The
TypeScript source also compares all three persisted fields to the exact reviewed result. Failures roll
back the whole metadata/event/custody transition. Concurrent delivery, replay and uncertain recovery use
the same saved action/event rather than issuing another mutation. If a later native deletion removes
the document, reopening fails closed and hands off to Personnel; no deleted row or old body is recreated.

Authored tests (not run locally):

- test/assistant-document-metadata.test.ts: actual native preparation/execution, exact normalized three
  fields, attachment preservation, content-column SELECT denial, source/attachment/company staleness,
  current role/grant/tenant/company/self refusal, wrong subject, native validation/late event rollback,
  concurrent confirm/reopen/replay, native outcome capture, current-XID/old-event/foreign-document proof,
  description tamper and null proof, exhaustive hybrid receipt constraints, genuine issued-letter
  generation/immutability and native handoff. All attachment contents are fictional in-memory fixtures.
- test/canonical-entitlements.test.ts: pure set/object ordering equivalence, ordered setting arrays, nonmutation, missing/null/scalar distinctions and actual tenant/status/module/scope/value changes.
- test/document-metadata-contract.test.ts: finite input, actual UTF-8 bound and no bytes/authority/proof
  internals in the public contract.
- test/document-metadata-transport.test.ts: actual six-operation packet registry and streamed response
  parser, valid full review above32KiB, wrong document/action ID refusal.
- test/document-metadata-panel.dom.test.tsx: actual employee/document selection, three human-entered
  fields, separate confirmation, expiry, lost-response recovery and six-locale desktop/mobile fixtures.
- Existing role matrix/coverage guard gains the native metadata adapter for every role. Exact fixed
  review-route expectations are extended. Native employee-documents and letter-generation suites remain
  relevant to the shared writer's default behavior and issued-letter protection.

Only static source inspection, JSON/journal inspection, whitespace checks and source-manifest generation
were performed. No tests, compiler, build, database, dev server, credentials/provider/business action,
CI, push, PR, merge or deployment occurred. No Next dependency/docs tree is installed; the new page follows
existing awaited searchParams without changing framework APIs. Exact-SHA independent review and parent
GitHub Actions verification remain pending.0720/idx701/when1793330000049 is provisional source allocation
only; release hold is unchanged.

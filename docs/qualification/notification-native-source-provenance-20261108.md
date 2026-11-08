# Notification source provenance and recipe-seal boundary

This is a source-only design checkpoint on codec source
`7041e59d487b211875d82c4c455bc805720dd4df`. It changes no SQL, migration,
profile, grants, worker, application, scheduling or resource budget. It does not
approve an installed expected profile or close the direct-LOGIN recipe gap.
Production stays held; all-family adoption and staging acceptance remain open.

## Exact evidence and scope

Retained authenticated inventory run `42430117622`, source
`c45b4fda7ecb4bc98c4228a0c8335b33c01be51d`, captured the complete native app
inventory in one repeatable-read/read-only snapshot on PostgreSQL160015. Its
one native case passed in25,976ms with socketClosed=true. These are component
observations at that source, not new checks of this child. Raw app inventory is
2,301 functions and3,281,255 implementation bytes; the old prototype's2,300
helper expectation remains unchanged. Membership must be derived and reviewed,
including prototype-added helpers; neither2,301 nor2,302 is a replacement guess.

The retained source record includes740 ordered migration SQL records, the
journal, three prerequisite source records and one explicitly unlisted SQL file:
745 records total. Offline verification independently checked every UTF-8 byte
count, SHA-256 and Git blob ID, each actual ordered ledger hash/timestamp, and
exact equality of all745 source files with this7041 child. The unlisted3211 SQL
is retained as UNAPPLIED, not represented as a ledger row or source of effects.
This740-ledger lineage is not the later combined743 staging lineage.

| Retained complete member | SHA-256 |
| --- | --- |
| notification-canonical-raw.json | `3e9ef16adc6d9e3a468b7829a9dc5169d9303c86f75b54163a456263beedf018` |
| notification-canonical-normalized.json | `e0b4596d0739f0b121f73433a6334c1b828cb70106a84ac182e58cf624318f09` |
| notification-canonical-source.json | `df509bd4ddc6a4a202eba749df70a417e9d2df15623e0c704ff5284319bb3c30` |
| notification-canonical-report.json | `f786a081282ff1961b97e726c14c74e989fcf0252aad9f25caf61eea2473cdc9` |

Raw catalogue, opaque defaults and original receipts remain in the private
retained artifact. The two companion indexes publish public source locations,
complete relevant replacement strings and hashes, not private access details.
They are offline derivations, not an approval API or a generated PASS receipt.

## Nine composed implementation bodies

[The composed-body index](notification-native-composed-body-provenance-20261108.json)
reconstructs each previously unmatched body from its latest literal CREATE body
and effective replacements in actual journal order. Every intermediate body
hash, exact needle/replacement, source line/hash and match count is recorded.
All nine final UTF-8 bodies equal the native captured prosrc byte-for-byte; all
115 effective substitutions have one match. No whitespace/identifier/OID
normalization or deparser approximation is used. This establishes the body
bytes' source derivation; it does not execute or certify the enclosing DO guard,
owner/ACL restoration, native parser, trigger behavior or business intent.

| Function, in app | Latest literal source | Effective steps |
| --- | --- | ---: |
| _draft_discard_source_snapshot(uuid,uuid) | [0859](../../db/migrations/0859_assistant_employee_draft_discard_custody.sql), then [0946](../../db/migrations/0946_draft_creation_cohort_custody.sql) | 2 |
| assistant_own_leave_reviews_redact(uuid) | [0622](../../db/migrations/0622_own_leave_review_store.sql), then0842/0851 | 2 |
| assistant_review_erasure_complete() | 0622, then0842/0851 | 4 |
| attendance_workflow_links() | [0592](../../db/migrations/0592_attendance_workflow_v4.sql), then [2301](../../db/migrations/2301_attendance_workflow_submission_shared_lock.sql) | 1 |
| audit_assistant_review_erasure() | 0622, then0842/0851 | 2 |
| native_outcome_completed_review_choices(jsonb) | [0822](../../db/migrations/0822_assistant_qualification_maintenance.sql), then0823..0859 in the recorded journal | 36 |
| native_outcome_review_completed(text,uuid) | 0822, then0823..0859 | 33 |
| native_outcome_targets_capture(uuid,uuid,uuid,text,uuid,uuid,jsonb) | [0650](../../db/migrations/0650_ai_native_outcomes.sql), then0842/0851 | 2 |
| native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid) | 0822, then0823..0859 | 33 |

The payroll reopen/reset replacements deliberately compose around the same
original needle. The resulting nested order follows0842 before0851; it must
not be flattened or reconstructed from a copied current list. The choices
numeric bounds become catalogue-derived bounds in0824. Subsequent no-op numeric
regex substitutions are not invented as body changes. Source role/metadata
checks remain separate obligations. Attendance2301 attribution proves only the
captured old lineage; the staging3101/3110/3210 union needs its own new derivation.

## All127 opaque defaults stay unmodified

[The defaults index](notification-native-default-source-provenance-20261108.json)
binds every signature, native argument/default display, raw AST SHA/byte count,
node-tag observation and one unique literal-body declaration with source bytes
and header. All127 native prosrc bodies have exactly one literal source origin;
all those headers declare defaults. Two names have explicit source rename steps:
[0845](../../db/migrations/0845_assistant_attendance_day_schedule_correction.sql)
preserves the attendance-command predecessor and
[0857](../../db/migrations/0857_assistant_performance_review_postimage_proof.sql)
preserves the assigned-review predecessor. A matching body alone does not prove
that a declaration's defaults reached the final signature; the rename locations
and complete native metadata remain review inputs.

The raw fields contain258 CONST nodes and one FUNCEXPR. The latter's native
display is now() on app.my_sync_family_child_relief(uuid,timestamptz). All2,301
prosqlbody fields are NULL in this capture; none is silently discarded. These
counts classify retained bytes, not a claim that parsing selected tags proves
all object references portable. Native proargdefaults includes source locations,
type/collation/function OIDs and datum encodings. Its raw bytes stay untouched.
Neither regex OID substitution nor comparing only pg_get_expr output is an
acceptable replacement for source/parser/native identity proof.

Before deriving an activatable helper profile, perform a version-bound native
replay in independently owned disposable hosted jobs from these exact740 SQL
and prerequisite bytes, preserving journal order and the actual role preparation.
Compare complete membership both ways, all ABI/owner/language/config/ACL/body
fields, the127 exact raw default fields and native displays. Perturb unrelated
object allocation in one replay; retain both raw catalogues. Resolve native
referenced identities through typed catalogues where supported; do not rewrite
opaque AST text. If raw defaults differ, retain both bytes and refuse portable
approval until a reviewed native mechanism can establish the exact typed
expression semantics. An unsupported node/field or unresolved reference refuses.
The existing capture bounds, standard runner and case/SQL/lock budgets remain;
plan separate bounded jobs rather than increase a case budget or truncate facts.

The final combined743 lineage requires the same derivation at its own exact
source/prerequisite/journal/ledger identity. This child does not authorize
recapturing arbitrary installed functions as expected truth. The later owner
must review final native engine/profile eligibility and each source-derived
expected body/metadata record before installation can consume them.

## Proposed native recipe seal, not implemented

The qualified [format1 codec](../../lib/notification-worker/recipe-seal.ts) and
[fixed read-only native encoder](../../test/fixtures/notification-worker/recipe-seal-codec.sql)
passed5pure+3native cases in run42433732041 at7041, independently API/artifact
verified by the root owner. Both complete ordered66-row contracts encode6,213
bytes. Actual v2 digest is
`2d70b80e3603a95ee4e81fe01f6f168f5556516be9a0a38568cd67d95ef5d891`;
actual v3 digest is
`b9518d01166a37215bb1fe41e109e67b8f516b83b8b2eded11ef7c86e38248dd`.
These bytes prove encoding parity at that source, never authority by themselves.

1. After helper provenance/profile review, add a guarded inactive append to the
   uninstalled prototype. Guard exact predecessor bodies, ABI/effective ACL,
   native relation/constraint/trigger metadata and absence of the new sealed
   state. Preserve body_md5 provenance and all existing fresh catalogue checks.
   Root alone allocates a later numbered migration after full-source integration.
2. The trusted owner supplies independently reviewed expected format/API/count/
   byte-length/digest and exact source/journal/prerequisite identity for the
   complete contract. Insert all66 explicit rows through the existing closed
   builder. In the SAME owner transaction, require complete native roundtrip and
   independently encoded full byte equality before creating/activating one
   immutable expected seal. Empty, partial, duplicate or arbitrary-current rows
   never become expected truth. No worker parameter, GUC, accepted flag or
   caller-reported build hash grants this ability.
3. Give the worker no read/write/DDL/EXECUTE capability for seal/control state.
   Seal both registry_contract and the new owner-only seal relation structurally
   in the process profile, increasing its explicitly reviewed relation set from
   four to six. Validate exact columns/defaults/checks/keys/RLS/ownership/ACL and
   expected row cardinality; a count alone is insufficient. The seal is keyed by
   the actual installed API version, not a caller-chosen variant.
4. admit_login and assert_process_profile recompute the complete ordered native
   format1 bytes and compare version/count/length/digest to trusted expected
   values BEFORE any event metadata/unknown-disposition branch. Keep all132
   existing admission frontiers and function/role/trigger/permission freshness;
   no success cache, caller epoch or admission deduplication is introduced.
5. Every canonical recipe has explicit subject/none/reader metadata. Both v2/v3
   retain the three unsupported automatic followup recipes, and command greeting
   remains audience none. Direct LOGIN project and finish_event must refuse
   known unsupported work. Deleting/retagging any known contract row must fail
   the fresh seal rather than become unknown-ignore. Genuinely unknown events
   retain the existing truthful ignored disposition. Canonical audience readers,
   payload guards and the single trusted-worker renderer remain their owners;
   a digest does not validate arbitrary rendered content or authorize new families.
6. Hosted hostile controls cover missing/extra/retagged recipe, changed guard,
   optional-not absence versus present-true, audience/port/implemented/category,
   API/count/digest/length/source/seal rows, schema/default/constraint/ACL tamper,
   wrong/recreated login, direct unsupported project/finish, genuine unknown
   positive and zero committed effects on refusal. Prove installation/reapply
   atomicity and exact restoration. Rerun affected native56 and paired6 at their
   new source identities, retaining old receipts unchanged; measure full fresh
   seal cost across all132 calls rather than claim it is free.

This design is not approval to install, arm, remove request-time catchup or drop
combined sweeps. Full-family canonical parity, durable source-intent ownership,
backfill/retention, protected non-superuser installation, process startup/stop/
recovery, throughput, browser/load comparisons and zero Busy remain separate
required work. No local application, DB, compiler, runtime or tests ran here;
only static source/evidence reads and byte/hash derivations were performed.

# Saved Personnel draft discard

Development implementation under source review. No installation, accepted migration ledger, deployment or release is claimed. The frozen dependency source remains PR136; this implementation composes only the verified Lifecycle helper payload from f5df91a75265fcff3a001642f79b9cb11b0fdd44 and c5178ded549b630bfaa97a3912156a317b91ca6b. Prior evidence stays attributed to its actual source SHA.

## Human action and native authority

`employees.draft.discard` reviews one persisted draft and its assigned company. A person explicitly consents to deleting the saved row and captured input without an application undo. The screen shows the stored label, company and actual native preview outcome: no reservation, a saved identifier without a numeric reservation, a released current tip, or a retained gap. It exposes no draft JSON, other-person fields, counter values, configuration IDs or private proof. Cancel review keeps the native draft. Lost replies recover through the original review or its caller-owned index.

The first slice requires the canonical Lifecycle owner to establish that no retained Onboarding case links to the draft, including while Lifecycle is off and for cancelled/completed cases. Other sources remain on the native Personnel screen. The native HR gate and existing draft RLS remain authoritative, including a genuine author after company-scope loss and a USER without a linked PERSON. There is no invented employee or universal company-maintain prerequisite. Native configured-tip RLS refusal rolls back; native non-tip gaps remain valid.

## Transaction and proof

```text
fresh actor + Access
  canonical Lifecycle absence helper
  bounded native source + configuration/counter locks (NOWAIT)
  caller-owned custody locks (NOWAIT)
  rollback-only native preview
  explicit subject/digest/consent confirmation
  same native discard: actual DELETE port → native release → native audit
  protected top-level proof → completed receipt
  COMMIT: retire all remaining pending draft reviews and their bodies
```

The port is owned by a dedicated NOLOGIN/NOBYPASSRLS role that inherits the application role one way. The real native SELECT/DELETE policies apply; no table-owner DELETE or copied permission formula substitutes for them. The child reads only private metadata and updates only deletion witness columns. It cannot read ciphertext, write source or admission fields, inherit the table owner, or be inherited/selected by the application login.

Six new private fields on the existing ledger bind an opaque hash of all thirteen stored draft fields plus xmin, an additional ctid version, minimal native counter-before metadata, transaction admission and actual deletion proof. No captured draft JSON is retained. SQL owns these values. A caller supplies neither a source row nor a witness. The actual DELETE lazily hashes its returned OLD tuple only for an exact bounded prepared version; ordinary native deletion avoids materializing an unsupported captured payload. The source course conservatively hands off compressed/oversize/numeric JSON shapes before serialization.

A protected current-transaction admission field is set only after the canonical helper and matching actual source. It does not prove deletion. An ordinary GUI transaction has no current admission and skips Assistant capture, preserving native linked-case behavior even when an old review exists. An admitted Assistant port rechecks the same helper immediately before DELETE; helper/try-lock failure escapes the whole transaction.

Completion checks the untouched witness tuple xmin before any completion UPDATE, the actual top-level native event, exact event payload, draft absence and native counter before/after. Released child-savepoint effects and pending no-op rewrites cannot become top-level proof. Normal deferred completion validation also checks the final commit course; forced IMMEDIATE checks establish their evaluation point, not a guarantee about later raw SQL writes. Historical receipts retain original proof while later transactions may advance numbering.

## Cleanup and privacy

The exact-table DELETE trigger stamps nothing. Its deferred ordered cursor retires ALL remaining pending activation/discard reviews for the deleted draft, including other USERs, then removes each corresponding body. It uses NOWAIT on both custody and content rows, has no global fanout cap, no skipped locks and no aggregate ID array. Current legitimate completion happens before this scan. Missing bodies allow row-only retirement. Already-terminal legacy body orphans remain outside this pending-cleanup claim.

Trusted storage-owner maintenance tries the existing OLD-tenant Access barrier first, without retargeting GUCs. Ordinary application deletion keeps its existing barrier. Non-increasing lock and statement bounds are installed before native work and retained through COMMIT. Timeouts, late locks, cancellation, audit/proof errors or incomplete cleanup roll back the whole command; no fixed fanout or elapsed-operation completion promise is made. Privileged TRUNCATE is outside the row-DELETE contract.

An additive hook on the existing protected erasure intent clears all six private fields, including completed bodyless proofs, while preserving original actor binding and canonical body-cleared counts. It requires the real erasure intent and existing deferred audit. Applied0622 is unchanged. Completed receipts whose proof has been erased become unavailable.

## Migration and hosted fixtures

Coordinator-assigned0752_assistant_employee_draft_discard_custody, idx731/version7/when1793330000089, is UNAPPLIED PROVISIONAL DEVELOPMENT ONLY. Reconcile above the actual accepted installation ledger before any future installation. No old SQL bytes change.

The actual restricted migration owner is NOCREATEROLE; provisioning is a separate operator prerequisite, not migration authority. A guarded test-only helper emulates that prerequisite only on the canonical disposable focused GitHub runner, before every template reuse/migration decision, and is included in the template fingerprint. It refuses incompatible or partial existing graphs rather than repairing them. Catalog-only prerequisite evidence is captured before migration.

The domain preflight permits a SUPER migration owner to skip only its own SET/not-inherited-USAGE checks; all child/application attributes, role paths, owners, RLS and schema checks remain active. Existing historical template migration stays on postgres. A separate REAL authenticated restricted-owner LOGIN rehearsal executes the exact new preflight and transfer DO blocks, checks denied role creation, unsafe schema privileges, transfer-failure rollback, restored prior role, revoked temporary CREATE and genuine app-login private/SET refusals. Its inert function placeholders establish ownership mechanics only; migrated native proof and RLS tests establish actual behavior separately. No live role, bootstrap, installation or controller change is authorized.

## Verification

Focused hosted groups are pending a frozen composition and independent source review. Planned evidence covers the strict contract/HTTP/panel and six-locale desktop/mobile fixtures; real native discard/activation and actor courses; all four reservation outcomes and top-level negative proofs; restricted-role/ownership mechanics; privacy; cleanup fanout and row/body interleavings; eleven real role-parity probes; registry and exhaustive old-kind hybrid closure. Every dispatched group requests the whole compiler on the exact40SHA, standard public runners only. Rendered fixtures are distinguished from authenticated browser journeys. No local tests, compiler, builds or databases are run.

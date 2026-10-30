# Organisation Assistant parity — first slice

Status: complete bounded catalogue action source authored; composed custody/UI hosted verification pending.

## Native inventory and boundaries

- Company listing/new/detail: app/admin/organization; core/admin owns company creation, general edits, parent, archive/delete. Country statutory identity resolves via localization registry; bank profiles and payroll cycle settings have separate owners. Composite company saves cannot be presented as one implemented isolated effect.
- Mounted System Labels save: app/admin/settings/system-labels/page.tsx -> saveLabelsGridAction -> core/admin.ts#bulkSaveLabels, which emits position.updated for the composite metadata/archive save. The older per-position archive action exists but is not mounted by the current grid. The latest source checkpoint now delegates its one archive-only subset to this mounted bulk owner in the SAME transaction; earlier legacy checkpoint remains historical.
- System Labels: departments, positions, business units, cost centres and their scope assignments use core/admin and core/system-labels. A position may be global or shared across companies; company_id alone is not its blast radius.
- Job descriptions: packs/job-descriptions/service owns draft/version/configuration/export and attachments. Binary upload/export remains a native handoff until a complete safe workflow exists.
- Reporting structure: existing org.reporting.change is implemented in Assistant but targets employment reporting, not catalogue administration.
- Settings have multiple authorities: tenant administration must retain each native service's actual gate; platform/operator/provider configuration, authentication and commercial module changes are excluded. Attendance/Payroll/Performance settings belong to their respective phase owners.

## First bounded effect

Single-company position archive/restore. Strict intent requires an opposite expected baseline; review includes native title/company/state. Private digest includes full stored metadata, row revision, origin company revision, Criteria rows/revisions/epoch and current native authority. Current source is authorized under native HR/origin-company scope before projection.

The Criteria owner now provides an additive read barrier using the same physical epoch rows/order without incrementing revisions. Access, leave configuration and all Criteria barriers precede position row lock. A native preview executes bulkSaveLabels inside an explicit rollback/release savepoint, retaining outer source locks. It refuses any native normalization that would change retained title/family/label/description or Criteria. Archive refuses the mounted grid's exact inUse predicate: ANY nonsuperseded assignment, including ended periods. Restore retains native duplicate/Criteria checks.

Confirmation repeats source/digest/preview, re-reads current metadata in that transaction and delegates one update to bulkSaveLabels. SQL0733's closed locator requires exactly one matching USER position.updated event and position row in the current top transaction, exact title/archived payload with omitted isGlobal, no subject employment, and the desired current state. Preview excludes top-transaction proof because its rolled-back effects are intentionally savepoint-local. The earlier legacy archivePositionTx extraction is removed; existing native archivePosition bytes return to baseline.

## Dependency and limits

Generic assigned custody cannot represent a position truthfully. Coordinator allocated UNAPPLIED PROVISIONAL0733 /idx713 /when1793330000070, permitting development CI only. The source now uses the same physical encrypted ledger through a position-specific compatibility adapter; it does not alter the shared engine or weaken assigned bindings. Native writer and current source guards remain authoritative. The complete composed action remains unverified until its actual candidate checks finish; it is not installed or accepted.

Authored focused DB tests additionally cover native preview rollback, stable read epochs, in-use refusal and Criteria staleness; original cases cover native archive/restore/event identity, stale edits, ABA, foreign tenant, global labels and employee refusal. Hosted results are recorded separately; no local tests/compiler/build/DB were run. No release or deployment is authorized.

## Complete slice source composition (pending new hosted verification)

`org.position.archive` is now wired locally through the existing encrypted physical ledger and `createReviewCustody`, the typed registry, shared same-origin HTTP owner, strict browser transport, closed completed-outcome reader, `/assistant/org-positions`, guarded Organisation link and all six locales. This implements only one archive/restore toggle of a canonical nonglobal position with no extra-company criteria. Creation, deletion, metadata edits, shared/global scope changes and batch saves remain native handoffs.

The position binding is tenant/user/nullable ACTOR person/company/position/desired state. Employment is NULL; no target employee/person is fabricated. Existing catalogue privacy capture uses `targets:[]`; the shared engine still captures a real actor person automatically. Public envelope digest/actionId are distinct from `body.nativeReviewedDigest`. Current native permission precedes body nomination/decryption; company/position bind the encrypted identity and commitment. Confirmation calls the unchanged mounted bulk owner and verifies a matching top-transaction native event/row; replay requires the same current position row version and exact original actor/event/kind/state. Own-login discard remains possible after native or Assistant permission loss. Canonical actor erasure retires its private body through the existing ledger erasure owner.

New SQL constraints wrap each predecessor predicate exactly once with an explicit new-kind branch. The canonical eight legacy receipt fields stay NULL; dedicated-family guards remain unchanged. No recursive `replace` of a full predecessor expression is used. Only coordinator-approved isolated shared fixes are adopted: d7 compiler, 9bd seed category, 22 probe counting, f82 bounded UNAPPLIED0726 and b55 bounded UNAPPLIED0716. Conflict resolution kept the held native 0726 subject owner and existing review facts, adding only f82's bounded expression and six-line note; no cost-recovery parent bundle was imported.

Inventory is additive: existing commands/requests/reviews/personnel partitions remain 10/13/13/7 actions. A fifth Organisation wrapper adds exactly one action and all eleven existing real role names, using the native mounted page's actual list/admission plus `bulkSaveLabels`; internal fixture role family is catalogue. Extra real unlinked USER, SYSTEM, foreign-login/company/tenant, role/grant loss, expiry, envelope mismatch, stale metadata, historical event, savepoint-local proof, actor erasure and hybrid-column fixtures are authored. Tests separately report actual constraint bytes and hosted PostgreSQL evidence. UI tests cover explicit confirmation, uncertainty, same-ID recovery, substitution, expiry, permission-loss discard and all six locales; hosted screenshots use real rendered components with fictional data and scripted endpoints, not an authenticated journey.

Verified historical source-only checkpoint: run41022930260 on89d7 source11 + archive panel10 + whole compiler PASS; Criteria16 PASS retained on0917/run41021703850. These results do not certify the new composed custody/UI source. No local tests, collection, compiler, build, DB or dev server were run. Release hold remains.

## First composed-run recovery

Run41026057810 on13770: all71DB cases passed; NODB/UI70passed and2failed. The new source11, custody15, role11 and UI12 passed; screenshot artifact12963712713 retained. Ledger38CHECKs total2,293,230bytes. Failures were the bounded grid-subaction entrypoint declaration and the old parent-page composition expectation. Whole compiler found only a SYSTEM test carrier using null instead of the actual optional userId type.

Recovery keeps the composite saveLabelsGridAction inventory in backlog and gives the bounded action no one-to-one native export claim. Its real page, bulk service owner and role probes remain explicit. The parent page now uses only the native boolean witness, with updated composition tests; no catalogue label enumeration for a shortcut. The Assistant adapter moves into core/assistant-actions/position-archive-source.ts so the existing governance source manifest binds it. All non-import source bytes are unchanged, verified by static SHA256 comparison. No shared manifest rule is widened. SYSTEM fixture omits userId; no authority change. No original failed run is relabelled.

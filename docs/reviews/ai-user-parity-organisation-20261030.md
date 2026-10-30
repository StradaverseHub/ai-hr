# Organisation Assistant parity — first slice

Status: mounted-grid native source preparation, NOT a complete Assistant action.

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

Generic assigned custody requires employment/person bindings and cannot represent a position truthfully. Coordinator migration request is recorded in the exclusive phase status file. No shared custody/registry changes, migration slot, HTTP exposure, six-locale UI, completed replay locator or erasure registration is claimed. The source cannot itself grant Assistant eligibility; the future adapter must repeat the shared action guard and encrypted custody lifecycle. Exact event-ID return is native transaction evidence, not a durable replay proof.

Authored focused DB tests additionally cover native preview rollback, stable read epochs, in-use refusal and Criteria staleness; original cases cover native archive/restore/event identity, stale edits, ABA, foreign tenant, global labels and employee refusal. Hosted results are recorded separately; no local tests/compiler/build/DB were run. No release or deployment is authorized.

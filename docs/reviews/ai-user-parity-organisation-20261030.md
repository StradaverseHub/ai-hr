# Organisation Assistant parity — first slice

Status: native source preparation, NOT a mounted or complete Assistant action.

## Native inventory and boundaries

- Company listing/new/detail: app/admin/organization; core/admin owns company creation, general edits, parent, archive/delete. Country statutory identity resolves via localization registry; bank profiles and payroll cycle settings have separate owners. Composite company saves cannot be presented as one implemented isolated effect.
- Mounted System Labels save: app/admin/settings/system-labels/page.tsx -> saveLabelsGridAction -> core/admin.ts#bulkSaveLabels, which emits position.updated for the composite metadata/archive save. The older per-position archive action exists but is not mounted by the current grid. This checkpoint prepares that legacy archive owner only; mounted grid parity remains pending.
- System Labels: departments, positions, business units, cost centres and their scope assignments use core/admin and core/system-labels. A position may be global or shared across companies; company_id alone is not its blast radius.
- Job descriptions: packs/job-descriptions/service owns draft/version/configuration/export and attachments. Binary upload/export remains a native handoff until a complete safe workflow exists.
- Reporting structure: existing org.reporting.change is implemented in Assistant but targets employment reporting, not catalogue administration.
- Settings have multiple authorities: tenant administration must retain each native service's actual gate; platform/operator/provider configuration, authentication and commercial module changes are excluded. Attendance/Payroll/Performance settings belong to their respective phase owners.

## First bounded effect

Single-company position archive/restore. Strict intent requires an opposite expected baseline; review includes native title/company/state. Source revision plus actor and tenant bind the digest. Confirmation repeats the authorized source lookup under the native workforce/configuration/label locks, delegates mutation/event to archivePositionTx, verifies the current resulting state and returns that exact native event UUID. Shared/global positions are refused. No employee identity is manufactured. Existing native archivePosition continues through the same transaction seam and preserves its void return.

## Dependency and limits

Generic assigned custody requires employment/person bindings and cannot represent a position truthfully. Coordinator migration request is recorded in the exclusive phase status file. No shared custody/registry changes, migration slot, HTTP exposure, six-locale UI, completed replay locator or erasure registration is claimed. The source cannot itself grant Assistant eligibility; the future adapter must repeat the shared action guard and encrypted custody lifecycle. Exact event-ID return is native transaction evidence, not a durable replay proof.

Authored focused DB tests cover native archive/restore/event identity, stale edits, ABA, foreign tenant, global labels and employee refusal. Hosted results are recorded separately; no local tests/compiler/build/DB were run. No release or deployment is authorized.

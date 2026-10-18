# Pay Items: create-only Excel import

This implements feedback `d15ef004-2995-4c31-a12e-8233448e8f42` at approved plan revision 1
(`4cd9935a086c0aaaa1b7b8a6f475561a3bf9f3dde429a84a402f6f92fdab525f`). The submitted workbook is
the presentation reference, not a second source of payroll defaults or statutory classifications.

`lib/pay-component-contract.ts` owns shared defaults and identity limits. The import vocabulary uses
the maintenance form's exact translated labels, enums and registered country-pack dictionaries.
`core/pay-components.ts` owns create validation and the transaction-aware create-only writer; the
import service supplies normalized input to that owner. Neither the browser preview nor an uploaded
Row Check formula authorizes a write.

## Record and calculation states

`pay_component.description` is optional presentation text (200 characters). It neither changes
payroll bases nor marks runs stale. Existing names and labels are preserved on migration; imported
names are initialized from the required Label. New codes accept uppercase ASCII letters, digits,
underscores and hyphens, at most 20 characters. Unchanged legacy codes/labels remain editable.

`pending_input_kind` is the sole stored pending fact. NULL means ready, including all existing
fixed/rule-bearing rows. `formula` derives the Formula pending caption; the other five calculated
kinds derive Calculation pending. A pending row must have SQL NULL `rule`. No placeholder fixed
rule, zero rate, arbitrary percentage or fabricated formula is installed. A complete rule must pass
the existing structural and catalog validator before the writer clears pending. A stale caller
submitting a NULL rule cannot clear it.

Migration `0562_pay_component_import_state` has centrally reserved journal index 562 and timestamp
1791900000042. The parent appends its journal entry after integrating 0560/0561; those migrations
and all applied predecessors must remain immutable.

## Atomicity, permissions and provenance

The authenticated same-origin route bounds the multipart stream before parsing, accepts XLSX only,
and enforces 5 MB / 1000 actual nonblank data rows. ZIP expansion is bounded before inflation.
Only Pay Items and its row-2 recognized headers are read. Unknown/advisory columns are ignored;
formula cells in imported fields are errors and are never evaluated.

Preview loads the catalog once and collects cell/row errors and warnings. Confirm re-parses the
original bytes, verifies the preview's SHA256, and revalidates today's catalog. The server ignores
browser-supplied normalized settings. All creates, inactive states, dependency ranks and audit
events share one transaction. Canonical manual/import creates and upserts share a tenant catalog
transaction lock. Active/inactive and case-normalized duplicate checks precede each create; the
database unique index remains the final backstop. A failed row, concurrent duplicate or audit fault
rolls back the whole file. The canonical create-only path cannot enter an update branch.

Permission remains the existing Pay Items administrator role and tenant RLS scope. No company count,
demo tenant, employment identity or additional grant is built into the implementation. Each created
code's existing domain event records its real actor and time plus Excel import and a bounded,
sanitized file name; descriptions and workbook contents are not copied into the audit payload.

## Consumer inventory

| Owner or consumer | Pending/description behavior |
| --- | --- |
| Catalog seed and statutory backfill | Omitted new fields remain NULL or preserve existing values; existing rule/flags are not backfilled differently. |
| Canonical create/upsert | Create validates identity/settings; edit preserves omitted descriptions; full validated rules clear pending. |
| Copy/new/edit screens | Description is distinct from Name/Label; copied pending types reopen the real editor with missing operands. |
| Archive/delete | Existing archive/delete lifecycle is unchanged; activating a pending item does not make it assignable. |
| Catalog/CSV export | Requested type and pending caption remain visible; description is exported as presentation text. |
| Fixed, individual and Personnel pickers | Read the same catalog with ready-only filtering; historical/read-only consumers retain all rows. |
| Recurring and batch writers | Refuse pending before any assignment write. |
| Individual transaction validator/derivation and transaction workbook | Refuse or exclude pending; cannot treat NULL rule as fixed input. |
| Full payroll and selective reprocess | Check used recurring, batch and individual assignments even with typed components disabled. Failure stays inside the payroll transaction. |
| Payroll Policy overtime conversion | Pending references are refused at policy save/activation/assignment and at conversion calculation. |
| Attendance Allowance definition/transfer | Pending references are refused in the definition and payroll projection owners; picker excludes them. |
| Overtime Pattern references and payroll pricing | Only ready earning items may be mapped/priced. Reference stamping omits the two new fields so existing activated-pattern bytes and description-only edits stay compatible. |
| Back Pay | Refuses pending components when reconstructing relevant recurring or batch entries. |
| Erasure/read/report projections | No separate pay-code identity writer exists in erasure; new fields do not authorize reads or change retained financial outputs. |

## Workbook differences made explicit

The generated workbook retains Instructions, Pay Items, Example, Field Guide and Lists, A:S/T
layout, C3 freeze, supplied band/header/cell styles, 500 advisory rows, conditional-formatting logic
and list/text-length validations. It generates master choices on each download. Field Guide keeps
the supplied nine-column shape and documents today's defaults.

Unpaid ORP remains N, overtime ORP is kind-aware, and the existing kind-aware EA default remains.
Explicit values, including Not mapped and Inactive, are retained. Per-day/per-hour plus proration
remains a hard refusal. The old phone/telco and meal exemption labels have no current equivalent;
they are rejected. Corrected illustrative examples explicitly name their current taxable
classification and ask Payroll to verify treatment; no exemption cap or eligibility rule is inferred.
The car-benefit example uses Non-payable/BIK. The overtime example remains pending until its actual
rate is supplied. The original workbook is not changed or claimed to import unchanged.

Error reports preserve the uploaded ZIP parts and original worksheet content and append literal
Import Result cells to the data sheet. They do not overwrite the upload or recalculate formulas.

## Verification required before release

Behavioral tests cover generated workbook structure/examples, literal/formula/header/file boundaries,
live-choice/default parity, all-cell diagnostics, duplicate refusal, real write-fault rollback,
concurrent creates, inactive creation, permissions, audit provenance, pending completion and payroll
process/reprocess refusal. The 1000-row test records actual validation duration and requires <10 s.

These tests do not replace the actual Excel and application journeys required by ADR-0104. Verify
the downloaded workbook in Excel, template dropdowns/row checks, paste/import/reopen all eight
corrected examples, mixed errors/no writes, error workbook download, duplicate re-upload, inactive
creation, pending completion/assignment/payroll refusal, relevant roles, all six locales, and mobile/
keyboard dialog navigation. Record actual runtime evidence; source preparation alone is not PASS.

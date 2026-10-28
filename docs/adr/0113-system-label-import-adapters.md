# ADR-0113 — System Labels import uses the existing editors and mutation owners

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- Date: 2026-10-13
- Status: Accepted
- Related: ADR-0073, ADR-0080; approved feedback 71b6c25f revision 1.

System Labels maintains company-linked organisation tables, tenant-wide employment option lists,
grades and grade groups. Their fields and scope differ. A generic table import would misinterpret
Department/Position identifiers, invent company scope for profile options, or detach grade membership.

The editor and workbook share the organisation category/column definitions. The workbook has one sheet
per supported organisation category, with the eight employment option sheets derived from the same
category list as the editor. Grades and grade groups use their own existing fields. Employment Type
remains fixed. Personal Profile Options are outside this Organisation Labels import.

Company names from the authenticated Reference sheet are accepted; IDs disambiguate duplicate names.
Company-linked additions require an origin company and explicit own/shared/global scope. Blank Company
never means Global. Shared and Global additions call the existing assignment/global services, including
their scope checks and automatic sharing enablement. Existing identifiers and company scope are never
renamed or reassigned by import. Tenant-wide categories stay tenant-wide.

Add New is the default. Exact duplicates are skipped; conflicting records require correction or the
explicit Update Existing mode. Its preview includes current/proposed editable values and requires an
update confirmation. Archived/inactive records must be restored through the editor. Grade-group members
reference existing active grade codes and use the Leave facade. An import cannot detach a grade from
another group or mutate a hidden reference field.

Preview is not write authority. Apply parses the workbook again, checks the live administrator/company
permissions and current records, compares a session/mode-bound snapshot fingerprint, and acquires table
writer locks until commit. Existing mutation services accept an optional already-scoped transaction so
the complete multi-category batch, scope changes and audit events commit or roll back together. This
transaction is supplied only by trusted server code; the existing standalone calls keep their guards.

Uploads allow only XLSX, at most 750 KB and 500 data rows, bounded worksheets/columns/cell lengths and
8 MB of ZIP expansion. Unsupported/encrypted archives and literal-field formulas refuse. Templates
format identifiers as text. Error reports contain safe string cells and worksheet/row references.
No production labels are written for acceptance checks and no new label storage or migration is needed.

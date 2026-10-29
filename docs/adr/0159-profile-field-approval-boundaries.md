# ADR-0159 — Profile field approval boundaries

- Date: 2026-10-29
- Status: Approved product direction in board item16173609; candidate verification and release remain separate.
- Related: migration0679; existing personnel field registry, profile permissions and routing owners.

## Decision

Version5 field policy records whether an editable field requires approval and whether supporting evidence is required. Missing rules preserve previous field defaults. Approval settings never grant visibility or edit authority. Canonical field validation and writers remain authoritative for both direct and reviewed changes.

Approval-off changes use a transaction-bound private SQL intent, exact physical deltas and an actual audit witness. Deferred guards reject incomplete transactions. The employee receives explicit saved and waiting field outcomes. Coupled banking, identity and passport/nationality changes, and changes within one register row, wait together when a submitted companion needs approval; half a valid bank account or dated row must not be applied first.

Supporting files belong to the request. Enforce three files at most,5MiB per file and10MiB total, supported signatures, exact evidence digests and scoped private reads. Transport limits accommodate those bounded files without changing the individual photo or notice limits.

Version3 routing snapshots all selected eligible HR principals at submission. Any one may decide; current authority and the subject context are rechecked, self-approval is denied, and terminal decisions serialize on the request. Saving later rules does not silently reroute an existing request. The dedicated Rules page uses the existing criteria and role owners.

## Verification boundary

Database permissions and deferred guards, service validation, concurrent decisions, attachment privacy, legacy compatibility and rendered controls require separate evidence. Synthetic UI captures do not establish authenticated installation acceptance. No change grants an agent authority to approve an employee's pending request.

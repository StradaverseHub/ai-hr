# Effective-dated Org Chart projection and explicit roots

Status: approved feedback34b9579a implementation candidate (4 November2026). Deployment and reporter acceptance remain separate.

`reporting_line` remains the single Direct Superior owner. `core/org-chart.ts` reads its administrative graph and dated assignment versions at the selected date; functional, project and dotted relationships remain independent overlays. Future versions must not replace today's graph prematurely. The canonical cycle helper checks intersecting date ranges, including cycles that would begin after a proposed relationship starts.

A missing superior is not proof of a top-level role. `org_chart_root` records an explicit, effective-dated HR designation without a backfill. Its writer uses the existing workforce-maintenance authorization and write serialization. Database triggers serialize on that same tenant access-configuration lock and reject overlapping roots, simultaneous administrative managers, self references and temporal reporting cycles. Shrinking a dirty historical edge remains possible so HR can repair existing data. Changes append domain audit events.

The projection retains the existing employment RLS and `app.can_see_employment` boundary. A company, business-unit, department, type, status, search or date filter can only narrow permitted data. Missing, inactive or inconsistent relationships appear as integrity states; restricted manager identities never reach the client. Counts, quick view and export read the same projection. An employee whose latest link ended on their permitted manager's cessation date receives a vacancy annotation, without resurrecting that link as a current parent.

PDF export is explicitly HR-admin authorized and rechecks the emitted employees before recording the export audit. Client-supplied collapsed nodes and selected branches can only remove nodes from the fresh permitted projection. A4/A3, orientation, current-view or full-branch selection, fit or numbered-page layout, company identity/logo, generation metadata and the optional Confidential mark are presentation choices. Unicode text reuses the existing PDF font owner. Numbered pages overlap their coordinate tiles and print whole cards; they never split a person's card between pages.

Large charts render collapsed branches progressively. Session preferences retain filters, search, layout and expanded state. No new relationship-editing surface, matrix-reporting owner or access grant is introduced.

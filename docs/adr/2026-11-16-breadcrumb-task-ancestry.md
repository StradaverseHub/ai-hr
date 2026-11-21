# Breadcrumb task ancestry

Status: Implemented candidate, awaiting hosted verification and staging acceptance.

The 16 November staging audit found 82 route/view cases with misleading module links or absent task ancestry. The shell previously used the first visible child as a module destination, so Payroll led to My Payslip and System Configuration led to Mobile App Builder. URL-prefix matching also assigned payroll setup and imports to Payroll Process, while non-descendant loan and report-builder pages had no active row.

A module grouping without an explicit landing page is now text. Security Center retains its actual admitted landing page. No new hub, permission, data reader or redirect is introduced. The sidebar remains the owner of admitted destinations; explicit breadcrumb families can resolve only when their owner row is present. Task parents use the actual existing settings, lists and import pages, with only relevant list scope carried back (for example a loan's employmentId). The existing current page heading supplies the record title.

Navigation ownership declares payroll setup, loans/history imports and report-builder descendants so the active row agrees with task ancestry. All 82 normalized audit entries have expected ancestor-link fixtures; DOM checks cover absent trails, unlinked grouping labels, record headings and same-path starter transitions. The audit's record variants and release window are not represented as exhaustive role or data coverage. Hosted checks and actual staging clicks remain separate acceptance evidence.

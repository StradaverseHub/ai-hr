# Original metadata reconciliation

Use this only when Information-Only Correction refuses a legacy employee because changes after payroll
finalization make the original display information uncertain. Never copy today's master values into an
old document snapshot. Retained original documents or independently verified original HR records must
establish every supplied value. If the evidence is incomplete, leave the correction blocked.

The operator prepares a private JSON manifest outside source. It contains version 1, tenantId,
actorUserId, verifiedOriginals true and an items array. Each item identifies payslipId, employmentId,
companyId and original values grade (the original displayed label, or an explicitly verified null),
employmentType (system code or verified null), hiredOn and joinDate. Each evidence entry carries a local
path, the SHA256 of the independently reviewed file and a short reference. Dates use YYYY-MM-DD. The
operator must be a current HR administrator for both the historical payroll company and the current
employee, with Workforce maintain access. The file bytes and local paths stay private; only references
and checksums enter the immutable reconciliation audit.

Run a dry-run first, selecting the private operator connection using the installation's normal procedure:

```
node --env-file=.env.local --import tsx scripts/reconcile-information-snapshots.ts /private/path/manifest.json
```

The default only validates files, bindings, permissions and immutable existing snapshots. It writes
nothing. Check the target installation and review the original evidence and the proposed metadata
before a separately authorised application:

```
node --env-file=.env.local --import tsx scripts/reconcile-information-snapshots.ts /private/path/manifest.json --apply --acknowledge-verified-originals --expected-database ACTUAL_DATABASE_NAME
```

An error rolls back the whole manifest. Existing different snapshots cannot be overwritten. Repeating
the same verified manifest inserts nothing twice. The script writes only missing display snapshots and
an audit event; it never updates employment, payroll, payslips, leave or attendance, and never regenerates
a document. After reconciliation, obtain a new correction preview rather than reusing a stale one.

This is an operator data-repair tool, not deployment authority. No staging or production application is
implied by building or testing it. Migration ordering must be reconciled with the current source freeze
before installation; see MIGRATION-ALLOCATION.md and ADR-0163.

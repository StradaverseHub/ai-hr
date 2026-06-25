# ADR-0047 — Business-decision reports + multi-format export

Status: Accepted
Date: 2026-06-25
Supersedes / relates: extends Wave 4 HR analytics (`core/analytics.ts`, ADR-pending consultant #3).

## Context

The feedback ask was a set of **market-standard business-decision reports** — Headcount,
All-Worker / Active Master Data (±compensation), Change Job, Termination, New Hire — each
**exportable in multiple formats** (Excel / CSV / PDF / Word) for individual / department /
company-wide / filtered records.

Most of this substrate already shipped in Wave 4 (`core/analytics.ts`):

- `headcountSummary` → **Headcount**
- `masterDataExport({ includeComp, includeTerminated })` → **All-Worker / Active Master Data ±Comp**
- `newHires` → **New Hire**, `terminations` → **Worker Termination**, plus `turnoverRate`

Export today is **CSV-only** (`lib/csv.ts#toCsv` + `app/analytics/export/route.ts`).

So this slice is an **extension in two tracks**:

- (A) one genuinely-new report — **Change Job Transaction** — plus department/free-text scoping;
- (B) **multi-format export** (CSV + XLSX + PDF) over the existing rows.

## Decisions

### 1. Report set — add Change Job; everything else already exists

Against the named report set, only **Change Job Transaction** is new. We add
`changeJobTransactions(ctx, scopeIds, { from, to, filter? })` reading the bitemporal
`assignment` version history.

**Versioning semantics (the subtle part):**

- Select the **successor** assignment rows whose `validFrom` falls in `[from, to]` and that are
  not correction tombstones (`supersededAt IS NULL`).
- `INNER JOIN` the **predecessor** version on
  `prior.employmentId = next.employmentId AND prior.validTo = next.validFrom AND prior.supersededAt IS NULL`.
  `transferEmployee` (`core/org.ts`) closes the prior open row (`validTo = effectiveDate`) and inserts
  the successor, so a real job change always has a closed predecessor abutting the successor.
- The `INNER JOIN` is the **"this is a job change, not a hire"** guard: a hire's genesis assignment
  has `validFrom = hiredOn` and **no** predecessor row with `validTo = validFrom`, so it is naturally
  dropped.
- **Terminations are excluded for free**: `terminateEmploymentTx` closes the open row **without**
  inserting a successor, so there is no in-window `validFrom` successor to falsely report.
- We expose `fromDepartment/toDepartment`, `fromPosition/toPosition`, `name`, `effectiveOn (= validFrom)`,
  ordered by `validFrom desc`.

### 2. No migration

Change Job reads existing `assignment` columns (`validFrom`/`validTo`/`supersededAt`/`departmentId`/
`positionId`). **No schema change.** RLS: `assignment_rls` (`0001_rls_grants_constraints.sql`) is
`USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))`; for an admin
`can_see_employment` is company-wide, identical to the `employment` read path the existing
`newHires`/`terminations` already use under the same session. We assert this with a test running under
`adminCtx`, not by inspection alone.

### 3. Read-only → no domain event

Every analytics function is read-only and appends **no** `DomainEvent`, matching the existing
`core/analytics.ts` header note. The new `changeJobTransactions` carries the same inline comment.

### 4. Scoping filter — department + free-text `q`, on roster/event reports only

We add `filter?: { departmentId?: string; q?: string }` to `masterDataExport`, `newHires`,
`terminations`, `changeJobTransactions`, **reusing the predicate shape from
`core/read.ts#listEmployeesPage`** (`departmentId → eq(assignment.departmentId, …)`,
`q → ilike(person.fullName) OR ilike(person.primaryEmail)`). "Company-wide" already works via
`scopeIds`; department + `q` give "individual / department-level / filtered-search". We deliberately
**drop** a per-report individual-`employmentId` export — you do not export a single termination as a file.
The comp gate (`includeComp && isAdmin(ctx)`) is untouched and never widened.

**Temporal-coherence fix (important).** `newHires`/`terminations` previously joined the **current**
assignment (`validTo IS NULL`). A terminated employee's assignment is **closed**, so its current join
yields a null department — filtering terminations by department on the current row would silently drop
every leaver. We therefore resolve the department/position against the assignment **effective at the
event date** (`hiredOn` for new-hires, `terminatedOn` for terminations, `effectiveOn` for change-job),
i.e. an `validFrom <= eventDate AND (validTo IS NULL OR validTo > eventDate)` join.
Master-data keeps the **current** assignment join; for master-data, a department-filtered export
**legitimately excludes employees with no open assignment** — recorded here as intended behaviour.

### 5. Export formats — CSV + XLSX + PDF; Word/.docx is **cut**

A neutral report shape — `{ filename, title, columns: string[], rows: (string|number|null)[][] }` —
is fed to three serializers in `lib/report-export.ts`:

- **CSV** reuses `lib/csv.ts#toCsv` (byte-identical to today).
- **XLSX** — see the dependency decision below.
- **PDF** reuses `pdf-lib` + the `safe()` Latin-1 guard from `lib/payslip-pdf.ts`.

**Word/.docx is deferred.** It is the weakest format for tabular rosters (nobody edits a headcount
roster as a Word table) and would add a multi-MB dependency + a localized Word-table serializer + a
PK-zip magic-byte test for the lowest-value output. Re-add only on explicit user demand.

### 6. The XLSX dependency decision (defending against the codebase's zero-dep taste)

The codebase has an explicit **pure-JS / zero-dep** posture: `lib/csv.ts` is "minimal, dependency-free";
`lib/payslip-pdf.ts` chose pdf-lib precisely for "no WASM/native, no bundler friction". Adding the
multi-MB `exceljs` dependency cuts against that taste, so it must be **justified, not merely decided**.

The justification for a *spreadsheet* export at all: CSV cannot carry typed/number-formatted cells, and
finance consumers genuinely want RM-formatted numeric columns and a bold header — that is a real gap CSV
cannot close.

**Chosen implementation: a zero-dependency SpreadsheetML / HTML-table `.xls` emitter** (the plan's
sanctioned fallback). It emits a `application/vnd.ms-excel` HTML-table workbook that Excel, Numbers and
LibreOffice all open natively, with a bold header row and right-aligned RM number cells — covering the
"Export to Excel" intent **without** adding `exceljs` to the shared dependency tree. This keeps the
codebase's zero-dep posture intact for this slice. If a future need requires true binary `.xlsx`
(multiple sheets, formulae, native number types), introducing `exceljs` is a follow-up that this ADR
pre-authorizes, gated on that need.

> Rationale for not adding `exceljs` now: the build runs in isolated worktrees that share a single
> installed `node_modules`; adding a heavy dependency there is both a bundler risk under Next 16 and a
> cross-build hazard. The HTML-`.xls` emitter delivers the Excel-openable spreadsheet with no new
> dependency and no serializer framework.

### 7. PDF is lossy for non-Latin names (documented, not fixed here)

`safe()` (`lib/payslip-pdf.ts`) replaces every codepoint outside `\x20-\x7E\xA0-\xFF` with `?`, because
Helvetica/WinAnsi cannot render CJK / Tamil / Thai glyphs. For a one-off payslip that is tolerable; for
a workforce roster it is a data-integrity caveat. **Decision: PDF is explicitly the
"human-readable summary" format and is documented as lossy for non-Latin names** — surfaced in the ADR
and as a one-line note next to the PDF button in the UI. **XLSX/CSV are the lossless tabular exports.**
Embedding a Unicode font in the PDF is an out-of-scope follow-up.

### 8. Empty-result handling

Every serializer must produce a **valid, openable** file for a zero-row report: CSV writes a header-only
file, the `.xls` HTML emitter writes a header-only sheet, the PDF renders title + header + a
"No records" line (no zero-row pagination crash).

### 9. Export headers stay English (backward-compat + i18n honesty)

Export **payload** column headers stay **English**, resolved from a constant (not `getTranslations`).
This (a) preserves byte-identical CSV output for existing external consumers / fixtures — localizing the
header row would silently change every CSV header and, for non-en locales, the content, with no golden
test guarding it; and (b) sidesteps the unenforceable "present-but-English" i18n gap (the coverage test
only catches missing/blank keys, not en-copied values). Only the **on-page UI** strings (card titles,
button labels, filter labels) are localized in all six locales — those are covered by the static
namespace/key checks. Localizing payload headers is a follow-up gated on a `differs-from-en` coverage
heuristic.

## Deferred (recorded so a future session does not re-discover them)

- **Word / .docx export** — lowest-value format for tabular data; re-add on demand.
- **Absenteeism report** — its data substrate does not exist: `db/schema.ts` stores present/late/half-day
  and **derives** absence (no row), `core/attendance.ts` computes absence by iterating expected working
  days and counting days with no row. There is **no code path that inserts `status='absent'`**, and
  `absenceReason` has zero reads/writes (a dead column). A `WHERE status='absent'` aggregate returns
  empty for real data. A correct absenteeism report needs a prior absence-row-capture + reason-entry
  slice first. Deferred alongside salary-benchmarking / dept-cost-control / payroll-validation.
- **True binary `.xlsx` via `exceljs`** — pre-authorized for when typed cells / multiple sheets / formulae
  are genuinely needed; not now.
- **Unicode-font PDF** — to make PDF lossless for non-Latin names.
- **Localized export-payload headers** — gated on a `differs-from-en` i18n heuristic.

## Consequences

- One new read (`changeJobTransactions`), one optional `filter` arg on four reads, one new serializer
  module (`lib/report-export.ts`), an extended export route, and UI format-button groups + a department/`q`
  filter — all read-only, no migration, no new runtime dependency.
- A golden byte-stability test pins the existing CSV output so the route refactor cannot regress external
  consumers.

# ADR-0096 — Clocking file mapping and import: a file ADDS clockings, it never writes over a day

- **Date:** 2026-10-08
- **Status:** Accepted with the approved plan for board item 50ed39e1 (round r424). Numbered 0096 because
  0095 is held by an unmerged branch (the lifecycle module); renumber at merge if that changes.
- **Amends:** ADR-0032 C6 (terminal punch import) and the terminal-punch note of ADR-0070.
- **Related:** migration 0518, `lib/clocking-file.ts`, `core/attendance-clocking-import.ts`,
  `core/attendance.ts` `addImportedPunchesBatchTx` / `assignPunchBusinessDays`, R45 multi-punch (0265),
  0341 (employee import history — the run-log precedent), 0474 (tenant-wide card ids).

## Context

Attendance › Import accepted one fixed layout ("staff_id, timestamp") pasted into a text box, and
`importAttendancePunches` reconciled it into ONE aggregate row per (employee, business day) — earliest punch
in, latest out — written with an UPSERT. That replaced the whole day: it wrote over Clock-screen clockings
and over times already corrected through an approved attendance request, wrote no `attendance_punch`
children, had no payroll interlock and kept no log. Real clocking devices write CSV or fixed-width TXT in
their own layouts, with their own In/Out codes.

## Decision

1. **Mappings.** A File Structure Mapping (`clocking_file_mapping`) describes once how a device writes its
   file: CSV/TXT, delimited (one character) or fixed width (1-based inclusive positions), header row,
   encoding (UTF-8, UTF-16LE/BE, Windows-1252 — decoded in the browser), the eight fields (six required:
   Card ID, Day, Month, Year, Hours, Minute) and the In/Out code table. Mappings are TENANT-WIDE: a device
   file names no company, and card ids are already tenant-wide (0474). The old layout survives as the
   built-in "AIHR Standard Template" — code, not a row, so every tenant has it and nobody can edit it.
   A used mapping is deactivated, never deleted (FK RESTRICT from the log).
2. **Reading is pure and shared.** `lib/clocking-file.ts` reads lines identically in the browser (the
   mapping test and the import preview) and on the server, which re-reads the text it receives and never
   trusts the preview. It refuses rather than repairs: real-calendar dates, 0-23 / 0-59, 20YY for a
   two-digit year, minutes only (seconds never read), Malaysia time as printed, codes trimmed and
   case-insensitive, a number cut short by a short line reported.
3. **An import ADDS clockings; it never writes over a day.** Each valid line becomes an
   `attendance_punch` child (method 'import', no geo, no clock capture) and the day is re-derived by
   `recomputeDayFromPunches`, exactly as Clock-screen multiple clockings are: first in, last out, closed only
   when ins and outs balance. The day type stamped on an existing row is kept (the first-clock-in freeze).
   A day row with no children (pre-multi-punch, or written by the retired importer) first has its own
   check-in/out synthesised as children so nothing is lost. This reverses the old upsert.
4. **Line decisions** (`core/attendance-clocking-import.ts`), re-run inside the import's transaction:
   matching card → employee code → IC digits against employments EMPLOYED ON THE DATE and visible to the
   importer (RLS) — out of scope reads "not found" and names no one; two answers at one level is ambiguous.
   A duplicate is the same employee, business day and minute (and direction when coded) from ANY source or
   earlier in the file, so re-importing a file adds nothing. Without codes, a day is read in, out, in, out;
   an odd count leaves it open; such lines may not add to a day that has Clock-screen clockings. A day
   corrected through an approved request, or owned by a CLOSED pay run, is refused; a day owned by a
   PROCESSED run is updated and that run marked needs-recalculation (`markBatchNeedsRecalc`). An approved
   overtime plan lands as at clock-out.
5. **Every import is logged** (`clocking_import_run` + one `clocking_import_line` per data line): who, when,
   file name / size / SHA-256 (never the file), the mapping as it was on the day, the reporter's counts
   (Failed = duplicates + unmatched cards + invalid date/time + other errors). Status is DERIVED, never
   stored. A run that throws saves nothing and leaves a Failed row written in its own transaction.
6. **Imports stay outside the geofence and device gate** (ADR-0070's disclosed bypass): they never call
   `checkInTx`. An end of the day supplied by an imported clocking carries no geofence reading.

## Consequences

- `importAttendancePunches` and its preview types are retired; one writer of imported attendance remains.
- Re-uploading a file is no longer a third "re-derive the whole day against a fresh schedule" path
  (core/attendance-recompute.ts says so); Recompute Attendance and correction approval remain.
- One file is capped at ~900 KB of decoded text (the server-action body), roughly 25,000 lines.
- Not done: dragging on fixed-width files, Excel input, other encodings, automatic pick-up from devices,
  deleting an imported clocking from the log, checking imports against clocking locations.

/**
 * Attendance service facade (ADR-0080 D11 criterion 3, rung 2).
 *
 * The ONE module outside-the-pack callers import for attendance services. It re-exports the pack's
 * implementation files in place — physical file moves are explicitly optional per D11; the
 * boundary is import discipline, enforced by test/attendance-pack-drift.test.ts: any file outside
 * the pack surface importing `core/attendance*` / `core/clocking-location` directly (instead of
 * this facade) fails the ratchet unless it is audited kernel-contract debt (the "attendance"
 * allowlist in test/pack-drift-allowlist.json — see packs/attendance/index.ts for who and why).
 *
 * Server-only in practice (drags in db/client) — never import from client components; the pack's
 * client-safe declaration is `packs/attendance/index.ts`.
 */
export * from '../../core/attendance';
export * from '../../core/attendance-allowance';
export * from '../../core/attendance-calc';
export * from '../../core/attendance-derive';
export * from '../../core/attendance-device';
export * from '../../core/attendance-rule';
export * from '../../core/clocking-location';
// `DayContext` is exported (as the same literal union) by BOTH core/attendance and
// core/attendance-derive; the ambiguous star export would silently drop the name from the facade,
// so re-export it explicitly (explicit exports take precedence over star ambiguity).
export type { DayContext } from '../../core/attendance';

export * from '../../core/attendance-explain';

export * from '../../core/attendance-clock';

export * from '../../core/attendance-clock-read';

// r424 (50ed39e1) — File Structure Mapping, Import Clocking Data and Import Logs.
export * from '../../core/attendance-clocking-import';

export * from '../../core/attendance-clock-data';
export { ClockDataChangedError, AttendancePayrollClosedError } from '../../core/attendance-punch-change';

export * from '../../core/attendance-rotation';
export * from '../../core/attendance-workflow';
export * from '../../core/attendance-application-history';

export * from './day-adjustment';

export * from './history-decisions';
export * from '../../core/schedule-group-controls';
export * from '../../core/attendance-shortfall';

// ADR0123 — canonical recorded inputs, consumed through this facade by Attendance writers.
export { captureCanonicalOvertimePersonnelContextTx } from './overtime-input';

export { previewOvertimePatternEmployee, previewOvertimePatternSample, calculateOvertimePatternDay, reconcileOvertimePatternDayTx, refreshOvertimePatternDayTx, overtimeSourceRevisionTx } from './overtime-calculation';
export { canonicalOvertimeInputTx, canonicalOvertimePayrollInputTx, canonicalOvertimeToilInputTx } from './overtime-input';

export { readOvertimePatternCalculation, readOvertimePatternCalculationTx, type OvertimePatternCalculationReview } from './overtime-calculation';
export { listOvertimePatterns, getOvertimePattern, overtimePatternSetup, saveOvertimePatternDraft, forkOvertimePatternDraft, validateOvertimePatternActivation, activateOvertimePattern, stopOvertimePatternVersion, archiveOvertimePattern, saveOvertimePatternAssignment, closeOvertimePatternAssignment, readOvertimeCalculationTx, lockOvertimeSourceTx, assertOvertimeSettlementAvailableTx, reserveOvertimeSettlementTx, releaseOvertimeSettlementTx, readOvertimeCashSettlementsTx, listCoveredOvertimeDaysTx, releaseOvertimeSettlementsForDraftTeardownTx, OvertimeOwnerError, type OvertimePatternDraft, type OvertimePatternDetail, type OvertimePatternListItem, type OvertimePatternSetup, type OvertimeRecordOutcome, type OvertimeCashSettlementRead } from './overtime-patterns';
export { createOvertimeCalculationOwner, readOvertimeSettlementForDayTx, readOvertimeCashDefinitionTx, readOvertimeDurationsTx, readOvertimeDurationDefinitionTx, hasOvertimePatternForDayTx, lockOvertimeDayForAttendanceWriteTx,
  type OvertimePatternVersionView, type OvertimeDurationRead, type CanonicalOvertimeInput, type CanonicalOvertimeSnapshot } from './overtime-patterns';
export {resolveOvertimeToilDurationTx, OvertimeToilEligibilityError, type OvertimeToilDuration} from './overtime-toil';

export {formulaOvertimeForRowsTx, formulaOvertimeCashForRowsTx, type FormulaOvertimeCashRecord} from './overtime-records';

// Own-profile read surface; canonical owner and RLS remain unchanged.
export {shiftArrangementHistory} from '../../core/shift-arrangement';

export { previewCardImport, commitCardImport, cardImportExisting, assertCardImportAccess } from '../../core/attendance-card-import';
export { setEmploymentCardId } from '../../core/attendance-card';

/**
 * 95d17761 — "Hide corrected movement records by default".
 *
 * A VIEW concern, deliberately kept out of `core/movement.ts`. Employment History is a projection over
 * the append-only `domain_event` ledger (ADR-0006 / ADR-0015): there is no row to delete, and the
 * as-of reconstruction the list and the detail view depend on replays every event including the dead
 * ones. So `movementHistory` keeps returning EVERY row — the projection is the evidence payroll, EA
 * reporting and the audit trail lean on — and the screen decides what to draw.
 *
 * A row is CORRECTED (dead) when it no longer describes anything that happened to the employee:
 *   • `reversed` non-null — rolled back, corrected (the reverse half of an edit) or cancelled;
 *   • `status === 'superseded'` — recorded, never applied, overtaken by a later conflicting movement.
 * Everything else counts. A PENDING movement is never hidden: it is dated in the future, it has not
 * happened yet, and it is precisely the one HR may still want to correct.
 *
 * Pure, so it is unit-tested directly rather than pattern-matched out of the page source.
 */
import type { MovementHistoryRow } from '../core/movement';

/** The identity a visibility decision actually needs — so a caller can pass a whole history row or a
 *  test can pass the two fields that decide it, with no fixture ceremony. */
export type MovementVisibilityRow = Pick<MovementHistoryRow, 'status' | 'reversed'>;

/** True when the row is a correction artefact that the default view takes off the profile. */
export function isCorrectedMovementRow(row: MovementVisibilityRow): boolean {
  // A live future-dated movement is never hidden. It is neither reversed nor superseded, so this is a
  // restatement of the rule below rather than a second rule — it is written out so a later change to
  // `statusOfRow` cannot quietly start hiding the one row HR most needs to see.
  if (row.status === 'pending') return false;
  return row.reversed != null || row.status === 'superseded';
}

export type MovementVisibility<T> = {
  /** The rows the table draws. */
  visible: T[];
  /** How many rows the default view took off the list — 0 whenever `showCorrected` is true. */
  hiddenCount: number;
};

/**
 * Split a history into what the Movement tab draws and how many entries that left out.
 *
 * `showCorrected` is the `?showCorrected=1` escape hatch: it restores the list EXACTLY as it rendered
 * before this item (muted, struck through, Reversed / Cancelled / Corrected / Superseded badges), so
 * nothing became unreachable — and, being a search param, it is per-view and needs no setting.
 */
export function partitionMovementRows<T extends MovementVisibilityRow>(
  rows: readonly T[],
  showCorrected: boolean,
): MovementVisibility<T> {
  if (showCorrected) return { visible: [...rows], hiddenCount: 0 };
  const visible = rows.filter((r) => !isCorrectedMovementRow(r));
  return { visible, hiddenCount: rows.length - visible.length };
}

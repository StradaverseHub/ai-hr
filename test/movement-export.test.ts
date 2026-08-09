/**
 * e6a144d4 — "Download Excel on the Movement tab".
 *
 * The builder behind the file is pure (lib/movement-export.ts, mirroring lib/movement-visibility.ts), so
 * the rules the reporter approved are asserted DIRECTLY here rather than pattern-matched out of a route:
 * every event is carried whatever its status, the status is spelled out on each row, the pay figure
 * arrives as a bare number, and a blank cell is blank rather than the screen's em-dash.
 *
 * The captions come from the REAL messages/en.json through a namespace-scoped translator, so a key that
 * does not exist fails here instead of rendering as a raw key behind a 200.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildMovementExport,
  movementExportColumns,
  movementExportFilename,
  movementExportRows,
  movementStatusLabel,
  type MovementExportRow,
} from '../lib/movement-export';
import { movementKindLabel } from '../lib/movement-kind-label';
import { toXlsxReport, type ReportData } from '../lib/report-export';
import type { MovementReversal, MovementStatus } from '../core/movement';

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const messagesOf = (loc: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../messages/${loc}.json`), 'utf8'));

/** A `people.detail` translator over a real locale file — throws on a missing key, like next-intl would. */
function translator(loc: string): (key: string) => string {
  const detail = messagesOf(loc).people.detail;
  return (key: string) => {
    const v = key
      .split('.')
      .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), detail);
    if (typeof v !== 'string') throw new Error(`missing people.detail.${key} in ${loc}.json`);
    return v;
  };
}
const t = translator('en');
const kindLabel = (kind: string) => movementKindLabel(kind, null, t);

const rev = (over: Partial<MovementReversal> = {}): MovementReversal => ({
  at: new Date('2026-08-01T02:00:00Z'),
  reason: 'Keyed against the wrong employee',
  corrected: false,
  cancelled: false,
  by: 'HR Admin',
  ...over,
});

function row(over: Partial<MovementExportRow> = {}): MovementExportRow {
  return {
    kind: 'promotion',
    status: 'applied' as MovementStatus,
    reversed: null,
    effectiveDate: '2026-08-10',
    entryDate: '2026-08-02',
    endDate: null,
    remarks: null,
    company: 'Fiamma (Chin Hin Property)',
    division: null,
    department: 'Finance',
    section: null,
    jobTitle: 'Finance Executive',
    currency: 'MYR',
    basicAmount: '4500.00',
    ...over,
  };
}

describe('e6a144d4 — Employment History export builder', () => {
  it('spells out all six event statuses, reversal winning over the derived status', () => {
    // The reporter asked for Applied, Pending, Reversed, Cancelled, Corrected and Superseded, each
    // readable, sortable and filterable inside Excel.
    expect(movementStatusLabel({ status: 'applied', reversed: null }, t)).toBe('Applied');
    expect(movementStatusLabel({ status: 'pending', reversed: null }, t)).toBe('Pending');
    expect(movementStatusLabel({ status: 'superseded', reversed: null }, t)).toBe('Superseded');
    expect(movementStatusLabel({ status: 'reversed', reversed: rev() }, t)).toBe('Reversed');
    // bd89ccd8 — undone while still pending: it never applied, so the word is Cancelled.
    expect(movementStatusLabel({ status: 'reversed', reversed: rev({ cancelled: true }) }, t)).toBe('Cancelled');
    // 66a63bd6 — the reverse half of an EDIT. Corrected beats Cancelled when a pending row was edited.
    expect(movementStatusLabel({ status: 'reversed', reversed: rev({ corrected: true }) }, t)).toBe('Corrected');
    expect(
      movementStatusLabel({ status: 'reversed', reversed: rev({ corrected: true, cancelled: true }) }, t),
    ).toBe('Corrected');
  });

  it('never leaves the status cell blank, even for a reversed row with no reversal record', () => {
    // Unreachable through core/movement.ts (it derives the one from the other), but a column whose whole
    // purpose is to name the state must not be able to come out empty.
    expect(movementStatusLabel({ status: 'reversed', reversed: null }, t)).toBe('Reversed');
  });

  it('carries EVERY event, including the ones 95d17761 keeps off the profile', () => {
    // The screen hides reversed / cancelled / corrected / superseded behind a Show link. The download
    // deliberately ignores that filter — this is the approved behaviour, not an oversight.
    const rows = [
      row({ kind: 'hired', status: 'applied' }),
      row({ kind: 'confirmation', status: 'applied' }),
      row({ kind: 'promotion', status: 'pending' }),
      row({ kind: 'transfer', status: 'reversed', reversed: rev() }),
      row({ kind: 'increment', status: 'reversed', reversed: rev({ cancelled: true }) }),
      row({ kind: 'demotion', status: 'reversed', reversed: rev({ corrected: true }) }),
      row({ kind: 'secondment', status: 'superseded' }),
    ];
    const built = buildMovementExport(rows, { t, kindLabel });
    expect(built.rows).toHaveLength(7);
    expect(built.rows.map((r) => r[1])).toEqual([
      'Applied', 'Applied', 'Pending', 'Reversed', 'Cancelled', 'Corrected', 'Superseded',
    ]);
  });

  it('splits the pay figure: Currency is a label and Basic Salary is a BARE number', () => {
    const [r] = movementExportRows([row()], { t, kindLabel });
    expect(r[10]).toBe('MYR');
    expect(r[11]).toBe('4500.00');
    // The one thing this column exists for: toXlsxReport marks a cell x:num only when it parses as a
    // plain number, so anything carrying the currency label is text an operator cannot sum.
    expect(r[11]).toMatch(/^-?\d+(\.\d+)?$/);
    expect(r[11]).not.toContain('MYR');
  });

  it('the amount really does reach the workbook as a NUMBER cell', () => {
    const built = buildMovementExport([row()], { t, kindLabel });
    const data: ReportData = { filename: 'x', title: 'Employment History', ...built };
    const xml = new TextDecoder().decode(toXlsxReport(data).bytes);
    expect(xml).toContain('x:num="4500.00"');
    // …and the currency column beside it is emphatically NOT a number cell.
    expect(xml).not.toContain('x:num="MYR"');
  });

  it('a row with no compensation yields two empty cells, not "null" and not a re-parse crash', () => {
    const [r] = movementExportRows([row({ currency: null, basicAmount: null })], { t, kindLabel });
    expect(r[10]).toBe('');
    expect(r[11]).toBe('');
  });

  it('blank cells are EMPTY — never the on-screen em-dash', () => {
    const [r] = movementExportRows(
      [row({ entryDate: null, endDate: null, remarks: null, division: null, section: null, company: null, jobTitle: null })],
      { t, kindLabel },
    );
    // A dash is a VALUE to a spreadsheet: it poisons sorting and filtering on the column it sits in.
    expect(r).not.toContain('—');
    expect(r.filter((c) => c === '')).toHaveLength(8);
    // Effective date and the two labels that always resolve are the cells that stay populated.
    expect(r[2]).toBe('2026-08-10');
  });

  it('prints the rollback / cancellation reason, and leaves it blank on events that were neither', () => {
    const [undone] = movementExportRows([row({ status: 'reversed', reversed: rev({ reason: 'Wrong grade' }) })], { t, kindLabel });
    expect(undone[13]).toBe('Wrong grade');
    const [live] = movementExportRows([row()], { t, kindLabel });
    expect(live[13]).toBe('');
    // A rollback recorded with no reason must not print "null".
    const [noReason] = movementExportRows([row({ status: 'reversed', reversed: rev({ reason: null }) })], { t, kindLabel });
    expect(noReason[13]).toBe('');
  });

  it('the fourteen approved columns, in the approved order', () => {
    expect(movementExportColumns(t)).toEqual([
      'Event Type', 'Event Status', 'Effective Date', 'Recorded at', 'End Date', 'Company', 'Division',
      'Department', 'Section', 'Job Title', 'Currency', 'Basic Salary', 'Remarks', 'Correction Reason',
    ]);
  });

  it('header list and row shape cannot drift — every row is exactly as wide as the header', () => {
    const rows = [row(), row({ status: 'pending' }), row({ status: 'reversed', reversed: rev() })];
    const built = buildMovementExport(rows, { t, kindLabel });
    expect(built.columns).toHaveLength(14);
    for (const r of built.rows) expect(r).toHaveLength(built.columns.length);
  });

  it('resolves the whole column set in all six locales (no raw key at runtime)', () => {
    for (const loc of LOCALES) {
      const tl = translator(loc);
      const cols = movementExportColumns(tl);
      expect(cols, `${loc}.json`).toHaveLength(14);
      for (const c of cols) expect(typeof c === 'string' && c.length > 0, `${loc}.json blank caption`).toBe(true);
      // The status captions the file prints, in every locale.
      for (const s of ['applied', 'pending', 'superseded'] as const) {
        expect(typeof tl(`movement.status.${s}`)).toBe('string');
      }
      for (const b of ['reversedBadge', 'cancelledBadge', 'correctedBadge', 'exportExcel']) {
        expect(typeof tl(`movement.${b}`), `${loc}.json missing movement.${b}`).toBe('string');
      }
    }
  });

  it('names the file with the employee ID, the name and EmploymentHistory', () => {
    expect(movementExportFilename('E1042', 'Nur Aisyah binti Rahman')).toBe(
      'E1042_Nur_Aisyah_binti_Rahman_EmploymentHistory',
    );
    // employeeCode is nullable (draft / imported employments) — degrade, never print "undefined_".
    expect(movementExportFilename(null, 'Nur Aisyah')).toBe('Nur_Aisyah_EmploymentHistory');
    expect(movementExportFilename('', 'Nur Aisyah')).toBe('Nur_Aisyah_EmploymentHistory');
    // Runs of whitespace collapse to one underscore, and the name is not otherwise mangled here — the
    // route's RFC 5987 header is what makes a non-Latin-1 name safe to put in Content-Disposition.
    expect(movementExportFilename('E7', '  Lee   Wei  Ming ')).toBe('E7_Lee_Wei_Ming_EmploymentHistory');
    expect(movementExportFilename('E9', '陳大文')).toBe('E9_陳大文_EmploymentHistory');
  });
});

describe('e6a144d4 — the event-type caption, shared by the screen and the file', () => {
  it('lets the tenant catalogue name win over the shipped translation (476f23ed)', () => {
    expect(movementKindLabel('transfer', 'Redeployment', t)).toBe('Redeployment');
    expect(movementKindLabel('transfer', null, t)).toBe(t('movement.eventType.transfer'));
    expect(movementKindLabel('transfer', '', t)).toBe(t('movement.eventType.transfer'));
  });

  it('resolves every shipped kind through a static key in all six locales', () => {
    const kinds = [
      'hired', 'transfer', 'entityTransfer', 'promotion', 'demotion', 'increment', 'salaryAdjustment',
      'confirmation', 'probationExtension', 'secondment', 'actingPosition', 'resignation', 'termination',
      'blacklist', 'blacklistCleared', 'orgAssignmentChange', 'reportingLineChange', 'employmentTypeChange',
      'gradeChange', 'joinDateChange', 'groupJoinDateCorrection',
    ];
    for (const loc of LOCALES) {
      const tl = translator(loc);
      for (const k of kinds) {
        // translator() throws on a missing key, so this is the six-locale coverage the file needs.
        expect(movementKindLabel(k, null, tl).length, `${loc}.json ${k}`).toBeGreaterThan(0);
      }
    }
  });

  it('humanizes an unknown/future kind rather than printing a raw key', () => {
    expect(movementKindLabel('someFutureKind', null, t)).toBe('Some Future Kind');
  });
});

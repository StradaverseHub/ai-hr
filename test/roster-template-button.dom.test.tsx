/**
 * "Download Template" — THE FILE THE BUTTON ACTUALLY HANDS TO THE BROWSER (item 23390097).
 *
 * WHY THIS FILE EXISTS. The template's four identity headings must be the MACHINE header
 * (`Employee No | Employee Name | Department | Occupation`), because lib/csv.ts normalises a heading to
 * lower/trim/underscore and core/roster-import.ts accepts only employee_no | employee_number |
 * employee_code | staff_id. They were once built from `t('colEmployeeNo')` &c, which made the round trip
 * impossible in ms, zh, ta, th and vi: `No. Pekerja` normalises to `no._pekerja`, every row came back
 * rejected `missing_employee_no` against a visibly populated column, and Save stayed disabled.
 *
 * That was fixed by moving the header inside RosterTemplateButton, built from ROSTER_TEMPLATE_ID_COLUMNS
 * so no caller can hand it a translation again. AND NOTHING COVERED THE LINE THAT DOES IT. Every existing
 * roster test asserts `buildRosterTemplate`'s header or the analyzer's tolerance of it; the component's
 * own `const header = [...ROSTER_TEMPLATE_ID_COLUMNS, ...dates]` could be changed back to the translated
 * labels and all 29 of them stayed green — the exact regression the fix was for.
 *
 * So this clicks the real button, intercepts the Blob it puts on the anchor, decodes the workbook with
 * the same lib/spreadsheet reader the uploader uses, and reads the header out of the file. Not the props,
 * not the source: the bytes.
 *
 * Scope note, as in roster-month-grid.dom.test.tsx: jsdom applies no CSS and computes no layout, so this
 * covers what the button PRODUCES, not how it looks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ms from '../messages/ms.json';
import { workbookToCsvText } from '../lib/spreadsheet';
import { ROSTER_TEMPLATE_ID_COLUMNS, buildRosterTemplate, cellKey, monthDates } from '../lib/roster-month';

// components/roster-grid.tsx imports its server actions at module scope; in jsdom that would drag
// next/cache, next/navigation and the whole database layer in. The button under test never calls them.
vi.mock('../app/roster/actions', () => ({
  assignCellAction: async () => ({ ok: true as const }),
  bulkAssignAction: async () => ({ ok: true as const }),
  rowAssignAction: async () => ({ ok: true as const }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

import { RosterTemplateButton } from '../components/roster-grid';

const MONTH = '2026-08';
const DATES = monthDates(MONTH);

/** jsdom implements no object URLs at all, so the download path has nowhere to put its Blob. Stubbing
 *  createObjectURL is also how the file is captured — this IS the interception point. */
let captured: Blob | null = null;
beforeEach(() => {
  captured = null;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      captured = blob;
      return 'blob:roster-template';
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => {} });
});

/** The props app/roster/page.tsx and app/roster/import/page.tsx pass, built the way they build them.
 *  A leading-zero employee code is deliberate: the .xlsx round trip exists partly to stop Excel eating it. */
const template = buildRosterTemplate({
  dates: DATES,
  employees: [
    { employmentId: 'e1', name: 'Ahmad Zulkifli', code: '0012', department: 'Site Operations', occupation: 'DEPARTMENT HEAD' },
    { employmentId: 'e2', name: 'Nurul Ain', code: 'A0002', department: 'Finance', occupation: 'EXECUTIVE' },
  ],
  cells: { [cellKey('e1', '2026-08-24')]: { kind: 'shift', shiftId: 'sh-mb28' } },
  shiftCode: () => 'MB28',
});

function renderButton() {
  return render(
    <RosterTemplateButton
      dates={DATES}
      rows={template.rows}
      month={MONTH}
      codes={['MB28', 'WFO-HQ-FWH']}
      label="Download Template"
      notesTitle="How to fill this in"
      notes={['Blank leaves the day as it is', 'RD is a rest day']}
      failedLabel="Could not build the template"
    />,
  );
}

/** Click Download Template and return the workbook it produced, decoded as rows. */
async function download(): Promise<string[][]> {
  renderButton();
  screen.getByRole('button', { name: 'Download Template' }).click();
  await waitFor(() => expect(captured, 'the button must hand a Blob to the browser').not.toBeNull());
  const csv = await workbookToCsvText(await (captured as unknown as Blob).arrayBuffer());
  // CRLF, and cells the writer chose to quote. Nothing in this fixture contains a comma, so a split is
  // enough — but the line endings are not optional to handle: without \r? the last column of every row
  // carries a trailing carriage return and every equality assertion fails for the wrong reason.
  return csv
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => line.split(',').map((cell) => cell.replace(/^"([\S\s]*)"$/, '$1').replace(/""/g, '"')));
}

describe('RosterTemplateButton — the header it writes into the file (23390097)', () => {
  it('emits the MACHINE header, not any locale’s translation of it', async () => {
    const rows = await download();
    const header = rows[0];

    // THE ASSERTION THE BLOCKER ASKED FOR: read out of the decoded workbook, so the component's own
    // header line is what is under test — not the constant, and not buildRosterTemplate's copy of it.
    expect(header.slice(0, 4)).toEqual([...ROSTER_TEMPLATE_ID_COLUMNS]);

    // And explicitly NOT the labels that broke the round trip. ms is the measured case; the same holds
    // for zh, ta, th and vi, and all five are unreachable now that the caller cannot supply a header.
    expect(header).not.toContain(ms.roster.colEmployeeNo);
    expect(header).not.toContain(ms.roster.colEmployeeName);
    expect(header).not.toContain(ms.roster.colDepartment);
    expect(header).not.toContain(ms.roster.colOccupation);

    // …and what the analyzer keys on survives normalisation (lower / trim / underscore).
    expect(header[0].toLowerCase().trim().replace(/\s+/g, '_')).toBe('employee_no');
  });

  it('the date columns follow the four identity columns, one per day of the month', async () => {
    const header = (await download())[0];
    expect(header).toHaveLength(4 + DATES.length);
    expect(header.slice(4)).toEqual(DATES);
    expect(header[4]).toBe('2026-08-01');
    expect(header[header.length - 1]).toBe('2026-08-31');
  });

  it('writes the rostered cells and keeps a leading-zero employee number as TEXT', async () => {
    const rows = await download();
    const header = rows[0];
    const ahmad = rows.find((r) => r[1] === 'Ahmad Zulkifli');
    expect(ahmad, 'the employee rows are in the file').toBeDefined();

    // The whole reason this is an .xlsx with text-formatted columns and not a CSV: Excel must not turn
    // `0012` into the number 12 the moment HR opens it.
    expect(ahmad![0]).toBe('0012');
    expect(ahmad![header.indexOf('2026-08-24')]).toBe('MB28');
    // A date nobody rostered stays EMPTY — the grey ghost must never be hardened into a stored assignment
    // by a round trip through this file.
    expect(ahmad![header.indexOf('2026-08-25')]).toBe('');
  });
});

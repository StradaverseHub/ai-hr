/**
 * r301 (board e5018593) — step ④ of Generate Entitlement, RENDERED, with an earned Annual Leave half.
 *
 * The node file (test/r301-generate-earned-accrual.test.ts) pins what the engines return. This file pins what
 * the operator READS from it, which no server test can see: the two summary tables the mockup draws ("Entitlement
 * to grant" / "Earned Annual Leave to add"), a reached earned line leaving the issues table, the future-year
 * and failure sentences, the failure's link to Run Earned Accrual, and no raw key path anywhere. The preview is
 * a stub returning a fixed result — the component must render the server's figures and restate nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { GenerateForm } from '../components/leave/generate-form';
import type { LeaveGenerationAccrual, LeaveGenerationLine, LeaveGenerationResult } from '../core/leave-generation';

const L = messages.admin.leave;

const line = (over: Partial<LeaveGenerationLine>): LeaveGenerationLine => ({
  employmentId: 'e0',
  employeeName: 'Employee 0',
  leaveTypeId: 'lt-annual',
  leaveTypeName: '*Annual Leave',
  outcome: 'earned_method',
  days: 0,
  carry: 0,
  forfeit: 0,
  belowStatutoryFloor: false,
  earnedMethodNotAnnualLeave: false,
  earnedAccrual: null,
  ...over,
});

const accrualRan: LeaveGenerationAccrual = {
  annualLeaveLines: 2,
  notAnnualLeaveLines: 0,
  skippedFutureYear: false,
  heldBackNextYearStarted: 0,
  forfeits: 0,
  asOf: '2026-09-17',
  posted: 1,
  upToDate: 1,
  days: 8.5,
  byLeaveType: [{ leaveTypeId: 'lt-annual', leaveTypeName: '*Annual Leave', posted: 1, upToDate: 1, days: 8.5 }],
  error: null,
};

const base: LeaveGenerationResult = {
  year: 2026,
  employeesSelected: 3,
  employeesReached: 3,
  employeesPassed: 2,
  employeesFailed: 1,
  granted: 2,
  skipped: 0,
  forfeits: 0,
  lines: [
    line({ employmentId: 'e1', employeeName: 'Aina', leaveTypeId: 'lt-mc', leaveTypeName: 'Medical Leave', outcome: 'granted', days: 14 }),
    line({ employmentId: 'e2', employeeName: 'Chen', leaveTypeId: 'lt-mc', leaveTypeName: 'Medical Leave', outcome: 'granted', days: 14 }),
    line({ employmentId: 'e1', employeeName: 'Aina', earnedAccrual: 'topped_up' }),
    line({ employmentId: 'e2', employeeName: 'Chen', earnedAccrual: 'up_to_date' }),
    line({ employmentId: 'e3', employeeName: 'Dev' }), // NOT reached
  ],
  decidedBy: [],
  accrual: accrualRan,
};

let current: LeaveGenerationResult = base;
const preview = vi.fn(async () => current);

async function openValidation() {
  const user = userEvent.setup();
  const utils = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <GenerateForm
        action={() => {}}
        previewAction={preview}
        years={[2025, 2026, 2027]}
        defaultYear={2026}
        leaveTypes={[{ value: 'lt-annual', label: '*Annual Leave' }]}
        criteriaSections={[]}
        employees={[]}
      />
    </NextIntlClientProvider>,
  );
  await waitFor(() => expect(preview).toHaveBeenCalled());
  await user.click(screen.getByRole('button', { name: 'Validation & Preview' }));
  return utils;
}

const cells = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent));

beforeEach(() => {
  window.localStorage.clear();
  preview.mockClear();
  current = base;
});

describe('r301 · step ④ shows both parts of the run', () => {
  it('"Entitlement to grant" and "Earned Annual Leave to add" render the server’s figures', async () => {
    const { container } = await openValidation();
    const grant = await screen.findByRole('table', { name: L.generateGrantTitle });
    expect(cells(grant)).toEqual([['Medical Leave', '2', '28']]);
    const earned = screen.getByRole('table', { name: L.generateAccrualTitle });
    expect(cells(earned)).toEqual([['*Annual Leave', '1', '1', '8.5']]);
    expect(container.textContent).toContain(L.generateAccrualAsAt.replace('{date}', '2026-09-17'));
    expect(container.textContent).not.toContain('admin.leave');
    expect(container.textContent).not.toMatch(/generate[A-Z][A-Za-z_]+/);
  });

  it('a REACHED earned line leaves the issues table; an unreached one stays, with its own label', async () => {
    await openValidation();
    const issues = await screen.findByRole('table', { name: L.generateIssuesAria });
    const rows = cells(issues);
    expect(rows).toEqual([['Dev', '*Annual Leave', L.generateOutcome_earned_method]]);
    // The Failed tile is the SERVER's count, not a recount of the table.
    const tiles = document.querySelector('form > section:nth-of-type(4) dl')!;
    expect(tiles.textContent).toContain('Failed1');
  });

  it('a FUTURE year says the days come as the year goes by, and draws no earned table', async () => {
    current = {
      ...base,
      year: 2027,
      lines: base.lines.map((l) => ({ ...l, earnedAccrual: null })),
      accrual: { ...accrualRan, skippedFutureYear: true, asOf: null, posted: 0, upToDate: 0, days: 0, byLeaveType: [] },
    };
    const { container } = await openValidation();
    await screen.findByRole('table', { name: L.generateGrantTitle });
    expect(screen.queryByRole('table', { name: L.generateAccrualTitle })).toBeNull();
    expect(container.textContent).toContain(L.generateAccrualFuture.replace('{year}', '2027'));
  });

  it('a FAILED accrual preview names the reason and links to Run Earned Accrual', async () => {
    current = {
      ...base,
      lines: base.lines.map((l) => ({ ...l, earnedAccrual: null })),
      accrual: { ...accrualRan, posted: 0, upToDate: 0, days: 0, byLeaveType: [], error: 'simulated outage' },
    };
    const { container } = await openValidation();
    await screen.findByRole('table', { name: L.generateGrantTitle });
    expect(container.textContent).toContain('simulated outage');
    const link = screen.getByRole('link', { name: messages.nav.leaveEarnedAccrual });
    expect(link.getAttribute('href')).toBe('/admin/leave-config/earned-accrual');
    expect(container.textContent).not.toContain('<link>');
  });

  it('stranded earned lines are counted in a sentence; no earned half at all when the engine logged none', async () => {
    current = { ...base, accrual: { ...accrualRan, notAnnualLeaveLines: 2 } };
    const first = await openValidation();
    expect(first.container.textContent).toContain(L.generateAccrualNotAnnualLeave.replace('{count}', '2'));
    first.unmount();

    current = { ...base, lines: base.lines.slice(0, 2), accrual: null };
    const second = await openValidation();
    await screen.findByRole('table', { name: L.generateGrantTitle });
    expect(second.container.textContent).not.toContain(L.generateAccrualTitle);
  });
});

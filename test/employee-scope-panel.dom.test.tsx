/**
 * r168a — the shared employee panel, PROVED BY RENDERING.
 *
 * WHY THIS EXISTS ALONGSIDE test/employee-scope-panel-guard.test.ts. That file proves the SERVER still
 * refuses what it always refused. It cannot prove the reporter's actual complaint, which is about what a
 * person sees and can do: "Zakat picks an employee from a plain dropdown, while Individual Transaction
 * gives you a searchable list with Company, Department and Status filters." Only a render can answer that,
 * and a source grep positively cannot — `<EmployeeScopePanel …>` appearing in four files says nothing about
 * whether all four got the same control, and the whole point of the refactor is that they did.
 *
 * SO THE FIXED-TRANSACTION ADAPTER IS RENDERED BESIDE THE PANEL AND COMPARED SURFACE-FOR-SURFACE. Fixed
 * Transaction is the screen whose 192-line near-copy was retired into the shared component, so it is the
 * one that could silently have LOST something. Comparing the two renders is the assertion that it did not.
 *
 * IT ALSO STANDS IN FOR PART OF THE i18n CHECK, though not all of it. NextIntlClientProvider is given the
 * REAL en.json here, so a key this component asks for and the catalog does not have throws rather than
 * painting MISSING_MESSAGE — which is exactly the failure mode that passes tsc, the suite and next build.
 * That covers en only; the other five locales are covered structurally by test/i18n-coverage.test.ts
 * (check A), and neither replaces reading a dev-server log.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic, not a visual regression.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';
import { EmployeeScopePanel, type ScopeEmployee } from '../components/collapsible-employee-panel';
import { EmployeePicker } from '../app/payroll/transactions/fixed/employee-picker';

// The address bar, stubbed. push() is RECORDED rather than performed: the URL this panel asks for is its
// entire contract with the server — selection lives in the query string precisely so the server's scope
// guard, not this component, decides what it means.
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const emp = (over: Partial<ScopeEmployee> & { employmentId: string; name: string }): ScopeEmployee => ({
  employeeCode: null,
  company: 'Acme Sdn Bhd',
  companyId: 'co-a',
  department: 'Finance',
  departmentId: 'dept-fin',
  businessUnit: 'HQ',
  businessUnitId: 'bu-hq',
  status: 'active',
  ...over,
});

const PEOPLE: ScopeEmployee[] = [
  emp({ employmentId: 'e1', name: 'Aisha Rahman', employeeCode: 'EMP-001' }),
  emp({ employmentId: 'e2', name: 'Bala Krishnan', employeeCode: 'EMP-002', department: 'Operations', departmentId: 'dept-ops' }),
  emp({ employmentId: 'e3', name: 'Chen Wei', employeeCode: 'EMP-003', company: 'Beta Sdn Bhd', companyId: 'co-b', businessUnit: 'Plant', businessUnitId: 'bu-plant' }),
  emp({ employmentId: 'e4', name: 'Devi Nair', employeeCode: 'EMP-004', status: 'ended' }),
];

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

/** Every employee row a reader can actually click, in order. */
const rowsOf = (container: HTMLElement) =>
  [...container.querySelectorAll('button[type="button"]')]
    .map((b) => b.textContent?.trim() ?? '')
    .filter((txt) => PEOPLE.some((p) => txt.includes(p.name)));

/** The panel's whole control surface as "label → options", so two renders compare in ONE assertion rather
 *  than one per field — a per-field list is a list somebody forgets to extend. */
const surfaceOf = (container: HTMLElement) =>
  [...container.querySelectorAll('label')].map((l) => {
    const caption = l.querySelector('span')?.textContent ?? '';
    const select = l.querySelector('select');
    if (select) {
      const opts = [...select.querySelectorAll('option')].map((o) => `${o.getAttribute('value')}=${o.textContent}`);
      return `${caption}: [${opts.join(' | ')}]`;
    }
    const input = l.querySelector('input');
    if (input) return `${caption}: <input ${input.getAttribute('type') ?? 'text'} ph="${input.getAttribute('placeholder') ?? ''}">`;
    return caption;
  });

/** Which `<details>` a control is folded inside, or null when it is always on show. `<label>` is the
 *  handle because `surfaceOf` above already identifies every control by its label. */
const foldOf = (container: HTMLElement, caption: string) => {
  const label = [...container.querySelectorAll('label')].find(
    (l) => l.querySelector('span')?.textContent === caption,
  );
  if (!label) throw new Error(`no control labelled "${caption}"`);
  return label.closest('details');
};

describe('r168a — the panel every screen now shares', () => {
  it('offers Company, Business Unit, Department and Status filters plus a search, not a plain dropdown', () => {
    const { container } = wrap(<EmployeeScopePanel employees={PEOPLE} selectedId={null} basePath="/x" />);
    // The reporter's complaint (r168a), restated as an assertion: all five controls are still here.
    // 009c8a37 INVERTED THE ORDER — this list used to read Company, Business unit, Department, Status,
    // Search employee, i.e. the one box used on every visit was the last one reached and the first name
    // sat five controls down. Search is now FIRST and the four narrowers follow it, folded away. The
    // CASE IS KEPT, not deleted: what r168a proved (that Zakat's plain dropdown became this control set)
    // is still true and still worth pinning; only the order it asserts has been reversed.
    expect(surfaceOf(container)).toEqual([
      'Search employee: <input search ph="Employee ID or name">',
      'Company: [=All companies | co-a=Acme Sdn Bhd | co-b=Beta Sdn Bhd]',
      'Business unit: [=All business units | bu-hq=HQ | bu-plant=Plant]',
      'Department: [=All departments | dept-fin=Finance | dept-ops=Operations]',
      'Status: [=All statuses | active=Active | ended=Ended]',
    ]);
    expect(rowsOf(container)).toHaveLength(4);
  });

  it('009c8a37 — the four narrowers are folded behind a CLOSED More filters; the search never hides', () => {
    const { container } = wrap(<EmployeeScopePanel employees={PEOPLE} selectedId={null} basePath="/x" />);

    const fold = container.querySelector('details');
    expect(fold, 'the four employee filters must sit behind a fold').not.toBeNull();
    // "Closed when you arrive" — the reporter asked for closed EVERY visit, so this is state and not a
    // cookie, and a fresh render is therefore always closed.
    expect(fold!.open).toBe(false);
    expect(within(fold!).getByText('More filters')).toBeInTheDocument();

    // The search box is the one control that must never be behind the fold: it is what the whole reorder
    // exists to put first.
    expect(foldOf(container, 'Search employee')).toBeNull();
    for (const caption of ['Company', 'Business unit', 'Department', 'Status']) {
      expect(foldOf(container, caption), `${caption} belongs inside More filters`).toBe(fold);
    }

    // Nothing is narrowing yet, so the summary carries no count.
    expect(within(fold!).queryByText(/\bon$/)).toBeNull();

    // The employee list is rendered BEFORE the fold — the names are the second thing on the panel, which
    // is the request. Reading DOM order is the only way to assert that; jsdom computes no layout.
    const firstRow = [...container.querySelectorAll('button[type="button"]')].find((b) =>
      b.textContent?.includes('Aisha Rahman'),
    )!;
    expect(firstRow.compareDocumentPosition(fold!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('009c8a37 — a filter chosen while the fold is CLOSED still narrows, and the summary says how many', async () => {
    const user = userEvent.setup();
    const { container } = wrap(<EmployeeScopePanel employees={PEOPLE} selectedId={null} basePath="/x" />);
    const fold = container.querySelector('details')!;
    expect(fold.open).toBe(false);

    // A hidden filter that silently narrowed the list would leave a short list looking like a bug. The
    // count on the summary is the answer, so it has to be driven by the same state the list is.
    await user.selectOptions(screen.getByDisplayValue('All companies'), 'co-a');
    expect(rowsOf(container)).toHaveLength(3);
    expect(within(fold).getByText('1 on')).toBeInTheDocument();

    await user.selectOptions(screen.getByDisplayValue('All statuses'), 'ended');
    expect(rowsOf(container)).toEqual([expect.stringContaining('Devi Nair')]);
    expect(within(fold).getByText('2 on')).toBeInTheDocument();

    // The search box is NOT counted — it never hides, so counting it would report a narrowing already
    // in plain sight.
    await user.type(screen.getByPlaceholderText('Employee ID or name'), 'Devi');
    expect(within(fold).getByText('2 on')).toBeInTheDocument();
  });

  it('009c8a37 — Reset clears the hidden four and the search box in one click', async () => {
    const user = userEvent.setup();
    const { container } = wrap(<EmployeeScopePanel employees={PEOPLE} selectedId={null} basePath="/x" />);
    const fold = container.querySelector('details')!;

    await user.selectOptions(screen.getByDisplayValue('All companies'), 'co-a');
    await user.selectOptions(screen.getByDisplayValue('All statuses'), 'ended');
    await user.type(screen.getByPlaceholderText('Employee ID or name'), 'Devi');
    expect(rowsOf(container)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(rowsOf(container)).toHaveLength(4);
    expect(within(fold).queryByText('1 on')).toBeNull();
    expect(within(fold).queryByText('2 on')).toBeNull();
    expect((screen.getByPlaceholderText('Employee ID or name') as HTMLInputElement).value).toBe('');
  });

  it('searches by employee ID and by name', async () => {
    const user = userEvent.setup();
    const { container } = wrap(<EmployeeScopePanel employees={PEOPLE} selectedId={null} basePath="/x" />);
    const search = screen.getByPlaceholderText('Employee ID or name');

    await user.type(search, 'EMP-003');
    expect(rowsOf(container)).toEqual([expect.stringContaining('Chen Wei')]);

    await user.clear(search);
    await user.type(search, 'bala');
    expect(rowsOf(container)).toEqual([expect.stringContaining('Bala Krishnan')]);
  });

  it('filters by company, and narrows the Business Unit options to that company', async () => {
    const user = userEvent.setup();
    const { container } = wrap(<EmployeeScopePanel employees={PEOPLE} selectedId={null} basePath="/x" />);
    await user.selectOptions(screen.getByDisplayValue('All companies'), 'co-b');
    expect(rowsOf(container)).toEqual([expect.stringContaining('Chen Wei')]);
    // The BU list must follow the company, or a reader can pick a combination that matches nobody.
    const bu = screen.getByDisplayValue('All business units');
    expect([...within(bu).getAllByRole('option')].map((o) => o.textContent)).toEqual([
      'All business units',
      'Plant',
    ]);
  });

  it('filters by employment status', async () => {
    const user = userEvent.setup();
    const { container } = wrap(<EmployeeScopePanel employees={PEOPLE} selectedId={null} basePath="/x" />);
    await user.selectOptions(screen.getByDisplayValue('All statuses'), 'ended');
    expect(rowsOf(container)).toEqual([expect.stringContaining('Devi Nair')]);
  });

  it('puts the selection in the URL and carries the screen’s own filters with it', async () => {
    const user = userEvent.setup();
    push.mockClear();
    wrap(
      <EmployeeScopePanel
        employees={PEOPLE}
        selectedId={null}
        basePath="/payroll/individual-payslip"
        preserve={{ companyId: 'co-a', year: '2026', month: '07' }}
      />,
    );
    await user.click(screen.getByText('Aisha Rahman'));

    expect(push).toHaveBeenCalledTimes(1);
    const url = new URL(push.mock.calls[0][0], 'https://example.test');
    expect(url.pathname).toBe('/payroll/individual-payslip');
    // The employee is in the QUERY STRING. That is the point: the server re-decides it on every request.
    expect(url.searchParams.get('employmentId')).toBe('e1');
    // The period the reader had chosen survives the switch...
    expect(url.searchParams.get('companyId')).toBe('co-a');
    expect(url.searchParams.get('year')).toBe('2026');
    expect(url.searchParams.get('month')).toBe('07');
  });

  it('does NOT invent params the caller did not list — a stale payslipId cannot ride along', async () => {
    const user = userEvent.setup();
    push.mockClear();
    wrap(
      <EmployeeScopePanel
        employees={PEOPLE}
        selectedId="e2"
        basePath="/payroll/individual-payslip"
        preserve={{ year: '2026' }}
      />,
    );
    await user.click(screen.getByText('Chen Wei'));
    const url = new URL(push.mock.calls[0][0], 'https://example.test');
    // A payslipId names a run belonging to the employee being navigated AWAY from. The caller omits it, so
    // the panel must not resurrect it from anywhere.
    expect(url.searchParams.get('payslipId')).toBeNull();
    expect([...url.searchParams.keys()].sort()).toEqual(['employmentId', 'year']);
  });

  it('marks the current employee so a reader can see who they are looking at', () => {
    const { container } = wrap(<EmployeeScopePanel employees={PEOPLE} selectedId="e2" basePath="/x" />);
    const selected = [...container.querySelectorAll('button[aria-current="true"]')];
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain('Bala Krishnan');
    expect(selected[0].textContent).toContain('Selected');
  });

  it('says so when nothing matches, rather than showing an empty box', async () => {
    const user = userEvent.setup();
    wrap(<EmployeeScopePanel employees={PEOPLE} selectedId={null} basePath="/x" />);
    await user.type(screen.getByPlaceholderText('Employee ID or name'), 'nobody-by-that-name');
    expect(screen.getByText('No employees match your filters.')).toBeInTheDocument();
  });
});

describe('r168a — retiring the Fixed Transaction near-copy changed nothing a reader can see', () => {
  it('the Fixed adapter renders the SAME control surface and the SAME rows as the shared panel', () => {
    // The 192-line copy is gone. This is the assertion that it was a copy — if the shared panel had
    // dropped a filter, or renamed one, this comparison is what notices.
    const direct = wrap(<EmployeeScopePanel employees={PEOPLE} selectedId="e1" basePath="/payroll/transactions/fixed" />);
    const asShared = surfaceOf(direct.container);
    const sharedRows = rowsOf(direct.container);
    direct.unmount();

    const fixed = wrap(<EmployeePicker employees={PEOPLE} selectedId="e1" />);
    expect(surfaceOf(fixed.container)).toEqual(asShared);
    expect(rowsOf(fixed.container)).toEqual(sharedRows);
  });

  it('the Fixed adapter still navigates to its own route', async () => {
    const user = userEvent.setup();
    push.mockClear();
    wrap(<EmployeePicker employees={PEOPLE} selectedId={null} />);
    await user.click(screen.getByText('Devi Nair'));
    const url = new URL(push.mock.calls[0][0], 'https://example.test');
    expect(url.pathname).toBe('/payroll/transactions/fixed');
    expect(url.searchParams.get('employmentId')).toBe('e4');
  });
});

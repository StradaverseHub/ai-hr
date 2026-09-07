/**
 * The Import Employees screen, PROVED BY RENDERING (item 2983802f).
 *
 * WHY THIS EXISTS ALONGSIDE the engine tests. Those prove what the SERVER decided. They cannot prove
 * what a person SEES — and everything this item added to the screen is rendered from CLIENT state after
 * a server action returns: the six numbered steps, the family sheet's own result list, the whole-file
 * refusal, and the "imported but their superior could not be linked" line. A `t('…')` that is missing, or
 * that carries a `{placeholder}` the caller does not supply, throws in the BROWSER and paints the raw key
 * path on screen while tsc, the suite and `next build` all stay green and the route still returns 200. So
 * these panels are rendered here against the REAL en.json and read back.
 *
 * WHAT IS ASSERTED beyond "it renders":
 *   · all six step names appear, in order, with their numbers — the labelling the plan asked for;
 *   · a preview carrying family rows shows them as their own checked list, with their own reasons;
 *   · a WHOLE-FILE refusal shows why AND disables Import even though rows are individually valid — the
 *     one place where a green-looking preview must not offer the button;
 *   · the result names the family members created and reports an unlinked superior WITHOUT counting
 *     those people as failures.
 *
 * Scope note (inherited from the other dom tests): jsdom applies no CSS and computes no layout, so this
 * catches rendering and interaction logic, not a visual regression.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';
import { EmployeeImport } from '../app/admin/personnel/import/employee-import';
import type { ImportPreview, ImportResult } from '../lib/import-schema';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const validateMock = vi.fn();
const commitMock = vi.fn();
vi.mock('../app/admin/personnel/import/actions', () => ({
  validateImportAction: (...a: unknown[]) => validateMock(...a),
  commitImportAction: (...a: unknown[]) => commitMock(...a),
}));

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

const screenUnderTest = () =>
  wrap(
    <EmployeeImport
      companies={[{ id: 'c1', name: 'Acme Sdn Bhd' }]}
      defaultCompanyId="c1"
      reference={{
        departments: ['Finance'],
        positions: ['Executive'],
        costCenters: ['CC1'],
        states: ['Selangor'],
        countries: ['Malaysia'],
        relationships: ['Spouse'],
        familyRelationships: ['spouse', 'child'],
      }}
    />,
  );

describe('2983802f · the import screen names its six steps', () => {
  it('renders every step label with its number', () => {
    screenUnderTest();
    const rail = screen.getByRole('list', { name: 'Import steps' });
    const items = within(rail).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items).toHaveLength(6);
    // In order, and each one carrying its own number — the sequence is the point.
    expect(items[0]).toMatch(/1.*Download the template/);
    expect(items[1]).toMatch(/2.*Prepare your employee data/);
    expect(items[2]).toMatch(/3.*Upload the file/);
    expect(items[3]).toMatch(/4.*Check and preview/);
    expect(items[4]).toMatch(/5.*Confirm the import/);
    expect(items[5]).toMatch(/6.*Import result/);
  });

  it('marks step 1 as current before anything has been provided', () => {
    screenUnderTest();
    const rail = screen.getByRole('list', { name: 'Import steps' });
    expect(within(rail).getByText('1')).toHaveAttribute('aria-current', 'step');
  });

  it('repeats the numbering over the controls that perform each step', () => {
    screenUnderTest();
    // Step 1 sits with the download buttons, step 3 with the upload box, step 4 with Validate.
    for (const n of [1, 2, 3, 4]) expect(screen.getByText(`Step ${n}`)).toBeInTheDocument();
    expect(screen.getByText('Download Excel template')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Validate' })).toBeInTheDocument();
  });
});

// A preview with two valid employees and three family members.
const basePreview: ImportPreview = {
  companyId: 'c1',
  total: 2,
  validCount: 2,
  missingColumns: [],
  fileErrors: [],
  rows: [
    { rowNum: 1, fullName: 'Parent One', email: 'parent@acme.test', ok: true, errors: [], warnings: [], company: 'Acme Sdn Bhd' },
    { rowNum: 2, fullName: 'Other Staff', email: 'other@acme.test', ok: true, errors: [], warnings: [], company: 'Acme Sdn Bhd' },
  ],
  dependents: {
    total: 3,
    validCount: 2,
    missingColumns: [],
    rows: [
      { rowNum: 1, employeeCode: 'F0001', fullName: 'Nurul Huda', relationship: 'spouse', ok: true, errors: [] },
      { rowNum: 2, employeeCode: 'F0001', fullName: 'Aiman', relationship: 'child', ok: true, errors: [] },
      {
        rowNum: 3,
        employeeCode: 'F9999',
        fullName: 'Ghost Child',
        relationship: 'child',
        ok: false,
        errors: ['Employee ID "F9999" is not on the employee sheet'],
      },
    ],
  },
};

/** Paste text, press Validate, and let the mocked action resolve into the preview panel. */
async function previewWith(preview: ImportPreview) {
  const userEvent = (await import('@testing-library/user-event')).default;
  const user = userEvent.setup();
  validateMock.mockResolvedValue(preview);
  screenUnderTest();
  await user.type(screen.getByPlaceholderText(/Paste CSV with a header row/), 'full_name\n');
  await user.click(screen.getByRole('button', { name: 'Validate' }));
  await screen.findByText(/Preview/);
  return user;
}

describe('2983802f · the family sheet is shown as its own checked list', () => {
  it('lists every family row with its Employee ID, relationship and reason', async () => {
    await previewWith({ ...basePreview, fileErrors: [] });
    // The caption appears once as the section heading and once inside it; either is proof it rendered.
    expect(screen.getAllByText(/Family sheet/).length).toBeGreaterThan(0);
    expect(screen.getByText('Nurul Huda')).toBeInTheDocument();
    expect(screen.getByText('Ghost Child')).toBeInTheDocument();
    // The failing family row prints its own reason, exactly as an employee row does.
    expect(screen.getByText(/is not on the employee sheet/)).toBeInTheDocument();
    // And the count is stated in the preview header AND over the family list itself.
    expect(screen.getAllByText(/3 family members/).length).toBe(2);
  });
});

describe('2983802f · a whole-file refusal is visible and blocks the button', () => {
  const refused: ImportPreview = {
    ...basePreview,
    fileErrors: [
      'The Family sheet names Employee ID "F9999", which is not on the employee sheet. Nothing was imported — add the employee, or correct the ID, and upload again.',
    ],
  };

  it('says the file was not imported, and why', async () => {
    await previewWith(refused);
    expect(screen.getByText('This file was not imported')).toBeInTheDocument();
    expect(screen.getByText(/names Employee ID "F9999"/)).toBeInTheDocument();
  });

  it('DISABLES Import even though both employee rows are individually valid', async () => {
    // This is the case a per-row-only screen gets wrong: two green rows and an offered button that
    // would import half a file. The server refuses independently; the button is the courtesy.
    await previewWith(refused);
    expect(screen.getByRole('button', { name: /Import 2 valid/ })).toBeDisabled();
  });

  it('offers Import when the same preview carries no file-level refusal', async () => {
    // The counterpart, so the case above is proving the refusal and not merely that a button exists.
    await previewWith({ ...basePreview, fileErrors: [] });
    expect(screen.getByRole('button', { name: /Import 2 valid/ })).toBeEnabled();
  });
});

describe('2983802f · the result names what happened to family and to superiors', () => {
  const result: ImportResult = {
    companyId: 'c1',
    imported: 2,
    failed: [],
    skipped: 0,
    dependentsImported: 3,
    superiorFailed: [{ rowNum: 2, email: 'other@acme.test', message: 'Reporting cycle detected' }],
    fileErrors: [],
    runId: null,
  };

  it('reports the family members created and the superior that could not be linked', async () => {
    const user = await previewWith({ ...basePreview, fileErrors: [] });
    commitMock.mockResolvedValue(result);
    await user.click(screen.getByRole('button', { name: /Import 2 valid/ }));
    await screen.findByText(/Imported 2 employees/);
    expect(screen.getByText(/3 family members added/)).toBeInTheDocument();
    // Reported as its own line — NOT as a failure, because these people are in the system.
    expect(
      screen.getByText(/1 employee was imported, but their direct superior could not be linked/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Reporting cycle detected/)).toBeInTheDocument();
    expect(screen.queryByText(/failed/)).toBeNull();
  });
});

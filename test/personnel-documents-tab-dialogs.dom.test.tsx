/**
 * 0386b95d — the Documents tab, PROVED BY RENDERING.
 *
 * The report is entirely about what the screen looks like: "the Add Document function is presented as a
 * dropdown". It was a <details>/<summary> fold-out — the only disclosure on the whole 4148-line personnel
 * page — with Edit and Replace as inline panels that pushed the grid down. A source grep can say the
 * element is gone; it cannot say a dialog took its place and still carries the same form, which is the
 * thing the reporter will check.
 *
 * IT IS ALSO THE RENDER CHECK THIS TAB COULD OTHERWISE ONLY GET FROM A DEV SERVER, for the client half
 * (documents-manager.tsx is the whole tab below the card header). NextIntlClientProvider is given the REAL
 * en.json and the assertions are on RENDERED TEXT, not on the presence of a t() call — so a key this
 * component asks for and the catalog does not hold fails here instead of painting MISSING_MESSAGE at an
 * admin, the failure mode that passes tsc, the suite and `next build` and still returns 200. The other
 * five locales are covered structurally by test/i18n-coverage.test.ts check A.
 *
 * THE DATALIST TEST IS THE ONE THAT EARNS ITS PLACE. Moving Add into a lazily-mounted dialog quietly
 * breaks `<input list="employee-doc-categories">` on every OTHER form on the tab, because a <datalist>
 * only resolves while it is mounted and the old one lived inside the Add form. Nothing about that failure
 * is visible in tsc, the suite or a 200 — the Category box simply stops suggesting.
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
import { DocumentsManager, type DocumentVM } from '../app/admin/personnel/[employmentId]/documents-manager';

// The server actions, stubbed. They are a 'use server' module that reaches Postgres (and the document
// store) on import; this file is about the screen in front of them, and their own behaviour — upload,
// mime sniffing, replace, delete, RLS and the audit trail — is proved against a real database in
// test/employee-documents.test.ts.
vi.mock('../app/admin/personnel/[employmentId]/actions', () => ({
  uploadEmployeeDocumentAction: vi.fn(),
  updateEmployeeDocumentMetaAction: vi.fn(),
  replaceEmployeeDocumentAction: vi.fn(),
  deleteEmployeeDocumentAction: vi.fn(),
}));

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

const doc = (over: Partial<DocumentVM> & { id: string }): DocumentVM => ({
  title: 'Signed contract',
  category: 'Contract',
  description: 'FY26 employment agreement',
  fileName: 'contract.pdf',
  mimeType: 'application/pdf',
  typeLabel: 'PDF',
  sizeLabel: '41 B',
  uploadedBy: 'Amy Tan',
  uploadedAt: '2026-01-15 09:32',
  updatedBy: null,
  updatedAt: '2026-01-15 09:32',
  inlineViewable: true,
  ...over,
});

const DOCS: DocumentVM[] = [
  doc({ id: 'd1' }),
  doc({ id: 'd2', title: 'Passport copy', category: 'Identity', fileName: 'passport.png', typeLabel: 'PNG', inlineViewable: true }),
];

const mount = (docs: DocumentVM[] = DOCS) =>
  wrap(
    <DocumentsManager
      employmentId="emp-1"
      docs={docs}
      categories={['Contract', 'Identity']}
      types={['PDF', 'PNG']}
    />,
  );

describe('0386b95d — Documents tab wears the Qualification shape', () => {
  it('offers Add Document as a button and no longer as a disclosure', async () => {
    const { container } = mount();
    // The reported control, gone: no <details>, no <summary>, anywhere on the tab.
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('summary')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add document' })).toBeInTheDocument();
  });

  it('the Add button opens the upload form in a dialog, carrying the file input and the tab tracker', async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add document' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Add document')).toBeInTheDocument();
    // The upload path is untouched: the file input, its accept list and the supported-types hint are the
    // ones that were in the fold-out.
    const file = dialog.querySelector('input[type="file"][name="file"]') as HTMLInputElement | null;
    expect(file).not.toBeNull();
    expect(file!.required).toBe(true);
    expect(file!.getAttribute('accept')).toContain('.pdf');
    expect(within(dialog).getByRole('button', { name: 'Upload' })).toBeInTheDocument();
    // Dialog.Portal reparents the form out of the PersonnelTabs shell, so the shell cannot inject the
    // tab and the save would land on Profile without this static input.
    const tab = dialog.querySelector('input[name="tab"]') as HTMLInputElement | null;
    expect(tab?.value).toBe('documents');
  });

  it('Edit is the same pop-up, prefilled, and never offers to swap the attachment', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Edit document')).toBeInTheDocument();
    expect((dialog.querySelector('input[name="title"]') as HTMLInputElement).value).toBe('Signed contract');
    expect((dialog.querySelector('input[name="category"]') as HTMLInputElement).value).toBe('Contract');
    expect((dialog.querySelector('input[name="documentId"]') as HTMLInputElement).value).toBe('d1');
    // Changing the FILE is the separately-audited Replace action, not a metadata edit.
    expect(dialog.querySelector('input[type="file"]')).toBeNull();
  });

  it('Replace is its own pop-up on the row, keeping the same accept list', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getAllByRole('button', { name: 'Replace' })[0]);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Replace attachment')).toBeInTheDocument();
    const file = dialog.querySelector('input[type="file"][name="file"]') as HTMLInputElement;
    expect(file.required).toBe(true);
    expect(file.getAttribute('accept')).toContain('.pdf');
  });

  it('the Category suggestions survive with every dialog CLOSED', () => {
    // The <datalist> used to live inside the Add form. A dialog mounts its body lazily, so leaving it
    // there would have left `list="employee-doc-categories"` dangling on the Edit form — and on the Add
    // form itself for anyone who reached it before opening Add. It now sits outside every dialog.
    const { container } = mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    const list = container.querySelector('#employee-doc-categories');
    expect(list).not.toBeNull();
    expect(list!.querySelectorAll('option')).toHaveLength(2);
  });

  it('View and Download stay links to the streaming route (the download path is not touched)', () => {
    mount();
    const view = screen.getAllByRole('link', { name: 'View' })[0] as HTMLAnchorElement;
    const download = screen.getAllByRole('link', { name: 'Download' })[0] as HTMLAnchorElement;
    expect(view.getAttribute('href')).toBe('/admin/personnel/emp-1/document/d1?inline=1');
    expect(download.getAttribute('href')).toBe('/admin/personnel/emp-1/document/d1');
  });

  it('Delete is confirmation-gated and still posts the document it belongs to', async () => {
    const user = userEvent.setup();
    const { container } = mount();
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    const form = deleteButtons[0].closest('form') as HTMLFormElement;
    expect((form.querySelector('input[name="documentId"]') as HTMLInputElement).value).toBe('d1');
    expect((form.querySelector('input[name="tab"]') as HTMLInputElement).value).toBe('documents');

    await user.click(deleteButtons[0]);
    // A real refusal step, not window.confirm: the confirmation is the shared AlertDialog.
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Delete this document');
    expect(container.querySelector('details')).toBeNull();
  });

  it('shows the empty state instead of a table when the employee has no documents', () => {
    mount([]);
    expect(screen.getByText('No documents uploaded yet.')).toBeInTheDocument();
    // …and the Add button is still there, so an empty tab is not a dead end.
    expect(screen.getByRole('button', { name: 'Add document' })).toBeInTheDocument();
  });
});

/**
 * f00bd1eb — Delete Company answers BEFORE it acts.
 *
 * The approved behaviour, from the plan and its two mockups: pressing Delete Company opens ONE of two dialogs.
 * When the delete will succeed, "Delete Company?" with the no-records sentence, Cancel and Delete. When it
 * will not, "Unable to Delete Company" with the reason (employee records / payroll records / still linked)
 * and Archive instead. Which one is decided by the server's delete guard (`deleteBlockedBy`), so the panel can
 * no longer offer a confirmation the database then refuses — the reported fault.
 *
 * Driven in the DOM with real clicks, because both dialogs are portalled and only exist once opened: a static
 * render would see neither. "Archive instead" is asserted to submit the ARCHIVE form with the panel's
 * returnTo marker, and the delete action never to be called from a refusal.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import { CompanyPanel, type PanelCompany } from '../components/company-panel';
import type { CompanyDeleteBlock } from '../lib/company-delete';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/admin/organization/c1',
  useSearchParams: () => new URLSearchParams(),
}));

const ORG = en.admin.organization as Record<string, string>;

const company = (over: Partial<PanelCompany>): PanelCompany => ({
  id: 'c1',
  name: 'ABC Comapny',
  country: 'MY',
  currency: 'MYR',
  registrationNo: null,
  companyLabel: null,
  industry: null,
  website: null,
  businessType: null,
  addressLine1: null,
  addressLine2: null,
  addressLine3: null,
  city: null,
  state: null,
  addressCountry: null,
  postcode: null,
  phone: null,
  fax: null,
  archivedAt: null,
  deleteBlockedBy: null,
  canDelete: true,
  parentId: null,
  hasLogo: false,
  defaultPayrollCycle: 'Monthly',
  ...over,
});

function renderPanel(over: Partial<PanelCompany>) {
  const archiveCompany = vi.fn();
  const deleteCompany = vi.fn();
  const noop = () => undefined;
  render(
    <NextIntlClientProvider
      locale="en"
      messages={en}
      timeZone="Asia/Kuala_Lumpur"
      onError={(err) => {
        throw err;
      }}
    >
      <CompanyPanel
        company={company(over)}
        companies={[{ id: 'c1', name: 'ABC Comapny' }]}
        statutory={null}
        bankProfiles={[]}
        statutoryAuthorities={[]}
        signatories={[]}
        stateOptions={[]}
        activeCycleNames={['Monthly']}
        actions={
          {
            saveGeneralTab: async () => ({ ok: true, saved: [] }),
            updateCompany: noop,
            archiveCompany,
            deleteCompany,
            setParent: noop,
            setStatutory: noop,
            setBankProfile: noop,
            removeBankProfile: noop,
            setStatutoryAuthority: noop,
            removeStatutoryAuthority: noop,
            setCompanyLogo: noop,
            removeCompanyLogo: noop,
            updateCompanyDefaultCycle: noop,
          } as never
        }
      />
    </NextIntlClientProvider>,
  );
  return { archiveCompany, deleteCompany };
}

const pressDelete = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: ORG.deleteCompany }));
  return { user, dialog: await screen.findByRole('alertdialog') };
};

describe('a company that was never used: the confirmation', () => {
  it('opens "Delete Company?" with Cancel and Delete, and Delete submits the delete', async () => {
    const { deleteCompany, archiveCompany } = renderPanel({ deleteBlockedBy: null });
    // Archive is offered beside Delete, as the mockup shows.
    expect(screen.getByRole('button', { name: ORG.archiveCompany })).toBeTruthy();
    const { user, dialog } = await pressDelete();
    expect(within(dialog).getByText('Delete Company?')).toBeTruthy();
    expect(
      within(dialog).getByText(
        'This company has no employee or payroll records. Are you sure you want to delete this company?',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: ORG.delete }));
    expect(deleteCompany).toHaveBeenCalledTimes(1);
    expect((deleteCompany.mock.calls[0][0] as FormData).get('id')).toBe('c1');
    expect(archiveCompany).not.toHaveBeenCalled();
  });
});

describe('a company that cannot be deleted: the refusal, with its reason and Archive instead', () => {
  const cases: [CompanyDeleteBlock, string][] = [
    ['employees', 'This company cannot be deleted because employee records have been created under this company.'],
    ['payroll', 'This company cannot be deleted because payroll records exist for this company.'],
    ['other', 'This company cannot be deleted because it is still linked to other records'],
  ];
  for (const [reason, opening] of cases) {
    it(`${reason}: "Unable to Delete Company", the ${reason} sentence, Close and Archive instead`, async () => {
      const { deleteCompany, archiveCompany } = renderPanel({ deleteBlockedBy: reason });
      const { user, dialog } = await pressDelete();
      expect(within(dialog).getByText('Unable to Delete Company')).toBeTruthy();
      expect(dialog.textContent).toContain(opening);
      expect(within(dialog).queryByText('Delete Company?')).toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
      await user.click(within(dialog).getByRole('button', { name: 'Archive instead' }));
      // "Archive instead" archives — through the panel's own archive form, marker and all — and never deletes.
      expect(archiveCompany).toHaveBeenCalledTimes(1);
      const posted = archiveCompany.mock.calls[0][0] as FormData;
      expect(posted.get('id')).toBe('c1');
      expect(posted.get('archived')).toBe('true');
      expect(posted.get('returnTo')).toBe('company');
      expect(deleteCompany).not.toHaveBeenCalled();
    });
  }

  it('Close dismisses the refusal and does nothing', async () => {
    const { deleteCompany, archiveCompany } = renderPanel({ deleteBlockedBy: 'payroll' });
    const { user, dialog } = await pressDelete();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(archiveCompany).not.toHaveBeenCalled();
    expect(deleteCompany).not.toHaveBeenCalled();
  });
});

describe('who sees Delete at all', () => {
  it('a reader who does not administer the company\'s parent is not offered Delete, only Archive', () => {
    renderPanel({ canDelete: false, deleteBlockedBy: null });
    expect(screen.queryByRole('button', { name: ORG.deleteCompany })).toBeNull();
    expect(screen.getByRole('button', { name: ORG.archiveCompany })).toBeTruthy();
  });

  it('an archived company offers Unarchive, not Delete (unchanged)', () => {
    renderPanel({ archivedAt: new Date('2026-01-01'), deleteBlockedBy: null });
    expect(screen.queryByRole('button', { name: ORG.deleteCompany })).toBeNull();
    expect(screen.getByRole('button', { name: ORG.unarchive })).toBeTruthy();
  });
});

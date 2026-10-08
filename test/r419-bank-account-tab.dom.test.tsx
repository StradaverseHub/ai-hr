/**
 * 48652e18 (r419) — Admin › Organisation › company › Bank Account, driven in the DOM with real clicks.
 *
 * The approved plan: "Add a bank account" is ONE CLOSED BUTTON above the saved accounts that opens the
 * fields, and closes again on Cancel or after a successful save; "Remove" asks first, in a box that names
 * the account, its bank and only the LAST FOUR digits of its number, and only "Yes, remove" removes it.
 *
 * Both halves need a real DOM: the add form is not mounted until opened, and the confirmation is a Radix
 * portal that exists only once opened, so a static render sees neither.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import { CompanyPanel, type PanelBankProfile, type PanelCompany } from '../components/company-panel';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/admin/organization/c1',
  useSearchParams: () => new URLSearchParams(),
}));

const ORG = en.admin.organization as Record<string, string>;
const FULL_NO = '5140-1234-5678';

const company: PanelCompany = {
  id: 'c1',
  name: 'Demo Sdn Bhd',
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
};

const profile = (over: Partial<PanelBankProfile> = {}): PanelBankProfile => ({
  id: 'bp1',
  bank: 'maybank',
  corporateId: 'CORP1',
  debitAccountNo: FULL_NO,
  orgName: 'Demo Sdn Bhd',
  txnType: 'IBG',
  accountLabel: 'Payroll account',
  accountName: null,
  accountType: null,
  branch: null,
  swiftCode: null,
  currency: 'MYR',
  isPrimary: true,
  ...over,
});

function panel(bankProfiles: PanelBankProfile[], actions: { setBankProfile: () => void; removeBankProfile: () => void }) {
  const noop = () => undefined;
  return (
    <NextIntlClientProvider
      locale="en"
      messages={en}
      timeZone="Asia/Kuala_Lumpur"
      onError={(err) => {
        throw err;
      }}
    >
      <CompanyPanel
        company={company}
        companies={[{ id: 'c1', name: 'Demo Sdn Bhd' }]}
        statutory={null}
        bankProfiles={bankProfiles}
        statutoryAuthorities={[]}
        signatories={[]}
        stateOptions={[]}
        activeCycleNames={['Monthly']}
        initialTab="bank"
        actions={
          {
            saveGeneralTab: async () => ({ ok: true, saved: [] }),
            updateCompany: noop,
            archiveCompany: noop,
            deleteCompany: noop,
            setParent: noop,
            setStatutory: noop,
            setStatutoryAuthority: noop,
            removeStatutoryAuthority: noop,
            setCompanyLogo: noop,
            removeCompanyLogo: noop,
            updateCompanyDefaultCycle: noop,
            ...actions,
          } as never
        }
      />
    </NextIntlClientProvider>
  );
}

function setup(bankProfiles: PanelBankProfile[] = [profile()]) {
  const setBankProfile = vi.fn();
  const removeBankProfile = vi.fn();
  const utils = render(panel(bankProfiles, { setBankProfile, removeBankProfile }));
  const rerender = (next: PanelBankProfile[]) => utils.rerender(panel(next, { setBankProfile, removeBankProfile }));
  return { setBankProfile, removeBankProfile, rerender, user: userEvent.setup() };
}

const addButton = () => screen.getByRole('button', { name: ORG.bankAccountAdd });
/** The blank add form is the only `corporateId` box with no value. */
const blankCorporateIds = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[name="corporateId"]')).filter((i) => i.value === '');

describe('Add a bank account: one closed button, above the accounts', () => {
  it('is closed on arrival, and the blank form is not there', () => {
    setup();
    expect(addButton().getAttribute('aria-expanded')).toBe('false');
    expect(blankCorporateIds(), 'no blank form on arrival').toHaveLength(0);
  });

  it('sits ABOVE the saved accounts', () => {
    setup();
    const savedHeading = screen.getByText('Payroll account');
    // DOCUMENT_POSITION_FOLLOWING: the saved account comes after the button in document order.
    expect(addButton().compareDocumentPosition(savedHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens the fields when clicked, and Cancel closes them without saving', async () => {
    const { user, setBankProfile } = setup();
    await user.click(addButton());
    expect(addButton().getAttribute('aria-expanded')).toBe('true');
    expect(blankCorporateIds(), 'the blank form is open').toHaveLength(1);
    // It is its own form with its own Save, outside the General tab's consolidated Save (bucket (b)).
    const addForm = blankCorporateIds()[0].closest('form')!;
    expect(addForm.hasAttribute('data-save-section')).toBe(false);
    expect(within(addForm).getByRole('button', { name: ORG.bankProfileSave }).getAttribute('type')).toBe('submit');
    await user.type(blankCorporateIds()[0], 'TYPED');
    await user.click(screen.getByRole('button', { name: ORG.bankAccountAddCancel }));
    expect(addButton().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelectorAll('input[name="corporateId"]'), 'only the saved account is left').toHaveLength(1);
    expect(setBankProfile).not.toHaveBeenCalled();
    // …and reopening shows a blank form again: Cancel discarded what was typed.
    await user.click(addButton());
    expect(blankCorporateIds()).toHaveLength(1);
  });

  it('closes after a successful save — a new account appearing in the list', async () => {
    const { user, rerender } = setup();
    await user.click(addButton());
    expect(addButton().getAttribute('aria-expanded')).toBe('true');
    rerender([profile(), profile({ id: 'bp-new', accountLabel: 'Second account', isPrimary: false })]);
    expect(addButton().getAttribute('aria-expanded')).toBe('false');
    expect(blankCorporateIds()).toHaveLength(0);
  });

  it('stays open when the list did not gain an account (a refused save keeps the entry)', async () => {
    const { user, rerender } = setup();
    await user.click(addButton());
    rerender([profile()]);
    expect(addButton().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('Remove asks first', () => {
  const openRemove = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: ORG.bankProfileRemove }));
    return screen.findByRole('alertdialog');
  };

  it('pressing Remove submits nothing and opens a dialog naming the account, bank and last four only', async () => {
    const { user, removeBankProfile } = setup();
    const dialog = await openRemove(user);
    expect(removeBankProfile, 'Remove alone removes nothing').not.toHaveBeenCalled();
    expect(within(dialog).getByText(ORG.bankRemoveConfirmTitle)).toBeTruthy();
    const text = dialog.textContent ?? '';
    expect(text).toContain('Payroll account · Maybank · account ending 5678');
    expect(text, 'warns that every detail goes').toContain(ORG.bankRemoveConfirmBody);
    expect(text, 'never the full number').not.toContain(FULL_NO);
    expect(text, 'nor the digits before the last four').not.toContain('1234');
    expect(text).not.toContain('51401234');
  });

  it('Cancel closes the dialog and leaves nothing submitted', async () => {
    const { user, removeBankProfile } = setup();
    const dialog = await openRemove(user);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(removeBankProfile).not.toHaveBeenCalled();
  });

  it('only "Yes, remove" submits — that account, on this company', async () => {
    const { user, removeBankProfile } = setup();
    const dialog = await openRemove(user);
    await user.click(within(dialog).getByRole('button', { name: ORG.bankRemoveConfirmYes }));
    expect(removeBankProfile).toHaveBeenCalledTimes(1);
    const posted = removeBankProfile.mock.calls[0][0] as FormData;
    expect(posted.get('id')).toBe('bp1');
    expect(posted.get('companyId')).toBe('c1');
  });

  it('a number of four characters or fewer is named without digits at all', async () => {
    const { user } = setup([profile({ debitAccountNo: '4321', accountLabel: null })]);
    const dialog = await openRemove(user);
    const text = dialog.textContent ?? '';
    expect(text, 'the bank, once — a blank label is not repeated').toContain('Maybank');
    expect(text).not.toContain('Maybank · Maybank');
    expect(text).not.toContain('4321');
    expect(text).not.toContain('ending');
  });
});

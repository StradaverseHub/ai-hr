/**
 * r389 (23bd49d9) — the Payslip Information Setup screen's client behaviour.
 *
 * The order the server saves is exactly the sequence of hidden `fields` inputs this form posts, so every
 * assertion about order is made on THOSE inputs as well as on what is drawn: a list that looks reordered but
 * posts the old sequence is the defect this would otherwise miss. A GET of the page (the §8 render check)
 * cannot reach any of this — it is all client state after load.
 *
 * The six catalogues are fed directly with `onError` throwing, so a key missing from one locale fails here
 * rather than rendering the English sentence through i18n/request.ts's fallback.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

vi.mock('../app/payroll/payslip-information/actions', () => ({
  savePayslipInformation: vi.fn(async () => ({ error: '', saved: true })),
  copyPayslipInformation: vi.fn(async () => ({ error: '', copiedTo: [] })),
}));

import { SettingsForm } from '../app/payroll/payslip-information/settings-form';

const OTHERS = [{ id: 'co-b', name: 'XYZ Company' }, { id: 'co-c', name: 'Demo Company' }];

function renderForm(p: { fields?: string[]; others?: { id: string; name: string }[]; messages?: typeof en; locale?: string } = {}) {
  return render(
    <NextIntlClientProvider locale={p.locale ?? 'en'} messages={(p.messages ?? en) as never} onError={(e) => { throw e; }}>
      <SettingsForm companyId="co-a" companyName="ABC Company" fields={p.fields ?? ['employeeCode', 'employee', 'currency']}
        otherCompanies={p.others ?? OTHERS}/>
    </NextIntlClientProvider>,
  );
}

const posted = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="fields"]')].map(i => i.value);
const shownList = () => within(screen.getByRole('region', { name: 'Shown on payslip' }));
const hiddenList = () => within(screen.getByRole('region', { name: 'Not shown' }));
const rowsOf = (list: ReturnType<typeof shownList>) => list.queryAllByRole('listitem').map(li => li.getAttribute('data-field'));

describe('r389 Payslip Information Setup — order', () => {
  it('lists shown fields numbered in the SAVED order, and the rest unnumbered in catalogue order', () => {
    const { container } = renderForm();
    expect(rowsOf(shownList())).toEqual(['employeeCode', 'employee', 'currency']);
    expect(shownList().getAllByRole('listitem').map(li => li.textContent?.match(/^\d+/)?.[0])).toEqual(['1', '2', '3']);
    expect(posted(container)).toEqual(['employeeCode', 'employee', 'currency']);
    const hidden = rowsOf(hiddenList());
    expect(hidden[0]).toBe('identityNumber');
    expect(hidden).not.toContain('employee');
    expect(hidden).toHaveLength(22); // r392: 25 catalogue fields, 3 shown
    expect(hiddenList().getAllByRole('listitem').every(li => !/^\d/.test(li.textContent ?? ''))).toBe(true);
  });

  it('Move up / Move down reorder the draft and what is posted; the ends are disabled', () => {
    const { container } = renderForm();
    expect(screen.getByRole('button', { name: 'Move up: Employee ID' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move down: Currency' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move down: Employee ID' }));
    expect(rowsOf(shownList())).toEqual(['employee', 'employeeCode', 'currency']);
    expect(posted(container)).toEqual(['employee', 'employeeCode', 'currency']);
    fireEvent.click(screen.getByRole('button', { name: 'Move up: Currency' }));
    expect(posted(container)).toEqual(['employee', 'currency', 'employeeCode']);
  });

  it('dragging a row onto another moves it there', () => {
    const { container } = renderForm();
    const rows = shownList().getAllByRole('listitem');
    fireEvent.dragStart(rows[2]);
    fireEvent.dragOver(rows[0]);
    fireEvent.drop(rows[0]);
    expect(posted(container)).toEqual(['currency', 'employeeCode', 'employee']);
  });

  it('switching a field on appends it to the END; switching it off returns it to Not shown', () => {
    const { container } = renderForm();
    fireEvent.click(screen.getByRole('switch', { name: 'Shown: Branch' }));
    expect(posted(container)).toEqual(['employeeCode', 'employee', 'currency', 'branch']);
    expect(rowsOf(hiddenList())).not.toContain('branch');
    fireEvent.click(screen.getByRole('switch', { name: 'Shown: Employee Name' }));
    expect(posted(container)).toEqual(['employeeCode', 'currency', 'branch']);
    expect(rowsOf(hiddenList())[0]).toBe('employee');
    // Back on ⇒ it does not regain its old place.
    fireEvent.click(screen.getByRole('switch', { name: 'Shown: Employee Name' }));
    expect(posted(container)).toEqual(['employeeCode', 'currency', 'branch', 'employee']);
  });

  it('says so when nothing is shown, and the switches report their state', () => {
    renderForm({ fields: [] });
    expect(screen.getByText(en.payroll.payslipInformation.noneShown)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Shown: Employee Name' })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('r389 Payslip Information Setup — Copy to Companies', () => {
  it('is not offered when the caller manages no other company', () => {
    renderForm({ others: [] });
    expect(screen.queryByRole('button', { name: 'Copy to Companies' })).toBeNull();
  });

  it('opens one dialog listing only the other companies; Copy Settings waits for a choice and posts what was ticked', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Copy to Companies' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Copy Employment Info Display Settings')).toBeInTheDocument();
    expect(dialog.textContent).toContain('Copy ABC Company’s saved display settings (which fields are shown and their order) to:');
    expect(dialog.textContent).toContain(en.payroll.payslipInformation.copyWarning);
    expect(within(dialog).getAllByRole('checkbox').map(c => c.closest('label')?.textContent)).toEqual(['Select All Companies', 'XYZ Company', 'Demo Company']);
    const confirm = within(dialog).getByRole('button', { name: 'Copy Settings' });
    expect(confirm).toBeDisabled();
    const targets = () => [...dialog.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="targetCompanyIds"]')].map(i => i.value);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Demo Company' }));
    expect(confirm).toBeEnabled();
    expect(targets()).toEqual(['co-c']);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Select All Companies' }));
    expect(targets()).toEqual(['co-b', 'co-c']);
    expect(within(dialog).getByRole('checkbox', { name: 'Select All Companies' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Select All Companies' }));
    expect(targets()).toEqual([]);
    expect(confirm).toBeDisabled();
    expect(dialog.querySelector<HTMLInputElement>('input[type="hidden"][name="companyId"]')?.value).toBe('co-a');
  });

  it('warns, in the dialog, that an unsaved draft is not what gets copied', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Copy to Companies' }));
    expect(within(screen.getByRole('alertdialog')).queryByText(en.payroll.payslipInformation.copyUnsaved)).toBeNull();
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Move down: Employee ID' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy to Companies' }));
    expect(within(screen.getByRole('alertdialog')).getByText(en.payroll.payslipInformation.copyUnsaved)).toBeInTheDocument();
  });
});

describe('r389 Payslip Information Setup — six locales', () => {
  it.each([['en', en], ['ms', ms], ['ta', ta], ['th', th], ['vi', vi_], ['zh', zh]] as const)('%s renders every new string', (loc, messages) => {
    const { unmount } = renderForm({ messages: messages as typeof en, locale: loc });
    const m = messages.payroll.payslipInformation as Record<string, string>;
    for (const key of ['shownHeading', 'hiddenHeading', 'orderNote', 'copyButton', 'save', 'cancel']) {
      expect(screen.getAllByText(m[key]).length, `${loc}.${key}`).toBeGreaterThan(0);
    }
    fireEvent.click(screen.getByRole('button', { name: `${m.moveDown}: ${m.employeeCode}` }));
    fireEvent.click(screen.getByRole('button', { name: m.copyButton }));
    const dialog = screen.getByRole('alertdialog');
    for (const key of ['copyTitle', 'copySelectAll', 'copyWarning', 'copyUnsaved', 'copyConfirm']) {
      expect(within(dialog).getAllByText(m[key]).length, `${loc}.${key}`).toBeGreaterThan(0);
    }
    expect(dialog.textContent).toContain(m.copyIntro.replace('{source}', 'ABC Company'));
    unmount();
  });
});

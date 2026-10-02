import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';
import { EaEmployeePicker, type EaPickerStrings } from '../app/payroll/statutory-forms/ea/employee-picker';

const catalogs = { en, ms, ta, th, vi, zh };
function strings(locale: keyof typeof catalogs): EaPickerStrings {
  const t = createTranslator({ locale, messages: catalogs[locale], namespace: 'payroll.statutoryForms' });
  return { searchName: t('eaSearchName'), searchNamePlaceholder: t('eaSearchNamePlaceholder'), searchCode: t('eaSearchCode'), searchCodePlaceholder: t('eaSearchCodePlaceholder'), selectAll: t('eaSelectAll'), clear: t('eaClear'), selectedTemplate: t('eaSelectedCount', { count: '{count}' }), generate: t('pcb2iiGenerate'), preview: t('pcb2iiPreview'), colSelect: t('eaColSelect'), colCode: t('eaColCode'), colName: t('colEmployee'), colDepartment: t('eaColDepartment'), colStatus: t('colStatus'), noMatch: t('eaNoMatch'), tooMany: t('eaTooMany', { max: 200 }) };
}
const rows = [{ employmentId: 'synthetic-id', name: 'Synthetic employee', code: 'EMP-SYN', department: 'Synthetic', status: 'active', statusLabel: 'Active' }];
const hidden = [{ name: 'companyId', value: 'company-a' }, { name: 'year', value: '2026' }, { name: 'lang', value: 'ms' }];

describe('r379 · actual localized shared-picker date behavior', () => {
  for (const locale of Object.keys(catalogs) as (keyof typeof catalogs)[]) {
    it(`${locale}: date starts empty, blocks both submissions, and carries the chosen date to receipts`, () => {
      const t = createTranslator({ locale, messages: catalogs[locale], namespace: 'payroll.statutoryForms' });
      const { container } = render(<EaEmployeePicker rows={rows} strings={strings(locale)} hidden={hidden}
        action="/payroll/statutory-forms/pcb2ii/download" previewAction="/payroll/statutory-forms/pcb2ii/preview"
        selectedDateField={{ label: t('pcb2iiSelectedDate'), value: '', help: t('pcb2iiDateHelp'), receiptsHref: '/payroll/statutory-forms/pcb2ii/receipts?companyId=company-a&year=2026&lang=ms', receiptsLabel: t('pcb2iiReceiptsLink') }} />);
      const date = container.querySelector<HTMLInputElement>('input[name="selectedDate"]')!;
      expect(date.value).toBe('');
      expect(date.required).toBe(true);
      expect(date.getAttribute('min')).toBeNull();
      expect(date.getAttribute('max')).toBeNull();
      expect(date.closest('label')).toHaveTextContent(t('pcb2iiSelectedDate'));
      fireEvent.click(screen.getByRole('checkbox'));
      const form = container.querySelector('form')!;
      expect(form.checkValidity()).toBe(false);
      expect(screen.getByRole('button', { name: t('pcb2iiPreview') })).toHaveAttribute('formaction', '/payroll/statutory-forms/pcb2ii/preview');
      fireEvent.change(date, { target: { value: '2028-02-29' } });
      expect(form.checkValidity()).toBe(true);
      expect(new FormData(form).get('selectedDate')).toBe('2028-02-29');
      const href = screen.getByRole('link', { name: t('pcb2iiReceiptsLink') }).getAttribute('href')!;
      const q = new URL(href, 'https://synthetic.local').searchParams;
      expect(q.get('selectedDate')).toBe('2028-02-29');
      expect(q.get('companyId')).toBe('company-a');
      expect(q.get('year')).toBe('2026');
      expect(q.get('lang')).toBe('ms');
      expect(container.textContent).not.toMatch(/MISSING_MESSAGE/);
    });
  }
  it('EA callers without the optional date contract retain their existing form', () => {
    const { container } = render(<EaEmployeePicker rows={rows} strings={strings('en')} hidden={hidden} action="/payroll/statutory-forms/ea/download" />);
    expect(container.querySelector('input[name="selectedDate"]')).toBeNull();
    expect(container.querySelector('form')).toHaveAttribute('action', '/payroll/statutory-forms/ea/download');
  });
});

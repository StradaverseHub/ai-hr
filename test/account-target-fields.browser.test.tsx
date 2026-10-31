import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ta from '../messages/ta.json';
import { AccountTargetFields } from '../app/(app)/admin/users/account-target-fields';
import { Card, Field, SectionHeader, btnPrimary, inputCls } from '../components/ui';
import '../app/globals.css';
afterEach(cleanup);

// Actual shared enrollment controls and compiled application CSS. No server mutation is mocked as success.
describe('standalone enrollment form in a real browser', () => {
  for (const width of [390, 1280]) for (const [locale, messages] of [['en', en], ['ta', ta]] as const) {
    it(`${locale} at ${width}px keeps identity and deliberate access choices reachable`, async () => {
      await page.viewport(width, 1000);
      const t = messages.admin.users;
      render(<NextIntlClientProvider locale={locale} messages={messages}><main className="mx-auto max-w-5xl p-4">
        <Card><SectionHeader title={t.manual.title}/><form data-testid="standalone-form" className="grid gap-4 p-4 sm:grid-cols-2">
          <AccountTargetFields idPrefix="manual" people={[{ id: 'person-a', name: 'Existing employee' }]} companies={[{ id: 'company-a', name: 'Acme company' }]} roles={[{ value: 'employee', label: t.role.employee }, { value: 'hr_admin', label: t.role.hr_admin }]}>
            <Field label={t.manual.email}><input type="email" name="email" required className={inputCls}/></Field>
            <Field label={t.manual.username}><input name="username" required className={inputCls}/></Field>
            <Field label={t.manual.password}><input type="password" name="password" required className={inputCls}/></Field>
          </AccountTargetFields>
          <button type="button" className={`${btnPrimary} w-fit`}>{t.manual.create}</button>
        </form></Card>
      </main></NextIntlClientProvider>);
      await page.getByRole('radio', { name: t.accountTarget.standalone }).click();
      const name = screen.getByRole('textbox', { name: t.accountTarget.fullName }) as HTMLInputElement;
      expect(name.required).toBe(true);
      const role = screen.getByRole('combobox', { name: t.accountTarget.role }) as HTMLSelectElement;
      const scope = screen.getByRole('combobox', { name: t.accountTarget.scope }) as HTMLSelectElement;
      expect(role.value).toBe(''); expect(scope.value).toBe(''); expect(role.required && scope.required).toBe(true);
      for (const control of [name, role, scope, screen.getByRole('textbox', { name: t.manual.email })]) {
        const rect = control.getBoundingClientRect();
        expect(rect.width).toBeGreaterThan(100); expect(rect.left).toBeGreaterThanOrEqual(0); expect(rect.right).toBeLessThanOrEqual(width);
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      console.info('Standalone enrollment screenshot:', await page.screenshot({element:document.querySelector('main')!,path:`../.vitest-attachments/standalone-${locale}-${width}.png`}));
    });
  }
});

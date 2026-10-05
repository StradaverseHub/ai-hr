/**
 * r388 — a redacted database error is SHOWN in the viewer's language, with its reference, and an ordinary
 * error message is shown exactly as before. ErrorBanner renders `?error=` on ~136 screens.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import { ErrorBanner } from '../components/ui';
import { formatDatabaseErrorRef } from '../lib/database-error-token';

const ref = formatDatabaseErrorRef('permission', 'A1B2C3');
const english = en.common.databaseError.permission.replace('{ref}', ref);

function banner(locale: string, messages: Record<string, unknown>, message: string) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <ErrorBanner message={message} />
    </NextIntlClientProvider>,
  ).container.textContent;
}

describe('ErrorBanner and a redacted database error', () => {
  it.each([
    ['en', en],
    ['ms', ms],
    ['zh', zh],
  ])('shows the %s sentence with the reference', (locale, messages) => {
    const expected = (messages as typeof en).common.databaseError.permission.replace('{ref}', ref);
    expect(banner(locale, messages, english)).toBe(expected);
    expect(expected).toContain(ref);
  });

  it('shows an ordinary refusal unchanged', () => {
    expect(banner('ms', ms, 'Select a bank from the Malaysian bank list')).toBe('Select a bank from the Malaysian bank list');
  });
});

// Board 96a54ed2: the unchanged correction form carries only the chosen employee when opened on behalf, and every
// on-behalf string exists in all six locales. All names are fictional.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { CorrectionForm, type CorrectionCopy } from '../app/attendance/requests/correction-form';
import { ATTENDANCE_NAV_FOR_TEST } from './helpers/attendance-on-behalf-nav';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';

const locales = { en, ms, zh, ta, th, vi } as const;
const copy = Object.fromEntries(['dateLabel', 'anotherHelp', 'checkIn', 'checkOut', 'required', 'reason', 'reasonPlaceholder', 'remark', 'remarkPlaceholder', 'attachment', 'attachmentHelp', 'goesTo', 'originalKept', 'submit'].map(key => [key, `Fictional ${key}`])) as CorrectionCopy;
const show = (onBehalfOf?: string | null) => render(<NextIntlClientProvider locale="en" messages={en}>
  <CorrectionForm copy={copy} approver="Fictional approver" submitAction={async () => undefined} section="other" requestKind="other" day={null} minDate="2026-11-01" maxDate="2026-11-11" onBehalfOf={onBehalfOf} />
</NextIntlClientProvider>);
afterEach(cleanup);

describe('Request On Behalf reuses the My Attendance form', () => {
  it('posts the chosen employee only when opened on their behalf', () => {
    const own = show();
    expect(own.container.querySelector('input[name="onBehalfOf"]')).toBeNull();
    cleanup();
    const forOther = show('00000000-0000-4000-8000-000000000123');
    expect(forOther.container.querySelector<HTMLInputElement>('input[name="onBehalfOf"]')?.value).toBe('00000000-0000-4000-8000-000000000123');
    // Every visible field is the same form.
    for (const label of ['Fictional checkIn', 'Fictional checkOut', 'Fictional submit']) expect(forOther.container.textContent).toContain(label);
  });
  it('offers both screens to HR under Attendance and to superiors under Manage', () => {
    expect(ATTENDANCE_NAV_FOR_TEST.admin).toEqual(expect.arrayContaining(['/attendance/on-behalf/request', '/attendance/on-behalf/approve']));
    expect(ATTENDANCE_NAV_FOR_TEST.manage).toEqual(expect.arrayContaining(['/attendance/on-behalf/request', '/attendance/on-behalf/approve']));
  });
  it.each(Object.keys(locales) as (keyof typeof locales)[])('has every on-behalf string in %s', locale => {
    const messages = locales[locale] as unknown as { attendanceOnBehalf: Record<string, string>; nav: Record<string, string>; attendanceHistory: Record<string, unknown> & { modes: Record<string, string> } };
    for (const key of Object.keys(en.attendanceOnBehalf)) expect(messages.attendanceOnBehalf[key]?.trim(), `${locale}.attendanceOnBehalf.${key}`).toBeTruthy();
    for (const key of ['attendanceRequestOnBehalf', 'attendanceApproveOnBehalf']) expect(messages.nav[key]?.trim()).toBeTruthy();
    for (const key of ['submittedOnBehalfBy', 'approvedOnBehalf', 'rejectedOnBehalf']) expect(String(messages.attendanceHistory[key] ?? '').trim()).toBeTruthy();
    expect(messages.attendanceHistory.modes.on_behalf?.trim()).toBeTruthy();
    if (locale !== 'en') expect(messages.attendanceOnBehalf.banner).not.toBe(en.attendanceOnBehalf.banner);
  });
});

/** Authored source-only display acceptance. No render/test runtime has been used in this window. */
import { randomUUID } from 'node:crypto';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import { todayInKualaLumpur } from '../lib/hr-date';

const catalogues = { en, ms, zh, ta, th, vi: viMessages };
let locale: keyof typeof catalogues = 'en';
vi.mock('next/link', () => ({ default: ({ children, ...props }: ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => {
    if (namespace !== 'ownLeaveReview') throw new Error('Unexpected review namespace');
    return createTranslator({ locale, messages: { ownLeaveReview: catalogues[locale].ownLeaveReview }, namespace: 'ownLeaveReview' });
  },
  getFormatter: async () => ({
    dateTime: (date: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(date),
    number: (number: number, options: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(number),
  }),
}));
import { OwnLeaveReviewCard } from '../components/assistant/own-leave-review-card';

afterEach(() => { cleanup(); locale = 'en'; });
function review() {
  const now = new Date();
  return { actionId: randomUUID(), contractVersion: 1 as const, reviewedDigest: 'a'.repeat(64),
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    companyName: '<strong>Fictional company</strong>', employeeCode: 'FICT-1', leaveTypeName: 'Annual',
    date: todayInKualaLumpur(), durationType: 'full_day' as const, deductionDays: 0.5,
    availableBalance: 10, estimatedAvailableAfter: 9.5, holidayWarnings: [], approvalRouting: 'unknown' as const,
    humanText: { reason: '<img src=x onerror=alert(1)> Exact human reason\nsecond line', employeeRemark: 'Exact human remark' } };
}

describe('saved own-leave review display', () => {
  it('renders exact human/source text as text and only offers the canonical date-only form fallback', async () => {
    const r = review();
    const { container } = render(await OwnLeaveReviewCard({ review: r }));
    expect(screen.getByRole('heading', { name: en.ownLeaveReview.title })).toBeTruthy();
    expect(container.textContent).toContain(r.companyName);
    expect(container.textContent).toContain(r.humanText.reason);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    const link = screen.getByRole('link', { name: en.ownLeaveReview.openForm });
    expect(link.getAttribute('href')).toBe(`/leave?apply=1&start=${r.date}`);
    expect(link.getAttribute('href')).not.toContain('reason');
    expect(container.querySelector('form')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(screen.getByText(en.ownLeaveReview.approvalUnknown)).toBeTruthy();
    expect(screen.getByText('0.5')).toBeTruthy();
    const selectedDate = new Date(`${r.date}T00:00:00+08:00`);
    expect(container.textContent).toContain(new Intl.DateTimeFormat('en', {
      dateStyle: 'full', timeZone: 'Asia/Kuala_Lumpur',
    }).format(selectedDate));
  });

  it('omits both estimates when the source display policy hides them', async () => {
    render(await OwnLeaveReviewCard({ review: { ...review(), availableBalance: null, estimatedAvailableAfter: null } }));
    expect(screen.queryByText(en.ownLeaveReview.available)).toBeNull();
    expect(screen.queryByText(en.ownLeaveReview.after)).toBeNull();
    expect(screen.getByText(en.ownLeaveReview.deduction)).toBeTruthy();
    expect(screen.getByText(en.ownLeaveReview.fullDay)).toBeTruthy();
  });

  it('refuses a leaked private field or inconsistent visibility instead of serializing it', async () => {
    const r = review();
    for (const extra of [{ privateAvailableBalance: 999 }, { availableBalance: null }]) {
      const { container } = render(await OwnLeaveReviewCard({ review: { ...r, ...extra } }));
      expect(screen.getByRole('alert').textContent).toBe(en.ownLeaveReview.unavailable);
      expect(container.textContent).not.toContain(r.companyName);
      expect(screen.queryByRole('link')).toBeNull();
      cleanup();
    }
  });

  it.each(['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const)('has a complete %s display and warning message', async language => {
    locale = language;
    const r = review();
    const { container } = render(await OwnLeaveReviewCard({ review: { ...r,
      holidayWarnings: [{ country: 'MY', state: 'Selangor', year: Number(r.date.slice(0, 4)), loaded: 1, required: 5 }] } }));
    expect(screen.getByRole('heading', { name: catalogues[language].ownLeaveReview.title })).toBeTruthy();
    expect(screen.getByRole('link', { name: catalogues[language].ownLeaveReview.openForm })).toBeTruthy();
    expect(container.textContent).toContain('MY · Selangor');
    expect(container.textContent).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
  });
});

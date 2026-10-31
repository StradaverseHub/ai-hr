import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
vi.mock('../app/(app)/rewards/actions', () => ({ lumpAction: vi.fn(), previewRewardLumpAction: vi.fn(() => new Promise(() => {})) }));
import { rewardReviewTitle } from '../app/(app)/rewards/[unitId]/unit-scope';
import { UnitLumpSum } from '../app/(app)/rewards/[unitId]/lump-sum';

const catalogues = { en, ms, zh, ta, th, vi: viMessages };
afterEach(cleanup);
describe('9070acae unit scope on the review', () => {
  it('titles the review with its company and business unit', () => {
    expect(rewardReviewTitle('2026 Annual Compensation Review', 'Sample Trading Sdn Bhd', 'Northern Sales')).toBe('2026 Annual Compensation Review · Sample Trading Sdn Bhd / Northern Sales');
  });
  it('states the scope above the lump-sum box and names the unit on its button', () => {
    const t = createTranslator({ locale: 'en', messages: en, namespace: 'rewards' });
    render(<NextIntlClientProvider locale="en" messages={en} onError={error => { throw error; }}>
      <UnitLumpSum value={{ unitId: 'unit-01', revision: 1, unitName: 'Northern Sales', editable: true, suggestedLumpCents: 30000, lumpUnitCents: null, reason: null, decision: null,
        scope: t('unitBonus.appliesOnlyTo', { company: 'Sample Trading Sdn Bhd', unit: 'Northern Sales' }) }} />
    </NextIntlClientProvider>);
    expect(screen.getByText('Applies only to this review: Sample Trading Sdn Bhd / Northern Sales')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save lump sum for Northern Sales' })).toBeVisible();
    expect(screen.queryByRole('button', { name: en.rewards.saveAmount })).toBeNull();
  });
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('formats the unit-scoped wording in %s', locale => {
    const t = createTranslator({ locale, messages: catalogues[locale], namespace: 'rewards' });
    for (const text of [t('unitBonus.appliesOnlyTo', { company: 'Sample Trading Sdn Bhd', unit: 'Northern Sales' }), t('unitBonus.saveUnitMultiplierFor', { unit: 'Northern Sales' }), t('unitBonus.saveLumpFor', { unit: 'Northern Sales' })]) {
      expect(text).toContain('Northern Sales');
    }
    expect(t('unitBonus.appliesOnlyTo', { company: 'Sample Trading Sdn Bhd', unit: 'Northern Sales' })).toContain('Sample Trading Sdn Bhd');
    if (locale !== 'en') expect(t('unitBonus.saveLumpFor', { unit: 'N' })).not.toBe(createTranslator({ locale: 'en', messages: en, namespace: 'rewards' })('unitBonus.saveLumpFor', { unit: 'N' }));
  });
});

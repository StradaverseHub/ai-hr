import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
const actions = vi.hoisted(() => ({ preview: vi.fn(), save: vi.fn() }));
vi.mock('../app/(app)/rewards/actions', () => ({ previewRewardLumpAction: actions.preview, lumpAction: actions.save }));
import { UnitLumpSum, type UnitLumpValue } from '../app/(app)/rewards/[unitId]/lump-sum';

// 4e3e1af7 / c28db2f0 — fictional fixtures.
const catalogues = { en, ms, zh, ta, th, vi: viMessages };
const c = en.rewards.lumpChoice;
const value = (patch: Partial<UnitLumpValue> = {}): UnitLumpValue => ({ unitId: 'unit-01', revision: 3, unitName: 'Northern Sales', scope: 'Applies only to this review', editable: true,
  suggestedLumpCents: 30000, lumpUnitCents: null, reason: null, decision: null, ...patch });
const preview = (over = false) => ({ unitId: 'unit-01', revision: 3, lumpUnitCents: 35000, suggestedLumpCents: 30000, exempt: false,
  plans: [{ plan: 'standard', count: 12, amendments: 2, lumpCents: 420000, balanceCents: 185000, usedBp: 9620, over: false }, { plan: 'h', count: 3, amendments: 0, lumpCents: 105000, balanceCents: -15000, usedBp: 10140, over }] });
const show = (v = value(), locale: keyof typeof catalogues = 'en') =>
  render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error => { throw error; }}><UnitLumpSum value={v} /></NextIntlClientProvider>);
beforeEach(() => { vi.clearAllMocks(); actions.preview.mockResolvedValue({ ok: true, preview: preview(true) }); });
afterEach(cleanup);

describe('4e3e1af7 / c28db2f0 unit lump sum', () => {
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders the three choices in %s without translation errors', async locale => {
    show(value(), locale);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(await screen.findByRole('table')).toBeVisible();
  });

  it('shows the per-plan effect, flags a plan over its pool and links the individual amendments', async () => {
    show();
    expect(await screen.findByText('12')).toBeVisible();
    expect(screen.getByText('101.4%')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(en.rewards.lumpImpact.overBlocked);
    expect(screen.getByRole('link', { name: '2 · view list' })).toHaveAttribute('href', '/rewards/unit-01?view=review&check=BUD-05#checks');
    expect(actions.preview).toHaveBeenCalledWith('unit-01', 3, null);
  });

  it('warns when a set amount is above the suggestion', async () => {
    show();
    await userEvent.click(screen.getByRole('radio', { name: new RegExp(c.set) }));
    await userEvent.type(screen.getByRole('spinbutton'), '350');
    expect(screen.getByText(/more than the remaining budget supports/)).toBeVisible();
  });

  it('withholding needs a reason and a confirmation naming how many people are affected', async () => {
    show();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('radio', { name: new RegExp(c.withhold) }));
    const withhold = screen.getByRole('button', { name: c.withhold });
    expect(withhold).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: c.reasonRequired }), 'BU missed the PAT floor');
    await userEvent.click(screen.getByRole('button', { name: c.withhold }));
    expect(screen.getByText('Withhold the lump sum for 15 people in Northern Sales?')).toBeVisible();
    expect(screen.getByRole('button', { name: c.withhold })).toHaveAttribute('type', 'submit');
  });

  it('shows who withheld it and why, and read-only viewers see the setting without a form', () => {
    show(value({ editable: false, lumpUnitCents: 0, decision: { at: '2026-11-12', actorName: 'A. Example', reason: 'BU missed the PAT floor' } }));
    expect(screen.getByRole('note')).toHaveTextContent('Lump sum withheld for this BU by A. Example on 2026-11-12. “BU missed the PAT floor”');
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

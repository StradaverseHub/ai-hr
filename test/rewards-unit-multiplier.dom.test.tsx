import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
const actions = vi.hoisted(() => ({ preview: vi.fn(), save: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: actions.refresh }) }));
vi.mock('../app/(app)/rewards/actions', () => ({ previewRewardMultiplierAction: actions.preview, saveRewardMultiplierAction: actions.save }));
import { UnitMultiplier, type UnitMultiplierValue } from '../app/(app)/rewards/[unitId]/unit-multiplier';

const catalogues = { en, ms, zh, ta, th, vi: viMessages };
const u = en.rewards.unitBonus;
const value = (patch: Partial<UnitMultiplierValue> = {}): UnitMultiplierValue => ({
  unitId: 'unit-01', revision: 4, unitName: 'Northern Sales', scope: 'Applies only to this review: Sample Trading Sdn Bhd / Northern Sales',
  multiplierBp: null, suggestedMultiplierBp: 11000, branch: false, canConfigure: true,
  suggestion: { patActualMissing: false, achievementBp: 11000, targetMonthsBp: 20000, poolMultiplierBp: 22000 }, ...patch,
});
const preview = (blocked: boolean, exempt = false) => ({ unitId: 'unit-01', revision: 4, beforeBp: null, requestedBp: 12000, effectiveBp: 12000, exempt, blocked, digest: 'd'.repeat(64),
  plans: [{ plan: 'standard', nowBp: 8400, afterBp: 9700, over: false }, { plan: 'h', nowBp: 7900, afterBp: 10400, over: true }] });
function show(v = value(), locale: keyof typeof catalogues = 'en') {
  return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error => { throw error; }}><UnitMultiplier value={v} /></NextIntlClientProvider>);
}
beforeEach(() => { vi.clearAllMocks(); actions.save.mockResolvedValue({ ok: true }); });
afterEach(cleanup);
describe('bcd7cc0f unit multiplier', () => {
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders the explanation and form in %s without translation errors', locale => {
    show(value({ suggestion: { ...value().suggestion!, patActualMissing: true } }), locale);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
  it('explains the suggestion and that it applies to both plans', () => {
    show();
    const box = within(screen.getByRole('region', { name: u.suggestedTitle }));
    expect(box.getByText('1.10')).toBeVisible();
    expect(box.getByText('110.0%')).toBeVisible();
    expect(box.getByText('2.00')).toBeVisible();
    expect(box.getByText('2.20')).toBeVisible();
    expect(box.getByText(u.ruleText)).toBeVisible();
    expect(box.queryByText(u.patMissing)).toBeNull();
    expect(screen.getByText(u.bothPlans)).toBeVisible();
    expect(screen.getByText('Applies only to this review: Sample Trading Sdn Bhd / Northern Sales')).toBeVisible();
  });
  it('says Actual PAT is missing', () => {
    show(value({ suggestedMultiplierBp: 0, suggestion: { patActualMissing: true, achievementBp: 0, targetMonthsBp: 20000, poolMultiplierBp: 0 } }));
    expect(screen.getByRole('note')).toHaveTextContent(u.patMissing);
  });
  it('replaces the form with a notice under branch factors', () => {
    show(value({ branch: true }));
    expect(screen.getByText(u.branchNotUsed)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('shows the explanation without the form to a viewer who cannot configure', () => {
    show(value({ canConfigure: false }));
    expect(screen.getByRole('region', { name: u.suggestedTitle })).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('checks impact per plan and refuses to save above 100% without an exemption', async () => {
    actions.preview.mockResolvedValue({ ok: true, preview: preview(true) });
    const user = userEvent.setup(); show();
    const save = screen.getByRole('button', { name: 'Save unit multiplier for Northern Sales' });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(en.rewards.multiplierAuto), '1.2');
    await user.type(screen.getByLabelText(u.reason), 'BU exceeded PAT target after Q4 revision');
    await user.click(screen.getByRole('button', { name: u.checkImpact }));
    expect(actions.preview).toHaveBeenCalledWith('unit-01', 4, 12000);
    const table = within(screen.getByRole('table', { name: u.checkImpact }));
    expect(table.getByRole('columnheader', { name: 'With 1.20' })).toBeVisible();
    expect(table.getByText('84.0%')).toBeVisible();
    expect(table.getByText(`104.0% · ${u.overBudget}`)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(u.overBlocked);
    expect(save).toBeDisabled();
  });
  it('saves a previewed override with its reason, and asks for a new check when the value changes', async () => {
    actions.preview.mockResolvedValue({ ok: true, preview: preview(false, true) });
    const user = userEvent.setup(); show();
    const save = screen.getByRole('button', { name: 'Save unit multiplier for Northern Sales' });
    await user.type(screen.getByLabelText(en.rewards.multiplierAuto), '1.2');
    await user.click(screen.getByRole('button', { name: u.checkImpact }));
    expect(screen.getByText(u.overExempt)).toBeVisible();
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(u.reason), 'short');
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(u.reason), ' but now long enough');
    expect(save).toBeEnabled();
    await user.click(save);
    expect(actions.save).toHaveBeenCalledWith('unit-01', 4, 12000, 'short but now long enough', 'd'.repeat(64));
    expect(actions.refresh).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(u.multiplierSaved);
    await user.type(screen.getByLabelText(u.reason), 'Another fictional reason');
    await user.type(screen.getByLabelText(en.rewards.multiplierAuto), '5');
    expect(screen.queryByRole('table')).toBeNull();
    expect(save).toBeDisabled();
  });
});

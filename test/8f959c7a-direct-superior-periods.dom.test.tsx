/**
 * Board 8f959c7a r2 — the Direct Superior card lists every period with Edit and Remove, says before a save
 * which period a cleared end date or a removal takes away, answers on the card (entries kept on a refusal),
 * and never spins forever or retries by itself. Fictional fixtures only.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../messages/en.json';
import { DirectSuperiorPeriods, type DirectSuperiorPeriodView } from '../app/admin/personnel/[employmentId]/direct-superior-periods';
import type { DirectSuperiorSaveOutcome } from '../app/admin/personnel/[employmentId]/actions';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const d = en.people.detail;
const labels = {
  title: d.directSuperiorPeriodsTitle, current: d.directSuperiorPeriodCurrent, edit: d.directSuperiorPeriodEdit,
  remove: d.directSuperiorPeriodRemove, superior: d.directSuperiorLabel, start: d.directSuperiorPeriodStart,
  end: d.directSuperiorPeriodEnd, endCurrent: d.directSuperiorPeriodEndCurrent, endFixed: d.directSuperiorPeriodEndFixed,
  reason: d.directSuperiorReason, cancel: d.directSuperiorCancel, saveCorrection: d.directSuperiorPeriodSaveCorrection,
  removePeriod: d.directSuperiorPeriodRemoveConfirm, confirmClear: d.directSuperiorPeriodConfirmClear,
  confirmRemovePrevious: d.directSuperiorPeriodConfirmRemovePrevious, confirmRemoveNext: d.directSuperiorPeriodConfirmRemoveNext,
  confirmRemoveAlone: d.directSuperiorPeriodConfirmRemoveAlone, joinHint: d.directSuperiorPeriodJoinHint,
  uncertain: d.directSuperiorUncertain, checkHistory: d.directSuperiorCheckHistory, searchPlaceholder: d.directSuperiorSearch,
  noResults: d.directSuperiorNoResults, none: d.directSuperiorNone,
};
// Newest first, as the page passes them: the same fictional superior split on 16-Nov-2026.
const PERIODS: DirectSuperiorPeriodView[] = [
  { id: 'line-2', managerEmploymentId: 'boss-a', label: 'A0001 – Test Superior', validFrom: '2026-11-16', validTo: null },
  { id: 'line-1', managerEmploymentId: 'boss-a', label: 'A0001 – Test Superior', validFrom: '2026-07-20', validTo: '2026-11-16' },
];
type Action = (previous: DirectSuperiorSaveOutcome, data: FormData) => Promise<DirectSuperiorSaveOutcome>;
function renderCard(action: Action, extra: Partial<{ canEdit: boolean; canRemove: boolean; confirmWithinMs: number }> = {}) {
  return render(
    <DirectSuperiorPeriods action={action} employmentId="emp-fictional" revision="rev-1" periods={PERIODS}
      joinable={['line-1']} options={[{ value: 'boss-a', label: 'A0001 – Test Superior' }]}
      canEdit={extra.canEdit ?? true} canRemove={extra.canRemove ?? true}
      historyHref="/admin/personnel/emp-fictional?tab=careerMovement" labels={labels} confirmWithinMs={extra.confirmWithinMs} />,
  );
}
const row = (id: string) => document.querySelector<HTMLElement>(`[data-superior-period-row="${id}"]`)!;

beforeEach(() => refresh.mockReset());

describe('Direct Superior periods on the card (8f959c7a r2)', () => {
  it('lists every period with inclusive dates, Current, the join hint, and Edit/Remove', () => {
    renderCard(vi.fn<Action>());
    expect(row('line-2')).toHaveTextContent('16-Nov-2026 – Current');
    expect(row('line-1')).toHaveTextContent('20-Jul-2026 – 15-Nov-2026');
    expect(row('line-1')).toHaveTextContent(labels.joinHint);
    expect(row('line-2')).not.toHaveTextContent(labels.joinHint);
    expect(within(row('line-1')).getByRole('button', { name: labels.edit })).toBeInTheDocument();
    expect(within(row('line-1')).getByRole('button', { name: labels.remove })).toBeInTheDocument();
  });

  it('shows no Edit or Remove without permission, and no Remove without the Delete permission', () => {
    const { unmount } = renderCard(vi.fn<Action>(), { canEdit: false });
    expect(screen.queryByRole('button', { name: labels.edit })).toBeNull();
    unmount();
    renderCard(vi.fn<Action>(), { canRemove: false });
    expect(screen.getAllByRole('button', { name: labels.edit })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: labels.remove })).toBeNull();
  });

  it('names the period a cleared end date removes, posts the edit, and keeps entries on a refusal', async () => {
    const action = vi.fn<Action>(async (_p, data) => ({ status: 'refused', submissionId: String(data.get('submissionId')),
      message: 'The selected Direct Superior must be active on the Effective Date.' }));
    renderCard(action);
    fireEvent.click(within(row('line-1')).getByRole('button', { name: labels.edit }));
    const end = row('line-1').querySelector<HTMLInputElement>('input[name="validToInclusive"]')!;
    expect(end.value).toBe('2026-11-15');
    fireEvent.change(end, { target: { value: '' } });
    const note = row('line-1').querySelector('[data-superior-period-confirm]')!;
    expect(note).toHaveTextContent('removes the period A0001 – Test Superior, 16-Nov-2026 – Current');
    expect(note).toHaveTextContent('from 20-Jul-2026');
    const reason = row('line-1').querySelector<HTMLInputElement>('input[name="reason"]')!;
    fireEvent.change(reason, { target: { value: 'Join the split period' } });
    await act(async () => { fireEvent.click(within(row('line-1')).getByRole('button', { name: labels.saveCorrection })); });
    const sent = action.mock.calls[0][1];
    expect(Object.fromEntries(['periodOperation', 'periodLineId', 'periodRevision', 'validFrom', 'validToInclusive', 'superiorEmploymentId', 'reason']
      .map(key => [key, sent.get(key)]))).toEqual({ periodOperation: 'edit', periodLineId: 'line-1', periodRevision: 'rev-1',
      validFrom: '2026-07-20', validToInclusive: '', superiorEmploymentId: 'boss-a', reason: 'Join the split period' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-direct-superior-outcome', 'refused');
    expect(reason.value).toBe('Join the split period');
    expect(end.value).toBe('');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('confirms a removal, closes the editor on a saved answer and refreshes the page', async () => {
    const action = vi.fn<Action>(async (_p, data) => ({ status: 'saved', submissionId: String(data.get('submissionId')), message: d.directSuperiorPeriodRemoved }));
    renderCard(action);
    fireEvent.click(within(row('line-2')).getByRole('button', { name: labels.remove }));
    expect(row('line-2').querySelector('[data-superior-period-confirm]')).toHaveTextContent('A0001 – Test Superior carries on');
    fireEvent.change(row('line-2').querySelector<HTMLInputElement>('input[name="reason"]')!, { target: { value: 'Entered twice' } });
    await act(async () => { fireEvent.click(within(row('line-2')).getByRole('button', { name: labels.removePeriod })); });
    expect(action.mock.calls[0][1].get('periodOperation')).toBe('remove');
    expect(await screen.findByRole('status')).toHaveTextContent(d.directSuperiorPeriodRemoved);
    expect(row('line-2').querySelector('form')).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('stops waiting after the bound, points at Employment History and never submits again by itself', async () => {
    vi.useFakeTimers();
    try {
      const action = vi.fn<Action>(() => new Promise(() => {}));
      renderCard(action, { confirmWithinMs: 1000 });
      fireEvent.click(within(row('line-2')).getByRole('button', { name: labels.remove }));
      fireEvent.change(row('line-2').querySelector<HTMLInputElement>('input[name="reason"]')!, { target: { value: 'Wrong' } });
      fireEvent.click(within(row('line-2')).getByRole('button', { name: labels.removePeriod }));
      await act(async () => { vi.advanceTimersByTime(1500); });
      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('data-direct-superior-outcome', 'uncertain');
      expect(within(alert).getByRole('link', { name: labels.checkHistory })).toHaveAttribute('href', '/admin/personnel/emp-fictional?tab=careerMovement');
      expect(action).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

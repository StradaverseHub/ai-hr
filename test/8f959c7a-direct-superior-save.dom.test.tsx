/**
 * Board 8f959c7a — the Direct Superior card's Save always finishes on the card itself: a refusal in red
 * under Save with the entries kept, a confirmed save with the current superior, and — when no answer can
 * be confirmed — a bounded "check Employment History" message instead of an endless "Saving...". Never a
 * second submit by itself. Fictional fixtures only.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../messages/en.json';
import { DirectSuperiorChangeForm } from '../app/admin/personnel/[employmentId]/direct-superior-change-form';
import type { DirectSuperiorSaveOutcome } from '../app/admin/personnel/[employmentId]/actions';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const d = en.people.detail;
const labels = {
  title: d.directSuperiorChangeTitle, amendment: d.directSuperiorAmend, movement: d.directSuperiorMovement,
  effectiveDate: 'Effective Date', reason: d.directSuperiorReason, cancel: d.directSuperiorCancel, save: d.directSuperiorSave,
  uncertain: d.directSuperiorUncertain, checkHistory: d.directSuperiorCheckHistory, current: d.directSuperiorCurrent,
  none: d.directSuperiorNone,
};
const HISTORY = '/admin/personnel/emp-fictional?tab=careerMovement';

type Action = (previous: DirectSuperiorSaveOutcome, data: FormData) => Promise<DirectSuperiorSaveOutcome>;
function renderForm(action: Action, confirmWithinMs?: number) {
  return render(
    <DirectSuperiorChangeForm action={action} employmentId="emp-fictional" currentLineId="line-1" hiredOn="2026-01-01"
      historyHref={HISTORY} labels={labels} confirmWithinMs={confirmWithinMs}>
      <input type="hidden" name="superiorEmploymentId" value="boss-fictional" />
    </DirectSuperiorChangeForm>,
  );
}

function fillMovement() {
  fireEvent.click(screen.getByRole('button', { name: labels.save }));
  fireEvent.click(screen.getByRole('radio', { name: labels.movement }));
  const date = document.querySelector<HTMLInputElement>('input[name="effectiveDate"]')!;
  const reason = document.querySelector<HTMLInputElement>('input[name="reason"]')!;
  fireEvent.change(date, { target: { value: '2026-07-01' } });
  fireEvent.change(reason, { target: { value: 'Team restructure' } });
  return { date, reason, submit: () => fireEvent.click(screen.getByRole('button', { name: labels.save })) };
}

beforeEach(() => refresh.mockReset());

describe('Direct Superior save outcome on the card (8f959c7a)', () => {
  it('shows a refusal inline under Save, keeps every entry and re-enables Save', async () => {
    const action = vi.fn<Action>(async (_p, data) => ({ status: 'refused', submissionId: String(data.get('submissionId')),
      message: 'The selected Direct Superior must be active on the Effective Date.' }));
    renderForm(action);
    const { date, reason, submit } = fillMovement();
    expect(date.min).toBe('2026-01-01');
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The selected Direct Superior must be active on the Effective Date.');
    expect(alert).toHaveAttribute('data-direct-superior-outcome', 'refused');
    expect(screen.getByRole('radio', { name: labels.movement })).toBeChecked();
    expect(date.value).toBe('2026-07-01');
    expect(reason.value).toBe('Team restructure');
    const save = screen.getByRole('button', { name: labels.save });
    expect(save).not.toBeDisabled();
    expect(save).not.toHaveAttribute('aria-busy', 'true');
    expect(action).toHaveBeenCalledOnce();
    const sent = action.mock.calls[0][1];
    expect(sent.get('superiorChangeMode')).toBe('movement');
    expect(sent.get('superiorEmploymentId')).toBe('boss-fictional');
    expect(sent.get('currentLineId')).toBe('line-1');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('confirms a save with the current superior read back, closes the review and refreshes in the background', async () => {
    const action = vi.fn<Action>(async (_p, data) => ({ status: 'saved', submissionId: String(data.get('submissionId')),
      message: 'Saved. The new Direct Superior applies from 01-Jul-2026.',
      current: { employmentId: 'boss-fictional', label: 'FIC-0002 – Fictional Boss' } }));
    renderForm(action);
    fillMovement().submit();
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Saved. The new Direct Superior applies from 01-Jul-2026.');
    expect(status).toHaveTextContent(`${labels.current}: FIC-0002 – Fictional Boss`);
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.queryByRole('radio', { name: labels.movement })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stops spinning after the bound and asks to check Employment History, without a second submit', async () => {
    const action = vi.fn<Action>(() => new Promise<DirectSuperiorSaveOutcome>(() => {}));
    renderForm(action, 40);
    fillMovement().submit();
    await waitFor(() => expect(screen.getByRole('button', { name: /saving/i })).toHaveAttribute('aria-busy', 'true'));
    const alert = await screen.findByRole('alert', {}, { timeout: 2000 });
    expect(alert).toHaveAttribute('data-direct-superior-outcome', 'uncertain');
    expect(alert).toHaveTextContent(labels.uncertain);
    expect(screen.getByRole('link', { name: labels.checkHistory })).toHaveAttribute('href', HISTORY);
    expect(screen.getByRole('button', { name: labels.save })).not.toHaveAttribute('aria-busy', 'true');
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));
    expect(action).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('treats an unreadable answer as unconfirmed, never as saved or failed', async () => {
    const action = vi.fn<Action>(async () => { throw new TypeError('Failed to fetch'); });
    renderForm(action);
    fillMovement().submit();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-direct-superior-outcome', 'uncertain');
    expect(action).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });
});

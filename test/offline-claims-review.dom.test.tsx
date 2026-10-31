/** The Offline punches tab on Attendance › Application History: status badges, the row's detail drawer, the photo rule
 * for a group admin (no photo and no Accept while it is kept; Reject stays), the time select limited to the proven
 * interval, the decision posted with its reason, a refusal in plain words, and every reason translated in every
 * locale. The action is replaced; its wiring is test/offline-claim-actions.test.ts. Instants derive from the clock. */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import zh from '../messages/zh.json';
import { OfflineClockReviewReason } from '../lib/mobile-offline-receipt';
const m = vi.hoisted(() => ({ resolve: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: m.refresh, push: vi.fn() }) }));
vi.mock('../app/(app)/attendance/application-history/offline-actions', () => ({ resolveOfflineClaimAction: m.resolve }));
import { OfflineClaimsReview } from '../app/(app)/attendance/application-history/offline-review';
import type { OfflineReviewRow } from '../app/(app)/attendance/application-history/offline-data';
import { defaultOfflineResolutionTime, offlineResolutionTimes, OFFLINE_SECOND_STEP_LIMIT } from '../app/(app)/attendance/application-history/offline-time';

const R = en.offlineClocking.review;
/** A whole minute well in the past, so every instant here is derived from the clock rather than written down. */
const anchor = Math.floor((Date.now() - 2 * 86_400_000) / 60_000) * 60_000;
const row = (over: Partial<OfflineReviewRow> = {}): OfflineReviewRow => ({
  id: '0b6a3f3e-8d0e-4a51-9b7e-3c1f0c6f2a11', employeeName: 'Fictional Worker', action: 'out', claimedAt: anchor + 4_300, receivedAt: anchor + 3_600_000,
  effectiveMinimum: anchor + 1_200, effectiveMaximum: anchor + 9_800, decidedAt: null, reason: 'mock_reported', status: 'needs_review',
  photo: { retainedUntil: anchor + 30 * 86_400_000, retained: true }, resolutionReason: null, ...over,
});
const show = (rows: OfflineReviewRow[], p: { groupAdmin?: boolean; all?: boolean; messages?: typeof en; locale?: string } = {}) =>
  render(<NextIntlClientProvider locale={p.locale ?? 'en'} messages={p.messages ?? en} onError={(error) => { throw error; }}>
    <OfflineClaimsReview rows={rows} groupAdmin={p.groupAdmin ?? false} all={p.all ?? false} />
  </NextIntlClientProvider>);
const open = async (name = 'Fictional Worker') => { fireEvent.click(screen.getByRole('button', { name })); return screen.findByRole('dialog'); };

describe('the review table', () => {
  it('shows each status as its own badge and the reason the punch was held', () => {
    const statuses = ['needs_review', 'pending', 'accepted', 'rejected'] as const;
    show(statuses.map((status, i) => row({ id: `0b6a3f3e-8d0e-4a51-9b7e-3c1f0c6f2a1${i}`, employeeName: `Worker ${i}`, status })), { all: true });
    const body = screen.getAllByRole('row').slice(1);
    expect(body).toHaveLength(4);
    statuses.forEach((status, i) => {
      expect(within(body[i]).getByText(R.status[status])).toBeVisible();
      expect(within(body[i]).getByText(en.offlineClocking.reasons.mock_reported)).toBeVisible();
      expect(within(body[i]).getByText(/^Received /)).toBeVisible();
    });
    for (const header of [R.colEmployee, R.colPunch, R.colWhy, R.colStatus]) expect(screen.getByRole('columnheader', { name: header })).toBeVisible();
  });

  it('says so when nothing is waiting, and when nothing was ever held', () => {
    show([]);
    expect(screen.getByText(R.empty)).toBeVisible();
    show([], { all: true });
    expect(screen.getByText(R.emptyAll)).toBeVisible();
  });
});

describe('the detail drawer', () => {
  it('shows the recorded range, the held reason, the photo from the audited route and both decisions', async () => {
    show([row()]);
    const dialog = await open();
    expect(within(dialog).getByText('Fictional Worker · Out punch')).toBeVisible();
    expect(within(dialog).getByText(/^Recorded offline .+ between .+ and .+ · phone says /)).toBeVisible();
    expect(within(dialog).getByText(`Held because: ${en.offlineClocking.reasonDetails.mock_reported}`)).toBeVisible();
    expect(within(dialog).getByText(/^Photo kept until .+ · viewing is recorded$/)).toBeVisible();
    const photo = within(dialog).getByRole('img', { name: R.photoAlt.replace('{name}', 'Fictional Worker') });
    expect(photo).toHaveAttribute('src', `/attendance/offline-claims/${row().id}/photo`);
    expect(screen.getByRole('button', { name: R.reject })).toBeVisible();
    expect(screen.getByRole('button', { name: R.accept })).toBeVisible();
  });

  it('gives a group admin no photo and no Accept while the photo is kept, with the reason why; Reject stays', async () => {
    show([row()], { groupAdmin: true });
    const dialog = await open();
    expect(within(dialog).queryByRole('img')).toBeNull();
    expect(within(dialog).getByText(R.groupAdminPhoto)).toBeVisible();
    expect(screen.queryByRole('button', { name: R.accept })).toBeNull();
    expect(screen.getByRole('button', { name: R.reject })).toBeVisible();
  });

  it('lets a group admin accept once the photo is no longer kept, or when there is none', async () => {
    show([row({ photo: { retainedUntil: anchor, retained: false } }), row({ id: '0b6a3f3e-8d0e-4a51-9b7e-3c1f0c6f2a19', employeeName: 'Second Worker', photo: null })], { groupAdmin: true });
    let dialog = await open();
    expect(within(dialog).getByText(R.photoGone)).toBeVisible();
    expect(screen.getByRole('button', { name: R.accept })).toBeVisible();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Fictional Worker · Out punch')).toBeNull());
    dialog = await open('Second Worker');
    expect(screen.getByRole('button', { name: R.accept })).toBeVisible();
    expect(within(dialog).queryByText(R.groupAdminPhoto)).toBeNull();
  });

  it('offers only whole seconds inside the proven interval, defaulting to the one nearest the phone\'s time', async () => {
    const r = row();
    show([r]);
    const dialog = await open();
    const select = within(dialog).getByRole('combobox', { name: R.time }) as HTMLSelectElement;
    const values = [...select.options].map((option) => Number(option.value));
    expect(values.length).toBeGreaterThan(0);
    expect(values).toEqual(offlineResolutionTimes(r.effectiveMinimum, r.effectiveMaximum).values);
    for (const value of values) {
      expect(value % 1000).toBe(0);
      expect(value).toBeGreaterThanOrEqual(r.effectiveMinimum!);
      expect(value).toBeLessThanOrEqual(r.effectiveMaximum!);
    }
    expect(Number(select.value)).toBe(anchor + 4_000);
    expect(within(dialog).getByText(R.timeHelpSeconds)).toBeVisible();
  });

  it('offers whole minutes for a wide interval and only rejection when no interval was proven', async () => {
    const wide = row({ effectiveMinimum: anchor - 7_200_000 + 500, effectiveMaximum: anchor + 3_600_000 - 1, claimedAt: anchor + 61_000 });
    show([wide, row({ id: '0b6a3f3e-8d0e-4a51-9b7e-3c1f0c6f2a18', employeeName: 'Unbounded Worker', effectiveMinimum: null, effectiveMaximum: null })]);
    let dialog = await open();
    const values = [...(within(dialog).getByRole('combobox', { name: R.time }) as HTMLSelectElement).options].map((option) => Number(option.value));
    expect(Math.min(...values)).toBe(anchor - 7_140_000);
    expect(Math.max(...values)).toBe(anchor + 3_540_000);
    expect(values).toHaveLength(179);
    expect(values.every((value) => value % 60_000 === 0)).toBe(true);
    expect(within(dialog).getByText(R.timeHelpMinutes)).toBeVisible();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = await open('Unbounded Worker');
    expect(within(dialog).getByText(R.noRange)).toBeVisible();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: R.accept })).toBeNull();
    expect(screen.getByRole('button', { name: R.reject })).toBeVisible();
  });

  it('posts the decision with its reason and instant, and shows a refusal in plain words', async () => {
    m.resolve.mockResolvedValueOnce({ ok: false, error: 'payrollClosed' });
    show([row()]);
    const dialog = await open();
    fireEvent.change(within(dialog).getByRole('textbox', { name: R.reason }), { target: { value: 'Gate log confirms the clock-out' } });
    fireEvent.click(screen.getByRole('button', { name: R.accept }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(R.errors.payrollClosed);
    const posted = m.resolve.mock.calls[0][1] as FormData;
    expect(posted.get('decision')).toBe('accepted');
    expect(posted.get('reason')).toBe('Gate log confirms the clock-out');
    expect(posted.get('claimId')).toBe(row().id);
    expect(Number(posted.get('effectiveAt'))).toBe(anchor + 4_000);
  });

  it('posts a rejection with its reason and no instant', async () => {
    m.resolve.mockResolvedValueOnce({ ok: true, claimId: row().id, status: 'rejected' });
    show([row()]);
    const dialog = await open();
    fireEvent.change(within(dialog).getByRole('textbox', { name: R.reason }), { target: { value: 'Employee was on leave' } });
    fireEvent.click(screen.getByRole('button', { name: R.reject }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(R.done.rejected);
    const posted = m.resolve.mock.lastCall![1] as FormData;
    expect([posted.get('decision'), posted.get('reason'), posted.get('effectiveAt')]).toEqual(['rejected', 'Employee was on leave', null]);
  });

  it('shows Pending approval after an accept a further level must approve, and refreshes the list on close', async () => {
    m.resolve.mockResolvedValueOnce({ ok: true, claimId: row().id, status: 'pending' });
    show([row()]);
    const dialog = await open();
    fireEvent.change(within(dialog).getByRole('textbox', { name: R.reason }), { target: { value: 'Supervisor confirmed' } });
    fireEvent.click(screen.getByRole('button', { name: R.accept }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(R.done.pending);
    expect(within(dialog).getByText(R.status.pending)).toBeVisible();
    expect(screen.queryByRole('button', { name: R.reject })).toBeNull();
    expect(screen.queryByRole('button', { name: R.accept })).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(m.refresh).toHaveBeenCalled());
  });
});

describe('the time options', () => {
  it('switch from seconds to minutes past the limit and choose the nearest option', () => {
    const base = anchor;
    expect(offlineResolutionTimes(base, base + OFFLINE_SECOND_STEP_LIMIT * 1000)).toMatchObject({ step: 'second' });
    expect(offlineResolutionTimes(base, base + OFFLINE_SECOND_STEP_LIMIT * 1000 + 1000)).toMatchObject({ step: 'minute' });
    expect(offlineResolutionTimes(base + 1, base + 999).values).toEqual([]);
    expect(offlineResolutionTimes(null, base).values).toEqual([]);
    expect(defaultOfflineResolutionTime([base, base + 1000, base + 2000], base + 1400)).toBe(base + 1000);
    expect(defaultOfflineResolutionTime([], base)).toBeNull();
  });
});

describe('every hold reason in every locale', () => {
  for (const [locale, messages] of [['en', en], ['ms', ms], ['ta', ta], ['th', th], ['vi', viMessages], ['zh', zh]] as const) {
    it(`${locale}: has a translated label and detail for all ${OfflineClockReviewReason.options.length} reasons`, () => {
      const c = (messages as typeof en).offlineClocking;
      for (const reason of OfflineClockReviewReason.options) {
        expect(c.reasons[reason], `${locale} reasons.${reason}`).toBeTruthy();
        expect(c.reasonDetails[reason], `${locale} reasonDetails.${reason}`).toBeTruthy();
        if (locale !== 'en') expect(c.reasons[reason], `${locale} reasons.${reason} is still English`).not.toBe(en.offlineClocking.reasons[reason]);
      }
      show(OfflineClockReviewReason.options.map((reason, i) => row({ id: `0b6a3f3e-8d0e-4a51-9b7e-${String(i).padStart(12, '0')}`, employeeName: `Worker ${i}`, reason })), { messages: messages as typeof en, locale });
      for (const reason of OfflineClockReviewReason.options) expect(screen.getAllByText(c.reasons[reason]).length).toBeGreaterThan(0);
    });
  }
});

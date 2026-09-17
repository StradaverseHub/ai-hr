/**
 * r302 · the employee's per-date outcome list after Cancel Approved Leave's split.
 *
 * The r302 hand-fix moves each per-date approval row onto the split row that holds its date and marks a date given
 * back by an approved cancellation 'cancelled'. This list had three pills (approved / rejected / anything else =
 * Pending), so a cancelled day read "Pending" — telling the employee a day they gave back is still waiting. And it
 * printed the raw ISO date. Both pinned here, in all six catalogues.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';
import { LeaveDateOutcome } from '../components/leave/leave-date-outcome';

afterEach(() => cleanup());

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;

describe('LeaveDateOutcome — a cancelled day reads Cancelled, dates in the viewer’s format', () => {
  for (const [locale, messages] of Object.entries(CATALOGUES)) {
    it(`${locale}`, () => {
      const b = (messages as { me: { dateBreakdown: Record<string, string> } }).me.dateBreakdown;
      expect(b.cancelled, `${locale} me.dateBreakdown.cancelled`).toBeTruthy();
      render(
        <LeaveDateOutcome
          locale={locale}
          labels={{ title: b.title, approved: b.approved, rejected: b.rejected, pending: b.pending, cancelled: b.cancelled, reason: b.reason }}
          dates={[
            { id: '1', leaveDate: '2026-10-05', days: '1.00', status: 'approved', rejectReason: null },
            { id: '2', leaveDate: '2026-10-06', days: '1.00', status: 'cancelled', rejectReason: null },
            { id: '3', leaveDate: '2026-10-07', days: '1.00', status: 'rejected', rejectReason: 'Short staffed' },
            { id: '4', leaveDate: '2026-10-08', days: '1.00', status: 'pending', rejectReason: null },
          ]}
        />,
      );
      const items = screen.getAllByRole('listitem');
      expect(items).toHaveLength(4);
      expect(within(items[0]).getByText(b.approved)).toBeTruthy();
      expect(within(items[1]).getByText(b.cancelled)).toBeTruthy();
      expect(within(items[1]).queryByText(b.pending)).toBeNull();
      expect(within(items[2]).getByText(b.rejected)).toBeTruthy();
      expect(within(items[3]).getByText(b.pending)).toBeTruthy();
      for (const li of items) expect(li.textContent ?? '').not.toMatch(/\d{4}-\d{2}-\d{2}/);
    });
  }
});

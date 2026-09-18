/**
 * r305 — EVERY TASK KIND HAS A LABEL THE BELL CAN RENDER.
 *
 * WHY A RENDER TEST AND NOT A KEY-EXISTENCE TEST. The bell builds its label from a COMPUTED key:
 * `t(`task.${task.kind}`)` (components/notification-center.tsx). test/i18n-coverage.test.ts says in its
 * own header that it cannot check dynamic keys — it proves every key in en.json exists in the other five
 * locales, which is a different claim. So a kind added to `PendingTaskKind` with no
 * `notifications.task.<kind>` entry passes tsc, passes that guard, passes `next build`, returns 200, and
 * paints the raw key at the person who is supposed to act on it. That is the hole this file closes, and it
 * is the hole r305's new 'replacementLeave' kind would otherwise have fallen into.
 *
 * The provider is given the REAL en.json, so a missing key throws here instead of rendering
 * MISSING_MESSAGE. The other five locales are covered structurally by i18n-coverage (check A); together
 * they mean: the key exists everywhere, and the component can actually render it.
 *
 * Scope note: jsdom computes no layout, so this is about text, not appearance.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { NotificationCenter } from '../components/notification-center';
import type { PendingTaskItem, PendingTaskKind } from '../core/approvals-inbox';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

// The bell imports its two server actions, and those reach db/client — which throws
// "DATABASE_URL is not set" in the dom project, deliberately (test/dom-setup.ts explains why a
// component test is given no connection). Marking read is not what this file is about.
vi.mock('@/app/notification-actions', () => ({
  markAllNotificationsReadAction: vi.fn(),
  markNotificationReadAction: vi.fn(),
}));

/**
 * Every kind the read model can produce. Listed literally rather than derived from the type, because a
 * type cannot be enumerated at runtime — and the `satisfies` below is what makes the list exhaustive:
 * add a kind to PendingTaskKind without adding it here and this file stops compiling.
 */
const ALL_KINDS = [
  'leave',
  'leaveCancellation',
  'replacementLeave',
  'attendance',
  'travel',
  'profile',
  'claim',
  'resignation',
  'managerReview',
  'hrReview',
] as const satisfies readonly PendingTaskKind[];

type Exhaustive<T extends readonly PendingTaskKind[]> = Exclude<PendingTaskKind, T[number]> extends never
  ? true
  : ['missing kinds:', Exclude<PendingTaskKind, T[number]>];
// A kind missing from ALL_KINDS surfaces here as a type error naming it.
const _exhaustive: Exhaustive<typeof ALL_KINDS> = true;

const task = (kind: PendingTaskKind): PendingTaskItem => ({
  id: `id-${kind}`,
  kind,
  subjectName: 'Subject Name',
  createdAt: new Date('2026-09-18T01:00:00.000Z').toISOString(),
  linkPath: '/approvals',
});

describe('the bell renders a real label for every task kind', () => {
  it('shows a translated label, never a raw key', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">
        <NotificationCenter unread={0} items={[]} tasks={ALL_KINDS.map(task)} />
      </NextIntlClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: /notification/i }));
    // ^Tasks, not /tasks/i: the bell's own aria-label ends in "… N tasks", so a loose match finds two.
    await userEvent.click(screen.getByRole('button', { name: /^Tasks/ }));

    for (const kind of ALL_KINDS) {
      const label = messages.notifications.task[kind];
      expect(label, `notifications.task.${kind} is missing from en.json`).toBeTruthy();
      expect(screen.getByText(label), `the bell did not render ${kind}`).toBeInTheDocument();
      // The failure this guards against: next-intl paints the key itself when the entry is absent.
      expect(screen.queryByText(`notifications.task.${kind}`)).toBeNull();
    }
  });

  it('labels the queue r305 added', () => {
    // Named on its own so a regression reads as what it is, rather than as "the loop failed".
    expect(messages.notifications.task.replacementLeave).toBe('Approve replacement leave request');
  });
});

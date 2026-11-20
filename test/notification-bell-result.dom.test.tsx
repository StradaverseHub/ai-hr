import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { expect, it, vi } from 'vitest';
import type { NotificationBellView } from '../app/notification-bell-view';
import { NotificationCenter } from '../components/notification-center';
import en from '../messages/en.json';

const actions = vi.hoisted(() => ({ one: vi.fn(), all: vi.fn() }));
vi.mock('../app/notification-actions', () => ({
  markNotificationReadAction: actions.one,
  markAllNotificationsReadAction: actions.all,
}));

const notice: NotificationBellView['items'][number] = {
  id: 'fictional-notice', title: 'Fictional update', body: 'Fictional notice body',
  kind: 'fixture', severity: 'info', createdAt: new Date(), readAt: null, linkPath: null,
};
const renderBell = (unread: number, items: NotificationBellView['items']) => (
  <NextIntlClientProvider locale="en" messages={en}>
    <NotificationCenter unread={unread} items={items} />
  </NextIntlClientProvider>
);

it('uses the committed bell data without needing a new layout render', async () => {
  actions.one.mockResolvedValueOnce({
    unread: 0, items: [], taskNotifications: [], notificationTaskCount: 0,
    readItems: [{ ...notice, readAt: new Date() }],
  });
  render(renderBell(1, [notice]));
  fireEvent.click(screen.getByRole('button', { name: /Notifications, .*1 unread/ }));
  fireEvent.click(screen.getByRole('button', { name: /Fictional update/ }));
  await screen.findByRole('button', { name: /Notifications, .*0 unread/ });
  expect(actions.one).toHaveBeenCalledWith(notice.id);
  fireEvent.click(screen.getByRole('button', { name: /Notifications, .*0 unread/ }));
  fireEvent.click(screen.getByRole('button', { name: 'History' }));
  expect(screen.getByText(notice.title)).toBeInTheDocument();
});

it('keeps the newer shell snapshot if a response from the previous scope arrives late', async () => {
  let complete!: (view: NotificationBellView) => void;
  actions.one.mockReturnValueOnce(new Promise<NotificationBellView>(resolve => { complete = resolve; }));
  const { rerender } = render(renderBell(1, [notice]));
  fireEvent.click(screen.getByRole('button', { name: /Notifications, .*1 unread/ }));
  fireEvent.click(screen.getByRole('button', { name: /Fictional update/ }));

  const nextNotice = { ...notice, id: 'new-scope', title: 'New scope notice' };
  rerender(renderBell(3, [nextNotice]));
  await act(async () => {
    complete({ unread: 0, items: [], readItems: [], taskNotifications: [], notificationTaskCount: 0 });
  });

  fireEvent.click(screen.getByRole('button', { name: /Notifications, .*3 unread/ }));
  expect(screen.getByText(nextNotice.title)).toBeInTheDocument();
});

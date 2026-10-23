import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import { NotificationCenter, type NotificationTaskItem } from '../components/notification-center';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('../app/notification-actions', () => ({ markAllNotificationsReadAction: vi.fn(), markNotificationReadAction: vi.fn() }));

const catalogues = { en, ms, zh, ta, th, vi: viMessages };
describe('replacement-leave tasks in the real bell', () => {
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders the complete 24-task population and both replacement links in %s', async locale => {
    const messages = catalogues[locale];
    const now = new Date().toISOString();
    const tasks: NotificationTaskItem[] = [
      ...Array.from({length:22}, (_, i) => ({ id: `existing-${i}`, kind: 'leave' as const, subjectName: `Fictional requester ${i}`, createdAt: now, linkPath: '/approvals' })),
      ...Array.from({length:2}, (_, i) => ({ id: `replacement-${i}`, kind: 'replacementLeave' as const, subjectName: `Fictional replacement applicant ${i}`, createdAt: now, linkPath: '/approvals?category=replacementLeave' })),
    ];
    render(<NextIntlClientProvider locale={locale} messages={messages} onError={error => { throw error; }}>
      <NotificationCenter unread={0} items={[]} tasks={tasks} taskCount={tasks.length} canApprove />
    </NextIntlClientProvider>);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button'));
    const taskTab = screen.getByText(messages.notifications.tabTasks, {exact:true}).closest('button')!;
    expect(taskTab).toHaveTextContent('24');
    await user.click(taskTab);
    const replacementLinks = screen.getAllByRole('link').filter(link => link.getAttribute('href') === '/approvals?category=replacementLeave');
    expect(replacementLinks).toHaveLength(2);
    for (const link of replacementLinks) expect(within(link).getByText(messages.notifications.task.replacementLeave)).toBeVisible();
    expect(screen.getByText('Fictional replacement applicant 0')).toBeVisible();
    expect(screen.getByText('Fictional replacement applicant 1')).toBeVisible();
  });
});

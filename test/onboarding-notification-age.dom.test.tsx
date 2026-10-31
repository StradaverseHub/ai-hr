import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { NotificationCenter, type NotificationTaskItem } from '../components/notification-center';
import { onboardingNotificationTask } from '../lib/onboarding-notification-task';
import messages from '../messages/en.json';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/notification-actions',()=>({markAllNotificationsReadAction:vi.fn(),markNotificationReadAction:vi.fn()}));
afterEach(()=>vi.restoreAllMocks());
it('omits invented onboarding ages, orders undated work deterministically and retains genuine approval timestamps and counts',()=>{
 const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now);
 const undated={id:'z-undated',title:'Undated checklist',joiner:'Fictional hire',due:null};
 const future={id:'a-future',title:'Future checklist',joiner:'Fictional hire',due:new Date(now+30*86400000).toISOString().slice(0,10)};
 const older:NotificationTaskItem={id:'old',kind:'leave',subjectName:'Older real approval',createdAt:new Date(now-3600000).toISOString(),linkPath:'/approvals'};
 const newer:NotificationTaskItem={id:'new',kind:'leave',subjectName:'Newer real approval',createdAt:new Date(now-120000).toISOString(),linkPath:'/approvals'};
 const tasks=[onboardingNotificationTask(undated),older,onboardingNotificationTask(future),newer];
 expect(tasks[0]).not.toHaveProperty('createdAt');expect(tasks[2]).not.toHaveProperty('createdAt');
 const view=render(<NextIntlClientProvider locale="en" messages={messages}><NotificationCenter unread={1} items={[]} tasks={tasks} taskCount={4}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Notifications, 5 waiting: 1 unread and 4 open tasks'}));
 fireEvent.click(screen.getByRole('button',{name:/^Tasks\s*4$/}));
 const entries=screen.getAllByRole('listitem');
 expect(entries.map(e=>e.textContent)).toEqual([
  expect.stringContaining('Newer real approval'),expect.stringContaining('Older real approval'),expect.stringContaining('Future checklist'),expect.stringContaining('Undated checklist')
 ]);
 expect(within(entries[0]!).getByText('2m')).toBeVisible();expect(within(entries[1]!).getByText('1h')).toBeVisible();
 expect(entries[2]!.textContent).toBe('Onboarding workFuture checklist · Fictional hire');
 expect(entries[3]!.textContent).toBe('Onboarding workUndated checklist · Fictional hire');
 view.rerender(<NextIntlClientProvider locale="en" messages={messages}><NotificationCenter unread={1} items={[]} tasks={[...tasks].reverse()} taskCount={4}/></NextIntlClientProvider>);
 expect(screen.getAllByRole('listitem').map(e=>e.textContent)).toEqual(entries.map(e=>e.textContent));
 expect(readFileSync('app/(app)/layout.tsx','utf8')).toContain('...onboardingQueue.map(onboardingNotificationTask)');
});

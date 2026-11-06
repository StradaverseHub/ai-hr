import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import { NotificationCenter, type NotificationTaskItem } from '../components/notification-center';
import {ShellApprovalFactsProvider,type ShellApprovalResult} from '../components/shell-approval-facts';

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

it('reads approval history only when an authorized viewer opens History', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json([{
    id:'decision', moduleKey:'leave', actionKey:'approved', subjectName:'Fictional approved employee',
    deciderName:null, isAuto:false, onBehalfOfName:null, occurredAt:new Date().toISOString(),
  }]));
  vi.stubGlobal('fetch',fetcher);
  try {
    render(<NextIntlClientProvider locale="en" messages={en} onError={error => { throw error; }}>
      <NotificationCenter unread={0} items={[]} canApprove />
    </NextIntlClientProvider>);
    const user = userEvent.setup();
    expect(fetcher).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('button',{name:en.notifications.tabTasks}));
    expect(fetcher).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:en.notifications.tabHistory}));
    expect(await screen.findByText(/Fictional approved employee/)).toBeVisible();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/notifications/approval-history',expect.objectContaining({
      cache:'no-store',credentials:'same-origin',
    }));
  } finally {
    vi.unstubAllGlobals();
  }
});

it('loads the bounded Claims preview only when Tasks opens and retains the full-queue link', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ total: 40, items: [{
    id: 'claim', kind: 'claim', subjectName: 'Fictional claim requester',
    createdAt: new Date().toISOString(), linkPath: '/approvals?category=claim&requestId=claim',
  }] }));
  vi.stubGlobal('fetch', fetcher);
  try {
    render(<NextIntlClientProvider locale="en" messages={en} onError={error => { throw error; }}>
      <NotificationCenter unread={0} items={[]} taskCount={40} claimTaskCount={40} claimPreviewRevision="revision" />
    </NextIntlClientProvider>);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button'));
    expect(fetcher).not.toHaveBeenCalled();
    await user.click(screen.getByText(en.notifications.tabTasks, { exact: true }));
    expect(await screen.findByText('Fictional claim requester')).toBeVisible();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/notifications/claim-tasks', expect.objectContaining({
      cache: 'no-store', credentials: 'same-origin',
    }));
    expect(screen.getByRole('link', { name: `${en.approvals.claims} (40)` }))
      .toHaveAttribute('href', '/approvals?category=claim');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps the bell usable during shell streaming, then shows the exact combined count and clears stale data',async()=>{
 let settle!:(result:ShellApprovalResult)=>void;
 const source=new Promise<ShellApprovalResult>(resolve=>{settle=resolve;});
 const item={id:'approval',kind:'leave' as const,subjectName:'Fictional scoped approval',
  createdAt:new Date().toISOString(),linkPath:'/approvals'};
 const view=(facts:Promise<ShellApprovalResult>)=><NextIntlClientProvider locale="en" messages={en} onError={error=>{throw error;}}>
  <ShellApprovalFactsProvider source={facts} canOpenApprovalsWithoutAssignment={false}>
   <NotificationCenter unread={1} items={[]} taskCount={2}/>
  </ShellApprovalFactsProvider>
 </NextIntlClientProvider>;
 const rendered=render(view(source));
 const user=userEvent.setup();
 await user.click(screen.getByRole('button',{name:'Notifications, 1 unread'}));
 await user.click(screen.getByRole('button',{name:en.notifications.tabTasks}));
 expect(screen.getByRole('status')).toHaveTextContent(en.common.loading);
 expect(screen.queryByText(en.notifications.tasksEmpty)).toBeNull();
 await act(async()=>settle({state:'ready',items:[item],total:5,approvalCount:5,claimTotal:4,
  hasAssignedApproval:true,hasAssignedAttendanceApproval:false}));
 expect(await screen.findByText(item.subjectName)).toBeVisible();
 expect(screen.getByRole('button',{name:'Notifications, 8 waiting: 1 unread and 7 open tasks'})).toBeVisible();
 rendered.rerender(view(Promise.resolve({state:'unavailable'})));
 expect(screen.queryByText(item.subjectName)).toBeNull();
 expect(await screen.findByRole('alert')).toHaveTextContent(en.commandBar.loadError);
 expect(screen.queryByText(en.notifications.tasksEmpty)).toBeNull();
 expect(screen.getByRole('button',{name:'Notifications, 1 unread'})).toBeVisible();
});

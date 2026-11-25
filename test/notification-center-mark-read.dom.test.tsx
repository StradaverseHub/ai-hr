/** ADR 0181 decision 4: marking a notification read updates the bell from the action's returned re-read; it no longer
 * revalidates the layout and refreshes the route (two whole-tree draws per click). A failed re-read refreshes the route
 * as before. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import type {BellNotifications} from '../lib/bell-notifications';

const router=vi.hoisted(()=>({refresh:vi.fn(),push:vi.fn()}));
const actions=vi.hoisted(()=>({markNotificationReadAction:vi.fn(),markAllNotificationsReadAction:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>router}));
vi.mock('../app/notification-actions',()=>actions);
import {NotificationCenter} from '../components/notification-center';

const row=(id:string,severity:'info'|'action',read=false)=>({id,title:`Fictional ${id}`,body:'Fixture only',linkPath:null,severity,readAt:read?new Date('2026-11-20T00:00:00Z'):null,createdAt:new Date('2026-11-24T00:00:00Z')});
const shell:BellNotifications={unread:2,items:[row('a','info'),row('b','info')],taskNotifications:[row('t','action')],notificationTaskCount:1,readItems:[row('old','info',true)]};
beforeEach(()=>{router.refresh.mockReset();actions.markNotificationReadAction.mockReset();actions.markAllNotificationsReadAction.mockReset();});
afterEach(cleanup);

function renderBell(){
 return render(<NextIntlClientProvider locale="en" messages={en}><NotificationCenter unread={shell.unread} items={shell.items}
  taskNotifications={shell.taskNotifications} notificationTaskCount={shell.notificationTaskCount} taskCount={3} readItems={shell.readItems}/></NextIntlClientProvider>);
}

it('applies the returned bell after mark all read, without refreshing the route',async()=>{
 actions.markAllNotificationsReadAction.mockResolvedValue({unread:0,items:[],taskNotifications:[],notificationTaskCount:0,
  readItems:[row('a','info',true),row('b','info',true),row('t','action',true),row('old','info',true)]} satisfies BellNotifications);
 renderBell();
 // 2 unread + 3 tasks (2 queue + 1 action notification).
 fireEvent.click(screen.getByRole('button',{name:'Notifications, 5 waiting: 2 unread and 3 open tasks'}));
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:en.notifications.markAllRead}));});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Notifications, 2 waiting: 0 unread and 2 open tasks'})).toBeTruthy());
 expect(screen.queryByText('Fictional a')).toBeNull();
 expect(router.refresh).not.toHaveBeenCalled();
});

it('refreshes the route when the re-read failed',async()=>{
 actions.markAllNotificationsReadAction.mockResolvedValue(null);
 renderBell();
 fireEvent.click(screen.getByRole('button',{name:'Notifications, 5 waiting: 2 unread and 3 open tasks'}));
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:en.notifications.markAllRead}));});
 await waitFor(()=>expect(router.refresh).toHaveBeenCalledTimes(1));
});

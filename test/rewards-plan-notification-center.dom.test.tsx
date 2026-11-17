/** Review Plans keys translate only for the native recipe kind/key pair, including action notices in the Task tab. */
import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import {NotificationCenter} from '../components/notification-center';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/notification-actions',()=>({markAllNotificationsReadAction:vi.fn(),markNotificationReadAction:vi.fn()}));
const catalogues={en,ms,zh,ta,th,vi:viMessages};
afterEach(cleanup);
it.each(['en','ms','zh','ta','th','vi'] as const)('renders the native new-company and current-approver notices in %s',locale=>{
 const messages=catalogues[locale],t=createTranslator({locale,messages,namespace:'notifications'});
 render(<NextIntlClientProvider locale={locale} messages={messages}><NotificationCenter unread={0} items={[]} taskCount={2} taskNotifications={[
  {id:'new-company',kind:'rewards.plan-company-added',title:'rewardsReviewPlans.newCompanyTitle',body:'Fictional New Company · 2027',linkPath:'/admin/rewards/review-plans?year=2027',severity:'action',readAt:null,createdAt:new Date()},
  {id:'rebound',kind:'rewards.plan-rebound',title:'rewardsReviewPlans.rebindNotificationTitle',body:'rewardsReviewPlans.rebindNotificationBody',linkPath:'/rewards/fictional-review',severity:'action',readAt:null,createdAt:new Date()},
 ]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:t('ariaBell',{total:2,unread:0,tasks:2})}));fireEvent.click(screen.getByRole('button',{name:name=>name.startsWith(messages.notifications.tabTasks)}));
 expect(screen.getByText(messages.rewardsReviewPlans.newCompanyTitle)).toBeTruthy();expect(screen.getByText('Fictional New Company · 2027')).toBeTruthy();
 expect(screen.getByText(messages.rewardsReviewPlans.rebindNotificationTitle)).toBeTruthy();expect(screen.getByText(messages.rewardsReviewPlans.rebindNotificationBody)).toBeTruthy();
 expect(screen.queryByText('rewardsReviewPlans.newCompanyTitle')).toBeNull();expect(screen.queryByText('rewardsReviewPlans.rebindNotificationBody')).toBeNull();
});
it.each([
 {kind:'unrelated.notice',title:'rewardsReviewPlans.rebindNotificationTitle',body:'rewardsReviewPlans.rebindNotificationBody'},
 {kind:'rewards.plan-rebound',title:'Custom legacy title',body:'rewardsReviewPlans.rebindNotificationBody'},
 {kind:'rewards.plan-rebound',title:'rewardsReviewPlans.rebindNotificationTitle',body:'Custom legacy body'},
 {kind:'rewards.plan-company-added',title:'Custom company notice',body:'Company · 2027'},
])('preserves stored text outside the exact recipe contract ($kind, $title)',item=>{
 render(<NextIntlClientProvider locale="en" messages={en}><NotificationCenter unread={1} items={[{...item,id:'legacy',linkPath:null,severity:'info',readAt:null,createdAt:new Date()}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Notifications, 1 waiting: 1 unread and 0 open tasks'}));expect(screen.getByText(item.title)).toBeTruthy();expect(screen.getByText(item.body)).toBeTruthy();
});

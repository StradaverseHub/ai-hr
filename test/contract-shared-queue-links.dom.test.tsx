import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import {NotificationCenter} from '../components/notification-center';
import en from '../messages/en.json';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/notification-actions',()=>({markAllNotificationsReadAction:vi.fn(),markNotificationReadAction:vi.fn()}));
afterEach(cleanup);
it('shows exact native queue totals and routes beyond the bounded bell preview to their actual owners',()=>{
 const t=createTranslator({locale:'en',messages:en,namespace:'notifications'});
 render(<NextIntlClientProvider locale="en" messages={en}><NotificationCenter unread={0} items={[]} taskCount={1250} tasks={[{id:'one-preview',kind:'contract_staff',subjectName:'Fictional employee',actionLabel:'Sign contract document',linkPath:'/lifecycle/contracts/letters/one-preview'}]} taskQueueLinks={[{href:'/tasks?contractPage=1',label:'Contract signatures',count:1000},{href:'/lifecycle/contracts/postings/work',label:'Contract posting work',count:250}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:t('ariaBell',{total:1250,unread:0,tasks:1250})}));
 fireEvent.click(screen.getByRole('button',{name:name=>name.startsWith(en.notifications.tabTasks)}));
 const queues=within(screen.getByRole('navigation',{name:'Open full task queues'}));
 expect(queues.getByRole('link',{name:/Contract signatures\s*1000/})).toHaveAttribute('href','/tasks?contractPage=1');
 expect(queues.getByRole('link',{name:/Contract posting work\s*250/})).toHaveAttribute('href','/lifecycle/contracts/postings/work');
 expect(screen.getByRole('link',{name:/Sign contract document/})).toHaveAttribute('href','/lifecycle/contracts/letters/one-preview');
});

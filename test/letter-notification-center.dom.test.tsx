import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import {NotificationCenter} from '../components/notification-center';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/notification-actions',()=>({markAllNotificationsReadAction:vi.fn(),markNotificationReadAction:vi.fn()}));
const catalogues={en,ms,zh,ta,th,vi:viMessages};
afterEach(cleanup);
it.each(['en','ms','zh','ta','th','vi'] as const)('renders the secure issued-letter notification in %s without exposing translation keys',locale=>{
 const messages=catalogues[locale],t=createTranslator({locale,messages,namespace:'notifications'});
 render(<NextIntlClientProvider locale={locale} messages={messages}><NotificationCenter unread={1} items={[{id:'fixture',kind:'letter.issued',title:'letters.notifications.issued',body:'letters.notifications.body',linkPath:'/me/letters/fixture',severity:'info',readAt:null,createdAt:new Date()}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:t('ariaBell',{total:1,unread:1,tasks:0})}));
 expect(screen.getByText(messages.letters.notifications.issued)).toBeTruthy();expect(screen.getByText(messages.letters.notifications.body)).toBeTruthy();expect(screen.queryByText('letters.notifications.issued')).toBeNull();
});

it('preserves legacy notification text when a projected item has no kind',()=>{
 render(<NextIntlClientProvider locale="en" messages={en}><NotificationCenter unread={1} items={[{id:'legacy',title:'Existing notification',body:'Existing message',linkPath:null,severity:'info',readAt:null,createdAt:new Date()}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Notifications, 1 waiting: 1 unread and 0 open tasks'}));expect(screen.getByText('Existing notification')).toBeTruthy();expect(screen.getByText('Existing message')).toBeTruthy();
});

it.each(['en','ms','zh','ta','th','vi'] as const)('renders a returned-letter task in %s through the existing bell',locale=>{
 const messages=catalogues[locale],t=createTranslator({locale,messages,namespace:'notifications'});render(<NextIntlClientProvider locale={locale} messages={messages}><NotificationCenter unread={0} items={[]} taskCount={1} taskNotifications={[{id:'creator-fixture',kind:'letter.returned',title:'letters.notifications.returned',body:'letters.notifications.body',linkPath:'/letters/generate/fixture',severity:'action',readAt:null,createdAt:new Date()}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:t('ariaBell',{total:1,unread:0,tasks:1})}));fireEvent.click(screen.getByRole('button',{name:name=>name.startsWith(messages.notifications.tabTasks)}));expect(screen.getByText(messages.letters.notifications.returned)).toBeTruthy();expect(screen.queryByText('letters.notifications.returned')).toBeNull();
});


it.each(['en','ms','zh','ta','th','vi'] as const)('renders employee acknowledgement notices without internal keys in %s',locale=>{
 const messages=catalogues[locale],t=createTranslator({locale,messages,namespace:'notifications'});render(<NextIntlClientProvider locale={locale} messages={messages}><NotificationCenter unread={2} items={(['acknowledged','signed'] as const).map(kind=>({id:kind,kind:'letter.'+kind,title:'letters.notifications.'+kind,body:'letters.notifications.body',linkPath:'/letters/register/fixture',severity:'info',readAt:null,createdAt:new Date()}))}/></NextIntlClientProvider>);fireEvent.click(screen.getByRole('button',{name:t('ariaBell',{total:2,unread:2,tasks:0})}));expect(screen.getByText(messages.letters.notifications.acknowledged)).toBeTruthy();expect(screen.getByText(messages.letters.notifications.signed)).toBeTruthy();
});


it.each(['en','ms','zh','ta','th','vi'] as const)('renders batch creation notices in %s',locale=>{
 const messages=catalogues[locale],t=createTranslator({locale,messages,namespace:'notifications'});render(<NextIntlClientProvider locale={locale} messages={messages}><NotificationCenter unread={1} items={[{id:'created',kind:'letter.created',title:'letters.notifications.created',body:'letters.notifications.body',linkPath:'/letters/generate/fixture',severity:'info',readAt:null,createdAt:new Date()}]}/></NextIntlClientProvider>);fireEvent.click(screen.getByRole('button',{name:t('ariaBell',{total:1,unread:1,tasks:0})}));expect(screen.getByText(messages.letters.notifications.created)).toBeTruthy();expect(screen.queryByText('letters.notifications.created')).toBeNull();
});

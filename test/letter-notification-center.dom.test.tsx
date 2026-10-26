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

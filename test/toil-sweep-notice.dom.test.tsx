/** The replacement-leave sweeps' completion notice renders in the reader's language through the existing bell. */
import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import {NotificationCenter} from '../components/notification-center';
import {bulkJobNoticeKeys} from '../lib/bulk-job';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/notification-actions',()=>({markAllNotificationsReadAction:vi.fn(),markNotificationReadAction:vi.fn()}));
const catalogues={en,ms,zh,ta,th,vi:viMessages};
afterEach(cleanup);
it.each((['en','ms','zh','ta','th','vi'] as const).flatMap(locale=>(['toil_expiry','toil_year_close'] as const).flatMap(kind=>(['completed','failed','cancelled'] as const).map(outcome=>[locale,kind,outcome] as const))))('renders the %s %s %s notice without exposing keys',(locale,kind,outcome)=>{
 const messages=catalogues[locale],t=createTranslator({locale,messages,namespace:'notifications'});
 const keys=bulkJobNoticeKeys(kind,outcome)!;
 expect(keys.linkPath).toBe('/admin/leave-config/leave-credit');
 render(<NextIntlClientProvider locale={locale} messages={messages}><NotificationCenter unread={1} items={[{id:'bulk-'+outcome,kind:'bulk-job.finished',title:keys.title,body:keys.body,linkPath:keys.linkPath,severity:'info',readAt:null,createdAt:new Date()}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:t('ariaBell',{total:1,unread:1,tasks:0})}));
 const copy=(messages as unknown as {bulkJobs:{notification:{toilSweep:Record<string,{title:string;body:string}>}}}).bulkJobs.notification.toilSweep[outcome];
 // Translated, not the English copy left in place.
 if(locale!=='en')expect([copy.title,copy.body]).not.toContain(en.bulkJobs.notification.toilSweep[outcome].title);
 expect(screen.getByText(copy.title)).toBeTruthy();expect(screen.getByText(copy.body)).toBeTruthy();
 expect(screen.queryByText(keys.title)).toBeNull();
});

/** The shared bulk-job completion notice renders in the reader's language through the existing bell. */
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
it.each((['en','ms','zh','ta','th','vi'] as const).flatMap(locale=>(['completed','failed','cancelled'] as const).map(outcome=>[locale,outcome] as const)))('renders the %s employee import %s notice without exposing keys',(locale,outcome)=>{
 const messages=catalogues[locale],t=createTranslator({locale,messages,namespace:'notifications'});
 const keys=bulkJobNoticeKeys('employee_import',outcome)!;
 expect(keys.linkPath).toBe('/admin/personnel/import/history');
 render(<NextIntlClientProvider locale={locale} messages={messages}><NotificationCenter unread={1} items={[{id:'bulk-'+outcome,kind:'bulk-job.finished',title:keys.title,body:keys.body,linkPath:keys.linkPath,severity:'info',readAt:null,createdAt:new Date()}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:t('ariaBell',{total:1,unread:1,tasks:0})}));
 const copy=(messages as {bulkJobs:{notification:{employeeImport:Record<string,{title:string;body:string}>}}}).bulkJobs.notification.employeeImport[outcome];
 expect(screen.getByText(copy.title)).toBeTruthy();expect(screen.getByText(copy.body)).toBeTruthy();
 expect(screen.queryByText(keys.title)).toBeNull();
});
it('shows any other text stored on a bulk-job notice as stored',()=>{
 render(<NextIntlClientProvider locale="en" messages={en}><NotificationCenter unread={1} items={[{id:'bulk-other',kind:'bulk-job.finished',title:'Background job finished',body:'Open the page where you started it to see the outcome.',linkPath:'/',severity:'info',readAt:null,createdAt:new Date()}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Notifications, 1 waiting: 1 unread and 0 open tasks'}));
 expect(screen.getByText('Background job finished')).toBeTruthy();
});
// Draft 9940: the clocking import and Recompute Attendance jobs use the same notice, with their own copy and page.
const attendanceKinds=[['clocking_import','clockingImport','/attendance/import/logs'],['attendance_recompute_preview','attendanceRecomputePreview','/attendance/recompute'],['attendance_recompute','attendanceRecompute','/attendance/recompute']] as const;
it.each((['en','ms','zh','ta','th','vi'] as const).flatMap(locale=>attendanceKinds.flatMap(kind=>(['completed','failed','cancelled'] as const).map(outcome=>[locale,kind[0],kind[1],kind[2],outcome] as const))))('renders the %s %s notice (%s) without exposing keys',(locale,kind,group,linkPath,outcome)=>{
 const messages=catalogues[locale],t=createTranslator({locale,messages,namespace:'notifications'});
 const keys=bulkJobNoticeKeys(kind,outcome)!;
 expect(keys.linkPath).toBe(linkPath);
 render(<NextIntlClientProvider locale={locale} messages={messages}><NotificationCenter unread={1} items={[{id:`bulk-${kind}-${outcome}`,kind:'bulk-job.finished',title:keys.title,body:keys.body,linkPath:keys.linkPath,severity:'info',readAt:null,createdAt:new Date()}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:t('ariaBell',{total:1,unread:1,tasks:0})}));
 const copy=(messages as unknown as {bulkJobs:{notification:Record<string,Record<string,{title:string;body:string}>>}}).bulkJobs.notification[group][outcome];
 expect(screen.getByText(copy.title)).toBeTruthy();expect(screen.getByText(copy.body)).toBeTruthy();
 expect(screen.queryByText(keys.title)).toBeNull();
});

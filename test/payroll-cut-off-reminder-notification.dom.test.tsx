/** AI v2 Phase 2 hardening (coordinator review, 4 November 2026) — the automatic payroll cut-off reminder in the reader's
 * own language. core/notifications.ts stores it as message keys (payrollReadiness.reminder.*); the bell renders them in
 * the locale the person reads in, like the greeting and letter notices. Pinned in all six locales, each expected value
 * read from that locale's own catalogue: no key leaks, Malay is not English, and the stored row never needs English. */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import {NotificationCenter} from '../components/notification-center';
import {withAiCentre} from './helpers/ai-centre-messages';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import aiEn from '../messages/ai-centre/en.json';import aiMs from '../messages/ai-centre/ms.json';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/notification-actions',()=>({markAllNotificationsReadAction:vi.fn(),markNotificationReadAction:vi.fn()}));
const catalogues={en,ms,zh,ta,th,vi:viMessages};
afterEach(cleanup);

type Reminder={title:Record<'lead5'|'lead2'|'lead1'|'soon',string>;body:Record<'own'|'approvals'|'both',string>};
const reminderOf=(messages:unknown)=>(messages as {payrollReadiness:{reminder:Reminder}}).payrollReadiness.reminder;
const notice=(title:string,body:string)=>({id:`reminder-${title}-${body}`,kind:'teras-loop.cut-off-reminder',title:`payrollReadiness.reminder.title.${title}`,
 body:`payrollReadiness.reminder.body.${body}`,linkPath:'/',severity:'action' as const,readAt:null,createdAt:new Date()});

it.each(['en','ms','zh','ta','th','vi'] as const)('renders the cut-off reminder in %s from that locale\'s own catalogue, with no key showing',locale=>{
 const messages=withAiCentre(locale,catalogues[locale] as Record<string,unknown>) as typeof en;
 const t=createTranslator({locale,messages,namespace:'notifications'});
 render(<NextIntlClientProvider locale={locale} messages={messages}><NotificationCenter unread={0} items={[]} taskCount={1} taskNotifications={[notice('lead2','both')]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:t('ariaBell',{total:1,unread:0,tasks:1})}));
 fireEvent.click(screen.getByRole('button',{name:name=>name.startsWith(messages.notifications.tabTasks)}));
 const reminder=reminderOf(messages);
 expect(screen.getByText(reminder.title.lead2)).toBeTruthy();
 expect(screen.getByText(reminder.body.both)).toBeTruthy();
 expect(screen.queryByText(/payrollReadiness\.reminder/)).toBeNull();
});

it('a Malay reader reads the reminder in Malay, never the English text',()=>{
 const messages=withAiCentre('ms',ms as Record<string,unknown>) as typeof en;
 render(<NextIntlClientProvider locale="ms" messages={messages}><NotificationCenter unread={0} items={[]} taskCount={1} taskNotifications={[notice('lead1','own')]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:createTranslator({locale:'ms',messages,namespace:'notifications'})('ariaBell',{total:1,unread:0,tasks:1})}));
 fireEvent.click(screen.getByRole('button',{name:name=>name.startsWith(messages.notifications.tabTasks)}));
 expect(screen.getByText(reminderOf(aiMs).title.lead1)).toBeTruthy();
 expect(screen.getByText(reminderOf(aiMs).body.own)).toBeTruthy();
 expect(reminderOf(aiMs).title.lead1).not.toBe(reminderOf(aiEn).title.lead1);
 expect(screen.queryByText(reminderOf(aiEn).body.own)).toBeNull();
});

it('leaves any other text as it was stored (a key outside the closed set is not translated)',()=>{
 render(<NextIntlClientProvider locale="en" messages={withAiCentre('en',en as Record<string,unknown>) as typeof en}>
  <NotificationCenter unread={1} items={[{...notice('lead5','own'),title:'payrollReadiness.reminder.title.other',severity:'info'}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Notifications, 1 waiting: 1 unread and 0 open tasks'}));
 expect(screen.getByText('payrollReadiness.reminder.title.other')).toBeTruthy();
});

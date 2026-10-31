import React from 'react';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
const m=vi.hoisted(()=>({save:vi.fn(),recipients:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:m.refresh})}));
vi.mock('../app/(app)/reports/employee-master/actions',()=>({saveMasterSchedule:m.save,masterScheduleRecipients:m.recipients}));
import {MasterReportSchedule} from '../app/(app)/reports/employee-master/MasterReportSchedule';
const catalogues={en,ms,zh,ta,th,vi:viMessages};
function view(locale:keyof typeof catalogues,enabled:boolean,available=false){const schedule={enabled,config:{frequency:'weekly' as const,day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},recipients:[],nextRunAt:enabled?'2026-10-20T01:00:00.000Z':null};return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} timeZone="Asia/Kuala_Lumpur" onError={error=>{throw error;}}><MasterReportSchedule reportId="fictional-report" version={1} canEdit asAt="2026-10-18" schedule={schedule} history={[]} scheduledEmailEnabled={available}/></NextIntlClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();m.save.mockResolvedValue({ok:true});});afterEach(cleanup);
describe('saved report scheduling hold presentation',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('explains unavailable scheduled email in %s without promising the stored next date',locale=>{view(locale,true);const t=catalogues[locale].employeeMasterReports.schedule as Record<string,unknown>;expect(typeof t.unavailable).toBe('string');expect(screen.getByRole('heading',{name:String(t.title)}).parentElement?.textContent).toContain(String(t.unavailable));expect(screen.getByLabelText(String(t.frequency)).matches(':disabled')).toBe(true);expect(screen.queryByText(/20.*2026|2026.*20/)).toBeNull();expect(m.save).not.toHaveBeenCalled();});
 it('prevents enabling while held but retains an explicit way to turn off an existing schedule',async()=>{view('en',true);const checkbox=screen.getByRole('checkbox',{name:en.employeeMasterReports.schedule.enabled}) as HTMLInputElement;expect(checkbox.checked).toBe(true);fireEvent.click(checkbox);expect(checkbox.checked).toBe(false);expect(checkbox.disabled).toBe(true);fireEvent.click(screen.getByRole('button',{name:en.employeeMasterReports.schedule.save}));await waitFor(()=>expect(m.save).toHaveBeenCalledWith(expect.objectContaining({enabled:false})));});
 it('starts unavailable schedules with the enable checkbox disabled, while explicit capability restores the ordinary editor',()=>{const first=view('en',false);expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);first.unmount();view('en',false,true);expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);expect(screen.getByLabelText(en.employeeMasterReports.schedule.frequency).matches(':disabled')).toBe(false);});
});

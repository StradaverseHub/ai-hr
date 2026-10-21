import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeHomeToday} from '../lib/employee-home-today';
const state=vi.hoisted(()=>({mounted:vi.fn()}));
vi.mock('next/dynamic',()=>({default:()=>function ClockOwner(props:{employmentId:string;initialAction:string;onSaved:(receipt:{direction:'in'|'out';recordedAt:string})=>void;onBusyChange:(busy:boolean)=>void}){
 React.useEffect(()=>{state.mounted(props);},[props]);
 return <><button onClick={()=>props.onBusyChange(true)}>Simulate uncertain submission</button><button onClick={()=>{props.onBusyChange(false);props.onSaved({direction:'in',recordedAt:new Date().toISOString()});}}>Confirm canonical receipt</button></>;
}}));
import {HomeTodayCard} from '../components/employee-home/today-card';
const catalogues={en,ms,zh,ta,th,vi:viMessages},fetcher=vi.fn(),date=todayInKualaLumpur();
let data:EmployeeHomeToday;
function view(locale:keyof typeof catalogues='en'){return <NextIntlClientProvider locale={locale} messages={catalogues[locale]} timeZone="Asia/Kuala_Lumpur" onError={error=>{throw error;}}><HomeTodayCard employmentId="own" employmentLabel="Fictional second employer" timeZone="Asia/Kuala_Lumpur"/></NextIntlClientProvider>;}
beforeEach(()=>{vi.clearAllMocks();data={version:1,employmentId:'own',serverNow:new Date().toISOString(),businessDate:date,attendanceEnabled:true,payrollEnabled:true,clock:{date,clockedIn:false,openSince:null,workedSeconds:0,crossesMidnight:false,shift:{code:'SF',start:'09:00',end:'18:00'},geofencingRequired:false,photoRequired:false},dayKind:'workday',leavePresence:null,workLocations:{total:1,names:['Fictional HQ']},payday:{date,daysAway:0}};
 fetcher.mockImplementation(async(url:string)=>Response.json(url.startsWith('/api/home/today')?data:{...data.clock,serverNow:data.serverNow,clockContext:'context',removalBaseline:'baseline',locationValid:true,attendancePhotoSetting:'not_required',captures:[],legacy:[]}));vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('Your Day Home card',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders real %s copy without loading clock commands at mount',async locale=>{
  render(view(locale));expect(await screen.findByText('Fictional HQ')).toBeTruthy();expect(screen.getByRole('button',{name:catalogues[locale].attendance.clock.clockIn})).toBeTruthy();
  expect(state.mounted).not.toHaveBeenCalled();expect(fetcher.mock.calls.every(([url])=>String(url).startsWith('/api/home/today?'))).toBe(true);expect(screen.getByRole('link',{name:catalogues[locale].employeeHome.today.correction}).getAttribute('href')).toContain('employmentId=own&home=1');
 });
 it('opens the canonical selected flow only after an explicit press and shows success only after its receipt',async()=>{
  render(view());fireEvent.click(await screen.findByRole('button',{name:en.attendance.clock.clockIn}));
  expect(await screen.findByRole('dialog')).toBeTruthy();await waitFor(()=>expect(state.mounted).toHaveBeenCalled());
  expect(state.mounted.mock.calls[0][0]).toMatchObject({employmentId:'own',initialAction:'in'});expect(screen.queryByText(/Clocked in at/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Confirm canonical receipt'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('status').textContent).toContain('Clocked in');
  await waitFor(()=>expect(document.activeElement?.tagName).toBe('BUTTON'));
 });
 it('keeps an uncertain canonical submission open through Escape and disables closing',async()=>{
  render(view());fireEvent.click(await screen.findByRole('button',{name:en.attendance.clock.clockIn}));fireEvent.click(await screen.findByRole('button',{name:'Simulate uncertain submission'}));
  expect((screen.getByRole('button',{name:'Close'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape',code:'Escape'});expect(screen.getByRole('dialog')).toBeTruthy();
 });
 it('suppresses an unnecessary clock-in for full leave but keeps clock-out for an open shift',async()=>{
  data.leavePresence='full_day';const mounted=render(view());await screen.findByText(en.employeeHome.today.leaveDayOff);expect(screen.queryByRole('button',{name:en.attendance.clock.clockIn})).toBeNull();mounted.unmount();
  data.clock={...data.clock!,clockedIn:true,openSince:data.serverNow,crossesMidnight:true};render(view());expect(await screen.findByRole('button',{name:en.attendance.clock.clockOut})).toBeTruthy();expect(screen.getByText(en.employeeHome.today.overnight)).toBeTruthy();
 });
 it('keeps a failed card independent and retries its read',async()=>{
  fetcher.mockResolvedValueOnce(new Response('',{status:503}));render(view());expect(await screen.findByRole('alert')).toHaveTextContent(en.employeeHome.today.failed);fireEvent.click(screen.getByRole('button',{name:'Retry: Your Day'}));expect(await screen.findByText('Fictional HQ')).toBeTruthy();expect(state.mounted).not.toHaveBeenCalled();
 });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
const state=vi.hoisted(()=>({locale:'en',view:vi.fn()}));
const catalogue=()=>JSON.parse(readFileSync(new URL(`../messages/${state.locale}.json`,import.meta.url),'utf8'));
vi.mock('next-intl/server',()=>({getLocale:async()=>state.locale,getTranslations:async(namespace:string)=>createTranslator({locale:state.locale,namespace,messages:catalogue()})}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{personId:'self'}})}));
vi.mock('../lib/authz',()=>({requireModule:async()=>undefined}));
vi.mock('../app/(app)/attendance/my-roster/record-list',()=>({AttendanceRecordList:()=>null}));
vi.mock('../packs/attendance/service',()=>({myAttendanceCalendarWindow:state.view}));
vi.mock('../db/client',()=>({withTenant:async(_ctx:unknown,run:(tx:unknown)=>unknown)=>run({})}));
vi.mock('../core/holidays',()=>({originalHolidayCalendarFor:async()=>[]}));
vi.mock('../core/holiday-replacement-read',()=>({replacementHolidayCalendarContext:async()=>[]}));
import Page from '../app/(app)/attendance/my-roster/page';
const fixture=()=>({employmentId:'own',name:'Fictional employee',employeeCode:'CAL01',position:'Analyst',managerName:'Fictional manager',from:'2026-03-16',to:'2026-03-18',legend:[],workDays:2,rosteredDays:1,restDays:1,plannedMinutes:960,lastUpdatedAt:null,days:[
  {date:'2026-03-16',cell:{kind:'shift',shiftId:'day'},shift:{id:'day',code:'DAY',name:'Long daytime shift',startTime:'09:00',endTime:'18:00',breakMinutes:60,workingMinutes:480,color:null},note:null,plannedMinutes:480,attendance:{status:'present',flag:'odd',checkInAt:'09:00',checkOutAt:null}},
  {date:'2026-03-17',cell:{kind:'rest'},shift:null,note:'Retained supervisor note',plannedMinutes:0,attendance:{status:'rest',flag:null,checkInAt:null,checkOutAt:null}},
  {date:'2026-03-18',cell:{kind:'off'},shift:null,note:null,plannedMinutes:0,attendance:{status:'on_leave',flag:null,checkInAt:null,checkOutAt:null}},
]});
beforeEach(()=>{vi.clearAllMocks();state.locale='en';state.view.mockResolvedValue(fixture());});
const render=async(view='month')=>renderToStaticMarkup(createElement(NextIntlClientProvider,{locale:state.locale,messages:catalogue(),children:await Page({searchParams:Promise.resolve({view,month:'2026-03',date:'2026-03-16',selected:'2026-03-17'})})}));
describe('Attendance Calendar rendering',()=>{
  it.each(['en','ms','zh','ta','th','vi'])('renders saved roster and attendance facts with reachable details in %s',async locale=>{
    state.locale=locale;const html=await render(),m=catalogue();
    expect(html).toContain(m.attendance.myCalendar.title);
    expect(html).toContain(m.attendance.statusPresent);
    expect(html).toContain(m.attendance.myCalendar.incompleteEntry);
    expect(html).toContain(m.attendance.statusOnLeave);
    expect(html).toContain('DAY');expect(html).toContain('09:00');
    expect(html).toContain('/attendance/my-records/2026-03-16?calendar=1');
    expect(html).toContain('tab=list');
    expect(html).toContain('from=2026-03-01');
    expect(html).toContain('to=2026-03-31');
    expect(html).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
    expect(html).not.toContain('aria-current="date"'); // selected March date is not today
  });
  it.each(['week','day'])('retains %s roster information and a daily attendance action',async view=>{
    const html=await render(view);expect(html).toContain('/attendance/my-records/2026-03-16?calendar=1');
    expect(html).toContain('DAY');expect(html).toContain('09:00');
  });
  it('names the missing employment instead of borrowing another employee',async()=>{
    state.view.mockResolvedValue(null);const html=await render();expect(html).toContain(catalogue().attendance.myRoster.notLinked);expect(html).not.toContain('/attendance/my-records/');
  });
});

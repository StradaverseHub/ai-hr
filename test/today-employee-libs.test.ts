/** Employee Today (owner decision, 11 Nov 2026): the pure rules behind the one-pager. Every expected value is written
 * out literally from a fictional calendar (November 2026: the 1st is a Sunday, the 11th a Wednesday), never re-derived
 * from the helpers under test. */
import {describe,expect,it} from 'vitest';
import {addCalendarDays,calendarDaysBetween,calendarMonthDays,isoWeekdayOf} from '../lib/hr-date-calendar';
import {buildMonthCalendar} from '../lib/today/month-calendar';
import {comingUp,dayRuns,deciderOf,employeePanels,isAllClear,isEmployeeOnlyAudience,nextStepsFrom,orderNextSteps,orderRequests,panelVisibility,
 paydayView,trackSteps,waitingDays,weekHours,weekOf,type NextStep,type TrackedRequest} from '../lib/today/employee';
import type {PayrollItem} from '../lib/pre-salary/items';

const TODAY='2026-11-11';

describe('HR calendar days (lib/hr-date-calendar.ts)',()=>{
 it('adds and counts calendar days across month and year ends',()=>{
  expect(addCalendarDays('2026-11-30',1)).toBe('2026-12-01');
  expect(addCalendarDays('2026-12-31',1)).toBe('2027-01-01');
  expect(addCalendarDays('2028-03-01',-1)).toBe('2028-02-29');
  expect(calendarDaysBetween('2026-11-11','2026-11-27')).toBe(16);
  expect(calendarDaysBetween('2026-11-27','2026-11-11')).toBe(-16);
 });
 it('names ISO weekdays, Monday 1 to Sunday 7',()=>{
  expect(isoWeekdayOf('2026-11-09')).toBe(1);
  expect(isoWeekdayOf('2026-11-11')).toBe(3);
  expect(isoWeekdayOf('2026-11-01')).toBe(7);
 });
 it('lists a month day by day, leap February included, and refuses non-dates',()=>{
  expect(calendarMonthDays('2026-11')).toHaveLength(30);
  expect(calendarMonthDays('2028-02').at(-1)).toBe('2028-02-29');
  expect(calendarMonthDays('2026-02').at(-1)).toBe('2026-02-28');
  expect(()=>calendarMonthDays('2026-13')).toThrow();
  expect(()=>addCalendarDays('2026-02-30',1)).toThrow();
 });
});

describe('month calendar (lib/today/month-calendar.ts)',()=>{
 it('lays November 2026 out Monday first in whole weeks, with six blanks before Sunday the 1st',()=>{
  const grid=buildMonthCalendar(TODAY);
  expect(grid.month).toBe('2026-11');
  expect(grid.weeks).toHaveLength(6);
  expect(grid.weeks.every(week=>week.length===7)).toBe(true);
  expect(grid.weeks[0].map(cell=>cell.date)).toEqual([null,null,null,null,null,null,'2026-11-01']);
  expect(grid.weeks[5].map(cell=>cell.date)).toEqual(['2026-11-30',null,null,null,null,null,null]);
  const cells=grid.weeks.flat().filter(cell=>cell.date);
  expect(cells).toHaveLength(30);
  expect(cells.filter(cell=>cell.today).map(cell=>cell.date)).toEqual(['2026-11-11']);
  expect(cells.filter(cell=>cell.past)).toHaveLength(10);
  expect(cells.find(cell=>cell.date==='2026-11-14')).toMatchObject({day:14,weekend:true});
  expect(cells.find(cell=>cell.date==='2026-11-13')).toMatchObject({day:13,weekend:false});
 });
 it('marks each fact on its day once, in the fixed mark order, whatever order the facts arrive in, and drops other months',()=>{
  const facts=[{date:'2026-11-25',mark:'cutoff'},{date:'2026-11-27',mark:'payday'},{date:'2026-11-13',mark:'due'},{date:'2026-11-06',mark:'fix'},
   {date:'2026-11-13',mark:'holiday'},{date:'2026-11-13',mark:'due'},{date:'2026-12-25',mark:'holiday'},{date:'2026-11-25',mark:'due'}] as const;
  const marks=(grid:ReturnType<typeof buildMonthCalendar>)=>Object.fromEntries(grid.weeks.flat().filter(cell=>cell.date&&cell.marks.length).map(cell=>[cell.date,cell.marks]));
  const expected={'2026-11-06':['fix'],'2026-11-13':['due','holiday'],'2026-11-25':['cutoff','due'],'2026-11-27':['payday']};
  expect(marks(buildMonthCalendar(TODAY,facts))).toEqual(expected);
  expect(marks(buildMonthCalendar(TODAY,[...facts].reverse()))).toEqual(expected);
 });
 it('starts a month that opens on a Monday with no blank (February 2027)',()=>{
  expect(buildMonthCalendar('2027-02-10').weeks[0][0].date).toBe('2027-02-01');
  expect(buildMonthCalendar('2027-02-10').weeks).toHaveLength(4);
 });
});

const item=(p:Partial<PayrollItem>&Pick<PayrollItem,'key'|'kind'|'group'>):PayrollItem=>({state:'todo',date:null,due:null,action:{kind:'open',href:`/fix/${p.key}`},...p}) as PayrollItem;
const step=(p:Partial<NextStep>&Pick<NextStep,'key'|'kind'>):NextStep=>({due:null,date:null,href:'/',decider:deciderOf(p.kind),...p});

describe('Next step and Then: order and senders',()=>{
 it('orders by due date, then by consequence, then by the day it is about, then by key',()=>{
  const shuffled=[
   step({key:'ack',kind:'letter_acknowledge',due:'2026-11-25'}),
   step({key:'claim',kind:'claim_draft',due:'2026-11-25'}),
   step({key:'epf',kind:'epf_number_missing',due:'2026-11-25'}),
   step({key:'clock-b',kind:'missed_clock_out',due:'2026-11-20',date:'2026-11-06'}),
   step({key:'clock-a',kind:'missed_clock_out',due:'2026-11-20',date:'2026-11-05'}),
   step({key:'none',kind:'notice_acknowledge',due:null}),
   step({key:'tax',kind:'tax_number_missing',due:'2026-11-25'}),
   step({key:'soon',kind:'review_acknowledge',due:'2026-11-13'}),
  ];
  const expected=['soon','clock-a','clock-b','epf','tax','claim','ack','none'];
  expect(orderNextSteps(shuffled).map(row=>row.key)).toEqual(expected);
  expect(orderNextSteps([...shuffled].reverse()).map(row=>row.key)).toEqual(expected);
 });
 it('takes only the person\'s own to-dos and adds each expiring passport, due on its expiry day',()=>{
  const steps=nextStepsFrom([
   item({key:'tax',kind:'tax_number_missing',group:'details',due:'2026-11-25'}),
   item({key:'unpaid',kind:'leave_unpaid',group:'leave',state:'check',due:'2026-11-20'}),
   item({key:'pending',kind:'leave_pending',group:'leave',state:'waiting',due:'2026-11-20'}),
   item({key:'approve',kind:'approve_leave',group:'approvals',due:'2026-11-20'}),
   item({key:'clock',kind:'missed_clock_out',group:'attendance',date:'2026-11-06',due:'2026-11-20'}),
  ],[{caseId:'case-1',expiresOn:'2026-12-01',href:'/me?tab=profile'}]);
  expect(steps.map(row=>[row.key,row.decider,row.due])).toEqual([
   ['clock','manager','2026-11-20'],['tax','hr','2026-11-25'],['passport_renew:case-1','hr','2026-12-01']]);
  expect(steps[0].href).toBe('/fix/clock');
 });
 it('sends record details to HR, attendance days to the manager, and leaves the rest to the person',()=>{
  expect(['bank_missing','tax_number_missing','epf_number_missing','socso_number_missing','identity_missing','tp1_draft','passport_renew'].map(kind=>deciderOf(kind as never))).toEqual(Array(7).fill('hr'));
  expect(['missed_clock_out','missed_clock_in','absent_no_leave'].map(kind=>deciderOf(kind as never))).toEqual(['manager','manager','manager']);
  expect(deciderOf('letter_acknowledge')).toBe('you');
  expect(deciderOf('claim_draft')).toBe('you');
 });
 it('is all clear only when every source was read and nothing is left',()=>{
  expect(isAllClear({steps:[],failed:false})).toBe(true);
  expect(isAllClear({steps:[],failed:true})).toBe(false);
  expect(isAllClear({steps:[step({key:'x',kind:'claim_draft'})],failed:false})).toBe(false);
 });
});

describe('panel visibility',()=>{
 it('hides a module\'s panel entirely when the module is not in use, and says so when its entitlement could not be read',()=>{
  expect(panelVisibility('on')).toBe('show');
  expect(panelVisibility('off')).toBe('hide');
  expect(panelVisibility('failed')).toBe('unavailable');
  expect(employeePanels({payroll:'on',leave:'on',attendance:'off'})).toEqual({payday:'show',leave:'show',hours:'hide'});
  expect(employeePanels({payroll:'off',leave:'failed',attendance:'on'})).toEqual({payday:'hide',leave:'unavailable',hours:'show'});
 });
 it('draws Employee Today for an employee only',()=>{
  expect(isEmployeeOnlyAudience(['employee'],false)).toBe(true);
  expect(isEmployeeOnlyAudience([],false)).toBe(true);
  expect(isEmployeeOnlyAudience(undefined,false)).toBe(true);
  expect(isEmployeeOnlyAudience(['employee','manager'],false)).toBe(false);
  expect(isEmployeeOnlyAudience(['payroll_partner'],false)).toBe(false);
  expect(isEmployeeOnlyAudience(['performance_comp_partner'],false)).toBe(false);
  expect(isEmployeeOnlyAudience(['performance_partner'],false)).toBe(false);
  expect(isEmployeeOnlyAudience(['employee'],true)).toBe(false);
 });
});

describe('Payday',()=>{
 it('shows the recorded payday when there is one, else the cut-off, and never a past date',()=>{
  expect(paydayView(TODAY,'2026-11-27','2026-11-25')).toEqual({kind:'payday',date:'2026-11-27',daysAway:16});
  expect(paydayView(TODAY,null,'2026-11-25')).toEqual({kind:'cutoff',date:'2026-11-25',daysAway:14});
  expect(paydayView(TODAY,'2026-10-27','2026-11-25')).toEqual({kind:'cutoff',date:'2026-11-25',daysAway:14});
  expect(paydayView(TODAY,null,'2026-11-10')).toBeNull();
  expect(paydayView(TODAY,TODAY,null)).toEqual({kind:'payday',date:TODAY,daysAway:0});
 });
});

describe('This week\'s hours',()=>{
 it('runs Monday to Sunday of the week holding today',()=>{
  expect(weekOf(TODAY)).toEqual(['2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13','2026-11-14','2026-11-15']);
  expect(weekOf('2026-11-15')[0]).toBe('2026-11-09');
  expect(weekOf('2026-11-16')[0]).toBe('2026-11-16');
 });
 it('sums only the minutes the attendance owner counted, shows today running, and leaves out an unscheduled weekend',()=>{
  const week=weekHours(TODAY,[
   {date:'2026-11-09',workedMinutes:521,scheduledMinutes:540,checkInAt:'x',checkOutAt:'y'},
   {date:'2026-11-10',workedMinutes:485,scheduledMinutes:540,checkInAt:'x',checkOutAt:'y'},
   {date:'2026-11-11',workedMinutes:null,scheduledMinutes:540,checkInAt:'x',checkOutAt:null},
   {date:'2026-11-12',workedMinutes:null,scheduledMinutes:540,checkInAt:null,checkOutAt:null},
   {date:'2026-11-13',workedMinutes:null,scheduledMinutes:540,checkInAt:null,checkOutAt:null},
   {date:'2026-11-14',workedMinutes:null,scheduledMinutes:null,checkInAt:null,checkOutAt:null},
  ]);
  expect(week.bars.map(bar=>[bar.date,bar.state])).toEqual([['2026-11-09','worked'],['2026-11-10','worked'],['2026-11-11','running'],['2026-11-12','upcoming'],['2026-11-13','upcoming']]);
  expect(week.workedMinutes).toBe(1006);
  expect(week.shiftMinutes).toBe(540);
 });
 it('keeps a worked weekend day and marks a scheduled day gone by with nothing recorded',()=>{
  const week=weekHours('2026-11-15',[{date:'2026-11-09',workedMinutes:null,scheduledMinutes:540,checkInAt:null,checkOutAt:null},
   {date:'2026-11-14',workedMinutes:240,scheduledMinutes:null,checkInAt:'x',checkOutAt:'y'}]);
  expect(week.bars.map(bar=>[bar.date,bar.state])).toEqual([['2026-11-09','none'],['2026-11-10','none'],['2026-11-11','none'],['2026-11-12','none'],['2026-11-13','none'],['2026-11-14','worked']]);
  expect(week.workedMinutes).toBe(240);
 });
});

describe('request tracker',()=>{
 const request=(p:Partial<TrackedRequest>&Pick<TrackedRequest,'key'|'stage'|'sent'>):TrackedRequest=>({kind:'leave',label:'Annual Leave',href:'/leave',...p});
 it('draws three steps for every stage',()=>{
  expect(trackSteps('waiting').map(row=>row.state)).toEqual(['done','current','todo']);
  expect(trackSteps('preparing').map(row=>row.state)).toEqual(['done','current','todo']);
  expect(trackSteps('approved').map(row=>row.state)).toEqual(['done','done','done']);
  expect(trackSteps('ready').map(row=>row.state)).toEqual(['done','done','done']);
  expect(trackSteps('declined').map(row=>row.state)).toEqual(['done','done','declined']);
 });
 it('lists open requests first, then the most recently sent, at most four',()=>{
  const rows=[request({key:'a',stage:'approved',sent:'2026-11-10'}),request({key:'b',stage:'waiting',sent:'2026-11-01'}),
   request({key:'c',stage:'preparing',sent:'2026-11-05',kind:'letter'}),request({key:'d',stage:'declined',sent:'2026-11-09'}),request({key:'e',stage:'ready',sent:'2026-10-01'})];
  expect(orderRequests(rows).map(row=>row.key)).toEqual(['c','b','a','d']);
  expect(orderRequests([...rows].reverse()).map(row=>row.key)).toEqual(['c','b','a','d']);
 });
 it('counts whole days waited',()=>{
  expect(waitingDays(TODAY,'2026-11-09')).toBe(2);
  expect(waitingDays(TODAY,TODAY)).toBe(0);
 });
});

describe('Coming up',()=>{
 it('joins consecutive days into runs',()=>{
  expect(dayRuns(['2026-12-03','2026-12-02','2026-12-05','2026-12-02'])).toEqual([{from:'2026-12-02',to:'2026-12-03'},{from:'2026-12-05',to:'2026-12-05'}]);
 });
 it('lists what is still to come, soonest first, cut-off before payday on the same day, at most four',()=>{
  const items=comingUp(TODAY,{cutOff:'2026-11-25',payday:'2026-11-27',leaveDates:['2026-11-10','2026-11-11','2026-11-12','2026-12-02'],
   holidays:[{date:'2026-11-08',name:'Deepavali'},{date:'2026-12-25',name:'Christmas Day'},{date:'2026-12-25',name:'Christmas Day'}],
   managerAway:[{from:'2026-11-25',to:'2026-11-26',name:'Daniel Tan'}]});
  expect(items.map(row=>[row.date,row.endDate,row.kind,row.name])).toEqual([
   ['2026-11-11','2026-11-12','leave',null],['2026-11-25','2026-11-25','cutoff',null],['2026-11-25','2026-11-26','managerAway','Daniel Tan'],['2026-11-27','2026-11-27','payday',null]]);
  expect(comingUp(TODAY,{holidays:[{date:'2026-12-25',name:'Christmas Day'},{date:'2026-12-25',name:'Christmas Day'}]},10)).toHaveLength(1);
  expect(comingUp(TODAY,{cutOff:'2026-11-10',payday:null})).toEqual([]);
 });
});

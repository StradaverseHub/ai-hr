import React from 'react';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {AttendanceDateSchedule} from '../components/attendance-day-editor';
import {AttendanceHistoryTable} from '../components/attendance-history-table';
const calls=vi.hoisted(()=>({save:vi.fn(),composite:vi.fn(),refresh:vi.fn(),bulk:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:calls.refresh})}));
vi.mock('next/link',()=>({default:({children,...p}:React.ComponentProps<'a'>)=><a {...p}>{children}</a>}));
vi.mock('../app/attendance/individual/[date]/actions',()=>({saveAttendanceDayScheduleAction:calls.save,saveAttendanceDayChangesAction:calls.composite,adminCorrectAttendanceDayAction:vi.fn(),rejectAttendanceDayApplicationAction:vi.fn()}));
vi.mock('../app/attendance/application-history/actions',()=>({attendanceHistoryBulkAction:calls.bulk}));
const data={baseline:'baseline',shiftId:'first',dayKind:'workday',closed:false,self:false,processed:false,leave:[],schedule:{shiftCode:'DAY',dayKind:'workday'},shifts:[{id:'first',code:'DAY',name:'Day'},{id:'second',code:'LATE',name:'Late'}]} as unknown as React.ComponentProps<typeof AttendanceDateSchedule>['data'];
const wrap=(children:React.ReactNode)=><NextIntlClientProvider locale="en" messages={en}>{children}</NextIntlClientProvider>;
const edit=()=>fireEvent.click(screen.getByRole('button',{name:'Edit'}));
beforeEach(()=>{vi.clearAllMocks();calls.save.mockResolvedValue({ok:true});calls.bulk.mockResolvedValue([{id:'a',status:'pending'},{id:'b',status:'failed',message:'The approval stage changed.'}]);});afterEach(cleanup);
it('opens a deliberate schedule edit, discards cancel, retains validation errors, and reopens saved props',async()=>{
  const ui=render(wrap(<AttendanceDateSchedule data={data} employmentId="employee" date="2026-10-01"/>));
  expect(screen.queryByRole('combobox')).toBeNull();edit();
  fireEvent.change(screen.getByLabelText(en.attendance.dayEdit.shift),{target:{value:'second'}});
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(calls.save).not.toHaveBeenCalled();expect(calls.composite).not.toHaveBeenCalled();
  edit();expect(screen.getByLabelText(en.attendance.dayEdit.shift)).toHaveValue('first');
  calls.save.mockResolvedValueOnce({ok:false,message:'Clock data changed. Reload the day.'});
  fireEvent.change(screen.getByLabelText(en.attendance.dayEdit.reason),{target:{value:'Verified correction'}});
  fireEvent.submit(document.querySelector('form')!);
  await screen.findByText('Clock data changed. Reload the day.');expect(screen.getByRole('dialog')).toBeVisible();expect(calls.save).toHaveBeenCalledTimes(1);expect(calls.composite).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(en.attendance.dayEdit.shift),{target:{value:'second'}});fireEvent.submit(document.querySelector('form')!);
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  ui.rerender(wrap(<AttendanceDateSchedule data={{...data,shiftId:'second',baseline:'new'}} employmentId="employee" date="2026-10-01"/>));edit();expect(screen.getByLabelText(en.attendance.dayEdit.shift)).toHaveValue('second');
  const payload=calls.save.mock.calls[1][0] as FormData;expect(payload.get('employmentId')).toBe('employee');expect(payload.get('date')).toBe('2026-10-01');expect(payload.get('baseline')).toBe('baseline');expect(payload.get('kind')).toBe('schedule');expect(payload.get('shiftId')).toBe('second');expect(payload.get('dayKind')).toBe('workday');expect(payload.get('reason')).toBe('Verified correction');expect(payload.has('rows')).toBe(false);expect(payload.has('clockChanges')).toBe(false);expect(calls.save).toHaveBeenCalledTimes(2);expect(calls.composite).not.toHaveBeenCalled();expect(calls.refresh).toHaveBeenCalledTimes(1);
});
it('protects Leave ownership and disables editing a closed or self day',()=>{
  const ui=render(wrap(<AttendanceDateSchedule data={{...data,closed:true}} employmentId="employee" date="2026-10-01"/>));expect(screen.getByRole('button',{name:'Edit'})).toBeDisabled();
  ui.rerender(wrap(<AttendanceDateSchedule data={{...data,leave:[{name:'Annual Leave',duration:'full_day'}] as typeof data.leave}} employmentId="employee" date="2026-10-01"/>));edit();expect(screen.getByLabelText(en.attendance.dayEdit.dayType)).toBeDisabled();expect(screen.getByText(en.attendance.dayEdit.leaveOwner)).toBeVisible();
});
const row=(id:string,selectable=true)=>({id,employmentId:id,employee:'Employee '+id,employeeCode:id,company:'Example Company',companyId:'company',attendanceDate:'2026-10-01',submittedAt:new Date(),status:'pending',applicationType:'irregularity',requestKind:'absent',currentStage:0,stages:null,templateName:null,selectable}) as React.ComponentProps<typeof AttendanceHistoryTable>['rows'][number];
it('selects only eligible page rows, confirms, reports mixed outcomes, and preserves the filtered return link',async()=>{
  const ui=render(wrap(<AttendanceHistoryTable rows={[row('a'),row('b'),row('self',false)]} returnTo="/attendance/application-history?status=pending&page=2"/>));
  expect(screen.queryByRole('columnheader',{name:en.attendanceHistory.reference})).toBeNull();expect(screen.getAllByText('01-Oct-2026')).toHaveLength(3);
  fireEvent.click(screen.getByRole('checkbox',{name:en.attendanceHistory.selectPage}));expect(screen.getByText('2 selected')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:en.attendanceHistory.approveSelected}));expect(calls.bulk).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Confirm'}));await screen.findByText(en.attendanceHistory.furtherApproval,{exact:false});
  expect(calls.bulk).toHaveBeenCalledWith({items:[{id:'a',stage:0},{id:'b',stage:0}],decision:'approved',reason:''});expect(screen.getByText('The approval stage changed.',{exact:false})).toBeVisible();
  expect(screen.getAllByRole('link',{name:en.attendanceHistory.view})[0].getAttribute('href')).toContain('returnTo=%2Fattendance%2Fapplication-history%3Fstatus%3Dpending%26page%3D2');
  ui.rerender(wrap(<AttendanceHistoryTable rows={[]} returnTo="/attendance/application-history?status=pending&page=2"/>));
  expect(screen.getByText('Employee a · 01-Oct-2026 · '+en.attendanceHistory.furtherApproval)).toBeVisible();
});
it('requires rejection remarks and does not submit when cancelled',()=>{
  render(wrap(<AttendanceHistoryTable rows={[row('a')]} returnTo="/attendance/application-history"/>));fireEvent.click(screen.getByRole('checkbox',{name:en.attendanceHistory.selectPage}));fireEvent.click(screen.getByRole('button',{name:en.attendanceHistory.rejectSelected}));expect(screen.getByRole('textbox')).toBeRequired();fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(calls.bulk).not.toHaveBeenCalled();
});

it('submits the stage observed when selected even if a refreshed row has advanced',async()=>{
  const ui=render(wrap(<AttendanceHistoryTable rows={[row('a')]} returnTo="/attendance/application-history"/>));
  fireEvent.click(screen.getByRole('checkbox',{name:en.attendanceHistory.selectPage}));
  ui.rerender(wrap(<AttendanceHistoryTable rows={[{...row('a'),currentStage:1}]} returnTo="/attendance/application-history"/>));
  fireEvent.click(screen.getByRole('button',{name:en.attendanceHistory.approveSelected}));
  expect(screen.getByRole('dialog')).toHaveTextContent('Employee a · 01-Oct-2026');
  fireEvent.click(screen.getByRole('button',{name:'Confirm'}));
  await waitFor(()=>expect(calls.bulk).toHaveBeenCalledWith({items:[{id:'a',stage:0}],decision:'approved',reason:''}));
});

it('submits the participant observed when selected even if a refreshed row changes within the same level',async()=>{
  const ui=render(wrap(<AttendanceHistoryTable rows={[{...row('a'),currentParticipantSlot:'0:0'}]} returnTo="/attendance/application-history"/>));
  fireEvent.click(screen.getByRole('checkbox',{name:en.attendanceHistory.selectPage}));
  ui.rerender(wrap(<AttendanceHistoryTable rows={[{...row('a'),currentParticipantSlot:'0:1'}]} returnTo="/attendance/application-history"/>));
  fireEvent.click(screen.getByRole('button',{name:en.attendanceHistory.approveSelected}));
  fireEvent.click(screen.getByRole('button',{name:'Confirm'}));
  await waitFor(()=>expect(calls.bulk).toHaveBeenCalledWith({items:[{id:'a',stage:0,participantSlot:'0:0'}],decision:'approved',reason:''}));
});

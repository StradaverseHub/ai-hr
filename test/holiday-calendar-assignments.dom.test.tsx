import React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {TabSaveScope} from '../components/tab-save-scope';
import {__resetUnsavedGuards} from '../lib/unsaved-changes';
import en from '../messages/en.json';
import {HolidayCalendarAssignments} from '../app/(app)/admin/personnel/[employmentId]/holiday-calendar-assignments';
const state=vi.hoisted(()=>({save:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:state.refresh})}));
vi.mock('../app/(app)/admin/personnel/[employmentId]/holiday-calendar-actions',()=>({saveHolidayCalendarAssignmentAction:state.save}));
afterEach(()=>{cleanup();__resetUnsavedGuards();});beforeEach(()=>{state.save.mockReset();state.refresh.mockReset();});
const base={employmentId:'employee',joinDate:'2025-04-05',employmentStartDate:'2025-04-01',fallbackLabel:'Selangor',groups:[{id:'group',name:'Recorded Calendar',active:true},{id:'old',name:'Inactive Calendar',active:false}],states:['Selangor','Johor'],rows:[]};
const mount=(overrides:Partial<React.ComponentProps<typeof HolidayCalendarAssignments>>={})=>render(<NextIntlClientProvider locale="en" messages={en}><HolidayCalendarAssignments {...base} {...overrides}/></NextIntlClientProvider>);
describe('dated holiday calendar input and history',()=>{
 it('renders the declared workflow facts and updates the end minimum without changing posted names',()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:'Add calendar'}));
  const calendar=screen.getByLabelText('Calendar'),start=screen.getByLabelText(/^Start Date/),end=screen.getByLabelText('End Date');
  expect(calendar).toHaveAttribute('data-personnel-field','attendance.dated_holiday_calendar.calendar');
  expect(calendar).toHaveAttribute('name','calendar');
  expect(start).toHaveAttribute('data-personnel-field','attendance.dated_holiday_calendar.startdate');
  expect(start).toHaveAttribute('name','startDate');expect(start).toHaveAttribute('type','date');
  expect(start).toBeRequired();expect(start).toHaveAttribute('min',base.employmentStartDate);
  expect(end).toHaveAttribute('data-personnel-field','attendance.dated_holiday_calendar.enddate');
  expect(end).toHaveAttribute('name','endDate');expect(end).toHaveAttribute('type','date');
  expect(end).not.toBeRequired();expect(end).toHaveAttribute('min',base.joinDate);
  fireEvent.change(start,{target:{value:'2025-04-09'}});
  expect(end).toHaveAttribute('min','2025-04-09');expect(end).toHaveValue('');
  expect(start).toHaveAttribute('min',base.employmentStartDate);
  expect(new FormData(screen.getByRole('form',{name:'Add calendar'}) as HTMLFormElement).get('startDate')).toBe('2025-04-09');
  expect(state.save).not.toHaveBeenCalled();
 });
 it('defaults to recorded Join Date, leaves an optional end blank, and cancel makes no call',()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:'Add calendar'}));
  expect(screen.getByLabelText(/^Start Date/)).toHaveValue(base.joinDate);
  expect(screen.getByLabelText(/^Start Date/)).toHaveAttribute('min',base.employmentStartDate);
  expect(screen.getByLabelText('End Date')).toHaveValue('');
  expect(screen.queryByRole('option',{name:/Inactive Calendar/})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(state.save).not.toHaveBeenCalled();
 });
 it('submits the selected calendar and dates, retains review feedback, and refreshes only after success',async()=>{
  state.save.mockResolvedValue({ok:true,updated:2,reviewDates:['2025-04-09']});mount();
  fireEvent.click(screen.getByRole('button',{name:'Add calendar'}));
  fireEvent.change(screen.getByLabelText('Calendar'),{target:{value:'group:group'}});
  fireEvent.change(screen.getByLabelText('End Date'),{target:{value:'2025-04-10'}});
  fireEvent.submit(screen.getByRole('form',{name:'Add calendar'}));
  await waitFor(()=>expect(state.refresh).toHaveBeenCalledOnce());
  const form=state.save.mock.calls[0][0] as FormData;
  expect(Object.fromEntries(form)).toEqual({employmentId:'employee',replacesId:'',calendar:'group:group',startDate:'2025-04-05',endDate:'2025-04-10'});
  expect(screen.getByRole('status')).toHaveTextContent('Recalculated 2');
  expect(screen.getByRole('status')).toHaveTextContent('1 incomplete attendance records');
 });
 it('edits a dated row using its immutable reference and retains archived current choice',()=>{
  mount({rows:[{id:'revision',startDate:'2025-04-05',endDate:'2025-04-10',choice:'group:old',superseded:false}]});
  fireEvent.click(screen.getByRole('button',{name:/Edit Inactive Calendar/}));
  expect(screen.getByLabelText('Calendar')).toHaveValue('group:old');
  expect(screen.getByLabelText('End Date')).toHaveValue('2025-04-10');
  expect(new FormData(screen.getByRole('form',{name:'Edit assignment'}) as HTMLFormElement).get('replacesId')).toBe('revision');
 });
 it('retains dates and selection when the save request fails, allowing an explicit retry',async()=>{
  state.save.mockRejectedValueOnce(new Error('Network unavailable'));mount();fireEvent.click(screen.getByRole('button',{name:'Add calendar'}));
  fireEvent.change(screen.getByLabelText('Calendar'),{target:{value:'state:Johor'}});
  fireEvent.change(screen.getByLabelText('End Date'),{target:{value:'2025-04-10'}});
  fireEvent.submit(screen.getByRole('form',{name:'Add calendar'}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('could not be saved'));
  expect(screen.getByLabelText('Calendar')).toHaveValue('state:Johor');expect(screen.getByLabelText('End Date')).toHaveValue('2025-04-10');
  expect(state.refresh).not.toHaveBeenCalled();
  // The refusal renders before React finishes the async transition. Retry becomes available
  // only after pending clears; observe that user-visible state instead of racing the render.
  await waitFor(()=>expect(screen.getByRole('button',{name:'Save assignment'})).toBeEnabled());
  state.save.mockResolvedValueOnce({ok:true,updated:0,reviewDates:[]});fireEvent.submit(screen.getByRole('form',{name:'Add calendar'}));
  await waitFor(()=>expect(state.refresh).toHaveBeenCalledOnce());expect(state.save).toHaveBeenCalledTimes(2);
 });
 it('keeps the submitted native date values on an overlap refusal and retries exactly those values',async()=>{
  state.save.mockResolvedValueOnce({ok:false,error:'overlap'});mount();
  fireEvent.click(screen.getByRole('button',{name:'Add calendar'}));
  fireEvent.change(screen.getByLabelText('Calendar'),{target:{value:'state:Johor'}});
  // Native edits/autofill can reach FormData before React has observed a change callback.
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  setter.call(screen.getByLabelText(/^Start Date/),'2025-04-10');
  setter.call(screen.getByLabelText('End Date'),'2025-04-11');
  fireEvent.submit(screen.getByRole('form',{name:'Add calendar'}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('overlaps'));
  expect(screen.getByLabelText(/^Start Date/)).toHaveValue('2025-04-10');
  expect(screen.getByLabelText('End Date')).toHaveValue('2025-04-11');
  expect(screen.getByLabelText('Calendar')).toHaveValue('state:Johor');
  expect(state.refresh).not.toHaveBeenCalled();
  const submitted=Object.fromEntries(state.save.mock.calls[0][0]);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Save assignment'})).toBeEnabled());
  state.save.mockResolvedValueOnce({ok:true,updated:0,reviewDates:[]});
  fireEvent.submit(screen.getByRole('form',{name:'Add calendar'}));
  await waitFor(()=>expect(state.refresh).toHaveBeenCalledOnce());
  expect(Object.fromEntries(state.save.mock.calls[1][0])).toEqual(submitted);
 });
 it('saves the independent calendar with an unrelated tab draft and still warns before leaving',async()=>{
  const tabSave=vi.fn();state.save.mockResolvedValue({ok:true,updated:0,reviewDates:[]});
  // Match Personnel Attendance: the independent calendar is a SIBLING before the tab scope.
  const contents=(rows:React.ComponentProps<typeof HolidayCalendarAssignments>['rows']=[]) => <NextIntlClientProvider locale="en" messages={en}>
   <HolidayCalendarAssignments {...base} rows={rows}/>
   <TabSaveScope tabKey="attendance" identity={{employmentId:base.employmentId}} saveAction={tabSave} covers={['Web Clocking']}>
    <form data-save-section="attendance-photo"><label>Photo requirement<input name="attendancePhotoSetting" defaultValue="required"/></label></form>
   </TabSaveScope>
   <a href="/admin/personnel">Leave personnel screen</a>
  </NextIntlClientProvider>;
  const view=render(contents());
  fireEvent.change(screen.getByLabelText('Photo requirement'),{target:{value:'optional'}});
  await waitFor(()=>expect(screen.getByRole('button',{name:'Save Changes'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Add calendar'}));
  fireEvent.change(screen.getByLabelText('Calendar'),{target:{value:'state:Johor'}});
  fireEvent.submit(screen.getByRole('form',{name:'Add calendar'}));
  await waitFor(()=>expect(state.save).toHaveBeenCalledOnce());
  await waitFor(()=>expect(state.refresh).toHaveBeenCalledOnce());
  // A refreshed RSC payload supplies new server markup without discarding the unrelated dirty scope.
  view.rerender(contents([{id:'saved',startDate:base.joinDate,endDate:null,choice:'state:Johor',superseded:false}]));
  expect(screen.queryByRole('dialog')).toBeNull();expect(tabSave).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Photo requirement')).toHaveValue('optional');
  expect(screen.getByRole('button',{name:'Save Changes'})).toBeEnabled();
  fireEvent.click(screen.getByRole('link',{name:'Leave personnel screen'}));
  const dialog=await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('Unsaved changes');
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(screen.getByLabelText('Photo requirement')).toHaveValue('optional');
  expect(tabSave).not.toHaveBeenCalled();
 });
 it('shows a protected-payroll refusal without dismissing the edit or claiming success',async()=>{
  state.save.mockResolvedValue({ok:false,error:'closedPayroll'});mount();fireEvent.click(screen.getByRole('button',{name:'Add calendar'}));
  fireEvent.submit(screen.getByRole('form',{name:'Add calendar'}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('closed payroll'));
  expect(state.refresh).not.toHaveBeenCalled();expect(screen.getByRole('form')).toBeInTheDocument();
 });
});

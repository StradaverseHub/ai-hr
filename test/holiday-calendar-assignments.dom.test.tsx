import React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {HolidayCalendarAssignments} from '../app/admin/personnel/[employmentId]/holiday-calendar-assignments';
const state=vi.hoisted(()=>({save:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:state.refresh})}));
vi.mock('../app/admin/personnel/[employmentId]/holiday-calendar-actions',()=>({saveHolidayCalendarAssignmentAction:state.save}));
afterEach(cleanup);beforeEach(()=>{state.save.mockReset();state.refresh.mockReset();});
const base={employmentId:'employee',joinDate:'2025-04-05',employmentStartDate:'2025-04-01',fallbackLabel:'Selangor',groups:[{id:'group',name:'Recorded Calendar',active:true},{id:'old',name:'Inactive Calendar',active:false}],states:['Selangor','Johor'],rows:[]};
const mount=(overrides:Partial<React.ComponentProps<typeof HolidayCalendarAssignments>>={})=>render(<NextIntlClientProvider locale="en" messages={en}><HolidayCalendarAssignments {...base} {...overrides}/></NextIntlClientProvider>);
describe('dated holiday calendar input and history',()=>{
 it('defaults to recorded Join Date, leaves an optional end blank, and cancel makes no call',()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:'Add calendar'}));
  expect(screen.getByLabelText('Start Date')).toHaveValue(base.joinDate);
  expect(screen.getByLabelText('Start Date')).toHaveAttribute('min',base.employmentStartDate);
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
 it('shows a protected-payroll refusal without dismissing the edit or claiming success',async()=>{
  state.save.mockResolvedValue({ok:false,error:'closedPayroll'});mount();fireEvent.click(screen.getByRole('button',{name:'Add calendar'}));
  fireEvent.submit(screen.getByRole('form',{name:'Add calendar'}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('closed payroll'));
  expect(state.refresh).not.toHaveBeenCalled();expect(screen.getByRole('form')).toBeInTheDocument();
 });
});

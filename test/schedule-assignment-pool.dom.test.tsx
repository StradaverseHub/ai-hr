import React from 'react';
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {EmployeeShiftFields} from '../components/employee-shift-fields';
afterEach(cleanup);
describe('effective-dated assignment choices',()=>{
 it('offers the effective pool and keeps an invalid saved source visibly disabled',()=>{
  render(<NextIntlClientProvider locale="en" messages={messages}><EmployeeShiftFields defaultType="fixed" defaultShiftId="old" defaultEffectiveFrom="2026-10-15" shifts={[{id:'old',label:'Old shift'},{id:'next',label:'Next shift'},{id:'archived',label:'Archived',archived:true}]} allowedPool={{baseShiftIds:['old'],versions:[{effectiveFrom:'2026-10-16',allowedShiftIds:['next','archived']}]}}/></NextIntlClientProvider>);
  expect(screen.getByRole('option',{name:'Old shift'})).not.toBeDisabled();
  expect(screen.queryByRole('option',{name:'Next shift'})).toBeNull();
  fireEvent.change(document.querySelector('[name="effectiveFrom"]')!,{target:{value:'2026-10-16'}});
  expect(screen.getByRole('option',{name:'Old shift'})).toBeDisabled();
  expect(screen.getByRole('option',{name:'Next shift'})).not.toBeDisabled();
  expect(screen.queryByRole('option',{name:'Archived'})).toBeNull();
  fireEvent.change(document.querySelector('[name="shiftId"]')!,{target:{value:'next'}});
  expect(screen.queryByRole('option',{name:'Old shift'})).toBeNull();
  expect((document.querySelector('[name="shiftId"]') as HTMLSelectElement).value).toBe('next');
 });
});

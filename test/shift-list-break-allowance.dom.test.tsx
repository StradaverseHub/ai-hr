import {expect, it, vi} from 'vitest';
import {render, screen, within} from '@testing-library/react';
import {createTranslator, NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
vi.mock('../lib/authz', () => ({requireAdmin:async()=>({})}));
vi.mock('../components/attendance-settings-navigation', () => ({AttendanceSettingsNavigation:()=>null}));
vi.mock('../core/attendance-rule', () => ({listAttendanceRules:async()=>[]}));
vi.mock('../app/(app)/admin/attendance/shift-actions', () => ({archiveShiftAction:async()=>{},copyShiftAction:async()=>{},deleteShiftAction:async()=>{},unarchiveShiftAction:async()=>{}}));
vi.mock('next-intl/server', () => ({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as never})}));
vi.mock('../core/roster', () => ({listShiftsForTenant:async()=>[{
  id:'fictional-full-flexi',code:'FLEXI',name:'Fictional Full Flexi',type:'full_flexi',startTime:null,endTime:null,
  normalMinutesOverride:480,breakMinutes:30,flexibleBreakEnabled:false,flexibleBreakMinutes:null,
  breakPeriods:[{start:'12:00',end:'13:00',flexible:true,flexibleMinutes:30}],weeklyPattern:[1,2,3,4,5],halfPattern:[],offPattern:[],ruleId:null,color:null,archivedAt:null,
}]}));
import Page from '../app/(app)/admin/attendance/page';

it('shows the nominal 60-minute window and its actual configured 30-minute flexible allowance together', async () => {
  render(<NextIntlClientProvider locale="en" messages={en}>{await Page({searchParams:Promise.resolve({})})}</NextIntlClientProvider>);
  const row = screen.getByText('FLEXI').closest('tr');
  expect(row).not.toBeNull();
  expect(within(row!).getByText('(60m)')).toBeVisible();
  expect(within(row!).getByText('Flexible · up to 30 min')).toBeVisible();
  expect(within(row!).queryByText('Flexible · up to 60 min')).toBeNull();
});

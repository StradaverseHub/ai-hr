import React from 'react';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {AttendanceDayTypeField} from '../components/attendance-day-parts';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
afterEach(cleanup);
describe('read-only Day Type uses the authorized day classification independently of attendance status',()=>{
 it.each(Object.entries({en,ms,zh,ta,th,vi}))('shows a worked rest day as Rest Day in %s',(locale,messages)=>{
  const row={status:'present',dayType:'rest_day' as const};
  render(<AttendanceDayTypeField label={messages.attendance.dayEdit.dayType} dayType={row.dayType} format={kind=>messages.attendance.dayEdit.kind[kind]}/>);
  expect(screen.getByText(messages.attendance.dayEdit.kind.rest_day)).toBeVisible();expect(screen.queryByText(messages.attendance.statusPresent)).toBeNull();
 });
 it('preserves the authorized admin override and leaves absent classification Unknown',()=>{
  const {rerender}=render(<AttendanceDayTypeField label="Day Type" dayType="rest_day" format={()=>{throw Error('Must preserve override');}} override="Recorded leave"/>);
  expect(screen.getByText('Recorded leave')).toBeVisible();rerender(<AttendanceDayTypeField label="Day Type" dayType={null} format={()=>{throw Error('Must not invent classification');}}/>);expect(screen.getByText('—')).toBeVisible();
 });
 it('wires manager classification directly from the existing range row without enabling admin reads',()=>{
  const page=readFileSync(resolve(process.cwd(),'app/(app)/attendance/individual/[date]/page.tsx'),'utf8');
  expect(page).toContain("<AttendanceDayTypeField label={t('dayEdit.dayType')} dayType={row.dayType}");
  expect(page).toContain('admin?attendanceDayEditor');expect(page).not.toMatch(/dayEdit\.dayType[^\n]*:statusText\[status\]/);
 });
});

import * as React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {AttendanceFormulaHistory} from '../components/attendance-formula-pay-items';
import LegacyLibrary from '../app/admin/attendance/settings/formula-builder/page';
import LegacyCreate from '../app/admin/attendance/settings/formula-builder/new/page';
import LegacyEdit from '../app/admin/attendance/settings/formula-builder/[id]/page';
import en from '../messages/en.json';

const mocks=vi.hoisted(()=>({read:vi.fn(),redirect:vi.fn()}));
vi.mock('../app/attendance/individual/[date]/formula-actions',()=>({readAttendancePayItemAction:mocks.read}));
vi.mock('next/navigation',()=>({redirect:mocks.redirect}));
afterEach(cleanup);

it('redirects all old builder bookmarks back to Attendance Settings',()=>{
 for(const redirect of [LegacyLibrary,LegacyCreate,LegacyEdit]){
  redirect();
  expect(mocks.redirect).toHaveBeenLastCalledWith('/admin/attendance/settings');
 }
});

it('shows only retained result evidence with its Payroll posting state',async()=>{
 const date='2025-08-10';
 const result={id:'result',companyId:'company',employmentId:'employment',formulaId:'formula',revisionId:'revision',
  payComponentId:'component',periodFrom:date,periodTo:date,quantity:'15',unit:'amount' as const,rate:null,amount:'15.00',createdAt:new Date(date)};
 mocks.read.mockResolvedValue({ok:true,value:{...result,payload:{result:{amount:'15.00',trace:[]},days:[]}}});
 render(<NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur">
  <AttendanceFormulaHistory rows={[{result,code:'LEGACY_PAY',version:1,definition:{description:'Fictional formula',period:{method:'daily'}},
   payCode:'ATTENDANCE',payName:'Attendance allowance',state:'posted'}]}/>
 </NextIntlClientProvider>);
 expect(screen.getByRole('heading',{name:en.attendanceFormula.retiredHistory})).toBeTruthy();
 expect(screen.getByText(en.attendanceFormula.resultStates.posted)).toBeTruthy();
 expect(screen.getAllByRole('button')).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.viewEvidence}));
 expect(await screen.findByText('Result: 15.00')).toBeTruthy();
 expect(mocks.read).toHaveBeenCalledWith(result.id);
});

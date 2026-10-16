// @vitest-environment jsdom
import {cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {LeaveDurationFields} from '../components/leave-duration-fields';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
afterEach(cleanup);
describe('explicit own Leave form transport',()=>{
 it('posts the selected B once and previews B without exposing an on-behalf selector',async()=>{
  const summary=vi.fn(async()=>null),preview=vi.fn(async()=>null);
  const root=render(<NextIntlClientProvider locale="en" messages={en}><form><LeaveDurationFields types={[{id:a,label:'Fictional leave',durations:null}]} fixedOwnEmploymentId={b} employeeOptions={[{id:a,name:'Unrelated former default'}]} startDefault="2026-10-16" summaryAction={summary} action={preview}/></form></NextIntlClientProvider>);
  expect(root.container.querySelector('select[name="employmentId"]')).toBeNull();
  expect(new FormData(root.container.querySelector('form')!).getAll('employmentId')).toEqual([b]);
  await waitFor(()=>expect(summary).toHaveBeenCalledWith({employmentId:b,leaveTypeId:a}));
  await waitFor(()=>expect(preview).toHaveBeenCalledWith(expect.objectContaining({employmentId:b,leaveTypeId:a})));
 });
});

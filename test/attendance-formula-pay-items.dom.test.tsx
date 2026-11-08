import * as React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {AttendanceFormulaPayItems} from '../components/attendance-formula-pay-items';
const mocks=vi.hoisted(()=>({calculate:vi.fn(),review:vi.fn(),read:vi.fn(),transfer:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
vi.mock('../app/attendance/individual/[date]/formula-actions',()=>({calculateAttendancePayItemAction:mocks.calculate,reviewAttendancePayItemAction:mocks.review,readAttendancePayItemAction:mocks.read,transferAttendancePayItemsAction:mocks.transfer}));
// This test owns result review and transfer intent. The separately tested editor owns trace rendering.
vi.mock('../app/admin/attendance/settings/formula-builder/editor',()=>({TestEvidence:()=> <div>Actual result evidence</div>}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const base={employmentId:'E',date:'2026-11-08',choices:[{id:'F',code:'WORKED',description:'Fictional earning',method:'daily'}],runs:[{id:'B',companyId:'C',period:'2026-11',cycleId:null}]};
const result={id:'R',companyId:'C',formulaId:'F',revisionId:'V',employmentId:'E',periodFrom:'2026-11-08',periodTo:'2026-11-08',payComponentId:'P',quantity:'60',unit:'minutes',rate:'20',amount:'20.00',createdAt:new Date('2026-11-08T00:00:00Z')};
const row={result,code:'WORKED',definition:{description:'Fictional earning',period:{method:'daily'}},payCode:'ATT',payName:'Attendance earning',state:'approved'};
const mount=(state='approved')=>render(<NextIntlClientProvider locale="en" messages={en}><AttendanceFormulaPayItems {...base} rows={[{...row,state}] as unknown as Parameters<typeof AttendanceFormulaPayItems>[0]['rows']}/></NextIntlClientProvider>);
it('requires selected approved results, draft run and a reason before explicit transfer',async()=>{
 mocks.transfer.mockResolvedValue({ok:true,value:{posted:['R'],excluded:[],idempotent:false}});mount();
 const transfer=screen.getByRole('button',{name:en.attendanceFormula.transferToPayroll});expect(transfer).toBeDisabled();
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.change(screen.getByLabelText(en.attendanceFormula.payrollRun),{target:{value:'B'}});expect(transfer).toBeDisabled();fireEvent.change(screen.getByLabelText(en.attendanceFormula.reviewReason),{target:{value:'Reviewed actual evidence'}});fireEvent.click(transfer);
 await waitFor(()=>expect(mocks.transfer).toHaveBeenCalledWith({batchId:'B',resultIds:['R'],reason:'Reviewed actual evidence'}));expect(mocks.review).not.toHaveBeenCalled();expect(mocks.calculate).not.toHaveBeenCalled();
});
it('does not permit unapproved result selection and surfaces the native calculation refusal',async()=>{
 mocks.calculate.mockResolvedValue({ok:false,error:'Fictional missing positioned break evidence'});mount('calculated');expect(screen.getByRole('checkbox')).toBeDisabled();
 fireEvent.change(screen.getByLabelText(en.attendanceFormula.activeFormula),{target:{value:'F'}});fireEvent.click(screen.getByRole('button',{name:en.attendanceFormula.calculatePayItem}));await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Fictional missing positioned break evidence'));expect(mocks.transfer).not.toHaveBeenCalled();
});

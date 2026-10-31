/** 39c7: View must retain the selected configured cycle, including after processing/archival.
 * Only the server-action boundary is stubbed here; DB/role authority is covered by the sibling DB test.
 */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {TxnWorkspace,type TxnEmployee} from '../app/(app)/payroll/transactions/individual/txn-workspace';
import {buildTxnPanel,type TxnPanelInputRow} from '../app/(app)/payroll/transactions/individual/existing-context';
const panelMock=vi.fn();
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()}),useSearchParams:()=>new URLSearchParams('')}));
vi.mock('sonner',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
vi.mock('../app/(app)/payroll/transactions/individual/actions',()=>({
 fetchEmployeeTxnPanelAction:(...args:unknown[])=>panelMock(...args),fetchBatchImpactAction:()=>Promise.resolve(null),fetchTxnDetailAction:()=>Promise.resolve(null),
 previewTxnAmountAction:()=>Promise.resolve({ok:true,derived:false}),previewTxnAmountsAction:()=>Promise.resolve({ok:true,derived:false}),
 createIndividualTxnAction:()=>Promise.resolve({ok:true,id:'created'}),createIndividualTxnDayGridAction:()=>Promise.resolve({ok:true,id:'created',count:1}),
 updateIndividualTxnAction:()=>Promise.resolve({ok:true,id:'row'}),deleteIndividualTxnAction:()=>Promise.resolve({ok:true}),
}));
type CycleFields={batchCycleId:string|null;batchCycleName:string|null;intendedCycleId:string|null;intendedCycleName:string|null};
const employee:TxnEmployee={employmentId:'employee',name:'Fictional Cycle Employee',employeeCode:'CYCLE-1',department:'Team',departmentId:'dept',businessUnit:null,businessUnitId:null,position:null,company:'Fictional Company',companyId:'company',status:'active'};
const base:TxnPanelInputRow&CycleFields={id:'row',employmentId:'employee',payPeriod:'2026-10',txnDate:'2026-09-02',kind:'earning',amount:'100.00',quantity:null,unit:null,notes:null,componentId:null,componentCode:null,componentName:null,source:'manual',runType:'regular',runSeq:1,batchStatus:'processed',createdOn:'2026-10-16',createdBy:null,changedAt:'2026-10-16T00:00:00.000000',payslipCalculatedAt:'2026-10-16T01:00:00.000000',batchNeedsRecalcForEmployment:false,batchCycleId:'monthly',batchCycleName:'Monthly',intendedCycleId:'monthly',intendedCycleName:'Monthly'};
async function open(patch:Partial<TxnPanelInputRow&CycleFields>={}){
 panelMock.mockResolvedValue(buildTxnPanel([{...base,...patch}]));
 render(<NextIntlClientProvider locale="en" messages={messages}><TxnWorkspace employees={[employee]} batches={[]} companies={[{id:'company',name:'Fictional Company',currency:'MYR'}]} payItems={[]} payrollCycles={[]} processHref="/payroll" requireComponent={false} currentPeriod="2026-10" panelDefaultOpen panelCookieKey="cycle-detail"/></NextIntlClientProvider>);
 const user=userEvent.setup();await user.click(await screen.findByRole('button',{name:/Fictional Cycle Employee/}));await user.click(await screen.findByRole('button',{name:'View'}));
 return screen.getByRole('dialog',{name:'Transaction details'});
}
beforeEach(()=>vi.clearAllMocks());
describe('configured Pay cycle in transaction View',()=>{
 it('shows Monthly on a processed September-work/October-pay row without relying on the active picker catalogue',async()=>{
  const dialog=await open();expect(within(dialog).getByText('Monthly')).toBeInTheDocument();expect(within(dialog).queryByText('Regular')).not.toBeInTheDocument();expect(within(dialog).getByText('2026-09-02')).toBeInTheDocument();expect(within(dialog).getByText('2026-10')).toBeInTheDocument();
 });
 it('shows the selected intended cycle before a run exists',async()=>{
  const dialog=await open({batchCycleId:null,batchCycleName:null,batchStatus:null,runType:null,runSeq:null,payslipCalculatedAt:null});expect(within(dialog).getByText('Monthly')).toBeInTheDocument();
 });
 it.each(['Advance Salary','Mid-Month'])('retains distinct/archived off-cycle label %s without an active picker option',async name=>{
  const dialog=await open({batchCycleId:'off-cycle',batchCycleName:name,intendedCycleId:'off-cycle',intendedCycleName:name,runType:'off_cycle',runSeq:2});expect(within(dialog).getByText(name+' #2')).toBeInTheDocument();expect(within(dialog).queryByText('Off-cycle #2')).not.toBeInTheDocument();
 });
 it('does not replace an unavailable known batch cycle with a different intended label or run type',async()=>{
  const dialog=await open({batchCycleName:null,intendedCycleName:'A different intended cycle'});expect(within(dialog).getByText('Pay cycle unavailable')).toBeInTheDocument();expect(within(dialog).queryByText('A different intended cycle')).not.toBeInTheDocument();expect(within(dialog).queryByText('Regular')).not.toBeInTheDocument();
 });
 it('does not guess a known intended cycle when its authorized name is unavailable',async()=>{
  const dialog=await open({batchCycleId:null,batchCycleName:null,batchStatus:null,runType:null,intendedCycleName:null,payslipCalculatedAt:null});expect(within(dialog).getByText('Pay cycle unavailable')).toBeInTheDocument();
 });
 it('keeps the translated run type fallback for genuinely NULL legacy cycle references',async()=>{
  const dialog=await open({batchCycleId:null,batchCycleName:null,intendedCycleId:null,intendedCycleName:null});expect(within(dialog).getByText('Regular')).toBeInTheDocument();expect(within(dialog).queryByText('Pay cycle unavailable')).not.toBeInTheDocument();
 });
});

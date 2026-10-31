import type {ButtonHTMLAttributes} from 'react';
import {describe,it,expect,vi,beforeEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {IndividualImportRevert} from '../app/(app)/payroll/transactions/individual/imports/[attemptId]/revert-control';
const mocks=vi.hoisted(()=>({refresh:vi.fn(),revert:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
vi.mock('../components/ui',()=>({Button:({children,...props}:ButtonHTMLAttributes<HTMLButtonElement>)=><button {...props}>{children}</button>}));
vi.mock('../app/(app)/payroll/transactions/import-excel/individual-actions',()=>({revertIndividualImportAction:mocks.revert}));
function surface(){return render(<NextIntlClientProvider locale="en" messages={messages}><IndividualImportRevert id="00000000-0000-4000-8000-000000000001" file="monthly.xlsx" count={2}/></NextIntlClientProvider>);}
beforeEach(()=>{cleanup();vi.clearAllMocks();});
describe('import batch reversal confirmation',()=>{
 it('requires explicit batch confirmation and identifies its file and row count',()=>{
  surface();expect(screen.getByText(/monthly.xlsx/)).toBeInTheDocument();expect(screen.getByText(/2 imported transactions/)).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Revert Import'})).toBeDisabled();expect(mocks.revert).not.toHaveBeenCalled();
 });
 it('sends the processed-payroll acknowledgement only when the user checks it and retains a refusal for review',async()=>{
  mocks.revert.mockResolvedValue({ok:false,error:'importRowsChanged'});surface();
  fireEvent.click(screen.getByRole('checkbox',{name:'I confirm reversal of the identified import batch.'}));
  fireEvent.click(screen.getByRole('checkbox',{name:/If existing payroll controls allow/}));
  fireEvent.click(screen.getByRole('button',{name:'Revert Import'}));
  await waitFor(()=>expect(mocks.revert).toHaveBeenCalledWith({id:'00000000-0000-4000-8000-000000000001',confirmProcessed:true}));
  expect(await screen.findByRole('alert')).toHaveTextContent('An imported record changed or was removed. Nothing was reversed.');expect(mocks.refresh).not.toHaveBeenCalled();
 });
});

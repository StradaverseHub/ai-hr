import {beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ContractManualWorkflow} from '../app/lifecycle/contracts/manual-workflow';
const commands=vi.hoisted(()=>({read:vi.fn(),start:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/lifecycle/contracts/shared-actions',()=>({readSharedManualWorkflows:commands.read,startSharedManualWorkflow:commands.start}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:commands.refresh})}));
beforeEach(()=>{cleanup();vi.clearAllMocks();commands.read.mockResolvedValue({ok:true,value:[{id:'workflow',revision:4,name:'Fictional recovery workflow',description:'Run the reviewed manual recovery sequence.'}]});});
it('reuses the exact admission request after transport failure and preserves the chosen live workflow',async()=>{
 commands.start.mockRejectedValueOnce(new Error('Transport lost')).mockResolvedValueOnce({ok:true,value:{eventId:'event',jobId:'job'}});
 render(<NextIntlClientProvider locale="en" messages={en}><ContractManualWorkflow caseId="case" revision={7}/></NextIntlClientProvider>);
 fireEvent.change(await screen.findByLabelText('Live manual workflow'),{target:{value:'workflow'}});fireEvent.click(screen.getByRole('button',{name:'Start selected workflow'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('selection is retained');expect(screen.getByLabelText('Live manual workflow')).toHaveValue('workflow');
 fireEvent.click(screen.getByRole('button',{name:'Start selected workflow'}));await waitFor(()=>expect(commands.start).toHaveBeenCalledTimes(2));
 expect(commands.start.mock.calls[1][0]).toEqual(commands.start.mock.calls[0][0]);expect(commands.start.mock.calls[0][0]).toMatchObject({caseId:'case',revision:7,workflowId:'workflow',workflowRevision:4,requestId:expect.any(String)});expect(commands.refresh).toHaveBeenCalledOnce();expect(await screen.findByText(/workflow was accepted/)).toBeVisible();
});
it('shows a denied live-choice read as an error instead of loading forever',async()=>{
 commands.read.mockResolvedValue({ok:false,error:'Your Manual permission changed. Reload the case.'});
 render(<NextIntlClientProvider locale="en" messages={en}><ContractManualWorkflow caseId="case" revision={7}/></NextIntlClientProvider>);
 expect(await screen.findByRole('alert')).toHaveTextContent('Manual permission changed');expect(screen.queryByText('Loading eligible live workflows…')).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Start selected workflow'})).not.toBeInTheDocument();
});

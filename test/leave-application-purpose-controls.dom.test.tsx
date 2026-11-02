/** Rendered exact Add projections; actual native target filtering is covered by the database suite. */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
const {router,query}=vi.hoisted(()=>({router:{replace:vi.fn()},query:{value:''}}));
vi.mock('next/navigation',()=>({useRouter:()=>router,useSearchParams:()=>new URLSearchParams(query.value)}));
import {RequestLeaveDialog} from '../components/leave/request-leave-dialog';
const props={types:[{id:'11111111-1111-4111-8111-111111111111',label:'Fictional leave type',durations:['full_day']}],ownEmploymentId:'22222222-2222-4222-8222-222222222222',submitAction:async()=>{},previewAction:async()=>null,summaryAction:async()=>null};
afterEach(()=>{cleanup();query.value='';router.replace.mockReset();});
it('renders no apply trigger/form and does not consume an auto-open link when exact Add is denied',()=>{
 query.value='apply=1';const view=render(<NextIntlClientProvider locale="en" messages={messages}><RequestLeaveDialog {...props} canAdd={false}/></NextIntlClientProvider>);
 expect(view.container.querySelector('form')).toBeNull();expect(screen.queryByRole('button',{name:messages.leave.requestLeave})).not.toBeInTheDocument();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(router.replace).not.toHaveBeenCalled();
});
it('renders the real apply fields and only the admitted target choices when exact Add is present',async()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><RequestLeaveDialog {...props} canAdd={true} employeeOptions={[{id:'33333333-3333-4333-8333-333333333333',name:'Fictional allowed report'}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:messages.leave.requestLeave}));
 expect(await screen.findByRole('dialog')).toBeInTheDocument();expect(screen.getByRole('option',{name:'Fictional allowed report'})).toBeInTheDocument();expect(screen.getByRole('option',{name:'Fictional leave type'})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:messages.leave.submitRequest})).toBeEnabled();
 const target=document.querySelector<HTMLSelectElement>('select[name="employmentId"]');expect(target?.value).toBe('33333333-3333-4333-8333-333333333333');expect(target?.options).toHaveLength(1);
});

/** Actual server calendar projection and real client withdrawal dialog; no database authority mock. */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages,namespace:namespace as never,onError:error=>{throw error;}})}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn(),replace:vi.fn()}),usePathname:()=>'/leave/tracker',useSearchParams:()=>new URLSearchParams()}));
import {PlannedAbsences} from '../components/planned-absences';
const requestId='11111111-1111-4111-8111-111111111111',personId='22222222-2222-4222-8222-222222222222';
const rows=[{id:personId,name:'Fictional own calendar employee',role:null,leaves:[{id:requestId,employmentId:'33333333-3333-4333-8333-333333333333',typeCode:'ANNUAL',typeName:'Fictional pending leave',status:'pending',startDate:'2026-11-04',endDate:'2026-11-04',durationType:'full_day',parentGroupId:null}]}];
afterEach(cleanup);
async function view(allowed:readonly string[]){const tree=await PlannedAbsences({rows,todayIso:'2026-11-03',anchorIso:'2026-11-02',initialCalView:'week',initialView:'my',viewerPersonId:personId,selfCancelAction:async()=>{},selfCancelAllowedRequestIds:allowed});return <NextIntlClientProvider locale="en" messages={messages}>{tree}</NextIntlClientProvider>;}
it('keeps the actual own pending pill visible without a withdrawal affordance when exact Delete is absent',async()=>{
 render(await view([]));expect(screen.getByText('Fictional own calendar employee')).toBeInTheDocument();expect(screen.getAllByText('Fictional pending').length).toBeGreaterThan(0);
 expect(screen.queryByRole('button',{name:messages.leave.selfCancelPillAffordanceLabel})).not.toBeInTheDocument();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('retains the native pending self-withdraw confirmation only for the exact admitted request',async()=>{
 render(await view([requestId]));fireEvent.click(screen.getByRole('button',{name:messages.leave.selfCancelPillAffordanceLabel}));
 expect(await screen.findByRole('dialog')).toBeInTheDocument();expect(screen.getByRole('button',{name:messages.leave.selfCancelConfirm})).toBeInTheDocument();
 expect(document.querySelector<HTMLInputElement>('input[name="leaveRequestId"]')?.value).toBe(requestId);
});

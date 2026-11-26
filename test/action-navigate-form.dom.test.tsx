/** ADR 0181 decision 4: <ActionNavigateForm> navigates in-app after a frame-keeping save instead of letting the action
 * redraw the whole tree, shows the feedback once, and re-reads the shell's approval facts when asked. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';

const router=vi.hoisted(()=>({push:vi.fn(),refresh:vi.fn(),replace:vi.fn()}));
const toast=vi.hoisted(()=>({success:vi.fn(),error:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>router}));
vi.mock('sonner',()=>({toast}));

import {ActionNavigateForm} from '../components/action-navigate-form';
import {ShellApprovalFactsProvider,useShellApprovalFacts,type ShellApprovalResult} from '../components/shell-approval-facts';
import {ACTION_NAVIGATION_FIELD,type ActionNavigation} from '../lib/action-navigation';

const ready=(total:number):ShellApprovalResult=>({state:'ready',items:[],total,approvalCount:total,claimTotal:0,hasAssignedAttendanceApproval:false,hasAssignedApproval:false});
function Badge(){const facts=useShellApprovalFacts();return <output data-testid="badge">{facts?.result.state==='ready'?facts.result.total:facts?.result.state}</output>;}

function renderForm(action:(form:FormData)=>Promise<ActionNavigation|void|undefined>,refreshAction?:()=>Promise<ShellApprovalResult>){
 const source=Promise.resolve(ready(5));
 return render(<NextIntlClientProvider locale="en" messages={en}>
  <ShellApprovalFactsProvider source={source} canOpenApprovalsWithoutAssignment refreshAction={refreshAction}>
   <Badge/>
   <ActionNavigateForm action={action} className="fixture-form"><input type="hidden" name="id" value="fixture-id"/><button type="submit">Decide</button></ActionNavigateForm>
  </ShellApprovalFactsProvider>
 </NextIntlClientProvider>);
}
beforeEach(()=>{router.push.mockReset();router.refresh.mockReset();toast.success.mockReset();toast.error.mockReset();});
afterEach(cleanup);

describe('ActionNavigateForm',()=>{
 it('marks the submission, shows the feedback, navigates without it and re-reads the badge',async()=>{
  const action=vi.fn(async(_form:FormData):Promise<ActionNavigation>=>({navigate:'/approvals?category=leave&toast=Leave+approved',refreshShellApprovals:true}));
  const refreshAction=vi.fn(async()=>ready(4));
  renderForm(action,refreshAction);
  await waitFor(()=>expect(screen.getByTestId('badge').textContent).toBe('5'));
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Decide'}));});
  await waitFor(()=>expect(router.push).toHaveBeenCalledWith('/approvals?category=leave'));
  const posted=action.mock.calls[0][0];
  expect(posted.get(ACTION_NAVIGATION_FIELD)).toBe('client');
  expect(posted.get('id')).toBe('fixture-id');
  expect(toast.success).toHaveBeenCalledTimes(1);
  expect(toast.success.mock.calls[0][0]).toBe('Leave approved');
  await waitFor(()=>expect(screen.getByTestId('badge').textContent).toBe('4'));
  expect(refreshAction).toHaveBeenCalledTimes(1);
  expect(router.refresh).not.toHaveBeenCalled();
 });
 it('does not re-read the badge after a refusal, and shows its error',async()=>{
  const refreshAction=vi.fn(async()=>ready(0));
  renderForm(async()=>({navigate:'/approvals?error=Not+allowed'}),refreshAction);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Decide'}));});
  await waitFor(()=>expect(router.push).toHaveBeenCalledWith('/approvals'));
  expect(toast.error).toHaveBeenCalledWith('Not allowed');
  expect(refreshAction).not.toHaveBeenCalled();
  expect(screen.getByTestId('badge').textContent).toBe('5');
 });
 it('never follows an address outside the application, and does nothing when the action returns nothing',async()=>{
  const refreshAction=vi.fn(async()=>ready(0));
  renderForm(async()=>({navigate:'//example.invalid/approvals',refreshShellApprovals:true}),refreshAction);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Decide'}));});
  cleanup();
  renderForm(async()=>undefined,refreshAction);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Decide'}));});
  expect(router.push).not.toHaveBeenCalled();
  expect(refreshAction).not.toHaveBeenCalled();
 });
 it('keeps the shown facts when the re-read fails',async()=>{
  const refreshAction=vi.fn(async():Promise<ShellApprovalResult>=>{throw new Error('offline');});
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  renderForm(async()=>({navigate:'/approvals',refreshShellApprovals:true}),refreshAction);
  await waitFor(()=>expect(screen.getByTestId('badge').textContent).toBe('5'));
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Decide'}));});
  await waitFor(()=>expect(refreshAction).toHaveBeenCalled());
  expect(screen.getByTestId('badge').textContent).toBe('5');
  log.mockRestore();
 });
});

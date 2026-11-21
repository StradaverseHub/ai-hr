import {Suspense} from 'react';
import {renderToString} from 'react-dom/server';
import {hydrateRoot,type Root} from 'react-dom/client';
import {act,fireEvent,render} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {NextIntlClientProvider} from 'next-intl';
import {ShellApprovalFactsProvider,type ShellApprovalResult} from '../components/shell-approval-facts';
import {NotificationCenter,type NotificationLifecyclePreview} from '../components/notification-center';
import en from '../messages/en.json';

vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/notification-actions',()=>({markAllNotificationsReadAction:vi.fn(),markNotificationReadAction:vi.fn()}));
const theme=vi.hoisted(()=>({monolith:true}));
vi.mock('../components/ui-theme-context',()=>({useIsMonolith:()=>theme.monolith}));

function deferred<T>(){
 let resolve!:(value:T)=>void;
 const promise=new Promise<T>(done=>{resolve=done;});
 return {promise,resolve};
}

// The server can finish a streamed segment while its client code/data still waits.
// Control that hydration delay without replacing either production component.
async function probe({delayBell,total,monolith,lifecycleCount}:{delayBell:boolean;total:number;monolith:boolean;lifecycleCount?:number}){
 theme.monolith=monolith;
 const source=deferred<ShellApprovalResult>(),gate=deferred<void>();
 const lifecycle=lifecycleCount===undefined?undefined:deferred<NotificationLifecyclePreview>();
 let client=false,blocked=delayBell;
 function Bell(){
  if(client&&blocked)throw gate.promise;
  return <NotificationCenter unread={0} items={[]} taskCount={lifecycle?2:0} lifecyclePreview={lifecycle?.promise} canApprove/>;
 }
 function Tree(){return <NextIntlClientProvider locale="en" timeZone="Asia/Kuala_Lumpur" messages={en}>
  <ShellApprovalFactsProvider source={source.promise} canOpenApprovalsWithoutAssignment={false}>
   <div data-shell-ready>Shell</div>
   {delayBell?<Suspense fallback={<span data-bell-placeholder/>}><Bell/></Suspense>:<Bell/>}
  </ShellApprovalFactsProvider>
 </NextIntlClientProvider>;}
 const host=document.createElement('div');document.body.append(host);
 host.innerHTML=renderToString(<Tree/>);
 const serverTrigger=host.querySelector('button')!;
 const serverBell=serverTrigger.outerHTML;
 expect(serverTrigger.disabled).toBe(true);
 const errors:string[]=[];let root:Root|undefined;
 const warnings:string[]=[];const consoleError=vi.spyOn(console,'error').mockImplementation((...args)=>warnings.push(args.map(String).join(' ')));
 try{
  client=true;
  await act(async()=>{root=hydrateRoot(host,<Tree/>,{onRecoverableError(error,info){errors.push(String(error)+'\n'+info.componentStack);}});});
  await act(async()=>{source.resolve({state:'ready',items:[],total,approvalCount:total,claimTotal:0,hasAssignedAttendanceApproval:total>0,hasAssignedApproval:total>0});await source.promise;});
  await act(async()=>{blocked=false;gate.resolve();await gate.promise;});
  const trigger=host.querySelector('button')!;
  expect(trigger.disabled).toBe(false);
  const pendingLabel=trigger.getAttribute('aria-label');
  await act(async()=>trigger.click());
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect([...host.querySelectorAll('button')].some(button=>button.textContent?.trim()==='History')).toBe(true);
  if(lifecycle&&lifecycleCount!==undefined){
   await act(async()=>{lifecycle.resolve({items:[],queueLinks:[],count:lifecycleCount});await lifecycle.promise;});
  }
  const clientBell=host.querySelector('button')!.outerHTML;
  console.log(JSON.stringify({delayBell,total,monolith,serverBell,clientBell,errors,warnings}));
  return {errors,warnings,pendingLabel,label:host.querySelector('button')!.getAttribute('aria-label')};
 }finally{await act(async()=>root?.unmount());host.remove();consoleError.mockRestore();}
}

describe('approval facts and notification bell hydration ordering',()=>{
 it('hydrates the previous inline bell before approval facts publish',async()=>{
  const result=await probe({delayBell:false,total:3,monolith:true});
  expect(result.errors).toEqual([]);expect(result.warnings).toEqual([]);expect(result.label).toContain('3 open tasks');
 });
 it.each([true,false])('hydrates a delayed bell with pending task count without mismatch (monolith=%s)',async monolith=>{
  const result=await probe({delayBell:true,total:3,monolith});
  expect(result.errors).toEqual([]);expect(result.warnings).toEqual([]);expect(result.label).toContain('3 open tasks');
 });
 it('keeps the bell available while Lifecycle loads and then includes its count',async()=>{
  const result=await probe({delayBell:false,total:3,lifecycleCount:4,monolith:true});
  expect(result.errors).toEqual([]);expect(result.warnings).toEqual([]);
  expect(result.pendingLabel).not.toContain('open tasks');
  expect(result.label).toContain('9 open tasks');
 });
 it('hydrates a delayed bell with no assigned task count without mismatch',async()=>{
  const result=await probe({delayBell:true,total:0,monolith:true});
  expect(result.errors).toEqual([]);expect(result.warnings).toEqual([]);expect(result.label).toContain('0 open tasks');
 });
});

it('fetches early on bell intent, avoids a duplicate at page load, and ignores obsolete scope results',async()=>{
 const waiting=vi.spyOn(document,'readyState','get').mockReturnValue('loading');
 const first=deferred<Response>(),second=deferred<Response>();
 const fetchPreview=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
 vi.stubGlobal('fetch',fetchPreview);
 const tree=(revision:string)=><NextIntlClientProvider locale="en" timeZone="Asia/Kuala_Lumpur" messages={en}>
  <ShellApprovalFactsProvider requestRevision={revision} canOpenApprovalsWithoutAssignment={false}>
   <NotificationCenter unread={0} items={[]}/>
  </ShellApprovalFactsProvider>
 </NextIntlClientProvider>;
 const view=render(tree('first'));
 const result=(total:number)=>Response.json({approvals:{state:'ready',items:[],total,claimTotal:0,approvalCount:total,
  hasAssignedAttendanceApproval:false,hasAssignedApproval:total>0},lifecycle:null});
 try{
  expect(fetchPreview).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button',{name:/^Notifications, /}));
  expect(view.getByRole('button',{name:'History'})).toBeDefined();
  expect(fetchPreview).toHaveBeenCalledExactlyOnceWith('/api/notifications/shell-tasks',
   expect.objectContaining({credentials:'same-origin',cache:'no-store'}));
  fireEvent(window,new Event('load'));
  expect(fetchPreview).toHaveBeenCalledOnce();

  const obsolete=fetchPreview.mock.calls[0][1].signal as AbortSignal;
  waiting.mockReturnValue('complete');
  view.rerender(tree('second'));
  expect(obsolete.aborted).toBe(true);
  expect(fetchPreview).toHaveBeenCalledTimes(2);
  await act(async()=>{first.resolve(result(99));await first.promise;});
  expect(view.getByRole('button',{name:/^Notifications, /}).getAttribute('aria-label')).not.toContain('99 open tasks');
  await act(async()=>{second.resolve(result(2));await second.promise;});
  expect(view.getByRole('button',{name:/^Notifications, /}).getAttribute('aria-label')).toContain('2 open tasks');
 }finally{
  view.unmount();
  waiting.mockRestore();
  vi.unstubAllGlobals();
 }
});

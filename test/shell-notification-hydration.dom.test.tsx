import {Suspense} from 'react';
import {renderToString} from 'react-dom/server';
import {hydrateRoot,type Root} from 'react-dom/client';
import {act} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {NextIntlClientProvider} from 'next-intl';
import {ShellApprovalFactsProvider,type ShellApprovalResult} from '../components/shell-approval-facts';
import {NotificationCenter} from '../components/notification-center';
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
async function probe({delayBell,total,monolith}:{delayBell:boolean;total:number;monolith:boolean}){
 theme.monolith=monolith;
 const source=deferred<ShellApprovalResult>(),gate=deferred<void>();
 let client=false,blocked=delayBell;
 function Bell(){
  if(client&&blocked)throw gate.promise;
  return <NotificationCenter unread={0} items={[]} canApprove/>;
 }
 function Tree(){return <NextIntlClientProvider locale="en" timeZone="Asia/Kuala_Lumpur" messages={en}>
  <ShellApprovalFactsProvider source={source.promise} canOpenApprovalsWithoutAssignment={false}>
   <div data-shell-ready>Shell</div>
   {delayBell?<Suspense fallback={<span data-bell-placeholder/>}><Bell/></Suspense>:<Bell/>}
  </ShellApprovalFactsProvider>
 </NextIntlClientProvider>;}
 const host=document.createElement('div');document.body.append(host);
 host.innerHTML=renderToString(<Tree/>);
 const serverBell=host.querySelector('button')!.outerHTML;
 const errors:string[]=[];let root:Root|undefined;
 try{
  client=true;
  await act(async()=>{root=hydrateRoot(host,<Tree/>,{onRecoverableError(error,info){errors.push(String(error)+'\n'+info.componentStack);}});});
  await act(async()=>{source.resolve({state:'ready',items:[],total,approvalCount:total,claimTotal:0,hasAssignedAttendanceApproval:total>0,hasAssignedApproval:total>0});await source.promise;});
  await act(async()=>{blocked=false;gate.resolve();await gate.promise;});
  const clientBell=host.querySelector('button')!.outerHTML;
  console.log(JSON.stringify({delayBell,total,monolith,serverBell,clientBell,errors}));
  return {errors,label:host.querySelector('button')!.getAttribute('aria-label')};
 }finally{await act(async()=>root?.unmount());host.remove();}
}

describe('approval facts and notification bell hydration ordering',()=>{
 it('hydrates the previous inline bell before approval facts publish',async()=>{
  const result=await probe({delayBell:false,total:3,monolith:true});
  expect(result.errors).toEqual([]);expect(result.label).toContain('3 open tasks');
 });
 it.each([true,false])('hydrates a delayed bell with pending task count without mismatch (monolith=%s)',async monolith=>{
  const result=await probe({delayBell:true,total:3,monolith});
  expect(result.errors).toEqual([]);expect(result.label).toContain('3 open tasks');
 });
 it('hydrates a delayed bell with no assigned task count without mismatch',async()=>{
  const result=await probe({delayBell:true,total:0,monolith:true});
  expect(result.errors).toEqual([]);
 });
});

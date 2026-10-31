/** @vitest-environment jsdom */
/** Finite deferred command fixtures: actual chat surfaces, no server/provider calls or fake progress. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import type {LauncherReply} from '../app/assistant/launcher-actions';
const state=vi.hoisted(()=>({workspace:vi.fn(),launcher:vi.fn()}));
vi.mock('next/navigation',()=>({usePathname:()=>'/leave'}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('../app/assistant/launcher-actions',()=>({askFromWorkspaceAction:state.workspace,askFromLauncherAction:state.launcher}));
import {WorkspaceConversation} from '../components/assistant/workspace-conversation';
import {AssistantLauncher} from '../components/assistant/assistant-launcher';
import {AtelierAskBox} from '../components/atelier-ask-box';
import {ThinkingIndicator} from '../components/assistant/thinking-indicator';
type Surface='Assistant'|'Dashboard'|'Floating messenger';
const surfaces=['Assistant','Dashboard','Floating messenger'] as const;
function show(surface:Surface){
 render(<NextIntlClientProvider locale="en" messages={en}>{surface==='Assistant'
  ?<WorkspaceConversation tasks={[]} fileImport={false}/>
  :surface==='Dashboard'?<AtelierAskBox label="Your question" placeholder="Ask about your work" submitLabel="Ask" suggestions={[]}/>
  :<AssistantLauncher position="bottom-right" hiddenAreas={[]}/>}</NextIntlClientProvider>);
 if(surface==='Floating messenger')fireEvent.click(screen.getByRole('button',{name:en.assistant.launcher.open}));
 const box=screen.getByRole('textbox') as HTMLTextAreaElement;
 fireEvent.change(box,{target:{value:'What is my leave balance?'}});
 fireEvent.click(screen.getByRole('button',{name:surface==='Floating messenger'?en.assistant.launcher.send:surface==='Dashboard'?'Ask':en.assistant.ask}));
 return{box,log:screen.getByRole('log')};
}
function deferred(){
 let resolve!:(value:LauncherReply)=>void,reject!:(reason:unknown)=>void,settled=false;
 const promise=new Promise<LauncherReply>((done,fail)=>{resolve=value=>{settled=true;done(value);};reject=reason=>{settled=true;fail(reason);};});
 return{promise,resolve,reject,finish:()=>{if(!settled)resolve({ok:false,message:'Fixture finished.'});}};
}
beforeEach(()=>{state.workspace.mockReset();state.launcher.mockReset();});afterEach(cleanup);
describe('honest visible thinking state',()=>{
 it.each(Object.entries({en,ms,zh,ta,th,vi:viMessages}))('%s retains a small accessible plain waiting label without decoration',(_locale,messages)=>{
  const label=messages.assistant.workspace.chat.thinking;
  render(<ThinkingIndicator label={label}/>);
  const status=screen.getByRole('status');expect(status).toHaveTextContent(label);expect(status).not.toHaveClass('sr-only');
  expect(status).toHaveAttribute('aria-live','polite');expect(status).toHaveAttribute('aria-atomic','true');
  expect(messages.assistant.launcher.working).toBe(label);
  expect(status).toHaveClass('text-xs','font-normal');expect(status.querySelector('[aria-hidden]')).toBeNull();expect(status.className).not.toMatch(/bg-|rounded|border|shadow/);

 });
 for(const surface of surfaces){
  it.each(['success','refusal','error'] as const)(`${surface} shows Thinking immediately and removes it after %s`,async outcome=>{
   const request=deferred();state.workspace.mockReturnValueOnce(request.promise);state.launcher.mockReturnValueOnce(request.promise);
   try{
    const{box,log}=show(surface),status=within(log).getByRole('status');
    expect(status).toHaveTextContent('Thinking…');expect(status).not.toHaveClass('sr-only');expect(box.readOnly).toBe(true);
    const message=status.closest('[data-message-role=assistant]');if(message)expect(message.className).not.toMatch(/bg-|rounded|border|shadow/);
    expect(log).toHaveTextContent('What is my leave balance?');expect(within(log).queryByRole('progressbar')).toBeNull();
    const active=surface==='Floating messenger'?state.launcher:state.workspace;expect(active).toHaveBeenCalledTimes(1);
    if(outcome==='success')await act(async()=>request.resolve({ok:true,exchangeId:'fictional-answered',answer:<p>You have 12 days of annual leave left.</p>}));
    else if(outcome==='refusal')await act(async()=>request.resolve({ok:false,message:'Please try again.'}));
    else await act(async()=>request.reject(Error('PRIVATE provider details')));
    expect(within(log).queryByRole('status')).toBeNull();expect(box.readOnly).toBe(false);
    if(outcome==='success')expect(within(log).getByText('You have 12 days of annual leave left.')).toBeInTheDocument();
    else expect(within(log).getByRole('alert')).toHaveTextContent(outcome==='refusal'?'Please try again.':surface==='Floating messenger'?en.assistant.launcher.failed:en.assistant.err_provider_error);
    expect(log).not.toHaveTextContent('PRIVATE provider details');
   }finally{await act(async()=>request.finish());}
  });
 }
});

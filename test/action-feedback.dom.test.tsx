import {useState} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {ActionFeedback,ActionFeedbackProvider,useActionFeedback} from '@/components/action-feedback';
import {ActionButton} from '@/components/ui/action-button';

const notices=vi.hoisted(()=>({error:vi.fn()}));
vi.mock('sonner',()=>({toast:notices}));
vi.mock('next-intl',()=>({useTranslations:()=>((key:string)=>(({processing:'Processing…',saving:'Saving…',uploading:'Uploading…',leave:'Leave unfinished action?',uncertain:'Check the result before repeating.',failed:'Action failed.',cancelled:'Cancelled.',success:'Completed.'} as Record<string,string>)[key]??key))}));
vi.mock('react-dom',async importOriginal=>({...await importOriginal<typeof import('react-dom')>(),useFormStatus:()=>({pending:false,data:null,method:null,action:null})}));
afterEach(()=>{cleanup();vi.restoreAllMocks();notices.error.mockClear();});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

describe('owned action processing feedback',()=>{
 it('disables explicit busy actions in every theme, shows a real spinner and keeps another action usable',()=>{
  const click=vi.fn();render(<ActionFeedbackProvider><ActionButton aria-busy actionKind="saving" pendingLabel="Saving…" onClick={click}>Save</ActionButton><ActionButton type="button">Other action</ActionButton></ActionFeedbackProvider>);
  const busy=screen.getByRole('button',{name:'Saving…'});expect(busy).toBeDisabled();expect(busy.querySelector('.action-spinner')).not.toBeNull();fireEvent.click(busy);expect(click).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Other action'})).toBeEnabled();
 });
 it('holds async callbacks pending through settlement and refuses repeated activation without declaring success',async()=>{
  const work=deferred<void>(),click=vi.fn(()=>work.promise);
  render(<ActionFeedbackProvider><ActionButton type="button" actionKind="saving" onClick={click}>Save</ActionButton></ActionFeedbackProvider>);
  fireEvent.click(screen.getByRole('button',{name:'Save'}));fireEvent.click(screen.getByRole('button',{name:'Saving…'}));expect(click).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Completed.')).toBeNull();await act(async()=>work.resolve());expect(screen.getByRole('button',{name:'Save'})).toBeEnabled();expect(screen.queryByText('Completed.')).toBeNull();
 });
 it('warns only for registered important work and removes guards when the operation settles',async()=>{
  const work=deferred<void>(),confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
  render(<ActionFeedbackProvider><ActionButton type="button" guardNavigation actionKind="saving" onClick={()=>work.promise}>Save</ActionButton><a href="/other">Leave</a></ActionFeedbackProvider>);
  fireEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent('Saving…'));
  const before=new Event('beforeunload',{cancelable:true});window.dispatchEvent(before);expect(before.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('link',{name:'Leave'}));expect(confirm).toHaveBeenCalledWith('Leave unfinished action?');await act(async()=>work.resolve());
  const after=new Event('beforeunload',{cancelable:true});window.dispatchEvent(after);expect(after.defaultPrevented).toBe(false);
 });
 it('does not protect a read-only action when navigation protection is disabled',()=>{
  render(<ActionFeedbackProvider><ActionButton type="button" aria-busy guardNavigation={false}>Preview</ActionButton></ActionFeedbackProvider>);
  const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);expect(event.defaultPrevented).toBe(false);
 });
 it('protects only the activated mutation when Save and Preview share a pending flag',async()=>{
  let operation=deferred<void>();
  function Editor(){const [pending,setPending]=useState(false);const run=async()=>{setPending(true);try{await operation.promise;}finally{setPending(false);}};return <><ActionButton type="button" guardNavigation aria-busy={pending} onClick={run}>Save</ActionButton><ActionButton type="button" guardNavigation={false} aria-busy={pending} onClick={run}>Preview</ActionButton></>;}
  render(<ActionFeedbackProvider><Editor/></ActionFeedbackProvider>);fireEvent.click(screen.getByRole('button',{name:'Preview'}));
  const previewLeave=new Event('beforeunload',{cancelable:true});window.dispatchEvent(previewLeave);expect(previewLeave.defaultPrevented).toBe(false);
  await act(async()=>operation.resolve());operation=deferred<void>();fireEvent.click(screen.getByRole('button',{name:'Save'}));
  const saveLeave=new Event('beforeunload',{cancelable:true});window.dispatchEvent(saveLeave);expect(saveLeave.defaultPrevented).toBe(true);
  await act(async()=>operation.resolve());const settled=new Event('beforeunload',{cancelable:true});window.dispatchEvent(settled);expect(settled.defaultPrevented).toBe(false);
 });
 it('accepts a framework-handled redirect without displaying an uncertain-result error',async()=>{
  const redirect=Object.assign(new Error('NEXT_REDIRECT'),{digest:'NEXT_REDIRECT;push;/saved;303;',handled:true});
  render(<ActionFeedbackProvider><ActionButton type="button" guardNavigation onClick={async()=>{throw redirect;}}>Save</ActionButton></ActionFeedbackProvider>);
  fireEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(screen.getByRole('button',{name:'Save'})).toBeEnabled());expect(notices.error).not.toHaveBeenCalled();expect(screen.queryByText('Completed.')).toBeNull();
 });
 it('blocks two native submits in the same event turn and permits a later independent submission',async()=>{
  let count=0;render(<ActionFeedbackProvider><form onSubmit={event=>{event.preventDefault();count++;}}><ActionButton>Save</ActionButton></form></ActionFeedbackProvider>);
  const form=screen.getByRole('button',{name:'Save'}).closest('form')!;
  fireEvent.submit(form);fireEvent.submit(form);expect(count).toBe(1);await act(async()=>{});fireEvent.submit(form);expect(count).toBe(2);
 });
});

describe('explicit action outcomes',()=>{
 it('shows only reported progress and confirmed completion, retaining edited input on a failed or uncertain result',async()=>{
  const work=deferred<{status:'success';value:void}>();let report!:(message:string,progress?:number)=>void;
  function Form(){const feedback=useActionFeedback({kind:'uploading'});return <><input aria-label="Draft" defaultValue="keep me"/><button onClick={()=>feedback.run(async update=>{report=update;return work.promise;})}>Start</button><ActionFeedback state={feedback.state}/></>;}
  render(<ActionFeedbackProvider><Form/></ActionFeedbackProvider>);fireEvent.click(screen.getByRole('button',{name:'Start'}));expect(screen.queryByRole('progressbar')).toBeNull();
  act(()=>report('Receiving attachment',37));expect(screen.getByRole('progressbar')).toHaveAttribute('value','37');expect(screen.queryByText('Completed.')).toBeNull();await act(async()=>work.resolve({status:'success',value:undefined}));expect(screen.getByText('Completed.')).toBeInTheDocument();expect(screen.getByRole('textbox')).toHaveValue('keep me');
 });
 it('clears processing on thrown network failure and requires a status check rather than inventing success',async()=>{
  const work=deferred<{status:'success';value:void}>();
  function Form(){const feedback=useActionFeedback();const [draft,setDraft]=useState('draft');return <><input aria-label="Draft" value={draft} onChange={event=>setDraft(event.target.value)}/><button onClick={()=>feedback.run(()=>work.promise)}>Start</button><ActionFeedback state={feedback.state}/></>;}
  render(<ActionFeedbackProvider><Form/></ActionFeedbackProvider>);fireEvent.click(screen.getByRole('button',{name:'Start'}));await act(async()=>work.reject(new Error('Disconnected')));expect(screen.getByRole('alert')).toHaveTextContent('Check the result before repeating.');expect(screen.queryByText('Completed.')).toBeNull();expect(screen.getByRole('textbox')).toHaveValue('draft');
 });
 it('does not fabricate cancellation for an interrupted request',async()=>{
  function Form(){const feedback=useActionFeedback();return <><button onClick={()=>feedback.run(async()=>({status:'cancelled',message:'Upload cancelled by server'}))}>Cancel</button><ActionFeedback state={feedback.state}/></>;}
  render(<ActionFeedbackProvider><Form/></ActionFeedbackProvider>);fireEvent.click(screen.getByRole('button',{name:'Cancel'}));await waitFor(()=>expect(screen.getByText('Upload cancelled by server')).toBeInTheDocument());
 });
 it('clears the explicit action guard for an accepted redirect without inventing a success outcome',async()=>{
  function Form(){const feedback=useActionFeedback();return <><button onClick={()=>feedback.run(async()=>{throw Object.assign(new Error('NEXT_REDIRECT'),{digest:'NEXT_REDIRECT;push;/saved;303;',handled:true});})}>Save</button><ActionFeedback state={feedback.state}/></>;}
  render(<ActionFeedbackProvider><Form/></ActionFeedbackProvider>);fireEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(screen.getAllByRole('status')).toHaveLength(1));expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByText('Completed.')).toBeNull();
 });

});

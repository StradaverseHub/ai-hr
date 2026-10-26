import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as attempt from '../lib/clock-attempt';
import * as errors from '../mobile/lib/errors';
import { SubmissionJournalUnavailable } from '../mobile/lib/submission-journal';
const employmentId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',actorId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(){
  let owner=1,namespace='https://hr.example.com',control:any;
  const native={AppState:{currentState:'active'}};
  const restored=vi.fn(),apiGet=vi.fn<(path:string,params?:Record<string,string>)=>Promise<any>>(async()=>({actorId,employments:[{employmentId,company:'Own company'}]}));
  const apiPost=vi.fn<(...args:unknown[])=>Promise<any>>(async()=>({kind:'clock',requestId:'request',receipt:null,abandoned:true}));
  const entry:any={kind:'clock',requestId:'request',command:'original command',createdAt:Date.now()};
  const journal={pending:vi.fn(async()=>[entry]),restore:vi.fn(async()=>({command:entry.command})),
    stage:vi.fn(async()=>entry),resolve:vi.fn(async()=>{}),prepareClock:vi.fn(async()=>entry),markAttemptReported:vi.fn(async()=>{}),clockAttempt:vi.fn(async()=>JSON.parse(entry.command))};
  const open=vi.fn(async()=>journal);
  const output={exports:{} as {listOwnedPendingSubmissions:()=>Promise<any[]>;reconcileOwnedPendingSubmission:(item:any,action:string)=>Promise<any>;useSubmissionRecovery:(kind:string,employmentId:string,onRestore:(value:unknown)=>void)=>{
    ready:boolean;error:unknown;prepareClock:(action:string,id:string)=>Promise<unknown>;reportAttempt:(id:string)=>Promise<unknown>;stage:(command:string)=>Promise<unknown>;resolve:(id:string)=>Promise<void>;
  }}};
  runInNewContext(transpileModule(readFileSync('mobile/lib/submission-recovery.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,
    {exports:output.exports,module:output,require:(id:string)=>{
      if(id==='react')return React;if(id==='react-native')return native;
      if(id==='./api')return {apiGet,apiPost};if(id==='./auth')return {authGeneration:()=>owner,assertAuthGeneration:(value:number)=>{if(value!==owner)throw new errors.SessionChangedError();}};
      if(id==='./config')return {identityNamespace:()=>namespace};
      if(id==='./errors')return errors;if(id==='./submission-native')return {openNativeSubmissionJournal:open};
      if(id==='../../lib/clock-attempt')return attempt;
      if(id==='./submission-journal')return {SubmissionJournalUnavailable};throw new Error(id);
    }});
  function Probe({employment=employmentId}:{employment?:string}){
    control=output.exports.useSubmissionRecovery('clock',employment,restored);
    return <span>{control.ready?'ready':control.error?'failed':'loading'}</span>;
  }
  return {Probe,apiGet,apiPost,open,journal,native,entry,restored,control:()=>control,changeAccount:()=>{owner++;},changeNamespace:()=>{namespace='https://another.example.com';},api:output.exports};
}
afterEach(cleanup);
describe('saved preparation recovery',()=>{
  it('refuses an obsolete company profile before saving or reporting an attempt',async()=>{
    const f=fixture();render(<f.Probe/>);await screen.findByText('ready');const previous=f.control();f.changeNamespace();
    await expect(previous.prepareClock('in','request')).rejects.toBeInstanceOf(errors.SessionChangedError);
    await expect(previous.reportAttempt('request')).rejects.toBeInstanceOf(errors.SessionChangedError);
    expect(f.journal.prepareClock).not.toHaveBeenCalled();expect(f.apiPost).not.toHaveBeenCalled();
  });
  it('reports the verified immutable preparation and retains it when the server response is lost',async()=>{
    const f=fixture();f.entry.stage='preparation';f.entry.command=JSON.stringify({requestId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',action:'in',claimedAt:Date.now()});f.entry.requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    render(<f.Probe/>);await screen.findByText('ready');f.apiPost.mockRejectedValueOnce(new errors.UnavailableError());
    await expect(f.control().reportAttempt(f.entry.requestId)).rejects.toBeInstanceOf(errors.UnavailableError);
    expect(f.journal.markAttemptReported).not.toHaveBeenCalled();expect(f.journal.resolve).not.toHaveBeenCalled();
    const receipt={requestId:f.entry.requestId,receivedAt:new Date().toISOString()};f.apiPost.mockResolvedValueOnce(receipt);
    await expect(f.control().reportAttempt(f.entry.requestId)).resolves.toEqual(receipt);
    expect(f.apiPost).toHaveBeenCalledWith('clock-attempts',JSON.parse(f.entry.command),{employmentId});
    expect(f.journal.markAttemptReported).toHaveBeenCalledWith(f.entry.requestId,receipt);expect(f.journal.resolve).not.toHaveBeenCalled();
  });
});
describe('pending inventory and terminal reconciliation',()=>{
  it('lists verified own pending references without decrypting attachments or replaying commands',async()=>{
    const f=fixture(),rows=await f.api.listOwnedPendingSubmissions();
    expect(rows).toEqual([{employmentId,company:'Own company',kind:'clock',requestId:'request',createdAt:expect.any(Number),hasEvidence:false}]);
    expect(rows[0]).not.toHaveProperty('command');expect(f.journal.restore).not.toHaveBeenCalled();expect(f.apiPost).not.toHaveBeenCalled();
  });
  it('keeps a lost discard reply pending, then resolves its confirmed abandonment without resending',async()=>{
    const f=fixture(),[row]=await f.api.listOwnedPendingSubmissions();f.apiPost.mockRejectedValueOnce(new errors.UnavailableError());
    await expect(f.api.reconcileOwnedPendingSubmission(row,'abandon')).rejects.toBeInstanceOf(errors.UnavailableError);
    expect(f.journal.resolve).not.toHaveBeenCalled();
    f.apiGet.mockResolvedValueOnce({kind:'clock',requestId:'request',receipt:null,abandoned:true});
    await f.api.reconcileOwnedPendingSubmission(row,'receipt');expect(f.journal.resolve).toHaveBeenCalledWith('clock','request');
    expect(f.apiPost).toHaveBeenCalledTimes(1);expect(f.apiPost).toHaveBeenCalledWith('submission-abandon',{kind:'clock',requestId:'request'},{employmentId});
  });
  it('never resolves unknown or mismatched receipt references',async()=>{
    const f=fixture(),[row]=await f.api.listOwnedPendingSubmissions();
    f.apiGet.mockResolvedValueOnce({kind:'clock',requestId:'request',receipt:null});await f.api.reconcileOwnedPendingSubmission(row,'receipt');
    expect(f.journal.resolve).not.toHaveBeenCalled();
    f.apiGet.mockResolvedValueOnce({kind:'clock',requestId:'different',receipt:{id:'recorded'}});
    await expect(f.api.reconcileOwnedPendingSubmission(row,'receipt')).rejects.toThrow('Unexpected submission receipt');expect(f.journal.resolve).not.toHaveBeenCalled();
  });
  it('refuses forged employment selectors before any abandonment call',async()=>{
    const f=fixture(),[row]=await f.api.listOwnedPendingSubmissions();
    await expect(f.api.reconcileOwnedPendingSubmission({...row,employmentId:actorId},'abandon')).rejects.toThrow('ownership');
    expect(f.apiPost).not.toHaveBeenCalled();expect(f.journal.resolve).not.toHaveBeenCalled();
  });
  it('does not clean up the previous account after logout during an admitted discard',async()=>{
    const f=fixture(),[row]=await f.api.listOwnedPendingSubmissions();let release!:(value:unknown)=>void;
    f.apiPost.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.api.reconcileOwnedPendingSubmission(row,'abandon');const assertion=expect(pending).rejects.toBeInstanceOf(errors.SessionChangedError);
    await waitFor(()=>expect(f.apiPost).toHaveBeenCalledOnce());f.changeAccount();release({kind:'clock',requestId:'request',receipt:null,abandoned:true});
    await assertion;expect(f.journal.resolve).not.toHaveBeenCalled();
  });
});
describe('submission recovery authorization and foreground boundary',()=>{
  it('hydrates a local claim only after the server verifies actor and employment',async()=>{
    const f=fixture();render(<f.Probe/>);await screen.findByText('ready');
    expect(f.apiGet).toHaveBeenCalledWith('me');
    expect(f.open).toHaveBeenCalledWith({namespace:'https://hr.example.com',actorId,employmentId},expect.any(Function));
    expect(f.restored).toHaveBeenCalledWith({entry:expect.objectContaining({requestId:'request'}),command:'original command'});
    expect(f.journal.stage).not.toHaveBeenCalled();expect(f.journal.resolve).not.toHaveBeenCalled();
  });
  it('does not open another employment, or accept an older server without verified actor identity',async()=>{
    const f=fixture();f.apiGet.mockResolvedValueOnce({actorId:undefined as unknown as string,employments:[{employmentId}]});
    render(<f.Probe/>);await screen.findByText('failed');expect(f.open).not.toHaveBeenCalled();
    cleanup();const other=fixture();render(<other.Probe employment={actorId}/>);
    await screen.findByText('failed');expect(other.open).not.toHaveBeenCalled();
  });
  it('blocks transmission while pending records are still being checked',async()=>{
    const f=fixture();let release!:(value:any)=>void;
    f.apiGet.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));render(<f.Probe/>);
    await expect(f.control().stage('new command')).rejects.toThrow('have not been checked');
    expect(f.journal.stage).not.toHaveBeenCalled();
    await act(async()=>release({actorId,employments:[{employmentId}]}));await screen.findByText('ready');
  });
  it('does not authorize transmission when encryption finishes after backgrounding',async()=>{
    const f=fixture();render(<f.Probe/>);await screen.findByText('ready');
    f.journal.stage.mockImplementationOnce(async()=>{f.native.AppState.currentState='background';return {kind:'clock',requestId:'request',command:'original command',createdAt:Date.now()};});
    await expect(f.control().stage('original command')).rejects.toThrow('Unlock the app');
    expect(f.journal.resolve).not.toHaveBeenCalled();
  });
  it('rejects an obsolete hook immediately after an employment switch',async()=>{
    const f=fixture(),ui=render(<f.Probe/>);await screen.findByText('ready');const obsolete=f.control();
    ui.rerender(<f.Probe employment={actorId}/>);
    await expect(obsolete.stage('original command')).rejects.toBeInstanceOf(errors.SessionChangedError);
    await screen.findByText('failed');expect(f.journal.stage).not.toHaveBeenCalled();
  });
  it('rejects a retained control after its protected screen unmounts',async()=>{
    const f=fixture(),ui=render(<f.Probe/>);await screen.findByText('ready');const obsolete=f.control();ui.unmount();
    await expect(obsolete.stage('original command')).rejects.toBeInstanceOf(errors.SessionChangedError);
    expect(f.journal.stage).not.toHaveBeenCalled();
  });
  it('does not hydrate a stale account and never reuses its verified identity for a new login',async()=>{
    const f=fixture();let release!:(value:any)=>void;
    f.apiGet.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));const ui=render(<f.Probe/>);
    await waitFor(()=>expect(f.apiGet).toHaveBeenCalledTimes(1));f.changeAccount();ui.rerender(<f.Probe/>);
    await screen.findByText('ready');await act(async()=>release({actorId,employments:[{employmentId}]}));
    expect(f.apiGet).toHaveBeenCalledTimes(2);expect(f.restored).toHaveBeenCalledTimes(1);
  });
});

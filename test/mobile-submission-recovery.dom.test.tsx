import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as errors from '../mobile/lib/errors';
import { SubmissionJournalUnavailable } from '../mobile/lib/submission-journal';
const employmentId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',actorId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(){
  let owner=1,control:any;
  const native={AppState:{currentState:'active'}};
  const restored=vi.fn(),apiGet=vi.fn(async()=>({actorId,employments:[{employmentId}]}));
  const entry={kind:'clock',requestId:'request',command:'original command'};
  const journal={pending:vi.fn(async()=>[entry]),restore:vi.fn(async()=>({command:entry.command})),
    stage:vi.fn(async()=>entry),resolve:vi.fn(async()=>{})};
  const open=vi.fn(async()=>journal);
  const output={exports:{} as {useSubmissionRecovery:(kind:string,employmentId:string,onRestore:(value:unknown)=>void)=>{
    ready:boolean;error:unknown;stage:(command:string)=>Promise<unknown>;resolve:(id:string)=>Promise<void>;
  }}};
  runInNewContext(transpileModule(readFileSync('mobile/lib/submission-recovery.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,
    {exports:output.exports,module:output,require:(id:string)=>{
      if(id==='react')return React;if(id==='react-native')return native;
      if(id==='./api')return {apiGet};if(id==='./auth')return {authGeneration:()=>owner,assertAuthGeneration:(value:number)=>{if(value!==owner)throw new errors.SessionChangedError();}};
      if(id==='./config')return {identityNamespace:()=>'https://hr.example.com'};
      if(id==='./errors')return errors;if(id==='./submission-native')return {openNativeSubmissionJournal:open};
      if(id==='./submission-journal')return {SubmissionJournalUnavailable};throw new Error(id);
    }});
  function Probe({employment=employmentId}:{employment?:string}){
    control=output.exports.useSubmissionRecovery('clock',employment,restored);
    return <span>{control.ready?'ready':control.error?'failed':'loading'}</span>;
  }
  return {Probe,apiGet,open,journal,native,restored,control:()=>control,changeAccount:()=>{owner++;}};
}
afterEach(cleanup);
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
    f.journal.stage.mockImplementationOnce(async()=>{f.native.AppState.currentState='background';return {kind:'clock',requestId:'request',command:'original command'};});
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

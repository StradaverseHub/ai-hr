import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JsxEmit,ModuleKind,transpileModule} from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {SignInRequiredError} from '../mobile/lib/errors';

function fixture(){
  let owner=1,queued=0;
  const handlers=new Map<string,()=>void>();
  const item={employmentId:'own',company:'Own company',kind:'clock',requestId:'pending-reference',createdAt:Date.now(),hasEvidence:true};
  const list=vi.fn(async()=>[item]);
  const reconcile=vi.fn<(...args:unknown[])=>Promise<any>>(async()=>({kind:'clock',requestId:item.requestId,receipt:null,abandoned:true}));
  const signOut=vi.fn(async()=>{}),setEmploymentId=vi.fn(),remove=vi.fn(),router={replace:vi.fn(),back:vi.fn()};
  const releasePush=vi.fn(async(..._args:unknown[])=>{});
  const drafts={clock:{employmentId:'own',requestId:item.requestId,photo:{uri:'private-photo'}},leave:null,putClock:vi.fn(),putLeave:vi.fn()};
  let dialog:Array<{style?:string;onPress?:()=>void}>=[];
  const Container=({children}:React.PropsWithChildren)=><div>{children}</div>;
  const Text=({children,accessibilityRole}:React.PropsWithChildren<{accessibilityRole?:string}>)=><span role={accessibilityRole==='alert'?'alert':undefined}>{children}</span>;
  const ports:Record<string,unknown>={
    react:React,'react/jsx-runtime':jsx,'react-native':{Alert:{alert:(_title:string,_body:string,buttons:typeof dialog)=>{dialog=buttons;}}},
    'expo-router':{router},'./design':{DesignText:Text,useTenantDesign:()=>({palette:{text:'black'}})},
    './submission-recovery':{listOwnedPendingSubmissions:list,reconcileOwnedPendingSubmission:reconcile},
    './session':{useSession:()=>({signOut,setEmploymentId})},'./errors':{SignInRequiredError},
    './auth':{authGeneration:()=>owner},'./config':{identityNamespace:()=>'https://hr.example.com'},
    './journey-drafts':{useJourneyDrafts:()=>drafts,removeLocalFile:remove},
    './i18n':{appLocale:()=>'en',t:(key:string,values?:{n:number})=>key==='pendingCount'||key==='offlineSignOutNote'?`${key} ${values?.n}`:key},
    './push-core':{releasePushOnExit:releasePush},
    './offline-clock':{useQueuedOfflinePunches:(isUnlocked:()=>boolean)=>{expect(typeof isUnlocked).toBe('function');return queued;}},
    './ui':{Screen:Container,Card:Container,Muted:Text,Row:()=>null,Title:({children}:React.PropsWithChildren)=><h1>{children}</h1>,
      LoadState:({loading,error}:any)=><span>{loading?'loading':error?'load error':''}</span>,
      Button:({title,onPress,disabled}:any)=>{handlers.set(title,onPress);return <button disabled={disabled} onClick={onPress}>{title}</button>;}},
  };
  const output={exports:{} as {PendingSubmissions:React.ComponentType<{intent?:'review'|'logout'|'company'}>}};
  runInNewContext(transpileModule(readFileSync('mobile/lib/pending-submissions.tsx','utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,
    {module:output,exports:output.exports,Date,require:(name:string)=>{if(name in ports)return ports[name];throw new Error(name);}});
  return {View:output.exports.PendingSubmissions,item,list,reconcile,signOut,setEmploymentId,remove,router,drafts,handlers,releasePush,changeAccount:()=>{owner++;},dialog:()=>dialog,queue:(n:number)=>{queued=n;}};
}
afterEach(cleanup);
describe('pending-aware voluntary exit',()=>{
  it('hides the previous account inventory synchronously and rejects its retained exit callback',async()=>{
    const f=fixture(),ui=render(<f.View intent="logout"/>);await screen.findByText('pendingCount 1');const obsolete=f.handlers.get('pendingKeepLogout')!;
    f.list.mockReturnValueOnce(new Promise(()=>{}));f.changeAccount();ui.rerender(<f.View intent="logout"/>);
    expect(screen.queryByText('pendingAttendance')).toBeNull();act(()=>obsolete());expect(f.signOut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('pendingKeepLogout'));expect(f.signOut).toHaveBeenCalledOnce();
  });
  it('keeps logout available even if local verification never completes',()=>{
    const f=fixture();f.list.mockReturnValueOnce(new Promise(()=>{}));render(<f.View intent="logout"/>);
    fireEvent.click(screen.getByText('pendingKeepLogout'));expect(f.signOut).toHaveBeenCalledOnce();expect(f.reconcile).not.toHaveBeenCalled();
  });
  it('continues an explicitly requested exit when the verified pending count is zero',async()=>{
    const f=fixture();f.list.mockResolvedValueOnce([]);render(<f.View intent="logout"/>);
    await waitFor(()=>expect(f.signOut).toHaveBeenCalledOnce());expect(f.reconcile).not.toHaveBeenCalled();
  });
  it('counts pending requests without replaying, and requires confirmation before server discard',async()=>{
    const f=fixture();render(<f.View/>);await screen.findByText('pendingCount 1');expect(f.reconcile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('pendingDiscard'));expect(f.reconcile).not.toHaveBeenCalled();
    await act(async()=>f.dialog().find(button=>button.style==='destructive')!.onPress!());
    await screen.findByText('pendingDiscarded');expect(f.reconcile).toHaveBeenCalledWith(f.item,'abandon');
    expect(screen.getByText('pendingCount 0')).toBeTruthy();expect(f.drafts.putClock).toHaveBeenCalledWith(null,f.item.requestId);
    expect(f.remove).toHaveBeenCalledWith(f.drafts.clock.photo);
  });
  it('reports an accepted receipt without claiming recorded attendance was discarded',async()=>{
    const f=fixture();f.reconcile.mockResolvedValueOnce({kind:'clock',requestId:f.item.requestId,receipt:{id:'recorded'},abandoned:false});
    render(<f.View/>);await screen.findByText('pendingCount 1');fireEvent.click(screen.getByText('checkReceipt'));
    await screen.findByText('pendingAlreadyRecorded');expect(screen.queryByText('pendingDiscarded')).toBeNull();
  });
  it('keeps an unknown result pending and never removes another employment draft with the same reference',async()=>{
    const f=fixture();f.reconcile.mockResolvedValueOnce({kind:'clock',requestId:f.item.requestId,receipt:null});
    render(<f.View/>);await screen.findByText('pendingCount 1');fireEvent.click(screen.getByText('checkReceipt'));
    await screen.findByText('pendingUnknown');expect(f.drafts.putClock).not.toHaveBeenCalled();expect(screen.getByText('pendingCount 1')).toBeTruthy();
    f.drafts.clock.employmentId='another';fireEvent.click(screen.getByText('checkReceipt'));
    await screen.findByText('pendingDiscarded');expect(f.drafts.putClock).not.toHaveBeenCalled();expect(f.remove).not.toHaveBeenCalled();
  });
  it('reviews the original employment and keeps a company change explicit',async()=>{
    const f=fixture();render(<f.View intent="company"/>);await screen.findByText('pendingCount 1');
    fireEvent.click(screen.getByText('pendingReview'));expect(f.setEmploymentId).toHaveBeenCalledWith('own');expect(f.router.replace).toHaveBeenCalledWith('/');
    fireEvent.click(screen.getByText('pendingKeepCompany'));expect(f.router.replace).toHaveBeenCalledWith('/company');expect(f.signOut).not.toHaveBeenCalled();
    // M10/D8: a company change releases this phone's push binding and reminders (sign-out does it inside the session).
    expect(f.releasePush).toHaveBeenCalledWith('company',null);
  });
  it('notes saved offline punches before sign-out as information: not counted, not discardable, not a blocker',async()=>{
    const f=fixture();f.queue(2);render(<f.View intent="logout"/>);await screen.findByText('pendingCount 1');
    expect(screen.getByText('offlineSignOutNote 2')).toBeTruthy();expect(screen.getAllByText('pendingDiscard')).toHaveLength(1);
    fireEvent.click(screen.getByText('pendingKeepLogout'));expect(f.signOut).toHaveBeenCalledOnce();expect(f.reconcile).not.toHaveBeenCalled();
  });
  it('uses the singular note for one punch and shows none outside sign-out or when nothing is queued',async()=>{
    const f=fixture();f.queue(1);const ui=render(<f.View intent="logout"/>);await screen.findByText('pendingCount 1');
    expect(screen.getByText('offlineSignOutNoteOne')).toBeTruthy();ui.unmount();
    render(<f.View intent="company"/>);await screen.findByText('pendingCount 1');expect(screen.queryByText(/^offlineSignOutNote/)).toBeNull();cleanup();
    const g=fixture();render(<g.View intent="logout"/>);await screen.findByText('pendingCount 1');expect(screen.queryByText(/^offlineSignOutNote/)).toBeNull();
  });
  it('still signs out on its own when no request is pending, even with offline punches queued',async()=>{
    const f=fixture();f.queue(3);f.list.mockResolvedValueOnce([]);render(<f.View intent="logout"/>);
    await waitFor(()=>expect(f.signOut).toHaveBeenCalledOnce());
  });
});

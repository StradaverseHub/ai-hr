/** Shipped screen with native view, dialog, session and HTTP ports replaced. No device acceptance. */
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JsxEmit,ModuleKind,transpileModule} from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {SignInRequiredError,UnavailableError,RequestRejectedError} from '../mobile/lib/errors';
import * as contracts from '../lib/mobile-integrity-contract';
const id='11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const key={keyId:id,originChallengeId:id,platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production',proofKind:'apple_key_proof',nativeKeyBinding:'a'.repeat(64),createdAt:'2026-10-27T00:00:00.000Z',revokedAt:null};
function compile(file:string,ports:Record<string,unknown>){
  const output={exports:{} as any};
  runInNewContext(transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,
    {module:output,exports:output.exports,Date,JSON,Symbol,require:(name:string)=>{if(name in ports)return ports[name];throw new Error(name);}});
  return output.exports;
}
function fixture(){
  let owner=1,namespace='company-one',locale='en',employmentId=id;
  let dialog:Array<{style?:string;onPress?:()=>void}>=[];
  const signOut=vi.fn(async()=>{}),reload=vi.fn(),back=vi.fn();
  const state:{data:any;loading:boolean;error:Error|null;reload:()=>void}={data:{outcome:'keys',items:[key]},loading:false,error:null,reload};
  const me:{data:any;loading:boolean;error:Error|null;reload:()=>void}={data:{employments:[{employmentId:id}]},loading:false,error:null,reload:vi.fn()};
  const revoke=vi.fn<(...args:any[])=>Promise<any>>(async()=>({outcome:'revoked',key:{...key,revokedAt:'2026-10-28T00:00:00.000Z'}}));
  const Container=({children}:React.PropsWithChildren)=><div>{children}</div>;
  const Text=({children,accessibilityRole}:React.PropsWithChildren<{accessibilityRole?:string}>)=><span role={accessibilityRole==='alert'?'alert':undefined}>{children}</span>;
  const useApi=vi.fn((path:string)=>path==='me'?me:state);
  const ports={react:React,'react/jsx-runtime':jsx,'react-native':{Alert:{alert:(_a:string,_b:string,buttons:typeof dialog)=>{dialog=buttons;}}},
    'expo-router':{router:{back}},'./design':{DesignText:Text,useTenantDesign:()=>({palette:{text:'black'}})},
    './api':{useApi},'./integrity-key-recovery':{revokeIntegrityKey:revoke},'./session':{useSession:()=>({employmentId,signOut})},
    './device-enrollment-screen':{DeviceEnrollment:({employmentId}: {employmentId:string})=><div data-testid="device-enrollment" data-employment={employmentId}/>},
    './auth':{authGeneration:()=>owner},'./config':{identityNamespace:()=>namespace},'./errors':{SignInRequiredError,RequestRejectedError},
    './i18n':{appLocale:()=>locale,t:(name:string,vars?:{id:string})=>name+(vars?' '+vars.id:'')},
    './ui':{Screen:Container,Card:Container,Muted:Text,Row:({label,value}:any)=><span>{label} {value}</span>,Title:Container,
      LoadState:({loading,error}:any)=><span>{loading?'loading':error?'load error':''}</span>,
      Button:({title,onPress,disabled}:any)=><button disabled={disabled} onClick={onPress}>{title}</button>},
  };
  return {View:compile('mobile/lib/integrity-keys.tsx',ports).IntegrityKeys as React.ComponentType,state,me,revoke,reload,signOut,useApi,
    confirm:()=>dialog.find(button=>button.style==='destructive')!.onPress!(),dialog:()=>dialog,
    changeOwner:()=>{owner++;},changeConnection:()=>{namespace='company-two';},changeLocale:()=>{locale='ms';},changeEmployment:()=>{employmentId='22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa';}};
}
afterEach(cleanup);
describe('integrity key review and explicit revocation',()=>{
  it('loads inventory without mutation and requires destructive confirmation',async()=>{
    const f=fixture();render(<f.View/>);expect(screen.getByText(id)).toBeTruthy();expect(f.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('integrityRevoke'));expect(f.revoke).not.toHaveBeenCalled();
    await act(async()=>{f.confirm();f.confirm();});
    expect(f.revoke).toHaveBeenCalledExactlyOnceWith(id,key);await screen.findByText('integrityRevoked '+id);
    expect(screen.queryByText('integrityRevoke')).toBeNull();expect(f.reload).toHaveBeenCalledOnce();
  });
  it('rejects a confirmation after the selected employment changes and does not publish an unmounted reply',async()=>{
    const f=fixture();const view=render(<f.View/>);fireEvent.click(screen.getByText('integrityRevoke'));const old=f.confirm;
    f.changeEmployment();view.rerender(<f.View/>);await act(async()=>old());expect(f.revoke).not.toHaveBeenCalled();
    const g=fixture();view.unmount();let finish!:(value:unknown)=>void;g.revoke.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    const next=render(<g.View/>);fireEvent.click(screen.getByText('integrityRevoke'));act(()=>g.confirm());next.unmount();
    await act(async()=>finish({outcome:'revoked',key:{...key,revokedAt:'2026-10-28T00:00:00.000Z'}}));expect(g.reload).not.toHaveBeenCalled();
  });
  it('gates a direct route before mounting private reads when signed out',()=>{
    let status='signedOut';const privateView=vi.fn(()=> <span>private content</span>);
    const Page=compile('mobile/app/integrity-keys.tsx',{'react/jsx-runtime':jsx,'expo-router':{Redirect:()=> <span>sign-in redirect</span>},'../lib/session':{useSession:()=>({status})},'../lib/integrity-keys':{IntegrityKeys:privateView}}).default as React.ComponentType;
    const view=render(<Page/>);expect(screen.getByText('sign-in redirect')).toBeTruthy();expect(privateView).not.toHaveBeenCalled();status='signedIn';view.rerender(<Page/>);expect(screen.getByText('private content')).toBeTruthy();
  });
  it('distinguishes missing prerequisites, initial loading, empty, unavailable and older-server states',()=>{
    const f=fixture();f.me.data=null;f.me.loading=true;const view=render(<f.View/>);expect(screen.queryByText('integrityKeysEmpty')).toBeNull();expect(f.useApi).not.toHaveBeenCalledWith('v2/integrity/keys',expect.anything(),expect.anything());
    f.me.data={employments:[]};f.me.loading=false;view.rerender(<f.View/>);expect(screen.getByText('integrityKeysNoEmployment')).toBeTruthy();
  });
  it('does not call an older server empty or allow a retained key to be revoked while reads fail',()=>{
    const f=fixture();f.state.error=new RequestRejectedError(404);const view=render(<f.View/>);
    expect(screen.getByText('integrityKeysOlderServer')).toBeTruthy();expect(screen.queryByText('integrityKeysEmpty')).toBeNull();expect(screen.queryByText('integrityRevoke')).toBeNull();
    f.state.error=new UnavailableError();view.rerender(<f.View/>);expect((screen.getByText('integrityRevoke') as HTMLButtonElement).disabled).toBe(true);
    f.state.error=null;f.state.data={outcome:'keys',items:[]};view.rerender(<f.View/>);expect(screen.getByText('integrityKeysEmpty')).toBeTruthy();
    f.state.data={outcome:'unavailable',code:'module_unavailable'};view.rerender(<f.View/>);expect(screen.getByText('integrityKeysUnavailable')).toBeTruthy();expect(screen.queryByText('integrityKeysEmpty')).toBeNull();
  });
  it('retains an uncertain key reference, never replays, and confirms only from a later server receipt',async()=>{
    const f=fixture();f.revoke.mockRejectedValueOnce(new UnavailableError());const view=render(<f.View/>);
    fireEvent.click(screen.getByText('integrityRevoke'));await act(async()=>f.confirm());await screen.findByText('integrityRevokeUncertain '+id);
    expect(f.revoke).toHaveBeenCalledOnce();fireEvent.click(screen.getByText('integrityCheckStatus'));expect(f.reload).toHaveBeenCalledOnce();expect(f.revoke).toHaveBeenCalledOnce();
    f.state.data={outcome:'keys',items:[{...key,revokedAt:'2026-10-28T00:00:00.000Z'}]};view.rerender(<f.View/>);
    await screen.findByText('integrityRevoked '+id);expect(screen.queryByText('integrityRevoke')).toBeNull();
    f.state.data={outcome:'keys',items:[key]};view.rerender(<f.View/>);expect(screen.queryByText('integrityRevoke')).toBeNull();
  });
  it.each(['owner','connection','locale'] as const)('refuses a deferred confirmation after %s changes',async change=>{
    const f=fixture();render(<f.View/>);fireEvent.click(screen.getByText('integrityRevoke'));
    if(change==='owner')f.changeOwner();if(change==='connection')f.changeConnection();if(change==='locale')f.changeLocale();
    await act(async()=>f.confirm());expect(f.revoke).not.toHaveBeenCalled();
  });
  it('does not publish or sign out another session from an obsolete reply or after unmount',async()=>{
    const f=fixture();let fail!:(error:Error)=>void;f.revoke.mockReturnValueOnce(new Promise((_,reject)=>{fail=reject;}));
    const view=render(<f.View/>);fireEvent.click(screen.getByText('integrityRevoke'));act(()=>f.confirm());f.changeOwner();
    await act(async()=>fail(new SignInRequiredError()));expect(f.signOut).not.toHaveBeenCalled();expect(f.reload).not.toHaveBeenCalled();
    view.unmount();
  });
  it('distinguishes a server refusal from confirmed revocation',async()=>{
    const f=fixture();f.revoke.mockResolvedValueOnce({outcome:'refused',code:'subject_unavailable'});render(<f.View/>);
    fireEvent.click(screen.getByText('integrityRevoke'));await act(async()=>f.confirm());await screen.findByText('integrityRevokeRefused '+id);expect(screen.queryByText('integrityRevoked '+id)).toBeNull();
  });
});
describe('real recovery command receipt matching',()=>{
  it('uses v2 for Android revocation and exact lookup while preserving enrollment binding',async()=>{
    const android={...key,platform:'android',appId:'ai.hr',environment:null,proofKind:'google_key_generation_proof'};
    const post=vi.fn(async()=>({outcome:'revoked',key:{...android,revokedAt:'2026-10-28T00:00:00.000Z'}}));
    const helper=compile('mobile/lib/integrity-key-recovery.ts',{'../../lib/mobile-integrity-contract':contracts,'./api':{apiPost:post},'./errors':{UnavailableError}});
    await helper.revokeIntegrityKey(id,android);expect(post).toHaveBeenCalledExactlyOnceWith('v2/integrity/revoke',{keyId:id},{employmentId:id});
    post.mockResolvedValueOnce({outcome:'revoked',key:{...android,nativeKeyBinding:'b'.repeat(64),revokedAt:'2026-10-28T00:00:00.000Z'}});
    await expect(helper.revokeIntegrityKey(id,android)).rejects.toBeInstanceOf(UnavailableError);
    await helper.lookupIntegrityKeyReceipt(id,id);expect(post).toHaveBeenLastCalledWith('v2/integrity/key-receipt',{originChallengeId:id},{employmentId:id});
  });
  it('sends only the key ID and rejects another enrollment or a missing revocation timestamp',async()=>{
    const post=vi.fn(async()=>({outcome:'revoked',key:{...key,revokedAt:'2026-10-28T00:00:00.000Z'}}));
    const helper=compile('mobile/lib/integrity-key-recovery.ts',{'../../lib/mobile-integrity-contract':contracts,'./api':{apiPost:post},'./errors':{UnavailableError}});
    await helper.revokeIntegrityKey(id,key);expect(post).toHaveBeenCalledExactlyOnceWith('integrity/revoke',{keyId:id},{employmentId:id});
    for(const changed of [{keyId:'22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},{nativeKeyBinding:'b'.repeat(64)},{revokedAt:null}]){
      post.mockResolvedValueOnce({outcome:'revoked',key:{...key,revokedAt:'2026-10-28T00:00:00.000Z',...changed}} as any);
      await expect(helper.revokeIntegrityKey(id,key)).rejects.toBeInstanceOf(UnavailableError);
    }
  });
});

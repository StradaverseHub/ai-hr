/** Actual shipped UI; SDK/storage/transport are controller ports tested independently. */
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JsxEmit,ModuleKind,transpileModule} from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {DeviceEnrollmentController,DeviceEnrollmentStatus} from '../mobile/lib/device-enrollment-contract';
import {SignInRequiredError,RequestRejectedError,UnavailableError} from '../mobile/lib/errors';
const id='11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type ButtonProps={title:string;disabled?:boolean;onPress:()=>void};
function fixture(platform='ios'){
 let owner=1,namespace='company-one',locale='en',saved:DeviceEnrollmentStatus={status:'empty'};
 let dialog:Array<{style?:string;onPress?:()=>void}>=[];
 const session={status:'signedIn',visible:true,signOut:vi.fn(async()=>{})},changed=vi.fn();
 const capabilities:{data:unknown;loading:boolean;error:Error|null;reload:()=>void}={data:{outcome:'capabilities',protocol:2,platform,features:['key_enrollment'],offline:false},loading:false,error:null,reload:vi.fn()};
 const controller:DeviceEnrollmentController={platform:platform==='android'?'android':'ios',supported:true,
  status:vi.fn(async()=>structuredClone(saved)),
  begin:vi.fn(async()=>{saved={status:'pending',phase:'requested',requestId:other,employmentId:id};return saved;}),
  advance:vi.fn(async()=>{saved={status:'stored_key',keyId:id,revoked:false};return saved;}),
  reconcile:vi.fn(async()=>structuredClone(saved)),revoke:vi.fn(async()=>{saved={status:'stored_key',keyId:id,revoked:true};return saved;}),
 };
 if(platform==='android')controller.replace=vi.fn(async()=>{saved={status:'pending',phase:'requested',requestId:other,employmentId:id};return saved;});
 const checks:Array<()=>boolean>=[];
 const open=vi.fn(async(_id:string,check:()=>boolean)=>{checks.push(check);return controller;});
 const useApi=vi.fn(()=>capabilities);
 const Container=({children}:React.PropsWithChildren)=><div>{children}</div>;
 const Text=({children,accessibilityRole}:React.PropsWithChildren<{accessibilityRole?:string}>)=><span role={accessibilityRole==='alert'?'alert':undefined}>{children}</span>;
 const output={exports:{} as {DeviceEnrollment:React.ComponentType<{employmentId:string;onChanged:()=>void}>}};
 const ports:Record<string,unknown>={react:React,'react/jsx-runtime':jsx,'react-native':{Platform:{OS:platform},Alert:{alert:(_title:string,_message:string,buttons:typeof dialog)=>{dialog=buttons;}}},
  './design':{DesignText:Text},'./api':{useApi},'./session':{useSession:()=>session},'./auth':{authGeneration:()=>owner},'./config':{identityNamespace:()=>namespace},
  './i18n':{appLocale:()=>locale,t:(key:string)=>key},'./errors':{SignInRequiredError,RequestRejectedError},'./device-enrollment':{openOwnedDeviceEnrollment:open},
  './ui':{Card:Container,Muted:Text,SectionLabel:Container,Button:({title,disabled,onPress}:ButtonProps)=><button disabled={disabled} onClick={onPress}>{title}</button>,
   LoadState:({loading,error,onRetry}:{loading:boolean;error:Error|null;onRetry:()=>void})=><>{loading&&<span>capability-loading</span>}{error&&<button onClick={onRetry}>retry-capabilities</button>}</>},
 };
 runInNewContext(transpileModule(readFileSync('mobile/lib/device-enrollment-screen.tsx','utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,
  {module:output,exports:output.exports,JSON,Symbol,require:(name:string)=>{if(name in ports)return ports[name];throw new Error(name);}});
 return {View:output.exports.DeviceEnrollment,session,controller,capabilities,open,checks,changed,useApi,
  saved:(value:DeviceEnrollmentStatus)=>{saved=value;},accept:()=>dialog.find(button=>button.style!=='cancel')!.onPress!,
  changeOwner:()=>{owner++;},changeCompany:()=>{namespace='other-company';},changeLocale:()=>{locale='ms';}};
}
afterEach(cleanup);
describe('explicit device enrollment screen',()=>{
 it('keeps registration disabled by default while reading saved status without mutation',async()=>{
  const f=fixture();f.capabilities.data={outcome:'unavailable',code:'not_configured'};render(<f.View employmentId={id} onChanged={f.changed}/>);
  await screen.findByText('integrityEnrollmentEmpty');expect(screen.getByText('integrityEnrollmentNotConfigured')).toBeTruthy();
  expect(screen.queryByText('integrityEnrollmentStart')).toBeNull();expect(f.controller.begin).not.toHaveBeenCalled();expect(f.controller.advance).not.toHaveBeenCalled();expect(f.controller.reconcile).not.toHaveBeenCalled();
  expect(f.useApi).toHaveBeenCalledWith('v2/integrity/ios/capabilities',{employmentId:id},f.session.signOut);
 });
 it('requires confirmation and prevents double submission before reporting saved registration',async()=>{
  const f=fixture();render(<f.View employmentId={id} onChanged={f.changed}/>);fireEvent.click(await screen.findByText('integrityEnrollmentStart'));
  expect(f.controller.begin).not.toHaveBeenCalled();const confirm=f.accept();await act(async()=>{confirm();confirm();});
  await screen.findByText('integrityEnrollmentSaved');expect(screen.getByRole('alert',{name:'integrityEnrollmentSaved'})).toBeTruthy();expect(f.controller.begin).toHaveBeenCalledOnce();expect(f.controller.advance).toHaveBeenCalledOnce();expect(f.changed).toHaveBeenCalledOnce();
 });
 it('rechecks current capability state when an old confirmation is accepted',async()=>{
  const f=fixture(),view=render(<f.View employmentId={id} onChanged={f.changed}/>);fireEvent.click(await screen.findByText('integrityEnrollmentStart'));const confirm=f.accept();
  f.capabilities.data={outcome:'unavailable',code:'not_configured'};view.rerender(<f.View employmentId={id} onChanged={f.changed}/>);
  await act(async()=>confirm());expect(f.controller.begin).not.toHaveBeenCalled();expect(f.controller.advance).not.toHaveBeenCalled();
 });
 it('does not offer new enrollment from stale capability data, unsupported native support or an older server',async()=>{
  const f=fixture();f.capabilities.error=new UnavailableError();const view=render(<f.View employmentId={id} onChanged={f.changed}/>);
  await screen.findByText('integrityEnrollmentEmpty');expect(screen.queryByText('integrityEnrollmentStart')).toBeNull();
  f.capabilities.error=null;f.controller.supported=false;view.rerender(<f.View employmentId={id} onChanged={f.changed}/>);expect(screen.getByText('integrityEnrollmentUnsupported')).toBeTruthy();expect(screen.queryByText('integrityEnrollmentStart')).toBeNull();
  f.capabilities.error=new RequestRejectedError(404);view.rerender(<f.View employmentId={id} onChanged={f.changed}/>);expect(screen.getByText('integrityEnrollmentOlderServer')).toBeTruthy();
 });
 it('offers receipt-only checking for a previous employment even when rollout is disabled',async()=>{
  const f=fixture();f.saved({status:'pending',phase:'proof_ready',requestId:other,employmentId:other});f.capabilities.data={outcome:'unavailable',code:'not_configured'};
  render(<f.View employmentId={id} onChanged={f.changed}/>);fireEvent.click(await screen.findByText('integrityCheckStatus'));
  await waitFor(()=>expect(f.controller.reconcile).toHaveBeenCalledOnce());expect(screen.getByText('integrityEnrollmentPreviousEmployment')).toBeTruthy();expect(screen.queryByText('integrityEnrollmentContinue')).toBeNull();expect(f.controller.advance).not.toHaveBeenCalled();expect(f.controller.begin).not.toHaveBeenCalled();
 });
 it('preserves a lost-reply pending stage and recovers it through explicit status checking',async()=>{
  const f=fixture();vi.mocked(f.controller.advance).mockImplementationOnce(async()=>{f.saved({status:'pending',phase:'proof_ready',requestId:other,employmentId:id});throw new UnavailableError();});
  render(<f.View employmentId={id} onChanged={f.changed}/>);fireEvent.click(await screen.findByText('integrityEnrollmentStart'));await act(async()=>f.accept()());
  await screen.findByText('integrityEnrollmentUncertain');expect(screen.getByText('integrityEnrollmentPending')).toBeTruthy();expect(f.controller.advance).toHaveBeenCalledOnce();
  vi.mocked(f.controller.reconcile).mockResolvedValueOnce({status:'stored_key',keyId:id,revoked:false});fireEvent.click(screen.getByText('integrityCheckStatus'));
  await screen.findByText('integrityEnrollmentSaved');expect(screen.queryByText('integrityEnrollmentUncertain')).toBeNull();expect(f.controller.advance).toHaveBeenCalledOnce();expect(f.controller.begin).toHaveBeenCalledOnce();
 });
 it('invalidates pre-lock confirmations permanently across unlock and hides cached registration while locked',async()=>{
  const f=fixture(),view=render(<f.View employmentId={id} onChanged={f.changed}/>);fireEvent.click(await screen.findByText('integrityEnrollmentStart'));const confirm=f.accept(),oldCheck=f.checks[0];
  f.session.status='locked';f.session.visible=false;view.rerender(<f.View employmentId={id} onChanged={f.changed}/>);expect(screen.queryByText('integrityEnrollmentTitle')).toBeNull();expect(oldCheck()).toBe(false);
  f.session.status='signedIn';f.session.visible=true;view.rerender(<f.View employmentId={id} onChanged={f.changed}/>);await screen.findByText('integrityEnrollmentStart');
  expect(oldCheck()).toBe(false);await act(async()=>confirm());expect(f.controller.begin).not.toHaveBeenCalled();expect(f.open).toHaveBeenCalledTimes(2);
 });
 it.each(['owner','company','locale','employment'] as const)('refuses a stale confirmation after %s changes',async(kind)=>{
  const f=fixture(),view=render(<f.View employmentId={id} onChanged={f.changed}/>);fireEvent.click(await screen.findByText('integrityEnrollmentStart'));const confirm=f.accept();
  if(kind==='owner')f.changeOwner();if(kind==='company')f.changeCompany();if(kind==='locale')f.changeLocale();
  view.rerender(<f.View employmentId={kind==='employment'?other:id} onChanged={f.changed}/>);await act(async()=>confirm());expect(f.controller.begin).not.toHaveBeenCalled();
 });
 it('does not publish a completed command after unmount',async()=>{
  const f=fixture();let finish!:(value:DeviceEnrollmentStatus)=>void;
  vi.mocked(f.controller.advance).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<f.View employmentId={id} onChanged={f.changed}/>);fireEvent.click(await screen.findByText('integrityEnrollmentStart'));await act(async()=>f.accept()());
  await waitFor(()=>expect(f.controller.advance).toHaveBeenCalledOnce());view.unmount();await act(async()=>finish({status:'stored_key',keyId:id,revoked:false}));expect(f.changed).not.toHaveBeenCalled();expect(f.session.signOut).not.toHaveBeenCalled();
 });
 it('does not replace an unreadable journal with an empty setup flow or expose private errors',async()=>{
  const f=fixture();f.open.mockRejectedValueOnce(new Error('private-native-storage-path'));render(<f.View employmentId={id} onChanged={f.changed}/>);
  await screen.findByText('integrityEnrollmentStorageUnavailable');expect(screen.queryByText('integrityEnrollmentStart')).toBeNull();expect(screen.queryByText('private-native-storage-path')).toBeNull();
  f.saved({status:'pending',phase:'key_requested',requestId:other,employmentId:id});fireEvent.click(screen.getByText('retry'));await screen.findByText('integrityEnrollmentPending');expect(f.controller.begin).not.toHaveBeenCalled();
 });
 it('permits explicit revocation recovery independently of enrollment rollout',async()=>{
  const f=fixture();f.capabilities.data={outcome:'unavailable',code:'not_configured'};f.saved({status:'revocation_pending',keyId:id});render(<f.View employmentId={id} onChanged={f.changed}/>);
  fireEvent.click(await screen.findByText('integrityCheckStatus'));await waitFor(()=>expect(f.controller.reconcile).toHaveBeenCalledOnce());expect(f.controller.revoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('integrityEnrollmentRetryRevoke'));await act(async()=>f.accept()());await screen.findByText('integrityEnrollmentRevoked');expect(f.controller.revoke).toHaveBeenCalledOnce();
 });
 it('requires an explicit Android replacement action for a known revoked registration',async()=>{
  const f=fixture('android');f.saved({status:'stored_key',keyId:id,revoked:true});render(<f.View employmentId={id} onChanged={f.changed}/>);
  fireEvent.click(await screen.findByText('integrityEnrollmentReplace'));expect(f.controller.replace).not.toHaveBeenCalled();await act(async()=>f.accept()());await screen.findByText('integrityEnrollmentSaved');expect(f.controller.replace).toHaveBeenCalledOnce();expect(f.controller.advance).toHaveBeenCalledOnce();
 });
 it('does not create an Android compatibility path for an unsupported native platform',()=>{
  const f=fixture('harmony');render(<f.View employmentId={id} onChanged={f.changed}/>);expect(screen.getByText('integrityEnrollmentUnsupported')).toBeTruthy();expect(f.open).not.toHaveBeenCalled();expect(f.useApi).not.toHaveBeenCalled();
 });
 it.each([false,true])('handles authentication refusal only for the still-current account (changed=%s)',async(changed)=>{
  const f=fixture();f.saved({status:'pending',phase:'proof_ready',requestId:other,employmentId:id});let reject!:(error:Error)=>void;
  vi.mocked(f.controller.reconcile).mockImplementationOnce(()=>new Promise((_resolve,no)=>{reject=no;}));
  const view=render(<f.View employmentId={id} onChanged={f.changed}/>);fireEvent.click(await screen.findByText('integrityCheckStatus'));
  await waitFor(()=>expect(f.controller.reconcile).toHaveBeenCalledOnce());
  if(changed){f.changeOwner();view.rerender(<f.View employmentId={id} onChanged={f.changed}/>);}
  await act(async()=>reject(new SignInRequiredError()));
  await waitFor(()=>expect(f.session.signOut).toHaveBeenCalledTimes(changed?0:1));
 });
});

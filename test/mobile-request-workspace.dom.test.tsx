import { inAppAlertPorts } from './helpers/in-app-alert-ports';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JsxEmit,ModuleKind,transpileModule} from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import * as contract from '../lib/mobile-api/v2/request-workspaces';
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(kind:'profile'|'resignation'|'noticeAcknowledgement'){
 const post=vi.fn().mockResolvedValue({outcome:'accepted',status:kind==='noticeAcknowledgement'?'acknowledged':'approved'}),alert=vi.fn(),reload=vi.fn();let seq=0;
 const copy=Object.fromEntries(['before','after','lastDay','consequence','acknowledge','version','sender','published','done'].map(s=>[s,s]));
 const View=({children}:any)=><div>{children}</div>;
 const base={kind,id:ID,subject:'Synthetic subject',documents:[{ref:'sample',name:'Evidence'}],expected:{digest:'a'.repeat(64)}};
 const workspace=kind==='profile'?{...base,lines:[{key:'phone',label:'Telephone',record:null,before:'Old phone',after:'New phone'}]}:kind==='resignation'?{...base,lastWorkingDay:'2026-12-31',reason:'Synthetic reason'}:{...base,body:'Full notice body\nSecond paragraph',contentVersion:3,publishedBy:'Synthetic HR',publishedAt:'2026-11-01T00:00:00Z'};
 const ports:Record<string,unknown>={react:React,'react/jsx-runtime':jsx,'react-native':{Alert:{alert},View,TextInput:({accessibilityLabel,value,onChangeText}:any)=><input aria-label={accessibilityLabel} value={value} onChange={e=>onChangeText(e.target.value)}/>},'expo-router':{router:{replace:vi.fn()}},'expo-crypto':{randomUUID:()=>`0000000${++seq}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`},'../../lib/mobile-api/v2/request-workspaces':contract,'./api':{apiPostV2:post,useApiV2:()=>({loading:false,error:null,reload,data:{outcome:'found',workspace}})},'./auth':{authGeneration:()=>1,assertAuthGeneration:()=>{}},'./session':{useSession:()=>({signOut:vi.fn()})},'./errors':{SignInRequiredError:class extends Error{},RequestRejectedError:class extends Error{}},'./design':{DesignText:View,useTenantDesign:()=>({palette:{text:'#fff',border:'#333'}})},'./ui':{Screen:View,Title:View,Card:View,Muted:View,Row:({label,value}:any)=><p>{label}: {value}</p>,LoadState:()=>null,Button:({title,disabled,onPress}:any)=><button disabled={disabled} onClick={onPress}>{title}</button>},'./approval-document':{ApprovalDocument:({name}:any)=><span>{name}</span>},'./i18n':{t:(s:string)=>s},'./request-workspace-copy':{requestCopy:()=>copy}};
 const module={exports:{} as any};runInNewContext(transpileModule(readFileSync('mobile/lib/request-workspace.tsx','utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:(key:string)=>{if (key === './in-app-alert') return inAppAlertPorts(ports['react-native']); if(key in ports)return ports[key];throw Error('Missing '+key);},Error});
 const confirm=async()=>{await act(async()=>alert.mock.calls[0][2][1].onPress());};return {...module.exports,post,alert,confirm};
}
afterEach(cleanup);
describe('native request workflow forms',()=>{
 it('shows exact before/after values and requires a profile rejection reason',async()=>{
  const f=fixture('profile');render(<f.RequestWorkspaceScreen kind="profile" id={ID}/>);expect(screen.getByText('before: Old phone')).toBeTruthy();expect(screen.getByText('after: New phone')).toBeTruthy();expect(screen.getByText('Evidence')).toBeTruthy();expect((screen.getByRole('button',{name:'approvalReject'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('approvalReason'),{target:{value:'Document does not match'}});fireEvent.click(screen.getByRole('button',{name:'approvalReject'}));expect(f.post).not.toHaveBeenCalled();await f.confirm();expect(f.post.mock.calls[0][2]).toMatchObject({action:'reject',reason:'Document does not match',expected:{digest:'a'.repeat(64)}});
 });
 it('names the last working day and actual employment consequence in the resignation confirmation',async()=>{
  const f=fixture('resignation');render(<f.RequestWorkspaceScreen kind="resignation" id={ID}/>);fireEvent.click(screen.getByRole('button',{name:'approvalApprove'}));expect(f.alert.mock.calls[0][1]).toContain('2026-12-31');expect(f.alert.mock.calls[0][1]).toContain('consequence');expect(f.post).not.toHaveBeenCalled();await f.confirm();expect(f.post.mock.calls[0][2].action).toBe('approve');
 });
 it('shows full notice text/version and offers acknowledgement, with the same reference for uncertain retry',async()=>{
  const f=fixture('noticeAcknowledgement');f.post.mockRejectedValueOnce(new Error('Lost answer'));render(<f.RequestWorkspaceScreen kind="noticeAcknowledgement" id={ID}/>);expect(screen.getByText(/Full notice body/)).toBeTruthy();expect(screen.getByText('version: 3')).toBeTruthy();expect(screen.queryByRole('button',{name:'approvalApprove'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'acknowledge'}));await f.confirm();await act(async()=>fireEvent.click(screen.getByRole('button',{name:'approvalRetry'})));expect(f.post.mock.calls[0][2]).toEqual(f.post.mock.calls[1][2]);expect(f.post.mock.calls[0][2].action).toBe('acknowledge');
 });
 it('does not submit a dialog retained after leaving the workspace',async()=>{
  const f=fixture('profile'),ui=render(<f.RequestWorkspaceScreen kind="profile" id={ID}/>);fireEvent.click(screen.getByRole('button',{name:'approvalApprove'}));ui.unmount();await f.confirm();expect(f.post).not.toHaveBeenCalled();
 });
 it('validates composite notice references independently of arbitrary route strings',()=>{
  expect(contract.validRequestReference('noticeAcknowledgement',`${ID}:${ID}:3`)).toBe(true);expect(contract.validRequestReference('profile',`${ID}:${ID}:3`)).toBe(false);expect(contract.validRequestReference('noticeAcknowledgement',`${ID}:${ID}:0`)).toBe(false);expect(contract.validRequestReference('profile','../settings')).toBe(false);
 });
});

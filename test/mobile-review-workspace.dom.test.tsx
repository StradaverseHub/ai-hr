import { inAppAlertPorts } from './helpers/in-app-alert-ports';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JsxEmit,ModuleKind,transpileModule} from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import * as contract from '../lib/mobile-api/v2/review-workspaces';
import {TERMINATION_REASONS} from '../app/approvals/review-decide-fields';
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function load(file:string,ports:Record<string,unknown>){const module={exports:{} as any};runInNewContext(transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:(key:string)=>{if(key==='react')return React;if(key==='react/jsx-runtime')return jsx;if (key === './in-app-alert') return inAppAlertPorts(ports['react-native']); if(key in ports)return ports[key];throw Error('Missing '+key);},Error});return module.exports;}
function fixture(kind:'managerReview'|'hrReview'='managerReview'){
 const post=vi.fn().mockResolvedValue({outcome:'accepted',status:kind==='managerReview'?'pending_hr':'completed'}),alert=vi.fn(),reload=vi.fn(),signOut=vi.fn();
 const copy=Object.fromEntries(['advisory','due','recommendation','managerComments','comments','extension','recommend_confirm','recommend_extend','recommend_terminate','confirm','extend','terminate','submit','next','done','type',...contract.REVIEW_TERMINATION_REASONS].map(s=>[s,s]));
 const View=({children}:any)=><div>{children}</div>;
 const ui={Screen:View,Title:View,Card:View,Muted:View,Row:({label,value}:any)=><p>{label}: {value}</p>,LoadState:()=>null,Button:({title,disabled,onPress}:any)=><button disabled={disabled} onClick={onPress}>{title}</button>,Chip:({title,disabled,onPress}:any)=><button disabled={disabled} onClick={onPress}>{title}</button>};
 const errors={SignInRequiredError:class extends Error{},RequestRejectedError:class extends Error{}};
 let seq=0;
 const native={Alert:{alert},View,TextInput:({accessibilityLabel,value,onChangeText,editable}:any)=><input aria-label={accessibilityLabel} value={value} disabled={!editable} onChange={e=>onChangeText(e.target.value)}/>};
 const {ReviewWorkspaceScreen}=load('mobile/lib/review-workspace.tsx',{'react-native':native,'expo-router':{router:{replace:vi.fn()}},'expo-crypto':{randomUUID:()=>`0000000${++seq}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`},'../../lib/mobile-api/v2/review-workspaces':contract,'./api':{apiPostV2:post,useApiV2:()=>({loading:false,error:null,reload,data:{outcome:'found',workspace:{kind,id:ID,subject:{name:'Synthetic employee',code:'E1'},reviewType:'probation',endDate:'2026-12-01',dueDate:'2026-11-01',managerRecommendation:'recommend_extend',managerComments:'Observe performance',expected:{status:kind==='managerReview'?'pending_manager':'pending_hr'}}}})},'./auth':{authGeneration:()=>1,assertAuthGeneration:()=>{}},'./session':{useSession:()=>({signOut})},'./errors':errors,'./design':{DesignText:View,useTenantDesign:()=>({palette:{text:'#fff',border:'#222',muted:'#aaa'}})},'./ui':ui,'./i18n':{t:(s:string)=>s},'./review-workspace-copy':{reviewCopy:()=>copy},'./leave-request-form':{PickerField:({label,value,onChange}:any)=><input aria-label={label} value={value??''} onChange={e=>onChange(e.target.value)}/>}});
 const confirm=async()=>{await act(async()=>alert.mock.calls[0][2][1].onPress());};
 return {ReviewWorkspaceScreen,post,alert,confirm,reload};
}
afterEach(cleanup);
describe('native employment review forms',()=>{
 it('offers manager recommendations and sends only after explicit confirmation',async()=>{
  const f=fixture();render(<f.ReviewWorkspaceScreen kind="managerReview" id={ID}/>);
  expect(screen.queryByRole('button',{name:'terminate'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'recommend_extend'}));fireEvent.change(screen.getByLabelText('comments'),{target:{value:'Needs time'}});
  fireEvent.click(screen.getByRole('button',{name:'submit'}));expect(f.post).not.toHaveBeenCalled();await f.confirm();
  expect(f.post.mock.calls[0][2]).toMatchObject({action:'recommend_extend',comments:'Needs time',expected:{status:'pending_manager'}});expect(screen.getByText('next')).toBeTruthy();
 });
 it('requires a date only for HR extension and omits cleared fields after changing action',async()=>{
  const f=fixture('hrReview');render(<f.ReviewWorkspaceScreen kind="hrReview" id={ID}/>);
  fireEvent.click(screen.getByRole('button',{name:'extend'}));expect((screen.getByRole('button',{name:'submit'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('extension'),{target:{value:'2027-01-31'}});fireEvent.change(screen.getByLabelText('comments'),{target:{value:'Prior extension'}});
  fireEvent.click(screen.getByRole('button',{name:'confirm'}));expect(screen.queryByLabelText('extension')).toBeNull();expect(screen.queryByLabelText('comments')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'submit'}));await f.confirm();expect(f.post.mock.calls[0][2]).toMatchObject({action:'confirm'});expect(f.post.mock.calls[0][2].extendToDate).toBeUndefined();expect(f.post.mock.calls[0][2].comments).toBeUndefined();
 });
 it('requires the existing termination classification and retries an uncertain result under the same reference',async()=>{
  const f=fixture('hrReview');f.post.mockRejectedValueOnce(new Error('lost response'));
  render(<f.ReviewWorkspaceScreen kind="hrReview" id={ID}/>);fireEvent.click(screen.getByRole('button',{name:'terminate'}));expect((screen.getByRole('button',{name:'submit'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'contract_end'}));fireEvent.click(screen.getByRole('button',{name:'submit'}));await f.confirm();await act(async()=>fireEvent.click(screen.getByRole('button',{name:'approvalRetry'})));
  expect(f.post.mock.calls[0][2]).toEqual(f.post.mock.calls[1][2]);expect(f.post.mock.calls[0][2].terminationReason).toBe('contract_end');
 });
 it('does not submit a confirmation retained after leaving the workspace',async()=>{
  const f=fixture();const ui=render(<f.ReviewWorkspaceScreen kind="managerReview" id={ID}/>);fireEvent.click(screen.getByRole('button',{name:'recommend_confirm'}));fireEvent.click(screen.getByRole('button',{name:'submit'}));ui.unmount();await f.confirm();expect(f.post).not.toHaveBeenCalled();
 });
 it('shares the web termination vocabulary and rejects missing/irrelevant fields or impossible dates',()=>{
  expect([...contract.REVIEW_TERMINATION_REASONS]).toEqual([...TERMINATION_REASONS]);
  const base={requestId:ID,expected:{status:'pending_hr'}};
  expect(contract.ReviewWorkspaceCommand.safeParse({...base,action:'terminate'}).success).toBe(false);
  expect(contract.ReviewWorkspaceCommand.safeParse({...base,action:'confirm',extendToDate:'2027-01-01'}).success).toBe(false);
  expect(contract.ReviewWorkspaceCommand.safeParse({...base,action:'extend',extendToDate:'2027-02-30'}).success).toBe(false);
 });
});

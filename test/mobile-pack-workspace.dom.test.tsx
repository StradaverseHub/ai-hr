import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JsxEmit,ModuleKind,transpileModule} from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import * as contract from '../lib/mobile-api/v2/pack-workspaces';
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(){
 const post=vi.fn().mockResolvedValue({outcome:'accepted',status:'recorded'}),alert=vi.fn(),reload=vi.fn();let generation=1;let blur=()=>{};
 const View=({children}:any)=><div>{children}</div>,Button=({title,disabled,onPress}:any)=><button disabled={disabled} onClick={onPress}>{title}</button>;
 const workspace={kind:'assessmentWork',id:ID,today:'2026-11-01',revision:3,title:'Synthetic assessment',blocks:[{id:'facts',title:'Employee evidence',rows:[{label:'Complete evidence',value:'Evidence is shown without a line clamp'}]}],documents:[{id:ID,name:'Supporting evidence.pdf'}],expected:{digest:'a'.repeat(64)},actions:[{id:'moderate',label:'Submit KPI moderation',consequence:'Record the canonical decision',fields:[{key:'actual',label:'Moderated actual',kind:'number',value:0,required:true},{key:'note',label:'Moderation note',kind:'text',value:'',required:true},{key:'band',label:'Band',kind:'choice',value:null,required:true,options:[{value:'ME',label:'Meets expectations'}]}]}]};
 const ports:Record<string,unknown>={'react':React,'react/jsx-runtime':jsx,'react-native':{View,TextInput:({accessibilityLabel,value,onChangeText,editable}:any)=><input aria-label={accessibilityLabel} value={value} disabled={!editable} onChange={e=>onChangeText(e.target.value)}/>,Alert:{alert},FlatList:({data,renderItem,ListHeaderComponent,ListFooterComponent}:any)=><div>{ListHeaderComponent}{data.map((item:any)=><div key={item.id}>{renderItem({item})}</div>)}{ListFooterComponent}</div>},'react-native-safe-area-context':{SafeAreaView:View},'expo-router':{useFocusEffect:(effect:()=>()=>void)=>React.useEffect(()=>{const off=effect();blur=off;return off;},[effect]),router:{replace:vi.fn()},Redirect:()=>null},'expo-crypto':{randomUUID:()=>ID},'../../lib/mobile-api/v2/pack-workspaces':contract,'./api':{useApiV2:()=>({loading:false,error:null,reload,data:{outcome:'found',workspace}}),apiPostV2:post,apiDownload:vi.fn(),v2Download:vi.fn()},'./auth':{authGeneration:()=>generation,assertAuthGeneration:()=>{}},'./session':{useSession:()=>({status:'signedIn',signOut:vi.fn()})},'./errors':{SignInRequiredError:class extends Error{},RequestRejectedError:class extends Error{}},'./design':{Atmosphere:()=>null,DesignText:View,useTenantDesign:()=>({palette:{text:'#fff',border:'#333'}})},'./ui':{Screen:View,Title:View,Card:View,Row:({label,value}:any)=><p>{label}: {value}</p>,Muted:View,Button,Chip:Button,HeaderBack:()=>null,LoadState:()=>null},'./leave-request-form':{PickerField:()=>null},'./approval-document':{ApprovalDocument:({name}:any)=><p>{name}</p>},'./i18n':{t:(s:string)=>s},'./request-workspace-copy':{requestCopy:()=>({done:'Recorded'})}};
 const module={exports:{} as any};runInNewContext(transpileModule(readFileSync('mobile/lib/pack-workspace.tsx','utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:(key:string)=>{if(key in ports)return ports[key];throw Error('Missing '+key);},Error,Object,Number});
 function fill(){fireEvent.click(screen.getByText('Submit KPI moderation'));fireEvent.change(screen.getByLabelText('Moderation note'),{target:{value:'Verified outcome'}});fireEvent.click(screen.getByText('Meets expectations'));}
 return {Component:module.exports.PackWorkspaceScreen,post,alert,reload,fill,setGeneration:(n:number)=>{generation=n;},blur:()=>blur()};
}
afterEach(cleanup);
describe('native pack review screen',()=>{
 it('shows full facts/documents and requires complete inputs before confirming typed values',async()=>{
  const f=fixture();render(<f.Component kind="assessmentWork" id={ID}/>);expect(screen.getByText(/Evidence is shown/)).toBeTruthy();expect(screen.getByText('Supporting evidence.pdf')).toBeTruthy();
  fireEvent.click(screen.getByText('Submit KPI moderation'));expect((screen.getByText('confirmAction') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Moderation note'),{target:{value:'Verified outcome'}});fireEvent.click(screen.getByText('Meets expectations'));fireEvent.click(screen.getByText('confirmAction'));expect(f.post).not.toHaveBeenCalled();
  expect(f.alert.mock.calls[0][1]).toContain('Record the canonical decision');await act(async()=>f.alert.mock.calls[0][2][1].onPress());
  expect(f.post.mock.calls[0][2]).toMatchObject({action:'moderate',values:{actual:0,note:'Verified outcome',band:'ME'},expected:{digest:'a'.repeat(64)}});expect(screen.getByText('Recorded')).toBeTruthy();
 });
 it('retries an uncertain command with the same sealed request and values',async()=>{
  const f=fixture();f.post.mockRejectedValueOnce(Error('lost reply'));render(<f.Component kind="assessmentWork" id={ID}/>);f.fill();fireEvent.click(screen.getByText('confirmAction'));await act(async()=>f.alert.mock.calls[0][2][1].onPress());
  await act(async()=>fireEvent.click(screen.getByText('approvalRetry')));expect(f.post).toHaveBeenCalledTimes(2);expect(f.post.mock.calls[0][2]).toEqual(f.post.mock.calls[1][2]);
 });
 it('a retained confirmation cannot submit after unmount or account change',async()=>{
  const f=fixture(),r=render(<f.Component kind="assessmentWork" id={ID}/>);f.fill();fireEvent.click(screen.getByText('confirmAction'));f.blur();await act(async()=>f.alert.mock.calls[0][2][1].onPress());expect(f.post).not.toHaveBeenCalled();r.unmount();
  const g=fixture();render(<g.Component kind="assessmentWork" id={ID}/>);g.fill();fireEvent.click(screen.getByText('confirmAction'));g.setGeneration(2);await act(async()=>g.alert.mock.calls[0][2][1].onPress());expect(g.post).not.toHaveBeenCalled();
 });
});

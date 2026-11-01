import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JsxEmit,ModuleKind,transpileModule} from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
function fixture(){
 let change:(s:string)=>void=()=>{},blur:()=>void=()=>{},generation=1;
 const View=({children}:any)=><div>{children}</div>;
 const PDF=({uri,page,onDocumentLoad,onDocumentError}:any)=>{React.useEffect(()=>{onDocumentLoad({nativeEvent:{pages:3}});},[]);return <div><span>{`PDF:${uri}:${page}`}</span><button onClick={onDocumentError}>native-error</button></div>;};
 const module={exports:{} as any};
 const ports:Record<string,unknown>={'expo-router':{useFocusEffect:(cb:()=>()=>void)=>React.useEffect(()=>{blur=cb();return blur;},[])},'react':React,'react/jsx-runtime':jsx,'react-native':{View,Image:({source}:any)=><img alt="receipt" src={source.uri}/>,useWindowDimensions:()=>({width:320,height:640}),AppState:{currentState:'active',addEventListener:(_s:string,fn:any)=>{change=fn;return {remove:vi.fn()};}}},expo:{requireNativeView:()=>PDF},'./auth':{authGeneration:()=>generation},'./errors':{SignInRequiredError:class extends Error{}},'./ui':{Muted:View,Button:({title,accessibilityLabel,disabled,onPress}:any)=><button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>{title}</button>},'./i18n':{appLocale:()=> 'en',t:(s:string)=>s}};
 runInNewContext(transpileModule(readFileSync('mobile/lib/approval-document.tsx','utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:(key:string)=>{if(key in ports)return ports[key];throw Error('Missing '+key);},Error});
 return {...module.exports,background:()=>act(()=>change('background')),blur:()=>act(()=>blur()),switchAccount:()=>{generation++;}};
}
const document=()=>({uri:'file:///private/cache/aihr-protected/random.pdf',mimeType:'application/pdf',size:200,delete:vi.fn()});
afterEach(cleanup);
describe('protected approval document lifecycle',()=>{
 it('renders a local PDF, pages in-app and deletes it on close without any sharing action',async()=>{
  const f=fixture(),doc=document(),open=vi.fn().mockResolvedValue({outcome:'file',document:doc});
  render(<f.ApprovalDocument name="Receipt" open={open} onSignInRequired={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'View: Receipt'}));
  await screen.findByText(`PDF:${doc.uri}:0`);expect(doc.delete).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button',{name:'Next page'}));expect(screen.getByText(`PDF:${doc.uri}:1`)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Close'}));expect(doc.delete).toHaveBeenCalledTimes(1);expect(screen.queryByText(/^PDF:/)).toBeNull();
 });
 it('deletes an open document when backgrounded and never restores its stale URI',async()=>{
  const f=fixture(),doc=document();render(<f.ApprovalDocument name="Receipt" open={async()=>({outcome:'file',document:doc})} onSignInRequired={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'View: Receipt'}));await screen.findByText(/^PDF:/);f.background();expect(doc.delete).toHaveBeenCalledTimes(1);expect(screen.queryByText(/^PDF:/)).toBeNull();
 });
 it.each(['background','unmount','account','blur'] as const)('deletes a late download after %s',async(reason)=>{
  const f=fixture(),doc=document();let resolve!:(v:unknown)=>void;const pending=new Promise<any>(yes=>{resolve=yes;});
  const ui=render(<f.ApprovalDocument name="Receipt" open={()=>pending} onSignInRequired={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'View: Receipt'}));
  if(reason==='background')f.background();else if(reason==='unmount')ui.unmount();else if(reason==='blur')f.blur();else f.switchAccount();
  await act(async()=>resolve({outcome:'file',document:doc}));expect(doc.delete).toHaveBeenCalledTimes(1);expect(screen.queryByText(/^PDF:/)).toBeNull();
 });
 it('deletes a file that the native parser refuses and offers a truthful failure',async()=>{
  const f=fixture(),doc=document();render(<f.ApprovalDocument name="Receipt" open={async()=>({outcome:'file',document:doc})} onSignInRequired={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'View: Receipt'}));await screen.findByText(/^PDF:/);fireEvent.click(screen.getByRole('button',{name:'native-error'}));expect(doc.delete).toHaveBeenCalledTimes(1);expect(screen.getByText('genericError')).toBeTruthy();
 });
});

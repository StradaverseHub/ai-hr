/** Render the shipped native controls with deterministic OS ports. Device gestures still need device QA. */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOBILE_DESIGN, MOBILE_ACCENTS } from '../lib/mobile-design';
function load(path:string,ports:Record<string,unknown>){const module={exports:{} as any};runInNewContext(transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,{exports:module.exports,module,require:(id:string)=>{if(id==='react')return React;if(id==='react/jsx-runtime')return jsx;if(id in ports)return ports[id];throw new Error('Missing port '+id);}});return module.exports;}
afterEach(cleanup);
function slide(){
  let handlers:any;const timing=vi.fn(()=>({start(){}}));
  function View(p:any){return <div onClick={p.onLayout?()=>p.onLayout({nativeEvent:{layout:{width:320}}}):undefined}>{p.children}</div>;}
  function Pressable(p:any){return <button disabled={p.disabled} aria-label={p.accessibilityLabel} onClick={p.onPress}>{p.children}</button>;}
  const port={View,Text:({children}:any)=><span>{children}</span>,Pressable,Animated:{View,Value:class {setValue(){}},timing},Easing:{out:(v:unknown)=>v,quad:1},PanResponder:{create:(v:any)=>{handlers=v;return {panHandlers:{}};}}};
  let reduced=false;
  const {SlideConfirm}=load('mobile/lib/slide-confirm.tsx',{'react-native':port,'./design':{useTenantDesign:()=>({design:DEFAULT_MOBILE_DESIGN,palette:{},reduceMotion:reduced})},'../../lib/mobile-design':{MOBILE_ACCENTS},'./i18n':{t:(s:string)=>s}});
  return {SlideConfirm,timing,handlers:()=>handlers,reduce:()=>{reduced=true;}};
}
describe('attendance confirmation control',()=>{
  it('requires a completed release; taps, short drags and cancelled drags never record',()=>{
    const f=slide(),confirm=vi.fn();render(<f.SlideConfirm label="Record clock in" onConfirm={confirm}/>);
    const rail=screen.getByText('Record clock in').parentElement!;fireEvent.click(rail);
    act(()=>f.handlers().onPanResponderMove(null,{dx:30,dy:0}));act(()=>f.handlers().onPanResponderRelease());expect(confirm).not.toHaveBeenCalled();
    act(()=>f.handlers().onPanResponderMove(null,{dx:252,dy:0}));expect(confirm).not.toHaveBeenCalled();act(()=>f.handlers().onPanResponderTerminate());act(()=>f.handlers().onPanResponderRelease());expect(confirm).not.toHaveBeenCalled();
    act(()=>f.handlers().onPanResponderMove(null,{dx:252,dy:0}));act(()=>f.handlers().onPanResponderRelease());act(()=>f.handlers().onPanResponderRelease());expect(confirm).toHaveBeenCalledTimes(1);
  });
  it('offers a labelled two-step accessible confirmation and respects disabled state',()=>{
    const f=slide(),confirm=vi.fn(),ui=render(<f.SlideConfirm label="Record clock out" onConfirm={confirm}/>);
    fireEvent.click(screen.getByRole('button',{name:'Record clock out. useTapConfirmation'}));expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Record clock out. confirmAction'}));expect(confirm).toHaveBeenCalledTimes(1);
    ui.rerender(<f.SlideConfirm label="Preparing" disabled onConfirm={confirm}/>);fireEvent.click(screen.getByRole('button'));act(()=>f.handlers().onPanResponderMove(null,{dx:999,dy:0}));act(()=>f.handlers().onPanResponderRelease());expect(confirm).toHaveBeenCalledTimes(1);
  });
  it('uses zero-duration reset when reduced motion is enabled and cannot confirm before layout',()=>{
    const f=slide();f.reduce();const confirm=vi.fn();render(<f.SlideConfirm label="Record" onConfirm={confirm}/>);
    act(()=>f.handlers().onPanResponderMove(null,{dx:999,dy:0}));act(()=>f.handlers().onPanResponderRelease());expect(confirm).not.toHaveBeenCalled();expect(f.timing).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({duration:0}));
  });
});
describe('private user drafts across OS activities',()=>{
  it('survives locking, discards on employment/account change, and rejects late picker results',()=>{
    let status='signedIn',employmentId='A',generation=1;const deleted:string[]=[];
    class File{constructor(private uri:string){}exists=true;delete(){deleted.push(this.uri);}}
    class Directory{exists=false;delete(){}}
    const f=load('mobile/lib/journey-drafts.tsx',{'expo-file-system':{File,Directory,Paths:{cache:'cache'}},'./auth':{authGeneration:()=>generation},'./session':{useSession:()=>({status,employmentId})}});
    let drafts:any;function Probe(){drafts=f.useJourneyDrafts();return <span>{drafts.clock?.phase??'empty'}</span>;}
    const ui=render(<f.JourneyDraftProvider><Probe/></f.JourneyDraftProvider>);
    const old=drafts;act(()=>drafts.putClock({action:'in',phase:'review',requestId:'request-A',photo:{uri:'private-A'}}));expect(screen.getByText('review')).toBeTruthy();
    status='locked';ui.rerender(<f.JourneyDraftProvider><Probe/></f.JourneyDraftProvider>);expect(screen.getByText('review')).toBeTruthy();
    act(()=>expect(old.putClock({action:'in',phase:'review',requestId:'request-A'},'request-A')).toBe(true));
    employmentId='B';ui.rerender(<f.JourneyDraftProvider><Probe/></f.JourneyDraftProvider>);expect(screen.getByText('empty')).toBeTruthy();expect(deleted).toContain('private-A');
    act(()=>expect(old.putClock({action:'in',phase:'review',requestId:'late'},'request-A')).toBe(false));
    employmentId='A';status='signedIn';ui.rerender(<f.JourneyDraftProvider><Probe/></f.JourneyDraftProvider>);expect(screen.getByText('empty')).toBeTruthy();
    act(()=>drafts.putClock({action:'out',phase:'review',requestId:'B'}));generation++;ui.rerender(<f.JourneyDraftProvider><Probe/></f.JourneyDraftProvider>);expect(screen.getByText('empty')).toBeTruthy();
    status='signedOut';ui.rerender(<f.JourneyDraftProvider><Probe/></f.JourneyDraftProvider>);act(()=>expect(drafts.putClock({action:'in',phase:'review'})).toBe(false));
  });
  it('cancelled requests cannot be resurrected by an old camera or document callback',()=>{
    const f=load('mobile/lib/journey-drafts.tsx',{'expo-file-system':{File:class{},Directory:class{exists=false},Paths:{cache:'cache'}},'./auth':{authGeneration:()=>1},'./session':{useSession:()=>({status:'signedIn',employmentId:'A'})}});
    let d:any;function Probe(){d=f.useJourneyDrafts();return null;}render(<f.JourneyDraftProvider><Probe/></f.JourneyDraftProvider>);
    act(()=>d.putLeave({phase:'edit',command:{requestId:'old'}}));const old=d;act(()=>d.putLeave(null));act(()=>expect(old.putLeave({phase:'edit',command:{requestId:'old'}},'old')).toBe(false));expect(d.leave).toBeNull();
  });
});

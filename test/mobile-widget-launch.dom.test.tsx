import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transpileModule,ModuleKind,JsxEmit} from 'typescript';
import * as React from 'react';import * as jsx from 'react/jsx-runtime';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
function load(path:string,ports:Record<string,unknown>){
 const module={exports:{} as Record<string,any>};
 runInNewContext(transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,
 {module,exports:module.exports,Date,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,require:(id:string)=>{if(id in ports)return ports[id];throw Error('Missing port '+id);}});
 return module.exports;
}
function fixture(){
 const signal=load('mobile/lib/shift-reminder-signal.ts',{});
 let namespace='workplace',generation=1;
 const session={status:'signedIn',visible:true,employmentId:'own'};
 const reply=(time='2026-11-07T10:00:00Z',employmentId:string|null='own')=>({enabled:!!employmentId,employmentId,state:employmentId?{serverNow:time}:null});
 const apiGet=vi.fn(async()=>reply()),update=vi.fn(),initialize=vi.fn();
 const native={currentState:'active',addEventListener:()=>({remove:vi.fn()})};
 const module=load('mobile/lib/widget-launch.tsx',{
 react:React,'react/jsx-runtime':jsx,'react-native':{AppState:native},
 'expo-linking':{getInitialURL:async()=>null,addEventListener:()=>({remove:vi.fn()})},
 'expo-router':{router:{replace:vi.fn()}},'./session':{useSession:()=>session},
 './config':{identityNamespace:()=>namespace},'./auth':{authGeneration:()=>generation},
 './widget-intent':{widgetIntents:{take:()=>null,capture:()=>false}},
 './attendance-widgets':{initializeAttendanceWidgets:initialize,updateAttendanceWidgets:update},
 './api':{apiGet},'./widget-snapshot':{projectAttendanceWidget:(r:any)=>r.enabled?{updated:r.state.serverNow}:null},
 './shift-reminder-signal':signal,'./preferences':{useDisplayPrefs:()=>({language:'en'})},
 });
 return{Observer:module.WidgetLaunchObserver as React.ComponentType,apiGet,update,session,reply,
 emit:(value:any,over:Record<string,unknown>={})=>signal.requestShiftReminderRefresh({clock:{value,namespace,generation,employmentId:'own',...over}}),
 refresh:()=>signal.requestShiftReminderRefresh(),changeOwner:()=>{generation++;namespace='other';}};
}
afterEach(cleanup);
describe('widget consumes a fresh authorized clock read',()=>{
 it('reuses Clock data without a second request and retains generic refreshes',async()=>{
  const f=fixture();render(<f.Observer/>);await waitFor(()=>expect(f.update).toHaveBeenCalledOnce());
  act(()=>f.emit(f.reply('2026-11-07T10:01:00Z')));expect(f.apiGet).toHaveBeenCalledOnce();
  expect(f.update).toHaveBeenLastCalledWith({updated:'2026-11-07T10:01:00Z'});
  await act(async()=>f.refresh());expect(f.apiGet).toHaveBeenCalledTimes(2);
  // A late older network answer cannot replace the newer server timestamp.
  expect(f.update).toHaveBeenLastCalledWith({updated:'2026-11-07T10:01:00Z'});
 });
 it('rejects other workplace, generation and employment events, and clears a disabled clock',async()=>{
  const f=fixture();const view=render(<f.Observer/>);await waitFor(()=>expect(f.update).toHaveBeenCalledOnce());f.update.mockClear();
  act(()=>{f.emit(f.reply(),{namespace:'foreign'});f.emit(f.reply(),{generation:2});f.emit(f.reply(),{employmentId:'other'});f.emit(f.reply(undefined,'other'));});
  expect(f.update).not.toHaveBeenCalled();expect(f.apiGet).toHaveBeenCalledOnce();
  act(()=>f.emit(f.reply(undefined,null)));expect(f.update).toHaveBeenLastCalledWith(null);
  view.unmount();f.update.mockClear();act(()=>f.emit(f.reply()));expect(f.update).not.toHaveBeenCalled();
 });
 it('rejects events after session visibility or authentication ownership changes',async()=>{
  const f=fixture();const view=render(<f.Observer/>);await waitFor(()=>expect(f.update).toHaveBeenCalledOnce());f.update.mockClear();
  f.session.visible=false;view.rerender(<f.Observer/>);act(()=>f.emit(f.reply()));expect(f.update).not.toHaveBeenCalled();
  f.session.visible=true;view.rerender(<f.Observer/>);await waitFor(()=>expect(f.update).toHaveBeenCalledOnce());f.update.mockClear();
  f.changeOwner();act(()=>f.emit(f.reply(),{generation:1,namespace:'workplace'}));expect(f.update).not.toHaveBeenCalled();
 });
});

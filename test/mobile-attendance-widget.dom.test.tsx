import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transpileModule,ModuleKind,JsxEmit} from 'typescript';
import * as jsx from 'react/jsx-runtime';
import {afterEach,expect,it,vi} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import {createWidgetIntentStore} from '../mobile/lib/widget-intent';
import * as React from 'react';
function load(file:string,ports:Record<string,unknown>){const module={exports:{} as any};runInNewContext(transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:(s:string)=>{if(s==='react')return React;if(s==='react/jsx-runtime')return jsx;if(s in ports)return ports[s];throw Error('Missing '+s);},setTimeout,clearTimeout,setInterval,clearInterval,AbortController,Date});return module.exports;}
afterEach(()=>{cleanup();vi.useRealTimers();});
const empty={clockIn:'Clock in',clockOut:'Clock out',hint:'Open app',status:'Open app to refresh',inTime:'—',outTime:'—',updated:'Open app',active:false};
it('iPhone layouts retain separate native links in both themes and schedule an empty expiry snapshot',()=>{
 const registered=new Map<string,{component:any;snapshot:ReturnType<typeof vi.fn>;timeline:ReturnType<typeof vi.fn>}>(),View=({children}:any)=><div>{children}</div>;
 const code=load('mobile/lib/attendance-widgets.ios.tsx',{'@expo/ui/swift-ui':{HStack:View,VStack:View,Text:View,Spacer:()=>null,Link:({destination,children}:any)=><a href={destination}>{children}</a>,Image:()=>null},'@expo/ui/swift-ui/modifiers':{...Object.fromEntries(['font','foregroundStyle','widgetURL','containerBackground','padding','accessibilityLabel','lineLimit','frame','background','privacySensitive','minimumScaleFactor'].map(k=>[k,(...args:any[])=>({k,args})])),shapes:{capsule:()=>({shape:'capsule'})}},'expo-widgets':{createWidget:(name:string,component:any)=>{const snapshot=vi.fn(),timeline=vi.fn();registered.set(name,{component,snapshot,timeline});return {updateSnapshot:snapshot,updateTimeline:timeline};}},'./widget-copy':{widgetPresentation:(s:any)=>s?{...empty,status:'Clocked in',inTime:s.inTime,outTime:s.outTime,updated:s.updated,active:true}:empty}});
 code.initializeAttendanceWidgets();expect([...registered.keys()]).toEqual(['OneHRClockIn','OneHRClockOut','OneHRAttendance']);
 for(const w of registered.values())expect(w.snapshot).toHaveBeenCalledWith(empty);
 const snapshot={status:'in',day:'2026-11-02',inTime:'09:02',outTime:'—',updated:'12:26',expiresAt:Date.now()+900_000};code.updateAttendanceWidgets(snapshot);
 for(const w of registered.values()){
  const entries=w.timeline.mock.calls[0][0];expect(entries).toHaveLength(2);expect(entries[0].props.inTime).toBe('09:02');expect(entries[1].date.getTime()).toBe(snapshot.expiresAt);expect(entries[1].props).toEqual(empty);
 }
 for(const colorScheme of ['light','dark']){
  const r=render(registered.get('OneHRAttendance')!.component({...empty,status:'Clocked in',inTime:'09:02',updated:'2026-11-02 · Updated 12:26 MYT',active:true},{colorScheme,widgetFamily:'systemMedium'}));
  expect(screen.getByRole('link',{name:'Clock in'}).getAttribute('href')).toBe('aihr://clock?action=in');expect(screen.getByRole('link',{name:'Clock out'}).getAttribute('href')).toBe('aihr://clock?action=out');expect(screen.getByText('09:02')).toBeTruthy();expect(screen.getByText(/Updated 12:26/)).toBeTruthy();r.unmount();
 }
 const config=JSON.parse(readFileSync('mobile/app.json','utf8')).expo.plugins.find((p:any)=>Array.isArray(p)&&p[0]==='expo-widgets')[1];expect(config.enablePushNotifications).toBe(false);expect(config.enableAndroid).toBe(false);expect(config.widgets.map((w:any)=>w.name)).toEqual([...registered.keys()]);
});
function observerFixture(){
 const intents=createWidgetIntentStore(),replace=vi.fn(),session={status:'signedOut',visible:true,employmentId:null as string|null},app={currentState:'active',addEventListener:()=>({remove:vi.fn()})},clear=vi.fn(),update=vi.fn(),read=vi.fn(async()=>({})),project=vi.fn(()=>({status:'in',inTime:'09:02'}));let onURL:(e:{url:string})=>void=()=>{},generation=1,namespace='synthetic';
 const {WidgetLaunchObserver}=load('mobile/lib/widget-launch.tsx',{'react-native':{AppState:app},'expo-linking':{getInitialURL:async()=>null,addEventListener:(_event:string,cb:any)=>{onURL=cb;return {remove:vi.fn()};}},'expo-router':{router:{replace}},'./session':{useSession:()=>session},'./config':{identityNamespace:()=>namespace},'./widget-intent':{widgetIntents:intents},'./attendance-widgets':{initializeAttendanceWidgets:clear,updateAttendanceWidgets:update},'./preferences':{useDisplayPrefs:()=>({language:'en'})},'./api':{apiGet:read},'./auth':{authGeneration:()=>generation},'./widget-snapshot':{projectAttendanceWidget:project},'./shift-reminder-signal':{onShiftReminderRefresh:()=>()=>{}}});
 return {WidgetLaunchObserver,session,app,replace,read,clear,update,project,receive:(url:string)=>onURL({url}),revoke:()=>{generation++;},switchConnection:()=>{namespace='other';}};
}
it('a launch waits for sign-in and employment selection, then routes once; its only network port is a read',async()=>{
 vi.useFakeTimers();const f=observerFixture(),C=f.WidgetLaunchObserver,r=render(<C/>);
 await React.act(async()=>{f.receive('aihr://clock?action=out');await vi.advanceTimersByTimeAsync(0);});expect(f.replace).not.toHaveBeenCalled();expect(f.read).not.toHaveBeenCalled();
 f.session.status='signedIn';r.rerender(<C/>);await React.act(async()=>vi.advanceTimersByTimeAsync(0));expect(f.replace).not.toHaveBeenCalled();
 f.session.employmentId='own';r.rerender(<C/>);await React.act(async()=>vi.advanceTimersByTimeAsync(0));expect(f.replace).toHaveBeenCalledOnce();expect(f.replace.mock.calls[0][0]).toMatchObject({pathname:'/clock',params:{widgetAction:'out'}});expect(f.read.mock.calls[0].slice(0,2)).toEqual(['clock',{employmentId:'own'}]);
 r.rerender(<C/>);await React.act(async()=>vi.advanceTimersByTimeAsync(0));expect(f.replace).toHaveBeenCalledOnce();
});
it('clears snapshots at logout and refuses a late result from the previous employment',async()=>{
 vi.useFakeTimers();const f=observerFixture();let finish:(v:{})=>void=()=>{};f.read.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));f.session.status='signedIn';f.session.employmentId='one';const C=f.WidgetLaunchObserver,r=render(<C/>);const clears=f.clear.mock.calls.length;
 f.session.status='signedOut';f.session.employmentId=null;f.revoke();r.rerender(<C/>);expect(f.clear.mock.calls.length).toBeGreaterThan(clears);
 await React.act(async()=>{finish({});await vi.advanceTimersByTimeAsync(0);});expect(f.update).not.toHaveBeenCalled();expect(f.project).not.toHaveBeenCalled();
});
it('does not poll in the background or publish a response received after the app locks',async()=>{
 vi.useFakeTimers();const f=observerFixture();let finish:(v:{})=>void=()=>{};f.read.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));f.session.status='signedIn';f.session.employmentId='one';const C=f.WidgetLaunchObserver,r=render(<C/>);
 f.session.status='locked';f.session.visible=false;f.app.currentState='background';r.rerender(<C/>);
 await React.act(async()=>{finish({});await vi.advanceTimersByTimeAsync(120_000);});expect(f.read).toHaveBeenCalledOnce();expect(f.update).not.toHaveBeenCalled();
});

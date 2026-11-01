import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transpileModule,ModuleKind,JsxEmit} from 'typescript';
import * as jsx from 'react/jsx-runtime';
import {afterEach,expect,it,vi} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import {createWidgetIntentStore} from '../mobile/lib/widget-intent';
import * as React from 'react';
function load(file:string,ports:Record<string,unknown>){const module={exports:{} as any};runInNewContext(transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:(s:string)=>{if(s==='react')return React;if(s==='react/jsx-runtime')return jsx;if(s in ports)return ports[s];throw Error('Missing '+s);},setTimeout,clearTimeout,Date});return module.exports;}
afterEach(()=>{cleanup();vi.useRealTimers();});
it('iPhone layouts register the configured widgets, adapt to light/dark and share only public labels',()=>{
 const registered=new Map<string,{component:any;snapshot:ReturnType<typeof vi.fn>}>(),View=({children}:any)=><div>{children}</div>;
 const code=load('mobile/lib/attendance-widgets.ios.tsx',{'@expo/ui/swift-ui':{HStack:View,VStack:View,Text:View,Link:({destination,children}:any)=><a href={destination}>{children}</a>,Image:()=>null},'@expo/ui/swift-ui/modifiers':Object.fromEntries(['font','foregroundStyle','widgetURL','containerBackground','padding','accessibilityLabel','lineLimit'].map(k=>[k,(...args:any[])=>({k,args})])),'expo-widgets':{createWidget:(name:string,component:any)=>{const snapshot=vi.fn();registered.set(name,{component,snapshot});return {updateSnapshot:snapshot};}},'./i18n':{t:(key:string)=>key}});
 code.initializeAttendanceWidgets();expect([...registered.keys()]).toEqual(['OneHRClockIn','OneHRClockOut','OneHRAttendance']);
 for(const w of registered.values())expect(w.snapshot.mock.calls).toEqual([[{clockIn:'clockIn',clockOut:'clockOut',hint:'widgetOpenHint'}]]);
 for(const colorScheme of ['light','dark']){const r=render(registered.get('OneHRAttendance')!.component({clockIn:'Clock in',clockOut:'Clock out',hint:'Open OneHR+ to confirm attendance'},{colorScheme,widgetFamily:'systemMedium'}));expect(screen.getByRole('link',{name:'Clock in'}).getAttribute('href')).toBe('aihr://clock?action=in');expect(screen.getByRole('link',{name:'Clock out'}).getAttribute('href')).toBe('aihr://clock?action=out');r.unmount();}
 const config=JSON.parse(readFileSync('mobile/app.json','utf8')).expo.plugins.find((p:any)=>Array.isArray(p)&&p[0]==='expo-widgets')[1];expect(config.enablePushNotifications).toBe(false);expect(config.enableAndroid).toBe(false);expect(config.widgets.map((w:any)=>w.name)).toEqual([...registered.keys()]);
});
it('a launch waits for sign-in and employment selection, then routes once without any attendance API',async()=>{
 vi.useFakeTimers();const intents=createWidgetIntentStore(),replace=vi.fn(),session={status:'signedOut',visible:true,employmentId:null as string|null},app={currentState:'active',addEventListener:()=>({remove:vi.fn()})};let onURL:(e:{url:string})=>void=()=>{};
 const {WidgetLaunchObserver}=load('mobile/lib/widget-launch.tsx',{'react-native':{AppState:app},'expo-linking':{getInitialURL:async()=>null,addEventListener:(_event:string,cb:any)=>{onURL=cb;return {remove:vi.fn()};}},'expo-router':{router:{replace}},'./session':{useSession:()=>session},'./config':{identityNamespace:()=>'synthetic'},'./widget-intent':{widgetIntents:intents},'./attendance-widgets':{initializeAttendanceWidgets:vi.fn()},'./preferences':{useDisplayPrefs:()=>({language:'en'})}});
 const r=render(<WidgetLaunchObserver/>);await React.act(async()=>{onURL({url:'aihr://clock?action=out'});await vi.runAllTimersAsync();});expect(replace).not.toHaveBeenCalled();
 session.status='signedIn';r.rerender(<WidgetLaunchObserver/>);await React.act(async()=>vi.runAllTimersAsync());expect(replace).not.toHaveBeenCalled();
 session.employmentId='own';r.rerender(<WidgetLaunchObserver/>);await React.act(async()=>vi.runAllTimersAsync());expect(replace).toHaveBeenCalledOnce();expect(replace.mock.calls[0][0]).toMatchObject({pathname:'/clock',params:{widgetAction:'out'}});
 r.rerender(<WidgetLaunchObserver/>);await React.act(async()=>vi.runAllTimersAsync());expect(replace).toHaveBeenCalledOnce();
});

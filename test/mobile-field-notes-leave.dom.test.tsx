import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transpileModule,ModuleKind,JsxEmit} from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';

function fixture(loading=false){
 const reload=vi.fn(),focus={current:()=>{}},cards=Array.from({length:5},(_,i)=>({leaveTypeId:String(i),leaveType:`Type ${i}`,isCurrentCycle:true,canApplyFor:i===4?null:i,takenOnly:false}));
 const states:Record<string,any>={leave:{data:loading?null:{cards,today:'2026-11-07'},loading,error:null,reload},'leave-options':{data:loading?null:{items:[{id:'0'}]},loading,error:null,reload},'leave-requests':{data:loading?null:{items:[],total:0},loading,error:null,reload}};
 const View=({children}:any)=><div>{children}</div>;
 const Text=({children}:any)=><span>{children}</span>;
 const ports:any={react:React,'react/jsx-runtime':jsx,'react-native':{View,Pressable:({children,onPress}:any)=><button onClick={onPress}>{children}</button>},
  'expo-router':{router:{push:vi.fn()},useFocusEffect:(fn:()=>void)=>{React.useEffect(()=>{focus.current=fn;fn();},[fn]);}},
  '../../lib/design':{DesignText:Text,useTenantDesign:()=>({palette:{}})},'../../lib/api':{useApi:(path:string)=>states[path]},
  '../../lib/session':{useSession:()=>({signOut:()=>{},employmentId:'synthetic'})},'../../lib/journey-drafts':{useJourneyDrafts:()=>({leave:null})},
  '../../lib/leave-request-form':{LeaveRequestForm:({cards:all}:any)=><button data-card-count={all.length}>Request leave</button>},
  '../../lib/visual':{Material:View,StatusPill:({label}:any)=><span>{label}</span>},'../../lib/home-cards':{cardFigure:(c:any)=>c.canApplyFor},'../../lib/i18n':{t:(k:string)=>k},
  '../../lib/ui':{Screen:View,Title:({children}:any)=><h1>{children}</h1>,SectionLabel:({children}:any)=><h2>{children}</h2>,Muted:Text,Row:View,
   fmtDays:(v:number|null)=>v===null?'Hidden':String(v),LoadState:({loading:busy}:any)=>busy?<div role="progressbar"/>:null,
   ListRow:({label,onPress}:any)=><button onClick={onPress}>{label}</button>}};
 const output={exports:{} as {default:React.ComponentType}};
 runInNewContext(transpileModule(readFileSync('mobile/app/(tabs)/leave.tsx','utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,{module:output,exports:output.exports,require:(id:string)=>{if(id in ports)return ports[id];throw new Error(id);}});
 return {View:output.exports.default,reload,focus,cards};
}
afterEach(cleanup);
it('shows one initial loading indicator without pretending the history is empty',()=>{
 const f=fixture(true);render(<f.View/>);
 expect(screen.getAllByRole('progressbar')).toHaveLength(1);
 expect(screen.queryByText('noRequests')).toBeNull();expect(screen.queryByText('requestHistory')).toBeNull();
 expect(f.reload).not.toHaveBeenCalled();
});
it('keeps every balance and request type accessible, and refreshes on return rather than first focus',()=>{
 const f=fixture();render(<f.View/>);
 expect(screen.getByText('Type 0')).toBeTruthy();expect(screen.queryByText('Type 4')).toBeNull();
 expect(screen.getByText('Request leave').getAttribute('data-card-count')).toBe('5');
 fireEvent.click(screen.getByText('allBalances'));expect(screen.getByText('Type 4')).toBeTruthy();expect(screen.getByText('Hidden')).toBeTruthy();
 expect(f.reload).not.toHaveBeenCalled();act(()=>f.focus.current());expect(f.reload).toHaveBeenCalledTimes(3);
});

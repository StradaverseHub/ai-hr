import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JsxEmit,ModuleKind,transpileModule} from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {UnavailableError} from '../mobile/lib/errors';
function fixture(){
  const Container=({children}:React.PropsWithChildren)=><div>{children}</div>;
  const output={exports:{} as {LoadState:React.ComponentType<{loading:boolean;hasData?:boolean;error:Error|null;onRetry:()=>void}>}};
  const ports:Record<string,unknown>={
    'react':React,'react/jsx-runtime':jsx,'expo-router':{router:{back:vi.fn()}},'react-native-safe-area-context':{SafeAreaView:Container},
    'react-native':{View:Container,ScrollView:Container,RefreshControl:()=>null,StyleSheet:{create:(v:unknown)=>v},
      ActivityIndicator:()=> <span role="progressbar"/>,Pressable:({children,onPress,disabled}:any)=><button onClick={onPress} disabled={disabled}>{children}</button>},
    './design':{DesignText:({children}:React.PropsWithChildren)=><span>{children}</span>,TenantBrand:()=>null,
      useTenantDesign:()=>({design:{schemaVersion:1,corners:'soft'},palette:{text:'black',muted:'gray',accent:'blue'}})},
    './errors':{UnavailableError},'./i18n':{t:(key:string,values?:{seconds?:number;id?:string})=>key+(values?.seconds?' '+values.seconds:values?.id?' '+values.id:'')},
  };
  runInNewContext(transpileModule(readFileSync('mobile/lib/ui.tsx','utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,
    {module:output,exports:output.exports,require:(name:string)=>{if(name in ports)return ports[name];throw new Error(name);}});
  return output.exports.LoadState;
}
afterEach(cleanup);
it('shows a safe support reference without displaying private error messages',()=>{
  const View=fixture(),reference='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  render(<View loading={false} error={new UnavailableError('SYNTHETIC_PRIVATE_HR_VALUE',undefined,reference)} onRetry={()=>{}}/>);
  expect(screen.getByText('supportReference '+reference)).toBeTruthy();expect(screen.queryByText('SYNTHETIC_PRIVATE_HR_VALUE')).toBeNull();
});
it('distinguishes first loading from refreshing retained information',()=>{
  const View=fixture(),ui=render(<View loading error={null} onRetry={()=>{}}/>);expect(screen.getByRole('progressbar')).toBeTruthy();
  ui.rerender(<View loading hasData error={null} onRetry={()=>{}}/>);expect(screen.queryByRole('progressbar')).toBeNull();expect(screen.getByText('refreshing')).toBeTruthy();
});
it('labels retained data as stale after failure and exposes the bounded server retry delay',()=>{
  const View=fixture(),retry=vi.fn(),ui=render(<View loading={false} hasData error={new UnavailableError(undefined,2)} onRetry={retry}/>);
  expect(screen.getByText('staleData')).toBeTruthy();expect(screen.getByText('retryAfter 2')).toBeTruthy();fireEvent.click(screen.getByText('retry'));expect(retry).toHaveBeenCalledOnce();
  ui.rerender(<View loading={false} error={new UnavailableError()} onRetry={retry}/>);expect(screen.queryByText('staleData')).toBeNull();
});

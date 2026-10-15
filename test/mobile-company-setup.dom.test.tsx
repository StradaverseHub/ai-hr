import { generateKeyPairSync,sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule,ModuleKind,JsxEmit } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { act,cleanup,render,screen,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { verifyCompanyProfile } from '../mobile/lib/company-profile';
import { createConnectionState } from '../mobile/lib/connection-state';

const pair=generateKeyPairSync('ed25519'),trust=[{keyId:'test',publicKey:pair.publicKey.export({format:'jwk'}).x!}];
function setup(name='Private customer',origin='https://private.example.test') {const now=Math.floor(Date.now()/1000);const bytes=Buffer.from(JSON.stringify({connectionVersion:1,apiVersion:'v1',authProvider:'keycloak',id:name.replace(/\W/g,'-'),name,hosting:'on-premise',apiOrigin:origin,issuer:origin+'/identity/realms/ai-hr',clientId:'aihr-mobile',audience:'aihr-api',notBefore:now-60,expiresAt:now+86400}));return {keyId:'test',payload:bytes.toString('base64url'),signature:sign(null,bytes,pair.privateKey).toString('base64url')};}
function fixture() {
 const files=new Map<string,string>(),deleted:string[]=[];let applied:unknown=null;
 class File {key:string;constructor(dir:string,name?:string){this.key=name?dir+'/'+name:dir;}get exists(){return files.has(this.key);}get size(){return files.get(this.key)?.length??0;}async text(){return files.get(this.key)!;}write(v:string){files.set(this.key,v);}delete(){deleted.push(this.key);files.delete(this.key);}}
 class Directory {key:string;constructor(dir:string,name:string){this.key=dir+'/'+name;}get exists(){return this.key==='cache/aihr-journeys';}delete(){deleted.push(this.key);}}
 const clear=vi.fn(async()=>{}),picker=vi.fn(async()=>({canceled:false,assets:[{uri:'cache/company.json'}]}));
 const Container=({children}:React.PropsWithChildren)=><div>{children}</div>;
 const ports:Record<string,unknown>={react:React,'react/jsx-runtime':jsx,
  'react-native':{ActivityIndicator:()=> <div>Loading</div>,BackHandler:{addEventListener:()=>({remove:()=>{}})},ScrollView:Container,Text:Container,View:Container,StyleSheet:{create:(x:unknown)=>x}},
  'react-native-safe-area-context':{SafeAreaView:Container},'expo-file-system':{File,Directory,Paths:{document:'doc',cache:'cache'}},'expo-document-picker':{getDocumentAsync:picker},'expo-router':{router:{replace:vi.fn(),back:vi.fn()},SplashScreen:{hideAsync:vi.fn(async()=>{})}},
  './auth':{signOut:clear},'./config':{runtimeConnections:true,applyCompanyConnection:(p:unknown)=>{applied=p;}},'./company-profile':{verifyCompanyProfile},'./connection-state':{createConnectionState},'./i18n':{appLocale:()=> 'en'},
  './ui':{colors:{},Button:({title,onPress,disabled}:any)=><button onClick={onPress} disabled={disabled}>{title}</button>},'../connections/trust.json':trust,'../connections/profiles.json':[setup('Test cloud','https://cloud.example.test')]};
 const output={exports:{} as any};
 runInNewContext(transpileModule(readFileSync('mobile/lib/company-connection.tsx','utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{exports:output.exports,module:output,URL,JSON,console,require:(id:string)=>{if(id in ports)return ports[id];throw new Error('Unexpected company setup dependency '+id);}});
 const Provider=output.exports.CompanyConnectionProvider as React.ComponentType<React.PropsWithChildren>;
 const Setup=output.exports.CompanySetup as React.ComponentType;
 function PrivateView(){const p=output.exports.useCompanyConnection();return <><p>Signed-out connection: {p?.name}</p><Setup/></>;}
 return {Provider,PrivateView,files,deleted,clear,picker,applied:()=>applied};
}
afterEach(cleanup);
describe('shipped company setup screen',()=>{
 it('reviews the approved server and identity before saving, and restores on restart',async()=>{const f=fixture(),user=userEvent.setup();let view=render(<f.Provider><f.PrivateView/></f.Provider>);await user.click(await screen.findByRole('button',{name:/Test cloud/}));expect(screen.getByText('Check your company connection')).toBeInTheDocument();expect(screen.getAllByText('https://cloud.example.test')).toHaveLength(2);expect(f.files.has('doc/aihr-company-v1.json')).toBe(false);await user.click(screen.getByRole('button',{name:'Use this company'}));await screen.findByText('Signed-out connection: Test cloud');expect(f.clear).toHaveBeenCalledTimes(1);expect(f.deleted).toContain('cache/aihr-journeys');expect(f.files.has('doc/aihr-company-v1.json')).toBe(true);view.unmount();view=render(<f.Provider><f.PrivateView/></f.Provider>);await screen.findByText('Signed-out connection: Test cloud');expect(f.clear).toHaveBeenCalledTimes(1);});
 it('imports a signed private company without recompilation and hides old views during cleanup',async()=>{const f=fixture(),user=userEvent.setup();f.files.set('doc/aihr-company-v1.json',JSON.stringify(setup('Old company','https://old.example.test')));f.files.set('cache/company.json',JSON.stringify(setup()));render(<f.Provider><f.PrivateView/></f.Provider>);await screen.findByText('Signed-out connection: Old company');await user.click(screen.getByRole('button',{name:'Import company setup'}));await screen.findByText('Private customer');let release!:()=>void;f.clear.mockImplementationOnce(()=>new Promise<void>(r=>{release=r;}));await user.click(screen.getByRole('button',{name:'Use this company'}));expect(screen.queryByText('Signed-out connection: Old company')).not.toBeInTheDocument();expect(screen.queryByText('Signed-out connection: Private customer')).not.toBeInTheDocument();await act(async()=>{release();});await screen.findByText('Signed-out connection: Private customer');expect(f.applied()).toMatchObject({apiOrigin:'https://private.example.test'});expect(f.deleted).toContain('cache/company.json');});
 it('rejects a forged setup file before changing the current company',async()=>{const f=fixture(),user=userEvent.setup();f.files.set('cache/company.json','{"keyId":"attacker","payload":"abc","signature":"abc"}');render(<f.Provider><f.PrivateView/></f.Provider>);await user.click(await screen.findByRole('button',{name:'Import company setup'}));await screen.findByText(/no longer valid/);expect(f.clear).not.toHaveBeenCalled();expect(f.applied()).toBeNull();expect(f.files.has('doc/aihr-company-v1.json')).toBe(false);});
});

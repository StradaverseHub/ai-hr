import { generateKeyPairSync,sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule,ModuleKind,JsxEmit } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { act,cleanup,render,screen,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach,describe,expect,it,vi } from 'vitest';
import * as companyProfile from '../mobile/lib/company-profile';
const { verifyCompanyProfile } = companyProfile;
import { createConnectionState } from '../mobile/lib/connection-state';
import * as workplaceSetup from '../lib/mobile-workplace-setup';
const { isWorkplaceSetupLink, readWorkplaceSetupLink, workplaceSetupLinks } = workplaceSetup;

const pair=generateKeyPairSync('ed25519'),trust=[{keyId:'test',publicKey:pair.publicKey.export({format:'jwk'}).x!}];
function setup(name='Private customer',origin='https://private.example.test',organization?:string) {const now=Math.floor(Date.now()/1000);const bytes=Buffer.from(JSON.stringify({connectionVersion:1,apiVersion:'v1',authProvider:organization?'internal':'keycloak',id:name.replace(/\W/g,'-'),name,hosting:'on-premise',apiOrigin:origin,issuer:origin+(organization?'/auth':'/identity/realms/ai-hr'),clientId:'aihr-mobile',audience:'aihr-api',notBefore:now-60,expiresAt:now+86400,...(organization?{organization}:{})}));return {keyId:'test',payload:bytes.toString('base64url'),signature:sign(null,bytes,pair.privateKey).toString('base64url')};}
function fixture() {
 const files=new Map<string,string>(),deleted:string[]=[];let applied:unknown=null,authOwner=0;
 class File {key:string;constructor(dir:string,name?:string){this.key=name?dir+'/'+name:dir;}get exists(){return files.has(this.key);}get size(){return files.get(this.key)?.length??0;}async text(){if(!files.has(this.key))throw new Error('No such file');return files.get(this.key)!;}write(v:string){files.set(this.key,v);}delete(){deleted.push(this.key);files.delete(this.key);}}
 class Directory {key:string;constructor(dir:string,name:string){this.key=dir+'/'+name;}get exists(){return this.key==='cache/aihr-journeys';}delete(){deleted.push(this.key);}}
 const clear=vi.fn(async()=>{authOwner++;}),picker=vi.fn(async()=>({canceled:false,assets:[{uri:'cache/company.json'}]}));
 const linking={initial:null as string|null,listener:null as ((event:{url:string})=>void)|null};
 const getInitialURL=vi.fn(async()=>linking.initial);
 const back={handler:null as (()=>boolean)|null};
 const Container=({children,style,accessibilityElementsHidden}:React.PropsWithChildren<{style?:{display?:string};accessibilityElementsHidden?:boolean}>)=><div style={{display:style?.display}} aria-hidden={accessibilityElementsHidden||undefined}>{children}</div>;
 const drafts={exports:{} as any};
 runInNewContext(transpileModule(readFileSync('mobile/lib/journey-drafts.tsx','utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,
  {exports:drafts.exports,module:drafts,JSON,Set,require(id:string){
    if(id==='react')return React;if(id==='react/jsx-runtime')return jsx;
    if(id==='expo-file-system')return{File,Directory,Paths:{cache:'cache'}};
    if(id==='./auth')return{authGeneration:()=>authOwner};
    if(id==='./session')return{useSession:()=>({status:'signedIn',employmentId:'fixture-employment'})};
    throw new Error('Unexpected drafts dependency '+id);
  }});
 const ports:Record<string,unknown>={react:React,'react/jsx-runtime':jsx,
  'react-native':{ActivityIndicator:()=> <div>Loading</div>,BackHandler:{addEventListener:(_type:string,handler:()=>boolean)=>{back.handler=handler;return{remove(){if(back.handler===handler)back.handler=null;}};}},ScrollView:Container,Text:Container,View:Container,TextInput:({accessibilityLabel,value,onChangeText,editable}:any)=><input aria-label={accessibilityLabel} value={value} onChange={e=>onChangeText(e.target.value)} disabled={editable===false}/>,StyleSheet:{create:(x:unknown)=>x}},
  'expo-linking':{getInitialURL,clearInitialURL:vi.fn(),addEventListener:(_type:string,listener:typeof linking.listener)=>{linking.listener=listener;return{remove(){linking.listener=null;}};}},
  'react-native-safe-area-context':{SafeAreaView:Container},'expo-file-system':{File,Directory,Paths:{document:'doc',cache:'cache'}},'expo-document-picker':{getDocumentAsync:picker},'expo-router':{router:{replace:vi.fn(),back:vi.fn()},SplashScreen:{hideAsync:vi.fn(async()=>{})}},
  './auth':{signOut:clear},'./config':{runtimeConnections:true,applyCompanyConnection:(p:unknown)=>{applied=p;}},'./company-profile':companyProfile,'./connection-state':{createConnectionState},'./i18n':{appLocale:()=> 'en',intlLocale:()=> 'en-MY'},'./locales/zh':{company:{}},'./locales/ta':{company:{}},'./locales/th':{company:{}},'./locales/vi':{company:{}},
  '../../lib/mobile-workplace-setup':workplaceSetup,
  './ui':{colors:{},Button:({title,onPress,disabled}:any)=><button onClick={onPress} disabled={disabled}>{title}</button>},'../connections/trust.json':trust,'../connections/profiles.json':[setup('Test cloud','https://cloud.example.test')]};
 const output={exports:{} as any};
 runInNewContext(transpileModule(readFileSync('mobile/lib/company-connection.tsx','utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{exports:output.exports,module:output,URL,JSON,console,require:(id:string)=>{if(id in ports)return ports[id];throw new Error('Unexpected company setup dependency '+id);}});
 const ConnectionProvider=output.exports.CompanyConnectionProvider as React.ComponentType<React.PropsWithChildren>;
 const Setup=output.exports.CompanySetup as React.ComponentType;
 const DraftProvider=drafts.exports.JourneyDraftProvider as React.ComponentType<React.PropsWithChildren>;
 // The fallback reproduces the old root composition when the same test runs against a pre-fix source snapshot.
 const ReviewBoundary=(output.exports.WorkplaceReviewBoundary??React.Fragment) as React.ComponentType<React.PropsWithChildren>;
 function Provider({children}:React.PropsWithChildren){return <ConnectionProvider><DraftProvider><ReviewBoundary>{children}</ReviewBoundary></DraftProvider></ConnectionProvider>;}
 function DraftEditor(){const state=drafts.exports.useJourneyDrafts();return <input aria-label="Employee draft" value={state.clock?.message??''} onChange={e=>state.putClock({action:'in',phase:'review',message:e.target.value,photo:{uri:'cache/employee-photo.jpg',name:'photo.jpg',mimeType:'image/jpeg',size:5}})}/>;}
 function LeaveDraftEditor(){const state=drafts.exports.useJourneyDrafts();return <input aria-label="Employee leave draft" value={state.leave?.command.employeeRemark??''} onChange={e=>state.putLeave({phase:'edit',command:{requestId:'00000000-0000-4000-8000-000000000001',leaveTypeId:'00000000-0000-4000-8000-000000000002',startDate:'1999-01-01',endDate:'1999-01-01',durationType:'full_day',employeeRemark:e.target.value},document:{uri:'cache/employee-document.pdf',name:'document.pdf',mimeType:'application/pdf',size:8}})}/>;}
 function PrivateView(){const p=output.exports.useCompanyConnection();return <><p>Signed-out connection: {p?.name}</p><Setup/></>;}
 return {Provider,PrivateView,DraftProvider,DraftEditor,LeaveDraftEditor,files,deleted,clear,picker,linking,back,getInitialURL,applied:()=>applied};
}
afterEach(cleanup);
describe('shipped company setup screen',()=>{
 it('reviews the approved server before saving, and restores on restart',async()=>{const f=fixture(),user=userEvent.setup();let view=render(<f.Provider><f.PrivateView/></f.Provider>);await user.click(await screen.findByRole('button',{name:/Test cloud/}));expect(screen.getByText('Check your company connection')).toBeInTheDocument();expect(screen.getAllByText('https://cloud.example.test')).toHaveLength(1);expect(f.files.has('doc/aihr-company-v1.json')).toBe(false);await user.click(screen.getByRole('button',{name:'Use this company'}));await screen.findByText('Signed-out connection: Test cloud');expect(f.clear).toHaveBeenCalledTimes(1);expect(f.deleted).toContain('cache/aihr-journeys');expect(f.files.has('doc/aihr-company-v1.json')).toBe(true);view.unmount();view=render(<f.Provider><f.PrivateView/></f.Provider>);await screen.findByText('Signed-out connection: Test cloud');expect(f.clear).toHaveBeenCalledTimes(1);});
 it('reviews a cold-launch workplace link before saving the signed organization',async()=>{
  const f=fixture(),user=userEvent.setup();f.linking.initial=workplaceSetupLinks(JSON.stringify(setup('Acme','https://cloud.example.test','acme'))).app;
  render(<f.Provider><f.PrivateView/></f.Provider>);
  expect(await screen.findByText('Acme')).toBeInTheDocument();expect(screen.getByText('acme')).toBeInTheDocument();
  expect(f.clear).not.toHaveBeenCalled();expect(f.files.has('doc/aihr-company-v1.json')).toBe(false);
  await user.click(screen.getByRole('button',{name:'Use this company'}));await screen.findByText('Signed-out connection: Acme');
  expect(f.applied()).toMatchObject({apiOrigin:'https://cloud.example.test',organization:'acme'});expect(f.clear).toHaveBeenCalledOnce();
 });
 it('lets a signed-in user cancel a warm setup link without changing stored connection or credentials',async()=>{
  const f=fixture(),user=userEvent.setup();const old=JSON.stringify(setup('Old company','https://cloud.example.test','old'));f.files.set('doc/aihr-company-v1.json',old);
  render(<f.Provider><f.PrivateView/></f.Provider>);await screen.findByText('Signed-out connection: Old company');
  act(()=>f.linking.listener?.({url:workplaceSetupLinks(JSON.stringify(setup('New company','https://cloud.example.test','new'))).app}));
  await screen.findByText('New company');expect(screen.queryByText('Signed-out connection: Old company')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Back'}));await screen.findByText('Signed-out connection: Old company');
  expect(f.clear).not.toHaveBeenCalled();expect(f.files.get('doc/aihr-company-v1.json')).toBe(old);
 });
 it('preserves actual employee drafts and attachments through link review/cancel, clearing only after confirmation',async()=>{
  const f=fixture(),user=userEvent.setup();f.files.set('doc/aihr-company-v1.json',JSON.stringify(setup('Current workplace','https://cloud.example.test','current')));
  render(<f.Provider><f.PrivateView/><f.DraftEditor/><f.LeaveDraftEditor/></f.Provider>);
  await user.type(await screen.findByLabelText('Employee draft'),'Attendance review in progress');f.files.set('cache/employee-photo.jpg','photo');
  await user.type(screen.getByLabelText('Employee leave draft'),'Keep this leave request');f.files.set('cache/employee-document.pdf','document');
  const incoming=workplaceSetupLinks(JSON.stringify(setup('New workplace','https://cloud.example.test','new'))).app;
  act(()=>f.linking.listener?.({url:incoming}));await screen.findByText('New workplace');
  expect(f.files.has('cache/employee-photo.jpg')).toBe(true);expect(f.files.has('cache/employee-document.pdf')).toBe(true);expect(screen.queryByLabelText('Employee draft')).not.toBeInTheDocument();expect(screen.queryByLabelText('Employee leave draft')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Back'}));expect(await screen.findByLabelText('Employee draft')).toHaveValue('Attendance review in progress');expect(screen.getByLabelText('Employee leave draft')).toHaveValue('Keep this leave request');
  expect(f.files.has('cache/employee-photo.jpg')).toBe(true);expect(f.files.has('cache/employee-document.pdf')).toBe(true);expect(f.clear).not.toHaveBeenCalled();
  act(()=>f.linking.listener?.({url:incoming}));await screen.findByText('New workplace');await user.click(screen.getByRole('button',{name:'Use this company'}));
  await screen.findByText('Signed-out connection: New workplace');expect(screen.getByLabelText('Employee draft')).toHaveValue('');expect(screen.getByLabelText('Employee leave draft')).toHaveValue('');
  expect(f.files.has('cache/employee-photo.jpg')).toBe(false);expect(f.files.has('cache/employee-document.pdf')).toBe(false);expect(f.clear).toHaveBeenCalledOnce();
 });
 it('preserves the employee draft when Android back cancels an invalid incoming link',async()=>{
  const f=fixture(),user=userEvent.setup();const stored=JSON.stringify(setup('Current workplace','https://cloud.example.test','current'));f.files.set('doc/aihr-company-v1.json',stored);
  render(<f.Provider><f.PrivateView/><f.DraftEditor/></f.Provider>);
  await user.type(await screen.findByLabelText('Employee draft'),'Keep my attendance draft');f.files.set('cache/employee-photo.jpg','photo');
  act(()=>f.linking.listener?.({url:'aihr://company#setup=invalid'}));await screen.findByText(/not a complete workplace setup link/);
  expect(f.back.handler).not.toBeNull();act(()=>{expect(f.back.handler?.()).toBe(true);});
  expect(await screen.findByLabelText('Employee draft')).toHaveValue('Keep my attendance draft');
  expect(f.files.has('cache/employee-photo.jpg')).toBe(true);expect(f.files.get('doc/aihr-company-v1.json')).toBe(stored);expect(f.clear).not.toHaveBeenCalled();
 });
 it('places link review inside the shipped session and draft providers',()=>{
  const layout=readFileSync('mobile/app/_layout.tsx','utf8');
  expect(layout).toMatch(/<CompanyConnectionProvider><SessionProvider>[\s\S]*<JourneyDraftProvider><WorkplaceReviewBoundary><Gate(?: key=\{language\})? \/><\/WorkplaceReviewBoundary><\/JourneyDraftProvider>[\s\S]*<\/SessionProvider><\/CompanyConnectionProvider>/);
 });
 it('pastes and verifies an on-prem setup link without opening another host or sending credentials',async()=>{
  const f=fixture(),user=userEvent.setup();render(<f.Provider><f.PrivateView/></f.Provider>);
  const link=workplaceSetupLinks(JSON.stringify(setup('Private customer','https://private.example.test','private'))).web;
  await user.type(await screen.findByLabelText('Paste setup link'),link);await user.click(screen.getByRole('button',{name:'Review setup link'}));
  await screen.findByText('private');expect(f.clear).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Use this company'}));await screen.findByText('Signed-out connection: Private customer');
  expect(f.applied()).toMatchObject({organization:'private'});
 });
 it('rejects a forged incoming organization and keeps the old setup unchanged',async()=>{
  const f=fixture();const old=JSON.stringify(setup('Old company','https://cloud.example.test','old'));f.files.set('doc/aihr-company-v1.json',old);
  render(<f.Provider><f.PrivateView/></f.Provider>);await screen.findByText('Signed-out connection: Old company');
  const envelope=setup('Acme','https://cloud.example.test','acme');const body=JSON.parse(Buffer.from(envelope.payload,'base64url').toString());body.organization='other';envelope.payload=Buffer.from(JSON.stringify(body)).toString('base64url');
  act(()=>f.linking.listener?.({url:workplaceSetupLinks(JSON.stringify(envelope)).app}));await screen.findByText(/does not match its signature/);
  expect(f.clear).not.toHaveBeenCalled();expect(f.files.get('doc/aihr-company-v1.json')).toBe(old);
 });
 it('keeps a newer warm link when an older initial URL finishes loading late',async()=>{
  const f=fixture();let release!:(url:string)=>void;
  f.getInitialURL.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  render(<f.Provider><f.PrivateView/></f.Provider>);
  act(()=>f.linking.listener?.({url:workplaceSetupLinks(JSON.stringify(setup('New workplace','https://cloud.example.test','new'))).app}));
  await act(async()=>release(workplaceSetupLinks(JSON.stringify(setup('Old workplace','https://cloud.example.test','old'))).app));
  await screen.findByText('New workplace');expect(screen.queryByText('Old workplace')).not.toBeInTheDocument();
  expect(f.clear).not.toHaveBeenCalled();expect(f.files.has('doc/aihr-company-v1.json')).toBe(false);
 });
 it('requires another confirmation for a link arriving during an earlier workplace switch',async()=>{
  const f=fixture(),user=userEvent.setup();f.files.set('doc/aihr-company-v1.json',JSON.stringify(setup('Original','https://cloud.example.test','original')));
  render(<f.Provider><f.PrivateView/></f.Provider>);await screen.findByText('Signed-out connection: Original');
  act(()=>f.linking.listener?.({url:workplaceSetupLinks(JSON.stringify(setup('First workplace','https://cloud.example.test','first'))).app}));
  await screen.findByText('First workplace');let release!:()=>void;f.clear.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  await user.click(screen.getByRole('button',{name:'Use this company'}));
  act(()=>f.linking.listener?.({url:workplaceSetupLinks(JSON.stringify(setup('Second workplace','https://cloud.example.test','second'))).app}));
  await act(async()=>release());await screen.findByText('Second workplace');
  expect(f.applied()).toMatchObject({organization:'first'});expect(screen.queryByText('Signed-out connection: First workplace')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Use this company'}));await screen.findByText('Signed-out connection: Second workplace');
  expect(f.applied()).toMatchObject({organization:'second'});expect(f.clear).toHaveBeenCalledTimes(2);
 });
 it('imports a signed private company without recompilation and hides old views during cleanup',async()=>{const f=fixture(),user=userEvent.setup();f.files.set('doc/aihr-company-v1.json',JSON.stringify(setup('Old company','https://old.example.test')));f.files.set('cache/company.json',JSON.stringify(setup()));render(<f.Provider><f.PrivateView/></f.Provider>);await screen.findByText('Signed-out connection: Old company');await user.click(screen.getByRole('button',{name:'Import company setup'}));await screen.findByText('Private customer');let release!:()=>void;f.clear.mockImplementationOnce(()=>new Promise<void>(r=>{release=r;}));await user.click(screen.getByRole('button',{name:'Use this company'}));expect(screen.queryByText('Signed-out connection: Old company')).not.toBeInTheDocument();expect(screen.queryByText('Signed-out connection: Private customer')).not.toBeInTheDocument();await act(async()=>{release();});await screen.findByText('Signed-out connection: Private customer');expect(f.applied()).toMatchObject({apiOrigin:'https://private.example.test'});expect(f.deleted).toContain('cache/company.json');});
 it('pastes the app link and the setup text itself, and says exactly why a setup is refused',async()=>{
  const f=fixture(),user=userEvent.setup();render(<f.Provider><f.PrivateView/></f.Provider>);
  const signedSetup=JSON.stringify(setup('Acme','https://cloud.example.test','acme'));
  const field=()=>screen.getByLabelText('Paste setup link');
  await screen.findByLabelText('Paste setup link');
  await user.type(field(),workplaceSetupLinks(signedSetup).app);await user.click(screen.getByRole('button',{name:'Review setup link'}));
  await screen.findByText('acme');await user.click(screen.getByRole('button',{name:'Choose another company'}));
  // The file's own text pasted into the same field.
  await user.click(field());await user.paste(signedSetup);await user.click(screen.getByRole('button',{name:'Review setup link'}));
  await screen.findByText('acme');await user.click(screen.getByRole('button',{name:'Choose another company'}));
  const now=Math.floor(Date.now()/1000);
  const timed=(notBefore:number,expiresAt:number)=>{const bytes=Buffer.from(JSON.stringify({connectionVersion:1,apiVersion:'v1',authProvider:'internal',id:'acme',name:'Acme',hosting:'cloud',apiOrigin:'https://cloud.example.test',issuer:'https://cloud.example.test/auth',clientId:'aihr-mobile',audience:'aihr-api',organization:'acme',notBefore,expiresAt}));return JSON.stringify({keyId:'test',payload:bytes.toString('base64url'),signature:sign(null,bytes,pair.privateKey).toString('base64url')});};
  for(const [text,reason] of [[timed(now-7200,now-3600),/expired on /],[timed(now+3600,now+7200),/valid from .*date and time on this phone/],
    [workplaceSetupLinks(signedSetup).app.slice(0,-6),/not a complete workplace setup link/],['aihr://company#setup=',/not a complete workplace setup link/],
    ['hello',/not a complete workplace setup link/],[JSON.stringify({...JSON.parse(signedSetup),keyId:'retired-key'}),/key this app does not trust/]] as const){
   await user.clear(field());await user.click(field());await user.paste(text);await user.click(screen.getByRole('button',{name:'Review setup link'}));
   expect(await screen.findByText(reason)).toBeInTheDocument();expect(screen.queryByText('acme')).not.toBeInTheDocument();
  }
  // An unreadable picked file says so instead of blaming the setup.
  f.picker.mockResolvedValueOnce({canceled:false,assets:[{uri:'cache/missing.json'}]});
  await user.click(screen.getByRole('button',{name:'Import company setup'}));
  expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
  expect(f.clear).not.toHaveBeenCalled();expect(f.applied()).toBeNull();
 });
 it('rejects a forged setup file before changing the current company',async()=>{const f=fixture(),user=userEvent.setup();f.files.set('cache/company.json','{"keyId":"attacker","payload":"abc","signature":"abc"}');render(<f.Provider><f.PrivateView/></f.Provider>);await user.click(await screen.findByRole('button',{name:'Import company setup'}));await screen.findByText(/signed with a key this app does not trust/);expect(f.clear).not.toHaveBeenCalled();expect(f.applied()).toBeNull();expect(f.files.has('doc/aihr-company-v1.json')).toBe(false);});
});

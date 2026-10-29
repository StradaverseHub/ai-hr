/** Offline clock states on the shipped clock screen (owner design, 2026-10-28): the real clock panel and offline UI
 * module (mobile/lib/offline-clock.tsx) with the build switch ON, executed through the VM with OS/network ports injected
 * and the offline driver (mobile/lib/offline-sync.ts) replaced by a scripted fake. The driver itself is pinned in
 * mobile-offline-sync.dom.test.tsx; this file pins what the employee sees and which driver call each action makes. */
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JsxEmit,ModuleKind,transpileModule} from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {DEFAULT_MOBILE_DESIGN,mobilePalette} from '../lib/mobile-design';
import * as errors from '../mobile/lib/errors';
import * as contract from '../lib/mobile-api/contract';
import * as enrollment from '../mobile/lib/enrollment-journal';
import {SignedClockUnavailable,type SignedClockStatus} from '../mobile/lib/signed-clock-journal';
import * as journal from '../mobile/lib/submission-journal';
/* eslint-disable @typescript-eslint/no-explicit-any */
function load(path:string,ports:Record<string,unknown>){const module={exports:{} as any};runInNewContext(transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,{exports:module.exports,module,FormData,Date,Error,require:(id:string)=>{if(id==='react')return React;if(id==='react/jsx-runtime')return jsx;if(id in ports)return ports[id];throw new Error('Missing native screen port '+id);}});return module.exports;}
const origin='https://hr.example.com',ctx='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const kl=(at:number)=>new Date(at).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kuala_Lumpur'});
const ready=(permits=2)=>({phase:'context_ready',own:true,employmentId:'own',contextId:ctx,expiresAt:Date.now()+3600000,permitsRemaining:permits,claimCount:0});
const claim=(n:number,action:'in'|'out',claimedAt:number,rest:Record<string,unknown>={state:'waiting'})=>({requestId:`${String(n).padStart(8,'0')}-dddd-4ddd-8ddd-dddddddddddd`,contextId:ctx,sequence:n,action,claimedAt,...rest});
const source={provider:null,mock:false,simulated:null,accessory:null};

function fixture(options:{clock?:'loaded'|'offline';employmentId?:string|null}={}){
  let drafts:any,sequence=0,signedState:SignedClockStatus={status:'offline_pending',requestId:ctx,phase:'context_ready'};
  const view={exchange:null as any,claims:[] as any[]},staged=new Map<string,'in'|'out'>(),retained=new Set<string>();
  let foreground:(result:unknown)=>void=()=>{};
  const reload=vi.fn(),post=vi.fn(),remove=vi.fn(),alert=vi.fn();
  const capture=vi.fn(async()=>({lat:3,lng:101,accuracy:5,sampledAt:Date.now(),source}));
  const preview=vi.fn<(...args:unknown[])=>Promise<any>>(async()=>({outcome:'not_enforced',siteId:null,siteName:null,distanceM:null,radiusM:null,accuracyM:5,maximumAccuracyM:null}));
  const session={employmentId:options.employmentId===undefined?'own':options.employmentId,status:'signedIn',signOut:vi.fn()};
  const View=({children}:any)=><div>{children}</div>,Text=({children,accessibilityRole}:any)=><span role={accessibilityRole==='alert'?'alert':undefined}>{children}</span>;
  const Pressable=(p:any)=><button disabled={p.disabled} role={p.accessibilityRole??'button'} aria-label={p.accessibilityLabel} onClick={p.onPress}>{p.children}</button>;
  const native={Alert:{alert},View,Text,Pressable,TextInput:()=>null,Image:()=>null,AppState:{currentState:'active'},Platform:{OS:'ios'}};
  const t=(key:string,vars?:Record<string,unknown>)=>vars?[key,...Object.values(vars)].join(' '):key;
  const base={'react-native':native,'./session':{useSession:()=>session},'./auth':{authGeneration:()=>1,assertAuthGeneration:()=>{}},'./design':{DesignText:Text,useTenantDesign:()=>({design:DEFAULT_MOBILE_DESIGN,palette:mobilePalette(DEFAULT_MOBILE_DESIGN,'dark')})},'./errors':errors,'./i18n':{appLocale:()=>'en',t},'expo-crypto':{randomUUID:()=>`${String(++sequence).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`},'expo-router':{useFocusEffect:()=>{},router:{push:vi.fn()}}};
  const provider=load('mobile/lib/journey-drafts.tsx',{...base,'expo-file-system':{File:class{exists=false},Directory:class{exists=false},Paths:{cache:'cache'}}});
  const ui={InfoNote:({short,detail}:any)=><span><span>{short}</span><span>{detail}</span></span>,HeaderBack:()=><button aria-label="back">‹</button>,ListRow:({label,value,onPress}:any)=><button aria-label={value?`${label}, ${value}`:label} onClick={onPress}>{label}{value?`: ${value}`:''}</button>,Button:(p:any)=><button disabled={p.disabled} onClick={p.onPress}>{p.title}</button>,Card:View,Muted:Text,Row:({label,value}:any)=><p>{label}: {value}</p>,LoadState:({error}:any)=>error?<p>load error</p>:null,colors:{warn:'#9A5B00',danger:'#B42318'}};
  const clockState={enabled:true,employmentId:'own',state:{serverNow:'',date:'2026-10-28',clockedIn:false,openSince:null,geofencingRequired:false,workedSeconds:0,shift:{code:null,start:null,end:null},attendancePhotoSetting:'not_required',deviceRequired:false,captures:[] as any[],legacy:[]}};
  const clockRead=options.clock==='offline'?{data:null,reload,loading:false,error:new errors.NetworkUnavailableError()}:{data:clockState,reload,loading:false,error:null};
  const signed={
    identity:{anchored:options.clock==='offline'},
    offline:{claims:vi.fn(async()=>structuredClone(view))},
    status:vi.fn(async()=>signedState),
    capabilities:vi.fn<()=>Promise<any>>(async()=>({outcome:'unavailable',code:'not_configured'})),
    key:vi.fn(async()=>({})),
    recover:vi.fn(async()=>signedState),start:vi.fn(),advance:vi.fn(),
  };
  const openSigned=vi.fn(async(_employment:string,_unlocked:()=>boolean)=>signed);
  const engine={
    syncOffline:vi.fn<(c:unknown,o?:{manual?:boolean})=>Promise<any>>(async()=>({state:'offline'})),
    beforeOnlinePunch:vi.fn<(c:unknown,o:{open:(employment:string)=>Promise<unknown>})=>Promise<any>>(async()=>({route:'offline',contextId:ctx})),
    afterOnlinePunch:vi.fn(async()=>({state:'ready',contextId:ctx,expiresAt:Date.now()+3600000,permitsRemaining:2})),
    captureOfflinePunch:vi.fn(async(_c:unknown,requestId:string)=>{view.claims.push(claim(view.claims.length+1,staged.get(requestId)!,Date.now()));view.claims.at(-1)!.requestId=requestId;return {captured:{status:'captured'},proof:{status:'proof_ready'}};}),
    removeUndeliverable:vi.fn(async(_c:unknown,requestId:string)=>{view.claims=view.claims.filter(value=>value.requestId!==requestId);return structuredClone(view);}),
    keepOfflineSynced:vi.fn((_c:unknown,report:(result:unknown)=>void)=>{foreground=report;return ()=>{};}),
    armOffline:vi.fn(),offlineClaims:vi.fn(),subscribeOfflineForeground:vi.fn(),
  };
  const anchorRead=vi.fn(async()=>({version:1,namespace:'company',apiOrigin:origin,actorId:'actor',employmentId:'own',companyId:'company',platform:'ios'}));
  const offlineModule=(build:boolean)=>load('mobile/lib/offline-clock.tsx',{...base,'./config':{offlineClockingBuild:build,config:{apiUrl:origin},identityNamespace:()=>'company'},'./offline-sync':engine,'./offline-anchor':{readOfflineAnchor:anchorRead},'./signed-clock':{openOwnedSignedClock:openSigned},'expo-symbols':{SymbolView:()=>null},'./ui':ui});
  const offlineUi=offlineModule(true);
  const stage=vi.fn(async(command:string,file?:unknown,signals?:unknown)=>{const parsed=JSON.parse(command);staged.set(parsed.requestId,parsed.action);if(signals)retained.add(parsed.requestId);return {command,file};});
  const prepareClock=vi.fn(async(action:string,requestId:string)=>({requestId,kind:'clock',stage:'preparation',createdAt:Date.now(),command:JSON.stringify({action,requestId,claimedAt:Date.now()})}));
  const reportAttempt=vi.fn(async(requestId:string)=>({requestId,receivedAt:new Date().toISOString()})),resolve=vi.fn(async()=>{});
  const shared={...base,'./submission-journal':journal,'../../lib/mobile-api/contract':contract,'./enrollment-journal':enrollment,'./signed-clock-journal':{SignedClockUnavailable},'./signed-clock':{openOwnedSignedClock:openSigned},
    './submission-recovery':{useSubmissionRecovery:()=>({ready:true,error:null,reload:()=>{},stage,resolve,prepareClock,reportAttempt,hasSignedAttempt:async(id:string)=>retained.has(id)})},
    './journey-drafts':{...provider,removeLocalFile:remove},'./ui':ui,
    './api':{apiGet:vi.fn(),apiPost:(path:string,...args:unknown[])=>path==='clock-location'?preview(...args):post(path,...args),useApi:(path:string)=>path==='clock'?clockRead:{data:{items:[]},reload:vi.fn(),loading:false,error:null}},
    './capture':{capturePosition:capture,capturePhoto:vi.fn(async()=>null),appendAttachment:()=>{}},'./device-registration':{readClockDevice:async()=>null,writeClockDevice:async()=>{},clearClockDevice:async()=>{}},'./shift-reminder-signal':{requestShiftReminderRefresh:()=>{}},
    './slide-confirm':{SlideConfirm:(p:any)=><button disabled={p.disabled} onClick={p.onConfirm}>{p.label}</button>},'./offline-clock':offlineUi};
  const {ClockPanel}=load('mobile/lib/clock-panel.tsx',shared);
  function Probe(){drafts=provider.useJourneyDrafts();return null;}
  function App(){return <provider.JourneyDraftProvider><Probe/><ClockPanel/></provider.JourneyDraftProvider>;}
  return {App,view,engine,signed,openSigned,anchorRead,session,post,preview,capture,stage,prepareClock,reportAttempt,resolve,reload,alert,clockState,offlineModule,
    setSignedState:(value:SignedClockStatus)=>{signedState=value;},foreground:(result:unknown)=>foreground(result),drafts:()=>drafts};
}
const slide=(name:'slidePrepare'|'slideRecord')=>screen.getByText(new RegExp('^'+name));
afterEach(cleanup);

describe('no connection, offline clocking available',()=>{
 it('shows the warning banner and availability, captures the punch locally and lists it as waiting',async()=>{
  const f=fixture();f.view.exchange=ready(2);render(<f.App/>);
  await screen.findByText('offlineNoConnection');expect(screen.getByText(/^offlineAvailableUntil /)).toBeTruthy();
  expect(screen.queryByText('onlineClockOnly')).toBeNull();expect(screen.queryByText('signedClockOfflinePending')).toBeNull();
  expect(f.engine.keepOfflineSynced).toHaveBeenCalledWith(f.signed,expect.any(Function));
  fireEvent.click(slide('slidePrepare'));await waitFor(()=>expect(slide('slideRecord')).toBeTruthy());
  expect(f.engine.beforeOnlinePunch).toHaveBeenCalledOnce();expect(f.engine.beforeOnlinePunch.mock.calls[0][0]).toBe(f.signed);
  expect(f.engine.beforeOnlinePunch.mock.calls[0][1].open).toEqual(expect.any(Function));
  expect(f.prepareClock).toHaveBeenCalledBefore(f.engine.beforeOnlinePunch);expect(f.engine.beforeOnlinePunch).toHaveBeenCalledBefore(f.capture);
  expect(f.preview).not.toHaveBeenCalled();expect(f.signed.capabilities).not.toHaveBeenCalled();expect(f.signed.key).not.toHaveBeenCalled();
  fireEvent.click(slide('slideRecord'));await screen.findByText('offlinePunchSaved');
  const id=f.prepareClock.mock.calls[0][1];
  expect(f.stage).toHaveBeenCalledOnce();expect(f.stage.mock.calls[0][2]).toEqual(source);
  expect(f.engine.captureOfflinePunch).toHaveBeenCalledWith(f.signed,id);expect(f.stage).toHaveBeenCalledBefore(f.engine.captureOfflinePunch);
  expect(f.post).not.toHaveBeenCalled();expect(f.reportAttempt).not.toHaveBeenCalled();expect(f.signed.start).not.toHaveBeenCalled();expect(f.resolve).not.toHaveBeenCalled();
  await screen.findByText('offlineSavedPunches');expect(screen.getByText(/^clockIn · /)).toBeTruthy();expect(screen.getByText('offlineStatusWaiting')).toBeTruthy();
  expect(f.drafts().clock).toMatchObject({phase:'idle',action:'out'});
 });
 it('keeps the review open and retries the same request when local capture fails',async()=>{
  const f=fixture();f.view.exchange=ready(1);f.engine.captureOfflinePunch.mockRejectedValueOnce(new SignedClockUnavailable('expired'));render(<f.App/>);
  await screen.findByText('offlineNoConnection');fireEvent.click(slide('slidePrepare'));await waitFor(()=>expect(slide('slideRecord')).toBeTruthy());
  fireEvent.click(slide('slideRecord'));await screen.findByText('offlineExpired');expect(f.drafts().clock.phase).toBe('review');
  fireEvent.click(slide('slideRecord'));await screen.findByText('offlinePunchSaved');
  const ids=f.engine.captureOfflinePunch.mock.calls.map(([,requestId])=>requestId);expect(ids).toHaveLength(2);expect(new Set(ids).size).toBe(1);
  expect(f.stage).toHaveBeenCalledOnce();expect(f.post).not.toHaveBeenCalled();
 });
});

describe('offline cold start',()=>{
 it('opens the clock from the anchored employment with no server read, shows the saved state and clocks out offline',async()=>{
  const at=Date.now()-3600000,f=fixture({clock:'offline',employmentId:null});
  f.view.exchange=ready(1);f.view.claims=[claim(1,'in',at)];render(<f.App/>);
  await screen.findByText('offlineNoConnection');
  expect(f.anchorRead).toHaveBeenCalled();expect(f.openSigned.mock.calls.map(([employment])=>employment)).toContain('own');
  expect(screen.getByText(`offlineClockedInSince ${kl(at)}`)).toBeTruthy();
  expect(screen.queryByText('load error')).toBeNull();expect(screen.queryByText('clockHistory')).toBeNull();expect(screen.queryByText('reportedAttempts')).toBeNull();
  expect(slide('slidePrepare')).not.toBeDisabled();
  fireEvent.click(slide('slidePrepare'));await waitFor(()=>expect(slide('slideRecord')).toBeTruthy());
  expect(f.prepareClock.mock.calls[0][0]).toBe('out');
  fireEvent.click(slide('slideRecord'));await screen.findByText('offlinePunchSaved');
  expect(JSON.parse(f.stage.mock.calls[0][0]).action).toBe('out');expect(f.engine.captureOfflinePunch).toHaveBeenCalledOnce();expect(f.post).not.toHaveBeenCalled();
 });
 it('renders nothing offline when no anchor exists for this connection',async()=>{
  const f=fixture({clock:'offline',employmentId:null});f.anchorRead.mockResolvedValue(null as any);f.view.exchange=ready(1);render(<f.App/>);
  await waitFor(()=>expect(f.anchorRead).toHaveBeenCalled());expect(screen.getByText('load error')).toBeTruthy();
  expect(screen.queryByText('offlineNoConnection')).toBeNull();expect(f.openSigned).not.toHaveBeenCalled();expect(screen.queryByText(/^slidePrepare/)).toBeNull();
 });
});

describe('back online with saved punches',()=>{
 it('sends automatically, pauses clocking with the slider disabled and offers Retry now while waiting on backoff',async()=>{
  const f=fixture();f.view.exchange={...ready(0),claimCount:2};f.view.claims=[claim(1,'in',Date.now()-7200000),claim(2,'out',Date.now()-3600000)];
  f.engine.syncOffline.mockResolvedValue({state:'waiting',retryAt:Date.now()+30000});render(<f.App/>);
  await screen.findByText('offlineSending 2');expect(screen.getByText('offlinePaused')).toBeTruthy();expect(slide('slidePrepare')).toBeDisabled();
  expect(f.engine.syncOffline).toHaveBeenCalledWith(f.signed,{manual:false});
  fireEvent.click(await screen.findByText('offlineRetryNow'));
  await waitFor(()=>expect(f.engine.syncOffline).toHaveBeenLastCalledWith(f.signed,{manual:true}));
  // A foreground sync that records both punches ends the paused state and refreshes the server clock read.
  f.view.claims=f.view.claims.map(value=>({...value,state:'recorded',effectiveAt:value.claimedAt,receivedAt:value.claimedAt+1000}));f.view.exchange=ready(2);
  await act(async()=>{f.foreground({state:'ready',contextId:ctx,expiresAt:Date.now()+3600000,permitsRemaining:2});});
  await waitFor(()=>expect(screen.queryByText('offlineSending 2')).toBeNull());expect(slide('slidePrepare')).not.toBeDisabled();
  expect(f.reload).toHaveBeenCalled();expect(screen.getAllByText('offlineStatusRecorded')).toHaveLength(2);
 });
 it('uses the singular sending line and hides Retry now while a send is not waiting on backoff',async()=>{
  const f=fixture();f.view.exchange={...ready(1),claimCount:1};f.view.claims=[claim(1,'in',Date.now()-60000)];
  f.engine.syncOffline.mockResolvedValue({state:'blocked',reason:'not_signed'});render(<f.App/>);
  await screen.findByText('offlineSendingOne');expect(screen.queryByText('offlineRetryNow')).toBeNull();expect(slide('slidePrepare')).toBeDisabled();
 });
});

describe('saved punches list',()=>{
 it('shows every status in text with its reason, and removes an undeliverable punch only after confirmation',async()=>{
  const now=Date.now(),f=fixture();f.view.exchange={...ready(0),claimCount:4};
  const recorded=claim(1,'in',now-50000000,{state:'recorded',effectiveAt:now-40000000,receivedAt:now-30000000});
  const held=claim(2,'out',now-20000000,{state:'held',reason:'outside_geofence',receivedAt:now-10000000});
  const refused=claim(3,'in',now-9000000,{state:'not_recorded',reason:'offline_disabled',receivedAt:now-8000000});
  const stuck=claim(4,'out',now-7000000,{state:'undeliverable',reason:'invalid_proof'});
  const waiting=claim(5,'in',now-6000000);
  f.view.claims=[recorded,held,refused,stuck,waiting];f.engine.syncOffline.mockResolvedValue({state:'blocked',reason:'needs_attention'});render(<f.App/>);
  await screen.findByText('offlineSavedPunches');
  expect(screen.getByText(`clockIn · ${kl(now-40000000)}`)).toBeTruthy();expect(screen.queryByText(`clockIn · ${kl(now-50000000)}`)).toBeNull();
  for(const label of ['offlineStatusRecorded','offlineStatusWaiting','offlineStatusHeld','offlineStatusNotRecorded','offlineStatusUndeliverable'])expect(screen.getByText(label)).toBeTruthy();
  for(const reason of ['offlineReasonOutsideSite','offlineReasonDisabled','offlineReasonNotVerified','offlineAskHr'])expect(screen.getByText(reason)).toBeTruthy();
  expect(screen.getAllByText('offlineRemove')).toHaveLength(1);
  fireEvent.click(screen.getByText('offlineRemove'));expect(f.alert).toHaveBeenCalledOnce();expect(f.engine.removeUndeliverable).not.toHaveBeenCalled();
  const [title,body,buttons]=f.alert.mock.calls[0];expect([title,body]).toEqual(['offlineRemoveTitle','offlineRemoveConfirm']);
  const syncs=f.engine.syncOffline.mock.calls.length;
  await act(async()=>{buttons.find((button:{style?:string})=>button.style==='destructive').onPress();});
  await waitFor(()=>expect(f.engine.removeUndeliverable).toHaveBeenCalledWith(f.signed,stuck.requestId));
  await waitFor(()=>expect(screen.queryByText('offlineStatusUndeliverable')).toBeNull());
  await waitFor(()=>expect(f.engine.syncOffline.mock.calls.length).toBeGreaterThan(syncs));
 });
 it('maps every receipt and undeliverable reason to its own sentence, with a fallback for an unknown code',()=>{
  const m=fixture().offlineModule(true);
  expect(['continuity_unknown','time_unverifiable','outside_context_window','proven_window_too_wide'].map(m.offlineReason)).toEqual(Array(4).fill('offlineReasonTime'));
  expect(['key_unavailable','context_closed','attachment_mismatch','earlier_undeliverable','request_conflict','mystery'].map(m.offlineReason))
   .toEqual(['offlineReasonKey','offlineReasonPassEnded','offlineReasonPhotoMismatch','offlineReasonEarlier','offlineReasonDuplicate','offlineReasonUnknown']);
 });
 it('stays hidden while no exchange holds claims for this employment',async()=>{
  const f=fixture();f.engine.syncOffline.mockResolvedValue({state:'ready',contextId:ctx,expiresAt:Date.now()+3600000,permitsRemaining:2});f.view.exchange=ready(2);render(<f.App/>);
  await waitFor(()=>expect(f.engine.syncOffline).toHaveBeenCalled());
  expect(screen.queryByText('offlineSavedPunches')).toBeNull();expect(screen.queryByText('offlineNoConnection')).toBeNull();expect(screen.getByText('onlineClockOnly')).toBeTruthy();
 });
});

describe('online punches go through the driver first',()=>{
 it.each([['closing','offlineBlockedClosing'],['other_employment','offlineBlockedOtherEmployment'],['needs_attention','offlineBlockedAttention'],['pending','offlineBlockedPending']] as const)
 ('shows the %s refusal without capturing a location or sending',async(reason,message)=>{
  const f=fixture();f.engine.syncOffline.mockResolvedValue({state:'idle'});f.engine.beforeOnlinePunch.mockResolvedValue({route:'blocked',reason});render(<f.App/>);
  fireEvent.click(slide('slidePrepare'));await screen.findByText(message);
  expect(f.capture).not.toHaveBeenCalled();expect(f.preview).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();expect(f.signed.capabilities).not.toHaveBeenCalled();
  expect(f.drafts().clock.phase).toBe('idle');
 });
 it('opens the employment that holds another job’s exchange and does not block on its pending state',async()=>{
  const f=fixture();f.view.exchange={phase:'context_ready',own:false,employmentId:'other',contextId:null,expiresAt:null,permitsRemaining:null,claimCount:null};
  f.setSignedState({status:'other_pending'});f.engine.syncOffline.mockResolvedValue({state:'blocked',reason:'other_employment'});
  f.engine.beforeOnlinePunch.mockImplementation(async(_c,options)=>{await options.open('other');return {route:'blocked',reason:'other_employment'};});
  render(<f.App/>);await waitFor(()=>expect(f.engine.syncOffline).toHaveBeenCalled());
  expect(screen.queryByText('signedClockOtherPending')).toBeNull();expect(slide('slidePrepare')).not.toBeDisabled();
  fireEvent.click(slide('slidePrepare'));await screen.findByText('offlineBlockedOtherEmployment');
  expect(f.openSigned).toHaveBeenCalledWith('other',expect.any(Function));expect(f.capture).not.toHaveBeenCalled();
 });
 it('clocks online after the driver clears the exchange, then re-arms with afterOnlinePunch',async()=>{
  const f=fixture();f.view.exchange=ready(2);f.engine.syncOffline.mockResolvedValue({state:'ready',contextId:ctx,expiresAt:Date.now()+3600000,permitsRemaining:2});
  f.engine.beforeOnlinePunch.mockImplementation(async()=>{f.view.exchange=null;f.setSignedState({status:'empty'});return {route:'online'};});
  render(<f.App/>);await waitFor(()=>expect(f.engine.syncOffline).toHaveBeenCalled());
  fireEvent.click(slide('slidePrepare'));await waitFor(()=>expect(slide('slideRecord')).toBeTruthy());
  expect(f.engine.beforeOnlinePunch).toHaveBeenCalledBefore(f.signed.capabilities);expect(f.engine.beforeOnlinePunch).toHaveBeenCalledBefore(f.capture);expect(f.preview).toHaveBeenCalledOnce();
  f.post.mockResolvedValueOnce({outcome:'accepted',receipt:contract.ClockReceipt.parse({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',direction:'in',date:'2026-10-28',recordedAt:'2026-10-28T01:00:00Z',photoAvailable:false})});
  fireEvent.click(slide('slideRecord'));await screen.findByText('clockRecorded');
  await waitFor(()=>expect(f.engine.afterOnlinePunch).toHaveBeenCalledWith(f.signed));expect(f.engine.captureOfflinePunch).not.toHaveBeenCalled();
 });
});

describe('sign-out note',()=>{
 it('counts only the waiting punches of the anchored employment’s current exchange',async()=>{
  const f=fixture(),m=f.offlineModule(true),now=Date.now();
  f.view.exchange=ready(0);f.view.claims=[claim(1,'in',now-4000),claim(2,'out',now-3000),claim(3,'in',now-2000,{state:'recorded',effectiveAt:now-2000,receivedAt:now}),{...claim(4,'out',now-1000),contextId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}];
  expect(await m.queuedOfflinePunches(()=>true)).toBe(2);expect(f.openSigned).toHaveBeenCalledWith('own',expect.any(Function));
  function Probe(){return <p>{`queued ${m.useQueuedOfflinePunches(()=>true)}`}</p>;}
  render(<Probe/>);await screen.findByText('queued 2');
 });
 it('reads nothing without an anchor for this connection, and nothing at all with the switch off',async()=>{
  const f=fixture();f.view.exchange=ready(0);f.view.claims=[claim(1,'in',Date.now())];
  f.anchorRead.mockResolvedValueOnce({...(await f.anchorRead()),apiOrigin:'https://other.example.com'});
  expect(await f.offlineModule(true).queuedOfflinePunches(()=>true)).toBe(0);
  f.anchorRead.mockResolvedValueOnce(null as any);expect(await f.offlineModule(true).queuedOfflinePunches(()=>true)).toBe(0);
  expect(f.openSigned).not.toHaveBeenCalled();
  f.anchorRead.mockClear();expect(await f.offlineModule(false).queuedOfflinePunches(()=>true)).toBe(0);expect(f.anchorRead).not.toHaveBeenCalled();
 });
});

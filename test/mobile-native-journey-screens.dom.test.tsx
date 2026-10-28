/** Shipped screens with OS/network ports injected; actual server rules are tested separately. */
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
function load(path:string,ports:Record<string,unknown>){const module={exports:{} as any};runInNewContext(transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,{exports:module.exports,module,FormData,Date,Error,require:(id:string)=>{if(id==='react')return React;if(id==='react/jsx-runtime')return jsx;if(id in ports)return ports[id];throw new Error('Missing native screen port '+id);}});return module.exports;}
function fixture(platform:'ios'|'android'='ios'){
  let drafts:any,sequence=0;const reload=vi.fn(),get=vi.fn(),post=vi.fn(),remove=vi.fn(),capture=vi.fn<()=>Promise<{lat:number;lng:number;accuracy:number;sampledAt:number;permissionAccuracy?:'precise'|'approximate'|'unavailable';source?:import('../lib/mobile-clock-integrity').ClockSourceSignals}>>(async()=>({lat:3,lng:101,accuracy:5,sampledAt:Date.now(),source:{provider:null,mock:false,simulated:null,accessory:null}}));
  const photo=vi.fn<()=>Promise<any>>(async()=>null);
  const reloadAttempts=vi.fn(),attemptsState={items:[] as any[]};
  const preview=vi.fn<(...args:unknown[])=>Promise<any>>(async()=>({outcome:'not_enforced',siteId:null,siteName:null,distanceM:null,radiusM:null,accuracyM:5,maximumAccuracyM:null}));
  const session={employmentId:'own',status:'signedIn',signOut:vi.fn()};
  const View=({children}:any)=><div>{children}</div>,Text=({children,accessibilityRole}:any)=><span role={accessibilityRole==='alert'?'alert':undefined}>{children}</span>;
  const Pressable=(p:any)=><button disabled={p.disabled} role={p.accessibilityRole??'button'} aria-label={p.accessibilityLabel} aria-checked={p.accessibilityState?.checked} onClick={p.onPress}>{p.children}</button>;
  const alert=vi.fn();
  const native={Alert:{alert},View,Text,Pressable,TextInput:(p:any)=><input aria-label={p.accessibilityLabel} disabled={!p.editable} value={p.value} onChange={e=>p.onChangeText(e.target.value)}/>,Image:()=>null,AppState:{currentState:'active'},Platform:{OS:platform}};
  const base={'react-native':native,'./session':{useSession:()=>session},'./auth':{authGeneration:()=>1,assertAuthGeneration:()=>{}},'./design':{DesignText:Text,useTenantDesign:()=>({design:DEFAULT_MOBILE_DESIGN,palette:mobilePalette(DEFAULT_MOBILE_DESIGN,'dark')})},'./errors':errors,'./i18n':{appLocale:()=>'en',t:(s:string,v?:any)=>s==='awayToday'?`${s} ${v.n}/${v.total}`:s},'expo-crypto':{randomUUID:()=>`${String(++sequence).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`},'expo-router':{useFocusEffect:()=>{},router:{push:vi.fn()}}};
  const provider=load('mobile/lib/journey-drafts.tsx',{...base,'expo-file-system':{File:class{exists=false},Directory:class{exists=false},Paths:{cache:'cache'}}});
  const ui={Button:(p:any)=><button disabled={p.disabled} onClick={p.onPress}>{p.title}</button>,Card:View,Muted:Text,Row:({label,value}:any)=><p>{label}: {value}</p>,LoadState:()=>null,fmtDays:(n:unknown)=>n==null?'—':String(n)};
  const clockState={enabled:true,employmentId:'own',state:{date:'2026-01-01',clockedIn:false,geofencingRequired:false,workedSeconds:0,shift:{code:null,start:null,end:null},attendancePhotoSetting:'not_required',deviceRequired:false,captures:[],legacy:[]}};
  const teamState={enabled:true,today:'2026-01-01',items:[{employmentId:'a',name:'Approved Away',dates:[{date:'2026-01-01',status:'approved',session:'full_day'}]},{employmentId:'b',name:'Pending Colleague',dates:[{date:'2026-01-01',status:'pending',session:'AM'}]}]};
  let signedState:SignedClockStatus={status:'empty'},restoredClock:any;
  const retained=new Set<string>();
  const signed={
    status:vi.fn(async()=>signedState),
    capabilities:vi.fn<()=>Promise<any>>(async()=>({outcome:'unavailable',code:'not_configured'})),
    key:vi.fn(async()=>({})),
    recover:vi.fn<((abandon?:boolean,requestId?:string)=>Promise<SignedClockStatus>)>(async()=>signedState),
    start:vi.fn(async(id:string)=>{signedState={status:'pending',phase:'intent',requestId:id,action:'in'};return signedState;}),
    advance:vi.fn<(requestId?:string)=>Promise<SignedClockStatus>>(async()=>{signedState={status:'empty'};return {status:'accepted',receipt:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',direction:'in',date:'2026-01-01',recordedAt:'2026-01-01T08:00:00.000Z',photoAvailable:false}};}),
  };
  const openSigned=vi.fn(async()=>signed);
  const hasSignedAttempt=vi.fn(async(id:string)=>retained.has(id));
  const stage=vi.fn(async(command:string,file?:unknown,source?:unknown)=>{if(source)retained.add(JSON.parse(command).requestId);return {command,file};}),resolve=vi.fn(async()=>{});
  const prepareClock=vi.fn(async(action:string,requestId:string)=>({requestId,kind:'clock',stage:'preparation',createdAt:Date.now(),command:JSON.stringify({action,requestId,claimedAt:Date.now()})}));
  const reportAttempt=vi.fn(async(requestId:string,_operation?:{assertCurrent():void})=>({requestId,receivedAt:new Date().toISOString()}));
  // The shipped offline UI module with the build switch OFF (the default); every driver and anchor entry is a spy.
  const engine={armOffline:vi.fn(),syncOffline:vi.fn(),beforeOnlinePunch:vi.fn(),afterOnlinePunch:vi.fn(),captureOfflinePunch:vi.fn(),offlineClaims:vi.fn(),removeUndeliverable:vi.fn(),subscribeOfflineForeground:vi.fn(),keepOfflineSynced:vi.fn()};
  const anchorRead=vi.fn(async()=>null);
  const offlineUi=load('mobile/lib/offline-clock.tsx',{...base,'./config':{offlineClockingBuild:false,config:{apiUrl:'https://hr.example.com'},identityNamespace:()=>'company'},'./offline-sync':engine,'./offline-anchor':{readOfflineAnchor:anchorRead},'./signed-clock':{openOwnedSignedClock:openSigned},'expo-symbols':{SymbolView:()=>null},'./ui':{...ui,colors:{warn:'#9A5B00',danger:'#B42318'}}});
  const shared={...base,'./submission-journal':journal,'../../lib/mobile-api/contract':contract,'./enrollment-journal':enrollment,'./signed-clock-journal':{SignedClockUnavailable},'./signed-clock':{openOwnedSignedClock:openSigned},'./submission-recovery':{useSubmissionRecovery:(_kind:string,_id:string,onRestore:(value:unknown)=>void)=>{
    React.useEffect(()=>{if(restoredClock){const value=restoredClock;if(value.entry.integrity)retained.add(value.entry.requestId);onRestore(value);}},[]);
    return {ready:true,error:null,reload:()=>{},stage,resolve,prepareClock,reportAttempt,hasSignedAttempt};
  }},'./journey-drafts':{...provider,removeLocalFile:remove},'./ui':ui,'./api':{apiGet:get,apiPost:(path:string,...args:unknown[])=>path==='clock-location'?preview(...args):post(path,...args),useApi:(path:string)=>({data:path==='clock-attempts'?attemptsState:path==='team'?teamState:clockState,reload:path==='clock-attempts'?reloadAttempts:reload,loading:false,error:null})},'./capture':{capturePosition:capture,capturePhoto:photo,appendAttachment:()=>{}},'./device-registration':{readClockDevice:async()=>null,writeClockDevice:async()=>{},clearClockDevice:async()=>{}},'./slide-confirm':{SlideConfirm:(p:any)=><button disabled={p.disabled} onClick={p.onConfirm}>{p.label}</button>},'./offline-clock':offlineUi,'expo-document-picker':{getDocumentAsync:async()=>({canceled:true})},'expo-file-system':{}};
  const {ClockPanel}=load('mobile/lib/clock-panel.tsx',shared),{LeaveRequestForm}=load('mobile/lib/leave-request-form.tsx',shared),{TeamPanel}=load('mobile/lib/team-panel.tsx',shared);
  function Probe(){drafts=provider.useJourneyDrafts();return null;}
  const options={employmentId:'own',items:[{id:'annual',name:'Annual leave',durations:['full_day','half_day_am','hourly'],allowedMimeTypes:[],maxDocBytes:10485760,requiresDocument:false,emergencySplit:false}]};
  function App({kind,refreshToken=0,visible=true}:{kind:'clock'|'leave'|'team';refreshToken?:number;visible?:boolean}){return <provider.JourneyDraftProvider><Probe/>{!visible?null:kind==='clock'?<ClockPanel refreshToken={refreshToken}/>:kind==='team'?<TeamPanel refreshToken={refreshToken}/>:<LeaveRequestForm options={options} today="2026-01-01" onSubmitted={reload}/>}</provider.JourneyDraftProvider>;}
  return {App,engine,anchorRead,session,post,signed,openSigned,alert,hasSignedAttempt,setSignedState:(value:SignedClockStatus)=>{signedState=value;},restoreClock:(value:unknown)=>{restoredClock=value;},preview,get,capture,reload,stage,resolve,prepareClock,reportAttempt,remove,teamState,clockState,photo,attemptsState,reloadAttempts,drafts:()=>drafts};
}
afterEach(cleanup);
describe('native clock job',()=>{
  it('allows an approximate fix when the shared site rule passes and keeps permission metadata out of the strict preview body',async()=>{
    const f=fixture();f.clockState.state.geofencingRequired=true;
    f.capture.mockImplementationOnce(async()=>({lat:3,lng:101,accuracy:500,sampledAt:Date.now(),permissionAccuracy:'approximate' as const}));
    f.preview.mockResolvedValueOnce({outcome:'pass',siteId:'own',siteName:'Campus',distanceM:0,radiusM:1000,accuracyM:500,maximumAccuracyM:null});
    render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');
    expect(f.preview.mock.calls[0][0]).not.toHaveProperty('permissionAccuracy');expect(screen.queryByText('openLocationSettings')).toBeNull();
    expect(f.post).not.toHaveBeenCalled();
  });
  it('offers precise-permission recovery when an approximate fix actually fails the site rule',async()=>{
    const f=fixture();f.capture.mockImplementationOnce(async()=>({lat:3,lng:101,accuracy:500,sampledAt:Date.now(),permissionAccuracy:'approximate' as const}));
    f.preview.mockResolvedValueOnce({outcome:'outside_site',siteId:'own',siteName:'Office',distanceM:0,radiusM:50,accuracyM:500,maximumAccuracyM:null});
    render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('locationApproximate');
    expect(screen.getByText('openLocationSettings')).toBeTruthy();expect(f.post).not.toHaveBeenCalled();
  });
  it('keeps an unsent attempt when a required photo is cancelled after location capture',async()=>{
    const f=fixture();f.clockState.state.attendancePhotoSetting='required';render(<f.App kind="clock"/>);
    fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('photoRequired');
    expect(f.prepareClock).toHaveBeenCalledBefore(f.photo);expect(f.drafts().clock.requestId).toBeTruthy();
    expect(f.drafts().clock.phase).toBe('idle');expect(f.stage).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();
    expect(screen.getByText('sendAttemptRecord')).toBeTruthy();
  });
  it('shows received attempt records separately from accepted clock history',()=>{
    const f=fixture();f.attemptsState.items.push({requestId:'own-report',action:'in',claimedAt:Date.now()-1000,receivedAt:new Date().toISOString()});
    render(<f.App kind="clock"/>);expect(screen.getByText('reportedAttemptsHint')).toBeTruthy();expect(screen.getByText('own-report')).toBeTruthy();
    expect(screen.queryByText('clockRecorded')).toBeNull();expect(f.post).not.toHaveBeenCalled();
  });
  it.each([new errors.UnavailableError(),new errors.RequestRejectedError(404)])('retains a staged command without sending attendance when its attempt receipt fails (%s)',async(error)=>{
    const f=fixture();render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');
    const id=f.drafts().clock.requestId;f.reportAttempt.mockRejectedValueOnce(error);
    fireEvent.click(screen.getByText('slideRecord'));await screen.findByText('attemptReportRequired');
    expect(f.stage).toHaveBeenCalledBefore(f.reportAttempt);expect(f.post).not.toHaveBeenCalled();expect(f.resolve).not.toHaveBeenCalled();
    expect(f.drafts().clock).toMatchObject({requestId:id,phase:'uncertain'});
    f.post.mockResolvedValueOnce({outcome:'refused',code:'clock_conflict'});
    fireEvent.click(screen.getByRole('button',{name:'retrySameClock'}));await screen.findByText('clockConflict');
    expect(f.reportAttempt).toHaveBeenCalledBefore(f.post);expect(f.resolve).toHaveBeenCalledWith(id);
  });
  it('saves the attempt before GPS and sends no location when its durable save fails',async()=>{
    const f=fixture();f.prepareClock.mockRejectedValueOnce(new Error('Disk full'));
    render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('attemptSaveFailed');
    expect(f.capture).not.toHaveBeenCalled();expect(f.preview).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();
  });
  it('keeps the stable attempt after GPS failure and reports it without recording attendance',async()=>{
    const f=fixture();f.capture.mockRejectedValueOnce(new Error('No location'));
    render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('No location');
    expect(f.prepareClock).toHaveBeenCalledBefore(f.capture);const id=f.drafts().clock.requestId;
    expect(id).toBeTruthy();expect(f.drafts().clock.attemptStartedAt).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('sendAttemptRecord'));await screen.findAllByText('attemptReported');
    expect(f.reportAttempt).toHaveBeenCalledWith(id,{assertCurrent:expect.any(Function)});expect(f.post).not.toHaveBeenCalled();expect(f.stage).not.toHaveBeenCalled();
    expect(f.drafts().clock.phase).toBe('idle');expect(screen.queryByText('clockRecorded')).toBeNull();
  });
  it('shows the assigned-site quality refusal without staging or sending attendance',async()=>{
    const f=fixture();f.preview.mockResolvedValueOnce({outcome:'outside_site',siteId:'assigned',siteName:'Main office',distanceM:20,radiusM:30,accuracyM:15,maximumAccuracyM:null});
    render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('locationOutsideSite');
    expect(screen.getByText('assignedLocation: Main office')).toBeTruthy();expect(screen.getByText('locationDistance: 20 m')).toBeTruthy();
    expect(f.stage).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();expect(f.drafts().clock.phase).toBe('idle');
  });
  it('cleans the decrypted upload copy after an uncertain response while retaining the original review evidence',async()=>{
    const f=fixture();render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');
    const original={uri:'original-photo',name:'photo.jpg',mimeType:'image/jpeg',size:3},upload={...original,uri:'upload-copy'};
    act(()=>f.drafts().putClock({...f.drafts().clock,photo:original}));
    f.stage.mockImplementationOnce(async(command:string)=>({command,file:upload}));f.post.mockRejectedValueOnce(new errors.UnavailableError());
    fireEvent.click(screen.getByText('slideRecord'));await screen.findByText('checkReceipt');
    expect(f.remove).toHaveBeenCalledWith(upload);expect(f.remove).not.toHaveBeenCalledWith(original);expect(f.drafts().clock.photo).toEqual(original);
  });
  it('never sends a clock command when its durable save fails',async()=>{
    const f=fixture();render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');
    f.stage.mockRejectedValueOnce(new Error('Disk full'));fireEvent.click(screen.getByText('slideRecord'));
    await screen.findByText('checkReceipt');expect(f.post).not.toHaveBeenCalled();expect(f.resolve).not.toHaveBeenCalled();
  });
  it('prepares and reviews without recording; timeout preserves one immutable command for explicit retry',async()=>{
    const f=fixture();render(<f.App kind="clock"/>);expect(f.post).not.toHaveBeenCalled();fireEvent.click(screen.getByText('slidePrepare'));
    await screen.findByText('slideRecord');expect(f.capture).toHaveBeenCalledTimes(1);expect(f.post).not.toHaveBeenCalled();
    f.post.mockRejectedValueOnce(new errors.UnavailableError());fireEvent.click(screen.getByText('slideRecord'));await screen.findAllByText('retrySameClock');expect(f.post).toHaveBeenCalledTimes(1);
    const command=(f.post.mock.calls[0][1] as FormData).get('command');expect(f.drafts().clock.phase).toBe('uncertain');
    f.post.mockResolvedValueOnce({outcome:'accepted',receipt:contract.ClockReceipt.parse({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',direction:'in',date:'2026-01-01',recordedAt:'2026-01-01T01:00:00Z',photoAvailable:false})});fireEvent.click(screen.getByRole('button',{name:'retrySameClock'}));await screen.findByText('clockRecorded');expect((f.post.mock.calls[1][1] as FormData).get('command')).toBe(command);expect(f.post).toHaveBeenCalledTimes(2);expect(screen.getByText(/9:00/)).toBeTruthy();expect(screen.queryByText('2026-01-01T01:00:00Z')).toBeNull();
  });
  it('cancelling a prepared capture writes nothing, and a definitive refusal permits a new attempt',async()=>{
    const f=fixture();render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');fireEvent.click(screen.getByText('cancel'));expect(f.post).not.toHaveBeenCalled();expect(f.drafts().clock).toMatchObject({phase:'idle',message:'attemptSavedNotSent'});
    fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');f.post.mockRejectedValueOnce(new errors.RequestRejectedError(400));fireEvent.click(screen.getByText('slideRecord'));await screen.findByText('slidePrepare');expect(f.drafts().clock.phase).toBe('idle');
  });
});
describe('native leave job',()=>{
  it('does not send a leave command if its durable save fails after preview',async()=>{
    const f=fixture();render(<f.App kind="leave"/>);fireEvent.click(screen.getByText('Annual leave'));
    f.post.mockResolvedValueOnce({days:1,overrides:[]});fireEvent.click(screen.getByText('reviewRequest'));await screen.findByText('submitRequest');
    f.stage.mockRejectedValueOnce(new Error('Disk full'));fireEvent.click(screen.getByText('submitRequest'));
    await screen.findByText('checkReceipt');expect(f.post).toHaveBeenCalledTimes(1);expect(f.post.mock.calls[0][0]).toBe('leave-preview');
  });
  it('requires a server preview and each material consent before submitting; timeout retry preserves reference',async()=>{
    const f=fixture();render(<f.App kind="leave"/>);fireEvent.click(screen.getByText('Annual leave'));expect(f.post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox',{name:'reason'}),{target:{value:'Personal travel'}});
    f.post.mockResolvedValueOnce({days:1,unpaidDays:0,overrides:[{consentToken:'conversion',action:'convert_to_emergency',fromTypeName:'Annual leave',toTypeName:'Emergency leave',needsConsent:true}]});
    fireEvent.click(screen.getByText('reviewRequest'));await screen.findByText('submitRequest');expect(f.post).toHaveBeenCalledTimes(1);expect(f.post.mock.calls[0][0]).toBe('leave-preview');expect(screen.getByText('submitRequest')).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));expect(screen.getByText('submitRequest')).not.toBeDisabled();f.post.mockRejectedValueOnce(new errors.UnavailableError());fireEvent.click(screen.getByText('submitRequest'));await screen.findByText('leaveUncertain');
    const original=(f.post.mock.calls[1][1] as FormData).get('command');f.post.mockResolvedValueOnce({outcome:'accepted',id:'receipt'});fireEvent.click(screen.getByText('retrySameClock'));await screen.findByText('requestRecorded');expect((f.post.mock.calls[2][1] as FormData).get('command')).toBe(original);expect(f.reload).toHaveBeenCalledTimes(1);
  });
  it('shows half/hour inputs from eligibility, and cancellation never submits',()=>{
    const f=fixture();render(<f.App kind="leave"/>);fireEvent.click(screen.getByText('Annual leave'));fireEvent.click(screen.getByText('hourly'));expect(screen.getByRole('textbox',{name:'fromTime'})).toBeTruthy();expect(screen.getByRole('textbox',{name:'toTime'})).toBeTruthy();expect(screen.queryByRole('textbox',{name:'endDate'})).toBeNull();fireEvent.click(screen.getByText('cancel'));expect(f.post).not.toHaveBeenCalled();expect(f.drafts().leave).toBeNull();
  });
});

describe('native team availability and refresh',()=>{
  it('counts approved absence only and renders session names for people, without raw enum labels',()=>{
    const f=fixture(),ui=render(<f.App kind="team"/>);fireEvent.click(screen.getByRole('button',{name:/awayToday 1\/2/}));expect(screen.getByText(/fullDay/)).toBeTruthy();expect(screen.getByText(/halfAM/)).toBeTruthy();expect(screen.queryByText(/full_day/)).toBeNull();
    ui.rerender(<f.App kind="team" refreshToken={1}/>);expect(f.reload).toHaveBeenCalledTimes(1);f.teamState.enabled=false;ui.rerender(<f.App kind="team" refreshToken={1}/>);expect(screen.queryByText('teamAvailability')).toBeNull();
  });
  it('Home refresh reloads the shared clock read without submitting or discarding a draft',async()=>{
    const f=fixture(),ui=render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');const id=f.drafts().clock.requestId;ui.rerender(<f.App kind="clock" refreshToken={1}/>);expect(f.reload).toHaveBeenCalledTimes(1);expect(f.drafts().clock.requestId).toBe(id);expect(f.post).not.toHaveBeenCalled();
  });
});


describe('explicit receipt lookup',()=>{
  it('clock Check receipt resolves the same reference without resubmitting its command',async()=>{
    const f=fixture();render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');
    f.post.mockRejectedValueOnce(new errors.UnavailableError());fireEvent.click(screen.getByText('slideRecord'));await screen.findByText('checkReceipt');
    const id=f.drafts().clock.requestId;f.get.mockResolvedValueOnce({kind:'clock',requestId:id,receipt:contract.ClockReceipt.parse({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',direction:'in',date:'2026-01-01',recordedAt:'2026-01-01T01:00:00Z',photoAvailable:false})});
    fireEvent.click(screen.getByText('checkReceipt'));await screen.findByText('clockRecorded');expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.get).toHaveBeenCalledWith('submission-receipt',{kind:'clock',requestId:id,employmentId:'own'});
  });
  it('leave Check receipt resolves its accepted response instead of merely refreshing history',async()=>{
    const f=fixture();render(<f.App kind="leave"/>);fireEvent.click(screen.getByText('Annual leave'));f.post.mockResolvedValueOnce({days:1,overrides:[]});
    fireEvent.click(screen.getByText('reviewRequest'));await screen.findByText('submitRequest');f.post.mockRejectedValueOnce(new errors.UnavailableError());
    fireEvent.click(screen.getByText('submitRequest'));await screen.findByText('checkReceipt');const id=f.drafts().leave.command.requestId;
    f.get.mockResolvedValueOnce({kind:'leave',requestId:id,receipt:{outcome:'accepted',id:'accepted',holidayWarning:false,maternityAllowanceWarning:false}});
    fireEvent.click(screen.getByText('checkReceipt'));await screen.findByText('requestRecorded');expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.get).toHaveBeenCalledWith('submission-receipt',{kind:'leave',requestId:id,employmentId:'own'});
  });
});


describe('signed native clock screen',()=>{
 for(const platform of ['ios','android'] as const){
  it(platform+' selects signed mode, saves source metadata and never calls the unsigned clock endpoint',async()=>{
   const f=fixture(platform);f.signed.capabilities.mockResolvedValue({outcome:'capabilities'});
   render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');
   expect(f.drafts().clock.clockProtocol).toBe('signed');fireEvent.click(screen.getByText('slideRecord'));
   await screen.findByText('clockRecorded');expect(f.stage).toHaveBeenCalledOnce();
   expect(f.stage.mock.calls[0][2]).toEqual({provider:null,mock:false,simulated:null,accessory:null});
   expect(f.signed.start).toHaveBeenCalledOnce();expect(f.signed.advance).toHaveBeenCalledOnce();expect(f.resolve).not.toHaveBeenCalled();
   expect(f.post).not.toHaveBeenCalled();expect(f.reportAttempt).toHaveBeenCalledOnce();
  });
 }
 it('retries the retained signed command after connection loss without a second capture or stage',async()=>{
  const f=fixture();f.signed.capabilities.mockResolvedValue({outcome:'capabilities'});f.signed.advance.mockRejectedValueOnce(new errors.UnavailableError());
  render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');fireEvent.click(screen.getByText('slideRecord'));
  await screen.findByRole('button',{name:'retrySameClock'});const id=f.drafts().clock.requestId;
  fireEvent.click(screen.getByRole('button',{name:'retrySameClock'}));await screen.findByText('clockRecorded');
  expect(f.stage).toHaveBeenCalledOnce();expect(f.capture).toHaveBeenCalledOnce();expect(f.signed.start.mock.calls.map(([id])=>id)).toEqual([id,id]);expect(f.post).not.toHaveBeenCalled();
 });
 it('blocks a new capture while another work profile owns an unresolved signed attempt',async()=>{
  const f=fixture();f.setSignedState({status:'other_pending'});render(<f.App kind="clock"/>);
  await screen.findByText('signedClockOtherPending');expect(screen.getByText('slidePrepare')).toBeDisabled();
  expect(f.capture).not.toHaveBeenCalled();expect(f.prepareClock).not.toHaveBeenCalled();expect(f.signed.key).not.toHaveBeenCalled();
 });
 it('offers device registration before capture if the signed key is missing',async()=>{
  const f=fixture();f.signed.capabilities.mockResolvedValue({outcome:'capabilities'});f.signed.key.mockRejectedValue(new enrollment.EnrollmentConflict());
  render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByRole('button',{name:'integrityEnrollmentTitle'});
  expect(f.capture).not.toHaveBeenCalled();expect(f.prepareClock).toHaveBeenCalledOnce();expect(f.stage).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();
 });
 it('does not choose unsigned clocking when signed discovery is unavailable',async()=>{
  const f=fixture();f.signed.capabilities.mockRejectedValue(new errors.UnavailableError());
  render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await waitFor(()=>expect(f.drafts().clock.phase).toBe('idle'));
  expect(f.capture).not.toHaveBeenCalled();expect(f.prepareClock).toHaveBeenCalledOnce();expect(f.post).not.toHaveBeenCalled();
 });
 it('restores the signed marker and refuses transport downgrade when the deployment route disappears',async()=>{
  const f=fixture(),id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const command={requestId:id,action:'in',lat:3,lng:101,accuracy:5,sampledAt:Date.now()};
  f.restoreClock({entry:{kind:'clock',requestId:id,integrity:{version:1,source:{provider:null,mock:false,simulated:null,accessory:null}}},command:JSON.stringify(command)});
  f.signed.start.mockRejectedValue(new errors.RequestRejectedError(404));
  render(<f.App kind="clock"/>);await screen.findByRole('button',{name:'retrySameClock'});fireEvent.click(screen.getByRole('button',{name:'retrySameClock'}));
  await waitFor(()=>expect(f.signed.start).toHaveBeenCalled());await waitFor(()=>expect(f.drafts().clock.phase).toBe('uncertain'));
  expect(f.drafts().clock.clockProtocol).toBe('signed');expect(f.capture).not.toHaveBeenCalled();expect(f.stage).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();expect(f.resolve).not.toHaveBeenCalled();
 });
 it('hydrates a global pending reference without capturing or uploading, and recovers its receipt without a photo',async()=>{
  const f=fixture();f.setSignedState({status:'pending',requestId:'saved-global',action:'in',phase:'sent'});
  render(<f.App kind="clock"/>);await screen.findByRole('button',{name:'checkReceipt'});
  expect(f.capture).not.toHaveBeenCalled();expect(f.signed.advance).not.toHaveBeenCalled();expect(f.reportAttempt).not.toHaveBeenCalled();
  f.signed.recover.mockResolvedValue({status:'accepted',receipt:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',direction:'in',date:'2026-01-01',recordedAt:'2026-01-01T08:00:00.000Z',photoAvailable:true}});
  fireEvent.click(screen.getByRole('button',{name:'checkReceipt'}));await screen.findByText('clockRecorded');expect(f.resolve).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();
 });
 it('requires explicit discard confirmation and keeps pending work until server-ordered abandonment',async()=>{
  const f=fixture();f.setSignedState({status:'pending',requestId:'saved-global',action:'in',phase:'sent'});
  f.signed.recover.mockImplementation(async abandon=>abandon?{status:'abandoned'}:{status:'pending',requestId:'saved-global',action:'in',phase:'sent'});
  render(<f.App kind="clock"/>);await screen.findByRole('button',{name:'pendingDiscard'});fireEvent.click(screen.getByRole('button',{name:'pendingDiscard'}));
  expect(f.signed.recover).not.toHaveBeenCalled();expect(f.alert).toHaveBeenCalledOnce();
  await act(async()=>{f.alert.mock.calls[0][2][1].onPress();});await screen.findByText('pendingDiscarded');
  expect(f.signed.recover).toHaveBeenCalledWith(true,'saved-global');expect(f.resolve).not.toHaveBeenCalled();expect(f.capture).not.toHaveBeenCalled();
 });
 it('never presents another request’s accepted receipt as the reviewed attempt',async()=>{
  const f=fixture();f.signed.capabilities.mockResolvedValue({outcome:'capabilities'});
  render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');
  f.setSignedState({status:'pending',requestId:'different-request',action:'in',phase:'sent'});
  fireEvent.click(screen.getByText('slideRecord'));await screen.findByRole('button',{name:'retrySameClock'});
  expect(f.signed.recover).not.toHaveBeenCalled();expect(f.signed.advance).not.toHaveBeenCalled();expect(screen.queryByText('clockRecorded')).toBeNull();expect(f.post).not.toHaveBeenCalled();
 });
});


describe('camera return and privacy lock lifecycle',()=>{
 it('retains the reviewed photo when the screen remounts and rehydrates its saved preparation',async()=>{
  const f=fixture();f.clockState.state.attendancePhotoSetting='required';
  let finish!:(photo:unknown)=>void;f.photo.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const ui=render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));
  await waitFor(()=>expect(f.photo).toHaveBeenCalledOnce());const draft=f.drafts().clock;
  f.session.status='locked';ui.rerender(<f.App kind="clock" visible={false}/>);
  await act(async()=>{finish({uri:'picked-private-photo',name:'attendance.jpg',mimeType:'image/jpeg',size:3});});
  await waitFor(()=>expect(f.drafts().clock.phase).toBe('review'));
  f.restoreClock({entry:{stage:'preparation',kind:'clock',requestId:draft.requestId,createdAt:draft.attemptStartedAt},
   command:JSON.stringify({requestId:draft.requestId,action:'in',claimedAt:draft.attemptStartedAt})});
  f.session.status='signedIn';ui.rerender(<f.App kind="clock"/>);await screen.findByText('slideRecord');
  expect(f.drafts().clock.photo.uri).toBe('picked-private-photo');expect(f.drafts().clock.geo).toEqual(draft.geo);
  expect(f.capture).toHaveBeenCalledOnce();expect(f.post).not.toHaveBeenCalled();
 });
});


it('does not start GPS or send preview after the preparation finishes on a locked/unmounted screen',async()=>{
 const f=fixture();let finish!:(value:any)=>void;
 f.prepareClock.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const ui=render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await waitFor(()=>expect(f.prepareClock).toHaveBeenCalledOnce());
 f.session.status='locked';ui.rerender(<f.App kind="clock" visible={false}/>);
 const id=f.prepareClock.mock.calls[0][1];await act(async()=>{finish({requestId:id,kind:'clock',stage:'preparation',createdAt:Date.now()});});
 expect(f.capture).not.toHaveBeenCalled();expect(f.preview).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();
 expect(f.drafts().clock).toMatchObject({requestId:id,phase:'idle'});
});


describe('actionable signed attendance failure guidance',()=>{
 it('explains unsupported device checks while retaining the unsent attempt without capturing',async()=>{
  const f=fixture();f.signed.capabilities.mockResolvedValue({outcome:'capabilities'});f.signed.key.mockRejectedValue(new SignedClockUnavailable('unsupported'));
  render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('signedClockUnsupported');
  expect(f.prepareClock).toHaveBeenCalledOnce();expect(f.drafts().clock.attemptStartedAt).toBeGreaterThan(0);expect(f.capture).not.toHaveBeenCalled();expect(f.stage).not.toHaveBeenCalled();expect(screen.queryByText('attemptSaveFailed')).toBeNull();
 });
 it.each([
  ['native_unavailable','signedClockUnavailable'],['unsupported','signedClockUnsupported'],['invalid_evidence','signedClockEvidenceRefused'],
 ] as const)('keeps a retained attempt when the device returns %s',async(reason,message)=>{
  const f=fixture();f.signed.capabilities.mockResolvedValue({outcome:'capabilities'});
  f.signed.advance.mockImplementation(async()=>({status:'pending',phase:'prepared',requestId:f.drafts().clock.requestId,action:'in',reason}));
  render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');fireEvent.click(screen.getByText('slideRecord'));
  await screen.findByText(message);expect(f.drafts().clock.phase).toBe('uncertain');expect(f.resolve).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'checkReceipt'})).toBeTruthy();
 });
 it('shows a safe server location refusal while preserving receipt recovery and explicit discard',async()=>{
  const f=fixture();f.signed.capabilities.mockResolvedValue({outcome:'capabilities'});
  f.signed.advance.mockImplementation(async()=>({status:'pending',phase:'sent',requestId:f.drafts().clock.requestId,action:'in',reason:'refused',refusal:{code:'outside_geofence',locationReason:'outside_site'}}));
  render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');fireEvent.click(screen.getByText('slideRecord'));
  await screen.findByText('locationOutsideSite');expect(f.resolve).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'pendingDiscard'})).toBeTruthy();expect(screen.queryByText('clockRecorded')).toBeNull();
 });
});


it('persists the local attempt before fresh discovery fails and later reports that exact attempt without clocking',async()=>{
 const f=fixture();f.openSigned.mockRejectedValue(new errors.UnavailableError());
 render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));
 await screen.findByText('signedClockUnavailable');
 const saveOrder=f.prepareClock.mock.invocationCallOrder[0];expect(f.openSigned.mock.invocationCallOrder.some(order=>order>saveOrder)).toBe(true);
 const id=f.drafts().clock.requestId;expect(id).toBeTruthy();expect(f.drafts().clock.attemptStartedAt).toBeGreaterThan(0);
 expect(f.capture).not.toHaveBeenCalled();expect(f.stage).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'sendAttemptRecord'}));await screen.findAllByText('attemptReported');
 expect(f.reportAttempt).toHaveBeenCalledWith(id,{assertCurrent:expect.any(Function)});
 expect(screen.queryByText('clockRecorded')).toBeNull();expect(f.post).not.toHaveBeenCalled();
});

it('blocks online clock preparation while the shared owner retains an offline context exchange',async()=>{
 const f=fixture();f.setSignedState({status:'offline_pending',requestId:'saved-context',phase:'context_requested'});render(<f.App kind="clock"/>);
 await screen.findByText('signedClockOfflinePending');expect(screen.getByText('slidePrepare')).toBeDisabled();
 expect(f.capture).not.toHaveBeenCalled();expect(f.signed.start).not.toHaveBeenCalled();
});

describe('offline clocking switch off (the default)',()=>{
 it('renders and clocks exactly as before: no driver or anchor call, no offline banner or saved-punch list',async()=>{
  const f=fixture();render(<f.App kind="clock"/>);
  expect(screen.getByText('onlineClockOnly')).toBeTruthy();expect(screen.getByText('clockHistory')).toBeTruthy();
  expect(screen.queryByText('offlineNoConnection')).toBeNull();expect(screen.queryByText('offlineSavedPunches')).toBeNull();
  fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');
  f.post.mockResolvedValueOnce({outcome:'accepted',receipt:contract.ClockReceipt.parse({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',direction:'in',date:'2026-01-01',recordedAt:'2026-01-01T01:00:00Z',photoAvailable:false})});
  fireEvent.click(screen.getByText('slideRecord'));await screen.findByText('clockRecorded');
  for(const spy of Object.values(f.engine))expect(spy).not.toHaveBeenCalled();
  expect(f.anchorRead).not.toHaveBeenCalled();expect(f.openSigned.mock.calls.every(([employment])=>employment==='own')).toBe(true);
 });
 it('keeps the session-employment check unchanged when no employment is picked (the offline relaxation is switch-on only)',async()=>{
  const f=fixture();f.session.employmentId=null as unknown as string;render(<f.App kind="clock"/>);
  fireEvent.click(screen.getByText('slidePrepare'));await waitFor(()=>expect(f.drafts().clock?.phase).toBe('idle'));
  expect(f.capture).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();
  for(const spy of Object.values(f.engine))expect(spy).not.toHaveBeenCalled();
 });
});

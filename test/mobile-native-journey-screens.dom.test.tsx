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
import * as v2team from '../lib/mobile-api/v2/team';
import * as enrollment from '../mobile/lib/enrollment-journal';
import {SignedClockUnavailable,type SignedClockStatus} from '../mobile/lib/signed-clock-journal';
import * as journal from '../mobile/lib/submission-journal';
function load(path:string,ports:Record<string,unknown>){const module={exports:{} as any};runInNewContext(transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,{exports:module.exports,module,FormData,Date,Error,setTimeout,clearTimeout,require:(id:string)=>{if(id==='react')return React;if(id==='react/jsx-runtime')return jsx;if(id in ports)return ports[id];throw new Error('Missing native screen port '+id);}});return module.exports;}
function fixture(platform:'ios'|'android'='ios'){
  let drafts:any,sequence=0;const reload=vi.fn(),get=vi.fn(),post=vi.fn(),remove=vi.fn(),capture=vi.fn<()=>Promise<{lat:number;lng:number;accuracy:number;sampledAt:number;permissionAccuracy?:'precise'|'approximate'|'unavailable';source?:import('../lib/mobile-clock-integrity').ClockSourceSignals}>>(async()=>({lat:3,lng:101,accuracy:5,sampledAt:Date.now(),source:{provider:null,mock:false,simulated:null,accessory:null}}));
  const photo=vi.fn<()=>Promise<any>>(async()=>null);
  const reloadAttempts=vi.fn(),attemptsState={items:[] as any[]};
  const preview=vi.fn<(...args:unknown[])=>Promise<any>>(async()=>({outcome:'not_enforced',siteId:null,siteName:null,distanceM:null,radiusM:null,accuracyM:5,maximumAccuracyM:null}));
  const session={employmentId:'own',status:'signedIn',signOut:vi.fn()};
  const View=({children}:any)=><div>{children}</div>,Text=({children,accessibilityRole}:any)=><span role={accessibilityRole==='alert'?'alert':undefined}>{children}</span>;
  const Pressable=(p:any)=><button disabled={p.disabled} role={p.accessibilityRole??'button'} aria-label={p.accessibilityLabel} aria-checked={p.accessibilityState?.checked} onClick={p.onPress}>{p.children}</button>;
  const alert=vi.fn();
  // D9 date/time control: the spinner is an input whose change is the picked local wall value; Android opens a dialog.
  const androidOpen=vi.fn();
  const picker={default:(p:any)=><input aria-label={p.accessibilityLabel} value={p.mode==='date'?`${p.value.getFullYear()}-${String(p.value.getMonth()+1).padStart(2,'0')}-${String(p.value.getDate()).padStart(2,'0')}`:`${String(p.value.getHours()).padStart(2,'0')}:${String(p.value.getMinutes()).padStart(2,'0')}`} onChange={e=>{const v=e.target.value;const d=p.mode==='date'?new Date(Number(v.slice(0,4)),Number(v.slice(5,7))-1,Number(v.slice(8,10))):new Date(2000,0,1,Number(v.slice(0,2)),Number(v.slice(3,5)));p.onChange({type:'set'},d);}}/>,DateTimePickerAndroid:{open:androidOpen}};
  const native={Alert:{alert},View,Text,Pressable,TextInput:(p:any)=><input aria-label={p.accessibilityLabel} disabled={!p.editable} value={p.value} onChange={e=>p.onChangeText(e.target.value)}/>,Image:()=>null,AppState:{currentState:'active'},Platform:{OS:platform}};
  const base={'react-native':native,'./session':{useSession:()=>session},'./auth':{authGeneration:()=>1,assertAuthGeneration:()=>{}},'./design':{DesignText:Text,useTenantDesign:()=>({design:DEFAULT_MOBILE_DESIGN,palette:mobilePalette(DEFAULT_MOBILE_DESIGN,'dark')})},'./errors':errors,'./i18n':{appLocale:()=>'en',t:(s:string,v?:any)=>s==='awayToday'?`${s} ${v.n}/${v.total}`:s},'expo-crypto':{randomUUID:()=>`${String(++sequence).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`},'expo-router':{useFocusEffect:()=>{},router:{push:vi.fn()}}};
  const provider=load('mobile/lib/journey-drafts.tsx',{...base,'expo-file-system':{File:class{exists=false},Directory:class{exists=false},Paths:{cache:'cache'}}});
  const ui={Chip:(p:any)=><button disabled={p.disabled} aria-pressed={!!p.selected} onClick={p.onPress}>{p.title}</button>,NoteLine:({text}:any)=><span>{text}</span>,InfoNote:({short,detail}:any)=><span><span>{short}</span><span>{detail}</span></span>,HeaderBack:({onPress}:any)=><button aria-label="back" onClick={onPress}>‹</button>,ListRow:({label,value,onPress}:any)=><button aria-label={value?`${label}, ${value}`:label} onClick={onPress}>{label}{value?`: ${value}`:''}</button>,Screen:({children,footer}:any)=><div>{children}{footer}</div>,Title:({children}:any)=><h1>{children}</h1>,Button:(p:any)=><button disabled={p.disabled} onClick={p.onPress}>{p.title}</button>,Card:View,Muted:Text,Row:({label,value}:any)=><p>{label}: {value}</p>,LoadState:()=>null,fmtDays:(n:unknown)=>n==null?'—':String(n)};
  const clockState={enabled:true,employmentId:'own',state:{date:'2026-01-01',clockedIn:false,geofencingRequired:false,workedSeconds:0,shift:{code:null,start:null,end:null},attendancePhotoSetting:'not_required',deviceRequired:false,captures:[],legacy:[]}};
  const teamState={enabled:true,today:'2026-01-01',from:'2026-01-01',to:'2026-01-07',scope:'my_team',companies:1,memberCount:2,truncated:false,items:[{employmentId:'a',name:'Approved Away',dates:[{date:'2026-01-01',status:'approved',session:'full_day'}]},{employmentId:'b',name:'Pending Colleague',dates:[{date:'2026-01-01',status:'pending',session:'AM'}]}]};
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
  }},'./journey-drafts':{...provider,removeLocalFile:remove},'./ui':ui,'./api':{apiGet:get,apiPost:(path:string,...args:unknown[])=>path==='clock-location'?preview(...args):post(path,...args),useApi:(path:string)=>({data:path==='clock-attempts'?attemptsState:path==='team'?teamState:clockState,reload:path==='clock-attempts'?reloadAttempts:reload,loading:false,error:null}),useApiV2:(path:string)=>({data:path==='v2/team/availability'?teamState:null,reload,loading:false,error:null})},'../../lib/mobile-api/v2/team':v2team,'./capture':{capturePosition:capture,capturePhoto:photo,appendAttachment:()=>{}},'./device-registration':{readClockDevice:async()=>null,writeClockDevice:async()=>{},clearClockDevice:async()=>{}},'./shift-reminder-signal':{requestShiftReminderRefresh:()=>{}},'./slide-confirm':{SlideConfirm:(p:any)=><button disabled={p.disabled} onClick={p.onConfirm}>{p.label}</button>},'./offline-clock':offlineUi,'./home-cards':{cardFigure:(c:any)=>c.takenOnly?c.taken:c.isCurrentCycle?c.canApplyFor:c.balance},'expo-document-picker':{getDocumentAsync:async()=>({canceled:true})},'expo-file-system':{},'@react-native-community/datetimepicker':picker};
  const {ClockPanel}=load('mobile/lib/clock-panel.tsx',shared),{LeaveRequestForm}=load('mobile/lib/leave-request-form.tsx',shared),{TeamPanel}=load('mobile/lib/team-panel.tsx',shared);
  function Probe(){drafts=provider.useJourneyDrafts();return null;}
  const options={employmentId:'own',items:[{id:'annual',name:'Annual leave',durations:['full_day','half_day_am','hourly'],allowedMimeTypes:[],maxDocBytes:10485760,requiresDocument:false,emergencySplit:false}]};
  function App({kind,refreshToken=0,visible=true,notices,cards,opts=options}:{kind:'clock'|'leave'|'team'|'homeClock';refreshToken?:number;visible?:boolean;notices?:Record<string,{label:string;detail:string|null}>;cards?:any[];opts?:any}){return <provider.JourneyDraftProvider><Probe/>{!visible?null:kind==='homeClock'?<ClockPanel variant="home" refreshToken={refreshToken} renderHome={(v:any)=><div><button disabled={v.disabled||v.busy} onClick={v.clock}>{'home:'+v.action}</button>{v.busy&&<span>homeBusy</span>}{v.doneAt&&<span>{'homeDone:'+v.doneAt}</span>}{v.message&&<span role="alert">{v.message}</span>}{v.finishOnClockTab&&<span>finishOnClockTab</span>}</div>}/>:kind==='clock'?<ClockPanel refreshToken={refreshToken}/>:kind==='team'?<TeamPanel refreshToken={refreshToken}/>:<LeaveRequestForm options={opts} today="2026-01-01" onSubmitted={reload} notices={notices} cards={cards}/>}</provider.JourneyDraftProvider>;}
  return {App,androidOpen,engine,anchorRead,session,post,signed,openSigned,alert,hasSignedAttempt,setSignedState:(value:SignedClockStatus)=>{signedState=value;},restoreClock:(value:unknown)=>{restoredClock=value;},preview,get,capture,reload,stage,resolve,prepareClock,reportAttempt,remove,teamState,clockState,photo,attemptsState,reloadAttempts,drafts:()=>drafts};
}
afterEach(cleanup);
/** Start a request and choose its type in the leave-type list (nothing is pre-selected). */
function startRequest(name='Annual leave'){fireEvent.click(screen.getByText('requestLeave'));fireEvent.click(screen.getByRole('button',{name:'leaveType, chooseLeaveType'}));fireEvent.click(screen.getByRole('radio',{name:new RegExp('^'+name)}));}
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
describe('one-tap clock from Home (owner request, Mobile WOW round)',()=>{
  const accepted=()=>({outcome:'accepted',receipt:contract.ClockReceipt.parse({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',direction:'in',date:'2026-01-01',recordedAt:'2026-01-01T01:00:00Z',photoAvailable:false})});
  it('one tap runs the Clock tab journey and records without a slide: saved attempt, location, assessment, then one command',async()=>{
    const f=fixture();render(<f.App kind="homeClock"/>);expect(f.post).not.toHaveBeenCalled();
    f.post.mockResolvedValueOnce(accepted());
    fireEvent.click(screen.getByText('home:in'));
    await screen.findByText('homeDone:2026-01-01T01:00:00Z');
    expect(f.prepareClock).toHaveBeenCalledTimes(1);expect(f.capture).toHaveBeenCalledTimes(1);expect(f.preview).toHaveBeenCalledTimes(1);
    expect(f.reportAttempt).toHaveBeenCalledTimes(1);expect(f.post).toHaveBeenCalledTimes(1);expect(f.post.mock.calls[0][0]).toBe('clock');
    const command=JSON.parse((f.post.mock.calls[0][1] as FormData).get('command') as string);
    expect(command).toMatchObject({action:'in',requestId:f.prepareClock.mock.calls[0][1]});
    expect(f.drafts().clock.phase).toBe('done');
  });
  it('stops before sending when the company requires a registered phone, and sends the person to the Clock tab',async()=>{
    const f=fixture();f.clockState.state.deviceRequired=true;render(<f.App kind="homeClock"/>);
    fireEvent.click(screen.getByText('home:in'));
    await screen.findByText('finishOnClockTab');
    expect(f.post).not.toHaveBeenCalled();expect(f.drafts().clock.phase).toBe('review');
  });
  it('a lost answer is left for an explicit retry on the Clock tab, never resent by itself',async()=>{
    const f=fixture();render(<f.App kind="homeClock"/>);
    f.post.mockRejectedValueOnce(new errors.UnavailableError());
    fireEvent.click(screen.getByText('home:in'));
    await screen.findByText('finishOnClockTab');
    expect(f.drafts().clock.phase).toBe('uncertain');expect(screen.getByRole('alert').textContent).toBe('clockUncertain');
    await act(async()=>{await new Promise(r=>setTimeout(r,20));});expect(f.post).toHaveBeenCalledTimes(1);
  });
  it('a location refusal is shown on Home and nothing is sent',async()=>{
    const f=fixture();f.preview.mockResolvedValueOnce({outcome:'outside_site',siteId:'s',siteName:'HQ',distanceM:900,radiusM:100,accuracyM:5,maximumAccuracyM:null});
    render(<f.App kind="homeClock"/>);fireEvent.click(screen.getByText('home:in'));
    await screen.findByRole('alert');expect(screen.getByRole('alert').textContent).toBe('locationOutsideSite');
    expect(f.post).not.toHaveBeenCalled();expect(f.drafts().clock.phase).toBe('idle');
  });
});
describe('native leave job',()=>{
  it('does not send a leave command if its durable save fails after preview',async()=>{
    const f=fixture();render(<f.App kind="leave"/>);startRequest();
    f.post.mockResolvedValueOnce({days:1,overrides:[]});fireEvent.click(screen.getByText('reviewRequest'));await screen.findByText('submitRequest');
    f.stage.mockRejectedValueOnce(new Error('Disk full'));fireEvent.click(screen.getByText('submitRequest'));
    await screen.findByText('checkReceipt');expect(f.post).toHaveBeenCalledTimes(1);expect(f.post.mock.calls[0][0]).toBe('leave-preview');
  });
  it('requires a server preview and each material consent before submitting; timeout retry preserves reference',async()=>{
    const f=fixture();render(<f.App kind="leave"/>);startRequest();expect(f.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('+ addReasonOrDocument'));fireEvent.change(screen.getByRole('textbox',{name:'reason'}),{target:{value:'Personal travel'}});
    f.post.mockResolvedValueOnce({days:1,unpaidDays:0,overrides:[{consentToken:'conversion',action:'convert_to_emergency',fromTypeName:'Annual leave',toTypeName:'Emergency leave',needsConsent:true}]});
    fireEvent.click(screen.getByText('reviewRequest'));await screen.findByText('submitRequest');expect(f.post).toHaveBeenCalledTimes(1);expect(f.post.mock.calls[0][0]).toBe('leave-preview');expect(screen.getByText('submitRequest')).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));expect(screen.getByText('submitRequest')).not.toBeDisabled();f.post.mockRejectedValueOnce(new errors.UnavailableError());fireEvent.click(screen.getByText('submitRequest'));await screen.findByText('leaveUncertain');
    const original=(f.post.mock.calls[1][1] as FormData).get('command');f.post.mockResolvedValueOnce({outcome:'accepted',id:'receipt'});fireEvent.click(screen.getByText('retrySameClock'));await screen.findByText('requestRecorded');expect((f.post.mock.calls[2][1] as FormData).get('command')).toBe(original);expect(f.reload).toHaveBeenCalledTimes(1);
  });
  it('shows half/hour pickers from eligibility, and cancellation never submits',()=>{
    const f=fixture();render(<f.App kind="leave"/>);startRequest();fireEvent.click(screen.getByText('hourly'));expect(screen.getByText('fromTime')).toBeTruthy();expect(screen.getByText('toTime')).toBeTruthy();expect(screen.queryByText('endDate')).toBeNull();expect(screen.queryByRole('textbox',{name:'fromTime'})).toBeNull();fireEvent.click(screen.getByText('cancel'));expect(f.post).not.toHaveBeenCalled();expect(f.drafts().leave).toBeNull();
  });
  it('D9: a picked time is the local wall value, set only on Done, and the hourly preview figure is shown',async()=>{
    const f=fixture();render(<f.App kind="leave"/>);startRequest();fireEvent.click(screen.getByText('hourly'));
    // iOS: opening the spinner sets nothing; Done commits what it shows.
    fireEvent.click(screen.getAllByText('pickerChoose')[0]);expect(f.drafts().leave.command.fromTime).toBeUndefined();
    fireEvent.change(screen.getByRole('textbox',{name:'fromTime'}),{target:{value:'09:30'}});expect(f.drafts().leave.command.fromTime).toBeUndefined();
    fireEvent.click(screen.getByText('pickerDone'));expect(f.drafts().leave.command.fromTime).toBe('09:30');
    fireEvent.click(screen.getByText('pickerChoose'));fireEvent.change(screen.getByRole('textbox',{name:'toTime'}),{target:{value:'11:30'}});fireEvent.click(screen.getByText('pickerDone'));
    expect(f.drafts().leave.command).toMatchObject({durationType:'hourly',fromTime:'09:30',toTime:'11:30',startDate:'2026-01-01',endDate:'2026-01-01'});
    f.post.mockResolvedValueOnce({days:0.25,unpaidDays:0,emergencySplit:false,overrides:[]});fireEvent.click(screen.getByText('reviewRequest'));await screen.findByText('submitRequest');
    expect(f.post.mock.calls[0][0]).toBe('leave-preview');expect(f.post.mock.calls[0][1]).toMatchObject({fromTime:'09:30',toTime:'11:30'});
    expect(screen.getByText('deductedDays: 0.25')).toBeTruthy();expect(screen.queryByText('hourlyReview')).toBeNull();
  });
  it('D9: an older server that previews no hourly figure keeps the server-checks sentence',async()=>{
    const f=fixture();render(<f.App kind="leave"/>);startRequest();fireEvent.click(screen.getByText('hourly'));
    f.post.mockResolvedValueOnce({days:null,unpaidDays:null,emergencySplit:false,overrides:[]});fireEvent.click(screen.getByText('reviewRequest'));await screen.findByText('submitRequest');
    expect(screen.getByText('hourlyReview')).toBeTruthy();expect(screen.queryByText(/deductedDays/)).toBeNull();
  });
  it('D9: Android opens the system dialog and a dismissed dialog changes nothing',()=>{
    const f=fixture('android');render(<f.App kind="leave"/>);startRequest();
    // Start date is the first picker; End date shows the same day on a fresh full-day draft.
    fireEvent.click(screen.getAllByText('2026-01-01',{selector:'button'})[0]);expect(f.androidOpen).toHaveBeenCalledTimes(1);expect(screen.queryByRole('textbox',{name:'startDate'})).toBeNull();
    const opened=f.androidOpen.mock.calls[0][0];expect(opened.mode).toBe('date');
    act(()=>opened.onChange({type:'dismissed'},new Date(2026,0,9)));expect(f.drafts().leave.command.startDate).toBe('2026-01-01');
    act(()=>opened.onChange({type:'set'},new Date(2026,0,9)));expect(f.drafts().leave.command.startDate).toBe('2026-01-09');
  });
  it('shows the server-translated entitlement notice for the selected type',()=>{
    const f=fixture();render(<f.App kind="leave" notices={{annual:{label:'Entitlement not generated',detail:'HR has not generated it yet.'}}}/>);
    expect(screen.queryByText('Entitlement not generated')).toBeNull();startRequest();
    expect(screen.getByText('Entitlement not generated')).toBeTruthy();expect(screen.getByText('HR has not generated it yet.')).toBeTruthy();
  });
});

describe('one-screen leave request (declutter round)',()=>{
  const card=(over:Record<string,unknown>={})=>({leaveTypeId:'annual',leaveType:'Annual leave',takenOnly:false,isCurrentCycle:true,canApplyFor:10,balance:10,taken:0,sharedPool:false,hasEntitlement:true,...over});
  it('the bar shows the SERVER preview\'s day count for the exact request on screen and the server\'s balance, never a figure of its own',async()=>{
    vi.useFakeTimers();
    try{
      const f=fixture();render(<f.App kind="leave" cards={[card()]}/>);startRequest();
      // A five-calendar-day range the server counts as 2 days (a weekend, a holiday): the app must show 2, not 5.
      fireEvent.click(screen.getAllByText('2026-01-01',{selector:'button'})[1]);fireEvent.change(screen.getByRole('textbox',{name:'endDate'}),{target:{value:'2026-01-05'}});fireEvent.click(screen.getByText('pickerDone'));
      expect(f.drafts().leave.command).toMatchObject({startDate:'2026-01-01',endDate:'2026-01-05'});
      expect(screen.getByText('leaveBarCounting')).toBeTruthy();expect(f.post).not.toHaveBeenCalled();
      f.post.mockResolvedValueOnce({days:2,unpaidDays:0,emergencySplit:false,overrides:[]});
      await act(async()=>{await vi.advanceTimersByTimeAsync(450);});
      expect(f.post).toHaveBeenCalledTimes(1);expect(f.post.mock.calls[0][0]).toBe('leave-preview');expect(f.post.mock.calls[0][2]).toEqual({employmentId:'own'});
      expect(f.post.mock.calls[0][1]).toMatchObject({startDate:'2026-01-01',endDate:'2026-01-05',durationType:'full_day'});
      expect(screen.getByText('2')).toBeTruthy();expect(screen.queryByText('5')).toBeNull();
      // The balance is the card figure as the server sent it; nothing is subtracted (no "balance after" is invented).
      expect(screen.getByText('leaveBarAvailable')).toBeTruthy();expect(screen.queryByText('8')).toBeNull();
      // The reason never changes the count, so typing one asks nothing; a new date range asks the server again.
      fireEvent.click(screen.getByText('+ addReasonOrDocument'));fireEvent.change(screen.getByRole('textbox',{name:'reason'}),{target:{value:'Trip'}});
      await act(async()=>{await vi.advanceTimersByTimeAsync(450);});expect(f.post).toHaveBeenCalledTimes(1);
      f.post.mockResolvedValueOnce({days:0.5,unpaidDays:0,emergencySplit:false,overrides:[]});
      fireEvent.click(screen.getByText('dayPartFirstHalf'));expect(screen.getByText('leaveBarCounting')).toBeTruthy();
      await act(async()=>{await vi.advanceTimersByTimeAsync(450);});
      expect(f.post).toHaveBeenCalledTimes(2);expect(f.post.mock.calls[1][1]).toMatchObject({durationType:'half_day_am',startDate:'2026-01-01',endDate:'2026-01-01'});
      expect(screen.getByText('0.5')).toBeTruthy();
    }finally{vi.useRealTimers();}
  });
  it('a failed preview says the days are shown on review; it never falls back to counting dates',async()=>{
    vi.useFakeTimers();
    try{
      const f=fixture();render(<f.App kind="leave" cards={[card()]}/>);startRequest();
      f.post.mockRejectedValueOnce(new errors.UnavailableError());
      await act(async()=>{await vi.advanceTimersByTimeAsync(450);});
      expect(screen.getByText('leaveBarNoCount')).toBeTruthy();expect(screen.queryByText('1')).toBeNull();
    }finally{vi.useRealTimers();}
  });
  it('"Add reason or document" is collapsed by default, and opens itself, marked required, when the type\'s server data requires a document or remark',()=>{
    const f=fixture();const ui=render(<f.App kind="leave"/>);startRequest();
    expect(screen.getByText('+ addReasonOrDocument')).toBeTruthy();expect(screen.queryByRole('textbox',{name:'reason'})).toBeNull();
    ui.unmount();
    for(const rule of [{requiresDocument:true,mandatoryAfterDays:null,employeeRemarkRequired:false},{requiresDocument:false,mandatoryAfterDays:null,employeeRemarkRequired:true}]){
      const g=fixture();const opts={employmentId:'own',items:[{id:'medical',name:'Medical leave',durations:['full_day'],allowedMimeTypes:[],maxDocBytes:10485760,emergencySplit:false,...rule}]};
      const r=render(<g.App kind="leave" opts={opts}/>);startRequest('Medical leave');
      expect(screen.queryByText('+ addReasonOrDocument')).toBeNull();expect(screen.getByText('addReasonOrDocument · required')).toBeTruthy();
      expect(screen.getByRole('textbox',{name:'reason'})).toBeTruthy();
      r.unmount();
    }
  });
  it('nothing is pre-selected: the type row reads "Choose leave type", no preview is asked, and Review refuses inline without disabling itself',async()=>{
    vi.useFakeTimers();
    try{
      const f=fixture();render(<f.App kind="leave" cards={[card()]}/>);fireEvent.click(screen.getByText('requestLeave'));
      expect(f.drafts().leave.command.leaveTypeId).toBe('');
      expect(screen.getByRole('button',{name:'leaveType, chooseLeaveType'})).toBeTruthy();
      await act(async()=>{await vi.advanceTimersByTimeAsync(450);});expect(f.post).not.toHaveBeenCalled();
      // No type, no preview asked — so the bar must not claim to be counting (it would never resolve).
      expect(screen.queryByText('leaveBarCounting')).toBeNull();expect(screen.getByText('chooseLeaveType')).toBeTruthy();
      const review=screen.getByText('reviewRequest');expect(review).not.toBeDisabled();
      fireEvent.click(review);expect(screen.getByRole('alert').textContent).toBe('chooseLeaveTypeFirst');
      expect(f.post).not.toHaveBeenCalled();expect(f.drafts().leave.phase).toBe('edit');
    }finally{vi.useRealTimers();}
  });
  it('the type list shows one compact row per type with its server balance; choosing one closes the list and keeps the dates',()=>{
    const f=fixture();const opts={employmentId:'own',items:[{id:'annual',name:'Annual leave',durations:['full_day','half_day_am'],allowedMimeTypes:[],maxDocBytes:10485760,requiresDocument:false,emergencySplit:false,notice:'Apply 3 days ahead.'},{id:'medical',name:'Medical leave',durations:['full_day'],allowedMimeTypes:[],maxDocBytes:10485760,requiresDocument:false,emergencySplit:false,notice:null}]};
    render(<f.App kind="leave" opts={opts} cards={[card(),card({leaveTypeId:'medical',leaveType:'Medical leave',canApplyFor:14})]}/>);
    startRequest('Annual leave');
    expect(screen.getByRole('button',{name:'leaveType, Annual leave · 10'})).toBeTruthy();expect(screen.getByText('Apply 3 days ahead.')).toBeTruthy();
    fireEvent.click(screen.getByText('dayPartFirstHalf'));
    fireEvent.click(screen.getByRole('button',{name:'leaveType, Annual leave · 10'}));
    expect(screen.getByRole('radio',{name:'Annual leave, 10'})).toBeTruthy();expect(screen.getByRole('radio',{name:'Medical leave, 14'})).toBeTruthy();
    // While the list is open the request is not cancellable from it by accident; its way out is the header back arrow.
    expect(screen.queryByText('cancel')).toBeNull();expect(screen.queryByRole('button',{name:'back'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'back'}));expect(screen.queryByRole('radio')).toBeNull();expect(f.drafts().leave.command.leaveTypeId).toBe('annual');
    fireEvent.click(screen.getByRole('button',{name:'leaveType, Annual leave · 10'}));
    fireEvent.click(screen.getByRole('radio',{name:'Medical leave, 14'}));
    expect(screen.queryByRole('radio')).toBeNull();
    expect(f.drafts().leave.command).toMatchObject({leaveTypeId:'medical',durationType:'full_day',startDate:'2026-01-01'});
    expect(screen.getByRole('button',{name:'leaveType, Medical leave · 14'})).toBeTruthy();
    // Day-part chips only for the parts the type offers: Medical offers full days only, so none are shown.
    expect(screen.queryByText('dayPartFirstHalf')).toBeNull();
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
    const f=fixture();render(<f.App kind="leave"/>);startRequest();f.post.mockResolvedValueOnce({days:1,overrides:[]});
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
  expect(f.anchorRead).not.toHaveBeenCalled();expect(f.openSigned.mock.calls.every(call=>(call as unknown[])[0]==='own')).toBe(true);
 });
 it('keeps the session-employment check unchanged when no employment is picked (the offline relaxation is switch-on only)',async()=>{
  const f=fixture();f.session.employmentId=null as unknown as string;render(<f.App kind="clock"/>);
  fireEvent.click(screen.getByText('slidePrepare'));await waitFor(()=>expect(f.drafts().clock?.phase).toBe('idle'));
  expect(f.capture).not.toHaveBeenCalled();expect(f.post).not.toHaveBeenCalled();
  for(const spy of Object.values(f.engine))expect(spy).not.toHaveBeenCalled();
 });
});

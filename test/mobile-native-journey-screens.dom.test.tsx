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
import * as journal from '../mobile/lib/submission-journal';
function load(path:string,ports:Record<string,unknown>){const module={exports:{} as any};runInNewContext(transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX}}).outputText,{exports:module.exports,module,FormData,Date,require:(id:string)=>{if(id==='react')return React;if(id==='react/jsx-runtime')return jsx;if(id in ports)return ports[id];throw new Error('Missing native screen port '+id);}});return module.exports;}
function fixture(){
  let drafts:any,sequence=0;const reload=vi.fn(),get=vi.fn(),post=vi.fn(),remove=vi.fn(),capture=vi.fn(async()=>({lat:3,lng:101,accuracy:5,sampledAt:Date.now()}));
  const session={employmentId:'own',status:'signedIn',signOut:vi.fn()};
  const View=({children}:any)=><div>{children}</div>,Text=({children,accessibilityRole}:any)=><span role={accessibilityRole==='alert'?'alert':undefined}>{children}</span>;
  const Pressable=(p:any)=><button disabled={p.disabled} role={p.accessibilityRole??'button'} aria-label={p.accessibilityLabel} aria-checked={p.accessibilityState?.checked} onClick={p.onPress}>{p.children}</button>;
  const native={View,Text,Pressable,TextInput:(p:any)=><input aria-label={p.accessibilityLabel} disabled={!p.editable} value={p.value} onChange={e=>p.onChangeText(e.target.value)}/>,Image:()=>null,AppState:{currentState:'active'},Platform:{OS:'ios'}};
  const base={'react-native':native,'./session':{useSession:()=>session},'./auth':{authGeneration:()=>1,assertAuthGeneration:()=>{}},'./design':{DesignText:Text,useTenantDesign:()=>({design:DEFAULT_MOBILE_DESIGN,palette:mobilePalette(DEFAULT_MOBILE_DESIGN,'dark')})},'./errors':errors,'./i18n':{appLocale:()=>'en',t:(s:string,v?:any)=>s==='awayToday'?`${s} ${v.n}/${v.total}`:s},'expo-crypto':{randomUUID:()=>`request-${++sequence}`},'expo-router':{useFocusEffect:()=>{}}};
  const provider=load('mobile/lib/journey-drafts.tsx',{...base,'expo-file-system':{File:class{exists=false},Directory:class{exists=false},Paths:{cache:'cache'}}});
  const ui={Button:(p:any)=><button disabled={p.disabled} onClick={p.onPress}>{p.title}</button>,Card:View,Muted:Text,Row:({label,value}:any)=><p>{label}: {value}</p>,LoadState:()=>null,fmtDays:(n:unknown)=>n==null?'—':String(n)};
  const clockState={enabled:true,employmentId:'own',state:{date:'2026-01-01',clockedIn:false,workedSeconds:0,shift:{code:null,start:null,end:null},attendancePhotoSetting:'not_required',deviceRequired:false,captures:[],legacy:[]}};
  const teamState={enabled:true,today:'2026-01-01',items:[{employmentId:'a',name:'Approved Away',dates:[{date:'2026-01-01',status:'approved',session:'full_day'}]},{employmentId:'b',name:'Pending Colleague',dates:[{date:'2026-01-01',status:'pending',session:'AM'}]}]};
  const stage=vi.fn(async(command:string,file?:unknown)=>({command,file})),resolve=vi.fn(async()=>{});
  const shared={...base,'./submission-journal':journal,'../../lib/mobile-api/contract':contract,'./submission-recovery':{useSubmissionRecovery:()=>({ready:true,error:null,reload:()=>{},stage,resolve})},'./journey-drafts':{...provider,removeLocalFile:remove},'./ui':ui,'./api':{apiGet:get,apiPost:post,useApi:(path:string)=>({data:path==='team'?teamState:clockState,reload,loading:false,error:null})},'./capture':{capturePosition:capture,capturePhoto:async()=>null,appendAttachment:()=>{}},'./device-registration':{readClockDevice:async()=>null,writeClockDevice:async()=>{},clearClockDevice:async()=>{}},'./slide-confirm':{SlideConfirm:(p:any)=><button disabled={p.disabled} onClick={p.onConfirm}>{p.label}</button>},'expo-document-picker':{getDocumentAsync:async()=>({canceled:true})},'expo-file-system':{}};
  const {ClockPanel}=load('mobile/lib/clock-panel.tsx',shared),{LeaveRequestForm}=load('mobile/lib/leave-request-form.tsx',shared),{TeamPanel}=load('mobile/lib/team-panel.tsx',shared);
  function Probe(){drafts=provider.useJourneyDrafts();return null;}
  const options={employmentId:'own',items:[{id:'annual',name:'Annual leave',durations:['full_day','half_day_am','hourly'],allowedMimeTypes:[],maxDocBytes:10485760,requiresDocument:false,emergencySplit:false}]};
  function App({kind,refreshToken=0}:{kind:'clock'|'leave'|'team';refreshToken?:number}){return <provider.JourneyDraftProvider><Probe/>{kind==='clock'?<ClockPanel refreshToken={refreshToken}/>:kind==='team'?<TeamPanel refreshToken={refreshToken}/>:<LeaveRequestForm options={options} today="2026-01-01" onSubmitted={reload}/>}</provider.JourneyDraftProvider>;}
  return {App,post,get,capture,reload,stage,resolve,remove,teamState,drafts:()=>drafts};
}
afterEach(cleanup);
describe('native clock job',()=>{
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
    f.post.mockResolvedValueOnce({outcome:'accepted',receipt:{recordedAt:'2026-01-01T01:00:00Z'}});fireEvent.click(screen.getByRole('button',{name:'retrySameClock'}));await screen.findByText('clockRecorded');expect((f.post.mock.calls[1][1] as FormData).get('command')).toBe(command);expect(f.post).toHaveBeenCalledTimes(2);expect(screen.getByText(/9:00/)).toBeTruthy();expect(screen.queryByText('2026-01-01T01:00:00Z')).toBeNull();
  });
  it('cancelling a prepared capture writes nothing, and a definitive refusal permits a new attempt',async()=>{
    const f=fixture();render(<f.App kind="clock"/>);fireEvent.click(screen.getByText('slidePrepare'));await screen.findByText('slideRecord');fireEvent.click(screen.getByText('cancel'));expect(f.post).not.toHaveBeenCalled();expect(f.drafts().clock).toBeNull();
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
    const id=f.drafts().clock.requestId;f.get.mockResolvedValueOnce({kind:'clock',requestId:id,receipt:{recordedAt:'2026-01-01T01:00:00Z'}});
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

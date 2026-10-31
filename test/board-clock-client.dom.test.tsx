import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { todayInKualaLumpur } from '../lib/hr-date';
const clockDate=todayInKualaLumpur();
import { ClockPageClient } from '../app/(app)/attendance/clock/clock-client';
import { requestClockRemovalAction } from '../app/(app)/attendance/clock/actions';
vi.mock('../app/(app)/attendance/clock/actions',()=>({requestClockRemovalAction:vi.fn()}));
vi.mock('next/link',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}));
const initial={clockContext:'a'.repeat(64),date:clockDate,serverNow:clockDate+'T00:00:00Z',workedSeconds:0,clockedIn:false,openSince:null,locationValid:true,locationAvailable:true,geofencingRequired:false,attendancePhotoSetting:'optional',captures:[],legacy:[],shift:{code:'SF',start:'07:00',end:'20:00'}} as unknown as React.ComponentProps<typeof ClockPageClient>['initial'];
let selectedSetting:'required'|'optional'|'not_required';
let geofencingRequired=false;
let captureRows:typeof initial.captures=[];
let post=vi.fn<(url:string,options?:RequestInit)=>Promise<Response>>();
let lookup=vi.fn<(url:string,options?:RequestInit)=>Promise<Response>>();
let getUserMedia=vi.fn<()=>Promise<MediaStream>>();
const receipt={recordedAt:clockDate+'T01:00:00Z',direction:'in',id:'capture',date:clockDate};
function mount(setting:'required'|'optional'|'not_required'='optional',employmentId?:string){
  selectedSetting=setting;
  return render(<NextIntlClientProvider locale="en" messages={en}><ClockPageClient initial={{...initial,captures:captureRows,attendancePhotoSetting:setting}} shiftName="Semi Flexi" employmentId={employmentId}/></NextIntlClientProvider>);
}
beforeEach(()=>{
  selectedSetting='optional';geofencingRequired=false;captureRows=[];
  Object.defineProperty(window,'isSecureContext',{value:true,configurable:true});
  Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition:vi.fn((ok)=>ok({coords:{latitude:3,longitude:101,accuracy:10}}))},configurable:true});
  getUserMedia=vi.fn<()=>Promise<MediaStream>>().mockRejectedValue(new DOMException('Denied','NotAllowedError'));
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia},configurable:true});
  post=vi.fn<(url:string,options?:RequestInit)=>Promise<Response>>().mockImplementation(async()=>Response.json({receipt}));lookup=vi.fn<(url:string,options?:RequestInit)=>Promise<Response>>().mockImplementation(async()=>Response.json({receipt}));
  vi.stubGlobal('fetch',vi.fn((url:string,options?:RequestInit)=>{
    if(options?.method==='POST')return post(url,options);
    if(url.startsWith('/api/attendance/clock?'))return lookup(url,options);
    if(url==='/api/time')return Promise.resolve(Response.json({serverNow:initial.serverNow}));
    return Promise.resolve(Response.json({...initial,captures:captureRows,attendancePhotoSetting:selectedSetting,geofencingRequired,locationAvailable:url.includes('?lat=')}));
  }));
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function begin(){await waitFor(()=>expect((screen.getByRole('button',{name:en.attendance.clock.clockIn}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.clockIn}));}
function allowCamera() {
  const stop = vi.fn(), revoke = vi.fn(), photo = new Blob(['synthetic-camera-frame'], {type: 'image/jpeg'});
  getUserMedia.mockResolvedValue({getTracks: () => [{stop}]} as unknown as MediaStream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage: vi.fn()} as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(photo));
  const NativeURL = URL;
  vi.stubGlobal('URL', class extends NativeURL {
    static createObjectURL() { return 'blob:synthetic-camera-frame'; }
    static revokeObjectURL = revoke;
  });
  return {stop, revoke, photo};
}
async function takeFrame(setting: 'required' | 'optional') {
  await begin();
  await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
  Object.defineProperties(document.querySelector('video')!, {videoWidth: {value: 640}, videoHeight: {value: 480}});
  fireEvent.click(screen.getByRole('button', {name: en.attendance.clock.takePhoto}));
  await screen.findByAltText(en.attendance.clock.photoReview);
}
describe('Web Clocking optional camera and uncertain commands',()=>{
  it('does not repeat a stale Home clock-in after the canonical read is already clocked in',async()=>{
    selectedSetting='not_required';const saved=vi.fn();
    const stale={...initial,attendancePhotoSetting:'not_required' as const,clockedIn:true,openSince:initial.serverNow};
    vi.mocked(fetch).mockImplementation(async(url)=>String(url)==='/api/time'?Response.json({serverNow:initial.serverNow}):Response.json(stale));
    render(<NextIntlClientProvider locale="en" messages={en}><ClockPageClient initial={{...initial,attendancePhotoSetting:'not_required'}} shiftName={null} employmentId="own" embedded initialAction="in" onSaved={saved}/></NextIntlClientProvider>);
    await screen.findByText(en.attendance.clock.conflict);expect(post).not.toHaveBeenCalled();expect(saved).not.toHaveBeenCalled();
  });
  it('starts one embedded explicit intent and reports only the confirmed selected receipt',async()=>{
    selectedSetting='not_required';const saved=vi.fn(),busy=vi.fn(),employmentId='f554c043-bdd1-4ba4-a2aa-11ca98719828';
    render(<NextIntlClientProvider locale="en" messages={en}><ClockPageClient initial={{...initial,attendancePhotoSetting:'not_required'}} shiftName={null} employmentId={employmentId} embedded initialAction="in" onSaved={saved} onBusyChange={busy}/></NextIntlClientProvider>);
    await waitFor(()=>expect(saved).toHaveBeenCalledWith({recordedAt:receipt.recordedAt,direction:'in'}));expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0][1]!.body as FormData).get('employmentId')).toBe(employmentId);expect(screen.queryByRole('heading',{name:en.attendance.clock.todayLog})).toBeNull();expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('preserves the selected employment through refresh, submission and uncertain receipt recovery',async()=>{
    const employmentId='f554c043-bdd1-4ba4-a2aa-11ca98719828';
    post.mockRejectedValueOnce(new TypeError('Response lost'));
    mount('not_required',employmentId);await begin();
    await screen.findByText(en.attendance.clock.pendingCommand);
    const body=post.mock.calls[0][1]!.body as FormData;
    expect(body.get('employmentId')).toBe(employmentId);expect(body.get('clockContext')).toBe(initial.clockContext);
    const refreshes=vi.mocked(fetch).mock.calls.map(([url])=>String(url)).filter(url=>url.startsWith('/api/attendance/today'));
    expect(refreshes.length).toBeGreaterThan(0);
    for(const url of refreshes)expect(new URL(url,'http://localhost').searchParams.get('employmentId')).toBe(employmentId);
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.checkSubmission}));
    await waitFor(()=>expect(lookup).toHaveBeenCalledTimes(1));
    const query=new URL(lookup.mock.calls[0][0],'http://localhost').searchParams;
    expect(query.get('employmentId')).toBe(employmentId);expect(query.get('requestId')).toBe(body.get('requestId'));
    await waitFor(()=>expect(screen.queryByText(en.attendance.clock.pendingCommand)).toBeNull());expect(post).toHaveBeenCalledTimes(1);
  });
  it.each(['optional', 'not_required'] as const)('does not promise photo capture when the setting is %s', setting => {
    mount(setting);
    expect(screen.getByRole('status')).toHaveTextContent(en.attendance.clock.serverTimeNote);
    expect(screen.getByRole('status')).not.toHaveTextContent(en.attendance.clock.photoHelper);
  });
  it.each(['required', 'optional'] as const)('reviews a granted %s camera frame before submitting its photo and showing the server time', async setting => {
    const {stop, revoke} = allowCamera(); mount(setting); await takeFrame(setting);
    expect(stop).toHaveBeenCalledTimes(1); expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: en.attendance.clock.confirmIn}));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = post.mock.calls[0][1]!.body as FormData;
    expect(body.get('action')).toBe('in');
    expect(body.get('photo')).toMatchObject({type: 'image/jpeg', size: new Blob(['synthetic-camera-frame']).size});
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(en.attendance.clock.savedIn.replace('{time}', '09:00:00')));
    expect(screen.queryByText(en.attendance.clock.pendingCommand)).toBeNull();
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:synthetic-camera-frame'));
  });
  it('retains the exact captured photo body after an uncertain response and a missing receipt', async () => {
    allowCamera(); post.mockRejectedValueOnce(new TypeError('Photo response lost'));
    lookup.mockResolvedValueOnce(Response.json({error: 'notFound'}, {status: 404}));
    mount(); await takeFrame('optional');
    fireEvent.click(screen.getByRole('button', {name: en.attendance.clock.confirmIn}));
    await screen.findByText(en.attendance.clock.pendingCommand);
    const original = post.mock.calls[0][1]!.body as FormData, originalPhoto = original.get('photo');
    expect(originalPhoto).not.toBeNull();
    expect(screen.getByRole('button', {name: en.attendance.clock.retakePhoto})).toBeDisabled();
    fireEvent.click(screen.getByRole('button', {name: en.attendance.clock.checkSubmission}));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]!.body).toBe(original);
    expect((post.mock.calls[1][1]!.body as FormData).get('photo')).toBe(originalPhoto);
    await waitFor(() => expect(screen.queryByText(en.attendance.clock.pendingCommand)).toBeNull());
  });
  it('keeps optional Skip Photo after denied camera permission',async()=>{
    mount();await begin();
    await screen.findByText(en.attendance.clock.cameraDenied);
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.skipPhoto}));
    await waitFor(()=>expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0][1]!.body as FormData).has('photo')).toBe(false);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Clocked in at 09:00:00'));
    expect(screen.getByRole('status')).not.toHaveTextContent('photo saved');
  });
  it('retries a denied camera after permission changes and keeps Skip Photo available',async()=>{
    mount();await begin();
    await screen.findByText(en.attendance.clock.cameraDenied);expect(screen.getByRole('button',{name:en.attendance.clock.skipPhoto})).toBeEnabled();
    allowCamera();fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.retryCamera}));
    await waitFor(()=>expect(document.querySelector('video')).not.toBeNull());expect(post).not.toHaveBeenCalled();
  });
  it('distinguishes an in-use camera and still allows an optional skip',async()=>{
    getUserMedia.mockRejectedValue(new DOMException('Busy','NotReadableError'));mount();await begin();
    await screen.findByText(en.attendance.clock.cameraBusy);expect(screen.getByRole('button',{name:en.attendance.clock.retryCamera})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.skipPhoto}));await waitFor(()=>expect(post).toHaveBeenCalledOnce());
  });
  it('allows optional skip while permission is unresolved and stops a camera granted too late',async()=>{
    let grant!:(stream:MediaStream)=>void;
    getUserMedia.mockImplementation(()=>new Promise(resolve=>{grant=resolve;}));
    mount();await begin();expect(screen.getByRole('button',{name:en.attendance.clock.skipPhoto})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.skipPhoto}));
    await waitFor(()=>expect(post).toHaveBeenCalledTimes(1));
    const stop=vi.fn();grant({getTracks:()=>[{stop}]} as unknown as MediaStream);
    await waitFor(()=>expect(stop).toHaveBeenCalledTimes(1));
    expect(document.querySelector('video')).toBeNull();
    expect((post.mock.calls[0][1]!.body as FormData).has('photo')).toBe(false);
  });
  it.each(['required','optional'] as const)('cancels an unresolved %s camera without a late error or submission',async setting=>{
    let reject!:(reason:Error)=>void;
    getUserMedia.mockImplementation(()=>new Promise((_,no)=>{reject=no;}));
    mount(setting);await begin();fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.cancelPhoto}));
    reject(new DOMException('Late denial','NotAllowedError'));
    await waitFor(()=>expect(screen.getByRole('button',{name:en.attendance.clock.clockIn})).toBeEnabled());
    expect(screen.queryByText(en.attendance.clock.cameraDenied)).toBeNull();expect(post).not.toHaveBeenCalled();
  });
  it('never opens a camera for Not Required',async()=>{
    mount('not_required');await begin();await waitFor(()=>expect(post).toHaveBeenCalledTimes(1));expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('checks the accepted receipt after a 500 and never posts a second clocking',async()=>{
    post.mockResolvedValueOnce(new Response('Unknown',{status:500}));mount('not_required');await begin();
    await screen.findByText(en.attendance.clock.pendingCommand);
    expect((screen.getByRole('button',{name:en.attendance.clock.clockOut}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.checkSubmission}));
    await waitFor(()=>expect(lookup).toHaveBeenCalledTimes(1));
    await waitFor(()=>expect(screen.queryByText(en.attendance.clock.pendingCommand)).toBeNull());expect(post).toHaveBeenCalledTimes(1);
  });
  it('reposts the identical FormData only when the receipt is not yet found',async()=>{
    post.mockRejectedValueOnce(new TypeError('Network lost'));lookup.mockResolvedValueOnce(Response.json({error:'notFound'},{status:404}));
    mount();await begin();await screen.findByText(en.attendance.clock.cameraDenied);fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.skipPhoto}));await screen.findByText(en.attendance.clock.pendingCommand);
    const original=post.mock.calls[0][1]!.body;
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.cancelPhoto}));expect(screen.getByText(en.attendance.clock.pendingCommand)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.checkSubmission}));await waitFor(()=>expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]!.body).toBe(original);
  });
  it('retains the original command after a retry refusal while its earlier response is uncertain',async()=>{
    post.mockRejectedValueOnce(new TypeError('Response lost')).mockResolvedValueOnce(Response.json({error:'origin'},{status:403}));
    lookup.mockResolvedValueOnce(Response.json({error:'notFound'},{status:404}));
    mount('not_required');await begin();await screen.findByText(en.attendance.clock.pendingCommand);
    const original=post.mock.calls[0][1]!.body;
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.checkSubmission}));await screen.findByText(en.attendance.clock.origin);
    expect(screen.getByText(en.attendance.clock.pendingCommand)).toBeTruthy();expect(post.mock.calls[1][1]!.body).toBe(original);
    expect((screen.getByRole('button',{name:en.attendance.clock.clockOut}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.checkSubmission}));
    await waitFor(()=>expect(screen.queryByText(en.attendance.clock.pendingCommand)).toBeNull());expect(post).toHaveBeenCalledTimes(2);
  });
  it('retains an uncertain request across authentication expiry and offers sign-in in another tab',async()=>{
    post.mockResolvedValueOnce(Response.json({error:'authentication'},{status:401}));mount('not_required');await begin();
    const signIn=await screen.findByRole('link',{name:en.attendance.clock.signInAgain});expect(signIn.getAttribute('target')).toBe('_blank');
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.checkSubmission}));await waitFor(()=>expect(lookup).toHaveBeenCalledTimes(1));expect(post).toHaveBeenCalledTimes(1);
  });
  it('keeps the original uncertain command when a different account tries to retry',async()=>{post.mockRejectedValueOnce(new TypeError('Network lost')).mockResolvedValueOnce(Response.json({error:'accountChanged'},{status:409}));lookup.mockResolvedValueOnce(Response.json({error:'notFound'},{status:404}));mount('not_required');await begin();await screen.findByText(en.attendance.clock.pendingCommand);const original=post.mock.calls[0][1]!.body;fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.checkSubmission}));await screen.findByText(en.attendance.clock.accountChanged);expect(screen.getByText(en.attendance.clock.pendingCommand)).toBeTruthy();expect(post.mock.calls[1][1]!.body).toBe(original);expect((original as FormData).get('clockContext')).toBe(initial.clockContext);});
  it('clocks without fabricated coordinates after GPS denial when geofencing is off',async()=>{mount('not_required');await begin();await waitFor(()=>expect(post).toHaveBeenCalledTimes(1));post.mockClear();vi.mocked(navigator.geolocation.getCurrentPosition).mockImplementationOnce((_ok,fail)=>fail?.({code:1} as GeolocationPositionError));await begin();await waitFor(()=>expect(post).toHaveBeenCalledTimes(1));const body=post.mock.calls[0][1]!.body as FormData;expect(body.has('lat')).toBe(false);expect(body.has('lng')).toBe(false);expect(body.has('accuracy')).toBe(false);expect(screen.queryByText(en.attendance.clock.locationDenied)).toBeNull();});
  it('still refuses missing GPS when the freshly read setting requires geofencing',async()=>{mount('not_required');await begin();await waitFor(()=>expect(post).toHaveBeenCalledTimes(1));post.mockClear();geofencingRequired=true;vi.mocked(navigator.geolocation.getCurrentPosition).mockImplementationOnce((_ok,fail)=>fail?.({code:1} as GeolocationPositionError));await begin();await screen.findByText(en.attendance.clock.locationDenied);expect(post).not.toHaveBeenCalled();expect(screen.queryByText(en.attendance.clock.pendingCommand)).toBeNull();});
  it('required camera failure cannot expose Skip Photo',async()=>{mount('required');await begin();await screen.findByText(en.attendance.clock.cameraDenied);expect(screen.queryByRole('button',{name:en.attendance.clock.skipPhoto})).toBeNull();expect(post).not.toHaveBeenCalled();});
});

const captureRow=(overrides:Partial<typeof initial.captures[number]>={}):typeof initial.captures[number]=>({
  id:'capture-a',requestId:'request-a',direction:'in',date:clockDate,recordedAt:clockDate+'T01:00:00Z',
  deviceId:null,lat:null,lng:null,accuracyM:null,locationStatus:null,geofencingRequired:false,locationName:null,
  punchId:'punch-a',removalRequested:false,removalBlocked:false,photoAvailable:false,purgedAt:undefined,photoDigest:undefined,...overrides,
});
it.each([null,'denied','unavailable','timeout','unsupported'] as const)('shows recorded %s location evidence separately from geofencing policy',async status=>{
  captureRows=[captureRow({locationStatus:status})];mount();
  await waitFor(()=>expect(screen.getByRole('button',{name:en.attendance.clock.clockIn})).toBeEnabled());
  const item=within(screen.getByRole('listitem'));
  expect(item.getByText(en.attendance.clock.captureLocation[status??'unknown'])).toBeVisible();
  expect(item.getByText(en.attendance.clock.geofencingNotRequired)).toBeVisible();
  expect(item.queryByRole('link')).toBeNull();
});
it('renders captured coordinates and accuracy without inventing a historical geofencing policy',async()=>{
  captureRows=[captureRow({lat:3.12,lng:101.6,accuracyM:8,locationStatus:'recorded',geofencingRequired:null})];mount();
  await waitFor(()=>expect(screen.getByRole('button',{name:en.attendance.clock.clockIn})).toBeEnabled());
  const item=within(screen.getByRole('listitem'));
  expect(item.getByRole('link',{name:'3.12000, 101.60000 · ±8 m'})).toHaveAttribute('target','_blank');
  expect(item.queryByText(en.attendance.clock.geofencingNotRequired)).toBeNull();
  expect(item.queryByText(en.attendance.clock.geofenceEnforced)).toBeNull();
});
it('blocks both clock intents while reviewing a removal and restores them on cancellation',async()=>{
  captureRows=[captureRow()];mount();
  const clockIn=screen.getByRole('button',{name:en.attendance.clock.clockIn}),clockOut=screen.getByRole('button',{name:en.attendance.clock.clockOut});
  await waitFor(()=>expect(clockIn).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.remove}));
  expect(clockIn).toBeDisabled();expect(clockOut).toBeDisabled();
  expect(within(screen.getByRole('dialog')).getByRole('textbox')).toBeRequired();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:en.attendance.clock.cancelPhoto}));
  expect(clockIn).toBeEnabled();expect(clockOut).toBeEnabled();expect(post).not.toHaveBeenCalled();
});
it('retains the selected employment in the canonical removal action',async()=>{
  const employmentId='f554c043-bdd1-4ba4-a2aa-11ca98719828';
  vi.mocked(requestClockRemovalAction).mockResolvedValueOnce({ok:true,correctionId:'fictional-request'});
  captureRows=[captureRow()];mount('not_required',employmentId);
  await waitFor(()=>expect(screen.getByRole('button',{name:en.attendance.clock.clockIn})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.remove}));
  const dialog=within(screen.getByRole('dialog'));
  fireEvent.change(dialog.getByRole('textbox'),{target:{value:'Fictional removal remark'}});
  fireEvent.click(dialog.getByRole('button',{name:en.attendance.clock.requestRemoval}));
  await waitFor(()=>expect(requestClockRemovalAction).toHaveBeenCalledWith(expect.objectContaining({employmentId,punchId:'punch-a',clockContext:initial.clockContext,reason:'Fictional removal remark'})));
});

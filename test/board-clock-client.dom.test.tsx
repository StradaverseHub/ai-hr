import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { todayInKualaLumpur } from '../lib/hr-date';
const clockDate=todayInKualaLumpur();
import { ClockPageClient } from '../app/attendance/clock/clock-client';
vi.mock('next/link',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}));
const initial={clockContext:'a'.repeat(64),date:clockDate,serverNow:clockDate+'T00:00:00Z',workedSeconds:0,clockedIn:false,openSince:null,locationValid:true,geofencingRequired:false,attendancePhotoSetting:'optional',captures:[],legacy:[],shift:{code:'SF',start:'07:00',end:'20:00'}} as unknown as React.ComponentProps<typeof ClockPageClient>['initial'];
let selectedSetting:'required'|'optional'|'not_required';
let post=vi.fn<(url:string,options?:RequestInit)=>Promise<Response>>();
let lookup=vi.fn<(url:string,options?:RequestInit)=>Promise<Response>>();
let getUserMedia=vi.fn<()=>Promise<MediaStream>>();
const receipt={recordedAt:clockDate+'T01:00:00Z',direction:'in',id:'capture',date:clockDate};
function mount(setting:'required'|'optional'|'not_required'='optional'){
  selectedSetting=setting;
  return render(<NextIntlClientProvider locale="en" messages={en}><ClockPageClient initial={{...initial,attendancePhotoSetting:setting}} shiftName="Semi Flexi"/></NextIntlClientProvider>);
}
beforeEach(()=>{
  selectedSetting='optional';
  Object.defineProperty(window,'isSecureContext',{value:true,configurable:true});
  Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition:vi.fn((ok)=>ok({coords:{latitude:3,longitude:101,accuracy:10}}))},configurable:true});
  getUserMedia=vi.fn<()=>Promise<MediaStream>>().mockRejectedValue(new DOMException('Denied','NotAllowedError'));
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia},configurable:true});
  post=vi.fn<(url:string,options?:RequestInit)=>Promise<Response>>().mockImplementation(async()=>Response.json({receipt}));lookup=vi.fn<(url:string,options?:RequestInit)=>Promise<Response>>().mockImplementation(async()=>Response.json({receipt}));
  vi.stubGlobal('fetch',vi.fn((url:string,options?:RequestInit)=>{
    if(options?.method==='POST')return post(url,options);
    if(url.startsWith('/api/attendance/clock?'))return lookup(url,options);
    if(url==='/api/time')return Promise.resolve(Response.json({serverNow:initial.serverNow}));
    return Promise.resolve(Response.json({...initial,attendancePhotoSetting:selectedSetting}));
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
  if (setting === 'optional') fireEvent.click(screen.getByRole('button', {name: en.attendance.clock.takePhoto}));
  await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
  Object.defineProperties(document.querySelector('video')!, {videoWidth: {value: 640}, videoHeight: {value: 480}});
  fireEvent.click(screen.getByRole('button', {name: en.attendance.clock.takePhoto}));
  await screen.findByAltText(en.attendance.clock.photoReview);
}
describe('Web Clocking optional camera and uncertain commands',()=>{
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
    mount();await begin();fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.takePhoto}));
    await screen.findByText(en.attendance.clock.cameraDenied);
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.skipPhoto}));
    await waitFor(()=>expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0][1]!.body as FormData).has('photo')).toBe(false);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Clocked in at 09:00:00'));
    expect(screen.getByRole('status')).not.toHaveTextContent('photo saved');
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
    mount();await begin();fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.skipPhoto}));await screen.findByText(en.attendance.clock.pendingCommand);
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
  it('allows a fresh no-photo attempt after location permission fails before submission',async()=>{mount('not_required');await begin();await waitFor(()=>expect(post).toHaveBeenCalledTimes(1));post.mockClear();vi.mocked(navigator.geolocation.getCurrentPosition).mockImplementationOnce((_ok,fail)=>fail?.({code:1} as GeolocationPositionError));await begin();await screen.findByText(en.attendance.clock.locationDenied);expect(post).not.toHaveBeenCalled();expect(screen.queryByText(en.attendance.clock.pendingCommand)).toBeNull();await begin();await waitFor(()=>expect(post).toHaveBeenCalledTimes(1));});
  it('required camera failure cannot expose Skip Photo',async()=>{mount('required');await begin();await screen.findByText(en.attendance.clock.cameraDenied);expect(screen.queryByRole('button',{name:en.attendance.clock.skipPhoto})).toBeNull();expect(post).not.toHaveBeenCalled();});
});

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { ClockPageClient } from '../app/attendance/clock/clock-client';
vi.mock('next/link',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}));
const initial={date:'2026-10-01',serverNow:'2026-10-01T00:00:00Z',workedSeconds:0,clockedIn:false,openSince:null,locationValid:true,geofencingRequired:false,attendancePhotoSetting:'optional',captures:[],legacy:[],shift:{code:'SF',start:'07:00',end:'20:00'}} as unknown as React.ComponentProps<typeof ClockPageClient>['initial'];
let post:ReturnType<typeof vi.fn>,lookup:ReturnType<typeof vi.fn>,getUserMedia:ReturnType<typeof vi.fn>;
const receipt={recordedAt:'2026-10-01T01:00:00Z',direction:'in',id:'capture',date:'2026-10-01'};
function mount(setting:'required'|'optional'|'not_required'='optional'){
  return render(<NextIntlClientProvider locale="en" messages={en}><ClockPageClient initial={{...initial,attendancePhotoSetting:setting}} shiftName="Semi Flexi"/></NextIntlClientProvider>);
}
beforeEach(()=>{
  Object.defineProperty(window,'isSecureContext',{value:true,configurable:true});
  Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition:vi.fn((ok)=>ok({coords:{latitude:3,longitude:101,accuracy:10}}))},configurable:true});
  getUserMedia=vi.fn().mockRejectedValue(new DOMException('Denied','NotAllowedError'));
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia},configurable:true});
  post=vi.fn().mockResolvedValue(Response.json({receipt}));lookup=vi.fn().mockResolvedValue(Response.json({receipt}));
  vi.stubGlobal('fetch',vi.fn((url:string,options?:RequestInit)=>{
    if(options?.method==='POST')return post(url,options);
    if(url.startsWith('/api/attendance/clock?'))return lookup(url,options);
    if(url==='/api/time')return Promise.resolve(Response.json({serverNow:initial.serverNow}));
    return Promise.resolve(Response.json(initial));
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function begin(){await waitFor(()=>expect((screen.getByRole('button',{name:en.attendance.clock.clockIn}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.clockIn}));}
describe('Web Clocking optional camera and uncertain commands',()=>{
  it('keeps optional Skip Photo after denied camera permission',async()=>{
    mount();await begin();fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.takePhoto}));
    await screen.findByText(en.attendance.clock.cameraDenied);
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.skipPhoto}));
    await waitFor(()=>expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0][1].body as FormData).has('photo')).toBe(false);
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
    const original=post.mock.calls[0][1].body;
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.cancelPhoto}));expect(screen.getByText(en.attendance.clock.pendingCommand)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.checkSubmission}));await waitFor(()=>expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1].body).toBe(original);
  });
  it('retains an uncertain request across authentication expiry and offers sign-in in another tab',async()=>{
    post.mockResolvedValueOnce(Response.json({error:'authentication'},{status:401}));mount('not_required');await begin();
    const signIn=await screen.findByRole('link',{name:en.attendance.clock.signInAgain});expect(signIn.getAttribute('target')).toBe('_blank');
    fireEvent.click(screen.getByRole('button',{name:en.attendance.clock.checkSubmission}));await waitFor(()=>expect(lookup).toHaveBeenCalledTimes(1));expect(post).toHaveBeenCalledTimes(1);
  });
  it('required camera failure cannot expose Skip Photo',async()=>{mount('required');await begin();await screen.findByText(en.attendance.clock.cameraDenied);expect(screen.queryByRole('button',{name:en.attendance.clock.skipPhoto})).toBeNull();expect(post).not.toHaveBeenCalled();});
});

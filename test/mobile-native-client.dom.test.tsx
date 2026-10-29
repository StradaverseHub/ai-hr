import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind } from 'typescript';
import * as React from 'react';
import * as integrity from '../lib/mobile-integrity-contract';
import * as contract from '../lib/mobile-api/contract';
import {readBoundedBody} from '../lib/bounded-body';
import {createReadCoordinator,retryAfterSeconds} from '../mobile/lib/read-coordinator';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiOriginProblem } from '../mobile/lib/config';
import { SessionChangedError, SignInRequiredError, UnavailableError, RequestRejectedError, NetworkUnavailableError, ThrottledError } from '../mobile/lib/errors';
import * as offlineContract from '../lib/mobile-offline-contract';
import * as v2Common from '../lib/mobile-api/v2/common';
import { z } from 'zod';
import {enrollmentFixture} from './helpers/mobile-enrollment-fixture';
import {androidEnrollmentFixture} from './helpers/mobile-android-enrollment-fixture';

/** Execute the shipped client/hook. Only the native ports are replaced, not the request logic. */
const employee = (name:string) => ({apiVersion:'v1',person:{name,email:null},employments:[],roles:[],modules:{payroll:false,notifications:false}});
function clientFixture() {
  let generation = 0;
  let namespace='company-one',monotonic=0,locale='en';
  const appState={currentState:'active'};
  const config = { apiUrl: 'https://hr.example.com' };
  const response = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => Response.json(new URL(url).pathname.endsWith('/clock') ? {outcome:'refused',code:'clock_conflict'} : employee('Employment one')));
  const auth = { authGeneration: () => generation,
    assertAuthGeneration(owner: number) { if (owner !== generation) throw new SessionChangedError(); },
    getAccessToken: vi.fn(async () => 'access-token'), refresh: vi.fn(async () => 'rotated-token') };
  const output = { exports: {} as { apiGet: (path: string, params?: Record<string, string>,signal?:AbortSignal) => Promise<unknown>; apiPost: (path:string,body:unknown,params?:Record<string,string>,operation?:{assertCurrent():void})=>Promise<unknown>;
    useApi: (path: string, params: Record<string, string>, onSignInRequired: () => void) => { data: { person: {name:string} } | null };
    v2Page: (path:string,item:z.ZodType)=>unknown; v2Download: (path:string,maxBytes?:number)=>unknown;
    apiGetPage: (resource:unknown,cursor:string|null,params?:Record<string,string>,signal?:AbortSignal)=>Promise<{items:unknown[];nextCursor:string|null}>;
    apiDownload: (resource:unknown,params?:Record<string,string>,signal?:AbortSignal)=>Promise<{outcome:string;code?:string;document?:{uri:string}}> } };
  const written = vi.fn((bytes: Uint8Array, mimeType: string) => ({ uri: 'cache/aihr-protected/random.pdf', mimeType, size: bytes.byteLength, delete: vi.fn() }));
  const code = transpileModule(readFileSync('mobile/lib/api.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  runInNewContext(code, { exports: output.exports, module: output, fetch: response, AbortController, FormData, TextDecoder, setTimeout, clearTimeout,
    require: (id: string) => {
      if (id === 'react') return React;
      if (id === 'react-native') return {AppState:appState};
      if (id === 'expo/fetch') return {fetch:response};
      if (id === '../../lib/bounded-body') return {readBoundedBody};
      if (id === '../../lib/mobile-integrity-contract') return integrity;
      if (id === '../../lib/mobile-api/contract') return contract;
      if (id === '../../lib/mobile-offline-contract') return offlineContract;
      if (id === './auth') return auth;
      if (id === './config') return { config, apiOriginProblem, configProblem: () => null,identityNamespace:()=>namespace };
      if (id === './read-coordinator') return {retryAfterSeconds,createReadCoordinator:(ports:Parameters<typeof createReadCoordinator>[0],...limits:[number?,number?])=>createReadCoordinator({...ports,now:()=>monotonic},...limits)};
      if (id === './errors') return { SessionChangedError, SignInRequiredError, UnavailableError, RequestRejectedError, NetworkUnavailableError, ThrottledError };
      if (id === './i18n') return { appLocale: () => locale };
      if (id === '../../lib/mobile-api/v2/common') return v2Common;
      if (id === './protected-document') return { writeProtectedDocument: written };
      throw new Error(`Unexpected native client dependency: ${id}`);
    } });
  return { api: output.exports, config, response, auth, appState, written, changeSession() { generation += 1; },changeConnection(){namespace='company-two';},changeLocale(){locale='ms';},advanceCooldown(ms:number){monotonic+=ms;} };
}
afterEach(()=>{cleanup();vi.useRealTimers();});

describe('native API transport', () => {
  it.each(['ios','android'] as const)('validates %s discovery without accepting the other platform or falling back',async(platform)=>{
    const f=clientFixture(),path='v2/integrity/'+platform+'/capabilities';
    f.response.mockResolvedValueOnce(Response.json({outcome:'capabilities',protocol:2,platform,features:['key_enrollment'],offline:false}));
    expect(await f.api.apiGet(path)).toMatchObject({outcome:'capabilities',platform});
    expect(new URL(f.response.mock.calls[0][0]).pathname).toBe('/api/mobile/v2/integrity/'+platform+'/capabilities');
    f.response.mockResolvedValueOnce(Response.json({outcome:'capabilities',protocol:2,platform:platform==='ios'?'android':'ios',features:['key_enrollment'],offline:false}));
    await expect(f.api.apiGet(path)).rejects.toBeInstanceOf(UnavailableError);
    f.response.mockResolvedValueOnce(new Response('',{status:404}));await expect(f.api.apiGet(path)).rejects.toMatchObject({status:404});expect(f.response).toHaveBeenCalledTimes(3);
  });
  it.each(['ios','android'] as const)('keeps %s enrollment on its exact protocol and never downgrades a missing command',async(platform)=>{
    const f=clientFixture(),e=platform==='ios'?enrollmentFixture():androidEnrollmentFixture();
    const prefix=platform==='ios'?'integrity/enrollment':'v2/integrity/android/enrollment',path=prefix+'/begin';
    f.response.mockResolvedValueOnce(Response.json(e.prepared()));
    expect(await f.api.apiPost(path,{requestId:e.requestId,appInstallationId:e.scope.appInstallationId},{employmentId:e.employmentId})).toMatchObject({outcome:'prepared',protocol:platform==='ios'?1:2});
    expect(new URL(f.response.mock.calls[0][0]).pathname).toBe(platform==='ios'?'/api/mobile/v1/integrity/enrollment/begin':'/api/mobile/v2/integrity/android/enrollment/begin');
    f.response.mockResolvedValueOnce(new Response('',{status:404}));
    await expect(f.api.apiPost(path,{requestId:e.requestId,appInstallationId:e.scope.appInstallationId},{employmentId:e.employmentId})).rejects.toMatchObject({status:404});
    expect(f.response).toHaveBeenCalledTimes(2);
    const wrong=platform==='ios'?androidEnrollmentFixture().prepared():enrollmentFixture().prepared();
    f.response.mockResolvedValueOnce(Response.json(wrong));
    await expect(f.api.apiPost(path,{requestId:e.requestId,appInstallationId:e.scope.appInstallationId},{employmentId:e.employmentId})).rejects.toBeInstanceOf(UnavailableError);
  });
  it('uses explicit v2 URLs and validates Android inventory, receipts and commands',async()=>{
    const f=clientFixture(),id='11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const key={keyId:id,originChallengeId:id,platform:'android',appId:'ai.hr',environment:null,proofKind:'google_key_generation_proof',nativeKeyBinding:'a'.repeat(64),createdAt:'2026-10-27T00:00:00.000Z',revokedAt:null};
    f.response.mockResolvedValueOnce(Response.json({outcome:'keys',items:[{...key,vendorKeyId:'private'}]}));
    expect(await f.api.apiGet('v2/integrity/keys',{employmentId:id})).toEqual({outcome:'keys',items:[key]});
    expect(f.response.mock.calls[0][0]).toBe('https://hr.example.com/api/mobile/v2/integrity/keys?employmentId='+id);
    f.response.mockResolvedValueOnce(Response.json({outcome:'key_receipt',key}));
    expect(await f.api.apiPost('v2/integrity/key-receipt',{originChallengeId:id},{employmentId:id})).toEqual({outcome:'key_receipt',key});
    f.response.mockResolvedValueOnce(Response.json({outcome:'revoked',key:{...key,revokedAt:key.createdAt}}));
    expect(await f.api.apiPost('v2/integrity/revoke',{keyId:id},{employmentId:id})).toMatchObject({outcome:'revoked'});
    expect(f.response.mock.calls[2][0]).toContain('/api/mobile/v2/integrity/revoke?');
    expect(f.response.mock.calls[2][1]?.body).toBe(JSON.stringify({keyId:id}));
  });
  it('falls back only from a missing v2 inventory and keeps the legacy decoder Apple-only',async()=>{
    const f=clientFixture();f.response.mockResolvedValueOnce(new Response('',{status:404})).mockResolvedValueOnce(Response.json({outcome:'keys',items:[]}));
    expect(await f.api.apiGet('v2/integrity/keys')).toEqual({outcome:'keys',items:[]});
    expect(f.response.mock.calls.map(([url])=>new URL(url).pathname)).toEqual(['/api/mobile/v2/integrity/keys','/api/mobile/v1/integrity/keys']);
    const bad=clientFixture(),id='11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    bad.response.mockResolvedValueOnce(new Response('',{status:404})).mockResolvedValueOnce(Response.json({outcome:'keys',items:[{keyId:id,originChallengeId:id,platform:'android',appId:'ai.hr',environment:null,proofKind:'google_key_generation_proof',nativeKeyBinding:'a'.repeat(64),createdAt:'2026-10-27T00:00:00.000Z',revokedAt:null}]}));
    await expect(bad.api.apiGet('v2/integrity/keys')).rejects.toBeInstanceOf(UnavailableError);
  });
  it('refreshes ownership before compatible reads and never downgrades or replays a v2 command',async()=>{
    const f=clientFixture();f.response.mockResolvedValueOnce(new Response('',{status:401})).mockResolvedValueOnce(new Response('',{status:404})).mockResolvedValueOnce(Response.json({outcome:'keys',items:[]}));
    expect(await f.api.apiGet('v2/integrity/keys')).toEqual({outcome:'keys',items:[]});expect(f.auth.refresh).toHaveBeenCalledOnce();
    expect(f.response.mock.calls[2][1]?.headers).toMatchObject({authorization:'Bearer rotated-token'});
    const write=clientFixture();write.response.mockResolvedValueOnce(new Response('',{status:404}));
    await expect(write.api.apiPost('v2/integrity/revoke',{keyId:'11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})).rejects.toMatchObject({status:404});expect(write.response).toHaveBeenCalledOnce();
    const failed=clientFixture();failed.response.mockResolvedValueOnce(new Response('',{status:503}));
    await expect(failed.api.apiGet('v2/integrity/keys')).rejects.toBeInstanceOf(UnavailableError);expect(failed.response).toHaveBeenCalledOnce();
  });
  it('validates key recovery contracts and sends only the selected key command through normal bearer transport',async()=>{
    const f=clientFixture(),id='11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const key={keyId:id,originChallengeId:id,platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production',proofKind:'apple_key_proof',nativeKeyBinding:'a'.repeat(64),createdAt:'2026-10-27T00:00:00.000Z',revokedAt:null};
    f.response.mockResolvedValueOnce(Response.json({outcome:'keys',items:[{...key,vendorKeyId:'private'}]}));
    expect(await f.api.apiGet('integrity/keys',{employmentId:id})).toEqual({outcome:'keys',items:[key]});
    const revoked={...key,revokedAt:'2026-10-28T00:00:00.000Z'};
    f.response.mockResolvedValueOnce(Response.json({outcome:'revoked',key:revoked}));
    expect(await f.api.apiPost('integrity/revoke',{keyId:id},{employmentId:id})).toEqual({outcome:'revoked',key:revoked});
    const [url,request]=f.response.mock.calls[1];expect(url).toBe('https://hr.example.com/api/mobile/v1/integrity/revoke?employmentId='+id);
    expect(request?.body).toBe(JSON.stringify({keyId:id}));expect(request?.credentials).toBe('omit');expect(request?.redirect).toBe('error');
    expect(request?.headers).toMatchObject({authorization:'Bearer access-token','content-type':'application/json'});
    f.response.mockResolvedValueOnce(Response.json({outcome:'key_receipt',key:null}));
    expect(await f.api.apiPost('integrity/key-receipt',{originChallengeId:id},{employmentId:id})).toEqual({outcome:'key_receipt',key:null});
    const [lookup,command]=f.response.mock.calls[2];expect(lookup).toBe('https://hr.example.com/api/mobile/v1/integrity/key-receipt?employmentId='+id);
    expect(command?.body).toBe(JSON.stringify({originChallengeId:id}));
    f.response.mockResolvedValueOnce(Response.json({outcome:'key_receipt',key:'unknown'}));
    await expect(f.api.apiPost('integrity/key-receipt',{originChallengeId:id},{employmentId:id})).rejects.toBeInstanceOf(UnavailableError);
    f.response.mockResolvedValueOnce(Response.json({outcome:'keys',items:Array(21).fill(key)}));
    await expect(f.api.apiGet('integrity/keys',{employmentId:id})).rejects.toBeInstanceOf(UnavailableError);
  });
  it('retains only a bounded UUID support reference from server failures',async()=>{
    const f=clientFixture(),reference='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    f.response.mockResolvedValueOnce(new Response('',{status:500,headers:{'x-aihr-support-id':reference.toUpperCase()}}));
    await expect(f.api.apiGet('me')).rejects.toMatchObject({supportId:reference});
    for(const value of ['private@email.test','x'.repeat(1000),'cccccccc-cccc-0ccc-8ccc-cccccccccccc']){
      f.response.mockResolvedValueOnce(new Response('',{status:503,headers:{'x-aihr-support-id':value}}));
      await expect(f.api.apiGet('me')).rejects.toMatchObject({supportId:undefined});
    }
  });
  it('does not start a queued read under a different language than its scoped key',async()=>{
    const f=clientFixture();const pending=f.api.apiGet('me');f.changeLocale();
    await expect(pending).rejects.toBeInstanceOf(SessionChangedError);expect(f.response).not.toHaveBeenCalled();
    await f.api.apiGet('me');expect(f.response.mock.calls[0][1]?.headers).toHaveProperty('accept-language','ms');
  });
  it('a refresh refusal from an obsolete account is not a sign-in refusal for the new account',async()=>{
    const f=clientFixture();f.response.mockResolvedValueOnce(new Response('',{status:401}));
    f.auth.refresh.mockImplementationOnce(async()=>{queueMicrotask(()=>f.changeSession());throw new SignInRequiredError();});
    await expect(f.api.apiGet('me')).rejects.toBeInstanceOf(SessionChangedError);expect(f.response).toHaveBeenCalledOnce();
  });
  it('shares a scoped read across widgets and one unmount cannot cancel the remaining widget',async()=>{
    const f=clientFixture();let release!:(response:Response)=>void;
    f.response.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));const onSignInRequired=vi.fn();
    function Widget({label}:{label:string}){const result=f.api.useApi('me',{},onSignInRequired);return <span>{label}: {result.data?.person.name??'loading'}</span>;}
    const ui=render(<><Widget key="a" label="A"/><Widget key="b" label="B"/></>);
    await waitFor(()=>expect(f.response).toHaveBeenCalledOnce());ui.rerender(<Widget key="b" label="B"/>);
    expect(f.response.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await act(async()=>release(Response.json(employee('Shared employee'))));await screen.findByText('B: Shared employee');
    expect(f.auth.getAccessToken).toHaveBeenCalledOnce();expect(onSignInRequired).not.toHaveBeenCalled();
  });
  it('keeps equivalent parameter order in one read and isolates a different company profile at the same origin',async()=>{
    const f=clientFixture();let release!:(response:Response)=>void;
    f.response.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const first=f.api.apiGet('me',{employmentId:'own',locale:'en'}).catch(e=>e);
    const second=f.api.apiGet('me',{locale:'en',employmentId:'own'}).catch(e=>e);
    await waitFor(()=>expect(f.response).toHaveBeenCalledOnce());f.changeConnection();
    const fresh=await f.api.apiGet('me',{employmentId:'own',locale:'en'});
    expect(await first).toBeInstanceOf(SessionChangedError);expect(await second).toBeInstanceOf(SessionChangedError);
    release(Response.json(employee('Obsolete employee')));expect(fresh).toEqual(employee('Employment one'));expect(f.response).toHaveBeenCalledTimes(2);
  });
  it('honors a longer read Retry-After without automatic or repeated manual network attempts',async()=>{
    const f=clientFixture();f.response.mockResolvedValueOnce(new Response('',{status:429,headers:{'retry-after':'5'}}));
    await expect(f.api.apiGet('me')).rejects.toMatchObject({retryAfter:5});
    await expect(f.api.apiGet('me')).rejects.toMatchObject({retryAfter:5});expect(f.response).toHaveBeenCalledOnce();
    f.advanceCooldown(5001);await expect(f.api.apiGet('me')).resolves.toEqual(employee('Employment one'));expect(f.response).toHaveBeenCalledTimes(2);
  });
  it('retries a read refused by the per-user in-flight admission once, after the short stated wait, and never twice',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const f=clientFixture(),busy=()=>new Response('',{status:429,headers:{'retry-after':'1'}});
    f.response.mockResolvedValueOnce(busy());
    const first=f.api.apiGet('me');
    await vi.advanceTimersByTimeAsync(999);expect(f.response).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300);expect(await first).toEqual(employee('Employment one'));expect(f.response).toHaveBeenCalledTimes(2);
    f.response.mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy());
    const second=f.api.apiGet('v2/integrity/keys').catch((error:unknown)=>error);
    await vi.advanceTimersByTimeAsync(5000);
    const refused=await second;expect(refused).toBeInstanceOf(ThrottledError);expect(refused).toMatchObject({retryAfter:1});expect(f.response).toHaveBeenCalledTimes(4);
    // A write is never retried here.
    f.response.mockResolvedValueOnce(busy());
    await expect(f.api.apiPost('clock',new FormData())).rejects.toBeInstanceOf(ThrottledError);await vi.advanceTimersByTimeAsync(5000);expect(f.response).toHaveBeenCalledTimes(5);
  });
  it('keeps at most six reads in flight and starts the queued ones as answers arrive',async()=>{
    const f=clientFixture(),held:((r:Response)=>void)[]=[];let answered=0,peak=0;
    f.response.mockImplementation(()=>new Promise<Response>(resolve=>{held.push(resolve);peak=Math.max(peak,f.response.mock.calls.length-answered);}));
    const paths=['me','leave','payslips','notifications','tasks','team','clock','leave-options','leave-requests','design','clock-attempts','submission-receipt','v2/integrity/keys'];
    const all=Promise.all(paths.map(path=>f.api.apiGet(path).catch(()=>undefined)));
    await vi.waitFor(()=>expect(f.response).toHaveBeenCalledTimes(6));
    await new Promise(r=>setTimeout(r,20));expect(f.response).toHaveBeenCalledTimes(6);
    while(answered<paths.length){
      await vi.waitFor(()=>expect(held.length).toBeGreaterThan(0));
      held.shift()!(answered%2?Response.json(employee('Answer')):new Response('',{status:503}));answered++;
      await new Promise(r=>setTimeout(r,0));
    }
    await all;expect(f.response).toHaveBeenCalledTimes(paths.length);expect(peak).toBe(6);
  });
  it('never starts a write in the background, including after a delayed token refresh',async()=>{
    const f=clientFixture();f.appState.currentState='background';
    await expect(f.api.apiPost('clock',new FormData())).rejects.toBeInstanceOf(UnavailableError);
    expect(f.response).not.toHaveBeenCalled();f.appState.currentState='active';
    f.response.mockResolvedValueOnce(new Response('',{status:401}));
    f.auth.refresh.mockImplementationOnce(async()=>{f.appState.currentState='background';return 'rotated-token';});
    await expect(f.api.apiPost('clock',new FormData())).rejects.toBeInstanceOf(UnavailableError);
    expect(f.response).toHaveBeenCalledTimes(1);
  });
  it('preserves the exact multipart command across the single 401 refresh and leaves Content-Type to fetch',async()=>{
    const f=clientFixture();const body=new FormData();body.append('command',JSON.stringify({requestId:'same-command'}));
    f.response.mockResolvedValueOnce(new Response('',{status:401}));await f.api.apiPost('clock',body,{employmentId:'own'});
    expect(f.response).toHaveBeenCalledTimes(2);for(const [,init] of f.response.mock.calls){expect(init?.body).toBe(body);expect(init?.method).toBe('POST');expect(init?.headers).not.toHaveProperty('content-type');}
  });
  it('does not silently retry a failed write and distinguishes validation refusal from uncertainty',async()=>{
    const f=clientFixture();f.response.mockResolvedValueOnce(new Response('',{status:503}));await expect(f.api.apiPost('clock',new FormData())).rejects.toBeInstanceOf(UnavailableError);expect(f.response).toHaveBeenCalledTimes(1);
    f.response.mockResolvedValueOnce(new Response('',{status:400}));await expect(f.api.apiPost('clock',new FormData())).rejects.toBeInstanceOf(RequestRejectedError);expect(f.response).toHaveBeenCalledTimes(2);
  });

  it('refuses HTTP before reading credentials or sending a request', async () => {
    const f = clientFixture(); f.config.apiUrl = 'http://hr.example.com';
    await expect(f.api.apiGet('me')).rejects.toBeInstanceOf(UnavailableError);
    expect(f.auth.getAccessToken).not.toHaveBeenCalled(); expect(f.response).not.toHaveBeenCalled();
  });
  it('a stale 401 cannot refresh or sign out a new account', async () => {
    const f = clientFixture(); let release!: (response: Response) => void;
    f.response.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.api.apiGet('me').catch((error: unknown) => error);
    await waitFor(() => expect(f.response).toHaveBeenCalledTimes(1));
    f.changeSession(); release(new Response('', { status: 401 }));
    expect(await pending).toBeInstanceOf(SessionChangedError);
    expect(f.auth.refresh).not.toHaveBeenCalled();
  });
  it('refreshes once for a current 401, preserving bearer and locale headers', async () => {
    const f = clientFixture(); f.response.mockResolvedValueOnce(new Response('', { status: 401 }));
    await f.api.apiGet('me', { employmentId: 'two' });
    expect(f.auth.refresh).toHaveBeenCalledTimes(1); expect(f.response).toHaveBeenCalledTimes(2);
    expect(f.response.mock.calls[1]).toEqual(['https://hr.example.com/api/mobile/v1/me?employmentId=two', {
      headers: { authorization: 'Bearer rotated-token', 'accept-language': 'en' }, redirect: 'error', credentials: 'omit',
      signal: expect.any(AbortSignal),
    }]);
  });
  it.each([429, 503])('HTTP %s is unavailable and never refreshes the credentials', async (status) => {
    const f = clientFixture(); f.response.mockResolvedValueOnce(new Response('', { status }));
    await expect(f.api.apiGet('me')).rejects.toBeInstanceOf(UnavailableError);
    expect(f.auth.refresh).not.toHaveBeenCalled();
  });
});

describe('native employment data isolation in the rendered hook', () => {
  it('hides the previous employment before the next request resolves', async () => {
    const f = clientFixture(); const onSignInRequired = vi.fn();
    function Screen({ employmentId }: { employmentId: string }) {
      const result = f.api.useApi('me', { employmentId }, onSignInRequired) as { data: { person: {name:string} } | null };
      return <div>{result.data?.person.name ?? 'Loading employment'}</div>;
    }
    const rendered = render(<Screen employmentId="one" />);
    expect(await screen.findByText('Employment one')).toBeInTheDocument();
    let release!: (value: Response) => void;
    f.response.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    rendered.rerender(<Screen employmentId="two" />);
    expect(screen.queryByText('Employment one')).not.toBeInTheDocument();
    expect(screen.getByText('Loading employment')).toBeInTheDocument();
    await waitFor(() => expect(f.response).toHaveBeenCalledTimes(2));
    await act(async () => { release(Response.json(employee('Employment two'))); });
    expect(await screen.findByText('Employment two')).toBeInTheDocument();
    expect(onSignInRequired).not.toHaveBeenCalled();
  });
});


describe('native response safety and refresh resilience',()=>{
  it('keeps same-scope data visible during a refresh and after a failed refresh',async()=>{
    const f=clientFixture(),onAuth=vi.fn();
    function App(){const result=f.api.useApi('me',{},onAuth) as any;return <><span>{result.data?.person.name}</span><span>{result.error?'Refresh failed':''}</span><button onClick={result.reload}>Refresh</button></>;}
    render(<App/>);await screen.findByText('Employment one');
    let release!:(r:Response)=>void;f.response.mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));
    fireEvent.click(screen.getByText('Refresh'));expect(screen.getByText('Employment one')).toBeInTheDocument();
    await act(async()=>release(new Response('',{status:503})));
    expect(await screen.findByText('Refresh failed')).toBeInTheDocument();expect(screen.getByText('Employment one')).toBeInTheDocument();expect(onAuth).not.toHaveBeenCalled();
  });
  it('discards cached content on a definitive permission refusal',async()=>{
    const f=clientFixture(),onAuth=vi.fn();
    function App(){const result=f.api.useApi('me',{},onAuth) as any;return <><span>{result.data?.person.name}</span><span>{result.error?'Refused':''}</span><button onClick={result.reload}>Refresh</button></>;}
    render(<App/>);await screen.findByText('Employment one');f.response.mockResolvedValueOnce(new Response('',{status:403}));
    fireEvent.click(screen.getByText('Refresh'));await screen.findByText('Refused');expect(screen.queryByText('Employment one')).not.toBeInTheDocument();
  });
  it.each([{}, {apiVersion:'v1',person:{name:42}}, {apiVersion:'v99'}])('rejects malformed business response %j without retrying or signing out',async payload=>{
    const f=clientFixture();f.response.mockResolvedValueOnce(Response.json(payload));
    await expect(f.api.apiGet('me')).rejects.toBeInstanceOf(UnavailableError);expect(f.response).toHaveBeenCalledTimes(1);expect(f.auth.refresh).not.toHaveBeenCalled();
  });
  it('caps actual streamed response bytes even without Content-Length',async()=>{
    const f=clientFixture(),cancel=vi.fn();f.response.mockResolvedValueOnce(new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1024*1024+1));},cancel})));
    await expect(f.api.apiGet('me')).rejects.toBeInstanceOf(UnavailableError);expect(cancel).toHaveBeenCalledOnce();
  });
  it('keeps the deadline alive when headers arrive but the body stalls',async()=>{
    vi.useFakeTimers();const f=clientFixture(),cancel=vi.fn();
    f.response.mockResolvedValueOnce(new Response(new ReadableStream({start(){},cancel})));
    const pending=f.api.apiGet('me').catch(e=>e);await vi.advanceTimersByTimeAsync(15_001);
    expect(await pending).toBeInstanceOf(UnavailableError);expect(cancel).toHaveBeenCalledOnce();expect(f.auth.refresh).not.toHaveBeenCalled();
  });
});


describe('signed clock transport and operation ownership',()=>{
 it.each(['ios','android'] as const)('keeps %s signed clock paths on v2 without legacy fallback',async platform=>{
  const f=clientFixture(),prefix='v2/integrity/'+platform+'/clock/';
  f.response.mockResolvedValueOnce(Response.json({outcome:'capabilities',protocol:2,platform,commandProtocol:platform==='ios'?1:2,
   features:platform==='ios'?['online_clock_assertion']:['online_clock_signature','current_play_integrity'],offline:false,cloudProjectNumber:platform==='ios'?null:'123456789'}));
  expect(await f.api.apiGet(prefix+'capabilities')).toMatchObject({platform,outcome:'capabilities'});
  const form=new FormData();form.append('command','saved command');
  f.response.mockResolvedValueOnce(Response.json({outcome:'refused',code:'challenge_unavailable'}));
  expect(await f.api.apiPost(prefix+'begin',form)).toEqual({outcome:'refused',code:'challenge_unavailable'});
  expect(f.response.mock.calls[1][1]?.body).toBe(form);
  f.response.mockResolvedValueOnce(new Response('',{status:404}));
  await expect(f.api.apiPost(prefix+'complete',form)).rejects.toMatchObject({status:404});
  expect(f.response).toHaveBeenCalledTimes(3);expect(new URL(f.response.mock.calls[2][0]).pathname).toBe('/api/mobile/'+prefix+'complete');
 });
 it('refuses a signed write without its multipart envelope before requesting credentials',async()=>{
  const f=clientFixture();await expect(f.api.apiPost('v2/integrity/ios/clock/complete',{})).rejects.toBeInstanceOf(UnavailableError);
  expect(f.auth.getAccessToken).not.toHaveBeenCalled();expect(f.response).not.toHaveBeenCalled();
 });
 it('checks privacy/selection ownership again before a refreshed-token mutation',async()=>{
  const f=clientFixture();let unlocked=true;const operation={assertCurrent(){if(!unlocked)throw new SessionChangedError();}};
  f.response.mockResolvedValueOnce(new Response('',{status:401}));
  f.auth.refresh.mockImplementationOnce(async()=>{unlocked=false;return 'rotated-token';});
  await expect(f.api.apiPost('v2/integrity/ios/clock/complete',new FormData(),{},operation)).rejects.toBeInstanceOf(SessionChangedError);
  expect(f.auth.refresh).toHaveBeenCalledOnce();expect(f.response).toHaveBeenCalledOnce();
 });
 it('checks operation ownership after a delayed token lookup, before the first mutation',async()=>{
  const f=clientFixture();let live=true;
  f.auth.getAccessToken.mockImplementationOnce(async()=>{live=false;return 'access-token';});
  await expect(f.api.apiPost('clock',new FormData(),{},{assertCurrent(){if(!live)throw new SessionChangedError();}})).rejects.toBeInstanceOf(SessionChangedError);
  expect(f.response).not.toHaveBeenCalled();
 });
});

describe('offline clocking transport',()=>{
  const id='11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  it('reports no HTTP response as the connectivity signal and keeps every HTTP outage a plain UnavailableError',async()=>{
    const f=clientFixture();f.response.mockRejectedValueOnce(new TypeError('Network request failed'));
    const offline=await f.api.apiGet('v2/integrity/ios/offline/capabilities',{employmentId:id}).catch((error:unknown)=>error);
    expect(offline).toBeInstanceOf(NetworkUnavailableError);expect(offline).toBeInstanceOf(UnavailableError);
    f.advanceCooldown(600000);
    for(const status of [500,503,429]){
      f.response.mockResolvedValueOnce(new Response('',{status,headers:{'retry-after':'7'}}));
      const outage=await f.api.apiPost('v2/integrity/ios/offline/context/close',{contextId:id,closeRequestId:id,consumedThrough:0},{employmentId:id}).catch((error:unknown)=>error);
      expect(outage,String(status)).toBeInstanceOf(UnavailableError);expect(outage,String(status)).not.toBeInstanceOf(NetworkUnavailableError);
    }
    f.response.mockResolvedValueOnce(Response.json({outcome:'garbage'}));
    const malformed=await f.api.apiPost('v2/integrity/ios/offline/context/close',{contextId:id,closeRequestId:id,consumedThrough:0},{employmentId:id}).catch((error:unknown)=>error);
    expect(malformed).toBeInstanceOf(UnavailableError);expect(malformed).not.toBeInstanceOf(NetworkUnavailableError);
  });
  it.each(['ios','android'] as const)('uses the exact %s offline URLs, JSON bodies and validated results',async platform=>{
    const f=clientFixture(),base='/api/mobile/v2/integrity/'+platform+'/offline/';
    // Keyless (owner decision D16): capabilities carry no issuer registry.
    const capabilities={outcome:'offline',enabled:true,apiOrigin:'https://hr.example.com',companyId:id,windowMs:86400000,permitCount:8};
    f.response.mockResolvedValueOnce(Response.json(capabilities));
    expect(await f.api.apiGet('v2/integrity/'+platform+'/offline/capabilities',{employmentId:id})).toEqual(capabilities);
    expect(new URL(f.response.mock.calls[0][0]).pathname).toBe(base+'capabilities');
    f.response.mockResolvedValueOnce(Response.json({outcome:'refused',code:'online_pending'}));
    const request={requestId:id,requestNonce:'A'.repeat(43),appInstallationId:id,keyId:id};
    expect(await f.api.apiPost('v2/integrity/'+platform+'/offline/context',request,{employmentId:id})).toEqual({outcome:'refused',code:'online_pending'});
    const init=f.response.mock.calls[1][1]!;expect(new URL(f.response.mock.calls[1][0]).pathname).toBe(base+'context');
    expect(JSON.parse(String(init.body))).toEqual(request);expect((init.headers as Record<string,string>)['content-type']).toBe('application/json');
    f.response.mockResolvedValueOnce(Response.json({outcome:'processed',receipt:{}}));
    const form=new FormData();form.append('claim','{}');
    await expect(f.api.apiPost('v2/integrity/'+platform+'/offline/claim',form,{employmentId:id})).rejects.toBeInstanceOf(UnavailableError);
    await expect(f.api.apiPost('v2/integrity/'+platform+'/offline/claim',{} as never,{employmentId:id})).rejects.toThrow('saved attachment envelope');
  });
});

describe('v2 cursor pages and protected downloads', () => {
  const pdf = () => new Response(new TextEncoder().encode('%PDF-1.7 synthetic'), { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="document.pdf"' } });
  it('reads a page through the v2 path with its own schema and an opaque cursor parameter', async () => {
    const f = clientFixture(), page = f.api.v2Page('v2/test-items', z.object({ id: z.string() }));
    f.response.mockResolvedValueOnce(Response.json({ items: [{ id: 'a', salary: '9999.99' }], nextCursor: 'Q1' }));
    expect(await f.api.apiGetPage(page, 'Q0', { employmentId: 'e1' })).toEqual({ items: [{ id: 'a' }], nextCursor: 'Q1' });
    const sent = new URL(f.response.mock.calls[0][0]);
    expect(sent.pathname).toBe('/api/mobile/v2/test-items');
    expect(Object.fromEntries(sent.searchParams)).toEqual({ cursor: 'Q0', employmentId: 'e1' });
    f.response.mockResolvedValueOnce(Response.json({ items: [{ id: 1 }], nextCursor: null }));
    await expect(f.api.apiGetPage(page, null)).rejects.toBeInstanceOf(UnavailableError);
    await expect(f.api.apiGetPage(page, null, { cursor: 'x' })).rejects.toThrow('cursor separately');
  });
  it('writes an allowed attachment to a protected file and returns its handle', async () => {
    const f = clientFixture(), file = f.api.v2Download('v2/test-pdf');
    f.response.mockResolvedValueOnce(pdf());
    const result = await f.api.apiDownload(file, { id: 'p1' });
    expect(result).toMatchObject({ outcome: 'file', document: { uri: 'cache/aihr-protected/random.pdf' } });
    expect(f.written).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(f.written.mock.calls[0][0])).toBe('%PDF-1.7 synthetic');
    expect(f.written.mock.calls[0][1]).toBe('application/pdf');
    expect(new URL(f.response.mock.calls[0][0]).pathname).toBe('/api/mobile/v2/test-pdf');
  });
  it('returns a JSON refusal and writes nothing', async () => {
    const f = clientFixture();
    f.response.mockResolvedValueOnce(Response.json({ outcome: 'refused', code: 'not_released' }));
    expect(await f.api.apiDownload(f.api.v2Download('v2/test-pdf'))).toEqual({ outcome: 'refused', code: 'not_released' });
    expect(f.written).not.toHaveBeenCalled();
  });
  it('refuses a disallowed type, an inline disposition, an oversized body, a backgrounded app and a superseded session', async () => {
    const f = clientFixture(), file = f.api.v2Download('v2/test-pdf', 8);
    f.response.mockResolvedValueOnce(new Response('<html>', { headers: { 'content-type': 'text/html', 'content-disposition': 'attachment' } }));
    await expect(f.api.apiDownload(f.api.v2Download('v2/test-pdf'))).rejects.toBeInstanceOf(UnavailableError);
    f.response.mockResolvedValueOnce(new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline' } }));
    await expect(f.api.apiDownload(f.api.v2Download('v2/test-pdf'))).rejects.toBeInstanceOf(UnavailableError);
    f.response.mockResolvedValueOnce(pdf());
    await expect(f.api.apiDownload(file)).rejects.toBeInstanceOf(UnavailableError);
    f.appState.currentState = 'background';
    f.response.mockResolvedValueOnce(pdf());
    await expect(f.api.apiDownload(f.api.v2Download('v2/test-pdf'))).rejects.toBeInstanceOf(UnavailableError);
    f.appState.currentState = 'active';
    f.response.mockImplementationOnce(async () => { f.changeSession(); return pdf(); });
    await expect(f.api.apiDownload(f.api.v2Download('v2/test-pdf'))).rejects.toBeInstanceOf(SessionChangedError);
    expect(f.written).not.toHaveBeenCalled();
  });
});

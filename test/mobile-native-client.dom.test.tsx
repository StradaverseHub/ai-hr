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
import { SessionChangedError, SignInRequiredError, UnavailableError, RequestRejectedError } from '../mobile/lib/errors';

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
  const output = { exports: {} as { apiGet: (path: string, params?: Record<string, string>,signal?:AbortSignal) => Promise<unknown>; apiPost: (path:string,body:unknown,params?:Record<string,string>)=>Promise<unknown>;
    useApi: (path: string, params: Record<string, string>, onSignInRequired: () => void) => { data: { person: {name:string} } | null } } };
  const code = transpileModule(readFileSync('mobile/lib/api.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  runInNewContext(code, { exports: output.exports, module: output, fetch: response, AbortController, FormData, TextDecoder, setTimeout, clearTimeout,
    require: (id: string) => {
      if (id === 'react') return React;
      if (id === 'react-native') return {AppState:appState};
      if (id === 'expo/fetch') return {fetch:response};
      if (id === '../../lib/bounded-body') return {readBoundedBody};
      if (id === '../../lib/mobile-integrity-contract') return integrity;
      if (id === '../../lib/mobile-api/contract') return contract;
      if (id === './auth') return auth;
      if (id === './config') return { config, apiOriginProblem, configProblem: () => null,identityNamespace:()=>namespace };
      if (id === './read-coordinator') return {retryAfterSeconds,createReadCoordinator:(ports:Parameters<typeof createReadCoordinator>[0])=>createReadCoordinator({...ports,now:()=>monotonic})};
      if (id === './errors') return { SessionChangedError, SignInRequiredError, UnavailableError, RequestRejectedError };
      if (id === './i18n') return { appLocale: () => locale };
      throw new Error(`Unexpected native client dependency: ${id}`);
    } });
  return { api: output.exports, config, response, auth, appState, changeSession() { generation += 1; },changeConnection(){namespace='company-two';},changeLocale(){locale='ms';},advanceCooldown(ms:number){monotonic+=ms;} };
}
afterEach(()=>{cleanup();vi.useRealTimers();});

describe('native API transport', () => {
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
  it('honors a safe read Retry-After without automatic or repeated manual network attempts',async()=>{
    const f=clientFixture();f.response.mockResolvedValueOnce(new Response('',{status:429,headers:{'retry-after':'2'}}));
    await expect(f.api.apiGet('me')).rejects.toMatchObject({retryAfter:2});
    await expect(f.api.apiGet('me')).rejects.toMatchObject({retryAfter:2});expect(f.response).toHaveBeenCalledOnce();
    f.advanceCooldown(2001);await expect(f.api.apiGet('me')).resolves.toEqual(employee('Employment one'));expect(f.response).toHaveBeenCalledTimes(2);
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

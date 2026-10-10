import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind } from 'typescript';
import * as React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiOriginProblem } from '../mobile/lib/config';
import { SessionChangedError, SignInRequiredError, UnavailableError, RequestRejectedError } from '../mobile/lib/errors';

/** Execute the shipped client/hook. Only the native ports are replaced, not the request logic. */
function clientFixture() {
  let generation = 0;
  const config = { apiUrl: 'https://hr.example.com' };
  const response = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ name: 'Employment one' }), { status: 200 }));
  const auth = { authGeneration: () => generation,
    assertAuthGeneration(owner: number) { if (owner !== generation) throw new SessionChangedError(); },
    getAccessToken: vi.fn(async () => 'access-token'), refresh: vi.fn(async () => 'rotated-token') };
  const output = { exports: {} as { apiGet: (path: string, params?: Record<string, string>) => Promise<unknown>; apiPost: (path:string,body:unknown,params?:Record<string,string>)=>Promise<unknown>;
    useApi: (path: string, params: Record<string, string>, onSignInRequired: () => void) => { data: { name: string } | null } } };
  const code = transpileModule(readFileSync('mobile/lib/api.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  runInNewContext(code, { exports: output.exports, module: output, fetch: response, AbortController, FormData, setTimeout, clearTimeout,
    require: (id: string) => {
      if (id === 'react') return React;
      if (id === './auth') return auth;
      if (id === './config') return { config, apiOriginProblem };
      if (id === './errors') return { SessionChangedError, SignInRequiredError, UnavailableError, RequestRejectedError };
      if (id === './i18n') return { appLocale: () => 'en' };
      throw new Error(`Unexpected native client dependency: ${id}`);
    } });
  return { api: output.exports, config, response, auth, changeSession() { generation += 1; } };
}
afterEach(cleanup);

describe('native API transport', () => {
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
      headers: { authorization: 'Bearer rotated-token', 'accept-language': 'en' }, redirect: 'error',
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
      const result = f.api.useApi('me', { employmentId }, onSignInRequired) as { data: { name: string } | null };
      return <div>{result.data?.name ?? 'Loading employment'}</div>;
    }
    const rendered = render(<Screen employmentId="one" />);
    expect(await screen.findByText('Employment one')).toBeInTheDocument();
    let release!: (value: Response) => void;
    f.response.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    rendered.rerender(<Screen employmentId="two" />);
    expect(screen.queryByText('Employment one')).not.toBeInTheDocument();
    expect(screen.getByText('Loading employment')).toBeInTheDocument();
    await waitFor(() => expect(f.response).toHaveBeenCalledTimes(2));
    await act(async () => { release(new Response(JSON.stringify({ name: 'Employment two' }))); });
    expect(await screen.findByText('Employment two')).toBeInTheDocument();
    expect(onSignInRequired).not.toHaveBeenCalled();
  });
});

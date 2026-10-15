import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionChangedError } from '../mobile/lib/errors';
function fixture() {
  let owner = 1, unavailable = false;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ step: 'mfa', challenge: 'c'.repeat(43) }));
  const output = { exports: {} as { internalAuthRequest: (op: string, values: Record<string,string>, owner: number, fetcher: typeof fetch) => Promise<unknown> } };
  runInNewContext(transpileModule(readFileSync('mobile/lib/internal-auth.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,
    {exports:output.exports,module:output,AbortController,setTimeout,clearTimeout,require(name:string){
      if(name==='./config')return {config:{apiUrl:'https://hr.private.test',authProvider:'internal'},configProblem:()=>unavailable?'Unverified server':null};
      if(name==='./auth')return {assertAuthGeneration:(current:number)=>{if(current!==owner)throw new SessionChangedError();}};
      throw new Error(name);
    }});
  const send = () => output.exports.internalAuthRequest('login',{organization:'private',username:'employee',password:'Private fixture password'},1,fetcher);
  return { fetcher,send,change:()=>{owner++;},disable:()=>{unavailable=true;} };
}
afterEach(()=>vi.useRealTimers());
describe('native embedded credential transport',()=>{
  it('posts only to the pinned app origin, without browser cookies, redirects or bearer credentials',async()=>{
    const f=fixture();await expect(f.send()).resolves.toEqual({step:'mfa',challenge:'c'.repeat(43)});
    const [url,init]=f.fetcher.mock.calls[0];expect(url).toBe('https://hr.private.test/login/api/login');
    expect(init).toMatchObject({method:'POST',credentials:'omit',redirect:'error',headers:{'content-type':'application/json','x-aihr-client':'native'}});
    expect(JSON.parse(String(init?.body))).toMatchObject({organization:'private',username:'employee'});
    expect(init?.headers).not.toHaveProperty('authorization');
  });
  it('refuses a missing/unverified connection before any credential request',async()=>{
    const f=fixture();f.disable();await expect(f.send()).rejects.toMatchObject({code:'unavailable'});expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('rejects a late challenge or session from the previous company generation',async()=>{
    const f=fixture();let release!:(response:Response)=>void;
    f.fetcher.mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));const pending=f.send();f.change();release(Response.json({step:'mfa',challenge:'c'.repeat(43)}));
    await expect(pending).rejects.toBeInstanceOf(SessionChangedError);
  });
  it('bounds streamed responses before accumulating an unbounded body',async()=>{
    const f=fixture(),cancel=vi.fn();
    f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(40_000));},cancel})));
    await expect(f.send()).rejects.toMatchObject({code:'unavailable'});expect(cancel).toHaveBeenCalledOnce();
  });
  it('refuses external QR URLs, malformed handles and invalid expiry hints',async()=>{
    for(const reply of [{step:'enroll',challenge:'c'.repeat(43),secret:'A'.repeat(32),qr:'https://attacker.test/track'},
      {step:'complete',access_token:'foreign.jwt.signature',refresh_token:'other',expires_in:900},
      {step:'complete',access_token:'aihr_'+'a'.repeat(43),refresh_token:'aihr_refresh_'+'b'.repeat(43),expires_in:99999}]){
      const f=fixture();f.fetcher.mockResolvedValueOnce(Response.json(reply));await expect(f.send()).rejects.toMatchObject({code:'unavailable'});
    }
  });
  it('aborts a stalled credential exchange within the declared time bound',async()=>{
    vi.useFakeTimers();const f=fixture();f.fetcher.mockImplementationOnce((_url,init)=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new Error('Aborted')));}));
    const pending=f.send().catch(error=>error);await vi.advanceTimersByTimeAsync(20_001);expect(await pending).toBeInstanceOf(Error);
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});

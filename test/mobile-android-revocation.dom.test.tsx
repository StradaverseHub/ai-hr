/** Synthetic HTTPS ports; no Google access or certificate validation in these tests. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createAndroidRevocationChecker} from '../lib/mobile-api/android-revocation';
const now=1800000000000;
const response=(body:unknown={entries:{}},headers:Record<string,string>={})=>Response.json(body,{headers:{date:new Date(now).toUTCString(),...headers}});
function fixture(){const transport=vi.fn<typeof fetch>(async()=>response());let time=now;const check=createAndroidRevocationChecker({transport,now:()=>time});return {transport,check,time:(value:number)=>{time=value;}};}
afterEach(()=>vi.useRealTimers());
describe('bounded Android certificate revocation observation',()=>{
 it('contacts only the fixed Google endpoint without credentials or certificate serials',async()=>{
  const f=fixture();expect(await f.check(['a1','ff'])).toEqual({status:'checked',source:'google_https',checkedAt:now,certificateCount:2});
  expect(f.transport).toHaveBeenCalledOnce();const [url,init]=f.transport.mock.calls[0];expect(url).toBe('https://android.googleapis.com/attestation/status');
  expect(init).toMatchObject({method:'GET',headers:{accept:'application/json'},redirect:'error',credentials:'omit',cache:'no-store'});expect(init).not.toHaveProperty('body');
 });
 it('checks every supplied path serial and refuses revoked before suspended irrespective of expiry metadata',async()=>{
  const f=fixture();f.transport.mockImplementation(async()=>response({entries:{a1:{status:'SUSPENDED'},ff:{status:'REVOKED',expires:'2020-01-01'}}}));
  expect(await f.check(['a1','ff'])).toEqual({status:'refused',reason:'revoked'});expect(await f.check(['a1'])).toEqual({status:'refused',reason:'suspended'});
 });
 it('does not cache or reuse a passing response across outage or changed statuses',async()=>{
  const f=fixture();await f.check(['a1']);f.transport.mockRejectedValueOnce(new Error('private provider fault'));
  expect(await f.check(['a1'])).toEqual({status:'unavailable',reason:'provider'});expect(f.transport).toHaveBeenCalledTimes(2);
  f.transport.mockResolvedValueOnce(response({entries:{a1:{status:'REVOKED'}}}));expect(await f.check(['a1'])).toEqual({status:'refused',reason:'revoked'});
 });
 it('requires bounded canonical server-path serials before network access',async()=>{
  const f=fixture();for(const serials of [[],['00a'],['A1'],['0'],['a\n'],['-1'],['a','a'],Array.from({length:9},(_,i)=>(i+1).toString(16)),['a'.repeat(41)]])expect(await f.check(serials)).toEqual({status:'invalid',reason:'invalid_serials'});
  expect(f.transport).not.toHaveBeenCalled();
 });
 it('refuses missing, stale, future or malformed HTTP freshness evidence',async()=>{
  const f=fixture();const invalidHeaders:Record<string,string>[]=[{date:''},{date:new Date(now-3600001).toUTCString()},{date:new Date(now+31000).toUTCString()},{age:'3601'},{age:'-1'},{age:'01'}];for(const headers of invalidHeaders){
   f.transport.mockResolvedValueOnce(response({entries:{}},headers));expect(await f.check(['a1'])).toEqual({status:'unavailable',reason:'stale'});
  }
 });
 it('includes body-transfer elapsed time and snapshots caller serials before awaiting transport',async()=>{
  const f=fixture(),serials=['a1'];f.transport.mockImplementationOnce(async()=>{serials[0]='ff';f.time(now+3600001);return response({entries:{a1:{status:'REVOKED'}}});});
  expect(await f.check(serials)).toEqual({status:'unavailable',reason:'stale'});
  const g=fixture(),input=['a1'];g.transport.mockImplementationOnce(async()=>{input[0]='ff';return response({entries:{a1:{status:'REVOKED'}}});});expect(await g.check(input)).toEqual({status:'refused',reason:'revoked'});
 });
 it('refuses malformed status lists, unknown statuses, extra fields and duplicate escaped member names',async()=>{
  const f=fixture();for(const value of [{},{entries:{a1:{status:'GOOD'}}},{entries:{a1:{status:'REVOKED',comment:'x'.repeat(141)}}},{entries:{'0a':{status:'REVOKED'}}},{entries:{a1:{status:'REVOKED',expires:'2026-02-30'}}},{entries:{},verified:true}]){
   f.transport.mockResolvedValueOnce(response(value));expect(await f.check(['a1'])).toEqual({status:'unavailable',reason:'malformed'});
  }
  for(const body of ['{"entries":{"a1":{"status":"REVOKED"},"a1":{}}}','{"entries":{},"\\u0065ntries":{}}','{"entries":{"a1":{"status":"REVOKED","status":"SUSPENDED"}}}','{"entries":[]}']){
   f.transport.mockResolvedValueOnce(new Response(body,{headers:{date:new Date(now).toUTCString()}}));expect(await f.check(['a1'])).toEqual({status:'unavailable',reason:'malformed'});
  }
 });
 it('bounds actual stream bytes despite false Content-Length',async()=>{
  const f=fixture();f.transport.mockResolvedValueOnce(new Response(new Uint8Array(4*1024*1024+1),{headers:{date:new Date(now).toUTCString(),'content-length':'1'}}));
  expect(await f.check(['a1'])).toEqual({status:'unavailable',reason:'malformed'});
 });
 it.each([301,304,403,429,500])('refuses HTTP %s without retries',async status=>{
  const f=fixture();f.transport.mockResolvedValueOnce(new Response(null,{status}));expect(await f.check(['a1'])).toEqual({status:'unavailable',reason:'provider'});expect(f.transport).toHaveBeenCalledOnce();
 });
 it('times out stalled transport and body and ignores late success',async()=>{
  vi.useFakeTimers();const f=fixture();let finish!:(r:Response)=>void;f.transport.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  const work=f.check(['a1']);await vi.advanceTimersByTimeAsync(10001);expect(await work).toEqual({status:'unavailable',reason:'timeout'});finish(response());
  const g=fixture();g.transport.mockResolvedValueOnce(new Response(new ReadableStream({start(){}}),{headers:{date:new Date(now).toUTCString()}}));
  const body=g.check(['a1']);await vi.advanceTimersByTimeAsync(10001);expect(await body).toEqual({status:'unavailable',reason:'timeout'});
 });
 it('does not start an aborted request and cancels an in-flight caller',async()=>{
  const f=fixture(),abort=new AbortController();abort.abort();expect(await f.check(['a1'],abort.signal)).toEqual({status:'unavailable',reason:'aborted'});expect(f.transport).not.toHaveBeenCalled();
  const g=fixture(),controller=new AbortController();g.transport.mockReturnValueOnce(new Promise(()=>{}));const pending=g.check(['a1'],controller.signal);controller.abort();expect(await pending).toEqual({status:'unavailable',reason:'aborted'});
 });
 it('refuses invalid configuration and a backwards server clock',async()=>{
  const f=fixture();expect(await createAndroidRevocationChecker({transport:f.transport,timeoutMs:0})(['a1'])).toEqual({status:'unavailable',reason:'configuration'});expect(f.transport).not.toHaveBeenCalled();
  f.transport.mockImplementationOnce(async()=>{f.time(now-1);return response();});expect(await f.check(['a1'])).toEqual({status:'unavailable',reason:'configuration'});
 });
});

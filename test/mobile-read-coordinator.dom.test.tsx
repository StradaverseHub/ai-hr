import {describe,expect,it,vi} from 'vitest';
import {createReadCoordinator,retryAfterSeconds} from '../mobile/lib/read-coordinator';
class Unavailable extends Error{constructor(readonly retryAfter?:number){super();}}
class Obsolete extends Error{}
function fixture(capacity=64){let now=0;return {owner:createReadCoordinator({unavailable:seconds=>new Unavailable(seconds),obsolete:()=>new Obsolete(),backoff:e=>e instanceof Unavailable?e.retryAfter:undefined,now:()=>now},capacity),advance:(ms:number)=>{now+=ms;}};}
describe('bounded shared read ownership',()=>{
  it('coalesces consumers while keeping their cancellation independent',async()=>{
    const f=fixture(),a=new AbortController(),b=new AbortController();let release!:(value:string)=>void,underlying!:AbortSignal;
    const load=vi.fn((signal:AbortSignal)=>{underlying=signal;return new Promise<string>(resolve=>{release=resolve;});});
    const first=f.owner.read('scope','key',load,a.signal).catch(e=>e),second=f.owner.read('scope','key',load,b.signal);
    await Promise.resolve();expect(load).toHaveBeenCalledOnce();a.abort();expect(await first).toBeInstanceOf(Unavailable);expect(underlying.aborted).toBe(false);
    release('shared');expect(await second).toBe('shared');
  });
  it('cancels an unconsumed read before starting it and permits a fresh request',async()=>{
    const f=fixture(),a=new AbortController(),load=vi.fn(async()=>'fresh');
    const cancelled=f.owner.read('scope','key',load,a.signal).catch(e=>e);a.abort();
    expect(await cancelled).toBeInstanceOf(Unavailable);expect(load).not.toHaveBeenCalled();
    expect(await f.owner.read('scope','key',load)).toBe('fresh');expect(load).toHaveBeenCalledOnce();
  });
  it('invalidates an old scope without a late response deleting or supplying the new scope read',async()=>{
    const f=fixture();let oldRelease!:(v:string)=>void,newRelease!:(v:string)=>void;
    const oldLoad=vi.fn(()=>new Promise<string>(r=>{oldRelease=r;})),newLoad=vi.fn(()=>new Promise<string>(r=>{newRelease=r;}));
    const old=f.owner.read('old','key',oldLoad).catch(e=>e);await Promise.resolve();
    const fresh=f.owner.read('new','key',newLoad);await Promise.resolve();oldRelease('old result');await Promise.resolve();
    const peer=f.owner.read('new','key',newLoad);expect(await old).toBeInstanceOf(Obsolete);expect(newLoad).toHaveBeenCalledOnce();
    newRelease('new result');expect(await fresh).toBe('new result');expect(await peer).toBe('new result');
  });
  it('bounds outstanding keys and releases capacity when the operation completes',async()=>{
    const f=fixture(1);let release!:(value:string)=>void;const first=f.owner.read('scope','a',()=>new Promise<string>(r=>{release=r;}));
    await expect(f.owner.read('scope','b',async()=>'b')).rejects.toBeInstanceOf(Unavailable);
    release('a');expect(await first).toBe('a');expect(await f.owner.read('scope','b',async()=>'b')).toBe('b');
  });
  it('keeps only a bounded cooldown after rate refusal and never retries in the background',async()=>{
    const f=fixture(),load=vi.fn(async()=>{throw new Unavailable(5);});
    await expect(f.owner.read('scope','key',load)).rejects.toMatchObject({retryAfter:5});f.advance(3000);
    await expect(f.owner.read('scope','key',load)).rejects.toMatchObject({retryAfter:2});expect(load).toHaveBeenCalledOnce();
    f.advance(2001);await expect(f.owner.read('scope','key',load)).rejects.toMatchObject({retryAfter:5});expect(load).toHaveBeenCalledTimes(2);
    expect(await f.owner.read('new-scope','key',async()=>'fresh')).toBe('fresh');
  });
  it('does not turn a rejection without an error value into a successful response',async()=>{
    const f=fixture();await expect(f.owner.read('scope','key',()=>Promise.reject())).rejects.toBeUndefined();
  });
  it('accepts bounded delta/date hints and ignores malformed or unbounded ones',()=>{
    const now=Date.now();expect(retryAfterSeconds(' 2 ',now)).toBe(2);
    expect(retryAfterSeconds(new Date(now+3000).toUTCString(),now)).toBe(3);
    for(const value of [null,'','0','-1','not-a-date','9999999999','1'.repeat(1000),new Date(now-60000).toUTCString()])expect(retryAfterSeconds(value,now)).toBeUndefined();
  });
});

describe('bounded concurrency and one short retry',()=>{
  function limited(concurrency:number,retry?:(e:unknown)=>number|undefined){
    return createReadCoordinator({unavailable:seconds=>new Unavailable(seconds),obsolete:()=>new Obsolete(),backoff:()=>undefined,retry},64,concurrency);
  }
  const tick=()=>new Promise(r=>setTimeout(r,0));
  it('starts at most N loads, queues the rest in order, and never starts a queued read nobody wants',async()=>{
    const owner=limited(2),started:string[]=[],release=new Map<string,(v:string)=>void>();
    const load=(key:string)=>()=>{started.push(key);return new Promise<string>(r=>{release.set(key,r);});};
    const gone=new AbortController();
    const reads=[owner.read('s','a',load('a')),owner.read('s','b',load('b')),owner.read('s','c',load('c'),gone.signal).catch(e=>e),owner.read('s','d',load('d'))];
    await tick();expect(started).toEqual(['a','b']);
    gone.abort();expect(await reads[2]).toBeInstanceOf(Unavailable);
    release.get('a')!('A');await tick();expect(started).toEqual(['a','b','d']);
    release.get('b')!('B');release.get('d')!('D');
    expect(await Promise.all([reads[0],reads[1],reads[3]])).toEqual(['A','B','D']);
    expect(started).not.toContain('c');
  });
  it('frees the slot when a load fails, and when a scope change cancels the queue',async()=>{
    const owner=limited(1);let release!:(v:string)=>void;
    const failing=owner.read('s','a',async()=>{throw new Error('down');}).catch(e=>e);
    const next=owner.read('s','b',()=>new Promise<string>(r=>{release=r;}));
    expect(await failing).toBeInstanceOf(Error);await tick();release('B');expect(await next).toBe('B');
    const blocked=owner.read('s','c',()=>new Promise<string>(()=>{}));const waiting=owner.read('s','d',async()=>'never').catch(e=>e);
    void blocked.catch(()=>{});
    expect(await owner.read('other-scope','e',async()=>'E').catch(e=>e)).toBe('E');
    expect(await waiting).toBeInstanceOf(Obsolete);
  });
  it('retries once after the port\'s delay, in a fresh slot, and gives up after the second refusal',async()=>{
    vi.useFakeTimers();
    try{
      const busy=new Unavailable(1),owner=limited(1,e=>e===busy?1000:undefined);
      const load=vi.fn().mockRejectedValueOnce(busy).mockResolvedValueOnce('fine');
      const first=owner.read('s','a',load);
      await vi.advanceTimersByTimeAsync(999);expect(load).toHaveBeenCalledOnce();
      // The waiting retry holds no slot: another read runs meanwhile.
      expect(await owner.read('s','other',async()=>'other')).toBe('other');
      await vi.advanceTimersByTimeAsync(1);expect(await first).toBe('fine');expect(load).toHaveBeenCalledTimes(2);
      const twice=vi.fn().mockRejectedValue(busy);const second=owner.read('s','b',twice).catch(e=>e);
      await vi.advanceTimersByTimeAsync(5000);expect(await second).toBe(busy);expect(twice).toHaveBeenCalledTimes(2);
      const long=vi.fn().mockRejectedValue(new Unavailable(5));const noRetry=limited(1,()=>undefined).read('s','c',long).catch(e=>e);
      await vi.advanceTimersByTimeAsync(10000);expect(await noRetry).toBeInstanceOf(Unavailable);expect(long).toHaveBeenCalledOnce();
      // A consumer that leaves during the wait cancels the retry.
      const leave=new AbortController(),again=vi.fn().mockRejectedValueOnce(busy).mockResolvedValue('late');
      const left=owner.read('s','d',again,leave.signal).catch(e=>e);await vi.advanceTimersByTimeAsync(10);leave.abort();
      expect(await left).toBeInstanceOf(Unavailable);await vi.advanceTimersByTimeAsync(5000);expect(again).toHaveBeenCalledOnce();
    }finally{vi.useRealTimers();}
  });
});

import {afterEach,describe,expect,it,vi} from 'vitest';
import {applicationDatabaseBudget} from '../db/capacity';
import {
  createHomeCardRefreshGate,deliverHomeCard,HOME_CARD_READ_HARD_CAP_MS,HOME_CARD_STREAM_STALL_MS,HomeCardReadTimeoutError,
} from '../lib/employee-home-delivery';

afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('independent employee Home read delivery',()=>{
  it('names the stall window and hard cap once, below the database admission queue wait',()=>{
    expect(HOME_CARD_STREAM_STALL_MS).toBe(8000);
    expect(HOME_CARD_READ_HARD_CAP_MS).toBe(20000);
    expect(HOME_CARD_STREAM_STALL_MS).toBeLessThan(HOME_CARD_READ_HARD_CAP_MS);
    const queueWaitMs=applicationDatabaseBudget({}).waitMs;
    expect(queueWaitMs).toBe(30000);
    expect(HOME_CARD_READ_HARD_CAP_MS).toBeLessThan(queueWaitMs);
    expect(()=>deliverHomeCard(async()=>1,{timeoutMs:HOME_CARD_READ_HARD_CAP_MS+1})).toThrow(RangeError);
  });
  it('keeps a slow read loading past the former 2.8 s deadline and delivers it without a timeout',async()=>{
    vi.useFakeTimers();
    let release:((value:string)=>void)|undefined,seen:AbortSignal|undefined;
    let settled=false;
    const result=deliverHomeCard(signal=>{seen=signal;return new Promise<string>(resolve=>{release=resolve;});});
    void result.then(()=>{settled=true;});
    await vi.advanceTimersByTimeAsync(2800);
    await vi.advanceTimersByTimeAsync(HOME_CARD_READ_HARD_CAP_MS-2800-1);
    expect(settled).toBe(false);expect(seen?.aborted).toBe(false);
    release!('Arrived just inside the cap');
    expect(await result).toEqual({state:'ready',value:'Arrived just inside the cap'});
    expect(seen?.aborted).toBe(false);
  });
  it('reports a limit raised by the stream, or any failure seen at the cap, as a timeout rather than a refusal',async()=>{
    expect(await deliverHomeCard(async()=>{throw new HomeCardReadTimeoutError();})).toEqual({state:'failed',reason:'timeout'});
    // The server's own cap answer can reach a browser whose timer was delayed: it is still the cap.
    const clock=vi.spyOn(performance,'now').mockReturnValue(1000);
    const read=(rejects:((reason:unknown)=>void)[])=>()=>new Promise<string>((_,reject)=>{rejects.push(reject);});
    const lateRejects:((reason:unknown)=>void)[]=[],earlyRejects:((reason:unknown)=>void)[]=[];
    const late=deliverHomeCard(read(lateRejects),{timeoutMs:100}),early=deliverHomeCard(read(earlyRejects),{timeoutMs:100});
    while(!lateRejects.length||!earlyRejects.length)await Promise.resolve();
    clock.mockReturnValue(1099);earlyRejects[0](new Error('Fictional refusal before the cap'));
    expect(await early).toEqual({state:'failed',reason:'unavailable'});
    clock.mockReturnValue(1150);lateRejects[0](new Error('Fictional server refusal after its cap'));
    expect(await late).toEqual({state:'failed',reason:'timeout'});
  });
  it('allows one automatic refresh per hard cap',()=>{
    let now=1000;const allow=createHomeCardRefreshGate(()=>now);
    expect(allow()).toBe(true);
    now+=2800;expect(allow()).toBe(false);
    now+=HOME_CARD_READ_HARD_CAP_MS-2801;expect(allow()).toBe(false);
    now+=1;expect(allow()).toBe(true);
  });
  it('delivers a ready sibling while another reader is delayed, then times out only the delayed one',async()=>{
    vi.useFakeTimers();
    let delayedSignal:AbortSignal|undefined;
    const delayed=vi.fn((signal:AbortSignal)=>{delayedSignal=signal;return new Promise<string>(()=>{});});
    const slow=deliverHomeCard(delayed);
    const fast=deliverHomeCard(async()=>({count:2}));
    expect(await fast).toEqual({state:'ready',value:{count:2}});
    expect(delayedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(HOME_CARD_READ_HARD_CAP_MS);
    expect(await slow).toEqual({state:'failed',reason:'timeout'});
    expect(delayedSignal?.aborted).toBe(true);
    expect(delayed).toHaveBeenCalledOnce();
  });
  it('does not invoke an already-cancelled read or retry a cancelled in-flight read',async()=>{
    const before=new AbortController();before.abort();
    const skipped=vi.fn(async()=>1);
    expect(await deliverHomeCard(skipped,{signal:before.signal})).toEqual({state:'cancelled'});
    expect(skipped).not.toHaveBeenCalled();
    const during=new AbortController();let seen:AbortSignal|undefined;
    const read=vi.fn((signal:AbortSignal)=>{seen=signal;return new Promise<number>(()=>{});});
    const result=deliverHomeCard(read,{signal:during.signal});
    await Promise.resolve();during.abort();
    expect(await result).toEqual({state:'cancelled'});
    expect(seen?.aborted).toBe(true);expect(read).toHaveBeenCalledOnce();
  });
  it('consumes a late rejection after timeout without leaking its body or changing the result',async()=>{
    vi.useFakeTimers();let rejectLate:((reason:unknown)=>void)|undefined;
    const result=deliverHomeCard(()=>new Promise<string>((_,reject)=>{rejectLate=reject;}),{timeoutMs:100});
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({state:'failed',reason:'timeout'});
    rejectLate!(new Error('Fictional private salary and SQL detail'));
    await Promise.resolve();await Promise.resolve();
    expect(await result).toEqual({state:'failed',reason:'timeout'});
    expect(JSON.stringify(await result)).not.toContain('salary');
  });
  it('does not expose synchronous or asynchronous reader errors and does not abort a completed read',async()=>{
    const sync=()=>{throw new Error('Fictional private record');};
    expect(await deliverHomeCard(sync)).toEqual({state:'failed',reason:'unavailable'});
    expect(await deliverHomeCard(async()=>{throw new Error('Fictional SQL');})).toEqual({state:'failed',reason:'unavailable'});
    const outer=new AbortController();let seen:AbortSignal|undefined;
    expect(await deliverHomeCard(async signal=>{seen=signal;return [] as string[];},{signal:outer.signal}))
      .toEqual({state:'ready',value:[]});
    outer.abort();expect(seen?.aborted).toBe(false);
  });
});

import {afterEach,describe,expect,it,vi} from 'vitest';
import {deliverHomeCard,HOME_CARD_READ_TIMEOUT_MS} from '../lib/employee-home-delivery';

afterEach(()=>vi.useRealTimers());
describe('independent employee Home read delivery',()=>{
  it('delivers a ready sibling while another reader is delayed, then times out only the delayed one',async()=>{
    vi.useFakeTimers();
    let delayedSignal:AbortSignal|undefined;
    const delayed=vi.fn((signal:AbortSignal)=>{delayedSignal=signal;return new Promise<string>(()=>{});});
    const slow=deliverHomeCard(delayed);
    const fast=deliverHomeCard(async()=>({count:2}));
    expect(await fast).toEqual({state:'ready',value:{count:2}});
    expect(delayedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(HOME_CARD_READ_TIMEOUT_MS);
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

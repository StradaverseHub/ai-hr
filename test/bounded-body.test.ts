import {afterEach,describe,expect,it,vi} from 'vitest';
import {readBoundedBody} from '../lib/bounded-body';
afterEach(()=>vi.useRealTimers());
describe('bounded body reads',()=>{
  it('reads bytes exactly and rejects a lying length once actual bytes exceed the cap',async()=>{
    const exact=new Response('body');expect(new TextDecoder().decode(await readBoundedBody(exact,4,1000))).toBe('body');
    await expect(readBoundedBody(new Response('oversize',{headers:{'content-length':'1'}}),4,1000)).rejects.toThrow('Body too large');
  });
  it('cancels a stalled stream at its deadline without waiting for a cooperative producer',async()=>{
    vi.useFakeTimers();const cancel=vi.fn(),response=new Response(new ReadableStream({start(){},cancel}));
    const pending=readBoundedBody(response,1024,100).catch(e=>e);await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({message:'Body read interrupted'});expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels on caller abort and rejects an already aborted request',async()=>{
    for(const immediate of [false,true]){const abort=new AbortController(),cancel=vi.fn();if(immediate)abort.abort();
      const pending=readBoundedBody(new Response(new ReadableStream({start(){},cancel})),1024,1000,abort.signal);if(!immediate)abort.abort();
      await expect(pending).rejects.toThrow('Body read interrupted');expect(cancel).toHaveBeenCalledOnce();}
  });
});

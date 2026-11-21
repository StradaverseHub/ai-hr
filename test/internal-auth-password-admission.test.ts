import {afterEach,expect,it,vi} from 'vitest';
import {AuthBusyError,createPasswordAdmission} from '../lib/internal-auth/password-admission';
afterEach(()=>vi.useRealTimers());
it('keeps two active leases and transfers released capacity in FIFO order',async()=>{
 const acquire=createPasswordAdmission(),[first,second]=await Promise.all([acquire(),acquire()]);
 const order:number[]=[];
 const third=acquire().then(release=>{order.push(3);return release;});
 const fourth=acquire().then(release=>{order.push(4);return release;});
 await Promise.resolve();expect(order).toEqual([]);
 first();const releaseThird=await third;expect(order).toEqual([3]);
 first();await Promise.resolve();expect(order).toEqual([3]); // duplicate release creates no extra capacity
 second();const releaseFourth=await fourth;expect(order).toEqual([3,4]);
 releaseThird();releaseFourth();const next=await acquire();next();
});
it('bounds waiting to six requests and expires waits without consuming an active slot',async()=>{
 vi.useFakeTimers();const acquire=createPasswordAdmission(),[first,second]=await Promise.all([acquire(),acquire()]);
 const queued=Array.from({length:6},()=>acquire()),settled=Promise.allSettled(queued);
 await expect(acquire()).rejects.toBeInstanceOf(AuthBusyError);
 await vi.advanceTimersByTimeAsync(2000);
 const results=await settled;expect(results).toHaveLength(6);
 for(const result of results){expect(result.status).toBe('rejected');if(result.status==='rejected')expect(result.reason).toBeInstanceOf(AuthBusyError);}
 first();second();const fresh=await acquire();fresh();expect(vi.getTimerCount()).toBe(0);
});
it('clears a granted wait timer so it cannot reject or steal a later lease',async()=>{
 vi.useFakeTimers();const acquire=createPasswordAdmission(),[first,second]=await Promise.all([acquire(),acquire()]);
 const queued=acquire();await vi.advanceTimersByTimeAsync(1999);first();const release=await queued;
 await vi.advanceTimersByTimeAsync(1);expect(vi.getTimerCount()).toBe(0);
 const fourth=acquire();release();const releaseFourth=await fourth;second();releaseFourth();
});

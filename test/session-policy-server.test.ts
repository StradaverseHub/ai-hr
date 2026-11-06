import {expect,it,vi} from 'vitest';
import {forgetIdleTimeout,idleTimeoutMinutesFor} from '../lib/session-policy-server';

const {unsafe}=vi.hoisted(()=>({unsafe:vi.fn()}));
vi.mock('../db/client',()=>({client:{unsafe}}));

it('shares a cold policy read and keeps an invalidated read out of the cache',async()=>{
 const tenant='fictional-policy-tenant';
 let finishOriginal!: (rows:{minutes:number}[])=>void;
 unsafe.mockImplementationOnce(()=>new Promise(resolve=>{finishOriginal=resolve;}))
  .mockResolvedValueOnce([{minutes:10}]);
 const original=idleTimeoutMinutesFor(tenant);
 const parallel=idleTimeoutMinutesFor(tenant);
 await vi.waitFor(()=>expect(unsafe).toHaveBeenCalledTimes(1));

 forgetIdleTimeout(tenant);
 expect(await idleTimeoutMinutesFor(tenant)).toBe(10);
 finishOriginal([{minutes:30}]);
 expect(await Promise.all([original,parallel])).toEqual([30,30]);
 expect(await idleTimeoutMinutesFor(tenant)).toBe(10);
 expect(unsafe).toHaveBeenCalledTimes(2);
});

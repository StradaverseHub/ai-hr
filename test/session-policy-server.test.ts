import {beforeEach,expect,it,vi} from 'vitest';
import {forgetIdleTimeout,idleTimeoutMinutesFor} from '../lib/session-policy-server';
import {DatabaseAdmissionError} from '../db/admission';

const {unsafe,admit}=vi.hoisted(()=>({unsafe:vi.fn(),admit:vi.fn(async(_tenant:string,read:()=>PromiseLike<unknown>)=>await read())}));
vi.mock('../db/client',()=>({client:{unsafe},withPoolWork:admit}));
beforeEach(()=>{unsafe.mockReset();admit.mockReset();admit.mockImplementation(async(_tenant,read)=>await read());});

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

it.each(['queue-full','queue-timeout','cancelled'] as const)('propagates %s without caching a policy and retries the configured five-minute limit',async kind=>{
 const tenant='fictional-policy-'+kind;
 const failure=kind==='cancelled'?new Error('owned policy read cancelled'):new DatabaseAdmissionError(kind);
 admit.mockRejectedValueOnce(failure);unsafe.mockResolvedValue([{minutes:5}]);
 await expect(idleTimeoutMinutesFor(tenant)).rejects.toBe(failure);
 expect(unsafe).not.toHaveBeenCalled();
 expect(await idleTimeoutMinutesFor(tenant)).toBe(5);
 expect(await idleTimeoutMinutesFor(tenant)).toBe(5);
 expect(admit).toHaveBeenCalledTimes(2);expect(unsafe).toHaveBeenCalledTimes(1);
});

it('retains the existing native SQL-failure fallback after admission',async()=>{
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 unsafe.mockRejectedValueOnce(new Error('fictional SQL failure'));
 try{expect(await idleTimeoutMinutesFor('fictional-policy-sql-fallback')).toBe(15);}
 finally{log.mockRestore();}
});

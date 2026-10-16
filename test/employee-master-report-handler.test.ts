import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createSingleReportHandler} from '../deploy/identity-email/report-handler';
it('refuses a second leased request immediately without cleanup or another SMTP preparation',async()=>{
  let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const deliver=vi.fn(async()=>{await blocked;return {outcome:'sent'};}),remove=vi.fn(async()=>{});
  const handler=createSingleReportHandler(deliver,remove),first={op:'sendReport' as const,occurrenceId:randomUUID(),leaseToken:randomUUID()};
  const pending=handler(first),second={...first,occurrenceId:randomUUID(),leaseToken:randomUUID()};
  expect(await Promise.race([handler(second),Promise.resolve('queued behind first')])).toEqual({outcome:'busy'});
  expect(deliver).toHaveBeenCalledTimes(1);expect(remove).not.toHaveBeenCalled();
  release();expect(await pending).toEqual({outcome:'sent'});expect(remove).toHaveBeenCalledExactlyOnceWith(first.occurrenceId,first.leaseToken);
  expect(await handler(second)).toEqual({outcome:'sent'});expect(deliver).toHaveBeenCalledTimes(2);
});
it('releases the guard after a failed delivery and cleanup while status remains available',async()=>{
  const deliver=vi.fn(async(input:{op:string})=>{if(input.op==='status')return {ready:true};throw new Error('fixture failure');});
  const failed=vi.fn(),handler=createSingleReportHandler(deliver,async()=>{throw new Error('fixture cleanup');},failed);
  const input={op:'sendReport' as const,occurrenceId:randomUUID(),leaseToken:randomUUID()};
  await expect(handler(input)).rejects.toThrow('fixture failure');expect(failed).toHaveBeenCalledTimes(1);
  expect(await handler({op:'status'})).toEqual({ready:true});
  await expect(handler(input)).rejects.toThrow('fixture failure');expect(deliver).toHaveBeenCalledTimes(3);
});

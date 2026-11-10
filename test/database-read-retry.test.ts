import {describe,expect,it,vi} from 'vitest';
import {DatabaseAdmissionError} from '../db/admission';
import {isDatabaseCapacityFailure,markDatabaseCapacityFailure,retryIdempotentRead} from '../db/read-retry';
import {DATABASE_CAPACITY_DIGEST} from '../lib/database-capacity';
import {databaseErrorKind} from '../lib/public-error';

const failure=(code:string)=>Object.assign(new Error('cancelled'),{code});
const noSleep=async()=>{};

describe('capacity failures',()=>{
 it('recognises an admission refusal and statement cancellation, and nothing else',()=>{
  expect(isDatabaseCapacityFailure(new DatabaseAdmissionError('queue-timeout'))).toBe(true);
  expect(isDatabaseCapacityFailure(failure('57014'))).toBe(true);
  expect(isDatabaseCapacityFailure(Object.assign(new Error('wrapped'),{cause:failure('57014')}))).toBe(true);
  expect(isDatabaseCapacityFailure(failure('23505'))).toBe(false);
  expect(isDatabaseCapacityFailure(new Error('other'))).toBe(false);
 });
 it('gives admission failures a digest the client boundary can read',()=>{
  expect(new DatabaseAdmissionError('queue-full').digest).toBe(DATABASE_CAPACITY_DIGEST);
  const error=markDatabaseCapacityFailure(failure('57014')) as {digest?:string};
  expect(error.digest).toBe(DATABASE_CAPACITY_DIGEST);
  expect((markDatabaseCapacityFailure(failure('23505')) as {digest?:string}).digest).toBeUndefined();
 });
 it('shows a statement cancellation as the translated busy sentence, not the system one',()=>{
  expect(databaseErrorKind('57014')).toBe('busy');
 });
});

describe('automatic retry of idempotent reads',()=>{
 it('retries a capacity failure and returns the read',async()=>{
  const read=vi.fn().mockRejectedValueOnce(new DatabaseAdmissionError('queue-timeout')).mockRejectedValueOnce(failure('57014')).mockResolvedValue('rows');
  await expect(retryIdempotentRead(read,undefined,{sleep:noSleep,now:()=>0})).resolves.toBe('rows');
  expect(read).toHaveBeenCalledTimes(3);
 });
 it('never retries any other failure',async()=>{
  const read=vi.fn().mockRejectedValue(failure('23505'));
  await expect(retryIdempotentRead(read,undefined,{sleep:noSleep})).rejects.toMatchObject({code:'23505'});
  expect(read).toHaveBeenCalledTimes(1);
 });
 it('stops after its attempts and surfaces the marked failure',async()=>{
  const read=vi.fn().mockRejectedValue(failure('57014'));
  await expect(retryIdempotentRead(read,undefined,{sleep:noSleep,now:()=>0,maxAttempts:2})).rejects.toMatchObject({digest:DATABASE_CAPACITY_DIGEST});
  expect(read).toHaveBeenCalledTimes(2);
 });
 it('does not start a retry that could not finish inside the budget',async()=>{
  let clock=0;
  const read=vi.fn().mockImplementation(async()=>{clock+=30_000;throw new DatabaseAdmissionError('queue-timeout');});
  await expect(retryIdempotentRead(read,undefined,{sleep:noSleep,now:()=>clock,budgetMs:45_000})).rejects.toMatchObject({code:'queue-timeout'});
  expect(read).toHaveBeenCalledTimes(1);
 });
 it('allows two full admission waits inside the default budget',async()=>{
  let clock=0;
  const read=vi.fn().mockImplementation(async()=>{clock+=30_000;throw new DatabaseAdmissionError('queue-timeout');});
  await expect(retryIdempotentRead(read,undefined,{sleep:noSleep,now:()=>clock})).rejects.toMatchObject({code:'queue-timeout'});
  expect(read).toHaveBeenCalledTimes(2);
 });
 it('stops when the reader has already left',async()=>{
  const controller=new AbortController();
  const read=vi.fn().mockImplementation(async()=>{controller.abort(new Error('left'));throw new DatabaseAdmissionError('queue-full');});
  await expect(retryIdempotentRead(read,controller.signal,{sleep:noSleep})).rejects.toMatchObject({code:'queue-full'});
  expect(read).toHaveBeenCalledTimes(1);
 });
});

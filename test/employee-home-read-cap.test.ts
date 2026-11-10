import {afterEach,describe,expect,it,vi} from 'vitest';
import {capHomeCardRead,HomeCardReadCapError} from '../app/api/home/read-cap';
import {cancelStatementsAtDeadline,currentDatabaseReadDeadline,databaseReadSignal} from '../db/workload';
import {HOME_CARD_READ_HARD_CAP_MS} from '../lib/employee-home-delivery';

afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('server-side Home card hard cap',()=>{
 it('aborts a stuck read at the shared hard cap and settles even when the reader ignores its signal',async()=>{
  vi.useFakeTimers();
  let deadline:AbortSignal|undefined,checkouts:AbortSignal|undefined;
  const read=vi.fn(()=>{deadline=currentDatabaseReadDeadline();checkouts=databaseReadSignal();return new Promise<string>(()=>{});});
  let outcome:unknown='pending';
  void capHomeCardRead(new AbortController().signal,read).catch(error=>{outcome=error;});
  await vi.advanceTimersByTimeAsync(HOME_CARD_READ_HARD_CAP_MS-1);
  expect(outcome).toBe('pending');expect(deadline?.aborted).toBe(false);expect(checkouts?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(outcome).toBeInstanceOf(HomeCardReadCapError);
  expect(deadline?.aborted).toBe(true);expect(checkouts?.aborted).toBe(true);
  expect(read).toHaveBeenCalledOnce();
 });
 it('leaves a disconnect as checkout cancellation only and clears its timer once the read settles',async()=>{
  vi.useFakeTimers();
  const request=new AbortController();let deadline:AbortSignal|undefined,checkouts:AbortSignal|undefined;
  let finish:((value:string)=>void)|undefined;
  const result=capHomeCardRead(request.signal,()=>{deadline=currentDatabaseReadDeadline();checkouts=databaseReadSignal();
   return new Promise<string>(resolve=>{finish=resolve;});});
  await vi.advanceTimersByTimeAsync(0);
  request.abort(new Error('Fictional disconnect'));
  expect(checkouts?.aborted).toBe(true);expect(deadline?.aborted).toBe(false);
  finish!('Fictional value');
  await expect(result).resolves.toBe('Fictional value');
  expect(vi.getTimerCount()).toBe(0);
  await expect(capHomeCardRead(new AbortController().signal,async()=>{throw new Error('Fictional refusal');})).rejects.toThrow('Fictional refusal');
  expect(vi.getTimerCount()).toBe(0);
 });
 it('cancels the statements a transaction opened and refuses any it asks for after the deadline',()=>{
  const deadline=new AbortController(),reason=new HomeCardReadCapError();
  const senders:ReturnType<typeof vi.fn>[]=[];
  const original=vi.fn(()=>{const canceller=vi.fn(async()=>{throw new Error('Fictional refused cancel connection');});senders.push(canceller);return {canceller};});
  const session={client:{unsafe:original as unknown as (...args:never[])=>{canceller?:null|((query:unknown)=>unknown)}}};
  const release=cancelStatementsAtDeadline(session,deadline.signal);
  const running=session.client.unsafe(),finished=session.client.unsafe();
  expect(original).toHaveBeenCalledTimes(2);expect(senders).toHaveLength(2);
  deadline.abort(reason);
  expect(senders[0]).toHaveBeenCalledWith(running);expect(senders[1]).toHaveBeenCalledWith(finished);
  expect(running.canceller).toBeNull();
  expect(()=>session.client.unsafe()).toThrow(reason);
  expect(original).toHaveBeenCalledTimes(2);
  release();
  expect(session.client.unsafe).toBe(original);
 });
});

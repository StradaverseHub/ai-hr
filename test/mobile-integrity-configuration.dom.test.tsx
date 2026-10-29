import {describe,expect,it,vi} from 'vitest';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {createIntegrityConfigurationReader} from '../lib/mobile-api/integrity-configuration';
const schema=z.object({origin:z.literal('https://hr.example.com')}).strict();
const ctx={tenantId:'test-tenant'} as SessionContext;
describe('shared server-owned integrity configuration lifetime',()=>{
 it('refuses a pre-aborted request without invoking configuration',async()=>{
  const read=vi.fn(async()=>({origin:'https://hr.example.com'})),controller=new AbortController();controller.abort();
  await expect(createIntegrityConfigurationReader(schema,read)(ctx,'own-employment',controller.signal)).rejects.toMatchObject({reason:'configuration_unavailable'});
  expect(read).not.toHaveBeenCalled();
 });
 it('cancels a non-cooperative reader when the request aborts and ignores late success',async()=>{
  let finish!:(value:unknown)=>void,observed:AbortSignal|undefined;
  const read=createIntegrityConfigurationReader(schema,async(_ctx,_id,signal)=>{observed=signal;return new Promise(resolve=>{finish=resolve;});});
  const controller=new AbortController(),result=read(ctx,'own-employment',controller.signal);
  await Promise.resolve();controller.abort();
  await expect(result).rejects.toMatchObject({reason:'configuration_unavailable'});expect(observed?.aborted).toBe(true);
  finish({origin:'https://hr.example.com'});await Promise.resolve();
 });
 it('bounds an uncooperative reader without waiting for its callback',async()=>{
  let signal:AbortSignal|undefined;
  const read=createIntegrityConfigurationReader(schema,async(_ctx,_id,s)=>{signal=s;return new Promise(()=>{});},5);
  await expect(read(ctx,'own-employment',new AbortController().signal)).rejects.toMatchObject({reason:'configuration_unavailable'});
  expect(signal?.aborted).toBe(true);
 });
 it('distinguishes absent policy from invalid policy and cleans up a successful reader signal',async()=>{
  const signal=new AbortController().signal;
  await expect(createIntegrityConfigurationReader(schema,async()=>null)(ctx,'own',signal)).rejects.toMatchObject({reason:'not_configured'});
  await expect(createIntegrityConfigurationReader(schema,async()=>({origin:'https://phone.example.com'}))(ctx,'own',signal)).rejects.toMatchObject({reason:'configuration_unavailable'});
  let observed:AbortSignal|undefined;
  expect(await createIntegrityConfigurationReader(schema,async(_ctx,_id,s)=>{observed=s;return {origin:'https://hr.example.com'};})(ctx,'own',signal)).toEqual({origin:'https://hr.example.com'});
  expect(observed?.aborted).toBe(true);expect(signal.aborted).toBe(false);
 });
 it('retains unexpected server failures for the private HTTP failure boundary and rejects invalid deadlines',async()=>{
  const failure=new Error('synthetic private server diagnostic');
  await expect(createIntegrityConfigurationReader(schema,async()=>{throw failure;})(ctx,'own',new AbortController().signal)).rejects.toBe(failure);
  for(const timeout of [0,-1,10001,NaN,1.5])expect(()=>createIntegrityConfigurationReader(schema,async()=>null,timeout)).toThrow('Invalid configuration deadline');
 });
});

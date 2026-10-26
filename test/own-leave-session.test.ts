/** Authored UNRUN: cookie-command selection never inherits the ordinary development fallback. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { resolveCommandDevPrincipal, resolveDevPrincipal } from '../lib/session';
const tenantId=randomUUID(),personId=randomUUID(),selected=randomUUID(),fallback=randomUUID();
const row={tenant_id:tenantId,person_id:personId,grants:[{role:'employee' as const,companyId:null}]};
describe('explicit human-command dev selection',()=>{
 it('resolves the real selected principal and preserves its grants without a fallback lookup',async()=>{
  const lookup=vi.fn(async(id:string)=>id===selected?[row]:[]),blocked=vi.fn(async()=>false);
  expect(await resolveCommandDevPrincipal(lookup,selected,blocked)).toMatchObject({tenantId,userId:selected,personId,roles:['employee'],grants:row.grants});
  expect(lookup).toHaveBeenCalledTimes(1);expect(lookup).toHaveBeenCalledWith(selected);expect(blocked).toHaveBeenCalledTimes(1);expect(blocked).toHaveBeenCalledWith(selected);
 });
 it('keeps ordinary page fallback working while missing/unknown command selections refuse',async()=>{
  const unknown=randomUUID(),lookup=vi.fn(async(id:string)=>id===fallback?[row]:[]),blocked=vi.fn(async()=>false);
  expect((await resolveDevPrincipal(lookup,undefined,fallback,blocked)).userId).toBe(fallback);
  lookup.mockClear();
  await expect(resolveCommandDevPrincipal(lookup,undefined,blocked)).rejects.toThrow('No selected browser session');
  expect(lookup).not.toHaveBeenCalled();
  await expect(resolveCommandDevPrincipal(lookup,unknown,blocked)).rejects.toThrow('No selected browser session');
  expect(lookup).toHaveBeenCalledTimes(1);expect(lookup).toHaveBeenCalledWith(unknown);expect(lookup).not.toHaveBeenCalledWith(fallback);
 });
 it('does not fall through blocked or malformed selections, and hides lookup diagnostics',async()=>{
  const lookup=vi.fn(async()=>[row]),blocked=vi.fn(async()=>true);
  await expect(resolveCommandDevPrincipal(lookup,selected,blocked)).rejects.toThrow('No selected browser session');
  lookup.mockClear();
  for(const value of ['', 'not-a-principal', 'x'.repeat(500)])await expect(resolveCommandDevPrincipal(lookup,value,blocked)).rejects.toThrow('No selected browser session');
  expect(lookup).not.toHaveBeenCalled();
  lookup.mockRejectedValueOnce(Error('PRIVATE_IDENTITY_DATABASE_SENTINEL'));
  let failure:unknown;try{await resolveCommandDevPrincipal(lookup,selected,async()=>false);}catch(error){failure=error;}
  expect((failure as Error).message).toBe('No selected browser session.');expect(failure).not.toHaveProperty('cause');
 });
});

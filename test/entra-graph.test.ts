import { describe,it,expect,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { entraConfigSchema, sourceId, trustedGraphUrl, workforcePayload, type WorkforceRecord } from '../lib/entra/model';
import { upload,reconcile,confirmedDirectoryObject } from '../lib/entra/graph';
const tenantId=randomUUID(),personId=randomUUID();
const config=entraConfigSchema.parse({tenantId,organization:'acme',directoryTenantId:randomUUID(),clientId:randomUUID(),clientSecret:'private',provisioningClientId:randomUUID(),provisioningClientSecret:'private',servicePrincipalId:randomUUID(),jobId:'job-1',mode:'cloud',domain:'acme.test',sourceAnchorAttribute:'extension_'+'a'.repeat(32)+'_hrSourceId',enabled:true,provisioningEnabled:true,immutableMatchingConfirmed:true,revision:randomUUID()});
const record:WorkforceRecord={tenant_id:tenantId,person_id:personId,full_name:'Employee One',active:true,revision:3,lease:randomUUID(),mode:'cloud',last_location:null,last_status:'pending',source_key:sourceId(tenantId,personId),submitted_revision:null,last_active:null};
const location='https://graph.microsoft.com/v1.0/auditLogs/provisioning?$filter=id%20eq%20%27receipt%27';
describe('Entra workforce transport',()=>{
 it('sends only the explicitly managed workforce fields with an immutable namespaced source ID',()=>{
  const data=workforcePayload(record,config).Operations[0].data;
  expect(data).toEqual({schemas:['urn:ietf:params:scim:schemas:core:2.0:User'],externalId:`aihr:${tenantId}:${personId}`,userName:`hr-${personId.replaceAll('-','')}@acme.test`,displayName:'Employee One',active:true});
  expect(()=>workforcePayload({...record,tenant_id:randomUUID()},config)).toThrow();
 });
 it('treats 202 as a receipt, never as a completed identity',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:202,headers:{location}}));
  expect(await upload(config,record,'bearer',fetcher)).toBe(location);
  expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'error',headers:{authorization:'Bearer bearer','content-type':'application/scim+json'}});
  fetcher.mockResolvedValue(new Response(null,{status:202}));await expect(upload(config,record,'bearer',fetcher)).rejects.toMatchObject({code:'uncertain'});
 });
 it('does not accept a foreign receipt host or credential-bearing URL',()=>{
  for(const value of ['https://evil.test/v1.0/auditLogs/provisioning','https://graph.microsoft.com.evil.test/v1.0/auditLogs/provisioning','https://u:p@graph.microsoft.com/v1.0/auditLogs/provisioning','https://graph.microsoft.com/v1.0/users'])expect(()=>trustedGraphUrl(value)).toThrow();
 });
 it('ignores logs from a different source or provisioning application',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({value:[{jobId:config.jobId,servicePrincipal:{id:config.servicePrincipalId},sourceIdentity:{id:'another-person'},statusInfo:{status:'success'},targetIdentity:{id:randomUUID()}}]}));
  expect(await reconcile(config,{...record,last_location:location},'token',fetcher)).toEqual({state:'pending'});
 });
 it('requires the immutable source marker, even if the generated UPN exists',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({id:randomUUID(),[config.sourceAnchorAttribute]:'wrong-source'}));
  await expect(confirmedDirectoryObject(config,record,'token',fetcher)).rejects.toMatchObject({code:'conflict'});
 });
 it('waits for hybrid sync and validates the object marker before adoption',async()=>{
  const id=randomUUID(),hybrid={...config,mode:'hybrid' as const,sourceAnchorAttribute:'onPremisesExtensionAttributes.extensionAttribute15'},r={...record,mode:'hybrid' as const};
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({id,onPremisesSyncEnabled:false,onPremisesExtensionAttributes:{extensionAttribute15:record.source_key}}));
  expect(await confirmedDirectoryObject(hybrid,r,'token',fetcher)).toBeNull();
  fetcher.mockResolvedValue(Response.json({id,onPremisesSyncEnabled:true,onPremisesExtensionAttributes:{extensionAttribute15:record.source_key}}));
  expect(await confirmedDirectoryObject(hybrid,r,'token',fetcher)).toBe(id);
 });
 it('honors bounded throttling without claiming success',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:429,headers:{'retry-after':'120'}}));
  await expect(upload(config,record,'token',fetcher)).rejects.toMatchObject({code:'throttled',retryAfter:120});
 });
});

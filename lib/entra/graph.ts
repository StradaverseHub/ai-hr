import { readBoundedBody } from '../bounded-body';
import { EntraError, trustedGraphUrl, type EntraConfig, type WorkforceRecord, workforcePayload } from './model';
async function request(url: string, init: RequestInit, fetcher: typeof fetch) {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000), cache: 'no-store' }); }
  catch { throw new EntraError('uncertain'); }
  if (!response.ok) {
    void response.body?.cancel().catch(()=>{});
    const retry = Math.min(3600, Math.max(30, Number(response.headers.get('retry-after')) || 60));
    throw new EntraError(response.status === 429 ? 'throttled' : response.status >= 500 ? 'uncertain' : 'forbidden', retry);
  }
  return response;
}
async function json(response: Response): Promise<Record<string,unknown>> {
  try { return JSON.parse(new TextDecoder().decode(await readBoundedBody(response, 1024*1024, 15_000))); }
  catch { throw new EntraError('unavailable'); }
}
export async function graphToken(config: EntraConfig, fetcher: typeof fetch = fetch) {
  const response = await request(`https://login.microsoftonline.com/${config.directoryTenantId}/oauth2/v2.0/token`, {method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({client_id:config.provisioningClientId,client_secret:config.provisioningClientSecret,scope:'https://graph.microsoft.com/.default',grant_type:'client_credentials'})},fetcher);
  const value = await json(response);
  if (typeof value.access_token !== 'string' || !value.access_token) throw new EntraError('unavailable');
  return value.access_token;
}
export async function upload(config: EntraConfig, record: WorkforceRecord, token: string, fetcher: typeof fetch = fetch) {
  const url = `https://graph.microsoft.com/v1.0/servicePrincipals/${config.servicePrincipalId}/synchronization/jobs/${config.jobId}/bulkUpload`;
  const response = await request(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/scim+json'},body:JSON.stringify(workforcePayload(record,config))},fetcher);
  if (response.status !== 202) throw new EntraError('uncertain');
  const location = response.headers.get('location');
  // Persist before reporting submission; absence of a receipt is an uncertain outcome, never ready.
  if (!location) throw new EntraError('uncertain');
  try{return trustedGraphUrl(location).href;}catch{throw new EntraError('uncertain');}
}
export type ProvisioningResult = { state:'pending'|'failed'|'complete'; objectId?:string };
export async function reconcile(config: EntraConfig, record: WorkforceRecord, token: string, fetcher: typeof fetch = fetch): Promise<ProvisioningResult> {
  if (!record.last_location) return {state:'pending'};
  if(!record.submission_started_at || !Number.isFinite(new Date(record.submission_started_at).getTime()))throw new EntraError('invalid');
  const receipt=trustedGraphUrl(record.last_location);
  const since=new Date(record.submission_started_at).toISOString();
  receipt.searchParams.set('$filter',`(${receipt.searchParams.get('$filter')||"jobId eq '"+config.jobId+"'"}) and sourceIdentity/id eq '${record.source_key}' and activityDateTime ge ${since}`);
  receipt.searchParams.set('$orderby','activityDateTime desc');receipt.searchParams.set('$top','100');
  let url: string|undefined = receipt.href;
  // Never follow an untrusted Graph-provided continuation with our bearer token.
  for (let page=0; url && page<3; page++) {
    const body = await json(await request(url,{headers:{authorization:`Bearer ${token}`}},fetcher));
    if (!Array.isArray(body.value)) throw new EntraError('unavailable');
    for (const item of body.value) {
      const principals=Array.isArray(item?.servicePrincipal)?item.servicePrincipal:[item?.servicePrincipal];
      if (!item || typeof item !== 'object' || item.jobId !== config.jobId || !principals.some((p:{id?:string})=>p?.id===config.servicePrincipalId) || item.sourceIdentity?.id !== record.source_key || item.tenantId!==config.directoryTenantId) continue;
      const time=new Date(item.activityDateTime).getTime();if(!Number.isFinite(time)||time<new Date(record.submission_started_at).getTime())continue;
      const status=item.provisioningStatusInfo?.status??item.statusInfo?.status;
      if (status === 'failure') return {state:'failed'};
      if (status !== 'success' && status !== 'skipped') continue;
      if (config.mode === 'hybrid') return {state:'complete'}; // AD success is not Entra readiness; explicit immutable binding is still required.
      const id = item.targetIdentity?.id;
      if (typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id)) return {state:'complete',objectId:id};
      if(status==='skipped')return {state:'complete'};
    }
    url = typeof body['@odata.nextLink'] === 'string' ? trustedGraphUrl(body['@odata.nextLink']).href : undefined;
  }
  return {state:'pending'};
}

/** A generated UPN is a locator only. The immutable source marker is the authority for adoption. */
export async function confirmedDirectoryObject(config: EntraConfig, record: WorkforceRecord, token: string, fetcher: typeof fetch = fetch): Promise<string|null> {
  const upn=`hr-${record.person_id.replaceAll('-', '')}@${config.domain}`;
  const field=config.sourceAnchorAttribute.split('.')[0];
  const url=new URL('https://graph.microsoft.com/v1.0/users/'+encodeURIComponent(upn));
  url.searchParams.set('$select',`id,displayName,accountEnabled,onPremisesSyncEnabled,${field}`);
  let response:Response;
  try{response=await fetcher(url.href,{headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000),cache:'no-store'});}catch{throw new EntraError('unavailable');}
  if(response.status===404){void response.body?.cancel().catch(()=>{});return null;}
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new EntraError('forbidden');}
  const object=await json(response),parts=config.sourceAnchorAttribute.split('.');
  const marker=parts.length===1?object[parts[0]]:(object[parts[0]] as Record<string,unknown>|undefined)?.[parts[1]];
  if(marker!==record.source_key||typeof object.id!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(object.id)))throw new EntraError('conflict');
  if(object.displayName!==record.full_name||object.accountEnabled!==record.active)return null;
  if(config.mode==='hybrid'&&object.onPremisesSyncEnabled!==true)return null;
  return object.id.toLowerCase();
}

import { connectionEndpoints, sameConnection } from '../../lib/mobile-connection';
import type { VerifiedCompanyProfile } from './company-profile';
import { readBoundedBody } from '../../lib/bounded-body';
/** No bearer or refresh credential is sent during enrollment or discovery. */
async function publicJson(url: string, fetcher: typeof fetch): Promise<unknown> {
  const controller = new AbortController(), timeout = setTimeout(()=>controller.abort(),10_000);
  try {
    const r = await fetcher(url,{redirect:'error',credentials:'omit',signal:controller.signal});
    if(!r.ok)void r.body?.cancel().catch(()=>{});
    if (r.status === 503) throw new Error('Company sign-in is not activated yet. Contact your administrator.');
    if (!r.ok) throw new Error('This server does not support mobile company setup yet.');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedBody(r,32768,10000,controller.signal)));
  } finally { clearTimeout(timeout); }
}
export async function verifyCompanyServer(profile: VerifiedCompanyProfile, fetcher: typeof fetch) {
  const info=await publicJson(profile.apiOrigin+'/login/mobile-connection',fetcher);
  if(!sameConnection(profile,info))throw new Error('The server login settings differ from the approved company setup. Ask your administrator for an updated file.');
  if (profile.authProvider === 'internal') return;
  const discovery=await publicJson(profile.issuer+'/.well-known/openid-configuration',fetcher) as Record<string,unknown>;
  const expected=connectionEndpoints(profile);
  if(discovery.issuer!==profile.issuer || discovery.authorization_endpoint!==expected.authorizationEndpoint ||
     discovery.token_endpoint!==expected.tokenEndpoint || discovery.end_session_endpoint!==expected.logoutEndpoint ||
     !Array.isArray(discovery.code_challenge_methods_supported) || !discovery.code_challenge_methods_supported.includes('S256'))throw new Error('The company login service does not match the approved setup.');
}

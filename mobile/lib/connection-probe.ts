import { connectionEndpoints, sameConnection } from '../../lib/mobile-connection';
import type { VerifiedCompanyProfile } from './company-profile';
/** No bearer or refresh credential is sent during enrollment or discovery. */
async function publicJson(url: string, fetcher: typeof fetch): Promise<unknown> {
  const controller = new AbortController(), timeout = setTimeout(()=>controller.abort(),10_000);
  try {
    const r = await fetcher(url,{redirect:'error',credentials:'omit',signal:controller.signal});
    if (r.status === 503) throw new Error('Company sign-in is not activated yet. Contact your administrator.');
    if (!r.ok) throw new Error('This server does not support mobile company setup yet.');
    if (Number(r.headers.get('content-length')) > 32_768) throw new Error('Invalid company response.');
    // A stream cap avoids reading an unbounded discovery response on native fetch implementations.
    const reader = r.body?.getReader();
    if (!reader) { const text = await r.text(); if(text.length>32_768)throw new Error('Invalid company response.'); return JSON.parse(text); }
    let size=0; const parts:Uint8Array[]=[];
    for (;;) { const chunk=await reader.read(); if(chunk.done)break; size+=chunk.value.length; if(size>32_768){await reader.cancel();throw new Error('Invalid company response.');}parts.push(chunk.value); }
    const data=new Uint8Array(size);let at=0;for(const part of parts){data.set(part,at);at+=part.length;}
    return JSON.parse(decodeURIComponent(Array.from(data,b=>'%'+b.toString(16).padStart(2,'0')).join('')));
  } finally { clearTimeout(timeout); }
}
export async function verifyCompanyServer(profile: VerifiedCompanyProfile, fetcher: typeof fetch = fetch) {
  const info=await publicJson(profile.apiOrigin+'/login/mobile-connection',fetcher);
  if(!sameConnection(profile,info))throw new Error('The server login settings differ from the approved company setup. Ask your administrator for an updated file.');
  const discovery=await publicJson(profile.issuer+'/.well-known/openid-configuration',fetcher) as Record<string,unknown>;
  const expected=connectionEndpoints(profile);
  if(discovery.issuer!==profile.issuer || discovery.authorization_endpoint!==expected.authorizationEndpoint ||
     discovery.token_endpoint!==expected.tokenEndpoint || discovery.end_session_endpoint!==expected.logoutEndpoint ||
     !Array.isArray(discovery.code_challenge_methods_supported) || !discovery.code_challenge_methods_supported.includes('S256'))throw new Error('The company login service does not match the approved setup.');
}

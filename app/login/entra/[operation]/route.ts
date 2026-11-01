import { randomUUID } from 'node:crypto';
import { client } from '@/db/client';
import { NextRequest, NextResponse } from 'next/server';
import { internalConfig, internalSelected, internalReady, INTERNAL_SESSION_COOKIE } from '@/lib/internal-auth/config';
import { takeRate } from '@/lib/internal-auth/service';
import { readBoundedBody } from '@/lib/bounded-body';
import { trustedRequestSource } from '@/lib/request-budget';
import { ENTRA_FLOW_COOKIE, startEntraLogin, completeEntraLogin, nativeLaunch, exchangeNative } from '@/lib/entra/login';
import { EntraError } from '@/lib/entra/model';
const headers={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
const cookie={httpOnly:true,secure:true,sameSite:'lax' as const,path:'/'};
export const runtime='nodejs';
export async function GET(req:NextRequest,{params}:{params:Promise<{operation:string}>}) {
  if(!internalSelected()||!internalReady())return new NextResponse(null,{status:404,headers});
  const {operation}=await params;
  try {
    await takeRate(`entra-get:${trustedRequestSource(req)||'global'}`,120,60_000);
    if(operation==='start'){
      const result=await startEntraLogin(req.nextUrl.searchParams.get('organization')||'',req.nextUrl.searchParams.get('returnTo')||'/',req.nextUrl.searchParams.get('ticket')||undefined);
      const response=NextResponse.redirect(result.url,303);for(const [k,v]of Object.entries(headers))response.headers.set(k,v);
      response.cookies.set(ENTRA_FLOW_COOKIE,result.handle,{...cookie,maxAge:600});return response;
    }
    if(operation==='callback'){
      const result=await completeEntraLogin(req.cookies.get(ENTRA_FLOW_COOKIE)?.value,req.nextUrl);
      const response=NextResponse.redirect(result.redirect,303);for(const [k,v]of Object.entries(headers))response.headers.set(k,v);
      response.cookies.set(ENTRA_FLOW_COOKIE,'',{...cookie,maxAge:0});
      if(!result.native)response.cookies.set(INTERNAL_SESSION_COOKIE,result.tokens.access_token,{...cookie,maxAge:result.tokens.expires_in});
      return response;
    }
    return new NextResponse(null,{status:404,headers});
  }catch{
    try{await client.unsafe("select app.append_auth_event(NULL,'entra-login',$1::uuid,'entra.login-refused','external',NULL,NULL)",[randomUUID()]);}catch{/* Authentication still fails closed if audit storage is unavailable. */}
    const response=NextResponse.redirect(new URL('/login?entraError=1',internalConfig().origin),303);
    for(const [k,v]of Object.entries(headers))response.headers.set(k,v);
    response.cookies.set(ENTRA_FLOW_COOKIE,'',{...cookie,maxAge:0});return response;
  }
}
export async function POST(req:NextRequest,{params}:{params:Promise<{operation:string}>}) {
  if(!internalSelected()||!internalReady())return NextResponse.json({error:'unavailable'},{status:404,headers});
  const origin=req.headers.get('origin');
  if(req.headers.get('x-aihr-client')!=='native'||(origin&&origin!==internalConfig().origin))return NextResponse.json({error:'forbidden'},{status:403,headers});
  try{
    await takeRate(`entra-post:${trustedRequestSource(req)||'global'}`,60,60_000);
    if(req.headers.get('content-type')?.split(';')[0]!=='application/json')throw new EntraError('invalid');
    const body=JSON.parse(new TextDecoder().decode(await readBoundedBody(req,4096,10_000,req.signal)));
    const text=(key:string,max=128)=>{if(typeof body?.[key]!=='string'||body[key].length>max)throw new EntraError('invalid');return body[key] as string;};
    const {operation}=await params;
    if(operation==='native')return NextResponse.json({url:await nativeLaunch(text('organization',64),{redirect:text('redirect',512),state:text('state'),challenge:text('challenge',43)})},{headers});
    if(operation==='exchange')return NextResponse.json(await exchangeNative(text('code',43),text('verifier')),{headers});
    return NextResponse.json({error:'unavailable'},{status:404,headers});
  }catch(e){return NextResponse.json({error:e instanceof EntraError?e.code:'unavailable'},{status:e instanceof EntraError&&e.code==='forbidden'?401:400,headers});}
}

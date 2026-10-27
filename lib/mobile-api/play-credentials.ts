/** Server-only service-account assembly. No ADC, key files, delegation or request-selected endpoint. */
import 'server-only';
import {createPrivateKey} from 'node:crypto';
import {JWT} from 'google-auth-library';
import {z} from 'zod';
import {readBoundedBody} from '../bounded-body';
import {IntegrityConfigurationUnavailable} from './integrity-configuration';
import type {PlayAccessTokenProvider} from './play-integrity';
const SCOPE='https://www.googleapis.com/auth/playintegrity',TOKEN_URL='https://oauth2.googleapis.com/token';
// Only these fields are passed to the SDK. Other fields in Google's exported JSON never select
// URLs, executable/file credentials, impersonation, universe domains, scopes or a quota project.
const credential=z.object({type:z.literal('service_account'),client_email:z.email().max(320).refine(value=>value.endsWith('.gserviceaccount.com')),
 private_key:z.string().min(1).max(16384)});
const access=z.string().min(1).max(16384).regex(/^[A-Za-z0-9._~+/-]+=*$/);
const tokenResponse=z.object({access_token:access,token_type:z.literal('Bearer'),expires_in:z.number().int().min(1).max(3600)});
export class PlayCredentialsUnavailableError extends Error{
 constructor(){super('Google authorization unavailable');this.name='PlayCredentialsUnavailableError';}
}
const unavailable=()=>new PlayCredentialsUnavailableError();
/** Per-call SDK clients keep cancellation/credential state separate. There is no application token
 * cache, shared refresh, retry or logging. Network ports are server/test assembly only. */
export function createPlayServiceAccountProvider(raw:unknown,ports:{transport?:typeof fetch;timeoutMs?:number;assertCurrent?:()=>void}={}):PlayAccessTokenProvider|null{
 const parsed=credential.safeParse(raw),timeout=ports.timeoutMs??5000;
 if(!parsed.success||!Number.isInteger(timeout)||timeout<1||timeout>10000)return null;
 let key:string;
 try{const value=createPrivateKey(parsed.data.private_key),bits=value.asymmetricKeyDetails?.modulusLength;
  if(value.asymmetricKeyType!=='rsa'||!bits||bits<2048||bits>8192)return null;
  key=value.export({type:'pkcs8',format:'pem'}).toString();
 }catch{return null;}
 const email=parsed.data.client_email,transport=ports.transport??fetch;
 return async(scope,signal)=>{
  if(scope!==SCOPE||signal.aborted)throw unavailable();
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,stop=()=>{},sent=false;
  const interrupted=new Promise<never>((_,reject)=>{
   stop=()=>{controller.abort();reject(unavailable());};signal.addEventListener('abort',stop,{once:true});timer=setTimeout(stop,timeout);
  });
  try{
   ports.assertCurrent?.();
   const exchange:typeof fetch=async(input,init)=>{
    const url=typeof input==='string'||input instanceof URL?String(input):input.url;
    if(controller.signal.aborted||sent||url!==TOKEN_URL||init?.method!=='POST'||
     !(typeof init.body==='string'||init.body instanceof URLSearchParams))throw unavailable();
    sent=true;ports.assertCurrent?.();
    const response=await transport(TOKEN_URL,{method:'POST',body:init.body,headers:init.headers,redirect:'error',cache:'no-store',signal:controller.signal});
    if(response.status!==200){void response.body?.cancel().catch(()=>{});throw unavailable();}
    const bytes=await readBoundedBody(response,65536,timeout,controller.signal);
    const value=tokenResponse.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    if(!value.success||controller.signal.aborted)throw unavailable();
    return Response.json(value.data);
   };
   const client=new JWT({email,key,scopes:[SCOPE],transporterOptions:{fetchImplementation:exchange,timeout,retry:false,retryConfig:{retry:0},maxContentLength:32768}});
   const value=await Promise.race([client.getAccessToken(),interrupted]);
   ports.assertCurrent?.();if(controller.signal.aborted||!access.safeParse(value.token).success)throw unavailable();
   return value.token!;
  }catch{throw unavailable();}
  finally{clearTimeout(timer);signal.removeEventListener('abort',stop);controller.abort();}
 };
}
/** Read only after subject authorization. A changed/removed credential vetoes this in-flight
 * operation, including its eventual deployment commit; no prior good credential is cached. */
export function readDeployedPlayCredentials(){
 const snapshot=process.env.AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT;
 const assertCurrent=()=>{if(process.env.AIHR_MOBILE_GOOGLE_SERVICE_ACCOUNT!==snapshot)throw new IntegrityConfigurationUnavailable('configuration_unavailable');};
 let input:unknown;
 try{if(snapshot&&Buffer.byteLength(snapshot,'utf8')<=32768)input=JSON.parse(snapshot);}catch{}
 return {accessToken:createPlayServiceAccountProvider(input,{assertCurrent}),assertCurrent};
}

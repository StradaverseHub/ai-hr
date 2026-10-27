/** Google status-list transport only. Not certificate-path, app identity or key custody verification. */
import 'server-only';
import {z} from 'zod';
import {readBoundedBody} from '../bounded-body';
const URL='https://android.googleapis.com/attestation/status';
const serial=z.string().min(1).max(40).regex(/^[a-f1-9][a-f0-9]*$/).refine(value=>value.trim()===value);
const entry=z.object({status:z.enum(['REVOKED','SUSPENDED']),expires:z.iso.date().optional(),
  reason:z.enum(['UNSPECIFIED','KEY_COMPROMISE','CA_COMPROMISE','SUPERSEDED','SOFTWARE_FLAW']).optional(),comment:z.string().max(140).optional()}).strict();
const payload=z.object({entries:z.record(serial,entry).refine(entries=>Object.keys(entries).length<=20000)}).strict();
/** JSON.parse alone loses duplicate keys. Bound nesting and refuse duplicate decoded member names. */
function json(text:string):unknown{
  let at=0,nodes=0;
  const ws=()=>{while(at<text.length&&/[\x20\t\r\n]/.test(text[at]))at++;};
  const string=()=>{const start=at++;let escaped=false;while(at<text.length){const c=text[at++];if(!escaped&&c==='"')return JSON.parse(text.slice(start,at)) as string;if(!escaped&&c==='\\')escaped=true;else escaped=false;}throw new Error();};
  function value(depth:number):unknown{
    if(depth>4||++nodes>150000)throw new Error();ws();
    if(text[at]==='"')return string();
    if(text[at]==='{'){
      at++;const result=Object.create(null),seen=new Set<string>();ws();if(text[at]==='}'){at++;return result;}
      for(;;){ws();if(text[at]!=='"')throw new Error();const key=string();if(seen.has(key))throw new Error();seen.add(key);ws();if(text[at++]!==':')throw new Error();result[key]=value(depth+1);ws();const end=text[at++];if(end==='}')return result;if(end!==',')throw new Error();}
    }
    throw new Error(); // Published schema contains only objects and strings.
  }
  const result=value(0);ws();if(at!==text.length)throw new Error();return result;
}
export type AndroidRevocationResult=
 |{status:'checked';source:'google_https';checkedAt:number;certificateCount:number}
 |{status:'refused';reason:'revoked'|'suspended'}
 |{status:'invalid';reason:'invalid_serials'}
 |{status:'unavailable';reason:'configuration'|'provider'|'timeout'|'aborted'|'malformed'|'stale'};
/** Input serials MUST come from the server-validated path, normalized as lowercase unpadded hex.
 * No URL, certificate or serial is transmitted to Google. No cache, retry or stale fallback exists.
 * maximumAgeMs bounds the HTTP observation, not Google's delay in publishing a compromise. */
export function createAndroidRevocationChecker(options:{transport?:typeof fetch;now?:()=>number;timeoutMs?:number;maximumAgeMs?:number}={}){
  const transport=options.transport??fetch,now=options.now??Date.now,timeout=options.timeoutMs??10000,maximumAge=options.maximumAgeMs??3600000;
  const configured=Number.isInteger(timeout)&&timeout>0&&timeout<=30000&&Number.isInteger(maximumAge)&&maximumAge>0&&maximumAge<=86400000;
  return async(serials:readonly string[],signal?:AbortSignal):Promise<AndroidRevocationResult>=>{
    if(!configured)return {status:'unavailable',reason:'configuration'};
    if(!Array.isArray(serials)||serials.length<1||serials.length>8||new Set(serials).size!==serials.length||serials.some(value=>!serial.safeParse(value).success))return {status:'invalid',reason:'invalid_serials'};
    const expected=[...serials],started=now();if(!Number.isSafeInteger(started)||started<=0)return {status:'unavailable',reason:'configuration'};
    const controller=new AbortController();let stop:'timeout'|'aborted'|undefined,timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
    const cancelled=Symbol();
    const interrupted=new Promise<never>((_,reject)=>{
      abort=()=>{stop='aborted';controller.abort();reject(cancelled);};
      signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{stop='timeout';controller.abort();reject(cancelled);},timeout);
      if(signal?.aborted)abort();
    });
    async function execute():Promise<AndroidRevocationResult>{
      if(controller.signal.aborted)throw cancelled;
      const response=await transport(URL,{method:'GET',headers:{accept:'application/json'},cache:'no-store',redirect:'error',credentials:'omit',signal:controller.signal});
      if(controller.signal.aborted)throw cancelled;
      if(response.status!==200){void response.body?.cancel().catch(()=>{});return {status:'unavailable',reason:'provider'};}
      const age=response.headers.get('age'),date=response.headers.get('date'),stamp=date?Date.parse(date):NaN;
      if(!Number.isFinite(stamp)||age!==null&&!/^(0|[1-9][0-9]{0,9})$/.test(age)){
        void response.body?.cancel().catch(()=>{});return {status:'unavailable',reason:'stale'};
      }
      let parsed:ReturnType<typeof payload.safeParse>;
      try{const bytes=await readBoundedBody(response,4*1024*1024,timeout,controller.signal);parsed=payload.safeParse(json(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
      catch{if(controller.signal.aborted)throw cancelled;return {status:'unavailable',reason:'malformed'};}
      if(controller.signal.aborted)throw cancelled;
      if(!parsed.success)return {status:'unavailable',reason:'malformed'};
      const checkedAt=now();
      if(!Number.isSafeInteger(checkedAt)||checkedAt<started)return {status:'unavailable',reason:'configuration'};
      if(stamp>checkedAt+30000||Math.max(checkedAt-stamp,Number(age??0)*1000+checkedAt-started)>maximumAge)return {status:'unavailable',reason:'stale'};
      // Expiry metadata is never used to override a published non-normal status.
      const statuses=expected.map(value=>parsed.data.entries[value]?.status);
      if(statuses.includes('REVOKED'))return {status:'refused',reason:'revoked'};
      if(statuses.includes('SUSPENDED'))return {status:'refused',reason:'suspended'};
      return {status:'checked',source:'google_https',checkedAt,certificateCount:expected.length};
    }
    try{return await Promise.race([execute(),interrupted]);}
    catch{return {status:'unavailable',reason:stop??'provider'};}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  };
}

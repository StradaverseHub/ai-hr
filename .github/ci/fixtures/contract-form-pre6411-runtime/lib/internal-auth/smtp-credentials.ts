/** Mail-scoped token acquisition. Fixed Microsoft endpoint; never log provider bodies or secrets. */
import {z} from 'zod';
import {EmailSettingsError} from '../identity/email-model';
import {storedEmailRelay,deliveryEmailRelay,type EmailRelay,type DeliveryEmailRelay} from '../identity/email-relay';
export const SMTP_TOKEN_MIN_LIFETIME_MS=60_000;
const tokenResponse=z.object({access_token:z.string().min(1).max(16384).regex(/^[\x21-\x7e]+$/),
 token_type:z.string().refine(value=>value.toLowerCase()==='bearer'),expires_in:z.number().int().min(120).max(86400),
});
async function boundedTokenBody(response:Response) {
 if(!response.body)throw new EmailSettingsError('authenticationFailed');
 const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 try {
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
   if(size>32768){await reader.cancel();throw new EmailSettingsError('authenticationFailed');}chunks.push(part.value);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
 }finally{reader.releaseLock();}
}
export function assertFreshDeliveryRelay(relay:unknown,now=Date.now()):DeliveryEmailRelay {
 const parsed=deliveryEmailRelay.safeParse(relay);if(!parsed.success)throw new EmailSettingsError('invalid');
 if(parsed.data.config.authentication==='microsoft365'&&parsed.data.accessTokenExpiresAt!<=now+SMTP_TOKEN_MIN_LIFETIME_MS)
  throw new EmailSettingsError('authenticationFailed');
 return parsed.data;
}
export async function prepareSmtpRelay(input:EmailRelay,options:{fetch?:typeof fetch;now?:()=>number}={}):Promise<DeliveryEmailRelay> {
 const clock=options.now??Date.now;
 if(input&&typeof input==='object'&&'accessToken' in input)return assertFreshDeliveryRelay(input,clock());
 const parsed=storedEmailRelay.safeParse(input);if(!parsed.success)throw new EmailSettingsError('invalid');
 const relay=parsed.data,c=relay.config;
 if(c.authentication!=='microsoft365')return c.auth?relay:{config:c};
 const startedAt=clock(),oauth=c.oauth2!;
 try {
  const response=await (options.fetch??fetch)(`https://login.microsoftonline.com/${oauth.tenantId}/oauth2/v2.0/token`,{
   method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'content-type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams({client_id:oauth.clientId,client_secret:relay.password!,grant_type:'client_credentials',scope:'https://outlook.office365.com/.default'}),
  });
  if(!response.ok)throw new EmailSettingsError('authenticationFailed');
  const token=tokenResponse.safeParse(await boundedTokenBody(response));if(!token.success)throw new EmailSettingsError('authenticationFailed');
  // Use request start, not response time, so a slow reply cannot extend token lifetime.
  return assertFreshDeliveryRelay({config:c,accessToken:token.data.access_token,accessTokenExpiresAt:startedAt+token.data.expires_in*1000},clock());
 }catch{throw new EmailSettingsError('authenticationFailed');}
}

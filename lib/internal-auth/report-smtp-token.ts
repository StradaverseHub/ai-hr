/** Auth broker's fixed Unix capability. The key-holding broker retains loopback-only networking. */
import {connect} from 'node:net';
import {z} from 'zod';
import {EmailSettingsError} from '../identity/email-model';
import {storedEmailRelay,type StoredEmailRelay,type DeliveryEmailRelay} from '../identity/email-relay';
import {assertFreshDeliveryRelay,prepareSmtpRelay} from './smtp-credentials';
const reply=z.object({accessToken:z.string().min(1).max(16384),accessTokenExpiresAt:z.number().int().positive()}).strict();
export async function prepareReportSmtpRelay(input:StoredEmailRelay):Promise<DeliveryEmailRelay>{
 const relay=storedEmailRelay.parse(input);if(relay.config.authentication!=='microsoft365')return prepareSmtpRelay(relay);
 try{
  const token=await new Promise<unknown>((resolve,reject)=>{
   const socket=connect({path:'/run/aihr-smtp-token.sock'});let size=0;const chunks:Buffer[]=[];
   const timer=setTimeout(()=>socket.destroy(new Error('Token capability timed out.')),12000);timer.unref();
   socket.on('connect',()=>socket.end(JSON.stringify({...relay.config.oauth2,clientSecret:relay.password})));
   socket.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>49152)socket.destroy(new Error('Token reply exceeded its bound.'));else chunks.push(chunk);});
   socket.on('error',reject);socket.on('close',()=>clearTimeout(timer));
   socket.on('end',()=>{try{resolve(reply.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));}catch{reject(new Error('Token capability unavailable.'));}});
  });
  return assertFreshDeliveryRelay({config:relay.config,...reply.parse(token)});
 }catch{throw new EmailSettingsError('authenticationFailed');}
}

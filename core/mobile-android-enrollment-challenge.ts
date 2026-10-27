/** Android enrollment challenge owner only. No key registration, vendor call or public route. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {AndroidEnrollmentSettings,AndroidEnrollmentContext,androidEnrollmentClientData} from '../lib/mobile-android-enrollment';
import {issueOwnIntegrityChallenge,readOwnIntegrityChallenge,type IntegrityChallengeView} from './mobile-integrity-challenge';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export const androidEnrollmentIntent=z.object({employmentId:uuid,requestId:uuid,appInstallationId:uuid}).strict();
const intent=androidEnrollmentIntent;
type Intent=z.infer<typeof intent>;
const hash=(bytes:string)=>createHash('sha256').update(bytes,'utf8');
export function createAndroidEnrollmentChallenges(settings:unknown){
 const config=AndroidEnrollmentSettings.parse(settings);
 function binding(ctx:SessionContext,input:Intent){
  return {...input,purpose:'device.enrollment' as const,bindingHash:hash(JSON.stringify(['aihr-android-enrollment-binding',1,
   config.apiOrigin,ctx.tenantId.toLowerCase(),ctx.userId?.toLowerCase(),input.employmentId,input.appInstallationId,config.target])).digest('hex')};
 }
 function prepared(ctx:SessionContext,row:IntegrityChallengeView){
  const context=AndroidEnrollmentContext.parse({version:1,purpose:'device.key.enrollment',apiOrigin:config.apiOrigin,
   installationId:row.installationId,tenantId:ctx.tenantId,actorId:row.actorId,employmentId:row.employmentId,appInstallationId:row.appInstallationId,
   requestId:row.requestId,challengeId:row.id,nonce:row.nonce,issuedAt:Date.parse(row.issuedAt),expiresAt:Date.parse(row.expiresAt),target:config.target});
  return context;
 }
 function result(ctx:SessionContext,row:IntegrityChallengeView){
  // Tenant is supplied by the authenticated server owner, never added to the public challenge view.
  const context=prepared(ctx,row);
  return {challenge:row,context,clientDataHash:hash(androidEnrollmentClientData(context)).digest('base64'),
   alias:'aihr_'+hash(JSON.stringify(['aihr-android-key-alias',1,context.installationId,context.tenantId,context.actorId,context.appInstallationId,context.challengeId])).digest('hex')};
 }
 return {
  async begin(ctx:SessionContext,input:Intent){const value=intent.parse(input);return result(ctx,await issueOwnIntegrityChallenge(ctx,binding(ctx,value)));},
  async read(ctx:SessionContext,input:Intent&{challengeId:string}){
   const value=intent.extend({challengeId:uuid}).parse(input),{challengeId,...original}=value;
   return result(ctx,await readOwnIntegrityChallenge(ctx,{...binding(ctx,original),challengeId}));
  },
 };
}

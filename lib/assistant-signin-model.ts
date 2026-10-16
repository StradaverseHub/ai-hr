/** Non-authorizing pure sign-in binding. Inputs must come from verified provider owners. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
export const ASSISTANT_DEMO_NONCE_COOKIE='assistant_demo_signin';
export const assistantDemoNonce=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const assistantVerifiedSignIn=z.discriminatedUnion('provider',[
 z.object({provider:z.literal('internal'),issuer:z.string().min(1).max(1000),subject:z.string().min(1).max(256),session:z.uuid()}).strict(),
 z.object({provider:z.literal('keycloak'),issuer:z.string().min(1).max(1000),subject:z.string().min(1).max(256),session:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 z.object({provider:z.literal('workos'),subject:z.string().min(1).max(256),session:z.string().min(1).max(256)}).strict(),
 z.object({provider:z.literal('demo'),subject:z.uuid(),session:assistantDemoNonce}).strict(),
]);
export function assistantSignInFingerprint(raw:unknown):string {
 const value=assistantVerifiedSignIn.parse(raw);
 return createHash('sha256').update(JSON.stringify(['aihr-assistant-signin-v1',value])).digest('hex');
}
